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
  boolean,
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

export const schema = {
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
