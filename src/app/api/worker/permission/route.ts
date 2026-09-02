import { workerPermissionRequestSchema } from '@/domain/worker-protocol';
import { json, workerRoute } from '@/server/http/worker-handler';

export const dynamic = 'force-dynamic';

/**
 * The agent asked for something outside its permission set.
 *
 * This is what happens instead of a silent allow: the mission moves to waiting, the request
 * appears under "What needs me?", and the owner decides on that exact request.
 */
export const POST = workerRoute(
  workerPermissionRequestSchema,
  { name: 'worker.permission', idempotent: true },
  async ({ services, workerId, body }) => {
    const { runId, ...input } = body;
    return json(await services.workerService.recordPermissionRequest(workerId, runId, input));
  },
);
