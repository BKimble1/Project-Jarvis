import { AUTHORIZATION_OUTCOME_LABELS } from '@/domain/authorization';
import { json, ownerRoute } from '@/server/http/handler';

export const dynamic = 'force-dynamic';

/**
 * Every authorisation decision, most recent first.
 *
 * The refusals are the more useful half. "Why has Jarvis not done anything?" is answered by
 * reading this list, and a system that only recorded its successes could not answer it at all.
 */
export const GET = ownerRoute(async ({ services, request }) => {
  const limit = Number(new URL(request.url).searchParams.get('limit') ?? '50');
  const decisions = await services.charterService.recentDecisions(
    Number.isFinite(limit) ? Math.min(Math.max(limit, 1), 200) : 50,
  );

  return json({
    decisions: decisions.map((decision) => ({
      id: decision.id,
      missionId: decision.missionId,
      outcome: decision.outcome,
      outcomeLabel: AUTHORIZATION_OUTCOME_LABELS[decision.outcome],
      mode: decision.mode,
      qualificationLevel: decision.qualificationLevel,
      charterVersionId: decision.charterVersionId,
      charterDigest: decision.charterDigest,
      summary: decision.summary,
      decidedAt: decision.decidedAt,
      estimatedSpendUsd: decision.estimatedSpendUsd,
      requested: decision.requested.map((capability) => capability.capability),
      verdicts: decision.verdicts,
    })),
  });
});
