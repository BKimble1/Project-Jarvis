import { json, ownerRouteWithParams } from '@/server/http/handler';

export const dynamic = 'force-dynamic';

export const POST = ownerRouteWithParams<{ id: string }>(async ({ services, params }) => {
  const outcome = await services.sync.syncProject(params.id, 'manual');
  /* Refresh the briefing so freshness and attention flags reflect the new evidence. */
  await services.briefings.briefProject(params.id, { regenerate: true });
  return json({ outcome });
});
