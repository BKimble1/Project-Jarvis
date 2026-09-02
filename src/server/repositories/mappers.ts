import type {
  Blocker,
  Decision,
  ExternalLink,
  Goal,
  ManualUpdate,
  Milestone,
  NextAction,
  Project,
  ProjectSource,
} from '@/domain/project';
import type { Evidence, EvidenceMetadata } from '@/domain/evidence';
import type { SyncRunRecord } from '@/domain/integrations';
import type { StatusSnapshot } from '@/domain/status';
import type {
  activityLog,
  blockers,
  decisions,
  evidence,
  goals,
  manualUpdates,
  milestones,
  nextActions,
  projects,
  projectSources,
  statusSnapshots,
  syncRuns,
} from '@/server/db/schema';

type Row<T extends { $inferSelect: unknown }> = T['$inferSelect'];

/** All instants leave the database as UTC ISO-8601 strings; formatting happens in the browser. */
export const iso = (value: Date | null | undefined): string | null =>
  value ? new Date(value).toISOString() : null;

export const isoRequired = (value: Date): string => new Date(value).toISOString();

export function toProject(row: Row<typeof projects>): Project {
  return {
    id: row.id,
    name: row.name,
    shortName: row.shortName,
    description: row.description,
    type: row.type,
    status: row.status,
    phase: row.phase,
    goal: row.goal,
    priority: row.priority,
    targetDate: row.targetDate,
    icon: row.icon,
    color: row.color,
    tags: row.tags ?? [],
    links: (row.links ?? []) as ExternalLink[],
    createdAt: isoRequired(row.createdAt),
    updatedAt: isoRequired(row.updatedAt),
    lastManualUpdateAt: iso(row.lastManualUpdateAt),
    lastSyncedAt: iso(row.lastSyncedAt),
    archivedAt: iso(row.archivedAt),
    freshness: row.freshness,
    needsAttention: row.needsAttention,
  };
}

export function toProjectSource(row: Row<typeof projectSources>): ProjectSource {
  return {
    id: row.id,
    projectId: row.projectId,
    kind: row.kind,
    isPrimary: row.isPrimary,
    label: row.label,
    github:
      row.kind === 'github_repo' && row.githubOwner && row.githubRepo
        ? {
            repoId: row.githubRepoId,
            owner: row.githubOwner,
            repo: row.githubRepo,
            url: row.githubUrl,
            visibility: row.githubVisibility,
            defaultBranch: row.githubDefaultBranch,
            archived: row.githubArchived,
            primaryLanguage: row.githubPrimaryLanguage,
            lastActivityAt: iso(row.githubLastActivityAt),
          }
        : null,
    externalUrl: row.externalUrl,
    syncStatus: row.syncStatus,
    lastSyncOkAt: iso(row.lastSyncOkAt),
    lastSyncFailedAt: iso(row.lastSyncFailedAt),
    lastSyncError: row.lastSyncError,
    availableCapabilities: row.availableCapabilities ?? [],
    unavailableCapabilities: row.unavailableCapabilities ?? [],
    createdAt: isoRequired(row.createdAt),
    updatedAt: isoRequired(row.updatedAt),
  };
}

export function toGoal(row: Row<typeof goals>): Goal {
  return {
    id: row.id,
    projectId: row.projectId,
    statement: row.statement,
    successDefinition: row.successDefinition,
    status: row.status,
    targetDate: row.targetDate,
    provenance: row.provenance,
    sourceSystem: row.sourceSystem,
    createdAt: isoRequired(row.createdAt),
    updatedAt: isoRequired(row.updatedAt),
  };
}

export function toMilestone(row: Row<typeof milestones>): Milestone {
  return {
    id: row.id,
    projectId: row.projectId,
    title: row.title,
    description: row.description,
    state: row.state,
    position: row.position,
    targetDate: row.targetDate,
    completedAt: iso(row.completedAt),
    provenance: row.provenance,
    sourceSystem: row.sourceSystem,
    evidenceIds: row.evidenceIds ?? [],
    createdAt: isoRequired(row.createdAt),
    updatedAt: isoRequired(row.updatedAt),
  };
}

export function toBlocker(row: Row<typeof blockers>): Blocker {
  return {
    id: row.id,
    projectId: row.projectId,
    title: row.title,
    description: row.description,
    severity: row.severity,
    isActive: row.isActive,
    resolutionRequirement: row.resolutionRequirement,
    requiresOwnerDecision: row.requiresOwnerDecision,
    provenance: row.provenance,
    sourceSystem: row.sourceSystem,
    evidenceIds: row.evidenceIds ?? [],
    createdAt: isoRequired(row.createdAt),
    resolvedAt: iso(row.resolvedAt),
  };
}

export function toDecision(row: Row<typeof decisions>): Decision {
  return {
    id: row.id,
    projectId: row.projectId,
    title: row.title,
    decision: row.decision,
    reasoning: row.reasoning,
    decidedOn: row.decidedOn,
    supersedesDecisionId: row.supersedesDecisionId,
    provenance: row.provenance,
    sourceSystem: row.sourceSystem,
    evidenceIds: row.evidenceIds ?? [],
    createdAt: isoRequired(row.createdAt),
    updatedAt: isoRequired(row.updatedAt),
  };
}

export function toManualUpdate(row: Row<typeof manualUpdates>): ManualUpdate {
  return {
    id: row.id,
    projectId: row.projectId,
    whatChanged: row.whatChanged,
    currentWork: row.currentWork,
    problemsOrRisks: row.problemsOrRisks,
    proposedNextAction: row.proposedNextAction,
    occurredOn: row.occurredOn,
    provenance: 'manual',
    sourceSystem: row.sourceSystem,
    createdAt: isoRequired(row.createdAt),
  };
}

export function toNextAction(row: Row<typeof nextActions>): NextAction {
  return {
    id: row.id,
    projectId: row.projectId,
    action: row.action,
    priority: row.priority,
    status: row.status,
    position: row.position,
    dueDate: row.dueDate,
    requiresOwner: row.requiresOwner,
    provenance: row.provenance,
    sourceSystem: row.sourceSystem,
    createdAt: isoRequired(row.createdAt),
    updatedAt: isoRequired(row.updatedAt),
    completedAt: iso(row.completedAt),
  };
}

export function toEvidence(row: Row<typeof evidence>): Evidence {
  return {
    id: row.id,
    projectId: row.projectId,
    sourceId: row.sourceId,
    kind: row.kind,
    sourceSystem: row.sourceSystem,
    externalId: row.externalId,
    title: row.title,
    summary: row.summary,
    url: row.url,
    observedAt: isoRequired(row.observedAt),
    fetchedAt: isoRequired(row.fetchedAt),
    metadata: (row.metadata ?? {}) as EvidenceMetadata,
  };
}

export function toSnapshot(row: Row<typeof statusSnapshots>): StatusSnapshot {
  return {
    id: row.id,
    projectId: row.projectId,
    generatedAt: isoRequired(row.generatedAt),
    status: row.status,
    phase: row.phase,
    headline: row.headline,
    recentlyCompleted: row.recentlyCompleted ?? [],
    currentWork: row.currentWork ?? [],
    blockers: row.blockers ?? [],
    decisionsNeeded: row.decisionsNeeded ?? [],
    recommendedActions: row.recommendedActions ?? [],
    evidenceIds: row.evidenceIds ?? [],
    freshness: row.freshness,
    unknowns: row.unknowns ?? [],
    summaryMethod: row.summaryMethod,
    fingerprint: row.fingerprint,
    narrative: row.narrative ?? null,
  };
}

export type { SyncRunRecord };

export function toSyncRun(row: Row<typeof syncRuns>): SyncRunRecord {
  return {
    id: row.id,
    projectId: row.projectId,
    sourceId: row.sourceId,
    trigger: row.trigger,
    status: row.status,
    startedAt: isoRequired(row.startedAt),
    finishedAt: iso(row.finishedAt),
    evidenceWritten: row.evidenceWritten,
    categoryResults: row.categoryResults ?? {},
    errorCode: row.errorCode,
    errorMessage: row.errorMessage,
    rateLimitRemaining: row.rateLimitRemaining,
    rateLimitLimit: row.rateLimitLimit,
    rateLimitResetAt: iso(row.rateLimitResetAt),
  };
}

export interface ActivityRecord {
  readonly id: string;
  readonly projectId: string | null;
  readonly kind: Row<typeof activityLog>['kind'];
  readonly summary: string;
  readonly detail: Record<string, unknown>;
  readonly createdAt: string;
}

export function toActivity(row: Row<typeof activityLog>): ActivityRecord {
  return {
    id: row.id,
    projectId: row.projectId,
    kind: row.kind,
    summary: row.summary,
    detail: row.detail ?? {},
    createdAt: isoRequired(row.createdAt),
  };
}
