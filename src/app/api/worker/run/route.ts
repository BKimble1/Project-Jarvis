import { workerRunStateSchema } from '@/domain/worker-protocol';
import { json, workerRoute } from '@/server/http/worker-handler';

export const dynamic = 'force-dynamic';

/**
 * Report where a run has got to.
 *
 * The worker proposes a mission state; the state machine decides whether that move is legal for a
 * worker to make. A worker cannot, for example, move a mission from `queued` to `completed`.
 */
export const POST = workerRoute(
  workerRunStateSchema,
  { name: 'worker.run', idempotent: true },
  async ({ services, workerId, body }) => {
    const mission = await services.workerService.reportRunState(workerId, body);
    const pending = await services.missionCommands.pendingFor(mission.id);
    return json({
      ok: true,
      missionState: mission.state,
      stopRequested: pending.some((command) => command.kind === 'stop'),
      pauseRequested: pending.some((command) => command.kind === 'pause'),
    });
  },
);
