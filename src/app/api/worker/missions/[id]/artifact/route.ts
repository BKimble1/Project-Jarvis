import { workerArtifactSchema } from '@/domain/worker-protocol';
import { json, workerRouteWithParams } from '@/server/http/worker-handler';

export const dynamic = 'force-dynamic';

/** A report or diff produced by the run. Redacted and size-bounded before storage. */
export const POST = workerRouteWithParams<typeof workerArtifactSchema, { id: string }>(
  workerArtifactSchema,
  { name: 'worker.artifact', idempotent: true },
  async ({ services, workerId, body, params }) => {
    const { runId, ...input } = body;
    return json(
      await services.workerService.recordArtifact(workerId, params.id, runId ?? null, input),
      { status: 201 },
    );
  },
);
