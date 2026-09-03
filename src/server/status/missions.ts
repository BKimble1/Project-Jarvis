import { MISSION_STATE_LABELS, type Mission, type MissionState } from '@/domain/mission';
import type { AttentionReason } from '@/domain/status';
import type { Claim } from '@/domain/evidence';
import type { MissionCounts } from '@/domain/mission';
import type { WorkerHealth } from '@/domain/worker';
import { ACTIVE_TASK_STATES, type MissionTask } from '@/domain/mission-task';
import { isWriteRole, type AgentRole } from '@/domain/agent-role';

/**
 * Missions as status evidence.
 *
 * The rule that governs this whole file: **a mission's state is a Verified fact** — Jarvis wrote
 * the row itself from a worker's report — but *what that state implies about the project* is
 * carefully hedged. A draft pull request is verified to exist; it is not verified to be good, and
 * it certainly is not finished work. A running mission whose worker has gone silent is not
 * "progressing".
 *
 * Every conclusion carries a rule id, like every other claim in the Status Brain.
 */

export interface MissionSignalInput {
  readonly missions: readonly Mission[];
  /** Worker health by worker id, so a disconnected worker changes the wording rather than the state. */
  readonly workers: ReadonlyMap<string, WorkerHealth>;
  /**
   * The tasks of each mission, by mission id.
   *
   * Optional, and absent means "no task detail", not "no tasks" — the difference matters, because
   * the multi-agent sentences below are only added when there is real task data behind them. A
   * Prompt 2 mission run by a single worker produces exactly the wording it always did.
   */
  readonly tasks?: ReadonlyMap<string, readonly MissionTask[]>;
  readonly now: Date;
}

export interface MissionSignals {
  readonly attention: readonly AttentionReason[];
  readonly currentWork: readonly Claim[];
  readonly recentlyCompleted: readonly Claim[];
  readonly unknowns: readonly string[];
}

const SEVERITY: Record<string, AttentionReason['severity']> = {
  plan: 'high',
  permission: 'critical',
  input: 'high',
  failed: 'high',
  stopped: 'medium',
  clarification: 'medium',
  pr: 'medium',
  stalled: 'high',
};

export function buildMissionSignals(input: MissionSignalInput): MissionSignals {
  const attention: AttentionReason[] = [];
  const currentWork: Claim[] = [];
  const recentlyCompleted: Claim[] = [];
  const unknowns: string[] = [];

  for (const mission of input.missions) {
    const worker = mission.claimedByWorkerId
      ? (input.workers.get(mission.claimedByWorkerId) ?? null)
      : null;
    const stalled = isActive(mission.state) && isDisconnected(worker);

    switch (mission.state) {
      case 'needs_clarification':
        attention.push({
          code: 'decision_required',
          severity: SEVERITY.clarification ?? 'medium',
          summary: `“${mission.title}” is waiting on your answer before Jarvis can plan it.`,
          provenance: 'verified',
          evidenceIds: [],
          rule: 'R-MS1',
        });
        break;

      case 'awaiting_plan_approval':
        attention.push({
          code: 'decision_required',
          severity: SEVERITY.plan ?? 'high',
          summary: `A plan for “${mission.title}” is waiting for your approval.`,
          provenance: 'verified',
          evidenceIds: [],
          rule: 'R-MS2',
        });
        break;

      case 'waiting_for_permission':
        attention.push({
          code: 'decision_required',
          severity: SEVERITY.permission ?? 'critical',
          summary: `Jarvis is paused on “${mission.title}” waiting for permission to continue.`,
          provenance: 'verified',
          evidenceIds: [],
          rule: 'R-MS3',
        });
        break;

      case 'waiting_for_input':
        attention.push({
          code: 'decision_required',
          severity: SEVERITY.input ?? 'high',
          summary: `Jarvis asked a question on “${mission.title}” and is waiting for your answer.`,
          provenance: 'verified',
          evidenceIds: [],
          rule: 'R-MS4',
        });
        break;

      case 'pull_request_ready':
        attention.push({
          code: 'decision_required',
          severity: SEVERITY.pr ?? 'medium',
          summary: `A draft pull request for “${mission.title}” is ready for your review. Nothing is merged.`,
          provenance: 'verified',
          evidenceIds: [],
          rule: 'R-MS5',
        });
        currentWork.push({
          text: `Draft pull request open for “${mission.title}” — awaiting review, not merged.`,
          provenance: 'verified',
          evidenceIds: [],
          rule: 'R-MS5a',
        });
        break;

      case 'failed':
        attention.push({
          code: 'failed_workflow',
          severity: SEVERITY.failed ?? 'high',
          summary: describeFailure(mission),
          provenance: 'verified',
          evidenceIds: [],
          rule: 'R-MS6',
        });
        break;

      case 'stopped':
        attention.push({
          code: 'decision_required',
          severity: SEVERITY.stopped ?? 'medium',
          summary: `“${mission.title}” was stopped. ${describePreservation(mission)}`,
          provenance: 'verified',
          evidenceIds: [],
          rule: 'R-MS7',
        });
        break;

      case 'completed':
        if (withinDays(mission.finishedAt, input.now, 7)) {
          recentlyCompleted.push({
            text: mission.completionSummary
              ? `Mission “${mission.title}”: ${mission.completionSummary}`
              : `Mission “${mission.title}” completed.`,
            provenance: 'verified',
            evidenceIds: [],
            rule: 'R-MS8',
          });
        }
        break;

      case 'queued':
        currentWork.push({
          text: `“${mission.title}” is approved and queued, waiting for a worker.`,
          provenance: 'verified',
          evidenceIds: [],
          rule: 'R-MS9',
        });
        break;

      case 'paused':
        currentWork.push({
          text: `“${mission.title}” is paused. Its workspace and branch are preserved.`,
          provenance: 'verified',
          evidenceIds: [],
          rule: 'R-MS10',
        });
        break;

      default:
        break;
    }

    /*
     * A running mission is only described as progressing while its worker is answering. Otherwise
     * the honest statement is that Jarvis does not currently know.
     */
    if (isActive(mission.state)) {
      if (stalled) {
        attention.push({
          code: 'failed_sync',
          severity: SEVERITY.stalled ?? 'high',
          summary: `“${mission.title}” shows as ${MISSION_STATE_LABELS[mission.state].toLowerCase()}, but its worker has stopped reporting.`,
          provenance: 'verified',
          evidenceIds: [],
          rule: 'R-MS11',
        });
        unknowns.push(
          `Whether “${mission.title}” is still making progress — its worker is not responding, so Jarvis cannot tell. Nothing has been marked complete or failed.`,
        );
      } else {
        currentWork.push({
          text: `Jarvis is working on “${mission.title}” (${MISSION_STATE_LABELS[mission.state].toLowerCase()}).`,
          provenance: 'verified',
          evidenceIds: [],
          rule: 'R-MS12',
        });
      }
    }

    if (mission.state === 'inspecting' || mission.state === 'planning') {
      currentWork.push({
        text: `Jarvis is ${mission.state === 'inspecting' ? 'inspecting the repository for' : 'planning'} “${mission.title}”.`,
        provenance: 'verified',
        evidenceIds: [],
        rule: 'R-MS13',
      });
    }

    describeAgents(mission, input.tasks?.get(mission.id) ?? null, {
      attention,
      currentWork,
      unknowns,
    });
  }

  return { attention, currentWork, recentlyCompleted, unknowns };
}

/**
 * The multi-agent sentences.
 *
 * §25 asks the Status Brain to describe a mission that several agents are working on, and the
 * temptation is to make that sound impressive — "a team of six agents is collaborating". It is
 * not a team and it is not collaborating; it is a graph of tasks with dependencies, some of which
 * are running. So the wording says what is true and countable: how many are working, how many are
 * allowed to write, whether one of them is a reviewer, and whether this is a repair round.
 *
 * Every sentence here is a Verified claim, because every one of them is read from a row Jarvis
 * wrote from a worker's own report — and each carries the rule that produced it.
 */
function describeAgents(
  mission: Mission,
  tasks: readonly MissionTask[] | null,
  out: { attention: AttentionReason[]; currentWork: Claim[]; unknowns: string[] },
): void {
  if (!tasks || tasks.length === 0) return;

  const live = tasks.filter((task) =>
    (ACTIVE_TASK_STATES as readonly string[]).includes(task.state),
  );
  const done = tasks.filter((task) => task.state === 'succeeded' || task.state === 'skipped');
  const failed = tasks.filter((task) => task.state === 'failed');

  if (live.length > 0) {
    const writers = live.filter((task) => isWriteRole(task.role as AgentRole));
    const reviewing = live.filter(
      (task) => task.taskType === 'review' || task.state === 'awaiting_review',
    );
    const repairing = live.filter((task) => task.repairRound > 0);

    const parts = [
      `${live.length} agent${live.length === 1 ? '' : 's'} working on “${mission.title}”`,
      `${done.length} of ${tasks.length} task${tasks.length === 1 ? '' : 's'} finished`,
    ];
    if (writers.length === 0) parts.push('none of them can write to the repository');
    else parts.push(`${writers.length} of them can write`);
    if (reviewing.length > 0) parts.push('an independent review is under way');
    if (repairing.length > 0) {
      parts.push(`this is repair round ${Math.max(...repairing.map((task) => task.repairRound))}`);
    }

    out.currentWork.push({
      text: `${parts.join('; ')}.`,
      provenance: 'verified',
      evidenceIds: [],
      rule: 'R-MS14',
    });
  }

  /*
   * A task that stopped because its repair budget ran out is a *stop*, not a failure to retry
   * harder. Saying which is the difference between an owner who knows to look and one who waits.
   */
  const exhausted = failed.filter((task) => task.failureCode === 'repair_limit_reached');
  if (exhausted.length > 0) {
    out.attention.push({
      code: 'decision_required',
      severity: 'high',
      summary: `“${mission.title}” used every repair round it was allowed and still does not pass review. Jarvis stopped rather than trying again. Everything it did is preserved.`,
      provenance: 'verified',
      evidenceIds: [],
      rule: 'R-MS15',
    });
  }

  const scopeViolations = failed.filter((task) => task.failureCode === 'write_scope_violation');
  if (scopeViolations.length > 0) {
    out.attention.push({
      code: 'decision_required',
      severity: 'critical',
      summary: `An agent on “${mission.title}” changed files outside the write set you approved, so Jarvis stopped it and preserved the workspace for you to look at.`,
      provenance: 'verified',
      evidenceIds: [],
      rule: 'R-MS16',
    });
  }

  const waitingOnOwner = tasks.filter(
    (task) => task.state === 'waiting_for_input' || task.state === 'waiting_for_permission',
  );
  if (waitingOnOwner.length > 0) {
    out.attention.push({
      code: 'decision_required',
      severity: 'high',
      summary: `${waitingOnOwner.length} agent${waitingOnOwner.length === 1 ? '' : 's'} on “${mission.title}” ${waitingOnOwner.length === 1 ? 'is' : 'are'} waiting for you before continuing.`,
      provenance: 'verified',
      evidenceIds: [],
      rule: 'R-MS17',
    });
  }

  /*
   * Blocked-but-nothing-running is the state most easily mistaken for progress: the mission is
   * not finished, no agent is working, and nothing is waiting on the owner either.
   */
  if (live.length === 0 && waitingOnOwner.length === 0 && !isFinishedMission(mission)) {
    const blocked = tasks.filter((task) => task.state === 'blocked');
    if (blocked.length > 0 && failed.length > 0) {
      out.unknowns.push(
        `When “${mission.title}” will continue — ${blocked.length} task(s) are waiting on work that failed, so nothing is running.`,
      );
    }
  }
}

function isFinishedMission(mission: Mission): boolean {
  return (
    mission.state === 'completed' ||
    mission.state === 'failed' ||
    mission.state === 'cancelled' ||
    mission.state === 'stopped' ||
    mission.state === 'pull_request_ready'
  );
}

function describeFailure(mission: Mission): string {
  const cause = mission.failureMessage ?? 'The cause was not recorded.';
  return `“${mission.title}” failed. ${cause} ${describePreservation(mission)}`;
}

/** Whether work survived matters more than why it stopped, so it is always stated. */
function describePreservation(mission: Mission): string {
  if (mission.pullRequestUrl) {
    return 'Its draft pull request is still open.';
  }
  if (mission.workingBranch) {
    return `Its branch ${mission.workingBranch} and workspace are preserved.`;
  }
  return 'No branch was created, so there is nothing to recover.';
}

function withinDays(timestamp: string | null, now: Date, days: number): boolean {
  if (!timestamp) return false;
  const at = new Date(timestamp).getTime();
  if (Number.isNaN(at)) return false;
  return now.getTime() - at <= days * 86_400_000;
}

function isActive(state: MissionState): boolean {
  return (
    state === 'claimed' ||
    state === 'preparing_workspace' ||
    state === 'running' ||
    state === 'waiting_for_permission' ||
    state === 'waiting_for_input' ||
    state === 'pausing' ||
    state === 'resuming' ||
    state === 'verifying' ||
    state === 'creating_pull_request'
  );
}

function isDisconnected(worker: WorkerHealth | null): boolean {
  if (!worker) return true;
  return worker.effectiveStatus === 'disconnected' || worker.effectiveStatus === 'revoked';
}

/**
 * Portfolio-level counts.
 *
 * Aggregation only — no mission appears here that does not already appear at project level, which
 * is the same discipline the rest of the portfolio assessment follows. The shape lives in
 * `@/domain/mission` so presentational components can type against it without importing a server
 * module.
 */
export function countMissions(
  missions: readonly Mission[],
  workers: ReadonlyMap<string, WorkerHealth>,
): MissionCounts {
  let running = 0;
  let stalled = 0;
  for (const mission of missions) {
    if (!isActive(mission.state)) continue;
    const worker = mission.claimedByWorkerId
      ? (workers.get(mission.claimedByWorkerId) ?? null)
      : null;
    if (isDisconnected(worker)) stalled += 1;
    else running += 1;
  }
  const countBy = (state: MissionState) =>
    missions.filter((mission) => mission.state === state).length;

  return {
    total: missions.length,
    running,
    stalled,
    queued: countBy('queued'),
    awaitingApproval: countBy('awaiting_plan_approval'),
    needsClarification: countBy('needs_clarification'),
    needsPermission: countBy('waiting_for_permission') + countBy('waiting_for_input'),
    paused: countBy('paused'),
    prReady: countBy('pull_request_ready'),
    failed: countBy('failed'),
    stopped: countBy('stopped'),
  };
}
