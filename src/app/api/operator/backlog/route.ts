import { z } from 'zod';
import { PRIORITY_BAND_MEANING } from '@/domain/opportunity';
import { json, ownerRoute, parseBody } from '@/server/http/handler';

export const dynamic = 'force-dynamic';

/**
 * What Jarvis thinks is worth doing, in the order it would do it.
 *
 * The factors travel with each entry rather than being summarised into the score, because "why is
 * this first?" should be answerable by reading sentences. The score orders; it does not measure,
 * and it is not a probability, a confidence or an amount of money.
 */
export const GET = ownerRoute(async ({ services }) => {
  const backlog = await services.operatorService.backlog();
  const ticks = await services.operatorService.recentTicks(20);

  return json({
    backlog: backlog.map((entry) => ({
      key: entry.key,
      projectId: entry.projectId,
      title: entry.title,
      detail: entry.detail,
      rule: entry.rule,
      source: entry.source,
      severity: entry.severity,
      provenance: entry.provenance,
      evidenceIds: entry.evidenceIds,
      capabilities: entry.capabilities,
      requiresOwner: entry.requiresOwner,
      state: entry.state,
      band: entry.band,
      bandMeaning: PRIORITY_BAND_MEANING[entry.band],
      score: entry.score,
      factors: entry.factors,
      missionId: entry.missionId,
      firstSeenAt: entry.firstSeenAt,
      lastSeenAt: entry.lastSeenAt,
    })),
    /*
     * The quiet ticks are the point of this list. "Why has Jarvis not done anything today?" is
     * answered by reading the last twenty summaries, including — especially — the empty ones.
     */
    ticks: ticks.map((tick) => ({
      id: tick.id,
      startedAt: tick.startedAt,
      finishedAt: tick.finishedAt,
      mode: tick.mode,
      outcome: tick.outcome,
      summary: tick.summary,
      projectsObserved: tick.projectsObserved,
      opportunitiesFound: tick.opportunitiesFound,
      missionsStarted: tick.missionsStarted,
      coverage: tick.coverage,
    })),
  });
});

const dismissSchema = z.object({
  key: z.string().trim().min(8).max(64),
  reason: z.string().trim().min(3).max(400),
});

/**
 * The owner saying no.
 *
 * A dismissed opportunity never comes back on its own, which is what makes it different from one
 * Jarvis declined — that one may return if the evidence changes. Both are recorded; only this one
 * is a decision.
 */
export const POST = ownerRoute(async ({ services, request }) => {
  const input = await parseBody(request, dismissSchema);
  const closed = await services.operatorService.dismiss(input.key, input.reason);
  if (!closed) {
    return json({ error: { code: 'not_found', message: 'No such opportunity.' } }, { status: 404 });
  }
  return json({ key: closed.key, state: closed.state, closedAt: closed.closedAt });
});
