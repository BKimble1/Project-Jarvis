import { workerReasoningClaimSchema } from '@/domain/worker-protocol';
import { json, workerRoute } from '@/server/http/worker-handler';

export const dynamic = 'force-dynamic';

/**
 * Claim a question to think about.
 *
 * Idempotent, because claiming changes state: a retry after a network timeout must not consume a
 * second question and leave the first one leased to nobody. The underlying claim is one atomic
 * statement, so two workers racing here still produce at most one assignment.
 *
 * A null assignment is the ordinary answer and is not an error. It means one of: nothing is
 * waiting, this worker's Claude runtime is unavailable, or the governor says the subscription
 * window has no room. The worker does not need to know which — the conversation that is waiting
 * already says so, in words, to the person who asked.
 */
export const POST = workerRoute(
  workerReasoningClaimSchema,
  { name: 'worker.reasoning.claim', idempotent: true },
  async ({ services, workerId, body }) => {
    const assignment = await services.workerService.claimReasoning(workerId, body);
    return json({ assignment });
  },
);
