import { NotFoundError } from '@/domain/errors';
import { projectUpdateSchema } from '@/domain/project';
import { json, ownerRouteWithParams, parseBody } from '@/server/http/handler';

export const dynamic = 'force-dynamic';

export const GET = ownerRouteWithParams<{ id: string }>(async ({ services, params }) => {
  const aggregate = await services.projects.aggregate(params.id);
  if (!aggregate) throw new NotFoundError('Project');
  return json(aggregate);
});

export const PATCH = ownerRouteWithParams<{ id: string }>(async ({ services, request, params }) => {
  const before = await services.projects.findById(params.id);
  if (!before) throw new NotFoundError('Project');
  const input = await parseBody(request, projectUpdateSchema);
  const project = await services.projects.update(params.id, input);

  if (input.status && input.status !== before.status) {
    await services.activity.record({
      projectId: project.id,
      kind: 'status_changed',
      summary: `Status changed from ${before.status} to ${project.status}.`,
    });
  }
  if (input.phase !== undefined && (input.phase ?? null) !== before.phase) {
    await services.activity.record({
      projectId: project.id,
      kind: 'phase_changed',
      summary: `Phase changed from ${before.phase ?? 'none'} to ${project.phase ?? 'none'}.`,
    });
  }
  if (input.goal !== undefined && (input.goal ?? null) !== before.goal) {
    await services.activity.record({
      projectId: project.id,
      kind: 'goal_changed',
      summary: 'Goal updated.',
    });
  }
  await services.activity.record({
    projectId: project.id,
    kind: 'project_updated',
    summary: `Updated ${project.name}.`,
  });
  return json({ project });
});

export const DELETE = ownerRouteWithParams<{ id: string }>(
  async ({ services, request, params }) => {
    const url = new URL(request.url);
    const project = await services.projects.findById(params.id);
    if (!project) throw new NotFoundError('Project');

    /* Deletion is opt-in and explicit; archiving is the default, reversible action. */
    if (url.searchParams.get('mode') === 'delete') {
      await services.projects.remove(params.id);
      await services.activity.record({
        kind: 'project_archived',
        summary: `Deleted ${project.name}.`,
      });
      return json({ deleted: true });
    }

    const archived = await services.projects.archive(params.id);
    await services.activity.record({
      projectId: archived.id,
      kind: 'project_archived',
      summary: `Archived ${archived.name}.`,
    });
    return json({ project: archived });
  },
);
