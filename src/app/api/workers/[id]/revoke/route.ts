import { z } from 'zod';
import { json, ownerRouteWithParams, parseBody } from '@/server/http/handler';

export const dynamic = 'force-dynamic';

const schema = z.object({ reason: z.string().trim().min(1).max(500) });

/**
 * Revoke a worker.
 *
 * Takes effect on the worker's very next request. Whatever mission it held stays exactly where it
 * is with its workspace intact — revoking a worker is not a way to fail a mission.
 */
export const POST = ownerRouteWithParams<{ id: string }>(async ({ services, request, params }) => {
  const { reason } = await parseBody(request, schema);
  await services.workerService.revoke(params.id, reason);
  const worker = await services.workerRepo.findById(params.id);
  return json({ worker });
});
