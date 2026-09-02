import { workerVerificationSchema } from '@/domain/worker-protocol';
import { json, workerRoute } from '@/server/http/worker-handler';

export const dynamic = 'force-dynamic';

/** One verification command's real result — including "unavailable on this platform". */
export const POST = workerRoute(
  workerVerificationSchema,
  { name: 'worker.verification', idempotent: true },
  async ({ services, workerId, body }) => {
    const { runId, ...input } = body;
    return json(await services.workerService.recordVerification(workerId, runId, input));
  },
);
