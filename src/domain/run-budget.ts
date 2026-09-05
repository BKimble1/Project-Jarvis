/**
 * The ceilings that bound one agent session, checked while it is still running.
 *
 * ## The gap this closes
 *
 * Every ceiling in this system was defined, most were stored on the row, and almost none were
 * applied to a running agent. `MissionOrchestrator.canStart` — the only caller of the mission
 * runtime and token rules — had no call sites at all. `taskExceedsLimits` was reachable only from
 * `orchestrator.tick`, and nothing calls `tick` on a timer, so the sweep never ran *while* a task
 * was running. And `TaskAssignment.timeLimitMs` and `.maxOutputTokens` were assembled, serialised
 * and shipped to the worker, where no line of code read either of them.
 *
 * So a task could run for as long as the model kept producing, and the only thing that ever
 * stopped it was the model deciding it was finished.
 *
 * ## Why the check lives in the worker
 *
 * Because that is where the run is. The control plane is serverless and sees a task only when the
 * worker reports; a ceiling enforced there can only ever notice a breach after it has happened.
 * The worker holds the session, holds the abort controller, and passes a safe interruption point
 * between every agent event — which is the difference between stopping a run and killing a process
 * in the middle of a git operation.
 *
 * The control plane still checks, and still refuses to hand out work that has already exceeded its
 * mission-level allowance. The two are not redundant: this one bounds the session in front of it,
 * that one bounds the mission across all of its sessions.
 *
 * ## Conservative accounting
 *
 * Real token counts arrive once, in the SDK's final `result` message, after the session has
 * already ended. A token ceiling that waited for them could only ever fire post-mortem. So while
 * the session runs, output is *estimated* from the text the agent has emitted, deliberately on the
 * low side of characters-per-token so the estimate runs ahead of the truth and the ceiling bites
 * early rather than late. When a real figure arrives it replaces the estimate outright.
 *
 * An estimate is never reported as a measurement. `RunBudgetState.basis` says which it is, and the
 * sentence an owner reads says "about" when it is estimating.
 */

export const RUN_LIMITS = ['time', 'outputTokens', 'turns'] as const;
export type RunLimit = (typeof RUN_LIMITS)[number];

export const RUN_LIMIT_LABELS: Record<RunLimit, string> = {
  time: 'time limit',
  outputTokens: 'output allowance',
  turns: 'turn limit',
};

export interface RunCeilings {
  /** Wall-clock for this session. Null means the deployment set none. */
  readonly timeLimitMs: number | null;
  readonly maxOutputTokens: number | null;
  readonly maxTurns: number | null;
}

export interface RunConsumption {
  /** Monotonic elapsed milliseconds. Never a difference of two wall-clock readings. */
  readonly elapsedMs: number;
  /** Characters the agent has emitted, for estimating before a real count exists. */
  readonly emittedCharacters: number;
  /** The provider's own figure once it arrives. Null until then. */
  readonly reportedOutputTokens: number | null;
  readonly turns: number;
}

/**
 * Characters per output token, deliberately low.
 *
 * English prose runs about four characters per token and code rather fewer. Three is below both,
 * which makes the estimate an over-count — and over-counting is the direction that stops a runaway
 * slightly early rather than letting it run slightly long. A ceiling that errs generously is a
 * ceiling that does not hold.
 */
const CHARACTERS_PER_TOKEN = 3;

export function estimateOutputTokens(emittedCharacters: number): number {
  return Math.ceil(Math.max(0, emittedCharacters) / CHARACTERS_PER_TOKEN);
}

export interface RunBudgetState {
  readonly outputTokens: number;
  /** `reported` once the provider has told us; `estimated` from emitted text until then. */
  readonly basis: 'reported' | 'estimated';
}

export function outputTokensSoFar(consumption: RunConsumption): RunBudgetState {
  if (consumption.reportedOutputTokens !== null) {
    return { outputTokens: consumption.reportedOutputTokens, basis: 'reported' };
  }
  return { outputTokens: estimateOutputTokens(consumption.emittedCharacters), basis: 'estimated' };
}

export interface CeilingBreach {
  readonly limit: RunLimit;
  /** The sentence recorded against the task. Says "about" when it is estimating. */
  readonly reason: string;
  readonly basis: 'reported' | 'estimated';
}

/**
 * Has this session passed one of its ceilings?
 *
 * Returns the first breach in a fixed order — time, then output, then turns — rather than every
 * breach, because the result is acted on rather than displayed and acting on the first is the same
 * as acting on all of them. The order is by how certain the measurement is: elapsed time is a
 * fact, an output figure may be an estimate, and a turn count is only as good as the events the
 * runtime chose to emit.
 *
 * A null ceiling is not a breach. It means the deployment configured none, which is a legitimate
 * choice and is different from a ceiling of zero.
 */
export function ceilingBreach(
  ceilings: RunCeilings,
  consumption: RunConsumption,
): CeilingBreach | null {
  if (ceilings.timeLimitMs !== null && consumption.elapsedMs >= ceilings.timeLimitMs) {
    return {
      limit: 'time',
      basis: 'reported',
      reason: `This task reached its ${Math.round(ceilings.timeLimitMs / 60_000)}-minute limit. Its work so far is preserved.`,
    };
  }

  if (ceilings.maxOutputTokens !== null) {
    const state = outputTokensSoFar(consumption);
    if (state.outputTokens >= ceilings.maxOutputTokens) {
      return {
        limit: 'outputTokens',
        basis: state.basis,
        reason:
          state.basis === 'estimated'
            ? `This task has produced about ${state.outputTokens.toLocaleString()} tokens of output, reaching its ${ceilings.maxOutputTokens.toLocaleString()} allowance. Its work so far is preserved.`
            : `This task produced ${state.outputTokens.toLocaleString()} tokens of output, reaching its ${ceilings.maxOutputTokens.toLocaleString()} allowance. Its work so far is preserved.`,
      };
    }
  }

  if (ceilings.maxTurns !== null && consumption.turns >= ceilings.maxTurns) {
    return {
      limit: 'turns',
      basis: 'reported',
      reason: `This task reached its ${ceilings.maxTurns}-turn limit. Its work so far is preserved.`,
    };
  }

  return null;
}

/**
 * A monotonic stopwatch.
 *
 * `Date.now()` can move backwards — an NTP correction, a suspended laptop, a container migration —
 * and a time ceiling computed from two wall-clock readings can therefore fire immediately or never.
 * `performance.now()` cannot go backwards, which is the only property this needs.
 */
export function monotonicNow(): number {
  return performance.now();
}
