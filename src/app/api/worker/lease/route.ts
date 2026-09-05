import { z } from 'zod';
import { json, workerRoute } from '@/server/http/worker-handler';

export const dynamic = 'force-dynamic';

const leaseSchema = z.object({
  runId: z.string().uuid(),
  taskId: z.string().uuid(),
  /**
   * What the worker believes it will change.
   *
   * Accepted for the audit trail and then ignored in favour of the write set the *approved graph*
   * declared. A worker cannot widen its own lease by asking for more.
   */
  paths: z.array(z.string().trim().min(1).max(200)).max(60).default([]),
});

/**
 * Take the write lease for a task.
 *
 * A refusal is `{granted:false}` with a reason, not an error: a task that has to wait for another
 * writer is ordinary scheduling, and turning it into a failure would make overlapping write sets
 * look like defects.
 */
export const POST = workerRoute(
  leaseSchema,
  { name: 'worker.lease', idempotent: true },
  async ({ services, workerId, body }) => {
    const result = await services.taskWorkerService.acquireLease(workerId, body);
    return json(result);
  },
);
