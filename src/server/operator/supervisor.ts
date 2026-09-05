import type { Mission } from '@/domain/mission';
import type { MissionRun } from '@/domain/mission-run';
import {
  boundsFromCharter,
  superviseMission,
  type ExplorationBounds,
  type ProgressSnapshot,
  type SupervisorVerdict,
} from '@/domain/progress';

/**
 * Watching a mission that may be going nowhere.
 *
 * `superviseMission` has been written, tested and callable for some time, and nothing called it.
 * This is the part that assembles what it needs out of what the control plane already stores, so
 * that a mission which has used all its attempts, or has not moved for forty minutes, or has spent
 * its whole token budget without producing anything, is *noticed* — rather than discovered
 * afterwards by an owner wondering where their afternoon went.
 *
 * ## What it can see, and what it cannot
 *
 * The control plane records what a mission *is*: its attempts, its repair rounds, when it started,
 * when it last moved, what its run has spent. Those feed the limit checks and the slower stall
 * signals, and between them they catch the expensive failures — a mission that will not finish, a
 * mission that has stopped moving, a mission burning tokens with nothing to show.
 *
 * It does not record what a mission's *working tree* looks like turn by turn: the hash of the diff
 * after each turn, how many turns have passed since a file changed, whether the failing check
 * improved the last time the change grew. Those signals need the worker to keep a running record
 * during the session, and it does not keep one.
 *
 * So this function supplies neutral values for those three rather than plausible ones. That is the
 * whole point of the distinction: a fabricated diff hash would make `oscillating_diff` fire at
 * random, and a guessed `turnsSinceFileChanged` would make `no_file_changed` a coin toss. A signal
 * that cannot be computed must be silent, not approximate — and `dormantSignals` names the ones
 * that are, so nobody reads a clean verdict as a thorough one.
 */

/** The stall signals that need per-turn session state the control plane does not keep. */
export const DORMANT_SUPERVISOR_SIGNALS = [
  'oscillating_diff',
  'no_file_changed',
  'widening_without_improving',
] as const;

export interface SupervisionReport {
  readonly missionId: string;
  readonly missionTitle: string;
  readonly verdict: SupervisorVerdict;
}

/**
 * A mission's progress, as far as the control plane can honestly describe it.
 *
 * `now` is passed rather than read so a tick's whole pass shares one clock: two missions judged
 * against timestamps a second apart would be judged against different bounds.
 */
export function snapshotFromMission(input: {
  readonly mission: Mission;
  readonly run: MissionRun | null;
  readonly openQuestions: readonly string[];
  readonly now: Date;
}): ProgressSnapshot {
  const { mission, run, now } = input;

  const startedAt = mission.startedAt ? Date.parse(mission.startedAt) : null;
  const movedAt = mission.lastActivityAt ? Date.parse(mission.lastActivityAt) : startedAt;

  const minutesSince = (at: number | null): number =>
    at === null || Number.isNaN(at) ? 0 : Math.max(0, (now.getTime() - at) / 60_000);

  return {
    attemptsUsed: mission.attemptCount,
    repairRoundsUsed: mission.repairRoundsUsed,
    elapsedMinutes: minutesSince(startedAt),
    minutesSinceStateChange: minutesSince(movedAt),
    outputTokens: run?.usage?.outputTokens ?? 0,
    /*
     * Null rather than zero. A subscription mission reports no cost because it has none, and zero
     * would read as "nothing spent" to a spend limit that is about money — which happens to be
     * true here, but only by accident, and the accident would stop being true for an API worker.
     */
    spendUsd: run?.usage?.totalCostUsd ?? null,
    /* See the header: three signals need per-turn state nobody records, so they stay silent. */
    turnsSinceFileChanged: 0,
    changedFileCount: 0,
    diffHashes: [],
    errorSignatures: [],
    questions: input.openQuestions,
    findingsBeforeRepair: [],
    findingsAfterRepair: [],
    /*
     * A mission with a branch, a plan or an artifact has produced something. Read from the mission
     * rather than guessed, so `output_without_result` fires on a mission that has genuinely made
     * nothing and stays quiet on one that has.
     */
    producedSomething: Boolean(mission.workingBranch) || mission.currentPlanVersion !== null,
    failureImprovedSinceWidening: null,
  };
}

export function superviseFromCharter(input: {
  readonly mission: Mission;
  readonly run: MissionRun | null;
  readonly openQuestions: readonly string[];
  readonly bounds: ExplorationBounds;
  readonly alreadyNarrowed: boolean;
  readonly ownerCouldUnblock: boolean;
  readonly now: Date;
}): SupervisorVerdict {
  return superviseMission({
    snapshot: snapshotFromMission(input),
    bounds: input.bounds,
    alreadyNarrowed: input.alreadyNarrowed,
    ownerCouldUnblock: input.ownerCouldUnblock,
  });
}

export { boundsFromCharter };
