import { z } from 'zod';
import { ForbiddenError } from './errors';

/**
 * What Jarvis has spent, and what it is allowed to spend.
 *
 * Two things about money in this file, both deliberate.
 *
 * **Reported and estimated are different columns.** When a provider tells Jarvis what a call cost,
 * that number is recorded as reported. When it does not, Jarvis may compute an estimate from
 * tokens and a price table — and that number lives somewhere else, is labelled everywhere it is
 * shown, and never silently becomes the other. If neither is available the answer is *unknown*,
 * which is shown as unknown. A precise-looking figure derived from a price table that may be
 * months stale is worse than no figure, because it gets believed.
 *
 * **The limit is enforced where the work starts, not where the button is.** `assertWithinBudget`
 * runs at the dispatch boundary — inside the claim path, before a task is handed to a worker. A
 * budget enforced in the interface is a budget that a scheduled job, a retry, or a second browser
 * tab walks straight past.
 *
 * Retries, reviews and repair rounds all count against the same budget, because they are all real
 * spending and the alternative is a mission that costs four times its cap while every individual
 * task stays under it.
 */

/* -------------------------------------------------------------------- usage */

export const USAGE_KINDS = [
  'agent_task',
  'review',
  'repair',
  'inspection',
  /** A narration or answer call made by the control plane rather than by a worker. */
  'narration',
  'answer',
  'briefing',
  'embedding',
  'transcription',
] as const;
export type UsageKind = (typeof USAGE_KINDS)[number];

export const USAGE_KIND_LABELS: Record<UsageKind, string> = {
  agent_task: 'Agent task',
  review: 'Review',
  repair: 'Repair',
  inspection: 'Inspection',
  narration: 'Briefing narration',
  answer: 'Answer',
  briefing: 'Briefing',
  embedding: 'Indexing',
  transcription: 'Transcription',
};

/** Where a cost figure came from. The distinction the rest of the file protects. */
export const COST_BASIS = [
  /** The provider told us. Trustworthy to the precision it gave. */
  'reported',
  /** Computed from token counts and a configured price table. An estimate, always labelled. */
  'estimated',
  /** Neither available. Shown as unknown, never as zero. */
  'unknown',
] as const;
export type CostBasis = (typeof COST_BASIS)[number];

export const COST_BASIS_LABELS: Record<CostBasis, string> = {
  reported: 'reported by the provider',
  estimated: 'estimated from tokens',
  unknown: 'unknown',
};

export interface UsageRecord {
  readonly id: string;
  readonly kind: UsageKind;
  readonly providerName: string | null;
  readonly modelName: string | null;
  readonly missionId: string | null;
  readonly taskId: string | null;
  readonly runId: string | null;
  readonly projectId: string | null;
  readonly repositoryFullName: string | null;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly cachedInputTokens: number | null;
  /** Present only when the provider reported it. Never computed into this field. */
  readonly reportedCostUsd: number | null;
  /** Present only when computed from a price table. Never a provider figure. */
  readonly estimatedCostUsd: number | null;
  readonly costBasis: CostBasis;
  readonly durationMs: number | null;
  readonly retryCount: number;
  readonly failed: boolean;
  readonly failureCode: string | null;
  readonly occurredAt: string;
}

/**
 * The single number to display for a record, and where it came from.
 *
 * Returns `null` for unknown rather than `0`. Zero is a claim that something was free; null is a
 * claim that Jarvis does not know, and those are different sentences.
 */
export function effectiveCost(record: Pick<UsageRecord, 'reportedCostUsd' | 'estimatedCostUsd'>): {
  readonly usd: number | null;
  readonly basis: CostBasis;
} {
  if (record.reportedCostUsd !== null) {
    return { usd: record.reportedCostUsd, basis: 'reported' };
  }
  if (record.estimatedCostUsd !== null) {
    return { usd: record.estimatedCostUsd, basis: 'estimated' };
  }
  return { usd: null, basis: 'unknown' };
}

export interface UsageTotals {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedInputTokens: number;
  /** Sum of what providers reported. */
  readonly reportedUsd: number;
  /** Sum of estimates, kept apart so a total is never half one and half the other silently. */
  readonly estimatedUsd: number;
  /** How many records had no cost at all. The honesty column. */
  readonly unknownCount: number;
  readonly recordCount: number;
  readonly failedCount: number;
  readonly retryCount: number;
  readonly durationMs: number;
}

export const EMPTY_TOTALS: UsageTotals = Object.freeze({
  inputTokens: 0,
  outputTokens: 0,
  cachedInputTokens: 0,
  reportedUsd: 0,
  estimatedUsd: 0,
  unknownCount: 0,
  recordCount: 0,
  failedCount: 0,
  retryCount: 0,
  durationMs: 0,
});

export function sumUsage(records: readonly UsageRecord[]): UsageTotals {
  return records.reduce<UsageTotals>(
    (total, record) => ({
      inputTokens: total.inputTokens + (record.inputTokens ?? 0),
      outputTokens: total.outputTokens + (record.outputTokens ?? 0),
      cachedInputTokens: total.cachedInputTokens + (record.cachedInputTokens ?? 0),
      reportedUsd: total.reportedUsd + (record.reportedCostUsd ?? 0),
      estimatedUsd: total.estimatedUsd + (record.estimatedCostUsd ?? 0),
      unknownCount: total.unknownCount + (record.costBasis === 'unknown' ? 1 : 0),
      recordCount: total.recordCount + 1,
      failedCount: total.failedCount + (record.failed ? 1 : 0),
      retryCount: total.retryCount + record.retryCount,
      durationMs: total.durationMs + (record.durationMs ?? 0),
    }),
    EMPTY_TOTALS,
  );
}

/**
 * The figure a budget is measured against.
 *
 * Reported and estimated are added together *for enforcement*, because a limit that ignored
 * estimates would be trivially evaded by a provider that reports nothing. They stay separate for
 * *display*, because that is where the distinction matters to a person.
 */
export function enforceableSpend(totals: UsageTotals): number {
  return totals.reportedUsd + totals.estimatedUsd;
}

/**
 * Whether a spend figure can be trusted enough to enforce a hard limit against.
 *
 * If a meaningful share of records have no cost at all, the total understates reality by an
 * unknown amount — and a hard limit computed from an understated total is a limit that does not
 * hold. Callers doing sensitive work use this to fail closed.
 */
export function spendIsMeasurable(totals: UsageTotals): boolean {
  if (totals.recordCount === 0) return true;
  return totals.unknownCount / totals.recordCount <= 0.25;
}

/* ------------------------------------------------------------------- pricing */

export interface ModelPrice {
  readonly model: string;
  readonly inputUsdPerMillion: number;
  readonly outputUsdPerMillion: number;
  readonly cachedInputUsdPerMillion: number | null;
}

/**
 * Estimate a cost from tokens.
 *
 * Returns `null` when there is no price for the model, and that null is the point: an unpriced
 * model produces an unknown cost rather than a zero. Prices are configuration, not a constant in
 * this file — a hard-coded price table is wrong the week after it is written, and a wrong price
 * presented as an estimate is exactly the false precision this module exists to avoid.
 */
export function estimateCostUsd(input: {
  readonly model: string | null;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly cachedInputTokens?: number | null;
  readonly prices: readonly ModelPrice[];
}): number | null {
  if (!input.model) return null;
  const price = input.prices.find((entry) => entry.model === input.model);
  if (!price) return null;
  if (input.inputTokens === null && input.outputTokens === null) return null;

  const million = 1_000_000;
  const cached = input.cachedInputTokens ?? 0;
  const uncachedInput = Math.max(0, (input.inputTokens ?? 0) - cached);

  const cost =
    (uncachedInput / million) * price.inputUsdPerMillion +
    ((input.outputTokens ?? 0) / million) * price.outputUsdPerMillion +
    (cached / million) * (price.cachedInputUsdPerMillion ?? price.inputUsdPerMillion);

  /* Rounded to the cent below a dollar is misleading; keep six places and format on display. */
  return Math.round(cost * 1_000_000) / 1_000_000;
}

/* ------------------------------------------------------------------ budgets */

export const BUDGET_SCOPES = [
  'task',
  'mission',
  'project',
  'day',
  'month',
  /** A ceiling on one provider or model, independent of the others. */
  'model',
] as const;
export type BudgetScope = (typeof BUDGET_SCOPES)[number];

export const BUDGET_SCOPE_LABELS: Record<BudgetScope, string> = {
  task: 'Per agent task',
  mission: 'Per mission',
  project: 'Per project',
  day: 'Per day',
  month: 'Per month',
  model: 'Per model',
};

export const BUDGET_KINDS = [
  /** Crossing it warns and notifies. Work continues. */
  'warning',
  /** Crossing it stops work. Enforced at dispatch. */
  'hard',
] as const;
export type BudgetKind = (typeof BUDGET_KINDS)[number];

export interface Budget {
  readonly id: string;
  readonly scope: BudgetScope;
  /** The project, mission or model this applies to. Null for `day`/`month`, which are global. */
  readonly targetId: string | null;
  readonly targetLabel: string | null;
  readonly limitUsd: number | null;
  /** A token ceiling, for the common case of caring about volume without trusting a price. */
  readonly limitOutputTokens: number | null;
  readonly warnAtPercent: number;
  readonly kind: BudgetKind;
  readonly enabled: boolean;
  /** When the counter restarts. Null for scopes that are naturally bounded, like `task`. */
  readonly resetPeriod: 'day' | 'month' | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export const budgetSchema = z
  .object({
    scope: z.enum(BUDGET_SCOPES),
    targetId: z.string().trim().max(200).nullish(),
    limitUsd: z.number().min(0.01).max(100_000).nullish(),
    limitOutputTokens: z.number().int().min(1_000).max(1_000_000_000).nullish(),
    warnAtPercent: z.number().int().min(10).max(100).default(80),
    kind: z.enum(BUDGET_KINDS).default('warning'),
    enabled: z.boolean().default(true),
    resetPeriod: z.enum(['day', 'month']).nullish(),
  })
  .refine((value) => value.limitUsd !== null || value.limitOutputTokens !== null, {
    message: 'A budget needs a limit: an amount, a token ceiling, or both.',
  })
  .refine(
    (value) =>
      !(value.scope === 'project' || value.scope === 'mission' || value.scope === 'model') ||
      Boolean(value.targetId),
    { message: 'A per-project, per-mission or per-model budget has to say which one.' },
  );
export type BudgetInput = z.infer<typeof budgetSchema>;

export const budgetOverrideSchema = z.object({
  budgetId: z.string().uuid(),
  /** Typed, because an override is how a hard limit stops being a hard limit. */
  confirmation: z.literal('raise this limit'),
  reason: z.string().trim().min(3).max(600),
  /** New limit, or null to disable the budget entirely for now. */
  limitUsd: z.number().min(0.01).max(100_000).nullish(),
  expiresInHours: z.number().int().min(1).max(720).nullish(),
});
export type BudgetOverrideInput = z.infer<typeof budgetOverrideSchema>;

/* ---------------------------------------------------------------- evaluation */

export const BUDGET_OUTCOMES = [
  'within',
  /** Past the warning threshold, still allowed. */
  'warning',
  /** Past a hard limit. Not allowed. */
  'exceeded',
  /**
   * A hard limit exists but the spend cannot be measured well enough to enforce it.
   *
   * Allowed for ordinary read-only work and refused for sensitive work — see
   * `assertWithinBudget`'s `sensitive` flag. Failing closed on everything would make one unpriced
   * model brick the whole system; failing open on a release would be worse.
   */
  'unmeasurable',
] as const;
export type BudgetOutcome = (typeof BUDGET_OUTCOMES)[number];

export interface BudgetStatus {
  readonly budget: Budget;
  readonly outcome: BudgetOutcome;
  readonly spentUsd: number | null;
  readonly spentOutputTokens: number;
  readonly remainingUsd: number | null;
  readonly remainingOutputTokens: number | null;
  readonly percentUsed: number | null;
  readonly rule: string;
  readonly reason: string | null;
}

/**
 * Where one budget stands.
 *
 * The rules, in the order they are checked:
 *
 *  - **R-BG1** — a disabled budget constrains nothing.
 *  - **R-BG2** — a token ceiling is exceeded. Checked first because it needs no price table and is
 *    therefore the limit that always works.
 *  - **R-BG3** — an amount limit is exceeded.
 *  - **R-BG4** — a hard amount limit exists but the spend is not measurable.
 *  - **R-BG5** — past the warning threshold.
 *  - **R-BG6** — within.
 */
export function evaluateBudget(budget: Budget, totals: UsageTotals): BudgetStatus {
  const spend = enforceableSpend(totals);
  const measurable = spendIsMeasurable(totals);
  const spentUsd = totals.recordCount === 0 ? 0 : measurable ? spend : null;

  const base = {
    budget,
    spentUsd,
    spentOutputTokens: totals.outputTokens,
    remainingUsd:
      budget.limitUsd !== null && spentUsd !== null
        ? Math.max(0, budget.limitUsd - spentUsd)
        : null,
    remainingOutputTokens:
      budget.limitOutputTokens !== null
        ? Math.max(0, budget.limitOutputTokens - totals.outputTokens)
        : null,
    percentUsed:
      budget.limitUsd !== null && spentUsd !== null && budget.limitUsd > 0
        ? Math.round((spentUsd / budget.limitUsd) * 100)
        : budget.limitOutputTokens !== null && budget.limitOutputTokens > 0
          ? Math.round((totals.outputTokens / budget.limitOutputTokens) * 100)
          : null,
  };

  if (!budget.enabled) {
    return { ...base, outcome: 'within', rule: 'R-BG1', reason: null };
  }

  if (budget.limitOutputTokens !== null && totals.outputTokens >= budget.limitOutputTokens) {
    return {
      ...base,
      outcome: budget.kind === 'hard' ? 'exceeded' : 'warning',
      rule: 'R-BG2',
      reason: `${formatTokens(totals.outputTokens)} of ${formatTokens(budget.limitOutputTokens)} output tokens used for ${describeBudgetTarget(budget)}.`,
    };
  }

  if (budget.limitUsd !== null && measurable && spend >= budget.limitUsd) {
    return {
      ...base,
      outcome: budget.kind === 'hard' ? 'exceeded' : 'warning',
      rule: 'R-BG3',
      reason: `${formatUsd(spend)} of ${formatUsd(budget.limitUsd)} used for ${describeBudgetTarget(budget)}.`,
    };
  }

  if (budget.limitUsd !== null && budget.kind === 'hard' && !measurable) {
    return {
      ...base,
      outcome: 'unmeasurable',
      rule: 'R-BG4',
      reason: `${totals.unknownCount} of ${totals.recordCount} calls reported no cost, so Jarvis cannot tell whether the limit for ${describeBudgetTarget(budget)} has been reached.`,
    };
  }

  if (base.percentUsed !== null && base.percentUsed >= budget.warnAtPercent) {
    return {
      ...base,
      outcome: 'warning',
      rule: 'R-BG5',
      reason: `${base.percentUsed}% of the budget for ${describeBudgetTarget(budget)} is used.`,
    };
  }

  return { ...base, outcome: 'within', rule: 'R-BG6', reason: null };
}

export interface BudgetDecision {
  readonly allowed: boolean;
  readonly outcome: BudgetOutcome;
  /** Every budget that had something to say, worst first. */
  readonly statuses: readonly BudgetStatus[];
  readonly blocking: BudgetStatus | null;
  readonly reason: string | null;
}

const OUTCOME_SEVERITY: Record<BudgetOutcome, number> = {
  within: 0,
  warning: 1,
  unmeasurable: 2,
  exceeded: 3,
};

/**
 * The combined verdict across every budget that applies.
 *
 * The worst outcome wins, and `sensitive` decides what `unmeasurable` means: ordinary work
 * proceeds with a warning, while work that writes to a repository, dispatches CI or sends a build
 * fails closed. An unenforceable limit on a release is not a limit.
 */
export function evaluateBudgets(input: {
  readonly statuses: readonly BudgetStatus[];
  readonly sensitive: boolean;
}): BudgetDecision {
  const ranked = [...input.statuses].sort(
    (left, right) => OUTCOME_SEVERITY[right.outcome] - OUTCOME_SEVERITY[left.outcome],
  );
  const worst = ranked[0] ?? null;
  const outcome = worst?.outcome ?? 'within';

  const blocked =
    outcome === 'exceeded' || (outcome === 'unmeasurable' && input.sensitive) ? worst : null;

  return {
    allowed: blocked === null,
    outcome,
    statuses: ranked,
    blocking: blocked,
    reason: blocked
      ? outcome === 'unmeasurable'
        ? `${blocked.reason} This work writes or releases, so Jarvis stops rather than proceeding under a limit it cannot enforce.`
        : blocked.reason
      : null,
  };
}

/**
 * The dispatch-boundary choke point.
 *
 * Throws, for the same reason `assertActivationAllowed` does: every caller's correct response is
 * to stop, and this is called from the one place a task actually starts.
 */
export function assertWithinBudget(decision: BudgetDecision): void {
  if (!decision.allowed) {
    throw new ForbiddenError(decision.reason ?? 'That would exceed a budget you set.', {
      outcome: decision.outcome,
      budgetScope: decision.blocking?.budget.scope ?? null,
      rule: decision.blocking?.rule ?? null,
    });
  }
}

/* -------------------------------------------------------------- projections */

export interface MissionCostEstimate {
  readonly usd: number | null;
  readonly outputTokens: number;
  readonly basis: 'from_similar_missions' | 'from_task_ceilings' | 'unknown';
  readonly confidence: 'low' | 'medium';
  readonly explanation: string;
}

/**
 * What a mission might cost, shown before approval.
 *
 * Two bases, both honest about being rough. Comparable finished missions are the better signal;
 * failing that, the sum of the task ceilings is a genuine *upper bound* rather than a prediction,
 * and it is described as one. Confidence never goes above medium, because it should not.
 */
export function estimateMissionCost(input: {
  readonly comparableTotals: readonly UsageTotals[];
  readonly taskOutputCeilings: readonly number[];
  readonly prices: readonly ModelPrice[];
  readonly model: string | null;
}): MissionCostEstimate {
  const usable = input.comparableTotals.filter((total) => total.recordCount > 0);

  if (usable.length >= 3) {
    const spends = usable.map(enforceableSpend).filter((value) => value > 0);
    const tokens = usable.map((total) => total.outputTokens);
    const medianTokens = median(tokens);
    if (spends.length >= 3) {
      return {
        usd: round2(median(spends)),
        outputTokens: Math.round(medianTokens),
        basis: 'from_similar_missions',
        confidence: 'medium',
        explanation: `The middle value across ${usable.length} comparable missions. Actual cost varies with how much the agents have to read.`,
      };
    }
    return {
      usd: null,
      outputTokens: Math.round(medianTokens),
      basis: 'from_similar_missions',
      confidence: 'low',
      explanation: `Comparable missions used about ${formatTokens(medianTokens)} of output. None of them reported a cost, so Jarvis will not put a figure on it.`,
    };
  }

  const ceiling = input.taskOutputCeilings.reduce((total, value) => total + value, 0);
  if (ceiling > 0) {
    const usd = estimateCostUsd({
      model: input.model,
      inputTokens: null,
      outputTokens: ceiling,
      prices: input.prices,
    });
    return {
      usd: usd === null ? null : round2(usd),
      outputTokens: ceiling,
      basis: 'from_task_ceilings',
      confidence: 'low',
      explanation:
        'An upper bound from the per-task ceilings, not a prediction. Most missions cost a fraction of this.',
    };
  }

  return {
    usd: null,
    outputTokens: 0,
    basis: 'unknown',
    confidence: 'low',
    explanation: 'Not enough history to estimate. Jarvis will record what it actually costs.',
  };
}

/**
 * Unusual retry or token behaviour worth mentioning.
 *
 * Not a limit — a *signal*. A task that retried six times or produced ten times the usual output
 * is either doing something hard or stuck in a loop, and the point of surfacing it is that a
 * person can tell those apart in seconds and a threshold cannot.
 */
export function detectAbnormalUsage(input: {
  readonly record: Pick<UsageRecord, 'retryCount' | 'outputTokens' | 'durationMs' | 'kind'>;
  readonly typicalOutputTokens: number | null;
}): readonly string[] {
  const notes: string[] = [];
  if (input.record.retryCount >= 3) {
    notes.push(`Retried ${input.record.retryCount} times, which usually means something is stuck.`);
  }
  if (
    input.typicalOutputTokens !== null &&
    input.typicalOutputTokens > 0 &&
    (input.record.outputTokens ?? 0) > input.typicalOutputTokens * 4
  ) {
    notes.push(
      `Produced ${formatTokens(input.record.outputTokens ?? 0)} of output, about ${Math.round(
        (input.record.outputTokens ?? 0) / input.typicalOutputTokens,
      )}× the usual for this kind of work.`,
    );
  }
  if ((input.record.durationMs ?? 0) > 30 * 60_000) {
    notes.push('Ran for over half an hour.');
  }
  return notes;
}

/* ------------------------------------------------------------------ display */

/** Tokens, not money — the same formatter the capacity module uses, for the same reason. */
export function formatTokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${Math.round(count / 1_000)}k`;
  return `${count}`;
}

/**
 * Format an amount, or say it is unknown.
 *
 * Never returns `$0.00` for a null. That string is a claim that something was free.
 */
export function formatUsd(value: number | null): string {
  if (value === null) return 'unknown';
  if (value === 0) return '$0.00';
  if (value < 0.01) return '<$0.01';
  return `$${value.toFixed(2)}`;
}

/** A cost with its basis attached, which is how every cost should be shown. */
export function describeCost(usd: number | null, basis: CostBasis): string {
  if (basis === 'unknown' || usd === null) {
    return 'cost unknown — the provider did not report one and there is no price for that model';
  }
  return `${formatUsd(usd)} (${COST_BASIS_LABELS[basis]})`;
}

export function describeBudgetTarget(budget: Budget): string {
  if (budget.targetLabel) return budget.targetLabel;
  switch (budget.scope) {
    case 'day':
      return 'today';
    case 'month':
      return 'this month';
    case 'task':
      return 'one task';
    case 'mission':
      return 'this mission';
    case 'project':
      return 'this project';
    case 'model':
      return budget.targetId ?? 'that model';
  }
}

/* ------------------------------------------------------------------ helpers */

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
