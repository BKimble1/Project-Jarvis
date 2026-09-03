import { json, ownerRoute } from '@/server/http/handler';

export const dynamic = 'force-dynamic';

/**
 * Full data export.
 *
 * Contains projects, sources, sub-entities, evidence, snapshots, activity and — since Prompt 2 —
 * missions, plans, approvals, runs, events, verifications and artifacts. Since Prompt 3 it also
 * contains the factory's own record: task graphs, tasks, reviews, findings, receipts, playbooks,
 * CI dispatch requests, release approvals, app profiles and paired displays.
 *
 * What it deliberately does **not** contain is every class of credential §27 names: agent runtime
 * credentials, worker secrets, GitHub credentials, CI-controller credentials, Apple credentials,
 * session secrets, display tokens, raw environment values, credential-helper configuration and
 * internal signed commands.
 *
 * Almost none of that is achieved by filtering here, and that is the point. A worker's
 * `token_hash` and a display's `token_hash` are not fields on `JarvisWorker` or `DisplayDevice` at
 * all, so they cannot reach this file even by accident; the CI controller's credential lives in
 * `AppConfig` and never in a row; an app profile stores the *name* of a GitHub Actions secret and
 * refuses at its schema to store a value. The one thing this route does by hand is swap a run's
 * `workerId` for the worker's name, so a run's history stays readable without exporting an
 * identity that pairs with a credential.
 *
 * `assertNoCredentials` is the backstop: a cheap structural scan that fails the export rather
 * than shipping a payload containing something that looks like a key. It exists because the
 * guarantee above is a property of a dozen type definitions, and a future field added to one of
 * them should break the export rather than quietly widen it.
 */

/** Column names that would mean a credential column had been added to an exported table. */
const FORBIDDEN_EXPORT_KEYS = [
  'tokenhash',
  'secrethash',
  'accesstoken',
  'refreshtoken',
  'clientsecret',
  'sessionsecret',
  'credentialtoken',
  'privatekey',
  'apikey',
  'password',
  'authorization',
  'installationtoken',
] as const;

/**
 * Values that are a credential whatever they are called.
 *
 * Deliberately only the shapes that are unambiguous — a PEM header, a provider's own token
 * prefix. The "long base64 blob" heuristic that belongs in an input validator is left out here:
 * an artifact body may legitimately contain one, and an export that refuses to serve because a
 * research report quoted a hash would be a worse failure than the one it prevents.
 */
const CREDENTIAL_VALUES = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bghp_[A-Za-z0-9]{20,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{30,}\b/,
  /\bsk-ant-[A-Za-z0-9-]{20,}\b/,
  /\bjarvisw_[0-9a-f-]{36}\.[A-Za-z0-9_-]{20,}/,
  /\bjarvisd_[0-9a-f-]{36}\.[A-Za-z0-9_-]{20,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
];

/**
 * Blobs whose *keys* come from outside Jarvis.
 *
 * An event detail, a workflow input map and the repository-facts bag are free-form: an agent or a
 * repository chose those key names, and one of them being called `apiKey` says nothing about
 * whether a secret is present — the value is redacted on the way in. So inside these, values are
 * checked and key names are not. Everywhere else, both are.
 */
const FREE_FORM_KEYS = new Set(['detail', 'inputs', 'repositoryFacts', 'metadata', 'facts']);

/**
 * Refuse to serve an export that contains a credential.
 *
 * A whole-payload scan rather than a per-table allow-list, because the failure it guards against
 * is a field nobody remembered to think about — and only a scan catches that one. It is a
 * backstop, not the mechanism: no credential reaches this file in the first place, because none
 * of the exported types has a field that could carry one.
 */
function assertNoCredentials(payload: unknown, path = 'export', freeForm = false): void {
  if (typeof payload === 'string') {
    for (const pattern of CREDENTIAL_VALUES) {
      if (pattern.test(payload)) {
        throw new Error(`The export would have contained a credential at ${path}.`);
      }
    }
    return;
  }
  if (payload === null || typeof payload !== 'object') return;
  if (Array.isArray(payload)) {
    payload.forEach((entry, index) => assertNoCredentials(entry, `${path}[${index}]`, freeForm));
    return;
  }
  for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
    const flattened = key.toLowerCase().replace(/[^a-z]/g, '');
    if (
      !freeForm &&
      FORBIDDEN_EXPORT_KEYS.includes(flattened as (typeof FORBIDDEN_EXPORT_KEYS)[number])
    ) {
      throw new Error(`The export would have contained ${path}.${key}, which is a credential.`);
    }
    assertNoCredentials(value, `${path}.${key}`, freeForm || FREE_FORM_KEYS.has(key));
  }
}

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
      const graphs = await services.graphs.list(mission.id);
      const tasks = (
        await Promise.all(graphs.map((graph) => services.tasks.listByGraph(graph.id)))
      ).flat();
      const [reviews, findings, receipt] = await Promise.all([
        services.reviews.listByMission(mission.id),
        services.reviews.listFindings(mission.id),
        services.receipts.findByMission(mission.id),
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
        graphs,
        tasks,
        reviews,
        findings,
        receipt,
      };
    }),
  );

  const [playbooks, dispatches, displays, appProfiles] = await Promise.all([
    services.playbookService.list(),
    services.ciDispatches.listRecent(200),
    services.displays.list(),
    services.appProfiles.list(),
  ]);
  const releaseApprovals = (
    await Promise.all(ids.map((projectId) => services.releaseApprovals.listForProject(projectId)))
  ).flat();

  const payload = {
    exportedAt: new Date().toISOString(),
    version: 3,
    /*
     * The controller's *shape*, from `describe()`, which reports whether a credential is
     * configured and never what it is. There is no other accessor that could return one.
     */
    ciController: services.ci.describe(),
    playbooks,
    ciDispatches: dispatches,
    releaseApprovals,
    /* `DisplayDevice` carries a token prefix for recognition, never a token or its hash. */
    displays,
    appProfiles,
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

  assertNoCredentials(payload);

  await services.activity.record({
    kind: 'data_exported',
    summary: `Exported ${projects.length} project${projects.length === 1 ? '' : 's'}, ${missions.length} mission${missions.length === 1 ? '' : 's'} and ${playbooks.length} playbook${playbooks.length === 1 ? '' : 's'}.`,
  });

  return json(payload, {
    headers: { 'content-disposition': `attachment; filename="jarvis-export.json"` },
  });
});
