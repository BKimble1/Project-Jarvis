import { json, ownerRoute } from '@/server/http/handler';

export const dynamic = 'force-dynamic';

/**
 * Full data export.
 *
 * Contains projects, sources, sub-entities, evidence, snapshots, activity and — since Prompt 2 —
 * missions, plans, approvals, runs, events, verifications and artifacts.
 *
 * It deliberately contains no sessions, no OAuth state, no configuration and, crucially, no
 * worker rows: a worker's `token_hash` is not part of the `JarvisWorker` type at all, so it
 * cannot reach here even by accident. What is exported instead is the worker's *name*, taken from
 * the run, which is what makes a run's history readable without exporting a credential.
 */
export const GET = ownerRoute(async ({ services }) => {
  const projects = await services.projects.listAllForAssessment(true);
  const ids = projects.map((project) => project.id);
  const aggregates = await services.projects.aggregateMany(ids);

  const workerNames = new Map(
    (await services.workerRepo.list()).map((worker) => [worker.id, worker.name] as const),
  );

  const missionPage = await services.missionRepo.list({ limit: 200 });
  const missions = await Promise.all(
    missionPage.items.map(async (mission) => {
      const [
        plans,
        approvals,
        clarifications,
        runs,
        events,
        permissionRequests,
        verifications,
        artifacts,
      ] = await Promise.all([
        services.plans.list(mission.id),
        services.approvals.list(mission.id),
        services.clarifications.list(mission.id),
        services.missionRuns.list(mission.id),
        services.missionEvents.list(mission.id, { limit: 500 }),
        services.permissions.list(mission.id),
        services.verifications.list(mission.id),
        services.artifacts.list(mission.id),
      ]);
      return {
        mission,
        plans,
        approvals,
        clarifications,
        /* Worker identity is exported as a name, never as an id-plus-credential pair. */
        runs: runs.map(({ workerId, ...run }) => ({
          ...run,
          workerName: workerNames.get(workerId) ?? 'removed worker',
        })),
        events,
        permissionRequests,
        verifications,
        artifacts,
      };
    }),
  );

  const payload = {
    exportedAt: new Date().toISOString(),
    version: 2,
    projects: await Promise.all(
      [...aggregates.values()].map(async (aggregate) => ({
        ...aggregate,
        evidence: await services.evidence.list({ projectId: aggregate.project.id, limit: 1000 }),
        snapshots: await services.snapshots.list(aggregate.project.id, 50),
        syncRuns: await services.runs.listByProject(aggregate.project.id, 50),
        activity: await services.activity.listByProject(aggregate.project.id, 200),
      })),
    ),
    missions,
  };

  await services.activity.record({
    kind: 'data_exported',
    summary: `Exported ${projects.length} project${projects.length === 1 ? '' : 's'} and ${missions.length} mission${missions.length === 1 ? '' : 's'}.`,
  });

  return json(payload, {
    headers: { 'content-disposition': `attachment; filename="jarvis-export.json"` },
  });
});
