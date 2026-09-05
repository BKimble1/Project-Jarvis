import type { ProvenanceLevel } from './enums';

/**
 * The shape of an answer from the Jarvis command bar.
 *
 * It lives in `domain` rather than in the router so presentational components can type against
 * it without importing a server module.
 */

export const QUERY_INTENTS = [
  'portfolio_status',
  'project_status',
  'portfolio_changes',
  'project_changes',
  'needs_attention',
  'blocked_projects',
  'stale_projects',
  'focus',
  'list_active',
  'list_waiting',
  'list_paused',
  'list_in_progress',
  'execution_request',
  /* Mission Control (Prompt 2). */
  'missions_running',
  'missions_needing_me',
  'plans_awaiting_approval',
  'pull_requests_ready',
  'missions_failed',
  'missions_finished_today',
  'mission_detail',
  'mission_command',
  'prohibited_request',
  'unsupported',
] as const;
export type QueryIntent = (typeof QUERY_INTENTS)[number];

export interface AnswerItem {
  readonly text: string;
  readonly provenance: ProvenanceLevel;
  readonly projectId?: string;
  readonly href?: string;
  readonly evidenceIds?: readonly string[];
}

export interface AnswerSection {
  readonly label: string;
  readonly items: readonly AnswerItem[];
  readonly emptyText?: string;
}

/**
 * What Jarvis understood from a request that looks like work.
 *
 * Returned instead of starting anything: the owner sees the reading before a mission exists, and
 * confirms it themselves. Answering a question must never create state.
 */
export interface MissionPreview {
  readonly understanding: string;
  readonly missionType: string;
  readonly missionTypeLabel: string;
  readonly riskLevel: string;
  readonly riskLevelLabel: string;
  readonly riskReasons: readonly string[];
  readonly projectId: string | null;
  readonly projectName: string | null;
  /** Present when the project name matched more than one project. */
  readonly projectChoices: readonly { readonly id: string; readonly name: string }[];
  readonly rawRequest: string;
  readonly title: string;
  readonly notice: string | null;
  readonly canStart: boolean;
}

export interface QueryAnswer {
  readonly intent: QueryIntent;
  readonly title: string;
  readonly summary: string;
  readonly summaryProvenance: ProvenanceLevel;
  readonly sections: readonly AnswerSection[];
  readonly projectIds: readonly string[];
  /** Present when the project name matched more than one project. */
  readonly disambiguation: readonly { readonly id: string; readonly name: string }[] | null;
  /** Present for requests Jarvis understands but cannot perform in this phase. */
  readonly notice: string | null;
  readonly href: string | null;
  /** Present when the request reads as work: what Jarvis understood, before anything is created. */
  readonly missionPreview?: MissionPreview | null;
}
