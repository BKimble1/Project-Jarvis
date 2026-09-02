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
 */
async function run(request: Request): Promise<NextResponse> {
  try {
    assertCronAuthorised(request);
    const services = await getServices();
    const outcomes = await services.sync.syncAll('scheduled');
    for (const outcome of outcomes) {
      if (outcome.skipped === 'locked') continue;
      await services.briefings
        .briefProject(outcome.projectId, { regenerate: true })
        .catch(() => {});
    }
    /* Housekeeping that keeps the database from growing without bound. */
    await services.sessions.purgeExpired();
    await services.oauthStates.purgeExpired();
    logger().info('scheduled sync finished', { projects: outcomes.length });
    return json({ ok: true, projects: outcomes.length, outcomes });
  } catch (error) {
    return errorResponse(error);
  }
}

export const POST = run;
export const GET = run;
