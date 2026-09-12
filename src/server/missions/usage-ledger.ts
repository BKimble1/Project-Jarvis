import type { UsageKind, UsageOutcome } from '@/domain/budget';
import type { RunBilling } from '@/domain/mission-run';
import type { CapacityObservation } from '@/domain/claude-capacity';
import type { UsageCreateInput } from '@/server/repositories/accounting-types';

/**
 * One place where a run's spending becomes a ledger row.
 *
 * ## Why this is a function and not two call sites
 *
 * There were two protocols and one of them wrote to the ledger. The mission protocol recorded
 * every run; the task protocol — which is where the multi-agent factory does all of its work —
 * recorded nothing at all. So the charter's daily and weekly spend caps, the budget page and the
 * capacity governor were all computed over a table that contained none of the factory's spending,
 * and the more work Jarvis did through tasks the more confidently wrong those numbers became.
 *
 * Writing the row is easy. Writing it *the same way* from two places is the part that decays, so
 * the shape lives here and both callers hand it what they have.
 *
 * ## Idempotency
 *
 * Keyed on the run, by `upsertForRun`. That is not an accident of implementation — it is the
 * reason a worker may report as often as it likes: it sends the run's total so far rather than a
 * delta, so a repeated report replaces one row instead of appending a second. A retry, a repair
 * round and a reclaimed task each get a *fresh* run, so each is genuinely distinct spending and
 * genuinely a distinct row. Nothing double-counts and nothing is lost.
 *
 * ## What is not claimed
 *
 * `reportedCostUsd` is set only when the provider actually gave a number, and `costBasis` says so.
 * An absent cost is never zero in the money column: zero is a claim that something was free, and a
 * budget computed from zeroes is a budget that does not hold.
 *
 * But an absent cost has two quite different meanings, and this used to record both as `unknown`.
 * A subscription worker reports no cost *on purpose* — its marginal cost really is nothing, and
 * the runtime drops the counterfactual API price rather than show an owner a bill they will not
 * receive. An API-key worker that reports no cost means the provider did not say, and the total is
 * understating reality by an unknown amount. Only the first is safe to enforce a limit against.
 *
 * Recording them the same way is how a deployment that had spent nothing all week ended up with an
 * operator that refused every plan: `spendIsMeasurable` fails closed on unmeasured spending, and a
 * subscription worker's rows are 100% unpriced by design. So the run now carries its billing mode
 * (see `RunUsage.billing`) and a subscription run is written as `subscription` — a *measured*
 * zero, which stays out of the unpriced count whatever else is in the window, rather than as a
 * missing figure that drags the whole ledger below being worth enforcing.
 *
 * Still never `reportedCostUsd: 0`. Zero in the money column would put subscription work into the
 * same total as API work at a price of nothing, and a week of it would read as a week of free API
 * calls rather than as a week the subscription paid for.
 */
export function usageRowForRun(input: {
  readonly kind: UsageKind;
  readonly runId: string;
  readonly missionId: string;
  readonly taskId: string | null;
  readonly projectId: string | null;
  readonly workerId: string | null;
  readonly attempt: number | null;
  /**
   * Loosened from `RunUsage` on purpose: the wire schema makes every field nullish, and a caller
   * that had to normalise before calling is a caller that eventually normalises differently.
   */
  readonly usage: {
    readonly inputTokens?: number | null;
    readonly outputTokens?: number | null;
    readonly cacheReadTokens?: number | null;
    readonly totalCostUsd?: number | null;
    readonly durationMs?: number | null;
    readonly billing?: RunBilling | null;
  };
  readonly outcome: UsageOutcome;
  readonly failureCode?: string | null;
  readonly occurredAt: Date;
  /** What this worker could see about the account when it spent this. Null when it saw nothing. */
  readonly capacity: CapacityObservation | null;
}): UsageCreateInput & { readonly runId: string } {
  const reported = input.usage.totalCostUsd;
  const windows = input.capacity?.windows;

  return {
    kind: input.kind,
    runId: input.runId,
    missionId: input.missionId,
    taskId: input.taskId,
    projectId: input.projectId,
    workerId: input.workerId,
    attempt: input.attempt,
    inputTokens: input.usage.inputTokens ?? null,
    outputTokens: input.usage.outputTokens ?? null,
    cachedInputTokens: input.usage.cacheReadTokens ?? null,
    reportedCostUsd: reported ?? null,
    /*
     * Reported beats everything: a worker that names a figure has one, whatever it is paying with.
     * Below that, a subscription run is free and anything else is unmeasured — including a worker
     * old enough not to send the field at all, whose silence is exactly "nobody said".
     */
    costBasis:
      reported !== null && reported !== undefined
        ? 'reported'
        : input.usage.billing === 'subscription'
          ? 'subscription'
          : 'unknown',
    durationMs: input.usage.durationMs ?? null,
    outcome: input.outcome,
    /*
     * The boolean stays, because things read it — but it can only say "broke or did not", and a
     * run somebody stopped is not a run that broke. `outcome` carries the difference.
     */
    failed: input.outcome === 'failed',
    failureCode: input.failureCode ?? null,
    occurredAt: input.occurredAt,
    /*
     * The account snapshot, taken from what this worker had already reported rather than measured
     * now. Months later the question is "how full was the window when Jarvis decided to run this",
     * and the worker row will have been rewritten thousands of times by then.
     */
    capacityFiveHourPercent: windows?.fiveHour.utilisationPercent.value ?? null,
    capacitySevenDayPercent: windows?.sevenDay.utilisationPercent.value ?? null,
    contextUsedTokens: input.capacity?.context.usedTokens.value ?? null,
    contextMaxTokens: input.capacity?.context.maxTokens.value ?? null,
  };
}

/** How a reported state maps onto the ledger's four endings. */
export function usageOutcomeFor(input: {
  readonly terminal: boolean;
  readonly failed: boolean;
  readonly stopped: boolean;
  readonly paused: boolean;
}): UsageOutcome {
  if (input.failed) return 'failed';
  if (input.stopped) return 'cancelled';
  if (input.paused) return 'paused';
  if (input.terminal) return 'succeeded';
  /*
   * Mid-run. Recorded rather than withheld, because a run that dies without a final report still
   * spent what it spent — and a row that says "unknown" is the honest shape of spending whose
   * ending has not happened yet.
   */
  return 'unknown';
}
