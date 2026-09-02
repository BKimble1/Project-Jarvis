import { json, ownerRouteWithParams } from '@/server/http/handler';

export const dynamic = 'force-dynamic';

export const POST = ownerRouteWithParams<{ id: string }>(async ({ services, params }) => {
  const project = await services.projects.restore(params.id);
  await services.activity.record({
    projectId: project.id,
    kind: 'project_restored',
    summary: `Restored ${project.name}.`,
  });
  return json({ project });
});
