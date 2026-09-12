import { projectInputSchema } from '@/domain/project';
import { json, ownerRoute, parseBody } from '@/server/http/handler';

export const dynamic = 'force-dynamic';

export const GET = ownerRoute(async ({ services, request }) => {
  const url = new URL(request.url);
  const page = await services.projects.list({
    search: url.searchParams.get('search') ?? undefined,
    includeArchived: url.searchParams.get('archived') === 'true',
    limit: Number(url.searchParams.get('limit') ?? 200),
  });
  return json(page);
});

export const POST = ownerRoute(async ({ services, request }) => {
  const input = await parseBody(request, projectInputSchema);
  const project = await services.projects.create(input);
  await services.sources.addManualSource(project.id);
  await services.activity.record({
    projectId: project.id,
    kind: 'project_created',
    summary: `Created ${project.name}.`,
    detail: { type: project.type },
  });
  return json({ project }, { status: 201 });
});
