import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ForbiddenError } from '@/domain/errors';
import type { AnswerItem, QueryAnswer } from '@/domain/query';
import {
  blockerInputSchema,
  decisionInputSchema,
  goalInputSchema,
  manualUpdateInputSchema,
  milestoneInputSchema,
  nextActionInputSchema,
  projectInputSchema,
  type Project,
  type ProjectAggregate,
} from '@/domain/project';
import { assertCronAuthorised } from '@/server/auth/guard';
import { resetConfigCache } from '@/server/config/env';
import { projects as projectsTable, projectSources } from '@/server/db/schema';
import { evidenceInput } from '../helpers/factories';
import { createHarness, type TestHarness } from '../helpers/services';

/**
 * The repository layer, the query router and the security guarantees, exercised through the same
 * service graph the application builds — a migrated PostgreSQL schema with only the network
 * replaced.
 */

/** Far enough in the past that any genuine touch of `lastManualUpdateAt` is unambiguous. */
const OLD_TOUCH = new Date('2024-01-01T00:00:00.000Z');

const createProject = (harness: TestHarness, input: unknown): Promise<Project> =>
  harness.services.projects.create(projectInputSchema.parse(input));

async function aggregateOf(harness: TestHarness, projectId: string): Promise<ProjectAggregate> {
  const aggregate = await harness.services.projects.aggregate(projectId);
  if (!aggregate) throw new Error(`No aggregate for project ${projectId}.`);
  return aggregate;
}

async function stampOldManualUpdate(harness: TestHarness, projectId: string): Promise<void> {
  await harness.services.db
    .update(projectsTable)
    .set({ lastManualUpdateAt: OLD_TOUCH, updatedAt: OLD_TOUCH })
    .where(eq(projectsTable.id, projectId));
}

async function manualUpdateAt(harness: TestHarness, projectId: string): Promise<number> {
  const project = await harness.services.projects.findById(projectId);
  if (!project?.lastManualUpdateAt) throw new Error('The project has no lastManualUpdateAt.');
  return new Date(project.lastManualUpdateAt).getTime();
}

interface EntityCase {
  readonly name: string;
  readonly add: (projectId: string) => Promise<string>;
  /** `null` for manual updates, which are append-only by design. */
  readonly edit: {
    readonly apply: (id: string) => Promise<string>;
    readonly expect: string;
  } | null;
  readonly remove: (id: string) => Promise<void>;
  readonly count: (aggregate: ProjectAggregate) => number;
}

function entityCases(harness: TestHarness): readonly EntityCase[] {
  const repo = harness.services.projects;
  return [
    {
      name: 'goal',
      add: async (projectId) =>
        (
          await repo.addGoal(
            projectId,
            goalInputSchema.parse({ statement: 'Ship the first usable version.' }),
          )
        ).id,
      edit: {
        apply: async (id) => (await repo.updateGoal(id, { status: 'achieved' })).status,
        expect: 'achieved',
      },
      remove: (id) => repo.removeGoal(id),
      count: (aggregate) => aggregate.goals.length,
    },
    {
      name: 'milestone',
      add: async (projectId) =>
        (await repo.addMilestone(projectId, milestoneInputSchema.parse({ title: 'First release' })))
          .id,
      edit: {
        apply: async (id) => (await repo.updateMilestone(id, { state: 'in_progress' })).state,
        expect: 'in_progress',
      },
      remove: (id) => repo.removeMilestone(id),
      count: (aggregate) => aggregate.milestones.length,
    },
    {
      name: 'blocker',
      add: async (projectId) =>
        (
          await repo.addBlocker(
            projectId,
            blockerInputSchema.parse({ title: 'Waiting on a provider decision', severity: 'high' }),
          )
        ).id,
      edit: {
        apply: async (id) => (await repo.updateBlocker(id, { severity: 'critical' })).severity,
        expect: 'critical',
      },
      remove: (id) => repo.removeBlocker(id),
      count: (aggregate) => aggregate.blockers.length,
    },
    {
      name: 'decision',
      add: async (projectId) =>
        (
          await repo.addDecision(
            projectId,
            decisionInputSchema.parse({ title: 'Hosting', decision: 'Use the managed host.' }),
          )
        ).id,
      edit: {
        apply: async (id) =>
          (await repo.updateDecision(id, { decision: 'Use the self-hosted runner.' })).decision,
        expect: 'Use the self-hosted runner.',
      },
      remove: (id) => repo.removeDecision(id),
      count: (aggregate) => aggregate.decisions.length,
    },
    {
      name: 'update',
      add: async (projectId) =>
        (
          await repo.addUpdate(
            projectId,
            manualUpdateInputSchema.parse({ whatChanged: 'Rewrote the onboarding copy.' }),
          )
        ).id,
      edit: null,
      remove: (id) => repo.removeUpdate(id),
      count: (aggregate) => aggregate.updates.length,
    },
    {
      name: 'next action',
      add: async (projectId) =>
        (
          await repo.addNextAction(
            projectId,
            nextActionInputSchema.parse({ action: 'Write the migration' }),
          )
        ).id,
      edit: {
        apply: async (id) => (await repo.updateNextAction(id, { priority: 'high' })).priority,
        expect: 'high',
      },
      remove: (id) => repo.removeNextAction(id),
      count: (aggregate) => aggregate.nextActions.length,
    },
  ];
}

/** The PostgreSQL failure behind a rejected write, so a test can name the constraint that fired. */
interface PostgresFailure {
  readonly code: string;
  readonly constraint: string;
  readonly detail: string;
}

function postgresFailure(error: unknown): PostgresFailure {
  const cause = error instanceof Error ? error.cause : null;
  if (cause === null || typeof cause !== 'object') {
    throw new Error('The rejection carried no database cause.');
  }
  const record = cause as Record<string, unknown>;
  return {
    code: String(record.code),
    constraint: String(record.constraint),
    detail: String(record.detail),
  };
}

function sectionItems(answer: QueryAnswer, label: string): readonly AnswerItem[] {
  const section = answer.sections.find((entry) => entry.label === label);
  if (!section) throw new Error(`The answer has no "${label}" section.`);
  return section.items;
}

const names = (page: { readonly items: readonly Project[] }): string[] =>
  page.items.map((project) => project.name);

describe('project sub-entities', () => {
  let harness: TestHarness;
  let project: Project;

  beforeEach(async () => {
    harness = await createHarness();
    project = await createProject(harness, {
      name: 'Aurora',
      type: 'software',
      goal: 'Ship the evidence timeline.',
    });
  });

  afterEach(async () => {
    await harness.close();
  });

  it('marks the project as manually updated when a sub-entity is added or edited', async () => {
    for (const entity of entityCases(harness)) {
      await stampOldManualUpdate(harness, project.id);
      const id = await entity.add(project.id);
      expect(await manualUpdateAt(harness, project.id), `${entity.name} add`).toBeGreaterThan(
        OLD_TOUCH.getTime(),
      );
      expect(entity.count(await aggregateOf(harness, project.id)), `${entity.name} count`).toBe(1);

      if (entity.edit) {
        await stampOldManualUpdate(harness, project.id);
        expect(await entity.edit.apply(id), `${entity.name} edit`).toBe(entity.edit.expect);
        expect(await manualUpdateAt(harness, project.id), `${entity.name} edit`).toBeGreaterThan(
          OLD_TOUCH.getTime(),
        );
      }

      await entity.remove(id);
    }
  });

  /**
   * Deleting a sub-entity is just as much an owner action as adding one, and
   * `lastManualUpdateAt` feeds the freshness assessment — so clearing the last blocker on a
   * project with no source must not leave it looking staler than it is.
   */
  it('records a manual change when a sub-entity is removed', async () => {
    for (const entity of entityCases(harness)) {
      const id = await entity.add(project.id);
      await stampOldManualUpdate(harness, project.id);

      await entity.remove(id);

      expect(entity.count(await aggregateOf(harness, project.id)), `${entity.name} count`).toBe(0);
      expect(await manualUpdateAt(harness, project.id), `${entity.name} remove`).toBeGreaterThan(
        OLD_TOUCH.getTime(),
      );
    }
  });

  it('resolves and reopens a blocker', async () => {
    const repo = harness.services.projects;
    const blocker = await repo.addBlocker(
      project.id,
      blockerInputSchema.parse({
        title: 'Decide on the hosting provider',
        severity: 'high',
        requiresOwnerDecision: true,
      }),
    );
    expect(blocker.isActive).toBe(true);
    expect(blocker.resolvedAt).toBeNull();

    const at = new Date('2025-06-20T10:30:00.000Z');
    const resolved = await repo.resolveBlocker(blocker.id, at);
    expect(resolved.isActive).toBe(false);
    expect(resolved.resolvedAt).toBe(at.toISOString());
    expect((await aggregateOf(harness, project.id)).blockers[0]?.isActive).toBe(false);

    const reopened = await repo.reopenBlocker(blocker.id);
    expect(reopened.isActive).toBe(true);
    expect(reopened.resolvedAt).toBeNull();
    expect((await aggregateOf(harness, project.id)).blockers[0]?.resolvedAt).toBeNull();
  });

  it('stamps completedAt when a next action is done and clears it when reopened', async () => {
    const repo = harness.services.projects;
    const action = await repo.addNextAction(
      project.id,
      nextActionInputSchema.parse({ action: 'Write the migration', priority: 'high' }),
    );
    expect(action.status).toBe('open');
    expect(action.completedAt).toBeNull();

    const done = await repo.updateNextAction(action.id, { status: 'done' });
    expect(done.status).toBe('done');
    expect(done.completedAt).not.toBeNull();

    const reopened = await repo.updateNextAction(action.id, { status: 'open' });
    expect(reopened.status).toBe('open');
    expect(reopened.completedAt).toBeNull();
    expect((await aggregateOf(harness, project.id)).nextActions[0]?.completedAt).toBeNull();
  });

  it('persists the decision that a later decision supersedes', async () => {
    const repo = harness.services.projects;
    const original = await repo.addDecision(
      project.id,
      decisionInputSchema.parse({
        title: 'Hosting provider',
        decision: 'Use the managed host.',
        decidedOn: '2025-06-01',
      }),
    );
    expect(original.supersedesDecisionId).toBeNull();

    const replacement = await repo.addDecision(
      project.id,
      decisionInputSchema.parse({
        title: 'Hosting provider (revised)',
        decision: 'Move to the self-hosted runner.',
        supersedesDecisionId: original.id,
      }),
    );
    expect(replacement.supersedesDecisionId).toBe(original.id);

    const stored = (await aggregateOf(harness, project.id)).decisions.find(
      (decision) => decision.id === replacement.id,
    );
    expect(stored?.supersedesDecisionId).toBe(original.id);
    expect(stored?.provenance).toBe('manual');
    expect(stored?.sourceSystem).toBe('manual');
  });
});

describe('project list', () => {
  let harness: TestHarness;
  let aurora: Project;
  let beacon: Project;
  let cobalt: Project;

  beforeEach(async () => {
    harness = await createHarness();
    aurora = await createProject(harness, {
      name: 'Aurora',
      shortName: 'AUR',
      type: 'software',
      priority: 'critical',
      goal: 'Ship the evidence timeline.',
      tags: ['infra', 'ui'],
    });
    beacon = await createProject(harness, {
      name: 'Beacon',
      type: 'website',
      status: 'paused',
      priority: 'low',
      description: 'A marketing site for the studio.',
      goal: 'Launch the new pricing page.',
      tags: ['marketing'],
    });
    cobalt = await createProject(harness, {
      name: 'Cobalt',
      type: 'research',
      priority: 'high',
      goal: 'Survey the storage options.',
      tags: ['infra'],
    });
  });

  afterEach(async () => {
    await harness.close();
  });

  it('searches names, short names, goals and tags', async () => {
    const list = harness.services.projects;

    const byName = await list.list({ search: 'auro' });
    expect(names(byName)).toEqual(['Aurora']);
    expect(byName.total).toBe(1);

    /* Search is case-insensitive, so the short name matches however the owner typed it. */
    const byShortName = await list.list({ search: 'AUR' });
    expect(names(byShortName)).toEqual(['Aurora']);
    expect(byShortName.total).toBe(1);

    const byGoal = await list.list({ search: 'pricing page' });
    expect(names(byGoal)).toEqual(['Beacon']);
    expect(byGoal.total).toBe(1);

    const byTag = await list.list({ search: 'infra', sort: 'name' });
    expect(names(byTag)).toEqual(['Aurora', 'Cobalt']);
    expect(byTag.total).toBe(2);

    const noMatch = await list.list({ search: 'nothing matches this' });
    expect(noMatch.items).toHaveLength(0);
    expect(noMatch.total).toBe(0);
  });

  it('filters by status, type, priority and tag', async () => {
    const list = harness.services.projects;

    const paused = await list.list({ statuses: ['paused'] });
    expect(names(paused)).toEqual(['Beacon']);
    expect(paused.total).toBe(1);

    const byType = await list.list({ types: ['website', 'research'], sort: 'name' });
    expect(names(byType)).toEqual(['Beacon', 'Cobalt']);
    expect(byType.total).toBe(2);

    const urgent = await list.list({ priorities: ['critical', 'high'], sort: 'name' });
    expect(names(urgent)).toEqual(['Aurora', 'Cobalt']);
    expect(urgent.total).toBe(2);

    const infra = await list.list({ tags: ['infra'], sort: 'name' });
    expect(names(infra)).toEqual(['Aurora', 'Cobalt']);
    expect(infra.total).toBe(2);

    /* Multiple tags are conjunctive: only a project carrying both survives. */
    const both = await list.list({ tags: ['infra', 'ui'] });
    expect(names(both)).toEqual(['Aurora']);
    expect(both.total).toBe(1);

    expect(await list.allTags()).toEqual(['infra', 'marketing', 'ui']);
  });

  it('excludes archived projects unless they are asked for', async () => {
    const list = harness.services.projects;
    await list.archive(beacon.id);

    const live = await list.list();
    expect(names(live)).not.toContain('Beacon');
    expect(live.total).toBe(2);

    const withArchived = await list.list({ includeArchived: true, sort: 'name' });
    expect(names(withArchived)).toEqual(['Aurora', 'Beacon', 'Cobalt']);
    expect(withArchived.total).toBe(3);

    const onlyArchived = await list.list({ onlyArchived: true });
    expect(names(onlyArchived)).toEqual(['Beacon']);
    expect(onlyArchived.total).toBe(1);
  });

  it('orders by each supported sort mode', async () => {
    const list = harness.services.projects;
    await list.setDerivedState(aurora.id, { freshness: 'failing', needsAttention: false });
    await list.setDerivedState(beacon.id, { freshness: 'stale', needsAttention: false });
    await list.setDerivedState(cobalt.id, { freshness: 'live', needsAttention: true });
    /* Beacon becomes the most recently touched project without changing anything else. */
    await list.update(beacon.id, { phase: 'Launch' });

    const byName = await list.list({ sort: 'name' });
    expect(names(byName)).toEqual(['Aurora', 'Beacon', 'Cobalt']);
    expect(byName.total).toBe(3);

    expect(names(await list.list({ sort: 'created' }))).toEqual(['Cobalt', 'Beacon', 'Aurora']);
    expect(names(await list.list({ sort: 'recent_activity' }))).toEqual([
      'Beacon',
      'Cobalt',
      'Aurora',
    ]);
    /* critical, then high, then low. */
    expect(names(await list.list({ sort: 'priority' }))).toEqual(['Aurora', 'Cobalt', 'Beacon']);
    /* Attention first, then the owner's priority breaks the tie. */
    expect(names(await list.list({ sort: 'attention' }))).toEqual(['Cobalt', 'Aurora', 'Beacon']);
    /* failing, then stale, then live. */
    expect(names(await list.list({ sort: 'staleness' }))).toEqual(['Aurora', 'Beacon', 'Cobalt']);
  });

  it('round-trips archive and restore, and hides archived projects from assessment', async () => {
    const list = harness.services.projects;
    expect(aurora.status).toBe('active');
    expect(aurora.archivedAt).toBeNull();

    const archived = await list.archive(aurora.id);
    expect(archived.status).toBe('archived');
    expect(archived.archivedAt).not.toBeNull();

    const live = await list.listAllForAssessment(false);
    expect(live.map((project) => project.name).sort()).toEqual(['Beacon', 'Cobalt']);
    expect((await list.listAllForAssessment(true)).map((project) => project.name).sort()).toEqual([
      'Aurora',
      'Beacon',
      'Cobalt',
    ]);

    const restored = await list.restore(aurora.id);
    expect(restored.status).toBe('active');
    expect(restored.archivedAt).toBeNull();
    expect((await list.listAllForAssessment(false)).map((project) => project.name).sort()).toEqual([
      'Aurora',
      'Beacon',
      'Cobalt',
    ]);
  });
});

describe('evidence storage', () => {
  let harness: TestHarness;
  let project: Project;
  let other: Project;

  beforeEach(async () => {
    harness = await createHarness();
    project = await createProject(harness, { name: 'Aurora', type: 'software' });
    other = await createProject(harness, { name: 'Beacon', type: 'website' });
  });

  afterEach(async () => {
    await harness.close();
  });

  it('upserts idempotently on (project, system, kind, external id)', async () => {
    const store = harness.services.evidence;
    const [first] = await store.upsertMany([
      evidenceInput({
        projectId: project.id,
        kind: 'git_commit',
        externalId: 'commit-abc123',
        title: 'Add the evidence timeline',
        observedAt: '2025-06-10T09:00:00.000Z',
      }),
    ]);
    const [again] = await store.upsertMany([
      evidenceInput({
        projectId: project.id,
        kind: 'git_commit',
        externalId: 'commit-abc123',
        title: 'Add the evidence timeline (amended)',
        observedAt: '2025-06-11T09:00:00.000Z',
      }),
    ]);

    expect(again?.id).toBe(first?.id);
    expect(again?.title).toBe('Add the evidence timeline (amended)');
    expect(again?.observedAt).toBe('2025-06-11T09:00:00.000Z');
    expect(await store.list({ projectId: project.id })).toHaveLength(1);

    /* The key includes kind and project, so the same external id elsewhere is a distinct fact. */
    await store.upsertMany([
      evidenceInput({
        projectId: project.id,
        kind: 'pull_request',
        externalId: 'commit-abc123',
        title: '#7 Evidence timeline',
        observedAt: '2025-06-11T10:00:00.000Z',
      }),
      evidenceInput({
        projectId: other.id,
        kind: 'git_commit',
        externalId: 'commit-abc123',
        title: 'A commit on another project',
        observedAt: '2025-06-11T11:00:00.000Z',
      }),
    ]);
    expect(await store.list({ projectId: project.id })).toHaveLength(2);
    expect(await store.list({ projectId: other.id })).toHaveLength(1);

    const counts = await store.countByProject([project.id, other.id]);
    expect(counts.get(project.id)).toBe(2);
    expect(counts.get(other.id)).toBe(1);
  });

  it('lists by kind and since, honours limit, and reports the newest observation', async () => {
    const store = harness.services.evidence;
    await store.upsertMany([
      evidenceInput({
        projectId: project.id,
        kind: 'git_commit',
        externalId: 'commit-old',
        title: 'An old commit',
        observedAt: '2025-05-01T09:00:00.000Z',
      }),
      evidenceInput({
        projectId: project.id,
        kind: 'git_commit',
        externalId: 'commit-new',
        title: 'A recent commit',
        observedAt: '2025-06-12T09:00:00.000Z',
      }),
      evidenceInput({
        projectId: project.id,
        kind: 'workflow_run',
        externalId: 'run-1',
        title: 'CI — success',
        observedAt: '2025-06-13T09:00:00.000Z',
      }),
    ]);

    const commits = await store.list({ projectId: project.id, kinds: ['git_commit'] });
    expect(commits.map((item) => item.externalId)).toEqual(['commit-new', 'commit-old']);

    const recent = await store.list({
      projectId: project.id,
      since: new Date('2025-06-01T00:00:00.000Z'),
    });
    expect(recent.map((item) => item.externalId)).toEqual(['run-1', 'commit-new']);

    const limited = await store.list({ projectId: project.id, limit: 1 });
    expect(limited.map((item) => item.externalId)).toEqual(['run-1']);

    expect(await store.latestObservedAt(project.id)).toBe('2025-06-13T09:00:00.000Z');
    expect(await store.latestObservedAt(other.id)).toBeNull();
  });

  it('rejects a second source for the same repository at the database level', async () => {
    const source = await harness.services.sources.addGithubSource(project.id, {
      owner: 'test-owner',
      repo: 'aurora',
    });
    expect(source.github?.owner).toBe('test-owner');

    /* The unique index is on lower(owner)/lower(repo), so a differently cased duplicate that
       slipped past the application layer still cannot reach the table. */
    const duplicate = async (): Promise<void> => {
      await harness.services.db.insert(projectSources).values({
        projectId: other.id,
        kind: 'github_repo',
        isPrimary: true,
        label: 'Test-Owner/Aurora',
        githubOwner: 'Test-Owner',
        githubRepo: 'Aurora',
        syncStatus: 'never',
      });
    };
    const rejection = await duplicate().then(
      () => null,
      (error: unknown) => error,
    );
    expect(rejection).toBeInstanceOf(Error);
    const failure = postgresFailure(rejection);
    expect(failure.code).toBe('23505');
    expect(failure.constraint).toBe('project_sources_github_unique_idx');
    expect(failure.detail).toContain(
      '(lower(github_owner), lower(github_repo))=(test-owner, aurora)',
    );

    /* A different repository on the same project is still allowed. */
    const second = await harness.services.sources.addGithubSource(project.id, {
      owner: 'test-owner',
      repo: 'beacon',
      isPrimary: false,
    });
    expect(second.github?.repo).toBe('beacon');
    expect(await harness.services.sources.listByProject(project.id)).toHaveLength(2);
  });
});

describe('status query router', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await createHarness();
  });

  afterEach(async () => {
    await harness.close();
  });

  const decisionBlocker = (title: string, requirement: string) =>
    blockerInputSchema.parse({
      title,
      severity: 'high',
      requiresOwnerDecision: true,
      resolutionRequirement: requirement,
    });

  it('answers "Where are we?" with counts and a focus order', async () => {
    const aurora = await createProject(harness, {
      name: 'Aurora',
      type: 'software',
      priority: 'critical',
      goal: 'Ship the evidence timeline.',
    });
    await harness.services.projects.addBlocker(
      aurora.id,
      decisionBlocker('Decide on the hosting provider', 'Compare the two hosting quotes.'),
    );
    await createProject(harness, { name: 'Beacon', type: 'website', goal: 'Launch the site.' });
    await createProject(harness, {
      name: 'Cobalt',
      type: 'research',
      priority: 'low',
      goal: 'Survey the storage options.',
    });

    const answer = await harness.services.router.answer('Where are we?');

    expect(answer.intent).toBe('portfolio_status');
    expect(answer.title).toBe('Where we are');
    expect(answer.summary).toBe('2 active projects, 1 needing your attention, 1 blocked.');
    expect(answer.href).toBe('/dashboard');
    expect(answer.disambiguation).toBeNull();
    expect(answer.notice).toBeNull();

    expect(sectionItems(answer, 'Counts').map((item) => item.text)).toEqual([
      '2 active',
      '1 need attention',
      '1 blocked',
      '0 waiting',
      '0 paused',
      '0 with stale data',
    ]);

    const focus = sectionItems(answer, 'Focus order');
    expect(focus[0]?.text).toBe('Aurora — Decision needed: Decide on the hosting provider');
    expect(focus[0]?.projectId).toBe(aurora.id);
    expect(focus[0]?.provenance).toBe('manual');
    expect(focus[0]?.href).toBe(`/projects/${aurora.id}`);
    /* The decision outranks both quiet projects; priority then breaks their tie. */
    expect(focus.map((item) => item.text.split(' — ')[0])).toEqual(['Aurora', 'Beacon', 'Cobalt']);
  });

  it('answers "Where are we on <project>?" with that project\'s briefing sections', async () => {
    const aurora = await createProject(harness, {
      name: 'Aurora',
      type: 'software',
      phase: 'Build',
      goal: 'Ship the evidence timeline.',
    });
    await createProject(harness, { name: 'Beacon', type: 'website', goal: 'Launch the site.' });
    await harness.services.projects.addBlocker(
      aurora.id,
      decisionBlocker('Decide on the hosting provider', 'Compare the two hosting quotes.'),
    );

    const answer = await harness.services.router.answer('Where are we on Aurora?');

    expect(answer.intent).toBe('project_status');
    expect(answer.title).toBe('Aurora');
    expect(answer.summary).toBe('Aurora is blocked by 1 open item.');
    expect(answer.summaryProvenance).toBe('inferred');
    expect(answer.projectIds).toEqual([aurora.id]);
    expect(answer.href).toBe(`/projects/${aurora.id}`);
    expect(answer.disambiguation).toBeNull();

    expect(answer.sections.map((section) => section.label)).toEqual([
      'Recently completed',
      'In progress',
      'Blockers',
      'Decisions needed',
      'Next actions',
      'Unknowns',
    ]);
    expect(sectionItems(answer, 'Recently completed')).toHaveLength(0);
    expect(sectionItems(answer, 'In progress')).toHaveLength(0);
    expect(sectionItems(answer, 'Blockers').map((item) => item.text)).toEqual([
      'Decide on the hosting provider',
    ]);
    expect(sectionItems(answer, 'Blockers')[0]?.provenance).toBe('manual');
    expect(sectionItems(answer, 'Decisions needed').map((item) => item.text)).toEqual([
      'Decide on the hosting provider — Compare the two hosting quotes.',
    ]);
    expect(sectionItems(answer, 'Next actions').map((item) => item.text)).toEqual([
      'Decide: Decide on the hosting provider',
    ]);
    /* Goal and phase are recorded and nothing is being synchronised, so nothing is unknown. */
    expect(sectionItems(answer, 'Unknowns')).toHaveLength(0);
  });

  it('asks which project was meant when a name matches more than one', async () => {
    const web = await createProject(harness, { name: 'Aurora Web', type: 'website' });
    const mobile = await createProject(harness, { name: 'Aurora Mobile', type: 'ios_app' });

    const answer = await harness.services.router.answer('Where are we on Aurora?');

    expect(answer.title).toBe('Which project did you mean?');
    expect(answer.summary).toBe('Several projects match that name.');
    expect(answer.disambiguation?.map((entry) => entry.name).sort()).toEqual([
      'Aurora Mobile',
      'Aurora Web',
    ]);
    expect([...answer.projectIds].sort()).toEqual([web.id, mobile.id].sort());
    expect(answer.href).toBeNull();

    /* No project was briefed, so nothing was asserted about either candidate. */
    expect(answer.sections).toHaveLength(0);
    expect(await harness.services.snapshots.latest(web.id)).toBeNull();
    expect(await harness.services.snapshots.latest(mobile.id)).toBeNull();
  });

  it('groups what needs the owner, and filters to blocked projects on request', async () => {
    const aurora = await createProject(harness, { name: 'Aurora', type: 'software' });
    const beacon = await createProject(harness, { name: 'Beacon', type: 'website' });
    const cobalt = await createProject(harness, {
      name: 'Cobalt',
      type: 'research',
      goal: 'Survey the storage options.',
    });
    await harness.services.projects.addBlocker(
      aurora.id,
      decisionBlocker('Decide on the hosting provider', 'Compare the two hosting quotes.'),
    );
    await harness.services.projects.addBlocker(
      beacon.id,
      blockerInputSchema.parse({ title: 'Waiting on the design review', severity: 'high' }),
    );

    const attention = await harness.services.router.answer('What needs me?');

    expect(attention.intent).toBe('needs_attention');
    expect(attention.title).toBe('What needs you');
    expect(attention.summary).toBe('2 items need you.');
    expect(attention.href).toBe('/attention');
    expect(sectionItems(attention, 'Decisions required').map((item) => item.text)).toEqual([
      'Aurora: Decision needed: Decide on the hosting provider',
    ]);
    expect(sectionItems(attention, 'Active blockers').map((item) => item.text)).toEqual([
      'Beacon: Blocked: Waiting on the design review',
    ]);
    expect(sectionItems(attention, 'Failed builds')).toHaveLength(0);
    expect(sectionItems(attention, 'Failed synchronisations')).toHaveLength(0);
    expect(sectionItems(attention, 'Overdue')).toHaveLength(0);
    expect(sectionItems(attention, 'Stale projects')).toHaveLength(0);
    expect([...attention.projectIds].sort()).toEqual([aurora.id, beacon.id].sort());

    /* The same grouping, straight from the service, carries the rule that produced each item. */
    const groups = await harness.services.attention.collect();
    expect(groups.total).toBe(2);
    expect(groups.decisions[0]?.reason.rule).toBe('R-AT1-blocker-requires-owner-decision');
    expect(groups.decisions[0]?.reason.severity).toBe('critical');
    expect(groups.blockers[0]?.reason.rule).toBe('R-AT2-active-blocker');
    expect(groups.blockers[0]?.projectName).toBe('Beacon');

    const blocked = await harness.services.router.answer('Which projects are blocked?');
    expect(blocked.intent).toBe('blocked_projects');
    expect(blocked.title).toBe('Blocked projects');
    expect(blocked.summary).toBe('2 projects.');
    expect([...blocked.projectIds].sort()).toEqual([aurora.id, beacon.id].sort());
    expect(blocked.projectIds).not.toContain(cobalt.id);
    expect(sectionItems(blocked, 'Blocked projects').map((item) => item.text)).toEqual([
      'Aurora — Aurora is blocked by 1 open item.',
      'Beacon — Beacon is blocked by 1 open item.',
    ]);
  });

  it('refuses to execute work, says so, and changes nothing', async () => {
    await createProject(harness, { name: 'Aurora', type: 'software' });

    const answer = await harness.services.router.answer('Build a new feature');

    expect(answer.intent).toBe('execution_request');
    expect(answer.title).toBe('Jarvis cannot run that yet');
    expect(answer.notice).toBe('Project execution is not part of this phase. Nothing was run.');
    expect(answer.summary).toContain('Prompt 2');
    expect(sectionItems(answer, 'What you can do now').map((item) => item.text)).toEqual([
      'Record it as a next action on a project so it is not lost.',
      'Ask "where are we?" or "what needs me?" for the current picture.',
    ]);

    /* Nothing was created, nothing was synchronised, and no provider call was made. */
    const listed = await harness.services.projects.list();
    expect(listed.total).toBe(1);
    expect(names(listed)).toEqual(['Aurora']);
    expect(await harness.services.activity.listRecent()).toHaveLength(0);
    expect(await harness.services.runs.listRecent()).toHaveLength(0);
    expect(harness.provider.calls).toBe(0);
  });

  it('records every question in history, newest first', async () => {
    const aurora = await createProject(harness, {
      name: 'Aurora',
      type: 'software',
      goal: 'Ship the evidence timeline.',
    });

    await harness.services.router.answer('Where are we?');
    await harness.services.router.answer('Where are we on Aurora?');
    await harness.services.router.answer('Build a new feature');

    const history = await harness.services.queryHistory.recent();
    expect(history.map((entry) => entry.queryText)).toEqual([
      'Build a new feature',
      'Where are we on Aurora?',
      'Where are we?',
    ]);
    expect(history.map((entry) => entry.intent)).toEqual([
      'execution_request',
      'project_status',
      'portfolio_status',
    ]);
    expect(history[1]?.projectId).toBe(aurora.id);
    expect(history[0]?.projectId).toBeNull();
    expect(await harness.services.queryHistory.recent(2)).toHaveLength(2);
  });
});

describe('scheduled-synchronisation credential', () => {
  const CRON_SECRET = 'cron-secret-value-0001';
  const ENV: Readonly<Record<string, string>> = {
    NODE_ENV: 'test',
    JARVIS_BASE_URL: 'http://localhost:3000',
    SESSION_SECRET: 'test-session-secret-value-that-is-long-enough',
    OWNER_GITHUB_LOGIN: 'test-owner',
    OWNER_GITHUB_USER_ID: '4242',
    GITHUB_OAUTH_CLIENT_ID: 'client-id',
    GITHUB_OAUTH_CLIENT_SECRET: 'client-secret',
    JARVIS_DB_DRIVER: 'pglite',
    JARVIS_AI_ENABLED: 'false',
    LOG_LEVEL: 'error',
    CRON_SECRET,
  };

  let saved: Record<string, string | undefined> = {};

  /* `assertCronAuthorised` reads the memoised global config, so the environment it was built
     from has to be controlled here and restored afterwards. */
  beforeEach(() => {
    saved = {};
    for (const [key, value] of Object.entries(ENV)) {
      saved[key] = process.env[key];
      process.env[key] = value;
    }
    resetConfigCache();
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetConfigCache();
  });

  const request = (headers: Record<string, string> = {}): Request =>
    new Request('https://jarvis.test/api/cron/sync', { headers });

  it('rejects a request with no credential', () => {
    expect(() => assertCronAuthorised(request())).toThrow(ForbiddenError);
    expect(() => assertCronAuthorised(request())).toThrow(
      'Invalid scheduled-synchronisation credential.',
    );
  });

  it('rejects a wrong secret', () => {
    expect(() =>
      assertCronAuthorised(request({ 'x-jarvis-cron-secret': 'not-the-cron-secret' })),
    ).toThrow('Invalid scheduled-synchronisation credential.');
    expect(() =>
      assertCronAuthorised(request({ authorization: `Bearer ${CRON_SECRET}x` })),
    ).toThrow(ForbiddenError);
  });

  it('accepts the configured secret in either supported header', () => {
    expect(() =>
      assertCronAuthorised(request({ 'x-jarvis-cron-secret': CRON_SECRET })),
    ).not.toThrow();
    expect(() =>
      assertCronAuthorised(request({ authorization: `Bearer ${CRON_SECRET}` })),
    ).not.toThrow();
  });

  it('closes the endpoint entirely when CRON_SECRET is unset', () => {
    delete process.env.CRON_SECRET;
    resetConfigCache();

    const attempts: readonly Record<string, string>[] = [
      {},
      { 'x-jarvis-cron-secret': CRON_SECRET },
      { authorization: `Bearer ${CRON_SECRET}` },
    ];
    for (const headers of attempts) {
      expect(() => assertCronAuthorised(request(headers))).toThrow(
        'Scheduled synchronisation is disabled because CRON_SECRET is not set.',
      );
    }
  });

  it('treats a too-short CRON_SECRET as no secret at all', () => {
    process.env.CRON_SECRET = 'short';
    resetConfigCache();

    expect(() => assertCronAuthorised(request({ 'x-jarvis-cron-secret': 'short' }))).toThrow(
      'Scheduled synchronisation is disabled because CRON_SECRET is not set.',
    );
  });
});

describe('read-only guarantee', () => {
  const SRC_DIR = path.resolve(import.meta.dirname, '../../src');
  const readSource = (relative: string): string =>
    readFileSync(path.join(SRC_DIR, relative), 'utf8');
  const typescriptFiles = (): readonly string[] =>
    readdirSync(SRC_DIR, { recursive: true, encoding: 'utf8' }).filter((entry) =>
      /\.tsx?$/.test(entry),
    );

  it('runs the read-only guard before any GitHub request leaves the process', () => {
    const client = readSource('server/providers/github/client.ts');
    expect(client).toContain("const READ_METHODS = new Set(['GET', 'HEAD']);");

    const fetchStart = client.indexOf('const instrumentedFetch');
    const octokitStart = client.indexOf('const octokit = new Octokit(');
    expect(fetchStart).toBeGreaterThan(-1);
    expect(octokitStart).toBeGreaterThan(fetchStart);

    const fetchBody = client.slice(fetchStart, octokitStart);
    const guardAt = fetchBody.indexOf('assertReadOnlyRequest(method, url)');
    const networkAt = fetchBody.indexOf('await baseFetch(');
    /* Order is the whole guarantee: a check placed after the call would reject the response
       rather than prevent the write, so the assertion is on the guard preceding the request. */
    expect(guardAt).toBeGreaterThan(-1);
    expect(networkAt).toBeGreaterThan(guardAt);

    /* Octokit is handed the instrumented fetch, so there is no second, unguarded path out. */
    expect(client).toMatch(
      /new Octokit\(\{[\s\S]*?request: \{ fetch: instrumentedFetch \},[\s\S]*?\}\);/,
    );

    const provider = readSource('server/providers/github/provider.ts');
    expect(provider).toContain('createGithubClient({');
    expect(provider).not.toContain('new Octokit(');

    const constructors = typescriptFiles().filter((file) =>
      readSource(file).includes('new Octokit('),
    );
    expect(constructors).toEqual(['server/providers/github/client.ts']);
  });

  it('declares only read operations on the SourceProvider interface', () => {
    const types = readSource('server/providers/types.ts');
    const start = types.indexOf('export interface SourceProvider {');
    expect(start).toBeGreaterThan(-1);
    const body = types.slice(start, types.indexOf('\n}', start));

    /* Two spaces of indentation is a direct member of the interface; nested option-object
       properties are indented further and are deliberately not counted. */
    const members = [...body.matchAll(/^ {2}(?:readonly )?([A-Za-z]\w*)[(?:]/gm)].map(
      (match) => match[1] ?? '',
    );
    expect([...members].sort()).toEqual([
      'checkHealth',
      'describeRepository',
      'fetchSnapshot',
      'isConfigured',
      'kind',
      'listAvailableRepositories',
    ]);

    const writeVerb =
      /^(create|update|delete|remove|push|write|open|close|merge|comment|dispatch|post|put|patch|set)/;
    expect(members.filter((name) => writeVerb.test(name))).toEqual([]);
  });
});

describe('data export', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await createHarness();
  });

  afterEach(async () => {
    await harness.close();
  });

  function collectKeys(value: unknown, into: Set<string>): void {
    if (Array.isArray(value)) {
      for (const entry of value) collectKeys(entry, into);
      return;
    }
    if (value !== null && typeof value === 'object') {
      for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
        into.add(key);
        collectKeys(nested, into);
      }
    }
  }

  it('exports projects and evidence and carries no credential of any kind', async () => {
    const { services } = harness;
    const project = await createProject(harness, {
      name: 'Aurora',
      type: 'software',
      goal: 'Ship the evidence timeline.',
    });
    await services.projects.addBlocker(
      project.id,
      blockerInputSchema.parse({ title: 'Decide on the hosting provider', severity: 'high' }),
    );
    await services.evidence.upsertMany([
      evidenceInput({
        projectId: project.id,
        kind: 'git_commit',
        externalId: 'commit-abc123',
        title: 'Add the evidence timeline',
        observedAt: '2025-06-10T09:00:00.000Z',
      }),
    ]);
    await services.briefings.briefProject(project.id);

    /* Secrets that exist in this instance and must not appear in the export. */
    const { token } = await services.sessions.create({
      githubLogin: 'test-owner',
      githubUserId: '4242',
      displayName: 'Test Owner',
      avatarUrl: null,
      ttlHours: 24,
    });
    const oauthState = await services.oauthStates.issue('/dashboard');
    expect(await services.sessions.find(token)).not.toBeNull();

    const exported = await services.projects.listAllForAssessment(true);
    const aggregates = await services.projects.aggregateMany(exported.map((entry) => entry.id));
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

    const entry = payload.projects[0];
    expect(payload.projects).toHaveLength(1);
    expect(entry?.project.name).toBe('Aurora');
    expect(entry?.blockers.map((blocker) => blocker.title)).toEqual([
      'Decide on the hosting provider',
    ]);
    expect(entry?.evidence.map((item) => item.externalId)).toEqual(['commit-abc123']);
    expect(entry?.snapshots).toHaveLength(1);
    expect(entry?.activity.map((item) => item.kind)).toEqual(['briefing_generated']);

    const serialised = JSON.stringify(payload);
    expect(serialised).toContain('commit-abc123');
    for (const secret of [
      token,
      oauthState,
      harness.config.sessionSecret,
      harness.config.githubReadToken ?? 'read-token',
      harness.config.cronSecret ?? 'cron-secret-value-0001',
    ]) {
      expect(serialised).not.toContain(secret);
    }

    const keys = new Set<string>();
    collectKeys(payload, keys);
    const sensitive = [...keys].filter((key) =>
      /token|secret|session|oauth|password|credential/i.test(key),
    );
    expect(sensitive).toEqual([]);
  });
});
