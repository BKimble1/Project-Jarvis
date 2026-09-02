import { json, ownerRouteWithParams } from '@/server/http/handler';

export const dynamic = 'force-dynamic';

/** Issues a fresh secret and forgets the old hash. The previous token stops working immediately. */
export const POST = ownerRouteWithParams<{ id: string }>(async ({ services, params }) => {
  return json(await services.workerService.rotate(params.id));
});
