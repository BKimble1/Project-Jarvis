import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConflictError, JarvisError, ValidationError } from '@/domain/errors';
import type { EvidenceInput } from '@/domain/evidence';
import { projectInputSchema, type ProjectSource } from '@/domain/project';
import type { FetchContext, SourceSnapshot } from '@/server/providers/types';
import { importRequestSchema, type ImportRequest } from '@/server/services/import-service';
import { evidenceInput, hoursBefore } from '../helpers/factories';
import {
  failedSnapshot,
  makeRepositorySummary,
  okSnapshot,
  partialSnapshot,
} from '../helpers/fake-provider';
import { createHarness, type TestHarness } from '../helpers/services';

const REPO = makeRepositorySummary({ owner: 'test-owner', repo: 'aurora' });

/**
 * Asserting on a thrown `JarvisError` needs the instance itself — its `code` and `details` are
 * the contract route handlers depend on, and `rejects.toThrow` only ever sees the message.
 */
async function captureError(run: () => Promise<unknown>): Promise<JarvisError> {
  try {
    await run();
  } catch (error) {
    if (error instanceof JarvisError) return error;
    throw error;
  }
  throw new Error('Expected the operation to reject, but it resolved.');
}

describe('importing a GitHub repository', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await createHarness();
    harness.provider.repositories = [REPO];
  });

  afterEach(async () => {
    await harness.close();
  });

  /*
   * The project only exists once the import has created it, so the first sync's evidence cannot
   * be queued up front — it is built from the fetch context the sync service passes in.
   */
  const respondWith = (build: (context: FetchContext) => SourceSnapshot): void => {
    /* Keeps the fake's call counter honest, so `provider.calls` assertions cannot pass vacuously. */
    harness.provider.fetchSnapshot = async (source: ProjectSource, context: FetchContext) => {
      harness.provider.calls += 1;
      harness.provider.requested.push(
        source.github ? `${source.github.owner}/${source.github.repo}` : '',
      );
      return build(context);
    };
  };

  function importedEvidence(context: FetchContext): EvidenceInput[] {
    return [
      evidenceInput({
        projectId: context.projectId,
        sourceId: context.sourceId,
        kind: 'git_commit',
        externalId: 'commit-abc123',
        title: 'Add the evidence timeline',
        url: `${REPO.url}/commit/abc123`,
        observedAt: hoursBefore(3, context.now),
        metadata: { sha: 'abc123' },
      }),
      evidenceInput({
        projectId: context.projectId,
        sourceId: context.sourceId,
        kind: 'pull_request',
        externalId: 'pr-7',
        title: '#7 Evidence timeline',
        url: `${REPO.url}/pull/7`,
        observedAt: hoursBefore(5, context.now),
        metadata: { number: 7, state: 'merged', merged: true },
      }),
    ];
  }

  it('creates the project, connects the repository and reports a full first synchronisation', async () => {
    const { services } = harness;
    respondWith((context) => okSnapshot(importedEvidence(context)));

    const result = await services.imports.import(
      importRequestSchema.parse({ owner: 'test-owner', repo: 'aurora' }),
    );

    expect(result.outcome).toBe('full');
    expect(result.message).toBe('Imported test-owner/aurora and synchronised 2 records.');
    expect(result.sync.status).toBe('ok');
    expect(result.sync.evidenceWritten).toBe(2);

    expect(result.project.name).toBe('aurora');
    expect(result.project.type).toBe('software');
    expect(result.project.status).toBe('active');
    expect(result.project.description).toBe('A fixture repository.');
    expect(result.project.links).toEqual([
      { label: 'Repository', url: 'https://github.com/test-owner/aurora' },
    ]);

    const sources = await services.sources.listByProject(result.project.id);
    expect(sources).toHaveLength(1);
    expect(sources[0]?.kind).toBe('github_repo');
    expect(sources[0]?.isPrimary).toBe(true);
    expect(sources[0]?.label).toBe('test-owner/aurora');
    expect(sources[0]?.github?.owner).toBe('test-owner');
    expect(sources[0]?.github?.repo).toBe('aurora');
    expect(sources[0]?.syncStatus).toBe('ok');

    const stored = await services.evidence.list({ projectId: result.project.id });
    expect(stored.map((row) => row.externalId).sort()).toEqual(['commit-abc123', 'pr-7']);
    expect(stored.every((row) => row.sourceId === sources[0]?.id)).toBe(true);

    const runs = await services.sync.history(result.project.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.trigger).toBe('import');
    expect(runs[0]?.status).toBe('ok');
    expect(runs[0]?.evidenceWritten).toBe(2);

    const activity = await services.activity.listByProject(result.project.id);
    const created = activity.find((entry) => entry.kind === 'project_created');
    expect(created?.summary).toBe('Imported test-owner/aurora from GitHub.');
    expect(created?.detail.visibility).toBe('private');
    expect(created?.detail.archived).toBe(false);
  });

  it('refuses a second import of the same repository, case-insensitively, and creates nothing', async () => {
    const { services } = harness;
    respondWith(() => okSnapshot([], { repo: null }));

    const first = await services.imports.import(
      importRequestSchema.parse({ owner: 'test-owner', repo: 'aurora' }),
    );

    const duplicate = await captureError(() =>
      services.imports.import(importRequestSchema.parse({ owner: 'test-owner', repo: 'aurora' })),
    );
    expect(duplicate).toBeInstanceOf(ConflictError);
    expect(duplicate.code).toBe('conflict');
    expect(duplicate.httpStatus).toBe(409);
    expect(duplicate.message).toBe('test-owner/aurora is already connected to a project.');
    expect(duplicate.details.projectId).toBe(first.project.id);

    /* GitHub owners and repository names are case-insensitive, so casing cannot smuggle in a
       second copy of a project the owner already has. */
    const recased = await captureError(() =>
      services.imports.import(importRequestSchema.parse({ owner: 'TEST-OWNER', repo: 'Aurora' })),
    );
    expect(recased).toBeInstanceOf(ConflictError);
    expect(recased.details.projectId).toBe(first.project.id);

    const projects = await services.projects.list();
    expect(projects.total).toBe(1);
    expect(projects.items.map((project) => project.id)).toEqual([first.project.id]);
    expect(await services.sources.listAllGithubSources()).toHaveLength(1);
    /* A refused duplicate must not have reached GitHub at all: only the first import synced. */
    expect(harness.provider.calls).toBe(1);
  });

  it('reports a partial first synchronisation honestly instead of claiming success', async () => {
    const { services } = harness;
    respondWith((context) => partialSnapshot(importedEvidence(context)));

    const result = await services.imports.import(
      importRequestSchema.parse({ owner: 'test-owner', repo: 'aurora' }),
    );

    expect(result.outcome).toBe('partial');
    expect(result.sync.status).toBe('partial');
    expect(result.message).toBe(
      'Imported test-owner/aurora, but some data could not be read. ' +
        'Some data was unavailable: issues, workflow_runs.',
    );
    expect(result.sync.evidenceWritten).toBe(2);

    const sources = await services.sources.listByProject(result.project.id);
    expect(sources[0]?.syncStatus).toBe('partial');
    expect(sources[0]?.unavailableCapabilities).toEqual(['issues', 'workflow_runs']);
  });

  it('keeps the project when the first synchronisation fails, so the owner can retry', async () => {
    const { services } = harness;
    respondWith(() => failedSnapshot('GitHub rejected the credential.'));

    const result = await services.imports.import(
      importRequestSchema.parse({ owner: 'test-owner', repo: 'aurora' }),
    );

    expect(result.outcome).toBe('failed');
    expect(result.sync.status).toBe('failed');
    expect(result.sync.evidenceWritten).toBe(0);
    expect(result.message).toBe(
      'Imported test-owner/aurora, but the first synchronisation failed. ' +
        'GitHub rejected the credential.',
    );

    /* A failed first sync is a retryable state, not a reason to discard the owner's import. */
    const stored = await services.projects.findById(result.project.id);
    expect(stored?.name).toBe('aurora');
    expect((await services.projects.list()).total).toBe(1);

    const sources = await services.sources.listByProject(result.project.id);
    expect(sources).toHaveLength(1);
    expect(sources[0]?.syncStatus).toBe('failed');
    expect(sources[0]?.lastSyncError).toBe('GitHub rejected the credential.');

    const runs = await services.sync.history(result.project.id);
    expect(runs[0]?.status).toBe('failed');
    expect(runs[0]?.errorCode).toBe('unauthorized');
  });

  it('imports an archived repository as an archived project', async () => {
    const { services } = harness;
    harness.provider.repositories = [
      makeRepositorySummary({ owner: 'test-owner', repo: 'atlas', archived: true }),
    ];
    /* `repo: null` keeps the fake's aurora identity from overwriting the atlas source. */
    respondWith(() => okSnapshot([], { repo: null }));

    const result = await services.imports.import(
      importRequestSchema.parse({ owner: 'test-owner', repo: 'atlas' }),
    );

    expect(result.outcome).toBe('full');
    expect(result.project.name).toBe('atlas');
    expect(result.project.status).toBe('archived');
    /* Archived on GitHub is not the same as archived in Jarvis: the project stays visible. */
    expect(result.project.archivedAt).toBeNull();

    const activity = await services.activity.listByProject(result.project.id);
    expect(activity.find((entry) => entry.kind === 'project_created')?.detail.archived).toBe(true);
  });

  it('marks repositories that are already imported when listing importable ones', async () => {
    const { services } = harness;
    harness.provider.repositories = [
      REPO,
      makeRepositorySummary({ owner: 'test-owner', repo: 'borealis', id: 1002 }),
    ];
    respondWith(() => okSnapshot([], { repo: null }));

    const imported = await services.imports.import(
      importRequestSchema.parse({ owner: 'test-owner', repo: 'aurora' }),
    );

    const listed = await services.imports.listImportable();
    expect(listed.map((repo) => repo.fullName)).toEqual([
      'test-owner/aurora',
      'test-owner/borealis',
    ]);
    expect(listed[0]?.alreadyImported).toBe(true);
    expect(listed[0]?.importedProjectId).toBe(imported.project.id);
    expect(listed[1]?.alreadyImported).toBe(false);
    expect(listed[1]?.importedProjectId).toBeNull();
  });

  it('rejects an invalid owner with a validation error before touching the database', async () => {
    const { services } = harness;
    const request: ImportRequest = {
      owner: 'bad owner!',
      repo: 'aurora',
      type: 'software',
      priority: 'medium',
      tags: [],
    };

    const failure = await captureError(() => services.imports.import(request));

    expect(failure).toBeInstanceOf(ValidationError);
    expect(failure.code).toBe('validation_failed');
    expect(failure.httpStatus).toBe(422);
    expect(failure.message).toBe('That repository could not be imported.');
    expect(failure.details.issues).toEqual(['Invalid GitHub owner']);

    expect((await services.projects.list()).total).toBe(0);
    /* "Before touching the database" also means before touching the network. */
    expect(harness.provider.calls).toBe(0);
    expect(await services.sources.listAllGithubSources()).toHaveLength(0);
  });
});

describe('project and portfolio briefings', () => {
  let harness: TestHarness;
  let now: Date;

  /*
   * The clock is anchored to real time because the repositories stamp `lastManualUpdateAt` and
   * `fetchedAt` from the wall clock; an injected clock in the past would make every age zero and
   * the freshness assertions meaningless.
   */
  const clock = (): Date => now;
  const advanceHours = (hours: number): void => {
    now = new Date(now.getTime() + hours * 3_600_000);
  };

  beforeEach(async () => {
    now = new Date();
    harness = await createHarness({ clock });
  });

  afterEach(async () => {
    await harness.close();
  });

  async function seedProject(name = 'Aurora'): Promise<string> {
    const project = await harness.services.projects.create(
      projectInputSchema.parse({
        name,
        type: 'software',
        phase: 'Build',
        goal: 'Ship the first usable version.',
      }),
    );
    return project.id;
  }

  const addBlocker = async (projectId: string, title: string): Promise<void> => {
    await harness.services.projects.addBlocker(projectId, {
      title,
      description: null,
      severity: 'high',
      resolutionRequirement: null,
      requiresOwnerDecision: false,
    });
  };

  it('persists a snapshot, refreshes the derived state and logs the generation', async () => {
    const { services } = harness;
    const projectId = await seedProject();
    await addBlocker(projectId, 'Waiting on a provider decision');

    const briefing = await services.briefings.briefProject(projectId);

    expect(briefing.method).toBe('deterministic');
    expect(briefing.assessment.status).toBe('blocked');
    expect(briefing.generatedAt).toBe(now.toISOString());

    const snapshots = await services.snapshots.list(projectId);
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]?.status).toBe('blocked');
    expect(snapshots[0]?.phase).toBe('Build');
    expect(snapshots[0]?.fingerprint).toBe(briefing.assessment.evidenceFingerprint);
    expect(snapshots[0]?.summaryMethod).toBe('deterministic');
    expect(snapshots[0]?.generatedAt).toBe(now.toISOString());
    expect(snapshots[0]?.headline).toBe(briefing.narrative.currentState);
    expect(snapshots[0]?.blockers.map((item) => item.text)).toEqual([
      'Waiting on a provider decision',
    ]);
    expect(snapshots[0]?.freshness.state).toBe('live');

    /* The denormalised columns are what list screens read, so they must follow the assessment. */
    const refreshed = await services.projects.findById(projectId);
    expect(refreshed?.needsAttention).toBe(true);
    expect(refreshed?.freshness).toBe('live');
    expect(refreshed?.freshness).toBe(briefing.assessment.freshness.state);

    const generated = (await services.activity.listByProject(projectId)).filter(
      (entry) => entry.kind === 'briefing_generated',
    );
    expect(generated).toHaveLength(1);
    expect(generated[0]?.summary).toBe('Briefing generated (deterministic).');
    expect(generated[0]?.detail.method).toBe('deterministic');
    expect(generated[0]?.detail.fingerprint).toBe(briefing.assessment.evidenceFingerprint);
  });

  it('reuses the stored narrative when the evidence fingerprint has not changed', async () => {
    const { services } = harness;
    const projectId = await seedProject();

    const first = await services.briefings.briefProject(projectId);
    advanceHours(1);
    const second = await services.briefings.briefProject(projectId);

    expect(second.assessment.evidenceFingerprint).toBe(first.assessment.evidenceFingerprint);
    expect(second.narrative).toEqual(first.narrative);
    expect(second.method).toBe('deterministic');
    /* The briefing is dated when it was written, not when it was re-read. */
    expect(second.generatedAt).toBe(first.generatedAt);
    expect(second.assessment.generatedAt).toBe(now.toISOString());
    expect(second.assessment.generatedAt).not.toBe(first.assessment.generatedAt);

    expect(await services.snapshots.list(projectId)).toHaveLength(1);
    const generated = (await services.activity.listByProject(projectId)).filter(
      (entry) => entry.kind === 'briefing_generated',
    );
    expect(generated).toHaveLength(1);
  });

  it('writes a fresh snapshot when the owner explicitly regenerates', async () => {
    const { services } = harness;
    const projectId = await seedProject();

    const first = await services.briefings.briefProject(projectId);
    advanceHours(1);
    const regenerated = await services.briefings.briefProject(projectId, { regenerate: true });

    expect(regenerated.assessment.evidenceFingerprint).toBe(first.assessment.evidenceFingerprint);
    expect(regenerated.generatedAt).toBe(now.toISOString());

    const snapshots = await services.snapshots.list(projectId);
    expect(snapshots).toHaveLength(2);
    expect(snapshots[0]?.generatedAt).toBe(now.toISOString());
    expect(snapshots.map((snapshot) => snapshot.fingerprint)).toEqual([
      first.assessment.evidenceFingerprint,
      first.assessment.evidenceFingerprint,
    ]);
    /* Two identical snapshots are not a change, so there is still no comparison baseline. */
    expect(await services.snapshots.previousDistinct(projectId)).toBeNull();

    const generated = (await services.activity.listByProject(projectId)).filter(
      (entry) => entry.kind === 'briefing_generated',
    );
    expect(generated).toHaveLength(2);
  });

  it('keeps the earlier snapshot as history when a new blocker changes the fingerprint', async () => {
    const { services } = harness;
    const projectId = await seedProject();

    const before = await services.briefings.briefProject(projectId);
    expect(before.assessment.status).toBe('active');

    advanceHours(1);
    await addBlocker(projectId, 'Waiting on a provider decision');
    const after = await services.briefings.briefProject(projectId);

    expect(after.assessment.status).toBe('blocked');
    expect(after.assessment.evidenceFingerprint).not.toBe(before.assessment.evidenceFingerprint);

    const snapshots = await services.snapshots.list(projectId);
    expect(snapshots).toHaveLength(2);
    expect(snapshots.map((snapshot) => snapshot.status)).toEqual(['blocked', 'active']);

    const latest = await services.snapshots.latest(projectId);
    expect(latest?.fingerprint).toBe(after.assessment.evidenceFingerprint);

    /* History is additive: the pre-blocker state stays exactly as it was recorded. */
    const previous = await services.snapshots.previousDistinct(projectId);
    expect(previous?.fingerprint).toBe(before.assessment.evidenceFingerprint);
    expect(previous?.status).toBe('active');
    expect(previous?.headline).toBe(before.narrative.currentState);
    expect(previous?.blockers).toEqual([]);
    expect(previous?.generatedAt).toBe(before.generatedAt);
  });

  it('reports the new blocker as a change and reports nothing when nothing changed', async () => {
    const { services } = harness;
    const projectId = await seedProject();

    await services.briefings.briefProject(projectId);
    /* A first snapshot is a baseline, not a change. */
    expect(await services.briefings.changesForProject(projectId)).toEqual([]);

    advanceHours(1);
    await services.briefings.briefProject(projectId, { regenerate: true });
    expect(await services.briefings.changesForProject(projectId)).toEqual([]);

    advanceHours(1);
    await addBlocker(projectId, 'Waiting on a provider decision');
    await services.briefings.briefProject(projectId);

    const changes = await services.briefings.changesForProject(projectId);
    const kinds = changes.map((change) => change.kind);
    expect(kinds).toContain('blocker_added');
    expect(kinds).toContain('status_changed');

    const added = changes.find((change) => change.kind === 'blocker_added');
    expect(added?.summary).toBe('New blocker: Waiting on a provider decision');
    expect(added?.provenance).toBe('manual');
    expect(added?.projectId).toBe(projectId);
    expect(added?.occurredAt).toBe(now.toISOString());

    const statusChange = changes.find((change) => change.kind === 'status_changed');
    expect(statusChange?.summary).toBe('Status changed from active to blocked');
  });

  it('summarises a mixed portfolio with counts, focus order and per-project assessments', async () => {
    const { services } = harness;

    const active = await services.projects.create(
      projectInputSchema.parse({
        name: 'Northwind',
        type: 'business',
        priority: 'high',
        goal: 'Sign the first three customers.',
      }),
    );
    const blocked = await services.projects.create(
      projectInputSchema.parse({
        name: 'Halcyon',
        type: 'research',
        goal: 'Publish the methodology review.',
      }),
    );
    await services.projects.addBlocker(blocked.id, {
      title: 'Choose the hosting provider',
      description: null,
      severity: 'high',
      resolutionRequirement: null,
      requiresOwnerDecision: true,
    });
    const paused = await services.projects.create(
      projectInputSchema.parse({
        name: 'Meridian',
        type: 'career',
        status: 'paused',
        goal: 'Move into a staff engineering role.',
      }),
    );
    const stale = await services.projects.create(
      projectInputSchema.parse({
        name: 'Aurora',
        type: 'software',
        goal: 'Ship the first usable version.',
      }),
    );

    /* Ten days is stale for a software project (7-day window) but merely recent for the
       slower-moving types, so a single clock advance produces a genuinely mixed portfolio. */
    advanceHours(24 * 10);

    const { briefing, projects, assessments } = await services.briefings.briefPortfolio();

    expect(projects.map((project) => project.name).sort()).toEqual([
      'Aurora',
      'Halcyon',
      'Meridian',
      'Northwind',
    ]);
    expect(briefing.assessment.counts).toEqual({
      total: 4,
      active: 2,
      progressing: 1,
      needsAttention: 2,
      blocked: 1,
      waiting: 0,
      paused: 1,
      completed: 0,
      stale: 1,
      archived: 0,
      syncFailing: 0,
    });
    expect(briefing.assessment.blockedProjectIds).toEqual([blocked.id]);
    expect(briefing.assessment.pausedProjectIds).toEqual([paused.id]);
    expect(briefing.assessment.staleProjectIds).toEqual([stale.id]);
    expect(briefing.assessment.progressingProjectIds).toEqual([active.id]);

    expect(assessments.size).toBe(4);
    expect(assessments.get(active.id)?.status).toBe('active');
    expect(assessments.get(active.id)?.freshness.state).toBe('recent');
    expect(assessments.get(blocked.id)?.status).toBe('blocked');
    expect(assessments.get(blocked.id)?.statusProvenance).toBe('inferred');
    expect(assessments.get(paused.id)?.status).toBe('paused');
    expect(assessments.get(paused.id)?.needsAttention).toBe(false);
    expect(assessments.get(stale.id)?.status).toBe('active');
    expect(assessments.get(stale.id)?.freshness.state).toBe('stale');

    /* Focus order is the worst thing true of each project, not a score: a decision the owner
       owes outranks stale data, which outranks a quiet project, and paused work comes last. */
    expect(
      briefing.assessment.focusOrder.map((entry) => [entry.rank, entry.projectName, entry.reason]),
    ).toEqual([
      [1, 'Halcyon', 'Decision needed: Choose the hosting provider'],
      [2, 'Aurora', 'No new evidence for 10 days.'],
      [3, 'Northwind', 'Progressing with nothing outstanding.'],
      [4, 'Meridian', 'Paused — nothing is expected until you resume it.'],
    ]);
    expect(briefing.assessment.focusOrder[0]?.provenance).toBe('manual');
    expect(briefing.assessment.focusOrder[1]?.provenance).toBe('verified');

    expect(briefing.assessment.decisionsNeeded).toHaveLength(1);
    expect(briefing.assessment.decisionsNeeded[0]?.code).toBe('decision_required');
    expect(briefing.assessment.decisionsNeeded[0]?.severity).toBe('critical');
    expect(briefing.assessment.decisionsNeeded[0]?.rule).toBe(
      'R-AT1-blocker-requires-owner-decision',
    );

    expect(briefing.method).toBe('deterministic');
    expect(briefing.narratorError).toBeNull();
    expect(briefing.narrative.headline).toBe(
      '2 active projects, 2 needing your attention, 1 blocked, 1 paused, 1 with stale data.',
    );
    expect(briefing.narrative.focusOrder[0]).toBe(
      'Halcyon — Decision needed: Choose the hosting provider',
    );
    expect(briefing.narrative.decisionsNeeded).toEqual([
      'Decision needed: Choose the hosting provider',
    ]);
    /* No evidence has been observed, so there is nothing to report as a recent change. */
    expect(briefing.assessment.recentChanges).toEqual([]);
    expect(briefing.narrative.importantChanges).toEqual([]);
    expect(briefing.assessment.unknowns).toEqual([]);

    /* Jarvis reports what the evidence supports; a completion percentage is never one of them. */
    expect(JSON.stringify(briefing)).not.toMatch(/\d+\s*%/);
  });
});
