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
  boolean,
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

const now = () => timestamp('placeholder', { withTimezone: true });
void now; // documentation helper; each column declares its own name below.

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
};
