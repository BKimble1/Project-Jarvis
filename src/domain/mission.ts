import { z } from 'zod';
import type { ProvenanceLevel } from './enums';

/**
 * The mission model.
 *
 * A mission is one unit of work the owner asked for, from plain language through to a draft pull
 * request or a research report. Everything here is shared vocabulary: the control plane, the
 * worker runtime and the browser all compile against these types, so a protocol change that
 * breaks one side fails type-checking for all of them.
 */

/* ------------------------------------------------------------------- states */

/**
 * Mission states.
 *
 * The set is closed and the transitions between them are a table (see `mission-state.ts`), not a
 * convention — a string that is not in this list cannot be stored, and a move that is not in the
 * table is rejected with a conflict rather than silently applied.
 */
export const MISSION_STATES = [
  'draft',
  'resolving_project',
  'needs_clarification',
  'inspecting',
  'planning',
  'awaiting_plan_approval',
  'queued',
  'claimed',
  'preparing_workspace',
  'running',
  'waiting_for_permission',
  'waiting_for_input',
  'pausing',
  'paused',
  'resuming',
  'verifying',
  'creating_pull_request',
  'pull_request_ready',
  'completed',
  'failed',
  'stopping',
  'stopped',
  'cancelled',
] as const;
export type MissionState = (typeof MISSION_STATES)[number];

/** States in which a worker is (or should be) actively holding the mission. */
export const ACTIVE_MISSION_STATES = [
  'claimed',
  'preparing_workspace',
  'running',
  'waiting_for_permission',
  'waiting_for_input',
  'pausing',
  'resuming',
  'verifying',
  'creating_pull_request',
] as const satisfies readonly MissionState[];

/** States that will never change again without an explicit new owner action. */
export const TERMINAL_MISSION_STATES = [
  'completed',
  'cancelled',
] as const satisfies readonly MissionState[];

/** Finished, but an owner may start a new attempt from here. */
export const RETRYABLE_MISSION_STATES = [
  'failed',
  'stopped',
] as const satisfies readonly MissionState[];

/** States where Jarvis is waiting on the owner rather than on itself. */
export const OWNER_BLOCKED_MISSION_STATES = [
  'needs_clarification',
  'awaiting_plan_approval',
  'waiting_for_permission',
  'waiting_for_input',
] as const satisfies readonly MissionState[];

export function isActiveMissionState(state: MissionState): boolean {
  return (ACTIVE_MISSION_STATES as readonly MissionState[]).includes(state);
}

export function isTerminalMissionState(state: MissionState): boolean {
  return (TERMINAL_MISSION_STATES as readonly MissionState[]).includes(state);
}

/* -------------------------------------------------------------------- types */

export const MISSION_TYPES = [
  'code_change',
  'bug_fix',
  'test_improvement',
  'documentation',
  'repository_maintenance',
  'investigation',
  'project_review',
  'research_report',
  'planning_only',
  'manual_task',
] as const;
export type MissionType = (typeof MISSION_TYPES)[number];

/** Mission types that never touch a repository's contents. */
export const READ_ONLY_MISSION_TYPES = [
  'investigation',
  'project_review',
  'research_report',
  'planning_only',
] as const satisfies readonly MissionType[];

export function isReadOnlyMissionType(type: MissionType): boolean {
  return (READ_ONLY_MISSION_TYPES as readonly MissionType[]).includes(type);
}

export const MISSION_RISK_LEVELS = ['read_only', 'low', 'moderate', 'high', 'prohibited'] as const;
export type MissionRiskLevel = (typeof MISSION_RISK_LEVELS)[number];

export const MISSION_RISK_RANK: Record<MissionRiskLevel, number> = {
  read_only: 0,
  low: 1,
  moderate: 2,
  high: 3,
  prohibited: 4,
};

export const MISSION_PRIORITIES = ['critical', 'high', 'medium', 'low'] as const;
export type MissionPriority = (typeof MISSION_PRIORITIES)[number];

/** Why a mission ended badly. Deliberately coarse: it drives what Jarvis recommends next. */
export const MISSION_FAILURE_CODES = [
  'agent_error',
  'agent_unavailable',
  'workspace_error',
  'git_error',
  'github_auth_error',
  'github_rate_limited',
  'github_error',
  'verification_failed',
  'policy_violation',
  'plan_superseded',
  'worker_lost',
  'timeout',
  'cancelled_by_owner',
  'unknown',
] as const;
export type MissionFailureCode = (typeof MISSION_FAILURE_CODES)[number];

/* ---------------------------------------------------------------- the model */

export interface Mission {
  readonly id: string;
  readonly projectId: string | null;
  readonly ownerLogin: string | null;
  /** Exactly what the owner typed, kept verbatim for audit. */
  readonly rawRequest: string;
  readonly title: string;
  readonly description: string | null;
  readonly type: MissionType;
  readonly riskLevel: MissionRiskLevel;
  /** Rule ids from `classifyMissionRisk`, so the level is always explainable. */
  readonly riskRuleIds: readonly string[];
  readonly riskReasons: readonly string[];
  readonly state: MissionState;
  readonly priority: MissionPriority;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly targetDate: string | null;

  readonly sourceId: string | null;
  readonly repositoryOwner: string | null;
  readonly repositoryName: string | null;
  readonly baseBranch: string | null;
  readonly workingBranch: string | null;
  readonly baseSha: string | null;
  readonly pullRequestUrl: string | null;
  readonly pullRequestNumber: number | null;

  readonly activeRunId: string | null;
  readonly claimedByWorkerId: string | null;
  readonly attemptCount: number;
  readonly currentPlanVersion: number | null;
  readonly approvedPlanVersion: number | null;

  /** Set only by an explicit owner override, so a paused project cannot execute by accident. */
  readonly executionOverrideAt: string | null;
  readonly executionOverrideReason: string | null;

  readonly constraints: readonly string[];
  readonly doNotTouch: readonly string[];
  readonly deliverable: string | null;
  readonly acceptanceCriteria: readonly string[];

  readonly cancellationReason: string | null;
  readonly completionSummary: string | null;
  readonly failureCode: MissionFailureCode | null;
  readonly failureMessage: string | null;
  readonly evidenceIds: readonly string[];
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly lastActivityAt: string | null;
}

/* ------------------------------------------------------------------ schemas */

/** Bounded everywhere: a mission is owner-typed text and must never be an unbounded body. */
export const missionTitleSchema = z.string().trim().min(3).max(160);
export const missionTextSchema = z.string().trim().min(1).max(4000);
const shortListSchema = z.array(z.string().trim().min(1).max(400)).max(20);

export const missionDraftSchema = z.object({
  rawRequest: missionTextSchema,
  projectId: z.string().uuid().nullish(),
  title: missionTitleSchema.optional(),
  description: z.string().trim().max(4000).nullish(),
  type: z.enum(MISSION_TYPES).optional(),
  priority: z.enum(MISSION_PRIORITIES).default('medium'),
  targetDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD.')
    .nullish(),
  sourceId: z.string().uuid().nullish(),
  constraints: shortListSchema.default([]),
  doNotTouch: shortListSchema.default([]),
  deliverable: z.string().trim().max(600).nullish(),
  acceptanceCriteria: shortListSchema.default([]),
});
export type MissionDraftInput = z.infer<typeof missionDraftSchema>;

export const missionUpdateSchema = z
  .object({
    title: missionTitleSchema,
    description: z.string().trim().max(4000).nullable(),
    type: z.enum(MISSION_TYPES),
    priority: z.enum(MISSION_PRIORITIES),
    projectId: z.string().uuid().nullable(),
    sourceId: z.string().uuid().nullable(),
    targetDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .nullable(),
    constraints: shortListSchema,
    doNotTouch: shortListSchema,
    deliverable: z.string().trim().max(600).nullable(),
    acceptanceCriteria: shortListSchema,
  })
  .partial();
export type MissionUpdateInput = z.infer<typeof missionUpdateSchema>;

/* ------------------------------------------------------------ clarification */

export const CLARIFICATION_TOPICS = [
  'project',
  'outcome',
  'deliverable',
  'acceptance',
  'constraints',
  'do_not_touch',
  'mode',
  'repository',
  'platform',
  'design_decision',
] as const;
export type ClarificationTopic = (typeof CLARIFICATION_TOPICS)[number];

export interface ClarificationQuestion {
  readonly id: string;
  readonly topic: ClarificationTopic;
  readonly question: string;
  /** Why this question materially affects implementation, safety or acceptance. */
  readonly why: string;
  readonly options: readonly string[];
  /** What Jarvis would assume if asked to decide. Recorded as an assumption, never a decision. */
  readonly recommendation: string | null;
  readonly rule: string;
}

export interface ClarificationRecord extends ClarificationQuestion {
  readonly missionId: string;
  readonly answer: string | null;
  /** `manual` when the owner answered; `inferred` when they asked Jarvis to recommend. */
  readonly answerProvenance: ProvenanceLevel | null;
  readonly askedAt: string;
  readonly answeredAt: string | null;
}

export const clarificationAnswerSchema = z.object({
  questionId: z.string().min(1).max(64),
  answer: z.string().trim().min(1).max(2000).optional(),
  /** Ask Jarvis to apply its own recommendation, recorded as an assumption. */
  acceptRecommendation: z.boolean().default(false),
});
export type ClarificationAnswerInput = z.infer<typeof clarificationAnswerSchema>;

/* ------------------------------------------------------------------- views */

/** Everything the mission list needs, denormalised once on the server. */
export interface MissionSummary {
  readonly mission: Mission;
  readonly projectName: string | null;
  readonly workerName: string | null;
  readonly openPermissionRequests: number;
  readonly openClarifications: number;
  readonly planVersion: number | null;
  readonly planApproved: boolean;
}

export const MISSION_STATE_LABELS: Record<MissionState, string> = {
  draft: 'Draft',
  resolving_project: 'Choosing project',
  needs_clarification: 'Needs clarification',
  inspecting: 'Inspecting',
  planning: 'Planning',
  awaiting_plan_approval: 'Awaiting approval',
  queued: 'Queued',
  claimed: 'Claimed',
  preparing_workspace: 'Preparing workspace',
  running: 'Running',
  waiting_for_permission: 'Waiting for permission',
  waiting_for_input: 'Waiting for input',
  pausing: 'Pausing',
  paused: 'Paused',
  resuming: 'Resuming',
  verifying: 'Verifying',
  creating_pull_request: 'Creating pull request',
  pull_request_ready: 'Draft PR ready',
  completed: 'Completed',
  failed: 'Failed',
  stopping: 'Stopping',
  stopped: 'Stopped',
  cancelled: 'Cancelled',
};

export const MISSION_TYPE_LABELS: Record<MissionType, string> = {
  code_change: 'Code change',
  bug_fix: 'Bug fix',
  test_improvement: 'Tests',
  documentation: 'Documentation',
  repository_maintenance: 'Maintenance',
  investigation: 'Investigation',
  project_review: 'Project review',
  research_report: 'Research',
  planning_only: 'Planning only',
  manual_task: 'Manual task',
};

export const MISSION_RISK_LABELS: Record<MissionRiskLevel, string> = {
  read_only: 'Read-only',
  low: 'Low risk',
  moderate: 'Moderate risk',
  high: 'High risk',
  prohibited: 'Prohibited',
};

export const MISSION_FAILURE_LABELS: Record<MissionFailureCode, string> = {
  agent_error: 'The agent reported an error',
  agent_unavailable: 'The Claude runtime was unavailable',
  workspace_error: 'The workspace could not be prepared',
  git_error: 'A git operation failed',
  github_auth_error: 'GitHub rejected the worker credential',
  github_rate_limited: 'GitHub rate-limited the worker',
  github_error: 'GitHub returned an error',
  verification_failed: 'Verification failed',
  policy_violation: 'The run attempted something Jarvis does not allow',
  plan_superseded: 'The approved plan was superseded',
  worker_lost: 'The worker stopped reporting',
  timeout: 'The run exceeded its time limit',
  cancelled_by_owner: 'You cancelled it',
  unknown: 'The cause was not recorded',
};

/**
 * Portfolio-level mission counts.
 *
 * `running` and `stalled` are deliberately separate: a mission whose worker has stopped reporting
 * is not something Jarvis can honestly describe as progressing.
 */
export interface MissionCounts {
  readonly total: number;
  readonly running: number;
  readonly queued: number;
  readonly awaitingApproval: number;
  readonly needsClarification: number;
  readonly needsPermission: number;
  readonly paused: number;
  readonly prReady: number;
  readonly failed: number;
  readonly stopped: number;
  readonly stalled: number;
}
