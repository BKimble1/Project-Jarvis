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
}
