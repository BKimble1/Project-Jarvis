import { z } from 'zod';
import { workerHeartbeatSchema } from '@/domain/worker-protocol';
import { json, workerRoute } from '@/server/http/worker-handler';

export const dynamic = 'force-dynamic';

const claimTaskSchema = z.object({
  heartbeat: workerHeartbeatSchema,
  /**
   * The roles this worker will accept.
   *
   * A worker with no model credential sends only `verifier` and `integrator`, so it can still do
   * the deterministic half of a mission without ever being handed a task it cannot perform.
   */
  roles: z.array(z.string().trim().min(3).max(40)).min(1).max(20),
});

/**
 * Claim the next runnable *task*.
 *
 * Separate from `/api/worker/claim` rather than folded into it: the mission claim is Prompt 2's
 * and is heavily tested, and a route that returns two different assignment shapes depending on a
 * flag is the kind of thing that eventually returns the wrong one.
 *
 * Idempotent, because claiming changes state. The underlying `claimNext` is a single atomic
 * statement with every capacity ceiling checked inside it, so two workers racing here still
 * produce at most one claim.
 */
export const POST = workerRoute(
  claimTaskSchema,
  { name: 'worker.claimTask', idempotent: true },
  async ({ services, workerId, body }) => {
    await services.workerService.heartbeat(workerId, body.heartbeat);
    const assignment = await services.taskWorkerService.claimTask(workerId, body.roles);
    return json({ assignment });
  },
);
