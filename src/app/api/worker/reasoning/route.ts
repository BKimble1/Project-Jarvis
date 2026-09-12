import { reasoningOutcomeSchema } from '@/domain/reasoning';
import { json, workerRoute } from '@/server/http/worker-handler';

export const dynamic = 'force-dynamic';

/**
 * The worker's answer, or its honest failure.
 *
 * `applied: false` is a success at the HTTP level and means the write did not land — the lease had
 * already been reclaimed, or somebody else answered first. Returning an error there would put the
 * worker into a retry loop over a question that already has an answer, which costs the owner's
 * subscription to arrive at the same place.
 *
 * Note what this route cannot carry. The schema has no field for a token, a session, a model
 * credential or an account identifier, and the outcome's `detail` is one bounded sentence. A
 * worker that wanted to send its Claude login here has nowhere to put it.
 */
export const POST = workerRoute(
  reasoningOutcomeSchema,
  { name: 'worker.reasoning.report', idempotent: true },
  async ({ services, workerId, body }) => {
    const result = await services.workerService.reportReasoning(workerId, body);
    return json(result);
  },
);
