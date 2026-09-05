import { and, desc, eq, gte, inArray, isNotNull, isNull, lte, sql } from 'drizzle-orm';
import { NotFoundError } from '@/domain/errors';
import { boundText, redactSecrets } from '@/domain/redaction';
import type { BriefingKind } from '@/domain/briefing';
import type {
  DeliveryState,
  JarvisNotification,
  NotificationCategory,
  NotificationChannel,
  NotificationDelivery,
  NotificationPreference,
  PushSubscription,
} from '@/domain/notification';
import type {
  LiveQualificationEvidence,
  QualificationCheckResult,
  QualificationLevel,
  QualificationRun,
} from '@/domain/qualification';
import { EMPTY_ASSUMPTIONS } from '@/domain/qualification';
import type { Schedule, ScheduleExecution } from '@/domain/schedule';
import type { VoiceCapture } from '@/domain/voice';
import type { Database } from '@/server/db/client';
import {
  briefings,
  liveQualificationEvidence,
  notificationDeliveries,
  notificationPreferences,
  notifications,
  pushSubscriptions,
  qualificationCheckResults,
  qualificationRuns,
  qualificationSuiteResults,
  scheduleExecutions,
  schedules,
  voiceCaptures,
} from '@/server/db/schema';
import {
  toCheckResult,
  toDelivery,
  toExecution,
  toLiveEvidence,
  toNotification,
  toPreference,
  toPushRecord,
  toPushSubscription,
  toSchedule,
  toStoredBriefing,
  toSuiteOutcome,
  toVoiceCapture,
} from './automation-mappers';
import type {
  BriefingCreateInput,
  BriefingRepository,
  ExecutionCreateInput,
  ExecutionPatch,
  LiveEvidenceInput,
  NotificationCreateInput,
  NotificationRepository,
  PreferenceRepository,
  PushRepository,
  PushSubscriptionRecord,
  QualificationCheckInput,
  QualificationRepository,
  QualificationRunCreateInput,
  ScheduleCreateInput,
  SchedulePatch,
  ScheduleRepository,
  StoredBriefing,
  SuiteOutcome,
  VoiceCreateInput,
  VoicePatch,
  VoiceRepository,
} from './automation-types';

/**
 * Persistence for qualification, scheduling, briefings, notifications and voice.
 *
 * Three methods here carry real weight:
 *
 *  - `claimOccurrence` inserts with `on conflict do nothing` and reports null when the row was
 *    already there. That single statement is the whole durability guarantee for scheduling.
 *  - `upsert` on notifications collapses into an open row rather than inserting, using the same
 *    partial unique index the schema declares.
 *  - `recordCheck` upserts per (run, check) so a re-run of one check replaces its result instead
 *    of appending a second, contradictory answer to the same question.
 */

const DEFAULT_LIMIT = 100;

export class DrizzleQualificationRepository implements QualificationRepository {
  constructor(private readonly db: Database) {}

  async createRun(input: QualificationRunCreateInput): Promise<QualificationRun> {
    const [row] = await this.db
      .insert(qualificationRuns)
      .values({
        startedBy: input.startedBy,
        buildRef: input.buildRef ?? null,
        assumptions: input.assumptions,
        note: input.note ? boundText(input.note, 1000) : null,
        qualificationVersion: input.qualificationVersion,
      })
      .returning();
    if (!row) throw new NotFoundError('Qualification run');
    return { ...this.shell(row), results: [] };
  }

  async recordCheck(
    runId: string,
    input: QualificationCheckInput,
  ): Promise<QualificationCheckResult> {
    /*
     * Every stored string passes through redaction. A check that talks to a provider can end up
     * with an error message containing a token; the honest place to stop that is on the way in,
     * once, rather than at each of the several places these rows are later read.
     */
    const detail = redactSecrets(boundText(input.detail, 600));
    const evidence = Object.fromEntries(
      Object.entries(input.evidence).map(([key, value]) => [
        key,
        redactSecrets(boundText(String(value), 200)),
      ]),
    );

    const [row] = await this.db
      .insert(qualificationCheckResults)
      .values({
        runId,
        checkId: input.id,
        outcome: input.outcome,
        detail,
        evidence,
        waivedReason: input.waivedReason ? boundText(input.waivedReason, 400) : null,
        durationMs: input.durationMs ?? null,
      })
      .onConflictDoUpdate({
        target: [qualificationCheckResults.runId, qualificationCheckResults.checkId],
        set: {
          outcome: input.outcome,
          detail,
          evidence,
          waivedReason: input.waivedReason ? boundText(input.waivedReason, 400) : null,
          durationMs: input.durationMs ?? null,
          checkedAt: new Date(),
        },
      })
      .returning();
    if (!row) throw new NotFoundError('Qualification check');
    return toCheckResult(row);
  }

  async finishRun(
    runId: string,
    level: QualificationLevel,
    finishedAt: Date,
  ): Promise<QualificationRun> {
    const [row] = await this.db
      .update(qualificationRuns)
      .set({ level, finishedAt })
      .where(eq(qualificationRuns.id, runId))
      .returning();
    if (!row) throw new NotFoundError('Qualification run');
    return this.hydrate(row);
  }

  async findRun(id: string): Promise<QualificationRun | null> {
    const [row] = await this.db
      .select()
      .from(qualificationRuns)
      .where(eq(qualificationRuns.id, id))
      .limit(1);
    return row ? this.hydrate(row) : null;
  }

  async latestRun(): Promise<QualificationRun | null> {
    const [row] = await this.db
      .select()
      .from(qualificationRuns)
      .where(isNull(qualificationRuns.supersededAt))
      .orderBy(desc(qualificationRuns.startedAt))
      .limit(1);
    return row ? this.hydrate(row) : null;
  }

  async listRuns(limit = 20): Promise<readonly QualificationRun[]> {
    const rows = await this.db
      .select()
      .from(qualificationRuns)
      .orderBy(desc(qualificationRuns.startedAt))
      .limit(limit);
    return Promise.all(rows.map((row) => this.hydrate(row)));
  }

  async supersedeOlderThan(runId: string, now: Date): Promise<number> {
    const [current] = await this.db
      .select({ startedAt: qualificationRuns.startedAt })
      .from(qualificationRuns)
      .where(eq(qualificationRuns.id, runId))
      .limit(1);
    if (!current) return 0;

    const rows = await this.db
      .update(qualificationRuns)
      .set({ supersededAt: now })
      .where(
        and(
          isNull(qualificationRuns.supersededAt),
          lte(qualificationRuns.startedAt, current.startedAt),
          sql`${qualificationRuns.id} <> ${runId}`,
        ),
      )
      .returning({ id: qualificationRuns.id });
    return rows.length;
  }

  async recordSuiteOutcome(input: Omit<SuiteOutcome, 'recordedAt'>): Promise<SuiteOutcome> {
    const [row] = await this.db
      .insert(qualificationSuiteResults)
      .values({
        kind: input.kind,
        passed: input.passed,
        buildRef: input.buildRef,
        detail: boundText(input.detail, 600),
        testCount: input.testCount,
      })
      .onConflictDoUpdate({
        target: qualificationSuiteResults.kind,
        set: {
          passed: input.passed,
          buildRef: input.buildRef,
          detail: boundText(input.detail, 600),
          testCount: input.testCount,
          recordedAt: new Date(),
        },
      })
      .returning();
    if (!row) throw new NotFoundError('Suite outcome');
    return toSuiteOutcome(row);
  }

  async suiteOutcomes(): Promise<readonly SuiteOutcome[]> {
    const rows = await this.db.select().from(qualificationSuiteResults);
    return rows.map((row) => toSuiteOutcome(row));
  }

  async recordLiveEvidence(input: LiveEvidenceInput): Promise<LiveQualificationEvidence> {
    const [row] = await this.db
      .insert(liveQualificationEvidence)
      .values({
        kind: input.kind,
        runId: input.runId,
        missionId: input.missionId ?? null,
        providerName: input.providerName ?? null,
        modelName: input.modelName ?? null,
        repositoryFullName: input.repositoryFullName,
        commitSha: input.commitSha ?? null,
        branchName: input.branchName ?? null,
        pullRequestUrl: input.pullRequestUrl ?? null,
        pullRequestNumber: input.pullRequestNumber ?? null,
        findingsCount: input.findingsCount ?? null,
        outputTokens: input.outputTokens ?? null,
        durationMs: input.durationMs ?? null,
        qualificationVersion: input.qualificationVersion,
        summary: redactSecrets(boundText(input.summary, 600)),
      })
      .returning();
    if (!row) throw new NotFoundError('Live qualification evidence');
    return toLiveEvidence(row);
  }

  async listLiveEvidence(limit = 20): Promise<readonly LiveQualificationEvidence[]> {
    const rows = await this.db
      .select()
      .from(liveQualificationEvidence)
      .orderBy(desc(liveQualificationEvidence.performedAt))
      .limit(limit);
    return rows.map((row) => toLiveEvidence(row));
  }

  private shell(row: typeof qualificationRuns.$inferSelect): Omit<QualificationRun, 'results'> {
    return {
      id: row.id,
      level: row.level,
      startedAt: new Date(row.startedAt).toISOString(),
      finishedAt: row.finishedAt ? new Date(row.finishedAt).toISOString() : null,
      startedBy: row.startedBy,
      buildRef: row.buildRef,
      assumptions: row.assumptions ?? EMPTY_ASSUMPTIONS,
      note: row.note,
      supersededAt: row.supersededAt ? new Date(row.supersededAt).toISOString() : null,
    };
  }

  private async hydrate(row: typeof qualificationRuns.$inferSelect): Promise<QualificationRun> {
    const results = await this.db
      .select()
      .from(qualificationCheckResults)
      .where(eq(qualificationCheckResults.runId, row.id))
      .orderBy(qualificationCheckResults.checkId);
    return { ...this.shell(row), results: results.map((result) => toCheckResult(result)) };
  }
}

export class DrizzleScheduleRepository implements ScheduleRepository {
  constructor(private readonly db: Database) {}

  async create(input: ScheduleCreateInput): Promise<Schedule> {
    const [row] = await this.db
      .insert(schedules)
      .values({
        kind: input.kind,
        name: boundText(input.name, 120),
        cadence: input.cadence,
        hour: input.hour,
        minute: input.minute,
        timeZone: input.timeZone,
        weekday: input.weekday ?? null,
        dayOfMonth: input.dayOfMonth ?? null,
        projectId: input.projectId ?? null,
        catchUp: input.catchUp,
        maxRetries: input.maxRetries,
        instruction: input.instruction ? boundText(input.instruction, 1000) : null,
        enabled: input.enabled ?? true,
        createdBy: input.createdBy,
      })
      .returning();
    if (!row) throw new NotFoundError('Schedule');
    return toSchedule(row);
  }

  async findById(id: string): Promise<Schedule | null> {
    const [row] = await this.db.select().from(schedules).where(eq(schedules.id, id)).limit(1);
    return row ? toSchedule(row) : null;
  }

  async list(includeDisabled = true): Promise<readonly Schedule[]> {
    const rows = await this.db
      .select()
      .from(schedules)
      .where(includeDisabled ? undefined : eq(schedules.enabled, true))
      .orderBy(schedules.hour, schedules.minute, schedules.name);
    return rows.map((row) => toSchedule(row));
  }

  async patch(id: string, patch: SchedulePatch): Promise<Schedule> {
    const [row] = await this.db
      .update(schedules)
      .set({
        ...(patch.name !== undefined ? { name: boundText(patch.name, 120) } : {}),
        ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
        ...(patch.cadence !== undefined ? { cadence: patch.cadence } : {}),
        ...(patch.hour !== undefined ? { hour: patch.hour } : {}),
        ...(patch.minute !== undefined ? { minute: patch.minute } : {}),
        ...(patch.timeZone !== undefined ? { timeZone: patch.timeZone } : {}),
        ...(patch.weekday !== undefined ? { weekday: patch.weekday } : {}),
        ...(patch.dayOfMonth !== undefined ? { dayOfMonth: patch.dayOfMonth } : {}),
        ...(patch.catchUp !== undefined ? { catchUp: patch.catchUp } : {}),
        ...(patch.maxRetries !== undefined ? { maxRetries: patch.maxRetries } : {}),
        ...(patch.instruction !== undefined
          ? { instruction: patch.instruction === null ? null : boundText(patch.instruction, 1000) }
          : {}),
        ...(patch.lastRunAt !== undefined ? { lastRunAt: patch.lastRunAt } : {}),
        ...(patch.lastOccurrenceAt !== undefined
          ? { lastOccurrenceAt: patch.lastOccurrenceAt }
          : {}),
        ...(patch.pausedAt !== undefined ? { pausedAt: patch.pausedAt } : {}),
        ...(patch.pausedReason !== undefined
          ? {
              pausedReason: patch.pausedReason === null ? null : boundText(patch.pausedReason, 300),
            }
          : {}),
        updatedAt: new Date(),
      })
      .where(eq(schedules.id, id))
      .returning();
    if (!row) throw new NotFoundError('Schedule');
    return toSchedule(row);
  }

  async remove(id: string): Promise<void> {
    await this.db.delete(schedules).where(eq(schedules.id, id));
  }

  /**
   * Claim an occurrence.
   *
   * `on conflict do nothing` plus an empty `returning` is the entire concurrency story: whoever
   * inserts first owns the occurrence, and everyone else gets null and does nothing. No lock, no
   * read-then-write window, no possibility of two briefings for one morning.
   */
  async claimOccurrence(input: ExecutionCreateInput): Promise<ScheduleExecution | null> {
    const rows = await this.db
      .insert(scheduleExecutions)
      .values({
        scheduleId: input.scheduleId,
        occurrenceAt: input.occurrenceAt,
        occurrenceLocal: input.occurrenceLocal,
        idempotencyKey: input.idempotencyKey,
        state: input.state,
        summary: input.summary ?? null,
      })
      .onConflictDoNothing({ target: scheduleExecutions.idempotencyKey })
      .returning();
    const row = rows[0];
    return row ? toExecution(row) : null;
  }

  async findExecution(id: string): Promise<ScheduleExecution | null> {
    const [row] = await this.db
      .select()
      .from(scheduleExecutions)
      .where(eq(scheduleExecutions.id, id))
      .limit(1);
    return row ? toExecution(row) : null;
  }

  async patchExecution(id: string, patch: ExecutionPatch): Promise<ScheduleExecution> {
    const [row] = await this.db
      .update(scheduleExecutions)
      .set({
        ...(patch.state !== undefined ? { state: patch.state } : {}),
        ...(patch.startedAt !== undefined ? { startedAt: patch.startedAt } : {}),
        ...(patch.finishedAt !== undefined ? { finishedAt: patch.finishedAt } : {}),
        ...(patch.attempt !== undefined ? { attempt: patch.attempt } : {}),
        ...(patch.nextRetryAt !== undefined ? { nextRetryAt: patch.nextRetryAt } : {}),
        ...(patch.failureCode !== undefined ? { failureCode: patch.failureCode } : {}),
        ...(patch.failureMessage !== undefined
          ? {
              failureMessage:
                patch.failureMessage === null
                  ? null
                  : redactSecrets(boundText(patch.failureMessage, 600)),
            }
          : {}),
        ...(patch.evidenceWindowFrom !== undefined
          ? { evidenceWindowFrom: patch.evidenceWindowFrom }
          : {}),
        ...(patch.evidenceWindowTo !== undefined
          ? { evidenceWindowTo: patch.evidenceWindowTo }
          : {}),
        ...(patch.resultId !== undefined ? { resultId: patch.resultId } : {}),
        ...(patch.summary !== undefined
          ? { summary: patch.summary === null ? null : boundText(patch.summary, 600) }
          : {}),
      })
      .where(eq(scheduleExecutions.id, id))
      .returning();
    if (!row) throw new NotFoundError('Schedule execution');
    return toExecution(row);
  }

  async listExecutions(scheduleId: string, limit = 30): Promise<readonly ScheduleExecution[]> {
    const rows = await this.db
      .select()
      .from(scheduleExecutions)
      .where(eq(scheduleExecutions.scheduleId, scheduleId))
      .orderBy(desc(scheduleExecutions.occurrenceAt))
      .limit(limit);
    return rows.map((row) => toExecution(row));
  }

  async pendingRetries(now: Date): Promise<readonly ScheduleExecution[]> {
    const rows = await this.db
      .select()
      .from(scheduleExecutions)
      .where(
        and(
          eq(scheduleExecutions.state, 'failed'),
          isNotNull(scheduleExecutions.nextRetryAt),
          lte(scheduleExecutions.nextRetryAt, now),
        ),
      )
      .orderBy(scheduleExecutions.nextRetryAt)
      .limit(20);
    return rows.map((row) => toExecution(row));
  }

  async recentExecutions(limit = 40): Promise<readonly ScheduleExecution[]> {
    const rows = await this.db
      .select()
      .from(scheduleExecutions)
      .orderBy(desc(scheduleExecutions.occurrenceAt))
      .limit(limit);
    return rows.map((row) => toExecution(row));
  }
}

export class DrizzleBriefingRepository implements BriefingRepository {
  constructor(private readonly db: Database) {}

  async create(input: BriefingCreateInput): Promise<StoredBriefing> {
    const [row] = await this.db
      .insert(briefings)
      .values({
        kind: input.kind,
        executionId: input.executionId ?? null,
        projectId: input.projectId ?? null,
        windowFrom: input.windowFrom,
        windowTo: input.windowTo,
        content: input.content,
        narration: input.narration ?? null,
        narrationRule: input.narrationRule ?? null,
        method: input.method,
        isQuiet: input.isQuiet,
      })
      .returning();
    if (!row) throw new NotFoundError('Briefing');
    return toStoredBriefing(row);
  }

  async findById(id: string): Promise<StoredBriefing | null> {
    const [row] = await this.db.select().from(briefings).where(eq(briefings.id, id)).limit(1);
    return row ? toStoredBriefing(row) : null;
  }

  async latest(kind?: BriefingKind, projectId?: string | null): Promise<StoredBriefing | null> {
    const clauses = [];
    if (kind) clauses.push(eq(briefings.kind, kind));
    if (projectId !== undefined) {
      clauses.push(
        projectId === null ? isNull(briefings.projectId) : eq(briefings.projectId, projectId),
      );
    }
    const [row] = await this.db
      .select()
      .from(briefings)
      .where(clauses.length > 0 ? and(...clauses) : undefined)
      .orderBy(desc(briefings.createdAt))
      .limit(1);
    return row ? toStoredBriefing(row) : null;
  }

  async list(limit = 30): Promise<readonly StoredBriefing[]> {
    const rows = await this.db
      .select()
      .from(briefings)
      .orderBy(desc(briefings.createdAt))
      .limit(limit);
    return rows.map((row) => toStoredBriefing(row));
  }

  async markRead(id: string, now: Date): Promise<StoredBriefing> {
    const [row] = await this.db
      .update(briefings)
      .set({ readAt: now })
      .where(eq(briefings.id, id))
      .returning();
    if (!row) throw new NotFoundError('Briefing');
    return toStoredBriefing(row);
  }
}

export class DrizzleNotificationRepository implements NotificationRepository {
  constructor(private readonly db: Database) {}

  /**
   * Create, or collapse into an open notification with the same dedupe key.
   *
   * The `where` on the update is what makes this correct rather than merely convenient: the
   * partial unique index only covers unacknowledged rows, so an acknowledged problem recurring
   * tomorrow is a new notification rather than a resurrected one.
   */
  async upsert(
    input: NotificationCreateInput,
    now: Date,
  ): Promise<{ readonly notification: JarvisNotification; readonly collapsed: boolean }> {
    /*
     * Insert first and let the index decide, rather than reading and then writing. A
     * select-then-insert pair has a window in which two callers both see nothing and both
     * insert; one of them then hits the partial unique index and throws, turning a duplicate
     * warning into a failed operation. Here the insert simply does nothing and the collapse
     * path takes over — the conflict target repeats the index's own predicate so Postgres can
     * infer it.
     */
    const inserted = await this.db
      .insert(notifications)
      .values({
        category: input.category,
        severity: input.severity,
        title: boundText(input.title, 200),
        body: input.body ? boundText(input.body, 600) : null,
        projectId: input.projectId ?? null,
        missionId: input.missionId ?? null,
        href: input.href ?? null,
        dedupeKey: input.dedupeKey,
        lastOccurredAt: now,
        expiresAt: input.expiresAt ?? null,
      })
      .onConflictDoNothing({
        target: notifications.dedupeKey,
        where: sql`${notifications.acknowledgedAt} is null`,
      })
      .returning();

    const fresh = inserted[0];
    if (fresh) return { notification: toNotification(fresh), collapsed: false };

    const [row] = await this.db
      .update(notifications)
      .set({
        occurrenceCount: sql`${notifications.occurrenceCount} + 1`,
        lastOccurredAt: now,
        severity: input.severity,
        title: boundText(input.title, 200),
        body: input.body ? boundText(input.body, 600) : null,
        readAt: null,
      })
      .where(
        and(eq(notifications.dedupeKey, input.dedupeKey), isNull(notifications.acknowledgedAt)),
      )
      .returning();
    if (!row) throw new NotFoundError('Notification');
    return { notification: toNotification(row), collapsed: true };
  }

  async findById(id: string): Promise<JarvisNotification | null> {
    const [row] = await this.db
      .select()
      .from(notifications)
      .where(eq(notifications.id, id))
      .limit(1);
    return row ? toNotification(row) : null;
  }

  async list(
    input: {
      readonly unreadOnly?: boolean;
      readonly categories?: readonly NotificationCategory[];
      readonly limit?: number;
    } = {},
  ): Promise<readonly JarvisNotification[]> {
    const clauses = [];
    if (input.unreadOnly) clauses.push(isNull(notifications.readAt));
    if (input.categories && input.categories.length > 0) {
      clauses.push(inArray(notifications.category, [...input.categories]));
    }
    const rows = await this.db
      .select()
      .from(notifications)
      .where(clauses.length > 0 ? and(...clauses) : undefined)
      .orderBy(desc(notifications.lastOccurredAt))
      .limit(input.limit ?? DEFAULT_LIMIT);
    return rows.map((row) => toNotification(row));
  }

  async unreadCount(): Promise<number> {
    const [row] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(notifications)
      .where(isNull(notifications.readAt));
    return Number(row?.count ?? 0);
  }

  async markRead(id: string, now: Date): Promise<JarvisNotification> {
    return this.setOne(id, { readAt: now });
  }

  async markUnread(id: string): Promise<JarvisNotification> {
    return this.setOne(id, { readAt: null });
  }

  async acknowledge(id: string, now: Date): Promise<JarvisNotification> {
    return this.setOne(id, { acknowledgedAt: now, readAt: now });
  }

  async markAllRead(now: Date): Promise<number> {
    const rows = await this.db
      .update(notifications)
      .set({ readAt: now })
      .where(isNull(notifications.readAt))
      .returning({ id: notifications.id });
    return rows.length;
  }

  async countSince(category: NotificationCategory, since: Date): Promise<number> {
    const [row] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(notifications)
      .where(and(eq(notifications.category, category), gte(notifications.lastOccurredAt, since)));
    return Number(row?.count ?? 0);
  }

  async expire(now: Date): Promise<number> {
    const rows = await this.db
      .update(notifications)
      .set({ acknowledgedAt: now })
      .where(and(isNotNull(notifications.expiresAt), lte(notifications.expiresAt, now)))
      .returning({ id: notifications.id });
    return rows.length;
  }

  async recordDelivery(input: {
    readonly notificationId: string;
    readonly channel: NotificationChannel;
    readonly state: DeliveryState;
    readonly attempt: number;
    readonly deliveredAt?: Date | null;
    readonly failureMessage?: string | null;
    readonly suppressedReason?: string | null;
  }): Promise<NotificationDelivery> {
    const values = {
      notificationId: input.notificationId,
      channel: input.channel,
      state: input.state,
      attempt: input.attempt,
      deliveredAt: input.deliveredAt ?? null,
      failureMessage: input.failureMessage
        ? redactSecrets(boundText(input.failureMessage, 400))
        : null,
      suppressedReason: input.suppressedReason ?? null,
    };
    const [row] = await this.db
      .insert(notificationDeliveries)
      .values(values)
      .onConflictDoUpdate({
        target: [notificationDeliveries.notificationId, notificationDeliveries.channel],
        set: {
          state: values.state,
          attempt: values.attempt,
          deliveredAt: values.deliveredAt,
          failureMessage: values.failureMessage,
          suppressedReason: values.suppressedReason,
        },
      })
      .returning();
    if (!row) throw new NotFoundError('Notification delivery');
    return toDelivery(row);
  }

  async listDeliveries(notificationId: string): Promise<readonly NotificationDelivery[]> {
    const rows = await this.db
      .select()
      .from(notificationDeliveries)
      .where(eq(notificationDeliveries.notificationId, notificationId));
    return rows.map((row) => toDelivery(row));
  }

  private async setOne(
    id: string,
    patch: Partial<typeof notifications.$inferInsert>,
  ): Promise<JarvisNotification> {
    const [row] = await this.db
      .update(notifications)
      .set(patch)
      .where(eq(notifications.id, id))
      .returning();
    if (!row) throw new NotFoundError('Notification');
    return toNotification(row);
  }
}

export class DrizzlePreferenceRepository implements PreferenceRepository {
  constructor(private readonly db: Database) {}

  async all(): Promise<readonly NotificationPreference[]> {
    const rows = await this.db.select().from(notificationPreferences);
    return rows.map((row) => toPreference(row));
  }

  async upsert(preference: NotificationPreference): Promise<NotificationPreference> {
    const values = {
      category: preference.category,
      channels: [...preference.channels],
      minSeverity: preference.minSeverity,
      digest: preference.digest,
      enabled: preference.enabled,
      projectIds: [...preference.projectIds],
      updatedAt: new Date(),
    };
    const [row] = await this.db
      .insert(notificationPreferences)
      .values(values)
      .onConflictDoUpdate({ target: notificationPreferences.category, set: values })
      .returning();
    if (!row) throw new NotFoundError('Notification preference');
    return toPreference(row);
  }
}

export class DrizzlePushRepository implements PushRepository {
  constructor(private readonly db: Database) {}

  async register(input: {
    readonly endpoint: string;
    readonly endpointHash: string;
    readonly keyP256dh: string;
    readonly keyAuth: string;
    readonly label?: string | null;
    readonly userAgent?: string | null;
  }): Promise<PushSubscription> {
    const values = {
      endpoint: input.endpoint,
      endpointHash: input.endpointHash,
      keyP256dh: input.keyP256dh,
      keyAuth: input.keyAuth,
      label: input.label ? boundText(input.label, 60) : null,
      userAgent: input.userAgent ? boundText(input.userAgent, 300) : null,
    };
    const [row] = await this.db
      .insert(pushSubscriptions)
      .values(values)
      .onConflictDoUpdate({
        target: pushSubscriptions.endpointHash,
        set: { ...values, failureCount: 0, revokedAt: null },
      })
      .returning();
    if (!row) throw new NotFoundError('Push subscription');
    return toPushSubscription(row);
  }

  async list(): Promise<readonly PushSubscription[]> {
    const rows = await this.db
      .select()
      .from(pushSubscriptions)
      .orderBy(desc(pushSubscriptions.createdAt));
    return rows.map((row) => toPushSubscription(row));
  }

  async active(): Promise<readonly PushSubscriptionRecord[]> {
    const rows = await this.db
      .select()
      .from(pushSubscriptions)
      .where(isNull(pushSubscriptions.revokedAt));
    return rows.map((row) => toPushRecord(row));
  }

  async recordFailure(id: string, revoke: boolean, now: Date): Promise<void> {
    await this.db
      .update(pushSubscriptions)
      .set({
        failureCount: sql`${pushSubscriptions.failureCount} + 1`,
        ...(revoke ? { revokedAt: now } : {}),
      })
      .where(eq(pushSubscriptions.id, id));
  }

  async recordSuccess(id: string, now: Date): Promise<void> {
    await this.db
      .update(pushSubscriptions)
      .set({ lastUsedAt: now, failureCount: 0 })
      .where(eq(pushSubscriptions.id, id));
  }

  async revoke(id: string, now: Date): Promise<void> {
    /*
     * Revoking clears the credential material as well as setting the date. A revoked
     * subscription that still holds a usable key is a revocation in name only.
     */
    await this.db
      .update(pushSubscriptions)
      .set({ revokedAt: now, endpoint: '', keyP256dh: '', keyAuth: '' })
      .where(eq(pushSubscriptions.id, id));
  }
}

export class DrizzleVoiceRepository implements VoiceRepository {
  constructor(private readonly db: Database) {}

  async create(input: VoiceCreateInput): Promise<VoiceCapture> {
    const [row] = await this.db
      .insert(voiceCaptures)
      .values({
        state: 'awaiting_confirmation',
        transcript: redactSecrets(boundText(input.transcript, 4000)),
        intent: input.intent,
        projectId: input.projectId ?? null,
        durationMs: input.durationMs ?? null,
        byteSize: input.byteSize ?? null,
        providerName: input.providerName ?? null,
        confidence: input.confidence ?? null,
        audioRetained: input.audioRetained ?? false,
        audioDeleteAfter: input.audioDeleteAfter ?? null,
      })
      .returning();
    if (!row) throw new NotFoundError('Voice capture');
    return toVoiceCapture(row);
  }

  async findById(id: string): Promise<VoiceCapture | null> {
    const [row] = await this.db
      .select()
      .from(voiceCaptures)
      .where(eq(voiceCaptures.id, id))
      .limit(1);
    return row ? toVoiceCapture(row) : null;
  }

  async patch(id: string, patch: VoicePatch): Promise<VoiceCapture> {
    const [row] = await this.db
      .update(voiceCaptures)
      .set({
        ...(patch.state !== undefined ? { state: patch.state } : {}),
        ...(patch.editedTranscript !== undefined
          ? {
              editedTranscript:
                patch.editedTranscript === null
                  ? null
                  : redactSecrets(boundText(patch.editedTranscript, 4000)),
            }
          : {}),
        ...(patch.intent !== undefined ? { intent: patch.intent } : {}),
        ...(patch.projectId !== undefined ? { projectId: patch.projectId } : {}),
        ...(patch.failureCode !== undefined ? { failureCode: patch.failureCode } : {}),
        ...(patch.failureMessage !== undefined
          ? {
              failureMessage:
                patch.failureMessage === null
                  ? null
                  : redactSecrets(boundText(patch.failureMessage, 400)),
            }
          : {}),
        ...(patch.confirmedAt !== undefined ? { confirmedAt: patch.confirmedAt } : {}),
        ...(patch.resultKind !== undefined ? { resultKind: patch.resultKind } : {}),
        ...(patch.resultId !== undefined ? { resultId: patch.resultId } : {}),
        ...(patch.audioRetained !== undefined ? { audioRetained: patch.audioRetained } : {}),
        ...(patch.audioDeleteAfter !== undefined
          ? { audioDeleteAfter: patch.audioDeleteAfter }
          : {}),
      })
      .where(eq(voiceCaptures.id, id))
      .returning();
    if (!row) throw new NotFoundError('Voice capture');
    return toVoiceCapture(row);
  }

  async recent(limit = 20): Promise<readonly VoiceCapture[]> {
    const rows = await this.db
      .select()
      .from(voiceCaptures)
      .orderBy(desc(voiceCaptures.createdAt))
      .limit(limit);
    return rows.map((row) => toVoiceCapture(row));
  }

  async expireRetention(now: Date): Promise<number> {
    const rows = await this.db
      .update(voiceCaptures)
      .set({ audioRetained: false, audioDeleteAfter: null })
      .where(
        and(
          eq(voiceCaptures.audioRetained, true),
          isNotNull(voiceCaptures.audioDeleteAfter),
          lte(voiceCaptures.audioDeleteAfter, now),
        ),
      )
      .returning({ id: voiceCaptures.id });
    return rows.length;
  }
}
