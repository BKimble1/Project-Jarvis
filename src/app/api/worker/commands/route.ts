import { workerCommandAckSchema } from '@/domain/worker-protocol';
import { json, workerRoute } from '@/server/http/worker-handler';

export const dynamic = 'force-dynamic';

/** The worker confirms it received, completed or could not carry out an owner command. */
export const POST = workerRoute(
  workerCommandAckSchema,
  { name: 'worker.commands', idempotent: true },
  async ({ services, workerId, body }) => {
    await services.workerService.acknowledgeCommand(
      workerId,
      body.commandId,
      body.outcome,
      body.detail ?? null,
    );
    return json({ ok: true });
  },
);
