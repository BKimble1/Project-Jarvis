import type { CharterLimits } from './charter';

/**
 * Knowing when to stop.
 *
 * An autonomous operator's most expensive failure is not doing something wrong. It is doing
 * something *almost right* forty times in a row: re-running a failing test with a slightly
 * different fix, re-reading the same file, spending an afternoon and a great deal of money on a
 * problem it was never going to solve, and reporting steady activity the whole time.
 *
 * This module is the part that notices. It is pure, deterministic, and deliberately harsh — every
 * signal below describes a shape that *looks* like work and is not, and each is written so it can
 * be detected from what a mission has already recorded rather than by asking a model whether it
 * thinks it is making progress. A model asked that question says yes.
 *
 * ## Two things it must not do
 *
 * **It must not throw away useful partial work.** Every verdict says what to keep. A mission that
 * is stopped for going nowhere still produced a branch, a diagnosis, and a list of things that did
 * not work, and all three are worth more than the tokens they cost.
 *
 * **It must not answer a stall by spawning more agents.** The tempting fix for "the builder is
 * stuck" is another reviewer, then a researcher to explain the reviewer, then a specialist. That
 * turns a stalled mission into an expensive stalled mission. `SUPERVISOR_ACTIONS` has no outcome
 * that adds an agent; the ways out are narrower scope, the owner, or stopping.
 */

/* ------------------------------------------------------------------ limits */

export const EXPLORATION_LIMITS = [
  'attempts',
  'repairRounds',
  'missionMinutes',
  'missionOutputTokens',
  'agentTurns',
  'parallelAgents',
  'missionSpendUsd',
  'consecutiveFailures',
  'writeSetFiles',
  'followUpDepth',
  'repeatedErrors',
] as const;
export type ExplorationLimit = (typeof EXPLORATION_LIMITS)[number];

export const EXPLORATION_LIMIT_MEANING: Record<ExplorationLimit, string> = {
  attempts: 'How many times a mission may be started from the beginning.',
  repairRounds: 'How many times a failing verification may be handed back for repair.',
  missionMinutes: 'Wall-clock time one mission may take.',
  missionOutputTokens: 'Model output one mission may produce, across every agent in it.',
  agentTurns: 'Turns a single agent may take before it is stopped.',
  parallelAgents: 'Agents that may run at once.',
  missionSpendUsd: 'Money one mission may cost.',
  consecutiveFailures: 'Missions that may fail in a row before the loop stops starting new ones.',
  writeSetFiles: 'Files one mission may change.',
  followUpDepth: 'How far a chain of follow-up missions may run from the one that started it.',
  repeatedErrors: 'How many times the same error may be seen before it counts as a wall.',
};

export interface ExplorationBounds {
  readonly attempts: number;
  readonly repairRounds: number;
  readonly missionMinutes: number;
  readonly missionOutputTokens: number;
  readonly agentTurns: number;
  readonly parallelAgents: number;
  readonly missionSpendUsd: number | null;
  readonly consecutiveFailures: number;
  readonly writeSetFiles: number;
  readonly followUpDepth: number;
  readonly repeatedErrors: number;
}

/**
 * The bounds the charter sets, plus the ones it does not.
 *
 * Four of the eleven come from the charter because they are the owner's to choose — money, time,
 * attempts, parallelism. The rest are operational safety rails with fixed defaults, and they are
 * fixed on purpose: an owner should not have to think about "how many turns before an agent is
 * looping" to use Jarvis safely, and an owner who could raise it to a thousand eventually would.
 */
export function boundsFromCharter(limits: CharterLimits): ExplorationBounds {
  return {
    attempts: limits.maxAttempts,
    repairRounds: limits.maxRepairRounds,
    missionMinutes: limits.maxMissionMinutes,
    parallelAgents: limits.maxParallelAgents,
    missionSpendUsd: limits.dailySpendUsd,
    missionOutputTokens: 400_000,
    agentTurns: 120,
    consecutiveFailures: 3,
    writeSetFiles: 60,
    followUpDepth: 2,
    repeatedErrors: 3,
  };
}

/* -------------------------------------------------------------- no progress */

export const NO_PROGRESS_SIGNALS = [
  /** The same error text, three times. The agent is trying variations of a fix that cannot work. */
  'repeated_error',
  /** Turns are being spent and no file has changed. Reading, not building. */
  'no_file_changed',
  /** The diff has returned to a state it already held. Undoing and redoing the same change. */
  'oscillating_diff',
  /** The same verification check fails after a repair that was supposed to fix it. */
  'verification_unmoved',
  /** Tokens spent, nothing produced: no artifact, no diff, no answer. */
  'output_without_result',
  /** The agent has asked the same question more than once. It is stuck, not curious. */
  'repeated_question',
  /** Wall-clock time has passed with no state change at all. */
  'no_state_change',
  /** A repair round finished with the same findings it started with. */
  'repair_ineffective',
  /** The write set keeps growing while the failing check does not improve. Scope creep. */
  'widening_without_improving',
  /** Every attempt the charter allows has been used. */
  'attempts_exhausted',
] as const;
export type NoProgressSignal = (typeof NO_PROGRESS_SIGNALS)[number];

export const NO_PROGRESS_MEANING: Record<NoProgressSignal, string> = {
  repeated_error: 'The same error keeps coming back, so the current approach cannot work.',
  no_file_changed: 'Turns are being spent and nothing has changed on disk.',
  oscillating_diff: 'The change has gone back to something it already was.',
  verification_unmoved: 'The same check is still failing after a repair meant to fix it.',
  output_without_result: 'A lot has been written and nothing has been produced.',
  repeated_question: 'The same question has been asked more than once.',
  no_state_change: 'Time has passed and nothing has moved.',
  repair_ineffective: 'A repair round ended with exactly the findings it started with.',
  widening_without_improving: 'The change keeps growing and the failure has not improved.',
  attempts_exhausted: 'Every attempt allowed has been used.',
};

/**
 * What a mission has actually done, as far as anything can tell from its record.
 *
 * Every field is something already stored — a diff hash, an error string, a count — rather than
 * something a model reports about itself. That distinction is the point: a stalled agent asked
 * whether it is making progress will say yes, sincerely, every time.
 */
export interface ProgressSnapshot {
  readonly attemptsUsed: number;
  readonly repairRoundsUsed: number;
  readonly elapsedMinutes: number;
  readonly minutesSinceStateChange: number;
  readonly outputTokens: number;
  readonly spendUsd: number | null;
  readonly turnsSinceFileChanged: number;
  readonly changedFileCount: number;
  /** Most recent last. Hashes of the working tree, so a repeat means the diff came back. */
  readonly diffHashes: readonly string[];
  /** Most recent last. Normalised error signatures, not raw text. */
  readonly errorSignatures: readonly string[];
  /** Most recent last. Normalised questions the agent asked the owner. */
  readonly questions: readonly string[];
  /** Findings before and after the most recent repair round, as stable ids. */
  readonly findingsBeforeRepair: readonly string[];
  readonly findingsAfterRepair: readonly string[];
  /** True once the mission has produced something worth keeping. */
  readonly producedSomething: boolean;
  /** Whether the failing check has improved at all since the write set last grew. */
  readonly failureImprovedSinceWidening: boolean | null;
}

export interface NoProgressFinding {
  readonly signal: NoProgressSignal;
  readonly detail: string;
}

export interface NoProgressVerdict {
  readonly stalled: boolean;
  readonly findings: readonly NoProgressFinding[];
  /** Limits that have been reached outright, separate from the softer stall signals. */
  readonly limitsReached: readonly ExplorationLimit[];
}

/**
 * Whether a mission has stopped making progress.
 *
 * Returns *every* signal rather than the first, because the combination is what an owner reads:
 * "the same error three times and the diff has stopped changing" is a different sentence from
 * either half, and a supervisor that stopped at the first signal would report the least
 * informative one.
 */
export function detectNoProgress(
  snapshot: ProgressSnapshot,
  bounds: ExplorationBounds,
): NoProgressVerdict {
  const findings: NoProgressFinding[] = [];
  const limitsReached: ExplorationLimit[] = [];

  const repeated = mostRepeated(snapshot.errorSignatures);
  if (repeated && repeated.count >= bounds.repeatedErrors) {
    findings.push({
      signal: 'repeated_error',
      detail: `“${truncate(repeated.value)}” has come back ${repeated.count} times.`,
    });
    limitsReached.push('repeatedErrors');
  }

  if (snapshot.turnsSinceFileChanged >= 15 && snapshot.changedFileCount === 0) {
    findings.push({
      signal: 'no_file_changed',
      detail: `${snapshot.turnsSinceFileChanged} turns have gone by without a file changing.`,
    });
  }

  if (hasRepeat(snapshot.diffHashes)) {
    findings.push({
      signal: 'oscillating_diff',
      detail: 'The change has returned to a state it already had.',
    });
  }

  if (
    snapshot.findingsBeforeRepair.length > 0 &&
    sameSet(snapshot.findingsBeforeRepair, snapshot.findingsAfterRepair)
  ) {
    findings.push({
      signal: 'repair_ineffective',
      detail: 'The repair round ended with exactly the findings it started with.',
    });
  }

  if (snapshot.outputTokens > 50_000 && !snapshot.producedSomething) {
    findings.push({
      signal: 'output_without_result',
      detail: `${Math.round(snapshot.outputTokens / 1000)}k tokens of output and nothing produced.`,
    });
  }

  const question = mostRepeated(snapshot.questions);
  if (question && question.count >= 2) {
    findings.push({
      signal: 'repeated_question',
      detail: `The same question has been asked ${question.count} times.`,
    });
  }

  if (snapshot.minutesSinceStateChange >= 20) {
    findings.push({
      signal: 'no_state_change',
      detail: `Nothing has moved for ${Math.round(snapshot.minutesSinceStateChange)} minutes.`,
    });
  }

  if (snapshot.failureImprovedSinceWidening === false) {
    findings.push({
      signal: 'widening_without_improving',
      detail: 'The change keeps growing and the failure has not improved.',
    });
  }

  if (snapshot.attemptsUsed >= bounds.attempts) {
    findings.push({
      signal: 'attempts_exhausted',
      detail: `All ${bounds.attempts} attempts have been used.`,
    });
    limitsReached.push('attempts');
  }

  if (snapshot.repairRoundsUsed >= bounds.repairRounds) limitsReached.push('repairRounds');
  if (snapshot.elapsedMinutes >= bounds.missionMinutes) limitsReached.push('missionMinutes');
  if (snapshot.outputTokens >= bounds.missionOutputTokens) limitsReached.push('missionOutputTokens');
  if (snapshot.changedFileCount >= bounds.writeSetFiles) limitsReached.push('writeSetFiles');
  if (
    bounds.missionSpendUsd !== null &&
    snapshot.spendUsd !== null &&
    snapshot.spendUsd >= bounds.missionSpendUsd
  ) {
    limitsReached.push('missionSpendUsd');
  }

  return {
    stalled: findings.length > 0 || limitsReached.length > 0,
    findings,
    limitsReached: [...new Set(limitsReached)],
  };
}

/* ------------------------------------------------------------- supervision */

export const SUPERVISOR_ACTIONS = [
  /** Nothing is wrong. Let it work. */
  'continue',
  /** One signal, early. Cut the scope to the smallest thing that would still be useful. */
  'narrow',
  /** It cannot finish and a person could unblock it. Ask, and keep the work. */
  'escalate',
  /** Stop, keep everything produced, and record why. */
  'stop',
] as const;
export type SupervisorAction = (typeof SUPERVISOR_ACTIONS)[number];

export const SUPERVISOR_ACTION_MEANING: Record<SupervisorAction, string> = {
  continue: 'Jarvis is getting somewhere and will keep going.',
  narrow: 'Jarvis is going in circles, so it is cutting the job down to the useful part.',
  escalate: 'Jarvis cannot finish this without you.',
  stop: 'Jarvis has stopped. Everything it produced is kept.',
};

export interface SupervisorVerdict {
  readonly action: SupervisorAction;
  /** The sentence an owner reads. Made of the findings, never of a model's summary of them. */
  readonly reason: string;
  readonly verdict: NoProgressVerdict;
  /**
   * What to keep when the action is `narrow`, `escalate` or `stop`.
   *
   * Always non-empty for those three. A mission that spent an hour learning that an approach does
   * not work has produced something worth more than the tokens it cost, and discarding it means
   * the next attempt pays for the same lesson.
   */
  readonly preserve: readonly string[];
}

/**
 * What to do about a mission that may be going nowhere.
 *
 * The escalation is one-way and shallow: `continue` → `narrow` → `escalate`/`stop`. There is no
 * outcome that adds an agent, because the tempting answer to "the builder is stuck" is another
 * reviewer, and then a researcher to explain the reviewer, and the result is a stalled mission
 * that costs four times as much.
 *
 * `narrow` is offered at most once per mission — `alreadyNarrowed` says whether it has been — so
 * a mission cannot spend its whole budget being cut down by degrees.
 */
export function superviseMission(input: {
  readonly snapshot: ProgressSnapshot;
  readonly bounds: ExplorationBounds;
  readonly alreadyNarrowed: boolean;
  /** True when a person could plausibly unblock it: a decision, a credential, an answer. */
  readonly ownerCouldUnblock: boolean;
}): SupervisorVerdict {
  const verdict = detectNoProgress(input.snapshot, input.bounds);
  const preserve = preservable(input.snapshot);

  if (!verdict.stalled) {
    return { action: 'continue', reason: 'It is still making progress.', verdict, preserve };
  }

  /*
   * A limit reached is not a judgement call. It is the end.
   *
   * The findings go into the sentence alongside the limit, because "all 2 attempts have been used"
   * tells an owner that it stopped and "the same TS2345 came back three times" tells them why —
   * and the second is the one that makes the next attempt different.
   */
  if (verdict.limitsReached.length > 0) {
    const limits = verdict.limitsReached
      .map((limit) => EXPLORATION_LIMIT_MEANING[limit].toLowerCase().replace(/\.$/, ''))
      .join('; ');
    const detail = describe(verdict);
    return {
      action: 'stop',
      reason: detail
        ? `Stopped because the limit was reached (${limits}): ${detail}`
        : `Stopped because the limit was reached: ${limits}.`,
      verdict,
      preserve,
    };
  }

  const asked = verdict.findings.some((finding) => finding.signal === 'repeated_question');
  if (asked || input.ownerCouldUnblock) {
    return {
      action: 'escalate',
      reason: `Jarvis needs you: ${describe(verdict)}`,
      verdict,
      preserve,
    };
  }

  if (!input.alreadyNarrowed) {
    return {
      action: 'narrow',
      reason: `Cutting the job down: ${describe(verdict)}`,
      verdict,
      preserve,
    };
  }

  return {
    action: 'stop',
    reason: `Stopped after narrowing did not help: ${describe(verdict)}`,
    verdict,
    preserve,
  };
}

/**
 * What is worth keeping from a mission that is being stopped.
 *
 * Never empty, even for a mission that produced no code. "These three approaches did not work" is
 * a result, and it is the one the next attempt most needs.
 */
export function preservable(snapshot: ProgressSnapshot): readonly string[] {
  const keep: string[] = [];
  if (snapshot.changedFileCount > 0) {
    keep.push(`the branch, with ${snapshot.changedFileCount} changed file(s)`);
  }
  if (snapshot.errorSignatures.length > 0) {
    keep.push(`the ${new Set(snapshot.errorSignatures).size} distinct failure(s) it ran into`);
  }
  if (snapshot.questions.length > 0) keep.push('the questions it could not answer');
  if (snapshot.producedSomething) keep.push('the artifacts it produced');
  if (keep.length === 0) keep.push('the record of what it tried and why it did not work');
  return keep;
}

function describe(verdict: NoProgressVerdict): string {
  return verdict.findings.map((finding) => finding.detail).join(' ');
}

function mostRepeated(
  values: readonly string[],
): { readonly value: string; readonly count: number } | null {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  let best: { value: string; count: number } | null = null;
  for (const [value, count] of counts) {
    if (!best || count > best.count) best = { value, count };
  }
  return best;
}

function hasRepeat(values: readonly string[]): boolean {
  return new Set(values).size !== values.length;
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const set = new Set(left);
  return right.every((value) => set.has(value));
}

function truncate(value: string): string {
  return value.length <= 80 ? value : `${value.slice(0, 77)}…`;
}
