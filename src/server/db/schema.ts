/**
 * Drizzle schema — PostgreSQL.
 *
 * Design notes
 * ------------
 * - Enumerations are stored as `text` with a TypeScript `$type<>` refinement rather than native
 *   Postgres enums. Every value is validated by Zod at the trust boundary, and `text` keeps
 *   migrations purely additive when later phases introduce new source kinds or evidence kinds.
 * - Every instant is `timestamp with time zone` and written in UTC.
 * - Rows that later phases will hang off (missions, tasks, agent runs, artifacts, approvals,
 *   playbooks, costs) join on `projects.id`; nothing here forecloses that.
 */
import { relations, sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  boolean,
  customType,
  real,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import type {
  ActivityKind,
  BlockerSeverity,
  EvidenceKind,
  FreshnessState,
  GoalStatus,
  MilestoneState,
  NextActionPriority,
  NextActionStatus,
  ProjectPriority,
  ProjectStatus,
  ProjectType,
  ProvenanceLevel,
  SourceCapability,
  SourceKind,
  SourceSystem,
  SummaryMethod,
  SyncStatus,
} from '@/domain/enums';
import type { Claim } from '@/domain/evidence';
import type { ExternalLink } from '@/domain/project';
import type { AttentionReason, FreshnessAssessment, RecommendedAction } from '@/domain/status';
import type {
  MissionFailureCode,
  MissionPriority,
  MissionRiskLevel,
  MissionState,
  MissionType,
} from '@/domain/mission';
import type { MissionPlanContent, PlanAuthor } from '@/domain/mission-plan';
import type {
  ArtifactKind,
  ArtifactSource,
  CommandKind,
  CommandState,
  EventActor,
  EventLevel,
  MissionEventType,
  PermissionRequestKind,
  PermissionRequestState,
  RunKind,
  RunState,
  VerificationOutcome,
} from '@/domain/mission-run';
import type { WorkerStatus } from '@/domain/worker';
import type { AgentRole } from '@/domain/agent-role';
import type {
  TaskFailureCode,
  TaskState,
  TaskType,
  WorkspaceRequirement,
} from '@/domain/mission-task';
import type { TaskGraphState } from '@/domain/task-graph';
import type {
  FindingCategory,
  FindingConfidence,
  FindingSeverity,
  FindingState,
  ReviewVerdict,
} from '@/domain/mission-review';
import type { CompletionReceiptContent } from '@/domain/completion-receipt';
import type { PlaybookDefinition } from '@/domain/playbook';
import type {
  CiDispatchPurpose,
  CiDispatchState,
  ReleaseApprovalState,
} from '@/domain/ci-dispatch';
import type { DisplayScope } from '@/domain/display-device';
import type {
  AppPlatform,
  IconState,
  PrivacySensitiveApi,
  SubscriptionModel,
} from '@/domain/app-profile';
import type {
  CheckOutcome,
  QualificationAssumptions,
  QualificationCheckId,
  QualificationLevel,
} from '@/domain/qualification';
import type {
  ConflictKind,
  ConflictState,
  KnowledgeCategory,
  KnowledgeConfidence,
  KnowledgeExcerpt,
  KnowledgeOrigin,
  KnowledgeScope,
  KnowledgeStatus,
} from '@/domain/knowledge';
import type {
  SourceFailureCode,
  SourceKind as KnowledgeSourceKind,
  SourceState,
} from '@/domain/knowledge-source';
import type {
  AnswerClaim,
  AnswerCoverage,
  AnswerMethod,
  AnswerScope,
  MissionSuggestion,
} from '@/domain/answer';
import type { Cadence, CatchUpPolicy, ExecutionState, ScheduleKind } from '@/domain/schedule';
import type { BriefingContent, BriefingKind, BriefingNarration } from '@/domain/briefing';
import type {
  DeliveryState,
  NotificationCategory,
  NotificationChannel,
  NotificationSeverity,
} from '@/domain/notification';
import type { CaptureFailureCode, CaptureState, TranscriptIntent } from '@/domain/voice';
import type { BudgetKind, BudgetScope, CostBasis, UsageKind } from '@/domain/budget';
import type { ConnectorId, ConnectorState } from '@/domain/connector';
import type { RevisionProvenance, RevisionState } from '@/domain/knowledge-revision';
import type { BlockKind } from '@/domain/knowledge-parser';
import type { EmbeddingState } from '@/domain/embedding';
import type { Sensitivity } from '@/domain/retrieval';

const now = () => timestamp('placeholder', { withTimezone: true });
void now; // documentation helper; each column declares its own name below.

/**
 * A Postgres `tsvector`.
 *
 * Declared here rather than left out of the schema so the ORM and the database agree about the
 * column's existence; the full-text queries themselves are written as SQL, because ranking with
 * `ts_rank_cd` has no expression-builder equivalent worth the indirection.
 */
const tsvector = customType<{ data: string; driverData: string }>({
  dataType() {
    return 'tsvector';
  },
});

/* --------------------------------------------------------------------- auth */

/**
 * Server-side sessions. The cookie carries only an opaque random id; everything else lives here,
 * so a stolen cookie can be revoked by deleting a row and no session data reaches the browser.
 */
export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** SHA-256 of the session token. The raw token is never stored. */
    tokenHash: text('token_hash').notNull(),
    githubLogin: text('github_login'),
    githubUserId: text('github_user_id'),
    displayName: text('display_name'),
    avatarUrl: text('avatar_url'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    userAgentHash: text('user_agent_hash'),
  },
  (table) => [
    uniqueIndex('sessions_token_hash_idx').on(table.tokenHash),
    index('sessions_expires_at_idx').on(table.expiresAt),
  ],
);

/** Short-lived OAuth state + PKCE verifier records. Deleted on use. */
export const oauthStates = pgTable(
  'oauth_states',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    stateHash: text('state_hash').notNull(),
    redirectTo: text('redirect_to'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex('oauth_states_state_hash_idx').on(table.stateHash),
    index('oauth_states_expires_at_idx').on(table.expiresAt),
  ],
);

/* ----------------------------------------------------------------- projects */

export const projects = pgTable(
  'projects',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    shortName: text('short_name'),
    description: text('description'),
    type: text('type').$type<ProjectType>().notNull(),
    status: text('status').$type<ProjectStatus>().notNull().default('active'),
    phase: text('phase'),
    goal: text('goal'),
    priority: text('priority').$type<ProjectPriority>().notNull().default('medium'),
    targetDate: text('target_date'),
    icon: text('icon'),
    color: text('color'),
    tags: jsonb('tags')
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    links: jsonb('links')
      .$type<ExternalLink[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    lastManualUpdateAt: timestamp('last_manual_update_at', { withTimezone: true }),
    lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    freshness: text('freshness').$type<FreshnessState>().notNull().default('never'),
    needsAttention: boolean('needs_attention').notNull().default(false),
  },
  (table) => [
    index('projects_status_idx').on(table.status),
    index('projects_type_idx').on(table.type),
    index('projects_archived_at_idx').on(table.archivedAt),
    index('projects_needs_attention_idx').on(table.needsAttention),
    index('projects_updated_at_idx').on(table.updatedAt),
    index('projects_freshness_idx').on(table.freshness),
    uniqueIndex('projects_name_unique_idx').on(sql`lower(${table.name})`),
  ],
);

export const projectSources = pgTable(
  'project_sources',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    kind: text('kind').$type<SourceKind>().notNull(),
    isPrimary: boolean('is_primary').notNull().default(false),
    label: text('label'),

    /* github_repo */
    githubRepoId: integer('github_repo_id'),
    githubOwner: text('github_owner'),
    githubRepo: text('github_repo'),
    githubUrl: text('github_url'),
    githubVisibility: text('github_visibility').$type<'public' | 'private' | 'internal'>(),
    githubDefaultBranch: text('github_default_branch'),
    githubArchived: boolean('github_archived').notNull().default(false),
    githubPrimaryLanguage: text('github_primary_language'),
    githubLastActivityAt: timestamp('github_last_activity_at', { withTimezone: true }),

    /* external_link */
    externalUrl: text('external_url'),

    syncStatus: text('sync_status').$type<SyncStatus>().notNull().default('never'),
    lastSyncOkAt: timestamp('last_sync_ok_at', { withTimezone: true }),
    lastSyncFailedAt: timestamp('last_sync_failed_at', { withTimezone: true }),
    lastSyncError: text('last_sync_error'),
    availableCapabilities: jsonb('available_capabilities')
      .$type<SourceCapability[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    unavailableCapabilities: jsonb('unavailable_capabilities')
      .$type<SourceCapability[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('project_sources_project_id_idx').on(table.projectId),
    index('project_sources_kind_idx').on(table.kind),
    /**
     * Prevents importing the same repository twice. Scoped to `kind` so multiple GitHub
     * repositories per project remain possible — only duplicates are rejected.
     */
    uniqueIndex('project_sources_github_unique_idx')
      .on(sql`lower(${table.githubOwner})`, sql`lower(${table.githubRepo})`)
      .where(sql`${table.kind} = 'github_repo'`),
  ],
);

/* ------------------------------------------------------------- sub-entities */

export const goals = pgTable(
  'goals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    statement: text('statement').notNull(),
    successDefinition: text('success_definition'),
    status: text('status').$type<GoalStatus>().notNull().default('open'),
    targetDate: text('target_date'),
    provenance: text('provenance').$type<ProvenanceLevel>().notNull().default('manual'),
    sourceSystem: text('source_system').$type<SourceSystem>().notNull().default('manual'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('goals_project_id_idx').on(table.projectId)],
);

export const milestones = pgTable(
  'milestones',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    description: text('description'),
    state: text('state').$type<MilestoneState>().notNull().default('planned'),
    position: integer('position').notNull().default(0),
    targetDate: text('target_date'),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    provenance: text('provenance').$type<ProvenanceLevel>().notNull().default('manual'),
    sourceSystem: text('source_system').$type<SourceSystem>().notNull().default('manual'),
    evidenceIds: jsonb('evidence_ids')
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('milestones_project_id_idx').on(table.projectId),
    index('milestones_state_idx').on(table.state),
  ],
);

export const blockers = pgTable(
  'blockers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    description: text('description'),
    severity: text('severity').$type<BlockerSeverity>().notNull().default('medium'),
    isActive: boolean('is_active').notNull().default(true),
    resolutionRequirement: text('resolution_requirement'),
    requiresOwnerDecision: boolean('requires_owner_decision').notNull().default(false),
    provenance: text('provenance').$type<ProvenanceLevel>().notNull().default('manual'),
    sourceSystem: text('source_system').$type<SourceSystem>().notNull().default('manual'),
    evidenceIds: jsonb('evidence_ids')
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  },
  (table) => [
    index('blockers_project_id_idx').on(table.projectId),
    index('blockers_active_idx').on(table.isActive),
    index('blockers_requires_decision_idx').on(table.requiresOwnerDecision),
  ],
);

export const decisions = pgTable(
  'decisions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    decision: text('decision').notNull(),
    reasoning: text('reasoning'),
    decidedOn: text('decided_on'),
    supersedesDecisionId: uuid('supersedes_decision_id'),
    provenance: text('provenance').$type<ProvenanceLevel>().notNull().default('manual'),
    sourceSystem: text('source_system').$type<SourceSystem>().notNull().default('manual'),
    evidenceIds: jsonb('evidence_ids')
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('decisions_project_id_idx').on(table.projectId)],
);

export const manualUpdates = pgTable(
  'manual_updates',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    whatChanged: text('what_changed').notNull(),
    currentWork: text('current_work'),
    problemsOrRisks: text('problems_or_risks'),
    proposedNextAction: text('proposed_next_action'),
    occurredOn: text('occurred_on'),
    sourceSystem: text('source_system').$type<SourceSystem>().notNull().default('manual'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('manual_updates_project_id_idx').on(table.projectId),
    index('manual_updates_created_at_idx').on(table.createdAt),
  ],
);

export const nextActions = pgTable(
  'next_actions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    action: text('action').notNull(),
    priority: text('priority').$type<NextActionPriority>().notNull().default('medium'),
    status: text('status').$type<NextActionStatus>().notNull().default('open'),
    position: integer('position').notNull().default(0),
    dueDate: text('due_date'),
    requiresOwner: boolean('requires_owner').notNull().default(false),
    provenance: text('provenance').$type<ProvenanceLevel>().notNull().default('manual'),
    sourceSystem: text('source_system').$type<SourceSystem>().notNull().default('manual'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (table) => [
    index('next_actions_project_id_idx').on(table.projectId),
    index('next_actions_status_idx').on(table.status),
    index('next_actions_due_date_idx').on(table.dueDate),
  ],
);

/* ----------------------------------------------------------------- evidence */

export const evidence = pgTable(
  'evidence',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    sourceId: uuid('source_id').references(() => projectSources.id, { onDelete: 'set null' }),
    kind: text('kind').$type<EvidenceKind>().notNull(),
    sourceSystem: text('source_system').$type<SourceSystem>().notNull(),
    externalId: text('external_id').notNull(),
    title: text('title').notNull(),
    summary: text('summary'),
    url: text('url'),
    observedAt: timestamp('observed_at', { withTimezone: true }).notNull(),
    fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),
    metadata: jsonb('metadata')
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
  },
  (table) => [
    /** Idempotency key: re-syncing the same commit/PR/run updates instead of duplicating. */
    uniqueIndex('evidence_identity_idx').on(
      table.projectId,
      table.sourceSystem,
      table.kind,
      table.externalId,
    ),
    index('evidence_project_observed_idx').on(table.projectId, table.observedAt),
    index('evidence_kind_idx').on(table.kind),
    index('evidence_source_id_idx').on(table.sourceId),
  ],
);

/* ---------------------------------------------------------------- snapshots */

export const statusSnapshots = pgTable(
  'status_snapshots',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    generatedAt: timestamp('generated_at', { withTimezone: true }).notNull().defaultNow(),
    status: text('status').$type<ProjectStatus>().notNull(),
    phase: text('phase'),
    headline: text('headline').notNull(),
    recentlyCompleted: jsonb('recently_completed')
      .$type<Claim[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    currentWork: jsonb('current_work')
      .$type<Claim[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    blockers: jsonb('blockers')
      .$type<Claim[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    decisionsNeeded: jsonb('decisions_needed')
      .$type<Claim[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    recommendedActions: jsonb('recommended_actions')
      .$type<RecommendedAction[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    attention: jsonb('attention')
      .$type<AttentionReason[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    evidenceIds: jsonb('evidence_ids')
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    freshness: jsonb('freshness').$type<FreshnessAssessment>().notNull(),
    unknowns: jsonb('unknowns')
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    summaryMethod: text('summary_method').$type<SummaryMethod>().notNull(),
    /** Stable hash of the assessment; equal fingerprints mean "nothing meaningful changed". */
    fingerprint: text('fingerprint').notNull(),
    narrative: jsonb('narrative').$type<Record<string, unknown>>(),
  },
  (table) => [
    index('status_snapshots_project_generated_idx').on(table.projectId, table.generatedAt),
    index('status_snapshots_fingerprint_idx').on(table.projectId, table.fingerprint),
  ],
);

/* ---------------------------------------------------------------- sync runs */

export const syncRuns = pgTable(
  'sync_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }),
    sourceId: uuid('source_id').references(() => projectSources.id, { onDelete: 'set null' }),
    trigger: text('trigger').$type<'manual' | 'scheduled' | 'import'>().notNull(),
    status: text('status').$type<SyncStatus>().notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    evidenceWritten: integer('evidence_written').notNull().default(0),
    /** Per-category outcome: which data categories succeeded, which were denied, which failed. */
    categoryResults: jsonb('category_results')
      .$type<Record<string, { ok: boolean; reason?: string; count?: number }>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    errorCode: text('error_code'),
    errorMessage: text('error_message'),
    rateLimitRemaining: integer('rate_limit_remaining'),
    rateLimitLimit: integer('rate_limit_limit'),
    rateLimitResetAt: timestamp('rate_limit_reset_at', { withTimezone: true }),
  },
  (table) => [
    index('sync_runs_project_started_idx').on(table.projectId, table.startedAt),
    index('sync_runs_status_idx').on(table.status),
  ],
);

/**
 * Cooperative synchronisation locks.
 *
 * A row here means "a sync is in flight for this project". `expiresAt` makes the lock
 * self-healing if a serverless invocation is killed mid-run.
 */
export const syncLocks = pgTable(
  'sync_locks',
  {
    projectId: uuid('project_id')
      .primaryKey()
      .references(() => projects.id, { onDelete: 'cascade' }),
    lockedAt: timestamp('locked_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    holder: text('holder').notNull(),
  },
  (table) => [index('sync_locks_expires_at_idx').on(table.expiresAt)],
);

/* ------------------------------------------------------------- activity log */

export const activityLog = pgTable(
  'activity_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }),
    kind: text('kind').$type<ActivityKind>().notNull(),
    summary: text('summary').notNull(),
    /** Small, redacted, non-sensitive detail. Never a raw provider payload. */
    detail: jsonb('detail')
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('activity_log_project_created_idx').on(table.projectId, table.createdAt),
    index('activity_log_created_idx').on(table.createdAt),
    index('activity_log_kind_idx').on(table.kind),
  ],
);

/** Single-row-per-key owner preferences (theme, retention window, sync cadence). */
export const appSettings = pgTable('app_settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').$type<unknown>().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Recent Jarvis command-bar queries, so the owner's history survives a reload. */
export const queryHistory = pgTable(
  'query_history',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    queryText: text('query_text').notNull(),
    intent: text('intent').notNull(),
    projectId: uuid('project_id').references(() => projects.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('query_history_created_idx').on(table.createdAt)],
);

/* ---------------------------------------------------------------- relations */

export const projectRelations = relations(projects, ({ many }) => ({
  sources: many(projectSources),
  goals: many(goals),
  milestones: many(milestones),
  blockers: many(blockers),
  decisions: many(decisions),
  updates: many(manualUpdates),
  nextActions: many(nextActions),
  evidence: many(evidence),
  snapshots: many(statusSnapshots),
}));

export const projectSourceRelations = relations(projectSources, ({ one, many }) => ({
  project: one(projects, { fields: [projectSources.projectId], references: [projects.id] }),
  evidence: many(evidence),
}));

export const evidenceRelations = relations(evidence, ({ one }) => ({
  project: one(projects, { fields: [evidence.projectId], references: [projects.id] }),
  source: one(projectSources, { fields: [evidence.sourceId], references: [projectSources.id] }),
}));

/* ============================ Mission Control ============================ */

/* ------------------------------------------------------------------ workers */

/**
 * Enrolled worker processes.
 *
 * `token_hash` is a SHA-256 of the enrolment secret. The secret itself exists in exactly two
 * places: the worker's configuration, and the one HTTP response that created it.
 */
export const workers = pgTable(
  'workers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    tokenHash: text('token_hash').notNull(),
    /** Enough to recognise a worker in a list; never enough to authenticate as one. */
    tokenPrefix: text('token_prefix').notNull(),
    status: text('status').$type<WorkerStatus>().notNull().default('registered'),
    version: text('version'),
    platform: text('platform'),
    currentMissionId: uuid('current_mission_id'),
    currentRunId: uuid('current_run_id'),
    maxConcurrency: integer('max_concurrency').notNull().default(1),
    runtimeAvailable: boolean('runtime_available').notNull().default(false),
    runtimeName: text('runtime_name'),
    runtimeDetail: text('runtime_detail'),
    workspaceHealthy: boolean('workspace_healthy').notNull().default(false),
    workspaceRootLabel: text('workspace_root_label'),
    githubDeliveryConfigured: boolean('github_delivery_configured').notNull().default(false),
    diagnostics: jsonb('diagnostics')
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    lastHeartbeatAt: timestamp('last_heartbeat_at', { withTimezone: true }),
    lastActivityAt: timestamp('last_activity_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    rotatedAt: timestamp('rotated_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokedReason: text('revoked_reason'),
  },
  (table) => [
    uniqueIndex('workers_token_hash_idx').on(table.tokenHash),
    index('workers_status_idx').on(table.status),
    index('workers_heartbeat_idx').on(table.lastHeartbeatAt),
  ],
);

/* ----------------------------------------------------------------- missions */

export const missions = pgTable(
  'missions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }),
    ownerLogin: text('owner_login'),
    rawRequest: text('raw_request').notNull(),
    title: text('title').notNull(),
    description: text('description'),
    type: text('type').$type<MissionType>().notNull(),
    riskLevel: text('risk_level').$type<MissionRiskLevel>().notNull(),
    riskRuleIds: jsonb('risk_rule_ids')
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    riskReasons: jsonb('risk_reasons')
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    state: text('state').$type<MissionState>().notNull().default('draft'),
    priority: text('priority').$type<MissionPriority>().notNull().default('medium'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    targetDate: text('target_date'),

    sourceId: uuid('source_id').references(() => projectSources.id, { onDelete: 'set null' }),
    repositoryOwner: text('repository_owner'),
    repositoryName: text('repository_name'),
    baseBranch: text('base_branch'),
    workingBranch: text('working_branch'),
    baseSha: text('base_sha'),
    pullRequestUrl: text('pull_request_url'),
    pullRequestNumber: integer('pull_request_number'),

    activeRunId: uuid('active_run_id'),
    claimedByWorkerId: uuid('claimed_by_worker_id').references(() => workers.id, {
      onDelete: 'set null',
    }),
    attemptCount: integer('attempt_count').notNull().default(0),
    currentPlanVersion: integer('current_plan_version'),
    approvedPlanVersion: integer('approved_plan_version'),

    /* Prompt 3: the task graph is versioned and approved exactly like the plan. */
    currentGraphVersion: integer('current_graph_version'),
    approvedGraphVersion: integer('approved_graph_version'),
    playbookKey: text('playbook_key'),
    playbookVersion: integer('playbook_version'),
    integrationBranch: text('integration_branch'),
    repairRoundsUsed: integer('repair_rounds_used').notNull().default(0),
    /** Set once the mission has a completion receipt. Its absence means "not delivery-ready". */
    receiptId: uuid('receipt_id'),

    executionOverrideAt: timestamp('execution_override_at', { withTimezone: true }),
    executionOverrideReason: text('execution_override_reason'),

    constraints: jsonb('constraints')
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    doNotTouch: jsonb('do_not_touch')
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    deliverable: text('deliverable'),
    acceptanceCriteria: jsonb('acceptance_criteria')
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),

    cancellationReason: text('cancellation_reason'),
    completionSummary: text('completion_summary'),
    failureCode: text('failure_code').$type<MissionFailureCode>(),
    failureMessage: text('failure_message'),
    evidenceIds: jsonb('evidence_ids')
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    lastActivityAt: timestamp('last_activity_at', { withTimezone: true }),
  },
  (table) => [
    index('missions_project_idx').on(table.projectId),
    index('missions_state_idx').on(table.state),
    index('missions_created_idx').on(table.createdAt),
    index('missions_updated_idx').on(table.updatedAt),
    index('missions_worker_idx').on(table.claimedByWorkerId),
  ],
);

/* -------------------------------------------------------------------- plans */

export const missionPlans = pgTable(
  'mission_plans',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    missionId: uuid('mission_id')
      .notNull()
      .references(() => missions.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    content: jsonb('content').$type<MissionPlanContent>().notNull(),
    author: text('author').$type<PlanAuthor>().notNull(),
    provenance: text('provenance').$type<ProvenanceLevel>().notNull().default('inferred'),
    riskLevel: text('risk_level').$type<MissionRiskLevel>().notNull(),
    runId: uuid('run_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    supersededAt: timestamp('superseded_at', { withTimezone: true }),
    /** Equal fingerprints mean "this edit changed nothing", so no version is created. */
    fingerprint: text('fingerprint').notNull(),
  },
  (table) => [
    uniqueIndex('mission_plans_version_idx').on(table.missionId, table.version),
    index('mission_plans_mission_idx').on(table.missionId),
  ],
);

/**
 * Approvals.
 *
 * Recorded against a specific plan version. An edit revokes the approval rather than carrying it
 * forward, which is what makes "approval of one plan version must not approve later edits" true
 * by construction rather than by convention.
 */
export const missionApprovals = pgTable(
  'mission_approvals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    missionId: uuid('mission_id')
      .notNull()
      .references(() => missions.id, { onDelete: 'cascade' }),
    planId: uuid('plan_id')
      .notNull()
      .references(() => missionPlans.id, { onDelete: 'cascade' }),
    planVersion: integer('plan_version').notNull(),
    approvedBy: text('approved_by').notNull(),
    approvedAt: timestamp('approved_at', { withTimezone: true }).notNull().defaultNow(),
    approvedRiskLevel: text('approved_risk_level').$type<MissionRiskLevel>().notNull(),
    approvedScope: jsonb('approved_scope')
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    note: text('note'),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokedReason: text('revoked_reason'),
  },
  (table) => [
    index('mission_approvals_mission_idx').on(table.missionId),
    uniqueIndex('mission_approvals_active_idx')
      .on(table.missionId, table.planVersion)
      .where(sql`${table.revokedAt} is null`),
  ],
);

/* ----------------------------------------------------------- clarifications */

export const missionClarifications = pgTable(
  'mission_clarifications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    missionId: uuid('mission_id')
      .notNull()
      .references(() => missions.id, { onDelete: 'cascade' }),
    questionId: text('question_id').notNull(),
    topic: text('topic').notNull(),
    question: text('question').notNull(),
    why: text('why').notNull(),
    options: jsonb('options')
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    recommendation: text('recommendation'),
    rule: text('rule').notNull(),
    answer: text('answer'),
    /** `manual` when the owner answered; `inferred` when they accepted Jarvis's recommendation. */
    answerProvenance: text('answer_provenance').$type<ProvenanceLevel>(),
    askedAt: timestamp('asked_at', { withTimezone: true }).notNull().defaultNow(),
    answeredAt: timestamp('answered_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('mission_clarifications_question_idx').on(table.missionId, table.questionId),
    index('mission_clarifications_mission_idx').on(table.missionId),
  ],
);

/* --------------------------------------------------------------------- runs */

export const missionRuns = pgTable(
  'mission_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    missionId: uuid('mission_id')
      .notNull()
      .references(() => missions.id, { onDelete: 'cascade' }),
    workerId: uuid('worker_id')
      .notNull()
      .references(() => workers.id, { onDelete: 'cascade' }),
    attempt: integer('attempt').notNull(),
    kind: text('kind').$type<RunKind>().notNull(),
    state: text('state').$type<RunState>().notNull().default('starting'),
    planVersion: integer('plan_version'),
    /*
     * Prompt 3: a run may belong to one task of a task graph.
     *
     * Null keeps the Prompt 2 shape exactly — a mission-level inspection or execution run — so
     * nothing that worked before has to know tasks exist. The worker protocol is unchanged: a run
     * id is still the unit of authorisation, it simply now has an optional owner.
     */
    taskId: uuid('task_id'),
    role: text('role').$type<AgentRole>(),
    permissionProfileId: text('permission_profile_id'),
    repairRound: integer('repair_round').notNull().default(0),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    lastEventAt: timestamp('last_event_at', { withTimezone: true }),
    agentSessionId: text('agent_session_id'),
    runtimeName: text('runtime_name'),
    runtimeVersion: text('runtime_version'),
    workspacePath: text('workspace_path'),
    baseBranch: text('base_branch'),
    baseSha: text('base_sha'),
    branchName: text('branch_name'),
    headSha: text('head_sha'),
    pullRequestUrl: text('pull_request_url'),
    pullRequestNumber: integer('pull_request_number'),
    filesChanged: jsonb('files_changed')
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    usageInputTokens: bigint('usage_input_tokens', { mode: 'number' }),
    usageOutputTokens: bigint('usage_output_tokens', { mode: 'number' }),
    usageCacheReadTokens: bigint('usage_cache_read_tokens', { mode: 'number' }),
    /** An estimate reported by the runtime, never a billing statement. Labelled as such in the UI. */
    usageCostUsd: doublePrecision('usage_cost_usd'),
    usageTurns: integer('usage_turns'),
    usageDurationMs: bigint('usage_duration_ms', { mode: 'number' }),
    failureCode: text('failure_code').$type<MissionFailureCode>(),
    failureMessage: text('failure_message'),
    currentAction: text('current_action'),
    workspacePreserved: boolean('workspace_preserved').notNull().default(true),
    /** Highest event sequence accepted for this run, so replays are cheap to reject. */
    lastEventSeq: bigint('last_event_seq', { mode: 'number' }).notNull().default(0),
  },
  (table) => [
    /*
     * Two partial indexes rather than one relaxed one.
     *
     * Prompt 2's guarantee — one run per (mission, attempt, kind) — still holds exactly, for
     * mission-level runs. Widening the original index to include `task_id` would have quietly
     * destroyed it: in Postgres two NULLs are distinct, so every mission-level run would have
     * stopped colliding with every other. Task-bound runs get their own uniqueness instead.
     */
    uniqueIndex('mission_runs_attempt_idx')
      .on(table.missionId, table.attempt, table.kind)
      .where(sql`task_id is null`),
    uniqueIndex('mission_runs_task_attempt_idx')
      .on(table.taskId, table.attempt)
      .where(sql`task_id is not null`),
    index('mission_runs_mission_idx').on(table.missionId),
    index('mission_runs_worker_idx').on(table.workerId),
    index('mission_runs_state_idx').on(table.state),
    index('mission_runs_task_idx').on(table.taskId),
  ],
);

/* ------------------------------------------------------------------- events */

export const missionEvents = pgTable(
  'mission_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    missionId: uuid('mission_id')
      .notNull()
      .references(() => missions.id, { onDelete: 'cascade' }),
    runId: uuid('run_id').references(() => missionRuns.id, { onDelete: 'cascade' }),
    seq: bigint('seq', { mode: 'number' }).notNull(),
    type: text('type').$type<MissionEventType>().notNull(),
    level: text('level').$type<EventLevel>().notNull().default('info'),
    actor: text('actor').$type<EventActor>().notNull(),
    summary: text('summary').notNull(),
    detail: jsonb('detail')
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    /** Idempotent delivery: the same (run, seq) posted twice is one row. */
    uniqueIndex('mission_events_run_seq_idx').on(table.runId, table.seq),
    index('mission_events_mission_created_idx').on(table.missionId, table.createdAt),
    index('mission_events_run_idx').on(table.runId, table.seq),
  ],
);

/* ----------------------------------------------------------------- commands */

export const missionCommands = pgTable(
  'mission_commands',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    missionId: uuid('mission_id')
      .notNull()
      .references(() => missions.id, { onDelete: 'cascade' }),
    runId: uuid('run_id').references(() => missionRuns.id, { onDelete: 'set null' }),
    kind: text('kind').$type<CommandKind>().notNull(),
    payload: jsonb('payload')
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    state: text('state').$type<CommandState>().notNull().default('pending'),
    requestedBy: text('requested_by').notNull(),
    requestedAt: timestamp('requested_at', { withTimezone: true }).notNull().defaultNow(),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    acknowledgedAt: timestamp('acknowledged_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    failureMessage: text('failure_message'),
    /** A double-tapped Pause button produces one command, not two. */
    idempotencyKey: text('idempotency_key').notNull(),
  },
  (table) => [
    uniqueIndex('mission_commands_idempotency_idx').on(
      table.missionId,
      table.kind,
      table.idempotencyKey,
    ),
    index('mission_commands_mission_idx').on(table.missionId, table.requestedAt),
    index('mission_commands_state_idx').on(table.state),
  ],
);

/* ------------------------------------------------------- permission requests */

export const missionPermissionRequests = pgTable(
  'mission_permission_requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    missionId: uuid('mission_id')
      .notNull()
      .references(() => missions.id, { onDelete: 'cascade' }),
    runId: uuid('run_id')
      .notNull()
      .references(() => missionRuns.id, { onDelete: 'cascade' }),
    /** An approval applies to exactly this key. There is no "always allow". */
    requestKey: text('request_key').notNull(),
    kind: text('kind').$type<PermissionRequestKind>().notNull(),
    toolName: text('tool_name'),
    requestedAction: text('requested_action').notNull(),
    reason: text('reason').notNull(),
    risk: text('risk').$type<'critical' | 'high' | 'medium' | 'low'>().notNull().default('medium'),
    ifApproved: text('if_approved').notNull(),
    alternatives: jsonb('alternatives')
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    state: text('state').$type<PermissionRequestState>().notNull().default('pending'),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    decidedBy: text('decided_by'),
    decisionNote: text('decision_note'),
    answer: text('answer'),
  },
  (table) => [
    uniqueIndex('mission_permission_key_idx').on(table.runId, table.requestKey),
    index('mission_permission_mission_idx').on(table.missionId, table.state),
  ],
);

/* ------------------------------------------------------------ verifications */

export const missionVerifications = pgTable(
  'mission_verifications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    missionId: uuid('mission_id')
      .notNull()
      .references(() => missions.id, { onDelete: 'cascade' }),
    runId: uuid('run_id')
      .notNull()
      .references(() => missionRuns.id, { onDelete: 'cascade' }),
    command: text('command').notNull(),
    source: text('source').notNull(),
    outcome: text('outcome').$type<VerificationOutcome>().notNull(),
    exitCode: integer('exit_code'),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    durationMs: bigint('duration_ms', { mode: 'number' }),
    outputExcerpt: text('output_excerpt'),
    /** Null when Jarvis genuinely cannot tell whether the failure belongs to this mission. */
    missionRelated: boolean('mission_related'),
    reason: text('reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('mission_verifications_run_idx').on(table.runId),
    index('mission_verifications_mission_idx').on(table.missionId),
  ],
);

/* --------------------------------------------------------------- artifacts */

export const missionArtifacts = pgTable(
  'mission_artifacts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    missionId: uuid('mission_id')
      .notNull()
      .references(() => missions.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }),
    runId: uuid('run_id').references(() => missionRuns.id, { onDelete: 'set null' }),
    kind: text('kind').$type<ArtifactKind>().notNull(),
    title: text('title').notNull(),
    contentType: text('content_type').notNull().default('text/markdown'),
    /** Redacted before storage. Bounded by `ARTIFACT_CONTENT_MAX` at the boundary. */
    content: text('content').notNull(),
    sizeBytes: integer('size_bytes').notNull().default(0),
    sources: jsonb('sources')
      .$type<ArtifactSource[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    createdBy: text('created_by').$type<EventActor>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('mission_artifacts_mission_idx').on(table.missionId),
    index('mission_artifacts_project_idx').on(table.projectId),
  ],
);

/* ---------------------------------------------------------- worker replays */

/**
 * Idempotency records for retryable worker requests.
 *
 * A worker that times out mid-request retries; without this, "the branch was pushed" could be
 * recorded twice, or worse, a state transition applied twice. The stored response is replayed
 * verbatim, and a *different* body under the same key is a conflict rather than an overwrite.
 */
export const workerIdempotency = pgTable(
  'worker_idempotency',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workerId: uuid('worker_id')
      .notNull()
      .references(() => workers.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    endpoint: text('endpoint').notNull(),
    requestHash: text('request_hash').notNull(),
    responseStatus: integer('response_status').notNull(),
    responseBody: jsonb('response_body')
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex('worker_idempotency_key_idx').on(table.workerId, table.key),
    index('worker_idempotency_expires_idx').on(table.expiresAt),
  ],
);

/* ------------------------------------------------- Prompt 3: the factory */

/**
 * A versioned task graph.
 *
 * The same discipline as a plan: proposed, read, approved *by version*, superseded by an edit.
 * `fingerprint` covers only the material content — roles, dependencies, write sets, criteria —
 * so rewording a task description does not demand a fresh approval while changing what an agent
 * may write always does.
 */
export const missionTaskGraphs = pgTable(
  'mission_task_graphs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    missionId: uuid('mission_id')
      .notNull()
      .references(() => missions.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    planVersion: integer('plan_version').notNull(),
    state: text('state').$type<TaskGraphState>().notNull().default('draft'),
    playbookKey: text('playbook_key'),
    playbookVersion: integer('playbook_version'),
    summary: text('summary').notNull(),
    notes: jsonb('notes')
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    fingerprint: text('fingerprint').notNull(),
    maxParallelTasks: integer('max_parallel_tasks').notNull().default(3),
    maxWriteTasks: integer('max_write_tasks').notNull().default(1),
    maxRepairRounds: integer('max_repair_rounds').notNull().default(2),
    proposedBy: text('proposed_by').notNull().default('system'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    approvedBy: text('approved_by'),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokedReason: text('revoked_reason'),
  },
  (table) => [
    uniqueIndex('mission_task_graphs_version_idx').on(table.missionId, table.version),
    index('mission_task_graphs_mission_idx').on(table.missionId),
    index('mission_task_graphs_state_idx').on(table.state),
  ],
);

/**
 * One task.
 *
 * `declared_write_set` is the load-bearing column: it is compared against other tasks before a
 * task starts, and against the files that really changed after it finishes. Both comparisons use
 * the same containment rule (`domain/write-set.ts`), so a task cannot pass the first and violate
 * the spirit of the second.
 */
export const missionTasks = pgTable(
  'mission_tasks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    missionId: uuid('mission_id')
      .notNull()
      .references(() => missions.id, { onDelete: 'cascade' }),
    graphId: uuid('graph_id')
      .notNull()
      .references(() => missionTaskGraphs.id, { onDelete: 'cascade' }),
    graphVersion: integer('graph_version').notNull(),
    planVersion: integer('plan_version').notNull(),
    key: text('key').notNull(),
    title: text('title').notNull(),
    description: text('description').notNull(),
    role: text('role').$type<AgentRole>().notNull(),
    /** Names a profile defined in code. A row can never define one. */
    permissionProfileId: text('permission_profile_id').notNull(),
    taskType: text('task_type').$type<TaskType>().notNull(),
    state: text('state').$type<TaskState>().notNull().default('draft'),
    position: integer('position').notNull().default(0),

    expectedInputs: jsonb('expected_inputs')
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    expectedOutputs: jsonb('expected_outputs')
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    acceptanceCriteria: jsonb('acceptance_criteria')
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),

    workspaceRequirement: text('workspace_requirement')
      .$type<WorkspaceRequirement>()
      .notNull()
      .default('none'),
    requiresRepository: boolean('requires_repository').notNull().default(true),
    expectedFileAreas: jsonb('expected_file_areas')
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    declaredWriteSet: jsonb('declared_write_set')
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    actualChangedFiles: jsonb('actual_changed_files')
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),

    assignedWorkerId: uuid('assigned_worker_id').references(() => workers.id, {
      onDelete: 'set null',
    }),
    activeRunId: uuid('active_run_id'),
    attempt: integer('attempt').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(1),
    maxTurns: integer('max_turns'),
    timeLimitMs: bigint('time_limit_ms', { mode: 'number' }),
    maxOutputTokens: bigint('max_output_tokens', { mode: 'number' }),

    usageInputTokens: bigint('usage_input_tokens', { mode: 'number' }),
    usageOutputTokens: bigint('usage_output_tokens', { mode: 'number' }),
    usageCostUsd: doublePrecision('usage_cost_usd'),
    usageTurns: integer('usage_turns'),
    usageDurationMs: bigint('usage_duration_ms', { mode: 'number' }),

    reviewsTaskId: uuid('reviews_task_id'),
    repairRound: integer('repair_round').notNull().default(0),
    latestReviewId: uuid('latest_review_id'),

    branchName: text('branch_name'),
    baseSha: text('base_sha'),
    headSha: text('head_sha'),
    workspacePath: text('workspace_path'),
    workspacePreserved: boolean('workspace_preserved').notNull().default(true),

    failureCode: text('failure_code').$type<TaskFailureCode>(),
    failureMessage: text('failure_message'),
    summary: text('summary'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    lastActivityAt: timestamp('last_activity_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('mission_tasks_key_idx').on(table.graphId, table.key),
    index('mission_tasks_mission_idx').on(table.missionId),
    index('mission_tasks_graph_idx').on(table.graphId),
    index('mission_tasks_state_idx').on(table.state),
    index('mission_tasks_worker_idx').on(table.assignedWorkerId),
    index('mission_tasks_role_idx').on(table.role),
  ],
);

/** Edges. A separate table so readiness is a join rather than a JSON scan. */
export const missionTaskDependencies = pgTable(
  'mission_task_dependencies',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    graphId: uuid('graph_id')
      .notNull()
      .references(() => missionTaskGraphs.id, { onDelete: 'cascade' }),
    taskId: uuid('task_id')
      .notNull()
      .references(() => missionTasks.id, { onDelete: 'cascade' }),
    dependsOnTaskId: uuid('depends_on_task_id')
      .notNull()
      .references(() => missionTasks.id, { onDelete: 'cascade' }),
  },
  (table) => [
    uniqueIndex('mission_task_dependencies_edge_idx').on(table.taskId, table.dependsOnTaskId),
    index('mission_task_dependencies_graph_idx').on(table.graphId),
  ],
);

/**
 * Write leases.
 *
 * A lease is held for the duration of a write-capable task and names the paths that task may
 * change. Two live leases whose paths overlap cannot both exist, which is enforced by the
 * service that grants them rather than by the schema — Postgres has no "overlapping prefix"
 * exclusion constraint for arbitrary path lists — but the unique index below at least guarantees
 * one live lease per task.
 */
export const missionWriteLeases = pgTable(
  'mission_write_leases',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    missionId: uuid('mission_id')
      .notNull()
      .references(() => missions.id, { onDelete: 'cascade' }),
    taskId: uuid('task_id')
      .notNull()
      .references(() => missionTasks.id, { onDelete: 'cascade' }),
    runId: uuid('run_id'),
    paths: jsonb('paths')
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    state: text('state').$type<'held' | 'released'>().notNull().default('held'),
    acquiredAt: timestamp('acquired_at', { withTimezone: true }).notNull().defaultNow(),
    releasedAt: timestamp('released_at', { withTimezone: true }),
    releasedReason: text('released_reason'),
  },
  (table) => [
    uniqueIndex('mission_write_leases_task_idx')
      .on(table.taskId)
      .where(sql`state = 'held'`),
    index('mission_write_leases_mission_idx').on(table.missionId),
  ],
);

/**
 * One review verdict.
 *
 * `diff_fingerprint` is what stops a verdict outliving the thing it was about: an approval is
 * for a specific diff, and a later diff has a different fingerprint, so it has no approval.
 * `cold_context` records that the reviewer was given the constructed context and nothing else.
 */
export const missionReviews = pgTable(
  'mission_reviews',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    missionId: uuid('mission_id')
      .notNull()
      .references(() => missions.id, { onDelete: 'cascade' }),
    taskId: uuid('task_id')
      .notNull()
      .references(() => missionTasks.id, { onDelete: 'cascade' }),
    runId: uuid('run_id'),
    graphVersion: integer('graph_version').notNull(),
    planVersion: integer('plan_version').notNull(),
    reviewerRole: text('reviewer_role').$type<AgentRole>().notNull(),
    verdict: text('verdict').$type<ReviewVerdict>().notNull(),
    /** What the reviewer proposed, before deterministic policy reconciled it. Kept for audit. */
    proposedVerdict: text('proposed_verdict').$type<ReviewVerdict>(),
    overrideRule: text('override_rule'),
    overrideReason: text('override_reason'),
    summary: text('summary').notNull(),
    diffFingerprint: text('diff_fingerprint').notNull(),
    reviewedFiles: jsonb('reviewed_files')
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    verificationSnapshot: jsonb('verification_snapshot')
      .$type<{ check: string; outcome: VerificationOutcome; required: boolean }[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    repairRound: integer('repair_round').notNull().default(0),
    coldContext: boolean('cold_context').notNull().default(true),
    unavailableReason: text('unavailable_reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('mission_reviews_mission_idx').on(table.missionId),
    index('mission_reviews_task_idx').on(table.taskId),
    index('mission_reviews_verdict_idx').on(table.verdict),
  ],
);

/** One structured finding. Prose alone cannot be stored, which is the point. */
export const missionReviewFindings = pgTable(
  'mission_review_findings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    reviewId: uuid('review_id')
      .notNull()
      .references(() => missionReviews.id, { onDelete: 'cascade' }),
    missionId: uuid('mission_id')
      .notNull()
      .references(() => missions.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    severity: text('severity').$type<FindingSeverity>().notNull(),
    category: text('category').$type<FindingCategory>().notNull(),
    title: text('title').notNull(),
    description: text('description').notNull(),
    evidence: text('evidence').notNull(),
    file: text('file'),
    line: integer('line'),
    component: text('component'),
    violates: text('violates'),
    reproduction: text('reproduction'),
    recommendation: text('recommendation').notNull(),
    confidence: text('confidence').$type<FindingConfidence>().notNull(),
    blocksDelivery: boolean('blocks_delivery').notNull().default(false),
    state: text('state').$type<FindingState>().notNull().default('open'),
    triageRule: text('triage_rule'),
    ownerDecision: text('owner_decision'),
    resolvedByTaskId: uuid('resolved_by_task_id'),
    repairRound: integer('repair_round').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('mission_review_findings_key_idx').on(table.reviewId, table.key),
    index('mission_review_findings_mission_idx').on(table.missionId),
    index('mission_review_findings_state_idx').on(table.state),
    index('mission_review_findings_severity_idx').on(table.severity),
  ],
);

/** The completion receipt: the only thing that makes a mission delivery-ready. */
export const missionReceipts = pgTable(
  'mission_receipts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    missionId: uuid('mission_id')
      .notNull()
      .references(() => missions.id, { onDelete: 'cascade' }),
    graphVersion: integer('graph_version').notNull(),
    planVersion: integer('plan_version').notNull(),
    content: jsonb('content').$type<CompletionReceiptContent>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('mission_receipts_version_idx').on(table.missionId, table.graphVersion),
    index('mission_receipts_mission_idx').on(table.missionId),
  ],
);

/* ------------------------------------------------------------- playbooks */

export const playbooks = pgTable(
  'playbooks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    key: text('key').notNull(),
    name: text('name').notNull(),
    description: text('description').notNull(),
    builtIn: boolean('built_in').notNull().default(false),
    enabled: boolean('enabled').notNull().default(true),
    latestVersion: integer('latest_version').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('playbooks_key_idx').on(table.key)],
);

/**
 * A playbook version.
 *
 * Immutable. Editing a playbook writes a new row; a mission records the exact version it ran, so
 * a playbook changed halfway through a mission cannot change what that mission is doing.
 */
export const playbookVersions = pgTable(
  'playbook_versions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    playbookId: uuid('playbook_id')
      .notNull()
      .references(() => playbooks.id, { onDelete: 'cascade' }),
    playbookKey: text('playbook_key').notNull(),
    version: integer('version').notNull(),
    definition: jsonb('definition').$type<PlaybookDefinition>().notNull(),
    fingerprint: text('fingerprint').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    createdBy: text('created_by').notNull().default('system'),
    note: text('note'),
  },
  (table) => [
    uniqueIndex('playbook_versions_version_idx').on(table.playbookId, table.version),
    index('playbook_versions_key_idx').on(table.playbookKey),
  ],
);

/* --------------------------------------------------- CI and release control */

/**
 * Every dispatch Jarvis was asked for, whether or not it happened.
 *
 * Refusals are rows too. A CI controller that silently drops what it will not do is impossible to
 * debug and impossible to audit; `refusal_rule` says exactly which gate closed.
 */
export const ciDispatches = pgTable(
  'ci_dispatches',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    missionId: uuid('mission_id').references(() => missions.id, { onDelete: 'set null' }),
    taskId: uuid('task_id').references(() => missionTasks.id, { onDelete: 'set null' }),
    projectId: uuid('project_id').references(() => projects.id, { onDelete: 'set null' }),
    purpose: text('purpose').$type<CiDispatchPurpose>().notNull(),
    repositoryFullName: text('repository_full_name').notNull(),
    workflowFile: text('workflow_file').notNull(),
    ref: text('ref').notNull(),
    commitSha: text('commit_sha').notNull(),
    inputs: jsonb('inputs')
      .$type<Record<string, string>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    inputsFingerprint: text('inputs_fingerprint').notNull(),
    state: text('state').$type<CiDispatchState>().notNull().default('requested'),
    refusalRule: text('refusal_rule'),
    refusalReason: text('refusal_reason'),
    requestedBy: text('requested_by').notNull(),
    requestedAt: timestamp('requested_at', { withTimezone: true }).notNull().defaultNow(),
    approvedBy: text('approved_by'),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    dispatchedAt: timestamp('dispatched_at', { withTimezone: true }),
    idempotencyKey: text('idempotency_key').notNull(),
    externalRunId: text('external_run_id'),
    externalRunUrl: text('external_run_url'),
    conclusion: text('conclusion'),
    stageReport: jsonb('stage_report')
      .$type<{ stage: string; state: string }[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('ci_dispatches_idempotency_idx').on(table.idempotencyKey),
    index('ci_dispatches_mission_idx').on(table.missionId),
    index('ci_dispatches_state_idx').on(table.state),
    index('ci_dispatches_requested_idx').on(table.requestedAt),
  ],
);

/**
 * An owner's approval for one external build.
 *
 * `identity` is the hash of repository + workflow + ref + commit + inputs. When any of those
 * change, the identity changes and the approval no longer matches — which is the whole mechanism
 * behind "do not reuse a previous approval after the commit changes".
 */
export const releaseApprovals = pgTable(
  'release_approvals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    missionId: uuid('mission_id').references(() => missions.id, { onDelete: 'set null' }),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull().default('testflight'),
    repositoryFullName: text('repository_full_name').notNull(),
    workflowFile: text('workflow_file').notNull(),
    ref: text('ref').notNull(),
    commitSha: text('commit_sha').notNull(),
    inputs: jsonb('inputs')
      .$type<Record<string, string>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    identity: text('identity').notNull(),
    state: text('state').$type<ReleaseApprovalState>().notNull().default('pending'),
    bundleIdentifier: text('bundle_identifier'),
    buildNumber: text('build_number'),
    approvedBy: text('approved_by'),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    supersededReason: text('superseded_reason'),
    dispatchId: uuid('dispatch_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('release_approvals_project_idx').on(table.projectId),
    index('release_approvals_state_idx').on(table.state),
    uniqueIndex('release_approvals_identity_idx')
      .on(table.identity)
      .where(sql`state = 'approved'`),
  ],
);

/* ------------------------------------------------------------- wallboards */

/**
 * A paired display device.
 *
 * Same credential discipline as a worker: hashed at rest, shown once, revocable, checked per
 * request. What differs is the size of what it unlocks — a sanitised summary and nothing else.
 */
export const displayDevices = pgTable(
  'display_devices',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    tokenHash: text('token_hash').notNull(),
    tokenPrefix: text('token_prefix').notNull(),
    location: text('location'),
    scopes: jsonb('scopes')
      .$type<DisplayScope[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    rotationSeconds: integer('rotation_seconds').notNull().default(20),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
    lastSeenUserAgent: text('last_seen_user_agent'),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokedReason: text('revoked_reason'),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('display_devices_token_hash_idx').on(table.tokenHash),
    index('display_devices_revoked_idx').on(table.revokedAt),
  ],
);

/* --------------------------------------------------------- the app factory */

/**
 * App identity and shape.
 *
 * Signing material is conspicuously absent and stays absent: `signing_secret_names` holds the
 * *names* of GitHub Actions secrets, so Jarvis can report that a repository looks configured
 * without ever being able to read what it is configured with.
 */
export const projectAppProfiles = pgTable(
  'project_app_profiles',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    platform: text('platform').$type<AppPlatform>().notNull().default('ios'),
    appName: text('app_name'),
    bundleIdentifier: text('bundle_identifier'),
    sku: text('sku'),
    teamIdentifierReference: text('team_identifier_reference'),
    appCategory: text('app_category'),
    primaryColor: text('primary_color'),
    iconState: text('icon_state').$type<IconState>().notNull().default('none'),
    subscriptionModel: text('subscription_model')
      .$type<SubscriptionModel>()
      .notNull()
      .default('not_applicable'),
    storeKitProductIds: jsonb('storekit_product_ids')
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    requiresWidget: boolean('requires_widget').notNull().default(false),
    requiresAppGroup: boolean('requires_app_group').notNull().default(false),
    appGroupIdentifier: text('app_group_identifier'),
    requiresNotifications: boolean('requires_notifications').notNull().default(false),
    privacySensitiveApis: jsonb('privacy_sensitive_apis')
      .$type<PrivacySensitiveApi[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    websiteRepository: text('website_repository'),
    websiteDomain: text('website_domain'),
    supportUrl: text('support_url'),
    privacyUrl: text('privacy_url'),
    termsUrl: text('terms_url'),
    testFlightWorkflow: text('testflight_workflow'),
    signingSecretNames: jsonb('signing_secret_names')
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('project_app_profiles_project_idx').on(table.projectId)],
);

/* ----------------------------------------------- Prompt 4: qualification */

/**
 * One qualification attempt.
 *
 * A run is a *dated claim about a specific build*: these checks, this outcome, under these
 * assumptions. The level is stored rather than recomputed on read so that a later code change
 * cannot retroactively promote or demote a historical run — `requiresRequalification` compares
 * the stored assumptions against the live ones and says so out loud when they diverge.
 */
export const qualificationRuns = pgTable(
  'qualification_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    level: text('level').$type<QualificationLevel>().notNull().default('built'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    startedBy: text('started_by').notNull(),
    /** The commit or config fingerprint this was qualified against. */
    buildRef: text('build_ref'),
    assumptions: jsonb('assumptions')
      .$type<QualificationAssumptions>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    note: text('note'),
    supersededAt: timestamp('superseded_at', { withTimezone: true }),
    qualificationVersion: text('qualification_version').notNull(),
  },
  (table) => [
    index('qualification_runs_started_idx').on(table.startedAt),
    index('qualification_runs_level_idx').on(table.level),
  ],
);

/**
 * One check result.
 *
 * `evidence` is a string map on purpose: there is no `value` column, so a caller trying to store
 * a credential has nowhere honest to put one, and the redaction pass has a single shape to scan.
 */
export const qualificationCheckResults = pgTable(
  'qualification_check_results',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    runId: uuid('run_id')
      .notNull()
      .references(() => qualificationRuns.id, { onDelete: 'cascade' }),
    checkId: text('check_id').$type<QualificationCheckId>().notNull(),
    outcome: text('outcome').$type<CheckOutcome>().notNull(),
    detail: text('detail').notNull(),
    evidence: jsonb('evidence')
      .$type<Record<string, string>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    /** Required, and at least ten characters, before `not_applicable` counts as a waiver. */
    waivedReason: text('waived_reason'),
    checkedAt: timestamp('checked_at', { withTimezone: true }).notNull().defaultNow(),
    durationMs: integer('duration_ms'),
  },
  (table) => [
    uniqueIndex('qualification_check_results_run_check_idx').on(table.runId, table.checkId),
    index('qualification_check_results_check_idx').on(table.checkId),
  ],
);

/**
 * What the test suite and the simulated smoke test last said, per build.
 *
 * The `automated` and `simulated` rungs are earned by tests rather than by configuration, so they
 * are reported here rather than as checks. Keyed by kind, because the only interesting answer is
 * the most recent one — an older green run on an older build is not evidence about this build,
 * which is exactly what `buildRef` makes visible.
 */
export const qualificationSuiteResults = pgTable('qualification_suite_results', {
  kind: text('kind').notNull().primaryKey(),
  passed: boolean('passed').notNull().default(false),
  buildRef: text('build_ref'),
  detail: text('detail').notNull(),
  testCount: integer('test_count'),
  recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * The record of a real model touching a real repository.
 *
 * Deliberately verbose: provider, model, repository, commit, branch, resulting pull request,
 * duration, and the version of the qualification procedure in force. This is the row that answers
 * "on what basis do you believe live write works?" months later. No column here can hold a
 * secret, and none is derived from one.
 */
export const liveQualificationEvidence = pgTable(
  'live_qualification_evidence',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    kind: text('kind').$type<'live_read' | 'live_write'>().notNull(),
    runId: uuid('run_id')
      .notNull()
      .references(() => qualificationRuns.id, { onDelete: 'cascade' }),
    missionId: uuid('mission_id').references(() => missions.id, { onDelete: 'set null' }),
    performedAt: timestamp('performed_at', { withTimezone: true }).notNull().defaultNow(),
    providerName: text('provider_name'),
    modelName: text('model_name'),
    repositoryFullName: text('repository_full_name').notNull(),
    commitSha: text('commit_sha'),
    branchName: text('branch_name'),
    pullRequestUrl: text('pull_request_url'),
    pullRequestNumber: integer('pull_request_number'),
    findingsCount: integer('findings_count'),
    outputTokens: bigint('output_tokens', { mode: 'number' }),
    durationMs: bigint('duration_ms', { mode: 'number' }),
    qualificationVersion: text('qualification_version').notNull(),
    summary: text('summary').notNull(),
  },
  (table) => [
    index('live_qualification_evidence_run_idx').on(table.runId),
    index('live_qualification_evidence_kind_idx').on(table.kind),
  ],
);

/* --------------------------------------------------- Prompt 4: knowledge */

/**
 * A document, note, page or repository file Jarvis has ingested.
 *
 * A source is **data, never authority**. Nothing stored here can grant a capability, approve a
 * mission or change a permission ceiling; retrieval renders it inside an explicit evidence fence
 * (`renderSourcesForPrompt`) precisely because a PDF may contain text that tries to.
 *
 * `body_text` holds the normalised text so re-chunking never needs the original bytes, and the
 * original bytes are not kept at all. `content_hash` is the identity that makes deduplication
 * real; the partial unique index applies it only to sources that still exist, so deleting and
 * re-adding the same file is allowed while adding it twice is not.
 */
export const knowledgeSources = pgTable(
  'knowledge_sources',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    kind: text('kind').$type<KnowledgeSourceKind>().notNull(),
    state: text('state').$type<SourceState>().notNull().default('pending'),
    title: text('title').notNull(),
    /** The original filename, URL or note title. Safe for display; never a credential. */
    origin: text('origin').notNull(),
    projectId: uuid('project_id').references(() => projects.id, { onDelete: 'set null' }),
    contentHash: text('content_hash').notNull(),
    byteSize: bigint('byte_size', { mode: 'number' }).notNull().default(0),
    charCount: integer('char_count').notNull().default(0),
    chunkCount: integer('chunk_count').notNull().default(0),
    version: integer('version').notNull().default(1),
    contentType: text('content_type'),
    /** Pages for a PDF, lines for text. Makes a locator mean something. */
    unitCount: integer('unit_count'),
    /** The normalised text. Emptied, not merely flagged, when a source is deleted. */
    bodyText: text('body_text'),
    tags: jsonb('tags')
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    failureCode: text('failure_code').$type<SourceFailureCode>(),
    failureMessage: text('failure_message'),
    retryCount: integer('retry_count').notNull().default(0),
    truncated: boolean('truncated').notNull().default(false),
    addedBy: text('added_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    parsedAt: timestamp('parsed_at', { withTimezone: true }),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    retainUntil: timestamp('retain_until', { withTimezone: true }),

    /* ------------------------------------------------------------ Prompt 4B */
    /**
     * The revision retrieval currently reads.
     *
     * A plain column rather than a foreign key, because the revision it points at is deleted by a
     * retention sweep long before the source is, and a cascade there would take the source with
     * it. The authoritative answer is still `knowledge_revisions.is_active`; this is the fast path.
     */
    activeRevisionId: uuid('active_revision_id'),
    /**
     * Who may retrieve from this source.
     *
     * The single authority for authorization. Retrieval joins through to this column rather than
     * reading the denormalised `project_id` on chunks, so changing a source's scope moves its
     * content immediately and cannot leave stale rows readable under the old scope.
     */
    scope: text('scope').$type<KnowledgeScope>().notNull().default('global'),
    sensitivity: text('sensitivity').$type<Sensitivity>().notNull().default('internal'),
    /** Whether the origin can be fetched again. A note cannot; a URL or repository file can. */
    refreshable: boolean('refreshable').notNull().default(false),
    lastRefreshedAt: timestamp('last_refreshed_at', { withTimezone: true }),
    /** An opaque key for the stored original. Never a filesystem path, never sent to a browser. */
    storageKey: text('storage_key'),
    originalAvailable: boolean('original_available').notNull().default(false),
  },
  (table) => [
    /*
     * A lookup index, deliberately NOT unique.
     *
     * Phase 4A had a global partial unique index here. It made revisions impossible — a source
     * could never hold two different contents — and it refused the same public document being
     * added under two different scopes, which is a legitimate thing to want. Uniqueness now lives
     * on `knowledge_revisions (source_id, content_hash)`, where it means what it should.
     */
    index('knowledge_sources_hash_lookup_idx').on(table.contentHash),
    index('knowledge_sources_project_idx').on(table.projectId),
    index('knowledge_sources_state_idx').on(table.state),
    index('knowledge_sources_kind_idx').on(table.kind),
    index('knowledge_sources_scope_idx').on(table.scope, table.projectId),
  ],
);

/**
 * One retrievable passage.
 *
 * `ordinal` is the machine-readable position and `locator` the human-readable one (`p. 4`,
 * `lines 120-138`, `## Deployment`), so a citation both resolves and reads correctly.
 *
 * `search_vector` is a stored generated column rather than a trigger or an application-side
 * write: a column the database maintains cannot drift out of step with the text beside it, and
 * cannot be forgotten by a new insert path. The two-argument `to_tsvector` is required — the
 * one-argument form is only STABLE and Postgres will refuse it here, which is the right refusal.
 */
export const knowledgeChunks = pgTable(
  'knowledge_chunks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sourceId: uuid('source_id')
      .notNull()
      .references(() => knowledgeSources.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id').references(() => projects.id, { onDelete: 'set null' }),
    ordinal: integer('ordinal').notNull(),
    locator: text('locator').notNull(),
    heading: text('heading'),
    text: text('text').notNull(),
    charCount: integer('char_count').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),

    /* ------------------------------------------------------------ Prompt 4B */
    /** The exact revision this passage came from. What a citation resolves to. */
    revisionId: uuid('revision_id').references(() => knowledgeRevisions.id, {
      onDelete: 'cascade',
    }),
    /** Deterministic identity from chunker version, location and content. Never insertion order. */
    stableKey: text('stable_key'),
    chunkerVersion: text('chunker_version'),
    headingPath: jsonb('heading_path')
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    pageNumber: integer('page_number'),
    startLine: integer('start_line'),
    endLine: integer('end_line'),
    blockOrdinals: jsonb('block_ordinals')
      .$type<number[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    /**
     * A second lexical channel, unstemmed.
     *
     * `english` stems, which is what gives "deployment" a hit for "deploy" — and what can bury an
     * exact identifier. Measured: under `simple`, "deploy" does not match "deployment", while
     * `E_AUTH_401` survives intact under both. Keeping both channels lets fusion protect exact
     * identifier matches without giving up morphological recall.
     */
    searchVectorExact: tsvector('search_vector_exact').generatedAlwaysAs(
      sql`to_tsvector('simple', coalesce("heading", '') || ' ' || "text")`,
    ),
    searchVector: tsvector('search_vector').generatedAlwaysAs(
      sql`to_tsvector('english', coalesce("heading", '') || ' ' || "text")`,
    ),
  },
  (table) => [
    /*
     * Ordinals are unique per *revision*, not per source. The Phase 4A index assumed one revision
     * per source and would refuse the second revision's first chunk.
     */
    uniqueIndex('knowledge_chunks_revision_ordinal_idx')
      .on(table.revisionId, table.ordinal)
      .where(sql`revision_id is not null`),
    uniqueIndex('knowledge_chunks_stable_key_idx')
      .on(table.revisionId, table.stableKey)
      .where(sql`revision_id is not null and stable_key is not null`),
    index('knowledge_chunks_source_idx').on(table.sourceId),
    index('knowledge_chunks_revision_idx').on(table.revisionId),
    index('knowledge_chunks_project_idx').on(table.projectId),
    index('knowledge_chunks_search_idx').using('gin', table.searchVector),
    index('knowledge_chunks_search_exact_idx').using('gin', table.searchVectorExact),
  ],
);

/**
 * One thing Jarvis believes, and why.
 *
 * `status` is the load-bearing column. Only `active` is retrievable, so a model-proposed memory
 * cannot influence an answer before I have confirmed it — the difference between a system that
 * learns and a system that quietly decides what is true about me.
 *
 * `supersedes_id` and `superseded_by_id` are plain columns rather than self-referencing keys, the
 * same choice the factory made for `reviews_task_id`: the chain has to survive a row being
 * removed without cascading a deletion through the history that explains it.
 */
export const knowledgeItems = pgTable(
  'knowledge_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    scope: text('scope').$type<KnowledgeScope>().notNull(),
    category: text('category').$type<KnowledgeCategory>().notNull(),
    origin: text('origin').$type<KnowledgeOrigin>().notNull(),
    status: text('status').$type<KnowledgeStatus>().notNull().default('suggested'),
    /** The rule id that decided the initial status, so the decision is auditable later. */
    statusRule: text('status_rule'),
    statement: text('statement').notNull(),
    detail: text('detail'),
    projectId: uuid('project_id').references(() => projects.id, { onDelete: 'set null' }),
    missionId: uuid('mission_id').references(() => missions.id, { onDelete: 'set null' }),
    sourceId: uuid('source_id').references(() => knowledgeSources.id, { onDelete: 'set null' }),
    sourceRef: text('source_ref'),
    excerpts: jsonb('excerpts')
      .$type<KnowledgeExcerpt[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    tags: jsonb('tags')
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    createdBy: text('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
    confirmedBy: text('confirmed_by'),
    reviewAt: timestamp('review_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    supersedesId: uuid('supersedes_id'),
    supersededById: uuid('superseded_by_id'),
    supersededReason: text('superseded_reason'),
    rejectedReason: text('rejected_reason'),
    forgottenAt: timestamp('forgotten_at', { withTimezone: true }),
    useCount: integer('use_count').notNull().default(0),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    confidence: text('confidence').$type<KnowledgeConfidence>(),
    searchVector: tsvector('search_vector').generatedAlwaysAs(
      sql`to_tsvector('english', "statement" || ' ' || coalesce("detail", ''))`,
    ),
  },
  (table) => [
    index('knowledge_items_status_idx').on(table.status),
    index('knowledge_items_scope_idx').on(table.scope),
    index('knowledge_items_category_idx').on(table.category),
    index('knowledge_items_project_idx').on(table.projectId),
    index('knowledge_items_source_idx').on(table.sourceId),
    index('knowledge_items_review_idx').on(table.reviewAt),
    index('knowledge_items_search_idx').using('gin', table.searchVector),
  ],
);

/**
 * Two things that appear to disagree.
 *
 * A row here is a *question put to me*, not a decision taken on my behalf. Neither side is
 * altered by detection, which is the whole point: an automatic winner would mean the newer
 * statement silently rewrote the older one.
 */
export const knowledgeConflicts = pgTable(
  'knowledge_conflicts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    kind: text('kind').$type<ConflictKind>().notNull(),
    state: text('state').$type<ConflictState>().notNull().default('open'),
    leftId: uuid('left_id').notNull(),
    rightId: uuid('right_id'),
    projectId: uuid('project_id').references(() => projects.id, { onDelete: 'set null' }),
    summary: text('summary').notNull(),
    detectedRule: text('detected_rule').notNull(),
    resolution: text('resolution'),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('knowledge_conflicts_pair_idx').on(table.leftId, table.rightId, table.kind),
    index('knowledge_conflicts_state_idx').on(table.state),
    index('knowledge_conflicts_left_idx').on(table.leftId),
  ],
);

/* ------------------------------------------ Prompt 4B: revisions and index */

/**
 * One exact retrieval of a source's content.
 *
 * A source is the origin the owner configured. A **revision** is what came back from it at one
 * instant, identified by the hash of its canonical text. Citations resolve to a revision, so
 * refreshing a document creates a new row rather than editing the evidence an older answer cited.
 *
 * `is_active` plus the partial unique index below is the whole concurrency story: exactly one
 * revision per source may be active, enforced by the database rather than by application code, so
 * two refreshes racing cannot both win. Activation is the last step — a half-indexed revision
 * cannot be active, because a document Jarvis has only partly read is worse than the older one it
 * would replace.
 */
export const knowledgeRevisions = pgTable(
  'knowledge_revisions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sourceId: uuid('source_id')
      .notNull()
      .references(() => knowledgeSources.id, { onDelete: 'cascade' }),
    /** 1-based and monotonic per source. What a person calls "version 3". */
    revisionNumber: integer('revision_number').notNull(),
    state: text('state').$type<RevisionState>().notNull().default('pending'),
    /** SHA-256 over canonical text plus parser identity. The revision's identity. */
    contentHash: text('content_hash').notNull(),
    /** SHA-256 of the raw bytes, for noticing that an origin's response changed at all. */
    byteHash: text('byte_hash'),
    byteSize: bigint('byte_size', { mode: 'number' }).notNull().default(0),
    charCount: integer('char_count').notNull().default(0),
    unitCount: integer('unit_count'),
    unitKind: text('unit_kind').$type<'page' | 'line'>().notNull().default('line'),
    blockCount: integer('block_count').notNull().default(0),
    chunkCount: integer('chunk_count').notNull().default(0),
    embeddedChunkCount: integer('embedded_chunk_count').notNull().default(0),
    /** The canonical text every block and chunk location refers into. */
    canonicalText: text('canonical_text'),
    parserName: text('parser_name').notNull(),
    parserVersion: text('parser_version').notNull(),
    chunkerVersion: text('chunker_version').notNull(),
    truncated: boolean('truncated').notNull().default(false),
    /** What the parser could not do. Not an error — an honest limitation, shown to the owner. */
    limitations: jsonb('limitations')
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    /** Where it came from. No field here can hold a credential; there is no header map. */
    provenance: jsonb('provenance')
      .$type<RevisionProvenance>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    failureCode: text('failure_code'),
    failureMessage: text('failure_message'),
    isActive: boolean('is_active').notNull().default(false),
    fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),
    activatedAt: timestamp('activated_at', { withTimezone: true }),
    supersededAt: timestamp('superseded_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    /*
     * The atomic activation guarantee. Two concurrent refreshes both trying to activate produce a
     * unique violation for the loser rather than two active revisions and a corpus that answers
     * from both.
     */
    uniqueIndex('knowledge_revisions_active_idx')
      .on(table.sourceId)
      .where(sql`is_active`),
    uniqueIndex('knowledge_revisions_number_idx').on(table.sourceId, table.revisionNumber),
    /*
     * Content identity is unique *per source*, not globally. The Phase 4A global unique index on
     * `knowledge_sources.content_hash` is dropped by this migration: it made revisions impossible
     * and stopped the same public document existing under two different scopes.
     */
    uniqueIndex('knowledge_revisions_content_idx').on(table.sourceId, table.contentHash),
    index('knowledge_revisions_source_idx').on(table.sourceId),
    index('knowledge_revisions_state_idx').on(table.state),
  ],
);

/**
 * The canonical structural extraction of a revision.
 *
 * Blocks sit between raw text and retrievable chunks because a citation needs structure: "page 4"
 * and "under ## Deployment, lines 120-138" are answers a flat string cannot give. Keeping them
 * also means re-chunking with a new chunker version never needs to re-fetch or re-parse.
 */
export const knowledgeBlocks = pgTable(
  'knowledge_blocks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    revisionId: uuid('revision_id')
      .notNull()
      .references(() => knowledgeRevisions.id, { onDelete: 'cascade' }),
    ordinal: integer('ordinal').notNull(),
    kind: text('kind').$type<BlockKind>().notNull(),
    text: text('text').notNull(),
    /** Heading nesting at this point, outermost first. */
    headingPath: jsonb('heading_path')
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    depth: integer('depth'),
    pageNumber: integer('page_number'),
    /** 0-based, inclusive, into the revision's canonical text. */
    startLine: integer('start_line').notNull(),
    endLine: integer('end_line').notNull(),
    language: text('language'),
    charCount: integer('char_count').notNull().default(0),
  },
  (table) => [
    uniqueIndex('knowledge_blocks_ordinal_idx').on(table.revisionId, table.ordinal),
    index('knowledge_blocks_revision_idx').on(table.revisionId),
    index('knowledge_blocks_page_idx').on(table.revisionId, table.pageNumber),
  ],
);

/**
 * A vector for one chunk or one memory.
 *
 * Stored as unit-normalised `real[]`, so cosine similarity is exactly a dot product and needs no
 * database extension — every driver (neon, node-postgres, PGlite) runs the same code path.
 *
 * `dimensions` is not decoration. Postgres `unnest` over two arrays of different lengths zips to
 * the longer one and pads with NULL, and `sum()` skips NULLs, so a mismatched query returns a
 * plausible number instead of an error. Every similarity query filters on this column, and a test
 * proves a mismatch returns nothing rather than a wrong score.
 */
export const knowledgeEmbeddings = pgTable(
  'knowledge_embeddings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    chunkId: uuid('chunk_id').references(() => knowledgeChunks.id, { onDelete: 'cascade' }),
    itemId: uuid('item_id').references(() => knowledgeItems.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull(),
    model: text('model').notNull(),
    dimensions: integer('dimensions').notNull(),
    /** Bumped when a vector's meaning changes; vectors from two versions are never compared. */
    indexingVersion: text('indexing_version').notNull(),
    embedding: real('embedding').array(),
    state: text('state').$type<EmbeddingState>().notNull().default('pending'),
    failureMessage: text('failure_message'),
    attempt: integer('attempt').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('knowledge_embeddings_chunk_idx')
      .on(table.chunkId, table.model, table.indexingVersion)
      .where(sql`chunk_id is not null`),
    uniqueIndex('knowledge_embeddings_item_idx')
      .on(table.itemId, table.model, table.indexingVersion)
      .where(sql`item_id is not null`),
    index('knowledge_embeddings_state_idx').on(table.state),
    index('knowledge_embeddings_model_idx').on(table.model, table.indexingVersion),
  ],
);

/**
 * Observable, retryable pipeline work.
 *
 * Ingestion is not a fire-and-forget promise. A row here is what makes "three imports pending, one
 * failed" answerable on the Operations screen, and what lets a failure be retried deliberately
 * rather than by re-uploading the file and hoping.
 *
 * `lease_owner`/`lease_expires_at` let a job be claimed without two workers running it at once,
 * the same shape the mission claim uses.
 */
export const knowledgeIngestionJobs = pgTable(
  'knowledge_ingestion_jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sourceId: uuid('source_id')
      .notNull()
      .references(() => knowledgeSources.id, { onDelete: 'cascade' }),
    revisionId: uuid('revision_id').references(() => knowledgeRevisions.id, {
      onDelete: 'cascade',
    }),
    kind: text('kind').$type<'ingest' | 'refresh' | 'reindex' | 'embed'>().notNull(),
    state: text('state')
      .$type<'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'>()
      .notNull()
      .default('queued'),
    attempt: integer('attempt').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(3),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }),
    leaseOwner: text('lease_owner'),
    leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),
    failureCode: text('failure_code'),
    failureMessage: text('failure_message'),
    requestedBy: text('requested_by').notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('knowledge_ingestion_jobs_state_idx').on(table.state, table.nextAttemptAt),
    index('knowledge_ingestion_jobs_source_idx').on(table.sourceId),
  ],
);

/* ------------------------------------------------------ Prompt 4: answers */

/**
 * A question and the answer that was given, kept whole.
 *
 * Stored because an answer is a claim Jarvis made at a moment, and "what did it tell me on
 * Tuesday, and on what basis?" is a question the system should be able to answer about itself.
 * `claims` keeps its citations, so an answer can be re-checked against the evidence it cited even
 * after that evidence has moved on.
 */
export const answers = pgTable(
  'answers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    question: text('question').notNull(),
    scope: text('scope').$type<AnswerScope>().notNull(),
    projectIds: jsonb('project_ids')
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    headline: text('headline').notNull(),
    claims: jsonb('claims')
      .$type<AnswerClaim[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    considered: jsonb('considered').$type<AnswerCoverage>().notNull(),
    method: text('method').$type<AnswerMethod>().notNull(),
    /** Set when a model answer was rejected. Names the rule, so the refusal is explainable. */
    rejectionRule: text('rejection_rule'),
    rejectionReason: text('rejection_reason'),
    missionSuggestion: jsonb('mission_suggestion').$type<MissionSuggestion | null>(),
    savedView: text('saved_view'),
    durationMs: integer('duration_ms'),
    askedBy: text('asked_by').notNull(),
    generatedAt: timestamp('generated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('answers_generated_idx').on(table.generatedAt),
    index('answers_scope_idx').on(table.scope),
  ],
);

/* ---------------------------------------------------- Prompt 4: schedules */

/**
 * A recurring job.
 *
 * The time is stored as **local wall-clock plus an IANA zone**, never as a UTC offset: an offset
 * is wrong twice a year, and a schedule that drifts an hour every spring is a schedule nobody
 * trusts. `last_occurrence_at` is the catch-up watermark — the last occurrence Jarvis has
 * *accounted for*, whether it ran it or recorded it as missed.
 *
 * `kind` maps to an activation capability in code (`KIND_CAPABILITY`), and no kind maps to a
 * write capability. A schedule cannot become permission to change code, because there is no kind
 * that asks for it.
 */
export const schedules = pgTable(
  'schedules',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    kind: text('kind').$type<ScheduleKind>().notNull(),
    name: text('name').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    cadence: text('cadence').$type<Cadence>().notNull(),
    hour: integer('hour').notNull(),
    minute: integer('minute').notNull().default(0),
    timeZone: text('time_zone').notNull(),
    weekday: integer('weekday'),
    dayOfMonth: integer('day_of_month'),
    projectId: uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }),
    catchUp: text('catch_up').$type<CatchUpPolicy>().notNull().default('run_latest'),
    maxRetries: integer('max_retries').notNull().default(2),
    instruction: text('instruction'),
    createdBy: text('created_by').notNull().default('owner'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    lastRunAt: timestamp('last_run_at', { withTimezone: true }),
    lastOccurrenceAt: timestamp('last_occurrence_at', { withTimezone: true }),
    pausedAt: timestamp('paused_at', { withTimezone: true }),
    pausedReason: text('paused_reason'),
  },
  (table) => [
    index('schedules_enabled_idx').on(table.enabled),
    index('schedules_kind_idx').on(table.kind),
    index('schedules_project_idx').on(table.projectId),
  ],
);

/**
 * One firing.
 *
 * `idempotency_key` is derived from the schedule and the **local wall-clock occurrence**, not from
 * an instant, and it is unique. That is what makes a DST-repeated 01:30 run once rather than
 * twice, and what makes a restart mid-run unable to duplicate a briefing.
 */
export const scheduleExecutions = pgTable(
  'schedule_executions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    scheduleId: uuid('schedule_id')
      .notNull()
      .references(() => schedules.id, { onDelete: 'cascade' }),
    state: text('state').$type<ExecutionState>().notNull().default('pending'),
    occurrenceAt: timestamp('occurrence_at', { withTimezone: true }).notNull(),
    /** The occurrence's local time, which the idempotency key is built from. */
    occurrenceLocal: text('occurrence_local').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    attempt: integer('attempt').notNull().default(0),
    nextRetryAt: timestamp('next_retry_at', { withTimezone: true }),
    failureCode: text('failure_code'),
    failureMessage: text('failure_message'),
    evidenceWindowFrom: timestamp('evidence_window_from', { withTimezone: true }),
    evidenceWindowTo: timestamp('evidence_window_to', { withTimezone: true }),
    resultId: uuid('result_id'),
    summary: text('summary'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('schedule_executions_idempotency_idx').on(table.idempotencyKey),
    index('schedule_executions_schedule_idx').on(table.scheduleId),
    index('schedule_executions_state_idx').on(table.state),
    index('schedule_executions_occurrence_idx').on(table.occurrenceAt),
  ],
);

/**
 * A briefing, with the window it looked at.
 *
 * The window is stored explicitly so a reader can always distinguish "nothing changed" from
 * "Jarvis did not look". `narration_rule` records the rule id when a model's narration was
 * rejected, so a deterministic briefing that had a narration attempt is visibly different from
 * one that never asked for one.
 */
export const briefings = pgTable(
  'briefings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    kind: text('kind').$type<BriefingKind>().notNull(),
    executionId: uuid('execution_id').references(() => scheduleExecutions.id, {
      onDelete: 'set null',
    }),
    projectId: uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }),
    windowFrom: timestamp('window_from', { withTimezone: true }).notNull(),
    windowTo: timestamp('window_to', { withTimezone: true }).notNull(),
    content: jsonb('content').$type<BriefingContent>().notNull(),
    narration: jsonb('narration').$type<BriefingNarration | null>(),
    narrationRule: text('narration_rule'),
    method: text('method').$type<SummaryMethod>().notNull().default('deterministic'),
    isQuiet: boolean('is_quiet').notNull().default(false),
    readAt: timestamp('read_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('briefings_created_idx').on(table.createdAt),
    index('briefings_kind_idx').on(table.kind),
    index('briefings_project_idx').on(table.projectId),
  ],
);

/* ------------------------------------------------ Prompt 4: notifications */

/**
 * Something worth telling me about.
 *
 * `title` and `body` are stored **already redacted**, because the redaction has to happen before
 * the row exists rather than on the way out to each channel — one choke point, not four.
 *
 * The partial unique index on `dedupe_key` is what stops a failing sync producing four hundred
 * rows overnight: while a notification is unacknowledged, a repeat increments `occurrence_count`
 * instead of inserting.
 */
export const notifications = pgTable(
  'notifications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    category: text('category').$type<NotificationCategory>().notNull(),
    severity: text('severity').$type<NotificationSeverity>().notNull(),
    title: text('title').notNull(),
    body: text('body'),
    projectId: uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }),
    missionId: uuid('mission_id').references(() => missions.id, { onDelete: 'cascade' }),
    /** Always a Jarvis path. A notification cannot become an outbound link. */
    href: text('href'),
    dedupeKey: text('dedupe_key').notNull(),
    occurrenceCount: integer('occurrence_count').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastOccurredAt: timestamp('last_occurred_at', { withTimezone: true }).notNull().defaultNow(),
    readAt: timestamp('read_at', { withTimezone: true }),
    acknowledgedAt: timestamp('acknowledged_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('notifications_dedupe_open_idx')
      .on(table.dedupeKey)
      .where(sql`acknowledged_at is null`),
    index('notifications_created_idx').on(table.createdAt),
    index('notifications_category_idx').on(table.category),
    index('notifications_unread_idx').on(table.readAt),
  ],
);

/**
 * One attempt to get a notification to one channel.
 *
 * Separate from the notification so a push failure is a fact about a delivery rather than about
 * the event: a failed push must never change mission state, and must never cause the underlying
 * action to run again.
 */
export const notificationDeliveries = pgTable(
  'notification_deliveries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    notificationId: uuid('notification_id')
      .notNull()
      .references(() => notifications.id, { onDelete: 'cascade' }),
    channel: text('channel').$type<NotificationChannel>().notNull(),
    state: text('state').$type<DeliveryState>().notNull().default('pending'),
    attempt: integer('attempt').notNull().default(0),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    failureMessage: text('failure_message'),
    suppressedReason: text('suppressed_reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('notification_deliveries_channel_idx').on(table.notificationId, table.channel),
    index('notification_deliveries_state_idx').on(table.state),
  ],
);

/** Per-category preferences. One row per category; absent means the code's default. */
export const notificationPreferences = pgTable('notification_preferences', {
  category: text('category').$type<NotificationCategory>().notNull().primaryKey(),
  channels: jsonb('channels')
    .$type<NotificationChannel[]>()
    .notNull()
    .default(sql`'["in_app"]'::jsonb`),
  minSeverity: text('min_severity').$type<NotificationSeverity>().notNull().default('low'),
  digest: boolean('digest').notNull().default(false),
  enabled: boolean('enabled').notNull().default(true),
  projectIds: jsonb('project_ids')
    .$type<string[]>()
    .notNull()
    .default(sql`'[]'::jsonb`),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * A browser push registration.
 *
 * The endpoint and its two keys are the browser's own credentials for its own push service, and
 * they have to live server-side for a push to be sendable at all. They are therefore treated as
 * credential material everywhere it matters: never exported, never logged, never rendered, and
 * listed in the export's forbidden keys. `endpoint_hash` is what the interface displays and what
 * deduplication uses, so no surface needs the value.
 */
export const pushSubscriptions = pgTable(
  'push_subscriptions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    endpointHash: text('endpoint_hash').notNull(),
    endpoint: text('endpoint').notNull(),
    keyP256dh: text('key_p256dh').notNull(),
    keyAuth: text('key_auth').notNull(),
    label: text('label'),
    userAgent: text('user_agent'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    failureCount: integer('failure_count').notNull().default(0),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('push_subscriptions_endpoint_idx').on(table.endpointHash),
    index('push_subscriptions_revoked_idx').on(table.revokedAt),
  ],
);

/* -------------------------------------------------------- Prompt 4: voice */

/**
 * One voice capture.
 *
 * **There is no column for audio.** Not a nullable one, not a flag pointing at a blob store:
 * transcription happens in the browser or against a provider and the audio is discarded, so
 * "do not retain raw audio by default" is a property of the schema rather than a policy someone
 * has to remember. `audio_retained` and `audio_delete_after` record whether the *client* was
 * permitted to keep its own copy for a stated window, and when that permission lapses.
 *
 * `intent` is always the server's own classification. The client sends what it displayed so the
 * two can be compared; it never sends the interpretation Jarvis acts on.
 */
export const voiceCaptures = pgTable(
  'voice_captures',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    state: text('state').$type<CaptureState>().notNull().default('recording'),
    transcript: text('transcript'),
    editedTranscript: text('edited_transcript'),
    intent: text('intent').$type<TranscriptIntent>(),
    projectId: uuid('project_id').references(() => projects.id, { onDelete: 'set null' }),
    durationMs: integer('duration_ms'),
    byteSize: bigint('byte_size', { mode: 'number' }),
    providerName: text('provider_name'),
    confidence: doublePrecision('confidence'),
    failureCode: text('failure_code').$type<CaptureFailureCode>(),
    failureMessage: text('failure_message'),
    audioRetained: boolean('audio_retained').notNull().default(false),
    audioDeleteAfter: timestamp('audio_delete_after', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
    /** What confirming produced: an answer id, a knowledge id, a mission id. */
    resultKind: text('result_kind'),
    resultId: uuid('result_id'),
  },
  (table) => [
    index('voice_captures_created_idx').on(table.createdAt),
    index('voice_captures_state_idx').on(table.state),
  ],
);

/* ------------------------------------------------------- Prompt 4: money */

/**
 * One model call, as it actually happened.
 *
 * **Append-only, and the reason matters.** Task usage columns are *replaced* on each report, and
 * `attempt` increments without clearing them, so a retried task's earlier spend disappears from
 * `mission_tasks`. A budget built on that undercounts exactly when it matters most. Rows here are
 * never updated, so retries, reviews and repair rounds all accumulate against the same budget.
 *
 * `reported_cost_usd` and `estimated_cost_usd` are separate columns on purpose. A provider figure
 * and a figure computed from a price table are different kinds of claim, and `cost_basis` says
 * which one a number is. Neither is ever defaulted to zero: unknown cost is null, and null is
 * displayed as unknown.
 */
export const usageRecords = pgTable(
  'usage_records',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    kind: text('kind').$type<UsageKind>().notNull(),
    providerName: text('provider_name'),
    modelName: text('model_name'),
    missionId: uuid('mission_id').references(() => missions.id, { onDelete: 'set null' }),
    taskId: uuid('task_id').references(() => missionTasks.id, { onDelete: 'set null' }),
    runId: uuid('run_id').references(() => missionRuns.id, { onDelete: 'set null' }),
    projectId: uuid('project_id').references(() => projects.id, { onDelete: 'set null' }),
    repositoryFullName: text('repository_full_name'),
    inputTokens: bigint('input_tokens', { mode: 'number' }),
    outputTokens: bigint('output_tokens', { mode: 'number' }),
    cachedInputTokens: bigint('cached_input_tokens', { mode: 'number' }),
    reportedCostUsd: doublePrecision('reported_cost_usd'),
    estimatedCostUsd: doublePrecision('estimated_cost_usd'),
    costBasis: text('cost_basis').$type<CostBasis>().notNull().default('unknown'),
    durationMs: bigint('duration_ms', { mode: 'number' }),
    retryCount: integer('retry_count').notNull().default(0),
    failed: boolean('failed').notNull().default(false),
    failureCode: text('failure_code'),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
    /** Set by the reporter, so a replayed worker report cannot double-count. */
    idempotencyKey: text('idempotency_key'),
  },
  (table) => [
    uniqueIndex('usage_records_idempotency_idx')
      .on(table.idempotencyKey)
      .where(sql`idempotency_key is not null`),
    index('usage_records_occurred_idx').on(table.occurredAt),
    index('usage_records_mission_idx').on(table.missionId),
    index('usage_records_task_idx').on(table.taskId),
    index('usage_records_project_idx').on(table.projectId),
    index('usage_records_model_idx').on(table.modelName),
  ],
);

/**
 * A limit.
 *
 * `kind` decides whether exceeding it warns or refuses. Enforcement lives at the dispatch
 * boundary — inside the atomic claim statement and again before the model call — never in the
 * interface, because a disabled button is not a permission system.
 */
export const budgets = pgTable(
  'budgets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    scope: text('scope').$type<BudgetScope>().notNull(),
    targetId: text('target_id'),
    targetLabel: text('target_label'),
    limitUsd: doublePrecision('limit_usd'),
    limitOutputTokens: bigint('limit_output_tokens', { mode: 'number' }),
    warnAtPercent: integer('warn_at_percent').notNull().default(80),
    kind: text('kind').$type<BudgetKind>().notNull().default('warning'),
    enabled: boolean('enabled').notNull().default(true),
    resetPeriod: text('reset_period').$type<'day' | 'month' | null>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('budgets_scope_target_idx')
      .on(table.scope, table.targetId)
      .where(sql`target_id is not null`),
    uniqueIndex('budgets_scope_global_idx')
      .on(table.scope)
      .where(sql`target_id is null`),
    index('budgets_enabled_idx').on(table.enabled),
  ],
);

/**
 * A deliberate, dated relaxation of a hard limit.
 *
 * Kept as its own row rather than by editing the budget, because "the limit was raised, by me, on
 * this date, for this reason" is the fact worth keeping. An expired override stops applying
 * without anyone having to remember to put the limit back.
 */
export const budgetOverrides = pgTable(
  'budget_overrides',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    budgetId: uuid('budget_id')
      .notNull()
      .references(() => budgets.id, { onDelete: 'cascade' }),
    reason: text('reason').notNull(),
    previousLimitUsd: doublePrecision('previous_limit_usd'),
    newLimitUsd: doublePrecision('new_limit_usd'),
    approvedBy: text('approved_by').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('budget_overrides_budget_idx').on(table.budgetId),
    index('budget_overrides_expires_idx').on(table.expiresAt),
  ],
);

/**
 * A price, so an estimate can exist at all.
 *
 * Owner-entered and clearly labelled as the basis for *estimates*. An unpriced model produces a
 * null cost rather than a zero one, which is why `estimateCostUsd` returns null instead of
 * guessing — a made-up price would turn "we don't know" into "it was cheap".
 */
export const modelPrices = pgTable(
  'model_prices',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    modelName: text('model_name').notNull(),
    providerName: text('provider_name'),
    inputPerMillionUsd: doublePrecision('input_per_million_usd').notNull(),
    outputPerMillionUsd: doublePrecision('output_per_million_usd').notNull(),
    cachedInputPerMillionUsd: doublePrecision('cached_input_per_million_usd'),
    note: text('note'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('model_prices_model_idx').on(table.modelName)],
);

/* --------------------------------------------------- Prompt 4: connectors */

/**
 * A connector's state, never its credential.
 *
 * There is no column that can hold a secret. `credential_configured` says one exists,
 * `credential_identity` holds a safe identity (a login, an app name, a token prefix), and
 * `credential_rotated_at` a date. What a connector may *do* is decided by its frozen manifest in
 * code — a row can enable a connector, but it cannot widen one.
 */
export const connectors = pgTable(
  'connectors',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    connectorId: text('connector_id').$type<ConnectorId>().notNull(),
    state: text('state').$type<ConnectorState>().notNull().default('disabled'),
    projectId: uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }),
    credentialConfigured: boolean('credential_configured').notNull().default(false),
    credentialIdentity: text('credential_identity'),
    credentialRotatedAt: timestamp('credential_rotated_at', { withTimezone: true }),
    lastSuccessAt: timestamp('last_success_at', { withTimezone: true }),
    lastFailureAt: timestamp('last_failure_at', { withTimezone: true }),
    lastFailureMessage: text('last_failure_message'),
    rateLimitedUntil: timestamp('rate_limited_until', { withTimezone: true }),
    enabledAt: timestamp('enabled_at', { withTimezone: true }),
    enabledBy: text('enabled_by'),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokedReason: text('revoked_reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('connectors_scoped_idx')
      .on(table.connectorId, table.projectId)
      .where(sql`project_id is not null`),
    uniqueIndex('connectors_global_idx')
      .on(table.connectorId)
      .where(sql`project_id is null`),
    index('connectors_state_idx').on(table.state),
  ],
);

/* ------------------------------------------------------ Prompt 4: safety */

/**
 * Inbound request counters.
 *
 * In the database rather than in process memory because a single-process rate limit is not a
 * rate limit in a system that can restart, and because the worker and the web process must share
 * one budget. `bucket_key` already includes the window, so an expired bucket is deleted by the
 * sweeper rather than reset in place.
 */
export const rateLimitBuckets = pgTable(
  'rate_limit_buckets',
  {
    bucketKey: text('bucket_key').notNull().primaryKey(),
    windowStartedAt: timestamp('window_started_at', { withTimezone: true }).notNull(),
    count: integer('count').notNull().default(0),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('rate_limit_buckets_window_idx').on(table.windowStartedAt)],
);

/**
 * The audit trail, hash-chained.
 *
 * `sequence` is a gapless serial and `hash` covers the row plus `previous_hash`, so removing or
 * editing an audit row breaks the chain at that point and `verifyAuditChain` can say where. This
 * is integrity, not secrecy: it does not stop someone with database access from rewriting
 * history, it stops them doing so *undetectably*.
 *
 * `detail` is deliberately small and redacted. An audit record needs to say what happened, not
 * to become a second copy of the private content the action touched.
 */
export const auditEvents = pgTable(
  'audit_events',
  {
    sequence: bigserial('sequence', { mode: 'number' }).primaryKey(),
    id: uuid('id').notNull().defaultRandom(),
    actor: text('actor').notNull(),
    actorKind: text('actor_kind').notNull(),
    action: text('action').notNull(),
    subjectKind: text('subject_kind'),
    subjectId: text('subject_id'),
    projectId: uuid('project_id').references(() => projects.id, { onDelete: 'set null' }),
    missionId: uuid('mission_id').references(() => missions.id, { onDelete: 'set null' }),
    outcome: text('outcome').$type<'allowed' | 'refused' | 'failed'>().notNull(),
    /** The rule id that decided it, when a rule did. */
    rule: text('rule'),
    summary: text('summary').notNull(),
    detail: jsonb('detail')
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    previousHash: text('previous_hash'),
    hash: text('hash').notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('audit_events_id_idx').on(table.id),
    /*
     * Two records cannot claim the same predecessor. The append path already serialises with an
     * advisory lock, so this index should never fire — which is exactly why it is worth having:
     * if the lock is ever removed or bypassed, a fork becomes a loud failure rather than a chain
     * that quietly verifies against only one of its two branches.
     */
    uniqueIndex('audit_events_previous_hash_idx')
      .on(table.previousHash)
      .where(sql`previous_hash is not null`),
    index('audit_events_occurred_idx').on(table.occurredAt),
    index('audit_events_action_idx').on(table.action),
    index('audit_events_actor_idx').on(table.actor),
  ],
);

/**
 * The record that something was deleted, without the thing.
 *
 * "Deleted private material must not remain retrievable" and "the audit trail should show that a
 * deletion occurred" are both true, and they are reconciled here: this row names the shape of
 * what went and every index it was purged from, and holds none of the content.
 */
export const deletionReceipts = pgTable(
  'deletion_receipts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    subjectKind: text('subject_kind').notNull(),
    subjectId: text('subject_id').notNull(),
    reason: text('reason').notNull(),
    itemCount: integer('item_count').notNull().default(1),
    requestedBy: text('requested_by').notNull(),
    /** Every place the content was removed from: chunks, search vectors, excerpts, exports. */
    scrubbedTargets: jsonb('scrubbed_targets')
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('deletion_receipts_subject_idx').on(table.subjectKind, table.subjectId),
    index('deletion_receipts_created_idx').on(table.createdAt),
  ],
);

/* --------------------------------------------------------------- relations */

export const missionRelations = relations(missions, ({ one, many }) => ({
  project: one(projects, { fields: [missions.projectId], references: [projects.id] }),
  worker: one(workers, { fields: [missions.claimedByWorkerId], references: [workers.id] }),
  plans: many(missionPlans),
  approvals: many(missionApprovals),
  clarifications: many(missionClarifications),
  runs: many(missionRuns),
  events: many(missionEvents),
  commands: many(missionCommands),
  permissionRequests: many(missionPermissionRequests),
  verifications: many(missionVerifications),
  artifacts: many(missionArtifacts),
}));

export const missionRunRelations = relations(missionRuns, ({ one, many }) => ({
  mission: one(missions, { fields: [missionRuns.missionId], references: [missions.id] }),
  worker: one(workers, { fields: [missionRuns.workerId], references: [workers.id] }),
  events: many(missionEvents),
}));

export const missionPlanRelations = relations(missionPlans, ({ one }) => ({
  mission: one(missions, { fields: [missionPlans.missionId], references: [missions.id] }),
}));

export const schema = {
  workers,
  missions,
  missionTaskGraphs,
  missionTasks,
  missionTaskDependencies,
  missionWriteLeases,
  missionReviews,
  missionReviewFindings,
  missionReceipts,
  playbooks,
  playbookVersions,
  ciDispatches,
  releaseApprovals,
  displayDevices,
  projectAppProfiles,
  missionPlans,
  missionApprovals,
  missionClarifications,
  missionRuns,
  missionEvents,
  missionCommands,
  missionPermissionRequests,
  missionVerifications,
  missionArtifacts,
  workerIdempotency,
  missionRelations,
  missionRunRelations,
  missionPlanRelations,
  sessions,
  oauthStates,
  projects,
  projectSources,
  goals,
  milestones,
  blockers,
  decisions,
  manualUpdates,
  nextActions,
  evidence,
  statusSnapshots,
  syncRuns,
  syncLocks,
  activityLog,
  appSettings,
  queryHistory,
  projectRelations,
  projectSourceRelations,
  evidenceRelations,
  qualificationRuns,
  qualificationCheckResults,
  qualificationSuiteResults,
  liveQualificationEvidence,
  knowledgeSources,
  knowledgeChunks,
  knowledgeItems,
  knowledgeConflicts,
  knowledgeRevisions,
  knowledgeBlocks,
  knowledgeEmbeddings,
  knowledgeIngestionJobs,
  answers,
  schedules,
  scheduleExecutions,
  briefings,
  notifications,
  notificationDeliveries,
  notificationPreferences,
  pushSubscriptions,
  voiceCaptures,
  usageRecords,
  budgets,
  budgetOverrides,
  modelPrices,
  connectors,
  rateLimitBuckets,
  auditEvents,
  deletionReceipts,
};
