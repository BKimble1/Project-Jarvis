import { and, asc, desc, eq, gte, inArray, isNull, lt, lte, or, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { NotFoundError } from '@/domain/errors';
import { EMPTY_TOTALS } from '@/domain/budget';
import type { Budget, ModelPrice, UsageKind, UsageRecord, UsageTotals } from '@/domain/budget';
import type { ConnectorId, ConnectorRecord, ConnectorState } from '@/domain/connector';
import { auditHash, verifyChain, type ChainLink } from '@/domain/audit';
import { boundText, redactDeep, redactSecrets } from '@/domain/redaction';
import type { Database } from '@/server/db/client';
import {
  auditEvents,
  budgetOverrides,
  budgets,
  connectors,
  deletionReceipts,
  modelPrices,
  rateLimitBuckets,
  usageRecords,
} from '@/server/db/schema';
import type {
  AuditAppendInput,
  AuditChainVerdict,
  AuditEventRecord,
  AuditRepository,
  BudgetCreateInput,
  BudgetOverrideRecord,
  BudgetRepository,
  ConnectorRepository,
  DeletionReceiptRecord,
  DeletionReceiptRepository,
  PriceRepository,
  RateLimitRepository,
  RateVerdictRecord,
  UsageCreateInput,
  UsageFilter,
  UsageRepository,
} from './accounting-types';
import { iso, isoRequired } from './mappers';

/**
 * Persistence for spend, limits, connectors and the audit trail.
 *
 * `DrizzleUsageRepository.totals` is the one to read first. It aggregates in SQL rather than
 * pulling rows into memory, and it counts records with no cost separately instead of summing
 * their nulls as zero — the difference between "this cost nothing" and "we cannot say what this
 * cost", which every budget decision downstream depends on.
 *
 * `DrizzleAuditRepository.append` takes the chain head inside a transaction. A chain built by
 * concurrent appends that each read the same head is not a chain; serialising is the point.
 */

export class DrizzleUsageRepository implements UsageRepository {
  constructor(private readonly db: Database) {}

  async record(input: UsageCreateInput): Promise<UsageRecord | null> {
    const rows = await this.db
      .insert(usageRecords)
      .values({
        kind: input.kind,
        providerName: input.providerName ?? null,
        modelName: input.modelName ?? null,
        missionId: input.missionId ?? null,
        taskId: input.taskId ?? null,
        runId: input.runId ?? null,
        projectId: input.projectId ?? null,
        repositoryFullName: input.repositoryFullName ?? null,
        inputTokens: input.inputTokens ?? null,
        outputTokens: input.outputTokens ?? null,
        cachedInputTokens: input.cachedInputTokens ?? null,
        reportedCostUsd: input.reportedCostUsd ?? null,
        estimatedCostUsd: input.estimatedCostUsd ?? null,
        costBasis: input.costBasis,
        durationMs: input.durationMs ?? null,
        retryCount: input.retryCount ?? 0,
        failed: input.failed ?? false,
        failureCode: input.failureCode ?? null,
        ...(input.occurredAt ? { occurredAt: input.occurredAt } : {}),
        idempotencyKey: input.idempotencyKey ?? null,
      })
      /*
       * The unique index is partial (`where idempotency_key is not null`), so the conflict
       * target has to carry the same predicate or Postgres cannot infer which index arbitrates.
       */
      .onConflictDoNothing({
        target: usageRecords.idempotencyKey,
        where: sql`${usageRecords.idempotencyKey} is not null`,
      })
      .returning();
    const row = rows[0];
    return row ? toUsageRecord(row) : null;
  }

  async list(
    filter: UsageFilter & { readonly limit?: number } = {},
  ): Promise<readonly UsageRecord[]> {
    const rows = await this.db
      .select()
      .from(usageRecords)
      .where(usageWhere(filter))
      .orderBy(desc(usageRecords.occurredAt))
      .limit(filter.limit ?? 200);
    return rows.map((row) => toUsageRecord(row));
  }

  async totals(filter: UsageFilter): Promise<UsageTotals> {
    const [row] = await this.db
      .select({
        inputTokens: sql<number>`coalesce(sum(${usageRecords.inputTokens}), 0)::double precision`,
        outputTokens: sql<number>`coalesce(sum(${usageRecords.outputTokens}), 0)::double precision`,
        cachedInputTokens: sql<number>`coalesce(sum(${usageRecords.cachedInputTokens}), 0)::double precision`,
        reportedUsd: sql<number>`coalesce(sum(${usageRecords.reportedCostUsd}), 0)::double precision`,
        estimatedUsd: sql<number>`coalesce(sum(${usageRecords.estimatedCostUsd}), 0)::double precision`,
        unknownCount: sql<number>`count(*) filter (where ${usageRecords.costBasis} = 'unknown')::int`,
        recordCount: sql<number>`count(*)::int`,
        failedCount: sql<number>`count(*) filter (where ${usageRecords.failed})::int`,
        retryCount: sql<number>`coalesce(sum(${usageRecords.retryCount}), 0)::int`,
        durationMs: sql<number>`coalesce(sum(${usageRecords.durationMs}), 0)::double precision`,
      })
      .from(usageRecords)
      .where(usageWhere(filter));

    if (!row) return EMPTY_TOTALS;
    return {
      inputTokens: Number(row.inputTokens),
      outputTokens: Number(row.outputTokens),
      cachedInputTokens: Number(row.cachedInputTokens),
      reportedUsd: Number(row.reportedUsd),
      estimatedUsd: Number(row.estimatedUsd),
      unknownCount: Number(row.unknownCount),
      recordCount: Number(row.recordCount),
      failedCount: Number(row.failedCount),
      retryCount: Number(row.retryCount),
      durationMs: Number(row.durationMs),
    };
  }

  async dailySpend(input: { readonly from: Date; readonly to: Date }) {
    const rows = await this.db
      .select({
        day: sql<string>`to_char(date_trunc('day', ${usageRecords.occurredAt}), 'YYYY-MM-DD')`,
        usd: sql<number>`(coalesce(sum(${usageRecords.reportedCostUsd}), 0) + coalesce(sum(${usageRecords.estimatedCostUsd}), 0))::double precision`,
        outputTokens: sql<number>`coalesce(sum(${usageRecords.outputTokens}), 0)::double precision`,
        known: sql<number>`count(*) filter (where ${usageRecords.costBasis} <> 'unknown')::int`,
      })
      .from(usageRecords)
      .where(and(gte(usageRecords.occurredAt, input.from), lte(usageRecords.occurredAt, input.to)))
      .groupBy(sql`date_trunc('day', ${usageRecords.occurredAt})`)
      .orderBy(asc(sql`date_trunc('day', ${usageRecords.occurredAt})`));

    /*
     * A day whose every record had an unknown cost reports null, not zero. Charting zero for
     * such a day would draw a flat line that reads as "nothing was spent".
     */
    return rows.map((row) => ({
      day: String(row.day),
      usd: Number(row.known) === 0 ? null : Number(row.usd),
      outputTokens: Number(row.outputTokens),
    }));
  }

  async byModel(filter: UsageFilter) {
    const rows = await this.db
      .select({
        modelName: sql<string>`coalesce(${usageRecords.modelName}, 'unknown')`,
        inputTokens: sql<number>`coalesce(sum(${usageRecords.inputTokens}), 0)::double precision`,
        outputTokens: sql<number>`coalesce(sum(${usageRecords.outputTokens}), 0)::double precision`,
        cachedInputTokens: sql<number>`coalesce(sum(${usageRecords.cachedInputTokens}), 0)::double precision`,
        reportedUsd: sql<number>`coalesce(sum(${usageRecords.reportedCostUsd}), 0)::double precision`,
        estimatedUsd: sql<number>`coalesce(sum(${usageRecords.estimatedCostUsd}), 0)::double precision`,
        unknownCount: sql<number>`count(*) filter (where ${usageRecords.costBasis} = 'unknown')::int`,
        recordCount: sql<number>`count(*)::int`,
        failedCount: sql<number>`count(*) filter (where ${usageRecords.failed})::int`,
        retryCount: sql<number>`coalesce(sum(${usageRecords.retryCount}), 0)::int`,
        durationMs: sql<number>`coalesce(sum(${usageRecords.durationMs}), 0)::double precision`,
      })
      .from(usageRecords)
      .where(usageWhere(filter))
      .groupBy(sql`coalesce(${usageRecords.modelName}, 'unknown')`)
      .orderBy(desc(sql`count(*)`));

    return rows.map((row) => ({
      modelName: String(row.modelName),
      totals: {
        inputTokens: Number(row.inputTokens),
        outputTokens: Number(row.outputTokens),
        cachedInputTokens: Number(row.cachedInputTokens),
        reportedUsd: Number(row.reportedUsd),
        estimatedUsd: Number(row.estimatedUsd),
        unknownCount: Number(row.unknownCount),
        recordCount: Number(row.recordCount),
        failedCount: Number(row.failedCount),
        retryCount: Number(row.retryCount),
        durationMs: Number(row.durationMs),
      } satisfies UsageTotals,
    }));
  }

  async prune(before: Date): Promise<number> {
    const rows = await this.db
      .delete(usageRecords)
      .where(lt(usageRecords.occurredAt, before))
      .returning({ id: usageRecords.id });
    return rows.length;
  }
}

function usageWhere(filter: UsageFilter) {
  const clauses = [];
  if (filter.missionId) clauses.push(eq(usageRecords.missionId, filter.missionId));
  if (filter.taskId) clauses.push(eq(usageRecords.taskId, filter.taskId));
  if (filter.projectId) clauses.push(eq(usageRecords.projectId, filter.projectId));
  if (filter.modelName) clauses.push(eq(usageRecords.modelName, filter.modelName));
  if (filter.from) clauses.push(gte(usageRecords.occurredAt, filter.from));
  if (filter.to) clauses.push(lte(usageRecords.occurredAt, filter.to));
  if (filter.kinds && filter.kinds.length > 0) {
    clauses.push(inArray(usageRecords.kind, [...filter.kinds] as UsageKind[]));
  }
  return clauses.length > 0 ? and(...clauses) : undefined;
}

function toUsageRecord(row: typeof usageRecords.$inferSelect): UsageRecord {
  return {
    id: row.id,
    kind: row.kind,
    providerName: row.providerName,
    modelName: row.modelName,
    missionId: row.missionId,
    taskId: row.taskId,
    runId: row.runId,
    projectId: row.projectId,
    repositoryFullName: row.repositoryFullName,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    cachedInputTokens: row.cachedInputTokens,
    reportedCostUsd: row.reportedCostUsd,
    estimatedCostUsd: row.estimatedCostUsd,
    costBasis: row.costBasis,
    durationMs: row.durationMs,
    retryCount: row.retryCount,
    failed: row.failed,
    failureCode: row.failureCode,
    occurredAt: isoRequired(row.occurredAt),
  };
}

export class DrizzleBudgetRepository implements BudgetRepository {
  constructor(private readonly db: Database) {}

  async upsert(input: BudgetCreateInput): Promise<Budget> {
    const existing = await this.findByTarget(input.scope, input.targetId ?? null);
    if (existing) return this.patch(existing.id, input);

    const [row] = await this.db
      .insert(budgets)
      .values({
        scope: input.scope,
        targetId: input.targetId ?? null,
        targetLabel: input.targetLabel ? boundText(input.targetLabel, 120) : null,
        limitUsd: input.limitUsd ?? null,
        limitOutputTokens: input.limitOutputTokens ?? null,
        warnAtPercent: input.warnAtPercent,
        kind: input.kind,
        enabled: input.enabled ?? true,
        resetPeriod: input.resetPeriod ?? null,
      })
      .returning();
    if (!row) throw new NotFoundError('Budget');
    return toBudget(row);
  }

  async findById(id: string): Promise<Budget | null> {
    const [row] = await this.db.select().from(budgets).where(eq(budgets.id, id)).limit(1);
    return row ? toBudget(row) : null;
  }

  async list(enabledOnly = false): Promise<readonly Budget[]> {
    const rows = await this.db
      .select()
      .from(budgets)
      .where(enabledOnly ? eq(budgets.enabled, true) : undefined)
      .orderBy(budgets.scope, budgets.targetLabel);
    return rows.map((row) => toBudget(row));
  }

  /**
   * Every budget that could bind this piece of work.
   *
   * Global scopes always apply; targeted ones apply when the target matches. Selecting them in
   * one query matters because this runs on the dispatch path — a budget check that costs four
   * round trips is a budget check somebody eventually moves out of the way.
   */
  async applicable(input: {
    readonly projectId?: string | null;
    readonly missionId?: string | null;
    readonly modelName?: string | null;
  }): Promise<readonly Budget[]> {
    const targeted = [];
    if (input.projectId) {
      targeted.push(and(eq(budgets.scope, 'project'), eq(budgets.targetId, input.projectId))!);
    }
    if (input.missionId) {
      targeted.push(and(eq(budgets.scope, 'mission'), eq(budgets.targetId, input.missionId))!);
    }
    if (input.modelName) {
      targeted.push(and(eq(budgets.scope, 'model'), eq(budgets.targetId, input.modelName))!);
    }

    const rows = await this.db
      .select()
      .from(budgets)
      .where(
        and(eq(budgets.enabled, true), or(inArray(budgets.scope, ['day', 'month']), ...targeted)!),
      );
    return rows.map((row) => toBudget(row));
  }

  async patch(id: string, patch: Partial<BudgetCreateInput>): Promise<Budget> {
    const [row] = await this.db
      .update(budgets)
      .set({
        ...(patch.targetLabel !== undefined
          ? { targetLabel: patch.targetLabel ? boundText(patch.targetLabel, 120) : null }
          : {}),
        ...(patch.limitUsd !== undefined ? { limitUsd: patch.limitUsd } : {}),
        ...(patch.limitOutputTokens !== undefined
          ? { limitOutputTokens: patch.limitOutputTokens }
          : {}),
        ...(patch.warnAtPercent !== undefined ? { warnAtPercent: patch.warnAtPercent } : {}),
        ...(patch.kind !== undefined ? { kind: patch.kind } : {}),
        ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
        ...(patch.resetPeriod !== undefined ? { resetPeriod: patch.resetPeriod } : {}),
        updatedAt: new Date(),
      })
      .where(eq(budgets.id, id))
      .returning();
    if (!row) throw new NotFoundError('Budget');
    return toBudget(row);
  }

  async remove(id: string): Promise<void> {
    await this.db.delete(budgets).where(eq(budgets.id, id));
  }

  async recordOverride(input: {
    readonly budgetId: string;
    readonly reason: string;
    readonly previousLimitUsd: number | null;
    readonly newLimitUsd: number | null;
    readonly approvedBy: string;
    readonly expiresAt: Date | null;
  }): Promise<BudgetOverrideRecord> {
    const [row] = await this.db
      .insert(budgetOverrides)
      .values({
        budgetId: input.budgetId,
        reason: boundText(input.reason, 600),
        previousLimitUsd: input.previousLimitUsd,
        newLimitUsd: input.newLimitUsd,
        approvedBy: input.approvedBy,
        expiresAt: input.expiresAt,
      })
      .returning();
    if (!row) throw new NotFoundError('Budget override');
    return toOverride(row);
  }

  async activeOverride(budgetId: string, now: Date): Promise<BudgetOverrideRecord | null> {
    const [row] = await this.db
      .select()
      .from(budgetOverrides)
      .where(
        and(
          eq(budgetOverrides.budgetId, budgetId),
          isNull(budgetOverrides.revokedAt),
          or(isNull(budgetOverrides.expiresAt), gte(budgetOverrides.expiresAt, now))!,
        ),
      )
      .orderBy(desc(budgetOverrides.createdAt))
      .limit(1);
    return row ? toOverride(row) : null;
  }

  async listOverrides(limit = 50): Promise<readonly BudgetOverrideRecord[]> {
    const rows = await this.db
      .select()
      .from(budgetOverrides)
      .orderBy(desc(budgetOverrides.createdAt))
      .limit(limit);
    return rows.map((row) => toOverride(row));
  }

  private async findByTarget(scope: string, targetId: string | null): Promise<Budget | null> {
    const [row] = await this.db
      .select()
      .from(budgets)
      .where(
        and(
          eq(budgets.scope, scope as Budget['scope']),
          targetId === null ? isNull(budgets.targetId) : eq(budgets.targetId, targetId),
        ),
      )
      .limit(1);
    return row ? toBudget(row) : null;
  }
}

function toBudget(row: typeof budgets.$inferSelect): Budget {
  return {
    id: row.id,
    scope: row.scope,
    targetId: row.targetId,
    targetLabel: row.targetLabel,
    limitUsd: row.limitUsd,
    limitOutputTokens: row.limitOutputTokens,
    warnAtPercent: row.warnAtPercent,
    kind: row.kind,
    enabled: row.enabled,
    resetPeriod: row.resetPeriod ?? null,
    createdAt: isoRequired(row.createdAt),
    updatedAt: isoRequired(row.updatedAt),
  };
}

function toOverride(row: typeof budgetOverrides.$inferSelect): BudgetOverrideRecord {
  return {
    id: row.id,
    budgetId: row.budgetId,
    reason: row.reason,
    previousLimitUsd: row.previousLimitUsd,
    newLimitUsd: row.newLimitUsd,
    approvedBy: row.approvedBy,
    expiresAt: iso(row.expiresAt),
    revokedAt: iso(row.revokedAt),
    createdAt: isoRequired(row.createdAt),
  };
}

export class DrizzlePriceRepository implements PriceRepository {
  constructor(private readonly db: Database) {}

  async upsert(price: ModelPrice & { readonly note?: string | null }): Promise<ModelPrice> {
    const values = {
      modelName: price.model,
      inputPerMillionUsd: price.inputUsdPerMillion,
      outputPerMillionUsd: price.outputUsdPerMillion,
      cachedInputPerMillionUsd: price.cachedInputUsdPerMillion,
      note: price.note ? boundText(price.note, 300) : null,
      updatedAt: new Date(),
    };
    const [row] = await this.db
      .insert(modelPrices)
      .values(values)
      .onConflictDoUpdate({ target: modelPrices.modelName, set: values })
      .returning();
    if (!row) throw new NotFoundError('Model price');
    return toPrice(row);
  }

  async all(): Promise<readonly ModelPrice[]> {
    const rows = await this.db.select().from(modelPrices).orderBy(modelPrices.modelName);
    return rows.map((row) => toPrice(row));
  }

  async find(modelName: string): Promise<ModelPrice | null> {
    const [row] = await this.db
      .select()
      .from(modelPrices)
      .where(eq(modelPrices.modelName, modelName))
      .limit(1);
    return row ? toPrice(row) : null;
  }

  async remove(modelName: string): Promise<void> {
    await this.db.delete(modelPrices).where(eq(modelPrices.modelName, modelName));
  }
}

function toPrice(row: typeof modelPrices.$inferSelect): ModelPrice {
  return {
    model: row.modelName,
    inputUsdPerMillion: row.inputPerMillionUsd,
    outputUsdPerMillion: row.outputPerMillionUsd,
    cachedInputUsdPerMillion: row.cachedInputPerMillionUsd,
  };
}

export class DrizzleConnectorRepository implements ConnectorRepository {
  constructor(private readonly db: Database) {}

  async ensure(connectorId: ConnectorId, projectId: string | null): Promise<ConnectorRecord> {
    const existing = await this.find(connectorId, projectId);
    if (existing) return existing;

    const [row] = await this.db
      .insert(connectors)
      .values({ connectorId, projectId, state: 'disabled' })
      .returning();
    if (!row) throw new NotFoundError('Connector');
    return toConnector(row);
  }

  async find(connectorId: ConnectorId, projectId: string | null): Promise<ConnectorRecord | null> {
    const [row] = await this.db
      .select()
      .from(connectors)
      .where(
        and(
          eq(connectors.connectorId, connectorId),
          projectId === null ? isNull(connectors.projectId) : eq(connectors.projectId, projectId),
        ),
      )
      .limit(1);
    return row ? toConnector(row) : null;
  }

  async list(): Promise<readonly ConnectorRecord[]> {
    const rows = await this.db.select().from(connectors).orderBy(connectors.connectorId);
    return rows.map((row) => toConnector(row));
  }

  async setState(input: {
    readonly connectorId: ConnectorId;
    readonly projectId: string | null;
    readonly state: ConnectorState;
    readonly actor: string;
    readonly reason?: string | null;
    readonly now: Date;
  }): Promise<ConnectorRecord> {
    await this.ensure(input.connectorId, input.projectId);
    const [row] = await this.db
      .update(connectors)
      .set({
        state: input.state,
        ...(input.state === 'enabled'
          ? { enabledAt: input.now, enabledBy: input.actor, revokedAt: null, revokedReason: null }
          : {}),
        ...(input.state === 'revoked'
          ? {
              revokedAt: input.now,
              revokedReason: input.reason ? boundText(input.reason, 300) : null,
              credentialConfigured: false,
              credentialIdentity: null,
            }
          : {}),
        updatedAt: input.now,
      })
      .where(this.match(input.connectorId, input.projectId))
      .returning();
    if (!row) throw new NotFoundError('Connector');
    return toConnector(row);
  }

  async recordCredential(input: {
    readonly connectorId: ConnectorId;
    readonly projectId: string | null;
    readonly configured: boolean;
    readonly identity: string | null;
    readonly rotatedAt: Date | null;
  }): Promise<ConnectorRecord> {
    await this.ensure(input.connectorId, input.projectId);
    const [row] = await this.db
      .update(connectors)
      .set({
        credentialConfigured: input.configured,
        /* An identity, never a value. Redacted anyway, because defence in depth is cheap here. */
        credentialIdentity: input.identity ? redactSecrets(boundText(input.identity, 120)) : null,
        credentialRotatedAt: input.rotatedAt,
        updatedAt: new Date(),
      })
      .where(this.match(input.connectorId, input.projectId))
      .returning();
    if (!row) throw new NotFoundError('Connector');
    return toConnector(row);
  }

  async recordOutcome(input: {
    readonly connectorId: ConnectorId;
    readonly projectId: string | null;
    readonly ok: boolean;
    readonly message?: string | null;
    readonly rateLimitedUntil?: Date | null;
    readonly now: Date;
  }): Promise<ConnectorRecord> {
    await this.ensure(input.connectorId, input.projectId);
    const [row] = await this.db
      .update(connectors)
      .set({
        ...(input.ok
          ? { lastSuccessAt: input.now, lastFailureMessage: null }
          : {
              lastFailureAt: input.now,
              lastFailureMessage: input.message
                ? redactSecrets(boundText(input.message, 400))
                : null,
            }),
        ...(input.rateLimitedUntil !== undefined
          ? { rateLimitedUntil: input.rateLimitedUntil }
          : {}),
        updatedAt: input.now,
      })
      .where(this.match(input.connectorId, input.projectId))
      .returning();
    if (!row) throw new NotFoundError('Connector');
    return toConnector(row);
  }

  private match(connectorId: ConnectorId, projectId: string | null) {
    return and(
      eq(connectors.connectorId, connectorId),
      projectId === null ? isNull(connectors.projectId) : eq(connectors.projectId, projectId),
    );
  }
}

function toConnector(row: typeof connectors.$inferSelect): ConnectorRecord {
  return {
    id: row.id,
    connectorId: row.connectorId,
    state: row.state,
    projectId: row.projectId,
    credentialConfigured: row.credentialConfigured,
    credentialIdentity: row.credentialIdentity,
    credentialRotatedAt: iso(row.credentialRotatedAt),
    lastSuccessAt: iso(row.lastSuccessAt),
    lastFailureAt: iso(row.lastFailureAt),
    lastFailureMessage: row.lastFailureMessage,
    rateLimitedUntil: iso(row.rateLimitedUntil),
    enabledAt: iso(row.enabledAt),
    enabledBy: row.enabledBy,
    revokedAt: iso(row.revokedAt),
    revokedReason: row.revokedReason,
    createdAt: isoRequired(row.createdAt),
    updatedAt: isoRequired(row.updatedAt),
  };
}

export class DrizzleRateLimitRepository implements RateLimitRepository {
  constructor(private readonly db: Database) {}

  /**
   * Count one request and decide.
   *
   * The whole thing is one statement: insert the bucket at count 1, or increment it if it is
   * already there, and return the resulting count. Two simultaneous requests therefore get 1 and
   * 2 rather than both getting 1 — which is the entire reason a rate limiter cannot be a
   * read-then-write pair.
   *
   * The window is part of the key, so a bucket never needs resetting: the next window is simply a
   * different row, and `sweep` deletes the old ones.
   */
  async hit(input: {
    readonly key: string;
    readonly limit: number;
    readonly windowSeconds: number;
    readonly now: Date;
  }): Promise<RateVerdictRecord> {
    const windowMs = input.windowSeconds * 1000;
    const windowStart = new Date(Math.floor(input.now.getTime() / windowMs) * windowMs);
    const bucketKey = `${input.key}#${windowStart.toISOString()}`;

    const [row] = await this.db
      .insert(rateLimitBuckets)
      .values({ bucketKey, windowStartedAt: windowStart, count: 1 })
      .onConflictDoUpdate({
        target: rateLimitBuckets.bucketKey,
        set: { count: sql`${rateLimitBuckets.count} + 1`, updatedAt: input.now },
      })
      .returning({ count: rateLimitBuckets.count });

    const count = Number(row?.count ?? 1);
    const elapsed = Math.floor((input.now.getTime() - windowStart.getTime()) / 1000);
    return {
      allowed: count <= input.limit,
      count,
      limit: input.limit,
      retryAfterSeconds: Math.max(1, input.windowSeconds - elapsed),
    };
  }

  async sweep(before: Date): Promise<number> {
    const rows = await this.db
      .delete(rateLimitBuckets)
      .where(lt(rateLimitBuckets.windowStartedAt, before))
      .returning({ bucketKey: rateLimitBuckets.bucketKey });
    return rows.length;
  }
}

/**
 * The advisory-lock key the audit chain serialises on.
 *
 * An arbitrary constant, chosen once and never derived from anything that could collide with a
 * different subsystem's lock. Transaction-scoped, so it is always released.
 */
const AUDIT_CHAIN_LOCK = 4_915_231;

export class DrizzleAuditRepository implements AuditRepository {
  constructor(private readonly db: Database) {}

  /**
   * Append one record and link it to the chain.
   *
   * Three things make this correct rather than merely plausible:
   *
   *  - **An advisory lock.** Two transactions that each read the current head under READ
   *    COMMITTED would both see the same predecessor and the chain would fork. `FOR UPDATE` on
   *    the head does not help — a row lock cannot make a *newly inserted* row visible to the
   *    query that already ran. A transaction-scoped advisory lock serialises the appends, and it
   *    is released automatically whether the transaction commits or rolls back.
   *  - **The sequence is drawn first.** `nextval` is called before the row is written, so the
   *    hash covers a sequence number that is already known. The alternative — inserting a
   *    placeholder hash and updating it once the serial is assigned — leaves a row reading
   *    `pending` behind if the process dies in between, permanently breaking the chain.
   *  - **One insert.** With the sequence and the predecessor both in hand, the record is written
   *    complete. There is no window in which a half-formed link exists.
   *
   * `detail` is redacted and bounded here rather than by callers. One choke point is the only
   * kind that holds.
   */
  async append(input: AuditAppendInput): Promise<AuditEventRecord> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(${AUDIT_CHAIN_LOCK})`);

      const [head] = await tx
        .select({ hash: auditEvents.hash })
        .from(auditEvents)
        .orderBy(desc(auditEvents.sequence))
        .limit(1);

      const allocated = await tx.execute(
        sql`select nextval('audit_events_sequence_seq') as sequence`,
      );
      const sequence = Number(firstValue(allocated, 'sequence'));

      const link = {
        sequence,
        id: randomUUID(),
        actor: boundText(input.actor, 120),
        actorKind: input.actorKind,
        action: input.action,
        subjectKind: input.subjectKind ?? null,
        subjectId: input.subjectId ?? null,
        projectId: input.projectId ?? null,
        missionId: input.missionId ?? null,
        outcome: input.outcome,
        rule: input.rule ?? null,
        summary: redactSecrets(boundText(input.summary, 400)),
        detail: redactDeep(input.detail ?? {}) as Record<string, unknown>,
        occurredAt: new Date().toISOString(),
        previousHash: head?.hash ?? null,
      };

      const [row] = await tx
        .insert(auditEvents)
        .values({ ...link, occurredAt: new Date(link.occurredAt), hash: auditHash(link) })
        .returning();
      if (!row) throw new NotFoundError('Audit event');
      return toAuditRecord(row);
    });
  }

  async list(
    input: {
      readonly actions?: readonly string[];
      readonly from?: Date;
      readonly to?: Date;
      readonly limit?: number;
    } = {},
  ): Promise<readonly AuditEventRecord[]> {
    const clauses = [];
    if (input.actions && input.actions.length > 0) {
      clauses.push(inArray(auditEvents.action, [...input.actions]));
    }
    if (input.from) clauses.push(gte(auditEvents.occurredAt, input.from));
    if (input.to) clauses.push(lte(auditEvents.occurredAt, input.to));

    const rows = await this.db
      .select()
      .from(auditEvents)
      .where(clauses.length > 0 ? and(...clauses) : undefined)
      .orderBy(desc(auditEvents.sequence))
      .limit(input.limit ?? 100);
    return rows.map((row) => toAuditRecord(row));
  }

  async verifyChain(limit = 1000): Promise<AuditChainVerdict> {
    const rows = await this.db
      .select()
      .from(auditEvents)
      .orderBy(desc(auditEvents.sequence))
      .limit(limit);
    const links: ChainLink[] = rows.reverse().map((row) => toChainLink(row));
    return verifyChain(links);
  }

  async count(): Promise<number> {
    const [row] = await this.db.select({ count: sql<number>`count(*)::int` }).from(auditEvents);
    return Number(row?.count ?? 0);
  }
}

function toChainLink(row: typeof auditEvents.$inferSelect): ChainLink {
  return {
    sequence: Number(row.sequence),
    id: row.id,
    actor: row.actor,
    actorKind: row.actorKind,
    action: row.action,
    subjectKind: row.subjectKind,
    subjectId: row.subjectId,
    projectId: row.projectId,
    missionId: row.missionId,
    outcome: row.outcome,
    rule: row.rule,
    summary: row.summary,
    detail: row.detail ?? {},
    occurredAt: new Date(row.occurredAt).toISOString(),
    previousHash: row.previousHash,
    hash: row.hash,
  };
}

function toAuditRecord(row: typeof auditEvents.$inferSelect): AuditEventRecord {
  return {
    sequence: Number(row.sequence),
    id: row.id,
    actor: row.actor,
    actorKind: row.actorKind as AuditEventRecord['actorKind'],
    action: row.action,
    subjectKind: row.subjectKind,
    subjectId: row.subjectId,
    projectId: row.projectId,
    missionId: row.missionId,
    outcome: row.outcome,
    rule: row.rule,
    summary: row.summary,
    detail: row.detail ?? {},
    previousHash: row.previousHash,
    hash: row.hash,
    occurredAt: isoRequired(row.occurredAt),
  };
}

export class DrizzleDeletionReceiptRepository implements DeletionReceiptRepository {
  constructor(private readonly db: Database) {}

  async record(
    input: Omit<DeletionReceiptRecord, 'id' | 'createdAt'>,
  ): Promise<DeletionReceiptRecord> {
    const [row] = await this.db
      .insert(deletionReceipts)
      .values({
        subjectKind: input.subjectKind,
        subjectId: input.subjectId,
        reason: boundText(input.reason, 400),
        itemCount: input.itemCount,
        requestedBy: input.requestedBy,
        scrubbedTargets: [...input.scrubbedTargets],
      })
      .returning();
    if (!row) throw new NotFoundError('Deletion receipt');
    return toReceipt(row);
  }

  async list(limit = 100): Promise<readonly DeletionReceiptRecord[]> {
    const rows = await this.db
      .select()
      .from(deletionReceipts)
      .orderBy(desc(deletionReceipts.createdAt))
      .limit(limit);
    return rows.map((row) => toReceipt(row));
  }
}

function toReceipt(row: typeof deletionReceipts.$inferSelect): DeletionReceiptRecord {
  return {
    id: row.id,
    subjectKind: row.subjectKind,
    subjectId: row.subjectId,
    reason: row.reason,
    itemCount: row.itemCount,
    requestedBy: row.requestedBy,
    scrubbedTargets: row.scrubbedTargets ?? [],
    createdAt: isoRequired(row.createdAt),
  };
}

/** Pull one column out of a raw result, whichever shape the driver returned it in. */
function firstValue(result: unknown, column: string): unknown {
  const rows = Array.isArray(result)
    ? result
    : result && typeof result === 'object' && 'rows' in result
      ? ((result as { rows: unknown }).rows as unknown[])
      : [];
  const row = rows[0];
  if (row && typeof row === 'object') return (row as Record<string, unknown>)[column];
  return undefined;
}
