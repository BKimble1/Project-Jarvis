import { json, ownerRoute } from '@/server/http/handler';

export const dynamic = 'force-dynamic';

export const GET = ownerRoute(async ({ services, request }) => {
  if (!services.provider.isConfigured()) {
    return json({ configured: false, repositories: [], health: null });
  }
  const search = new URL(request.url).searchParams.get('search') ?? undefined;
  const [repositories, health] = await Promise.all([
    services.imports.listImportable(search),
    services.provider.checkHealth(),
  ]);
  return json({ configured: true, repositories, health });
});
