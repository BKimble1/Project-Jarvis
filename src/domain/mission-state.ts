import { ConflictError } from './errors';
import {
  MISSION_RISK_RANK,
  isReadOnlyMissionType,
  type Mission,
  type MissionState,
} from './mission';
import type { ProjectStatus } from './enums';

/**
 * The mission state machine.
 *
 * Two things live here and nothing else: which moves exist, and who is allowed to make them.
 * Both are data. A transition that is not in the table cannot happen, which is what makes
 * "a Draft mission cannot jump directly to Running" a property of the system rather than a
 * property of the code that happens to be calling it today.
 */

/**
 * Who moved a mission.
 *
 * `charter` is not a person and is not a synonym for `owner`. It means "standing authority the
 * owner granted in advance decided this", and it exists as its own actor precisely so that the
 * few moves it may make are enumerable, testable and visible in the history. A mission that
 * reached `queued` because of a charter reads differently in an audit from one a person queued,
 * and it must: nobody was watching.
 *
 * It is deliberately *not* the case that `charter` can do whatever `owner` can do. See
 * `CHARTER_TRANSITIONS` below for the exact list, which is four moves long.
 */
export type MissionActor = 'owner' | 'worker' | 'system' | 'charter';

export interface MissionTransition {
  readonly from: MissionState;
  readonly to: MissionState;
  /** Who may make this move. An owner cannot start a run; a worker cannot approve a plan. */
  readonly actors: readonly MissionActor[];
  readonly summary: string;
}

const T = (
  from: MissionState,
  to: MissionState,
  actors: readonly MissionActor[],
  summary: string,
): MissionTransition => ({ from, to, actors, summary });

export const MISSION_TRANSITIONS: readonly MissionTransition[] = [
  /* Intake */
  T('draft', 'resolving_project', ['owner', 'system'], 'Looking for the right project'),
  T('draft', 'needs_clarification', ['owner', 'system'], 'Jarvis needs more information'),
  /* A draft that needs nothing clarified goes straight to inspection or to planning. */
  T('draft', 'inspecting', ['owner', 'system'], 'Inspecting the repository'),
  T('draft', 'planning', ['owner', 'system'], 'Planning'),
  T('draft', 'cancelled', ['owner'], 'Cancelled before it started'),
  T('resolving_project', 'draft', ['owner', 'system'], 'Returned to draft'),
  T('resolving_project', 'needs_clarification', ['owner', 'system'], 'Jarvis needs to ask'),
  T('resolving_project', 'inspecting', ['owner', 'system'], 'Project chosen; inspecting'),
  T('resolving_project', 'planning', ['owner', 'system'], 'Project chosen; planning'),
  T('resolving_project', 'cancelled', ['owner'], 'Cancelled'),
  T('needs_clarification', 'draft', ['owner'], 'Returned to draft for editing'),
  T('needs_clarification', 'resolving_project', ['owner', 'system'], 'Choosing project'),
  T('needs_clarification', 'inspecting', ['owner', 'system'], 'Questions answered; inspecting'),
  T('needs_clarification', 'planning', ['owner', 'system'], 'Questions answered; planning'),
  T('needs_clarification', 'cancelled', ['owner'], 'Cancelled'),

  /* Inspection and planning */
  T('inspecting', 'planning', ['worker', 'system'], 'Inspection finished'),
  T('inspecting', 'needs_clarification', ['worker', 'system'], 'Inspection raised a question'),
  T('inspecting', 'failed', ['worker', 'system'], 'Inspection failed'),
  T('inspecting', 'cancelled', ['owner'], 'Cancelled during inspection'),
  T('planning', 'awaiting_plan_approval', ['owner', 'worker', 'system'], 'Plan ready for review'),
  T('planning', 'needs_clarification', ['owner', 'worker', 'system'], 'Planning raised a question'),
  T('planning', 'failed', ['worker', 'system'], 'Planning failed'),
  T('planning', 'cancelled', ['owner'], 'Cancelled during planning'),

  /* Approval */
  T('awaiting_plan_approval', 'queued', ['owner', 'charter'], 'Plan approved and queued'),
  T('awaiting_plan_approval', 'planning', ['owner', 'charter'], 'Revision requested'),
  T('awaiting_plan_approval', 'needs_clarification', ['owner'], 'More information needed'),
  T('awaiting_plan_approval', 'draft', ['owner'], 'Returned to draft'),
  T('awaiting_plan_approval', 'cancelled', ['owner'], 'Cancelled'),

  /* Queue and claim */
  T('queued', 'claimed', ['worker'], 'Claimed by a worker'),
  /*
   * Prompt 3: a multi-agent mission has no single claim moment.
   *
   * Its tasks are claimed individually and the mission is "running" as soon as any of them is, so
   * it moves straight from `queued` to `running` rather than passing through a mission-level
   * `claimed`/`preparing_workspace` that no longer describes anything real. The single-agent path
   * is untouched and still goes through both.
   */
  T('queued', 'running', ['system', 'worker'], 'Its first task started'),
  T('queued', 'awaiting_plan_approval', ['owner', 'system'], 'Approval withdrawn or plan edited'),
  T('queued', 'cancelled', ['owner'], 'Cancelled while queued'),
  T('queued', 'failed', ['system'], 'Could not be started'),
  T('claimed', 'preparing_workspace', ['worker'], 'Preparing the workspace'),
  T('claimed', 'queued', ['system'], 'Released back to the queue'),
  T('claimed', 'failed', ['worker', 'system'], 'Failed after claiming'),
  T('claimed', 'stopping', ['owner'], 'Stop requested'),
  T('preparing_workspace', 'running', ['worker'], 'Workspace ready; agent started'),
  T('preparing_workspace', 'failed', ['worker', 'system'], 'Workspace preparation failed'),
  T('preparing_workspace', 'stopping', ['owner'], 'Stop requested'),

  /* Execution */
  T('running', 'waiting_for_permission', ['worker'], 'The agent asked for permission'),
  T('running', 'waiting_for_input', ['worker'], 'The agent asked a question'),
  T('running', 'pausing', ['owner'], 'Pause requested'),
  T('running', 'verifying', ['worker'], 'Running verification'),
  T('running', 'creating_pull_request', ['worker'], 'Opening the draft pull request'),
  T('running', 'completed', ['worker'], 'Finished'),
  /* A multi-agent mission reaches its draft pull request through the delivery task. */
  T('running', 'pull_request_ready', ['worker', 'system'], 'The draft pull request is open'),
  T('running', 'awaiting_plan_approval', ['system'], 'A revised graph needs approving'),
  T('running', 'failed', ['worker', 'system'], 'Failed'),
  T('running', 'stopping', ['owner'], 'Stop requested'),
  T('waiting_for_permission', 'running', ['owner', 'worker'], 'Permission decided'),
  T('waiting_for_permission', 'pausing', ['owner'], 'Pause requested'),
  T('waiting_for_permission', 'stopping', ['owner'], 'Stop requested'),
  T('waiting_for_permission', 'failed', ['worker', 'system'], 'Failed while waiting'),
  T('waiting_for_input', 'running', ['owner', 'worker'], 'Question answered'),
  T('waiting_for_input', 'pausing', ['owner'], 'Pause requested'),
  T('waiting_for_input', 'stopping', ['owner'], 'Stop requested'),
  T('waiting_for_input', 'failed', ['worker', 'system'], 'Failed while waiting'),
  T('verifying', 'running', ['worker'], 'Verification finished; continuing'),
  T('verifying', 'creating_pull_request', ['worker'], 'Verification finished; opening the PR'),
  T('verifying', 'completed', ['worker'], 'Finished after verification'),
  T('verifying', 'failed', ['worker', 'system'], 'Failed during verification'),
  T('verifying', 'stopping', ['owner'], 'Stop requested'),
  T('creating_pull_request', 'pull_request_ready', ['worker'], 'Draft pull request opened'),
  T('creating_pull_request', 'failed', ['worker', 'system'], 'Could not open the pull request'),
  T('creating_pull_request', 'stopping', ['owner'], 'Stop requested'),
  T('pull_request_ready', 'completed', ['owner', 'worker'], 'Marked complete'),
  T('pull_request_ready', 'failed', ['worker', 'system'], 'Failed after the pull request'),

  /* Pause and resume */
  T('pausing', 'paused', ['worker'], 'Paused at a safe boundary'),
  T('pausing', 'running', ['worker'], 'Pause was cancelled'),
  T('pausing', 'stopping', ['owner'], 'Escalated to a stop'),
  T('pausing', 'failed', ['worker', 'system'], 'Failed while pausing'),
  T('paused', 'resuming', ['owner'], 'Resume requested'),
  T('paused', 'awaiting_plan_approval', ['owner', 'system'], 'Scope changed; plan needs approval'),
  T('paused', 'stopping', ['owner'], 'Stop requested'),
  T('paused', 'cancelled', ['owner'], 'Cancelled while paused'),
  T('resuming', 'running', ['worker'], 'Resumed'),
  T('resuming', 'paused', ['worker', 'system'], 'Could not resume; still paused'),
  T('resuming', 'failed', ['worker', 'system'], 'Failed while resuming'),
  T('resuming', 'stopping', ['owner'], 'Stop requested'),

  /* Stop */
  T('stopping', 'stopped', ['worker', 'system'], 'The worker confirmed it stopped'),
  T('stopping', 'failed', ['worker', 'system'], 'Failed while stopping'),

  /*
   * Retry is always an explicit owner action that starts a new attempt. There is deliberately no
   * `stopped → running` or `failed → running`: nothing may resume a stopped mission silently.
   */
  T('stopped', 'queued', ['owner'], 'Retried as a new attempt'),
  T('stopped', 'awaiting_plan_approval', ['owner'], 'Re-planned before retrying'),
  T('stopped', 'cancelled', ['owner'], 'Cancelled'),
  T('failed', 'queued', ['owner', 'charter'], 'Retried as a new attempt'),
  T('failed', 'awaiting_plan_approval', ['owner', 'charter'], 'Re-planned before retrying'),
  T('failed', 'cancelled', ['owner'], 'Cancelled'),
];

const TRANSITION_INDEX = new Map<string, MissionTransition>(
  MISSION_TRANSITIONS.map((transition) => [`${transition.from}→${transition.to}`, transition]),
);

/**
 * Every move standing authority may make, written out rather than derived.
 *
 * Four moves, and the shape of the list is the argument: standing authority replaces the owner
 * only where the owner was a gate on *forward progress inside work Jarvis is already doing*. It
 * replaces the owner nowhere else.
 *
 * What is deliberately absent, and why:
 *
 * - **Anything to `cancelled`.** Cancelling destroys queued work. An operator that can cancel can
 *   quietly delete the owner's own missions, and there is no benefit to autonomy in it: a mission
 *   the operator no longer wants can be failed with a reason, which keeps the record.
 * - **Anything to `stopping` or `pausing`.** Same reasoning from the other side. When the
 *   supervisor decides a mission has become a rabbit hole it ends it through `running → failed`,
 *   which `system` may already do, and the partial work stays on its branch.
 * - **`stopped → queued`.** A stopped mission was stopped by a person. Re-queueing it is the one
 *   move that would let standing authority overrule a live owner decision, so it is the one move
 *   most worth refusing.
 *
 * `failed → queued` *is* here, because a failure is the system's own verdict rather than the
 * owner's, and retrying inside the charter's attempt limit is ordinary operating behaviour. The
 * limit is enforced by the authorisation service, not by this table.
 */
export const CHARTER_TRANSITIONS: readonly (readonly [MissionState, MissionState])[] = [
  ['awaiting_plan_approval', 'queued'],
  ['awaiting_plan_approval', 'planning'],
  ['failed', 'queued'],
  ['failed', 'awaiting_plan_approval'],
];

/** Whether standing authority may make this move at all, before any charter content is consulted. */
export function charterMayMove(from: MissionState, to: MissionState): boolean {
  return findTransition(from, to)?.actors.includes('charter') ?? false;
}

export function findTransition(from: MissionState, to: MissionState): MissionTransition | null {
  return TRANSITION_INDEX.get(`${from}→${to}`) ?? null;
}

/**
 * States an execution run has already passed the starting line in.
 *
 * A worker that restarts polls, is handed back the run it still holds, and receives an assignment
 * shaped exactly like a first claim. This is how it tells the two apart. Everything listed here
 * permits `running` from a worker — either as a real transition or, for `running` itself, as the
 * same-state no-op — which is what makes "skip the opening report and re-synchronise on `running`"
 * safe for every one of them.
 *
 * `claimed` is deliberately absent: that *is* the first claim, and it is the one state from which
 * announcing `preparing_workspace` is both correct and necessary.
 */
const UNDERWAY_STATES = new Set<MissionState>([
  'preparing_workspace',
  'running',
  'waiting_for_permission',
  'waiting_for_input',
  'pausing',
  'resuming',
  'verifying',
]);

export function isMissionAlreadyUnderway(state: MissionState): boolean {
  return UNDERWAY_STATES.has(state);
}

export function allowedNextStates(
  from: MissionState,
  actor?: MissionActor,
): readonly MissionState[] {
  return MISSION_TRANSITIONS.filter(
    (transition) =>
      transition.from === from && (actor === undefined || transition.actors.includes(actor)),
  ).map((transition) => transition.to);
}

/**
 * Validate a state change.
 *
 * A move to the state a mission is already in is accepted as a no-op so that a retried worker
 * request — the same report delivered twice — cannot fail. Anything else that is not in the table
 * is a conflict, not a validation error: the caller's view of the world is simply out of date.
 */
export function assertTransition(
  from: MissionState,
  to: MissionState,
  actor: MissionActor,
): MissionTransition | null {
  if (from === to) return null;
  const transition = findTransition(from, to);
  if (!transition) {
    throw new ConflictError(`A mission cannot move from ${from} to ${to}.`, {
      from,
      to,
      allowed: allowedNextStates(from, actor),
    });
  }
  if (!transition.actors.includes(actor)) {
    throw new ConflictError(
      actor === 'charter'
        ? `Standing authority cannot move a mission from ${from} to ${to}. That move needs you.`
        : `A ${actor} cannot move a mission from ${from} to ${to}.`,
      { from, to, actor },
    );
  }
  return transition;
}

/* -------------------------------------------------------------------- guards */

export interface GuardResult {
  readonly ok: boolean;
  readonly reason: string | null;
  readonly rule: string | null;
}

const OK: GuardResult = { ok: true, reason: null, rule: null };
const deny = (rule: string, reason: string): GuardResult => ({ ok: false, reason, rule });

export interface QueueGuardInput {
  readonly mission: Pick<
    Mission,
    | 'state'
    | 'riskLevel'
    | 'type'
    | 'projectId'
    | 'currentPlanVersion'
    | 'approvedPlanVersion'
    | 'executionOverrideAt'
  >;
  readonly projectStatus: ProjectStatus | null;
  readonly projectArchived: boolean;
  /** True when the approved plan produces only a reviewable draft PR — no publish, no deploy. */
  readonly planIsReviewOnly: boolean;
}

/**
 * May this mission be queued for execution?
 *
 * Everything the spec calls out as a hard stop is checked here rather than in a route handler,
 * so the same rules apply to the API, the UI and the worker's re-check at claim time.
 */
export function canQueueMission(input: QueueGuardInput): GuardResult {
  const { mission } = input;

  if (mission.riskLevel === 'prohibited') {
    return deny(
      'R-MQ1',
      'This mission was classified as prohibited. Jarvis will not execute it, and reducing it to something allowed means rewriting the request.',
    );
  }
  if (!mission.projectId) {
    return deny('R-MQ2', 'A mission needs a project before it can run.');
  }
  if (input.projectArchived || input.projectStatus === 'archived') {
    return deny('R-MQ3', 'This project is archived. Restore it before Jarvis does any work on it.');
  }
  if (mission.currentPlanVersion === null) {
    return deny('R-MQ4', 'There is no plan to run yet.');
  }
  if (mission.approvedPlanVersion === null) {
    return deny('R-MQ5', 'The plan has not been approved.');
  }
  if (mission.approvedPlanVersion !== mission.currentPlanVersion) {
    return deny(
      'R-MQ6',
      `Version ${mission.approvedPlanVersion} was approved but version ${mission.currentPlanVersion} is current. Approve the current version before running it.`,
    );
  }
  if (input.projectStatus === 'paused' && !mission.executionOverrideAt) {
    return deny(
      'R-MQ7',
      'This project is paused. Confirm a one-time override — or reactivate the project — before Jarvis works on it.',
    );
  }
  if (MISSION_RISK_RANK[mission.riskLevel] >= MISSION_RISK_RANK.high && !input.planIsReviewOnly) {
    return deny(
      'R-MQ8',
      'High-risk missions may be planned, but may only execute when the approved plan is reduced to a reviewable draft pull request that publishes and deploys nothing.',
    );
  }
  return OK;
}

export interface ClaimGuardInput {
  readonly mission: Pick<
    Mission,
    'state' | 'approvedPlanVersion' | 'currentPlanVersion' | 'activeRunId'
  >;
  readonly activeMissionCount: number;
  readonly concurrencyLimit: number;
  readonly workerRevoked: boolean;
}

export function canClaimMission(input: ClaimGuardInput): GuardResult {
  if (input.workerRevoked) return deny('R-MC1', 'This worker has been revoked.');
  if (input.mission.state !== 'queued') {
    return deny(
      'R-MC2',
      `Only a queued mission can be claimed; this one is ${input.mission.state}.`,
    );
  }
  if (
    input.mission.approvedPlanVersion === null ||
    input.mission.approvedPlanVersion !== input.mission.currentPlanVersion
  ) {
    return deny('R-MC3', 'The approved plan version is no longer the current one.');
  }
  if (input.mission.activeRunId !== null) {
    return deny('R-MC4', 'This mission already has an active run.');
  }
  if (input.activeMissionCount >= input.concurrencyLimit) {
    return deny(
      'R-MC5',
      `Jarvis runs ${input.concurrencyLimit} mission at a time in this phase, and one is already active.`,
    );
  }
  return OK;
}

export interface ResumeGuardInput {
  readonly mission: Pick<
    Mission,
    'state' | 'approvedPlanVersion' | 'currentPlanVersion' | 'claimedByWorkerId'
  >;
  readonly workerConnected: boolean;
  readonly workspacePreserved: boolean;
}

export function canResumeMission(input: ResumeGuardInput): GuardResult {
  if (input.mission.state === 'stopped') {
    return deny(
      'R-MR1',
      'A stopped mission does not resume. Retry it as a new attempt — the earlier work is preserved.',
    );
  }
  if (input.mission.state !== 'paused') {
    return deny(
      'R-MR2',
      `Only a paused mission can be resumed; this one is ${input.mission.state}.`,
    );
  }
  if (input.mission.approvedPlanVersion !== input.mission.currentPlanVersion) {
    return deny(
      'R-MR3',
      'The plan changed while the mission was paused. Approve the current version before resuming.',
    );
  }
  if (!input.workerConnected) {
    return deny('R-MR4', 'The worker that holds this mission is not connected.');
  }
  if (!input.workspacePreserved) {
    return deny(
      'R-MR5',
      'The workspace is no longer available, so this mission needs a fresh session rather than a resume.',
    );
  }
  return OK;
}

/**
 * Whether a mission needs a repository at all.
 *
 * A manual project's mission still plans, researches and reports — it simply never grows a branch.
 */
export function missionNeedsRepository(mission: Pick<Mission, 'type'>): boolean {
  return !isReadOnlyMissionType(mission.type) && mission.type !== 'manual_task';
}
