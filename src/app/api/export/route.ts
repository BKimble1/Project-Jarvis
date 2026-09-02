import { json, ownerRoute } from '@/server/http/handler';

export const dynamic = 'force-dynamic';

/**
 * Full data export.
 *
 * Contains projects, sources, sub-entities, evidence, snapshots and activity — and deliberately
 * no sessions, no OAuth state and no configuration, so an export can never carry a credential.
 */
export const GET = ownerRoute(async ({ services }) => {
  const projects = await services.projects.listAllForAssessment(true);
  const ids = projects.map((project) => project.id);
  const aggregates = await services.projects.aggregateMany(ids);

  const payload = {
    exportedAt: new Date().toISOString(),
    version: 1,
    projects: await Promise.all(
      [...aggregates.values()].map(async (aggregate) => ({
        ...aggregate,
        evidence: await services.evidence.list({ projectId: aggregate.project.id, limit: 1000 }),
        snapshots: await services.snapshots.list(aggregate.project.id, 50),
        syncRuns: await services.runs.listByProject(aggregate.project.id, 50),
        activity: await services.activity.listByProject(aggregate.project.id, 200),
      })),
    ),
  };

  await services.activity.record({
    kind: 'data_exported',
    summary: `Exported ${projects.length} project${projects.length === 1 ? '' : 's'}.`,
  });

  return json(payload, {
    headers: { 'content-disposition': `attachment; filename="jarvis-export.json"` },
  });
});
