import type {
  Budget,
  BudgetKind,
  BudgetScope,
  CostBasis,
  ModelPrice,
  UsageKind,
  UsageRecord,
  UsageTotals,
} from '@/domain/budget';
import type { ConnectorId, ConnectorRecord, ConnectorState } from '@/domain/connector';

/**
 * The persistence boundary for spend, limits, connectors and the audit trail.
 *
 * The shape that matters: `UsageRepository` has no `update` and no `delete`. A usage record is a
 * statement that a call happened, and statements about the past do not get edited. Everything
 * that looks like a correction is a new row.
 */

/* ------------------------------------------------------------------- usage */

export interface UsageCreateInput {
  readonly kind: UsageKind;
  readonly providerName?: string | null;
  readonly modelName?: string | null;
  readonly missionId?: string | null;
  readonly taskId?: string | null;
  readonly runId?: string | null;
  readonly projectId?: string | null;
  readonly repositoryFullName?: string | null;
  readonly inputTokens?: number | null;
  readonly outputTokens?: number | null;
  readonly cachedInputTokens?: number | null;
  readonly reportedCostUsd?: number | null;
  readonly estimatedCostUsd?: number | null;
  readonly costBasis: CostBasis;
  readonly durationMs?: number | null;
  readonly retryCount?: number;
  readonly failed?: boolean;
  readonly failureCode?: string | null;
  readonly occurredAt?: Date;
  /** Set by a worker report so a replay cannot double-count. */
  readonly idempotencyKey?: string | null;
}

export interface UsageFilter {
  readonly missionId?: string;
  readonly taskId?: string;
  readonly projectId?: string;
  readonly modelName?: string;
  readonly from?: Date;
  readonly to?: Date;
  readonly kinds?: readonly UsageKind[];
}

export interface UsageRepository {
  /** Returns null when the idempotency key has already been recorded. */
  record(input: UsageCreateInput): Promise<UsageRecord | null>;
  /**
   * Write or *replace* the ledger entry for one run.
   *
   * The distinction from `record` is the whole reason this exists. A worker reports its usage
   * repeatedly during a run, and each report carries the run's total so far rather than the delta
   * since the last one. Appending those would count the same tokens once per report; ignoring all
   * but the last would lose the usage of any run that ended without a final report. Replacing a
   * single row keyed on the run does neither, and it matches how the run's own usage columns
   * already behave.
   */
  upsertForRun(input: UsageCreateInput & { readonly runId: string }): Promise<UsageRecord>;
  list(filter?: UsageFilter & { readonly limit?: number }): Promise<readonly UsageRecord[]>;
  /**
   * Aggregate in the database rather than by reading rows into memory.
   *
   * A budget check happens on the dispatch path, so it has to be one indexed query rather than a
   * scan whose cost grows with history. `unknownCostRecords` is returned separately because
   * summing nulls as zero would turn "we cannot measure this" into "this was free".
   */
  totals(filter: UsageFilter): Promise<UsageTotals>;
  /** Spend by day, for the chart and for abnormality detection. */
  dailySpend(input: {
    readonly from: Date;
    readonly to: Date;
  }): Promise<
    readonly { readonly day: string; readonly usd: number | null; readonly outputTokens: number }[]
  >;
  byModel(
    filter: UsageFilter,
  ): Promise<readonly { readonly modelName: string; readonly totals: UsageTotals }[]>;
  /** Drops records older than a retention horizon, returning how many went. */
  prune(before: Date): Promise<number>;
}

/* ----------------------------------------------------------------- budgets */

export interface BudgetCreateInput {
  readonly scope: BudgetScope;
  readonly targetId?: string | null;
  readonly targetLabel?: string | null;
  readonly limitUsd?: number | null;
  readonly limitOutputTokens?: number | null;
  readonly warnAtPercent: number;
  readonly kind: BudgetKind;
  readonly enabled?: boolean;
  readonly resetPeriod?: 'day' | 'month' | null;
}

export interface BudgetOverrideRecord {
  readonly id: string;
  readonly budgetId: string;
  readonly reason: string;
  readonly previousLimitUsd: number | null;
  readonly newLimitUsd: number | null;
  readonly approvedBy: string;
  readonly expiresAt: string | null;
  readonly revokedAt: string | null;
  readonly createdAt: string;
}

export interface BudgetRepository {
  upsert(input: BudgetCreateInput): Promise<Budget>;
  findById(id: string): Promise<Budget | null>;
  list(enabledOnly?: boolean): Promise<readonly Budget[]>;
  /** Every budget that could apply to a piece of work, in one query. */
  applicable(input: {
    readonly projectId?: string | null;
    readonly missionId?: string | null;
    readonly modelName?: string | null;
  }): Promise<readonly Budget[]>;
  patch(id: string, patch: Partial<BudgetCreateInput>): Promise<Budget>;
  remove(id: string): Promise<void>;

  recordOverride(input: {
    readonly budgetId: string;
    readonly reason: string;
    readonly previousLimitUsd: number | null;
    readonly newLimitUsd: number | null;
    readonly approvedBy: string;
    readonly expiresAt: Date | null;
  }): Promise<BudgetOverrideRecord>;
  activeOverride(budgetId: string, now: Date): Promise<BudgetOverrideRecord | null>;
  listOverrides(limit?: number): Promise<readonly BudgetOverrideRecord[]>;
}

export interface PriceRepository {
  upsert(price: ModelPrice & { readonly note?: string | null }): Promise<ModelPrice>;
  all(): Promise<readonly ModelPrice[]>;
  find(modelName: string): Promise<ModelPrice | null>;
  remove(modelName: string): Promise<void>;
}

/* -------------------------------------------------------------- connectors */

export interface ConnectorRepository {
  /** Reads the record, creating a disabled one if the connector has never been touched. */
  ensure(connectorId: ConnectorId, projectId: string | null): Promise<ConnectorRecord>;
  find(connectorId: ConnectorId, projectId: string | null): Promise<ConnectorRecord | null>;
  list(): Promise<readonly ConnectorRecord[]>;
  setState(input: {
    readonly connectorId: ConnectorId;
    readonly projectId: string | null;
    readonly state: ConnectorState;
    readonly actor: string;
    readonly reason?: string | null;
    readonly now: Date;
  }): Promise<ConnectorRecord>;
  recordCredential(input: {
    readonly connectorId: ConnectorId;
    readonly projectId: string | null;
    readonly configured: boolean;
    readonly identity: string | null;
    readonly rotatedAt: Date | null;
  }): Promise<ConnectorRecord>;
  recordOutcome(input: {
    readonly connectorId: ConnectorId;
    readonly projectId: string | null;
    readonly ok: boolean;
    readonly message?: string | null;
    readonly rateLimitedUntil?: Date | null;
    readonly now: Date;
  }): Promise<ConnectorRecord>;
}

/* ------------------------------------------------------------ rate limiting */

export interface RateVerdictRecord {
  readonly allowed: boolean;
  readonly count: number;
  readonly limit: number;
  readonly retryAfterSeconds: number;
}

export interface RateLimitRepository {
  /**
   * Count one request against a bucket and say whether it is allowed.
   *
   * A single upsert, so two concurrent requests cannot both read "one below the limit". Bucket
   * keys embed the window, so expiry is a delete rather than a reset.
   */
  hit(input: {
    readonly key: string;
    readonly limit: number;
    readonly windowSeconds: number;
    readonly now: Date;
  }): Promise<RateVerdictRecord>;
  sweep(before: Date): Promise<number>;
}

/* ------------------------------------------------------------------- audit */

export interface AuditAppendInput {
  readonly actor: string;
  readonly actorKind: 'owner' | 'system' | 'worker' | 'agent' | 'schedule' | 'display';
  readonly action: string;
  readonly subjectKind?: string | null;
  readonly subjectId?: string | null;
  readonly projectId?: string | null;
  readonly missionId?: string | null;
  readonly outcome: 'allowed' | 'refused' | 'failed';
  readonly rule?: string | null;
  readonly summary: string;
  readonly detail?: Record<string, unknown>;
}

export interface AuditEventRecord extends Omit<AuditAppendInput, 'detail'> {
  readonly sequence: number;
  readonly id: string;
  readonly detail: Record<string, unknown>;
  readonly previousHash: string | null;
  readonly hash: string;
  readonly occurredAt: string;
}

export interface AuditChainVerdict {
  readonly ok: boolean;
  readonly checked: number;
  /** The sequence number where the chain first fails to reconcile, if it does. */
  readonly brokenAt: number | null;
  readonly reason: string | null;
}

export interface AuditRepository {
  /** Appends and links. Serialised, because a chain built concurrently is not a chain. */
  append(input: AuditAppendInput): Promise<AuditEventRecord>;
  list(input?: {
    readonly actions?: readonly string[];
    readonly from?: Date;
    readonly to?: Date;
    readonly limit?: number;
  }): Promise<readonly AuditEventRecord[]>;
  verifyChain(limit?: number): Promise<AuditChainVerdict>;
  count(): Promise<number>;
}

export interface DeletionReceiptRecord {
  readonly id: string;
  readonly subjectKind: string;
  readonly subjectId: string;
  readonly reason: string;
  readonly itemCount: number;
  readonly requestedBy: string;
  readonly scrubbedTargets: readonly string[];
  readonly createdAt: string;
}

export interface DeletionReceiptRepository {
  record(input: Omit<DeletionReceiptRecord, 'id' | 'createdAt'>): Promise<DeletionReceiptRecord>;
  list(limit?: number): Promise<readonly DeletionReceiptRecord[]>;
}
