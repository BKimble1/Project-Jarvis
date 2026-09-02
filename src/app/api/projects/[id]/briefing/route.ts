import { json, ownerRouteWithParams } from '@/server/http/handler';

export const dynamic = 'force-dynamic';

export const GET = ownerRouteWithParams<{ id: string }>(async ({ services, params, request }) => {
  const regenerate = new URL(request.url).searchParams.get('regenerate') === 'true';
  const briefing = await services.briefings.briefProject(params.id, { regenerate });
  return json({ briefing });
});

export const POST = ownerRouteWithParams<{ id: string }>(async ({ services, params }) => {
  const briefing = await services.briefings.briefProject(params.id, { regenerate: true });
  return json({ briefing });
});
