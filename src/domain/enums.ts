/**
 * Domain enumerations.
 *
 * Every enum is declared once, as a readonly tuple, so it can drive:
 *  - the Drizzle/Postgres column type,
 *  - the Zod runtime validator,
 *  - the TypeScript union,
 *  - and the UI label maps,
 * without any of them drifting apart.
 */

export const PROJECT_TYPES = [
  'software',
  'ios_app',
  'website',
  'business',
  'product_idea',
  'research',
  'school',
  'career',
  'engineering',
  'document',
  'personal',
  'other',
] as const;
export type ProjectType = (typeof PROJECT_TYPES)[number];

export const PROJECT_STATUSES = [
  'active',
  'waiting',
  'blocked',
  'paused',
  'completed',
  'archived',
  'unknown',
] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

export const PROJECT_PRIORITIES = ['critical', 'high', 'medium', 'low'] as const;
export type ProjectPriority = (typeof PROJECT_PRIORITIES)[number];

/**
 * Source kinds. Phase 1 implements `github_repo`, `manual` and `external_link`.
 * The enum is intentionally open so later phases can add providers without a data migration
 * of existing rows (only an enum value addition).
 */
export const SOURCE_KINDS = ['github_repo', 'manual', 'external_link'] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

export const SYNC_STATUSES = ['never', 'ok', 'partial', 'failed', 'running'] as const;
export type SyncStatus = (typeof SYNC_STATUSES)[number];

/**
 * How much a displayed claim can be trusted. This is the backbone of the whole product:
 * nothing is rendered without one of these four labels.
 */
export const PROVENANCE_LEVELS = ['verified', 'manual', 'inferred', 'unknown'] as const;
export type ProvenanceLevel = (typeof PROVENANCE_LEVELS)[number];

export const EVIDENCE_KINDS = [
  'git_commit',
  'pull_request',
  'issue',
  'workflow_run',
  'check_result',
  'release',
  'deployment',
  'repo_metadata',
  'manual_update',
  'goal',
  'milestone',
  'blocker',
  'decision',
  'next_action',
  'sync_run',
] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

export const SOURCE_SYSTEMS = ['github', 'manual', 'jarvis', 'external'] as const;
export type SourceSystem = (typeof SOURCE_SYSTEMS)[number];

export const GOAL_STATUSES = ['open', 'achieved', 'abandoned'] as const;
export type GoalStatus = (typeof GOAL_STATUSES)[number];

export const MILESTONE_STATES = ['planned', 'in_progress', 'done', 'cancelled'] as const;
export type MilestoneState = (typeof MILESTONE_STATES)[number];

export const BLOCKER_SEVERITIES = ['critical', 'high', 'medium', 'low'] as const;
export type BlockerSeverity = (typeof BLOCKER_SEVERITIES)[number];

export const NEXT_ACTION_STATUSES = ['open', 'in_progress', 'done', 'dropped'] as const;
export type NextActionStatus = (typeof NEXT_ACTION_STATUSES)[number];

export const NEXT_ACTION_PRIORITIES = ['critical', 'high', 'medium', 'low'] as const;
export type NextActionPriority = (typeof NEXT_ACTION_PRIORITIES)[number];

/** How a status snapshot's narrative was produced. Recorded on every snapshot. */
export const SUMMARY_METHODS = ['deterministic', 'ai_narrated', 'ai_failed_fallback'] as const;
export type SummaryMethod = (typeof SUMMARY_METHODS)[number];

/**
 * Freshness of the evidence behind a project's status.
 *  - `live`    : synchronised (or manually updated) very recently.
 *  - `recent`  : within the normal working window.
 *  - `stale`   : older than the staleness threshold for its type.
 *  - `failing` : the last synchronisation attempt failed; displayed data is last-known-good.
 *  - `never`   : nothing has ever been observed.
 */
export const FRESHNESS_STATES = ['live', 'recent', 'stale', 'failing', 'never'] as const;
export type FreshnessState = (typeof FRESHNESS_STATES)[number];

export const ACTIVITY_KINDS = [
  'project_created',
  'project_updated',
  'goal_changed',
  'status_changed',
  'phase_changed',
  'blocker_added',
  'blocker_resolved',
  'decision_recorded',
  'milestone_changed',
  'next_action_changed',
  'update_recorded',
  'source_added',
  'source_removed',
  'sync_started',
  'sync_completed',
  'sync_failed',
  'briefing_generated',
  'project_archived',
  'project_restored',
  'data_exported',
  'data_retention_applied',
] as const;
export type ActivityKind = (typeof ACTIVITY_KINDS)[number];

/** Data categories a source may or may not expose, depending on credential scope. */
export const SOURCE_CAPABILITIES = [
  'metadata',
  'commits',
  'pull_requests',
  'issues',
  'workflow_runs',
  'checks',
  'releases',
  'deployments',
] as const;
export type SourceCapability = (typeof SOURCE_CAPABILITIES)[number];

export const DEFAULT_PROJECT_PHASES = [
  'Idea',
  'Research',
  'Planning',
  'Design',
  'Build',
  'Testing',
  'Review',
  'Launch',
  'Operating',
  'Wrapping up',
] as const;
