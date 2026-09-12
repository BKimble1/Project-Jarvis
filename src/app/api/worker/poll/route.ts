import { workerPollSchema } from '@/domain/worker-protocol';
import { json, workerRoute } from '@/server/http/worker-handler';

export const dynamic = 'force-dynamic';

/**
 * Heartbeat, commands and current assignment in one round trip.
 *
 * Not idempotency-guarded: it is a read plus a heartbeat, and repeating it is exactly what the
 * worker is supposed to do.
 */
export const POST = workerRoute(
  workerPollSchema,
  { name: 'worker.poll' },
  async ({ services, workerId, body }) => json(await services.workerService.poll(workerId, body)),
);
