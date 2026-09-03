import { z } from 'zod';
import { ConflictError } from './errors';
import { AGENT_ROLES, PERMISSION_PROFILE_IDS, type AgentRole } from './agent-role';
import { MISSION_FAILURE_CODES } from './mission';

/**
 * One task in a mission's task graph.
 *
 * A mission used to be a single unit of work. In Prompt 3 it is a small, acyclic graph of tasks,
 * each with its own role, its own permission profile, its own workspace and its own state
 * machine. The mission state still exists and still means what it meant; the task states below
 * describe the individual agents underneath it.
 *
 * As with mission states, the set is closed and the moves between them are a table rather than a
 * convention. That is what makes "a task cannot reach `succeeded` without passing review" a
 * property of the system rather than of whichever code happened to call it.
 */

/* ------------------------------------------------------------------- states */

export const TASK_STATES = [
  /** In a proposed graph the owner has not approved yet. */
  'draft',
  /** Approved, but something it depends on has not finished. */
  'blocked',
  /** Every dependency is satisfied. A worker may claim it. */
  'ready',
  'claimed',
  'preparing',
  'running',
  'waiting_for_input',
  'waiting_for_permission',
  'pausing',
  'paused',
  /** Running the repository's own checks. Always before review, never after. */
  'verifying',
  /** Waiting for an independent reviewer that has not seen how the work was done. */
  'awaiting_review',
  /** A review found something blocking and a repair round is available. */
  'repair_required',
  /** Merging finished task branches into the mission integration branch. */
  'integrating',
  'succeeded',
  'failed',
  'stopped',
  'cancelled',
  /** Deliberately not run: the owner removed it, or a condition made it unnecessary. */
  'skipped',
] as const;
export type TaskState = (typeof TASK_STATES)[number];

/** States in which a worker is (or should be) actively holding the task. */
export const ACTIVE_TASK_STATES = [
  'claimed',
  'preparing',
  'running',
  'waiting_for_input',
  'waiting_for_permission',
  'pausing',
  'verifying',
  'integrating',
] as const satisfies readonly TaskState[];

/** Nothing will happen to these again without a new owner action. */
export const TERMINAL_TASK_STATES = [
  'succeeded',
  'failed',
  'stopped',
  'cancelled',
  'skipped',
] as const satisfies readonly TaskState[];

/** Waiting on the owner rather than on Jarvis. */
export const OWNER_BLOCKED_TASK_STATES = [
  'waiting_for_input',
  'waiting_for_permission',
] as const satisfies readonly TaskState[];

/** Counted against the "how many agents are running" ceilings. */
export const CAPACITY_TASK_STATES = [
  'claimed',
  'preparing',
  'running',
  'waiting_for_permission',
  'waiting_for_input',
  'pausing',
  'verifying',
  'integrating',
] as const satisfies readonly TaskState[];

export function isActiveTaskState(state: TaskState): boolean {
  return (ACTIVE_TASK_STATES as readonly TaskState[]).includes(state);
}

export function isTerminalTaskState(state: TaskState): boolean {
  return (TERMINAL_TASK_STATES as readonly TaskState[]).includes(state);
}

/** A dependency is satisfied when it finished well — or was deliberately not needed. */
export function satisfiesDependency(state: TaskState): boolean {
  return state === 'succeeded' || state === 'skipped';
}

/** A dependency can never be satisfied from here, so anything waiting on it is stuck. */
export function dependencyIsUnreachable(state: TaskState): boolean {
  return state === 'failed' || state === 'stopped' || state === 'cancelled';
}

/* -------------------------------------------------------------------- types */

export const TASK_TYPES = [
  'research',
  'investigation',
  'implementation',
  'test_authoring',
  'verification',
  'review',
  'security_review',
  'ux_review',
  'release_verification',
  'repair',
  'integration',
  /** Pushing the integration branch and opening the draft pull request. Deterministic. */
  'delivery',
  'synthesis',
  'report',
  'ci_dispatch',
] as const;
export type TaskType = (typeof TASK_TYPES)[number];

export const TASK_TYPE_LABELS: Record<TaskType, string> = {
  research: 'Research',
  investigation: 'Investigation',
  implementation: 'Implementation',
  test_authoring: 'Tests',
  verification: 'Verification',
  review: 'Review',
  security_review: 'Security review',
  ux_review: 'UI/UX review',
  release_verification: 'Release verification',
  repair: 'Repair',
  integration: 'Integration',
  delivery: 'Delivery',
  synthesis: 'Synthesis',
  report: 'Report',
  ci_dispatch: 'CI dispatch',
};

export const TASK_STATE_LABELS: Record<TaskState, string> = {
  draft: 'Proposed',
  blocked: 'Blocked',
  ready: 'Ready',
  claimed: 'Claimed',
  preparing: 'Preparing',
  running: 'Running',
  waiting_for_input: 'Waiting for input',
  waiting_for_permission: 'Waiting for permission',
  pausing: 'Pausing',
  paused: 'Paused',
  verifying: 'Verifying',
  awaiting_review: 'Awaiting review',
  repair_required: 'Repair required',
  integrating: 'Integrating',
  succeeded: 'Succeeded',
  failed: 'Failed',
  stopped: 'Stopped',
  cancelled: 'Cancelled',
  skipped: 'Skipped',
};

/** What a task needs before it can start. */
export const WORKSPACE_REQUIREMENTS = [
  /** No checkout at all: coordination, synthesis, report writing. */
  'none',
  /** Its own read-only clone. Several of these may exist at once. */
  'readonly_clone',
  /** Its own writable clone and its own task branch. */
  'task_workspace',
  /** The mission integration branch. Only ever one at a time, held by the integrator. */
  'integration',
] as const;
export type WorkspaceRequirement = (typeof WORKSPACE_REQUIREMENTS)[number];

export const TASK_FAILURE_CODES = [
  ...MISSION_FAILURE_CODES,
  /** The agent changed a file outside the write set the owner approved. */
  'write_scope_violation',
  /** Two tasks wanted the same files and could not be safely serialised. */
  'write_lease_conflict',
  /** Task branches could not be merged without discarding someone's work. */
  'integration_conflict',
  /** A dependency ended in a state it can never recover from. */
  'dependency_failed',
  /** Review returned blocking findings and every repair round was used. */
  'review_blocked',
  /** Repair rounds exhausted. */
  'repair_limit_reached',
  /** A configured usage, runtime or attempt ceiling stopped it. */
  'limit_reached',
  /** Capacity was withdrawn — drain mode, or an emergency stop. */
  'capacity_withdrawn',
] as const;
export type TaskFailureCode = (typeof TASK_FAILURE_CODES)[number];

export const TASK_FAILURE_LABELS: Partial<Record<TaskFailureCode, string>> = {
  write_scope_violation: 'The agent changed files outside the approved write set',
  write_lease_conflict: 'Another task holds a write lease over the same files',
  integration_conflict: 'The task branch could not be merged cleanly',
  dependency_failed: 'Something this task depends on did not finish',
  review_blocked: 'Review blocked delivery',
  repair_limit_reached: 'The repair limit was reached',
  limit_reached: 'A configured limit stopped it',
  capacity_withdrawn: 'Capacity was withdrawn before it could finish',
};

export function isTaskFailureCode(value: string): value is TaskFailureCode {
  return (TASK_FAILURE_CODES as readonly string[]).includes(value);
}

/* ---------------------------------------------------------------- the model */

export interface TaskUsage {
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly totalCostUsd: number | null;
  readonly turns: number | null;
  readonly durationMs: number | null;
}

export interface MissionTask {
  readonly id: string;
  readonly missionId: string;
  readonly graphId: string;
  readonly graphVersion: number;
  readonly planVersion: number;
  /** Stable within a graph: `t1`, `t2`… Used in branch names and in the owner-facing graph. */
  readonly key: string;
  readonly title: string;
  readonly description: string;
  readonly role: AgentRole;
  /** Names a profile; never defines one. Resolution happens in `agent-role.ts`. */
  readonly permissionProfileId: string;
  readonly taskType: TaskType;
  readonly state: TaskState;
  readonly position: number;

  readonly dependsOn: readonly string[];
  readonly expectedInputs: readonly string[];
  readonly expectedOutputs: readonly string[];
  readonly acceptanceCriteria: readonly string[];

  readonly workspaceRequirement: WorkspaceRequirement;
  readonly requiresRepository: boolean;
  /** Human-readable areas, shown to the owner in the graph. */
  readonly expectedFileAreas: readonly string[];
  /** Machine-checked path prefixes. The lease and the scope check both use this. */
  readonly declaredWriteSet: readonly string[];
  readonly actualChangedFiles: readonly string[];

  readonly assignedWorkerId: string | null;
  readonly activeRunId: string | null;
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly maxTurns: number | null;
  readonly timeLimitMs: number | null;
  readonly maxOutputTokens: number | null;
  readonly usage: TaskUsage;

  /** For a review task: the task whose work it reviews. */
  readonly reviewsTaskId: string | null;
  /** 0 for the first pass; 1 and 2 for repair rounds. */
  readonly repairRound: number;
  /** Set on a review task when its verdict is recorded. */
  readonly latestReviewId: string | null;

  readonly branchName: string | null;
  readonly baseSha: string | null;
  readonly headSha: string | null;
  readonly workspacePath: string | null;
  readonly workspacePreserved: boolean;

  readonly failureCode: TaskFailureCode | null;
  readonly failureMessage: string | null;
  readonly summary: string | null;

  readonly createdAt: string;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly lastActivityAt: string | null;
}

/* --------------------------------------------------------- the state machine */

export type TaskActor = 'owner' | 'worker' | 'system';

export interface TaskTransition {
  readonly from: TaskState;
  readonly to: TaskState;
  readonly actors: readonly TaskActor[];
  readonly summary: string;
}

const T = (
  from: TaskState,
  to: TaskState,
  actors: readonly TaskActor[],
  summary: string,
): TaskTransition => ({ from, to, actors, summary });

/**
 * Every move a task may make.
 *
 * Two absences are deliberate and load-bearing:
 *
 *  - There is no `running → succeeded` for a task that owes verification and review. A builder
 *    reaches `succeeded` only through `verifying` and `awaiting_review`, so "the agent said it
 *    was done" can never be the thing that finishes it.
 *  - There is no `failed → running` or `stopped → running`. A finished task restarts only as a
 *    new attempt the owner asked for, which returns it to `ready` with the attempt incremented.
 */
export const TASK_TRANSITIONS: readonly TaskTransition[] = [
  /* Approval turns a proposed graph into a live one. */
  T('draft', 'blocked', ['system'], 'Waiting on a dependency'),
  T('draft', 'ready', ['system'], 'Ready to start'),
  T('draft', 'skipped', ['owner', 'system'], 'Not needed'),
  T('draft', 'cancelled', ['owner'], 'Removed before it started'),

  T('blocked', 'ready', ['system'], 'Its dependencies finished'),
  T('blocked', 'blocked', ['system'], 'Still waiting'),
  T('blocked', 'skipped', ['owner', 'system'], 'Not needed'),
  T('blocked', 'cancelled', ['owner'], 'Cancelled while blocked'),
  T('blocked', 'failed', ['system'], 'Something it depends on did not finish'),

  T('ready', 'claimed', ['worker'], 'Claimed by a worker'),
  T('ready', 'blocked', ['system'], 'A graph revision added a dependency'),
  T('ready', 'skipped', ['owner', 'system'], 'Not needed'),
  T('ready', 'cancelled', ['owner'], 'Cancelled before it started'),
  T('ready', 'failed', ['system'], 'Could not be started'),

  T('claimed', 'preparing', ['worker'], 'Preparing its workspace'),
  T('claimed', 'ready', ['system'], 'Released back to the queue'),
  T('claimed', 'failed', ['worker', 'system'], 'Failed after claiming'),
  T('claimed', 'stopped', ['worker', 'system'], 'Stopped before it started'),

  T('preparing', 'running', ['worker'], 'Workspace ready; agent started'),
  T('preparing', 'integrating', ['worker'], 'Workspace ready; merging'),
  /* A verifier has no agent to start: its workspace is ready and the checks begin. */
  T('preparing', 'verifying', ['worker'], "Workspace ready; running the repository's checks"),
  T('preparing', 'failed', ['worker', 'system'], 'Workspace preparation failed'),
  T('preparing', 'stopped', ['worker', 'system'], 'Stopped while preparing'),

  T('running', 'waiting_for_permission', ['worker'], 'The agent asked for permission'),
  T('running', 'waiting_for_input', ['worker'], 'The agent asked a question'),
  T('running', 'pausing', ['owner'], 'Pause requested'),
  T('running', 'verifying', ['worker'], 'Running verification'),
  T('running', 'awaiting_review', ['worker', 'system'], 'Ready for independent review'),
  T('running', 'integrating', ['worker'], 'Merging task branches'),
  /* Only a task that owes neither verification nor review may finish straight from running. */
  T('running', 'succeeded', ['worker', 'system'], 'Finished'),
  T('running', 'failed', ['worker', 'system'], 'Failed'),
  T('running', 'stopped', ['worker', 'system'], 'Stopped'),

  T('waiting_for_permission', 'running', ['owner', 'worker'], 'Permission decided'),
  T('waiting_for_permission', 'pausing', ['owner'], 'Pause requested'),
  T('waiting_for_permission', 'failed', ['worker', 'system'], 'Failed while waiting'),
  T('waiting_for_permission', 'stopped', ['worker', 'system'], 'Stopped while waiting'),
  T('waiting_for_input', 'running', ['owner', 'worker'], 'Question answered'),
  T('waiting_for_input', 'pausing', ['owner'], 'Pause requested'),
  T('waiting_for_input', 'failed', ['worker', 'system'], 'Failed while waiting'),
  T('waiting_for_input', 'stopped', ['worker', 'system'], 'Stopped while waiting'),

  T('pausing', 'paused', ['worker'], 'Paused at a safe point'),
  T('pausing', 'running', ['worker'], 'The pause was cancelled'),
  T('pausing', 'failed', ['worker', 'system'], 'Failed while pausing'),
  T('pausing', 'stopped', ['worker', 'system'], 'Stopped while pausing'),
  T('paused', 'running', ['worker'], 'Resumed'),
  T('paused', 'stopped', ['worker', 'system'], 'Stopped while paused'),
  T('paused', 'cancelled', ['owner'], 'Cancelled while paused'),
  T('paused', 'failed', ['worker', 'system'], 'Failed while paused'),

  T('verifying', 'awaiting_review', ['worker', 'system'], 'Verification finished'),
  T('verifying', 'repair_required', ['system'], 'Verification failed; repair available'),
  /*
   * The worker may close its own verification task, because "the checks ran" is a fact it
   * observed and not a judgement about them. What the results *mean* is decided elsewhere: the
   * outcomes are recorded through a separate route from real exit codes, `decideVerdict` refuses
   * an approval standing on a failed required check, and nothing here can turn a failure into a
   * pass. The system keeps the transition too, for a mission it closes out itself.
   */
  T('verifying', 'succeeded', ['worker', 'system'], 'Verification finished; nothing to review'),
  T('verifying', 'failed', ['worker', 'system'], 'Verification failed'),
  T('verifying', 'stopped', ['worker', 'system'], 'Stopped during verification'),

  T('awaiting_review', 'succeeded', ['system'], 'Review approved'),
  T('awaiting_review', 'repair_required', ['system'], 'Review found something blocking'),
  T('awaiting_review', 'failed', ['system'], 'Review blocked delivery'),
  T('awaiting_review', 'waiting_for_input', ['system'], 'Review needs an owner decision'),
  T('awaiting_review', 'stopped', ['worker', 'system'], 'Stopped while awaiting review'),

  T('repair_required', 'awaiting_review', ['system'], 'Repaired; ready for a fresh review'),
  T('repair_required', 'failed', ['system'], 'No repair round remained'),
  T('repair_required', 'waiting_for_input', ['system'], 'The findings need an owner decision'),
  T('repair_required', 'cancelled', ['owner'], 'Cancelled rather than repaired'),
  T('repair_required', 'stopped', ['worker', 'system'], 'Stopped'),

  T('integrating', 'succeeded', ['worker', 'system'], 'Merged cleanly'),
  T('integrating', 'failed', ['worker', 'system'], 'Could not merge'),
  T('integrating', 'stopped', ['worker', 'system'], 'Stopped while merging'),

  /* A finished task restarts only as a new attempt the owner asked for. */
  T('failed', 'ready', ['owner'], 'Retried as a new attempt'),
  T('failed', 'skipped', ['owner'], 'Given up on deliberately'),
  T('failed', 'cancelled', ['owner'], 'Cancelled'),
  T('stopped', 'ready', ['owner'], 'Retried as a new attempt'),
  T('stopped', 'cancelled', ['owner'], 'Cancelled'),
];

const TASK_TRANSITION_INDEX = new Map<string, TaskTransition>(
  TASK_TRANSITIONS.map((transition) => [`${transition.from}→${transition.to}`, transition]),
);

export function findTaskTransition(from: TaskState, to: TaskState): TaskTransition | null {
  return TASK_TRANSITION_INDEX.get(`${from}→${to}`) ?? null;
}

export function allowedNextTaskStates(from: TaskState, actor?: TaskActor): readonly TaskState[] {
  return TASK_TRANSITIONS.filter(
    (transition) =>
      transition.from === from && (actor === undefined || transition.actors.includes(actor)),
  ).map((transition) => transition.to);
}

/**
 * Validate a task state change.
 *
 * Same shape as the mission machine: a move to the state a task is already in is a no-op so a
 * retried worker report cannot fail, and anything else missing from the table is a conflict —
 * the caller's view of the world is out of date, not malformed.
 */
export function assertTaskTransition(
  from: TaskState,
  to: TaskState,
  actor: TaskActor,
): TaskTransition | null {
  if (from === to) return findTaskTransition(from, to);
  const transition = findTaskTransition(from, to);
  if (!transition) {
    throw new ConflictError(`A task cannot move from ${from} to ${to}.`, {
      from,
      to,
      allowed: allowedNextTaskStates(from, actor),
    });
  }
  if (!transition.actors.includes(actor)) {
    throw new ConflictError(`A ${actor} cannot move a task from ${from} to ${to}.`, {
      from,
      to,
      actor,
    });
  }
  return transition;
}

/* ------------------------------------------------------------------ schemas */

/**
 * A task key.
 *
 * Short, lowercase and starting with `t`, because it is not only an identifier: it becomes part
 * of a branch name (`jarvis/<mission-id>-<key>-<slug>`) and part of a DOM id. Deliberately admits
 * mnemonics — `tb` for the builder, `tv` for verification, `tr` for review — since a graph an
 * owner reads is easier to follow when the keys mean something. `tbr1` is the first repair of
 * `tb`, which the pattern accepts as an ordinary key.
 */
export const taskKeySchema = z
  .string()
  .trim()
  .regex(/^t[a-z0-9]{1,7}$/, 'A task key looks like t1, tb, tv or tbr1.');

const pathSetSchema = z.array(z.string().trim().min(1).max(200)).max(60);

/** One task as an owner or a playbook proposes it. Ids and state are assigned by Jarvis. */
export const taskProposalSchema = z.object({
  key: taskKeySchema,
  title: z.string().trim().min(3).max(160),
  description: z.string().trim().min(3).max(4000),
  role: z.enum(AGENT_ROLES),
  permissionProfileId: z.enum(PERMISSION_PROFILE_IDS).optional(),
  taskType: z.enum(TASK_TYPES),
  dependsOn: z.array(taskKeySchema).max(20).default([]),
  expectedInputs: z.array(z.string().trim().min(1).max(300)).max(20).default([]),
  expectedOutputs: z.array(z.string().trim().min(1).max(300)).max(20).default([]),
  acceptanceCriteria: z.array(z.string().trim().min(1).max(400)).max(20).default([]),
  workspaceRequirement: z.enum(WORKSPACE_REQUIREMENTS),
  requiresRepository: z.boolean().default(true),
  expectedFileAreas: z.array(z.string().trim().min(1).max(200)).max(40).default([]),
  declaredWriteSet: pathSetSchema.default([]),
  maxAttempts: z.number().int().min(1).max(3).default(1),
  reviewsTaskKey: taskKeySchema.nullish(),
  repairRound: z.number().int().min(0).max(3).default(0),
  /** Relative, not an estimate in tokens or money: "small", "medium", "large". */
  estimatedCost: z.enum(['small', 'medium', 'large']).default('medium'),
});
export type TaskProposal = z.infer<typeof taskProposalSchema>;

export const taskEditSchema = z.object({
  key: taskKeySchema,
  title: z.string().trim().min(3).max(160).optional(),
  description: z.string().trim().min(3).max(4000).optional(),
  dependsOn: z.array(taskKeySchema).max(20).optional(),
  acceptanceCriteria: z.array(z.string().trim().min(1).max(400)).max(20).optional(),
  declaredWriteSet: pathSetSchema.optional(),
  /** The owner may drop a task from the graph; they may not add capability to one. */
  remove: z.boolean().optional(),
});
export type TaskEditInput = z.infer<typeof taskEditSchema>;
