import { workerEventBatchSchema } from '@/domain/worker-protocol';
import { json, workerRoute } from '@/server/http/worker-handler';

export const dynamic = 'force-dynamic';

/**
 * A batch of run events.
 *
 * Doubly idempotent: the request key replays a whole retried batch, and the unique
 * `(run_id, seq)` index means an individual event that did land is never stored twice.
 */
export const POST = workerRoute(
  workerEventBatchSchema,
  { name: 'worker.events', idempotent: true },
  async ({ services, workerId, body }) =>
    json(await services.workerService.appendEvents(workerId, body)),
);
