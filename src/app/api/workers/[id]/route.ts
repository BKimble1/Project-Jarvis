import { NotFoundError } from '@/domain/errors';
import { json, ownerRouteWithParams } from '@/server/http/handler';

export const dynamic = 'force-dynamic';

export const GET = ownerRouteWithParams<{ id: string }>(async ({ services, params }) => {
  const worker = await services.workerRepo.findById(params.id);
  if (!worker) throw new NotFoundError('Worker');
  return json({ worker });
});

/** Removes an enrolled worker outright. Revoking is usually the better choice. */
export const DELETE = ownerRouteWithParams<{ id: string }>(async ({ services, params }) => {
  await services.workerRepo.remove(params.id);
  return json({ ok: true });
});
