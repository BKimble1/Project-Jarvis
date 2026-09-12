import { json, ownerRouteWithParams } from '@/server/http/handler';

export const dynamic = 'force-dynamic';

/** Manual retry. Records a new attempt; the earlier one and its workspace are preserved. */
export const POST = ownerRouteWithParams<{ id: string }>(async ({ services, params }) => {
  return json({ mission: await services.missions.retry(params.id) });
});
