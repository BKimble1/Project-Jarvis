import type { Evidence, EvidenceInput } from '@/domain/evidence';
import type {
  Blocker,
  Goal,
  ManualUpdate,
  Milestone,
  NextAction,
  Project,
  ProjectAggregate,
  ProjectSource,
} from '@/domain/project';

/**
 * Pure in-memory fixtures for unit tests.
 *
 * Every builder returns a complete, valid object with sensible defaults, so a test only states
 * the field it is actually exercising.
 */

export const NOW = new Date('2025-06-15T12:00:00.000Z');

export const daysBefore = (days: number, from: Date = NOW): string =>
  new Date(from.getTime() - days * 86_400_000).toISOString();

export const hoursBefore = (hours: number, from: Date = NOW): string =>
  new Date(from.getTime() - hours * 3_600_000).toISOString();

let counter = 0;
const nextId = (prefix: string) => `${prefix}-${(counter += 1)}`;

export function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: overrides.id ?? nextId('project'),
    name: 'Aurora',
    shortName: null,
    description: null,
    type: 'software',
    status: 'active',
    phase: 'Build',
    goal: 'Ship the first usable version.',
    priority: 'medium',
    targetDate: null,
    icon: null,
    color: null,
    tags: [],
    links: [],
    createdAt: daysBefore(30),
    updatedAt: hoursBefore(2),
    lastManualUpdateAt: hoursBefore(2),
    lastSyncedAt: hoursBefore(1),
    archivedAt: null,
    freshness: 'live',
    needsAttention: false,
    ...overrides,
  };
}

export function makeSource(overrides: Partial<ProjectSource> = {}): ProjectSource {
  return {
    id: overrides.id ?? nextId('source'),
    projectId: overrides.projectId ?? 'project-1',
    kind: 'github_repo',
    isPrimary: true,
    label: 'owner/aurora',
    github: {
      repoId: 1,
      owner: 'owner',
      repo: 'aurora',
      url: 'https://github.com/owner/aurora',
      visibility: 'private',
      defaultBranch: 'main',
      archived: false,
      primaryLanguage: 'TypeScript',
      lastActivityAt: hoursBefore(4),
    },
    externalUrl: null,
    syncStatus: 'ok',
    lastSyncOkAt: hoursBefore(1),
    lastSyncFailedAt: null,
    lastSyncError: null,
    availableCapabilities: ['metadata', 'commits', 'pull_requests'],
    unavailableCapabilities: [],
    createdAt: daysBefore(30),
    updatedAt: hoursBefore(1),
    ...overrides,
  };
}

export function makeEvidence(overrides: Partial<Evidence> = {}): Evidence {
  return {
    id: overrides.id ?? nextId('evidence'),
    projectId: overrides.projectId ?? 'project-1',
    sourceId: null,
    kind: 'git_commit',
    sourceSystem: 'github',
    externalId: nextId('external'),
    title: 'A commit',
    summary: null,
    url: 'https://github.com/owner/aurora/commit/abc',
    observedAt: hoursBefore(6),
    fetchedAt: hoursBefore(1),
    metadata: {},
    ...overrides,
  };
}

export function makeMergedPr(overrides: Partial<Evidence> = {}): Evidence {
  return makeEvidence({
    kind: 'pull_request',
    title: '#7 Evidence timeline',
    observedAt: daysBefore(2),
    metadata: { number: 7, state: 'merged', merged: true, mergedAt: daysBefore(2) },
    ...overrides,
  });
}

export function makeOpenPr(overrides: Partial<Evidence> = {}): Evidence {
  return makeEvidence({
    kind: 'pull_request',
    title: '#12 Status engine',
    observedAt: daysBefore(1),
    metadata: { number: 12, state: 'open', merged: false, draft: false },
    ...overrides,
  });
}

export function makeWorkflowRun(
  conclusion: string | null,
  overrides: Partial<Evidence> = {},
): Evidence {
  return makeEvidence({
    kind: 'workflow_run',
    title: `CI — ${conclusion ?? 'running'}`,
    observedAt: daysBefore(1),
    metadata: {
      runId: 1,
      workflowName: 'CI',
      status: conclusion ? 'completed' : 'in_progress',
      conclusion,
      isDefaultBranch: true,
    },
    ...overrides,
  });
}

export function makeBlocker(overrides: Partial<Blocker> = {}): Blocker {
  return {
    id: overrides.id ?? nextId('blocker'),
    projectId: overrides.projectId ?? 'project-1',
    title: 'Waiting on a provider decision',
    description: null,
    severity: 'high',
    isActive: true,
    resolutionRequirement: null,
    requiresOwnerDecision: false,
    provenance: 'manual',
    sourceSystem: 'manual',
    evidenceIds: [],
    createdAt: daysBefore(3),
    resolvedAt: null,
    ...overrides,
  };
}

export function makeMilestone(overrides: Partial<Milestone> = {}): Milestone {
  return {
    id: overrides.id ?? nextId('milestone'),
    projectId: overrides.projectId ?? 'project-1',
    title: 'First release',
    description: null,
    state: 'planned',
    position: 0,
    targetDate: null,
    completedAt: null,
    provenance: 'manual',
    sourceSystem: 'manual',
    evidenceIds: [],
    createdAt: daysBefore(10),
    updatedAt: daysBefore(10),
    ...overrides,
  };
}

export function makeNextAction(overrides: Partial<NextAction> = {}): NextAction {
  return {
    id: overrides.id ?? nextId('action'),
    projectId: overrides.projectId ?? 'project-1',
    action: 'Write the migration',
    priority: 'medium',
    status: 'open',
    position: 0,
    dueDate: null,
    requiresOwner: false,
    provenance: 'manual',
    sourceSystem: 'manual',
    createdAt: daysBefore(3),
    updatedAt: daysBefore(3),
    completedAt: null,
    ...overrides,
  };
}

export function makeGoal(overrides: Partial<Goal> = {}): Goal {
  return {
    id: overrides.id ?? nextId('goal'),
    projectId: overrides.projectId ?? 'project-1',
    statement: 'Ship it',
    successDefinition: null,
    status: 'open',
    targetDate: null,
    provenance: 'manual',
    sourceSystem: 'manual',
    createdAt: daysBefore(20),
    updatedAt: daysBefore(20),
    ...overrides,
  };
}

export function makeUpdate(overrides: Partial<ManualUpdate> = {}): ManualUpdate {
  return {
    id: overrides.id ?? nextId('update'),
    projectId: overrides.projectId ?? 'project-1',
    whatChanged: 'Rewrote the onboarding copy.',
    currentWork: null,
    problemsOrRisks: null,
    proposedNextAction: null,
    occurredOn: null,
    provenance: 'manual',
    sourceSystem: 'manual',
    createdAt: daysBefore(1),
    ...overrides,
  };
}

export function makeAggregate(overrides: Partial<ProjectAggregate> = {}): ProjectAggregate {
  const project = overrides.project ?? makeProject();
  const scoped = <T extends { projectId: string }>(items: readonly T[] | undefined) =>
    (items ?? []).map((item) => ({ ...item, projectId: project.id }));

  return {
    project,
    sources: (overrides.sources ?? []).map((source) => ({ ...source, projectId: project.id })),
    goals: scoped(overrides.goals),
    milestones: scoped(overrides.milestones),
    blockers: scoped(overrides.blockers),
    decisions: scoped(overrides.decisions),
    updates: scoped(overrides.updates),
    nextActions: scoped(overrides.nextActions),
  };
}

export function evidenceInput(
  overrides: Partial<EvidenceInput> & { projectId: string },
): EvidenceInput {
  return {
    kind: 'git_commit',
    sourceSystem: 'github',
    externalId: nextId('ext'),
    title: 'A commit',
    observedAt: hoursBefore(3),
    metadata: {},
    ...overrides,
  };
}
