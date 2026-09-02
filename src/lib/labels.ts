import type {
  ActivityKind,
  FreshnessState,
  ProjectPriority,
  ProjectStatus,
  ProjectType,
  ProvenanceLevel,
} from '@/domain/enums';

/** Human labels for enum values. Kept out of components so wording stays consistent. */

export const PROJECT_TYPE_LABELS: Record<ProjectType, string> = {
  software: 'Software',
  ios_app: 'iOS app',
  website: 'Website',
  business: 'Business',
  product_idea: 'Product idea',
  research: 'Research',
  school: 'School',
  career: 'Career',
  engineering: 'Engineering',
  document: 'Document',
  personal: 'Personal',
  other: 'Other',
};

export const PROJECT_STATUS_LABELS: Record<ProjectStatus, string> = {
  active: 'Active',
  waiting: 'Waiting',
  blocked: 'Blocked',
  paused: 'Paused',
  completed: 'Completed',
  archived: 'Archived',
  unknown: 'Unknown',
};

export const PRIORITY_LABELS: Record<ProjectPriority, string> = {
  critical: 'Critical',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
};

export const FRESHNESS_LABELS: Record<FreshnessState, string> = {
  live: 'Live',
  recent: 'Recent',
  stale: 'Stale',
  failing: 'Sync failing',
  never: 'No data',
};

export const PROVENANCE_LABELS: Record<ProvenanceLevel, string> = {
  verified: 'Verified',
  manual: 'Manual',
  inferred: 'Inferred',
  unknown: 'Unknown',
};

export const PROVENANCE_EXPLANATIONS: Record<ProvenanceLevel, string> = {
  verified: 'Observed directly from a connected source.',
  manual: 'Entered by you. Jarvis has not verified it elsewhere.',
  inferred: 'Derived from the available evidence, not stated by any source.',
  unknown: 'There is not enough evidence to say.',
};

export const ACTIVITY_LABELS: Record<ActivityKind, string> = {
  project_created: 'Project created',
  project_updated: 'Project updated',
  goal_changed: 'Goal changed',
  status_changed: 'Status changed',
  phase_changed: 'Phase changed',
  blocker_added: 'Blocker added',
  blocker_resolved: 'Blocker resolved',
  decision_recorded: 'Decision recorded',
  milestone_changed: 'Milestone changed',
  next_action_changed: 'Next action changed',
  update_recorded: 'Update recorded',
  source_added: 'Source added',
  source_removed: 'Source removed',
  sync_started: 'Sync started',
  sync_completed: 'Sync completed',
  sync_failed: 'Sync failed',
  briefing_generated: 'Briefing generated',
  project_archived: 'Project archived',
  project_restored: 'Project restored',
  data_exported: 'Data exported',
  data_retention_applied: 'Retention applied',
};

/** Project types that never show repository panels. */
export const CODE_PROJECT_TYPES = new Set<ProjectType>([
  'software',
  'ios_app',
  'website',
  'engineering',
]);
