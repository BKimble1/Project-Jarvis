import type { NextResponse } from 'next/server';
import { assertCronAuthorised } from '@/server/auth/guard';
import { getServices } from '@/server/container';
import { errorResponse, json } from '@/server/http/handler';
import { logger } from '@/server/logging/logger';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * Scheduled synchronisation.
 *
 * Protected by `CRON_SECRET` and closed when that secret is absent. It never trusts a caller's
 * identity claim — only the shared secret, compared in constant time.
 *
 * This is unattended work, so the activation lock applies. Two capabilities are involved and they
 * are treated differently on purpose:
 *
 *  - **Refreshing evidence** is a GitHub *read*. It is what keeps the Status Brain honest, and
 *    withholding it would degrade the truth rather than protect anything, so it runs whenever
 *    the schedule fires.
 *  - **Narrating a briefing with a model** is model work. When that is not qualified, the
 *    briefing is still produced — by the deterministic narrator — and the response says so. The
 *    lock reduces the capability rather than removing the feature, because a control that turns
 *    the morning briefing off entirely is a control that gets switched off.
 */
async function run(request: Request): Promise<NextResponse> {
  try {
    assertCronAuthorised(request);
    const services = await getServices();

    const narration = await services.qualificationService.evaluate('scheduled_briefing');

    const outcomes = await services.sync.syncAll('scheduled');
    for (const outcome of outcomes) {
      if (outcome.skipped === 'locked') continue;
      await services.briefings
        .briefProject(outcome.projectId, {
          regenerate: true,
          deterministicOnly: !narration.allowed,
        })
        .catch(() => {});
    }

    if (!narration.allowed) {
      await services.audit.append({
        actor: 'cron',
        actorKind: 'schedule',
        action: 'activation.refused',
        subjectKind: 'capability',
        subjectId: 'scheduled_briefing',
        outcome: 'refused',
        rule: 'R-QA1',
        summary:
          'Briefings were produced deterministically: model narration is not qualified to run unattended.',
        detail: { required: narration.required, actual: narration.actual },
      });
    }

    /* Housekeeping that keeps the database from growing without bound. */
    await services.sessions.purgeExpired();
    await services.oauthStates.purgeExpired();
    logger().info('scheduled sync finished', {
      projects: outcomes.length,
      modelNarration: narration.allowed,
    });
    return json({
      ok: true,
      projects: outcomes.length,
      outcomes,
      narration: {
        modelAllowed: narration.allowed,
        required: narration.required,
        actual: narration.actual,
        reason: narration.reason,
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}

export const POST = run;
export const GET = run;
