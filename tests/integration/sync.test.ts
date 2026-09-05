import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Evidence, EvidenceInput } from '@/domain/evidence';
import { projectInputSchema, type Project, type ProjectSource } from '@/domain/project';
import { NOW, evidenceInput, hoursBefore } from '../helpers/factories';
import {
  failedSnapshot,
  makeRepositorySummary,
  okSnapshot,
  partialSnapshot,
} from '../helpers/fake-provider';
import { createHarness, type TestHarness } from '../helpers/services';

/** Every fixture source points at this repository; `okSnapshot` reports the same identity back. */
const REPO = makeRepositorySummary({ owner: 'test-owner', repo: 'aurora' });

describe('project synchronisation', () => {
  let harness: TestHarness;
  let now: Date;

  const clock = (): Date => now;
  const advanceHours = (hours: number): void => {
    now = new Date(now.getTime() + hours * 3_600_000);
  };

  beforeEach(async () => {
    now = NOW;
    harness = await createHarness({ clock });
  });

  afterEach(async () => {
    await harness.close();
  });

  async function seedProject(
    options: { name?: string; repo?: string } = {},
  ): Promise<{ project: Project; source: ProjectSource }> {
    const project = await harness.services.projects.create(
      projectInputSchema.parse({
        name: options.name ?? 'Aurora',
        type: 'software',
        goal: 'Ship the first usable version.',
      }),
    );
    const source = await harness.services.sources.addGithubSource(project.id, {
      owner: REPO.owner,
      repo: options.repo ?? REPO.repo,
    });
    return { project, source };
  }

  /* A real provider stamps every record with the source it came from, and freshness depends on
     that link to tell "evidence from a healthy source" from "evidence from a broken one". */
  function githubEvidence(projectId: string, sourceId: string): EvidenceInput[] {
    return [
      evidenceInput({
        projectId,
        sourceId,
        kind: 'git_commit',
        externalId: 'commit-abc123',
        title: 'Add the evidence timeline',
        url: `${REPO.url}/commit/abc123`,
        observedAt: hoursBefore(3),
        metadata: { sha: 'abc123', author: REPO.owner },
      }),
      evidenceInput({
        projectId,
        sourceId,
        kind: 'pull_request',
        externalId: 'pr-7',
        title: '#7 Evidence timeline',
        url: `${REPO.url}/pull/7`,
        observedAt: hoursBefore(5),
        metadata: { number: 7, state: 'merged', merged: true },
      }),
    ];
  }

  const sortedIds = (rows: readonly { readonly id: string }[]): string[] =>
    rows.map((row) => row.id).sort();

  it('writes evidence, records the run and logs the activity on a first synchronisation', async () => {
    const { services, provider } = harness;
    const { project, source } = await seedProject();
    provider.snapshots = [okSnapshot(githubEvidence(project.id, source.id))];

    const outcome = await services.sync.syncProject(project.id);

    expect(outcome.status).toBe('ok');
    expect(outcome.evidenceWritten).toBe(2);
    expect(outcome.skipped).toBeUndefined();
    expect(outcome.message).toBe('Synchronised 2 evidence records.');
    expect(outcome.runId).not.toBeNull();

    const stored = await services.evidence.list({ projectId: project.id });
    expect(stored.map((row) => row.externalId).sort()).toEqual(['commit-abc123', 'pr-7']);
    expect(stored.every((row) => row.sourceId === source.id)).toBe(true);
    expect(stored.every((row) => row.sourceSystem === 'github')).toBe(true);

    const synced = await services.sources.findById(source.id);
    expect(synced?.syncStatus).toBe('ok');
    expect(synced?.lastSyncOkAt).toBe(NOW.toISOString());
    expect(synced?.lastSyncFailedAt).toBeNull();
    expect(synced?.lastSyncError).toBeNull();
    expect(synced?.availableCapabilities).toEqual(['metadata', 'commits', 'pull_requests']);
    expect(synced?.unavailableCapabilities).toEqual([]);
    /* The snapshot is authoritative for repository metadata, so the source adopts it. */
    expect(synced?.github?.repoId).toBe(REPO.id);
    expect(synced?.github?.defaultBranch).toBe('main');
    expect(synced?.github?.visibility).toBe('private');

    const runs = await services.sync.history(project.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.id).toBe(outcome.runId);
    expect(runs[0]?.status).toBe('ok');
    expect(runs[0]?.trigger).toBe('manual');
    expect(runs[0]?.sourceId).toBe(source.id);
    expect(runs[0]?.evidenceWritten).toBe(2);
    expect(runs[0]?.categoryResults).toEqual({ metadata: { ok: true, count: 1 } });
    expect(runs[0]?.rateLimitLimit).toBe(5000);
    expect(runs[0]?.rateLimitRemaining).toBe(4990);
    expect(runs[0]?.finishedAt).not.toBeNull();
    expect(runs[0]?.errorCode).toBeNull();

    const refreshed = await services.projects.findById(project.id);
    expect(refreshed?.lastSyncedAt).toBe(NOW.toISOString());

    const activity = await services.activity.listByProject(project.id);
    const kinds = activity.map((entry) => entry.kind);
    expect(kinds).toContain('sync_started');
    expect(kinds).toContain('sync_completed');
    expect(kinds).not.toContain('sync_failed');
    expect(activity.find((entry) => entry.kind === 'sync_started')?.summary).toBe(
      'Synchronising test-owner/aurora.',
    );
    expect(activity.find((entry) => entry.kind === 'sync_started')?.detail.trigger).toBe('manual');
    expect(activity.find((entry) => entry.kind === 'sync_completed')?.summary).toBe(
      'Synchronised test-owner/aurora.',
    );
    expect(activity.find((entry) => entry.kind === 'sync_completed')?.detail.evidenceWritten).toBe(
      2,
    );
  });

  it('is idempotent: the same snapshot twice updates the same rows instead of duplicating', async () => {
    const { services, provider } = harness;
    const { project, source } = await seedProject();
    provider.snapshots = [okSnapshot(githubEvidence(project.id, source.id))];

    const first = await services.sync.syncProject(project.id);
    const before = await services.evidence.list({ projectId: project.id });

    /* `fetchedAt` comes from the service's injected clock, so advancing it is enough. */
    advanceHours(1);
    const second = await services.sync.syncProject(project.id);
    const after = await services.evidence.list({ projectId: project.id });

    expect(provider.calls).toBe(2);
    expect(first.evidenceWritten).toBe(2);
    expect(second.evidenceWritten).toBe(2);
    expect(after).toHaveLength(before.length);
    expect(after).toHaveLength(2);
    expect(sortedIds(after)).toEqual(sortedIds(before));
    expect((await services.evidence.countByProject([project.id])).get(project.id)).toBe(2);

    const beforeFetched = before.map((row) => Date.parse(row.fetchedAt));
    const afterFetched = after.map((row) => Date.parse(row.fetchedAt));
    expect(Math.min(...afterFetched)).toBeGreaterThan(Math.max(...beforeFetched));
    /* Re-observing must not rewrite when the event actually happened. */
    expect(after.map((row) => row.observedAt)).toEqual(before.map((row) => row.observedAt));

    const runs = await services.sync.history(project.id);
    expect(runs).toHaveLength(2);
    expect(runs.map((run) => run.status)).toEqual(['ok', 'ok']);
  });

  it('records a partial synchronisation with its unavailable capabilities and keeps the evidence', async () => {
    const { services, provider } = harness;
    const { project, source } = await seedProject();
    provider.snapshots = [partialSnapshot(githubEvidence(project.id, source.id))];

    const outcome = await services.sync.syncProject(project.id);

    expect(outcome.status).toBe('partial');
    expect(outcome.evidenceWritten).toBe(2);
    expect(outcome.message).toBe('Some data was unavailable: issues, workflow_runs.');
    expect(outcome.skipped).toBeUndefined();

    const stored = await services.evidence.list({ projectId: project.id });
    expect(stored).toHaveLength(2);

    const synced = await services.sources.findById(source.id);
    expect(synced?.syncStatus).toBe('partial');
    expect(synced?.unavailableCapabilities).toEqual(['issues', 'workflow_runs']);
    expect(synced?.availableCapabilities).toEqual(['metadata', 'commits']);
    expect(synced?.lastSyncError).toBe('Some data was unavailable: issues, workflow_runs.');
    /* Partial is degraded, not broken: nothing may be branded as a failure. */
    expect(synced?.lastSyncOkAt).toBe(NOW.toISOString());
    expect(synced?.lastSyncFailedAt).toBeNull();

    const runs = await services.sync.history(project.id);
    expect(runs[0]?.status).toBe('partial');
    expect(runs[0]?.evidenceWritten).toBe(2);
    expect(runs[0]?.errorCode).toBeNull();

    const refreshed = await services.projects.findById(project.id);
    expect(refreshed?.lastSyncedAt).toBe(NOW.toISOString());

    const activity = await services.activity.listByProject(project.id);
    expect(activity.map((entry) => entry.kind)).not.toContain('sync_failed');
    const completed = activity.find((entry) => entry.kind === 'sync_completed');
    expect(completed?.summary).toBe('Synchronised test-owner/aurora with some data unavailable.');
    expect(completed?.detail.unavailable).toEqual(['issues', 'workflow_runs']);
  });

  it('preserves previously verified evidence when a later synchronisation fails', async () => {
    const { services, provider } = harness;
    const { project, source } = await seedProject();
    provider.snapshots = [
      okSnapshot(githubEvidence(project.id, source.id)),
      failedSnapshot('GitHub rejected the credential.'),
    ];

    await services.sync.syncProject(project.id);
    const before = await services.evidence.list({ projectId: project.id });
    expect(before).toHaveLength(2);

    advanceHours(1);
    const outcome = await services.sync.syncProject(project.id);

    expect(outcome.status).toBe('failed');
    expect(outcome.evidenceWritten).toBe(0);
    expect(outcome.message).toBe('GitHub rejected the credential.');

    /* The whole point of the invariant: a failed attempt shows last-known-good, it never erases. */
    const after = await services.evidence.list({ projectId: project.id });
    const shape = (rows: readonly Evidence[]) =>
      rows
        .map((row) => ({
          id: row.id,
          externalId: row.externalId,
          title: row.title,
          observedAt: row.observedAt,
          fetchedAt: row.fetchedAt,
        }))
        .sort((a, b) => a.externalId.localeCompare(b.externalId));
    expect(shape(after)).toEqual(shape(before));

    const failedSource = await services.sources.findById(source.id);
    expect(failedSource?.syncStatus).toBe('failed');
    expect(failedSource?.lastSyncError).toBe('GitHub rejected the credential.');
    expect(failedSource?.lastSyncFailedAt).toBe(new Date(NOW.getTime() + 3_600_000).toISOString());
    /* The last success is retained so the UI can say how old the good data is. */
    expect(failedSource?.lastSyncOkAt).toBe(NOW.toISOString());

    const runs = await services.sync.history(project.id);
    expect(runs.map((run) => run.status)).toEqual(['failed', 'ok']);
    expect(runs[0]?.errorCode).toBe('unauthorized');
    expect(runs[0]?.errorMessage).toBe('GitHub rejected the credential.');
    expect(runs[0]?.evidenceWritten).toBe(0);

    const activity = await services.activity.listByProject(project.id);
    const failure = activity.find((entry) => entry.kind === 'sync_failed');
    expect(failure?.summary).toBe('Could not synchronise test-owner/aurora.');
    expect(failure?.detail.code).toBe('unauthorized');

    const briefing = await services.briefings.briefProject(project.id);
    expect(briefing.assessment.freshness.state).toBe('failing');
    expect(briefing.assessment.freshness.lastError).toBe('GitHub rejected the credential.');
    expect(briefing.assessment.freshness.observedAt).toBe(NOW.toISOString());
    expect(briefing.assessment.freshness.ageHours).toBeCloseTo(1, 5);
    expect(briefing.assessment.freshness.explanation).toContain(
      'last data that synchronised successfully',
    );

    const refreshed = await services.projects.findById(project.id);
    expect(refreshed?.freshness).toBe('failing');
  });

  it('skips a project with no GitHub source without recording a run', async () => {
    const { services, provider } = harness;
    const project = await services.projects.create(
      projectInputSchema.parse({ name: 'Thesis chapter 3', type: 'school' }),
    );
    await services.sources.addExternalLinkSource(
      project.id,
      'https://example.com/thesis',
      'Drive folder',
    );
    provider.snapshots = [okSnapshot([])];

    const outcome = await services.sync.syncProject(project.id);

    expect(outcome.skipped).toBe('no_source');
    expect(outcome.status).toBe('never');
    expect(outcome.evidenceWritten).toBe(0);
    expect(outcome.runId).toBeNull();
    expect(outcome.message).toBe('This project has no synchronisable source.');
    expect(provider.calls).toBe(0);
    expect(await services.sync.history(project.id)).toHaveLength(0);
    expect(await services.activity.listByProject(project.id)).toHaveLength(0);
  });

  it('reports an unconfigured provider as skipped instead of throwing', async () => {
    const { services, provider } = harness;
    const { project, source } = await seedProject();
    provider.configured = false;

    const outcome = await services.sync.syncProject(project.id);

    expect(outcome.skipped).toBe('not_configured');
    expect(outcome.status).toBe('failed');
    expect(outcome.runId).toBeNull();
    expect(outcome.message).toBe(
      'No GitHub token is configured, so this project cannot be synchronised.',
    );
    expect(provider.calls).toBe(0);
    expect(await services.sync.history(project.id)).toHaveLength(0);
    /* A missing credential is our problem, not the repository's: the source stays unjudged. */
    const untouched = await services.sources.findById(source.id);
    expect(untouched?.syncStatus).toBe('never');
    expect(untouched?.lastSyncError).toBeNull();
  });

  it('refuses to run while another holder owns the lock, then proceeds once it is released', async () => {
    const { services, provider } = harness;
    const { project, source } = await seedProject();
    provider.snapshots = [okSnapshot(githubEvidence(project.id, source.id))];

    expect(await services.locks.acquire(project.id, 'other-invocation', 300)).toBe(true);

    const blocked = await services.sync.syncProject(project.id);
    expect(blocked.skipped).toBe('locked');
    expect(blocked.status).toBe('running');
    expect(blocked.evidenceWritten).toBe(0);
    expect(blocked.runId).toBeNull();
    expect(blocked.message).toBe('A synchronisation for this project is already running.');
    expect(provider.calls).toBe(0);
    expect(await services.sync.history(project.id)).toHaveLength(0);

    await services.locks.release(project.id, 'other-invocation');

    const allowed = await services.sync.syncProject(project.id);
    expect(allowed.skipped).toBeUndefined();
    expect(allowed.status).toBe('ok');
    expect(allowed.evidenceWritten).toBe(2);
    expect(provider.calls).toBe(1);
    /* The lock is released in a `finally`, so a completed sync never wedges the project. */
    expect(await services.locks.isLocked(project.id)).toBe(false);
  });

  it('steals an expired lock so a killed invocation cannot wedge a project', async () => {
    const { services, provider } = harness;
    const { project, source } = await seedProject();
    provider.snapshots = [okSnapshot(githubEvidence(project.id, source.id))];

    /* A negative TTL is a lock whose holder died before it could be released. */
    expect(await services.locks.acquire(project.id, 'dead-invocation', -60)).toBe(true);
    expect(await services.locks.isLocked(project.id)).toBe(false);

    const outcome = await services.sync.syncProject(project.id);

    expect(outcome.skipped).toBeUndefined();
    expect(outcome.status).toBe('ok');
    expect(outcome.evidenceWritten).toBe(2);
    expect(await services.evidence.list({ projectId: project.id })).toHaveLength(2);
    expect(await services.locks.isLocked(project.id)).toBe(false);
  });

  it('isolates failures in syncAll so one broken repository never blocks the next', async () => {
    const { services, provider } = harness;
    const alpha = await seedProject({ name: 'Alpha', repo: 'alpha' });
    const beta = await seedProject({ name: 'Beta', repo: 'beta' });

    /*
     * Keyed by repository rather than queued positionally, so which project fails is stated by
     * the test rather than decided by the order `syncAll` happens to visit sources in.
     */
    provider.snapshotsByRepo.set(
      'test-owner/alpha',
      failedSnapshot('GitHub rejected the credential.'),
    );
    provider.snapshotsByRepo.set(
      'test-owner/beta',
      okSnapshot(githubEvidence(beta.project.id, beta.source.id)),
    );

    const outcomes = await services.sync.syncAll('scheduled');

    expect(provider.calls).toBe(2);
    expect([...provider.requested].sort()).toEqual(['test-owner/alpha', 'test-owner/beta']);
    expect(outcomes).toHaveLength(2);
    expect([...outcomes].map((outcome) => outcome.projectId).sort()).toEqual(
      [alpha.project.id, beta.project.id].sort(),
    );

    const byName = new Map(outcomes.map((outcome) => [outcome.projectName, outcome]));
    expect(byName.get('Alpha')?.status).toBe('failed');
    expect(byName.get('Alpha')?.evidenceWritten).toBe(0);
    expect(byName.get('Alpha')?.message).toBe('GitHub rejected the credential.');
    expect(byName.get('Beta')?.status).toBe('ok');
    expect(byName.get('Beta')?.evidenceWritten).toBe(2);

    expect(await services.evidence.list({ projectId: alpha.project.id })).toHaveLength(0);
    expect(await services.evidence.list({ projectId: beta.project.id })).toHaveLength(2);

    const alphaRuns = await services.sync.history(alpha.project.id);
    const betaRuns = await services.sync.history(beta.project.id);
    expect(alphaRuns.map((run) => run.status)).toEqual(['failed']);
    expect(betaRuns.map((run) => run.status)).toEqual(['ok']);
    expect(betaRuns[0]?.trigger).toBe('scheduled');

    expect((await services.sources.findById(alpha.source.id))?.syncStatus).toBe('failed');
    expect((await services.sources.findById(beta.source.id))?.syncStatus).toBe('ok');
  });

  it('refuses to synchronise a project that does not exist', async () => {
    const { services, provider } = harness;

    await expect(
      services.sync.syncProject('00000000-0000-4000-8000-000000000000'),
    ).rejects.toMatchObject({ code: 'not_found' });

    /* The lookup fails before any provider work, so nothing was fetched and nothing recorded. */
    expect(provider.calls).toBe(0);
    expect(await services.runs.listRecent(10)).toHaveLength(0);
  });

  it('returns synchronisation history newest first', async () => {
    const { services, provider } = harness;
    const { project, source } = await seedProject();
    provider.snapshots = [
      okSnapshot(githubEvidence(project.id, source.id)),
      failedSnapshot('Repository not found.'),
      partialSnapshot(githubEvidence(project.id, source.id)),
    ];

    await services.sync.syncProject(project.id, 'import');
    advanceHours(1);
    await services.sync.syncProject(project.id, 'scheduled');
    advanceHours(1);
    await services.sync.syncProject(project.id, 'manual');

    const history = await services.sync.history(project.id);
    expect(history.map((run) => run.status)).toEqual(['partial', 'failed', 'ok']);
    expect(history.map((run) => run.trigger)).toEqual(['manual', 'scheduled', 'import']);
    const startedAt = history.map((run) => Date.parse(run.startedAt));
    expect(startedAt).toEqual([...startedAt].sort((a, b) => b - a));
    expect(new Set(startedAt).size).toBe(3);
    expect(history.every((run) => run.finishedAt !== null)).toBe(true);

    const limited = await services.sync.history(project.id, 2);
    expect(limited.map((run) => run.status)).toEqual(['partial', 'failed']);
  });
});
