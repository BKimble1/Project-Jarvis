import { and, asc, desc, eq, inArray, isNotNull, isNull, lt, or, sql, type SQL } from 'drizzle-orm';
import { ConflictError, NotFoundError } from '@/domain/errors';
import {
  ACTIVE_MISSION_STATES,
  MISSION_TYPES,
  OWNER_BLOCKED_MISSION_STATES,
  TERMINAL_MISSION_STATES,
  type ClarificationQuestion,
  type ClarificationRecord,
  type Mission,
  type MissionState,
  type MissionUpdateInput,
} from '@/domain/mission';
import type { MissionApproval, MissionPlan } from '@/domain/mission-plan';
import type {
  CommandKind,
  CommandState,
  MissionArtifact,
  MissionCommand,
  MissionEvent,
  MissionEventInput,
  MissionPermissionRequest,
  MissionRun,
  MissionVerification,
  PermissionRequestInput,
  VerificationInput,
  ArtifactInput,
} from '@/domain/mission-run';
import { EVENT_SUMMARY_MAX, VERIFICATION_OUTPUT_MAX } from '@/domain/mission-run';
import { boundText, redactDeep, redactSecrets } from '@/domain/redaction';
import type { JarvisWorker } from '@/domain/worker';
import type { Database } from '@/server/db/client';
import {
  missionApprovals,
  missionArtifacts,
  missionClarifications,
  missionCommands,
  missionEvents,
  missionPermissionRequests,
  missionPlans,
  missionRuns,
  missionVerifications,
  missions,
  workerIdempotency,
  workers,
} from '@/server/db/schema';
import {
  toArtifact,
  toClarification,
  toMission,
  toMissionApproval,
  toMissionCommand,
  toMissionEvent,
  toMissionPlan,
  toMissionRun,
  toPermissionRequest,
  toVerification,
  toCapacityObservation,
  toWorker,
} from './mission-mappers';
import type {
  ApprovalRepository,
  ArtifactRepository,
  ClaimRequest,
  ClaimResult,
  ClarificationRepository,
  CommandRepository,
  ControlPlaneEventInput,
  EventRepository,
  IdempotencyRecord,
  IdempotencyRepository,
  MissionCreateInput,
  MissionListFilter,
  MissionListPage,
  MissionRepository,
  MissionStatePatch,
  PermissionRepository,
  PlanRepository,
  RunRepository,
  VerificationRepository,
  WorkerCapacityReading,
  WorkerRepository,
} from './mission-types';
import type { CapacityObservation } from '@/domain/claude-capacity';

/**
 * Mission Control persistence.
 *
 * Two things here are load-bearing rather than incidental:
 *
 *  - **`claimNext` is one statement.** The concurrency check, the queued-state check and the
 *    write all happen in a single `UPDATE … WHERE id = (SELECT … FOR UPDATE SKIP LOCKED)`, so two
 *    workers cannot both observe "nothing is running" and both start something.
 *  - **`transition` is a compare-and-set.** Passing `expectedState` turns a lost update into a
 *    `null` return, which the service reports as a conflict instead of silently clobbering.
 */

export class DrizzleMissionRepository implements MissionRepository {
  constructor(private readonly db: Database) {}

  async create(input: MissionCreateInput): Promise<Mission> {
    const [row] = await this.db
      .insert(missions)
      .values({
        projectId: input.projectId ?? null,
        ownerLogin: input.ownerLogin,
        rawRequest: input.rawRequest,
        title: input.title,
        description: input.description ?? null,
        type: input.type,
        riskLevel: input.riskLevel,
        riskRuleIds: [...input.riskRuleIds],
        riskReasons: [...input.riskReasons],
        state: input.state,
        priority: input.priority,
        targetDate: input.targetDate ?? null,
        sourceId: input.sourceId ?? null,
        constraints: [...input.constraints],
        doNotTouch: [...input.doNotTouch],
        deliverable: input.deliverable ?? null,
        acceptanceCriteria: [...input.acceptanceCriteria],
      })
      .returning();
    if (!row) throw new NotFoundError('Mission');
    return toMission(row);
  }

  async update(id: string, input: MissionUpdateInput): Promise<Mission> {
    const values: Record<string, unknown> = { updatedAt: new Date() };
    if (input.title !== undefined) values.title = input.title;
    if (input.description !== undefined) values.description = input.description;
    if (input.type !== undefined) values.type = input.type;
    if (input.priority !== undefined) values.priority = input.priority;
    if (input.projectId !== undefined) values.projectId = input.projectId;
    if (input.sourceId !== undefined) values.sourceId = input.sourceId;
    if (input.targetDate !== undefined) values.targetDate = input.targetDate;
    if (input.constraints !== undefined) values.constraints = [...input.constraints];
    if (input.doNotTouch !== undefined) values.doNotTouch = [...input.doNotTouch];
    if (input.deliverable !== undefined) values.deliverable = input.deliverable;
    if (input.acceptanceCriteria !== undefined) {
      values.acceptanceCriteria = [...input.acceptanceCriteria];
    }
    const [row] = await this.db.update(missions).set(values).where(eq(missions.id, id)).returning();
    if (!row) throw new NotFoundError('Mission');
    return toMission(row);
  }

  async findById(id: string): Promise<Mission | null> {
    const [row] = await this.db.select().from(missions).where(eq(missions.id, id)).limit(1);
    return row ? toMission(row) : null;
  }

  async list(filter: MissionListFilter = {}): Promise<MissionListPage> {
    const conditions: SQL[] = [];
    if (filter.states && filter.states.length > 0) {
      conditions.push(inArray(missions.state, [...filter.states]));
    }
    if (filter.projectId) conditions.push(eq(missions.projectId, filter.projectId));
    if (filter.types && filter.types.length > 0) {
      conditions.push(inArray(missions.type, [...filter.types]));
    }
    if (filter.needsOwner) {
      conditions.push(inArray(missions.state, [...OWNER_BLOCKED_MISSION_STATES]));
    }
    if (filter.search) {
      const needle = `%${filter.search.toLowerCase()}%`;
      const clause = or(
        sql`lower(${missions.title}) like ${needle}`,
        sql`lower(${missions.rawRequest}) like ${needle}`,
        sql`${missions.id}::text like ${needle}`,
      );
      if (clause) conditions.push(clause);
    }
    const where = conditions.length > 0 ? and(...conditions) : undefined;

    const rows = await this.db
      .select()
      .from(missions)
      .where(where)
      /* Newest first, with the id as a tiebreak so pagination is stable to the row. */
      .orderBy(desc(missions.createdAt), asc(missions.id))
      .limit(filter.limit ?? 100)
      .offset(filter.offset ?? 0);

    const [count] = await this.db
      .select({ value: sql<number>`count(*)::int` })
      .from(missions)
      .where(where);

    return { items: rows.map(toMission), total: count?.value ?? rows.length };
  }

  async listByProject(projectId: string, limit = 20): Promise<readonly Mission[]> {
    const rows = await this.db
      .select()
      .from(missions)
      .where(eq(missions.projectId, projectId))
      .orderBy(desc(missions.createdAt), asc(missions.id))
      .limit(limit);
    return rows.map(toMission);
  }

  async listActive(): Promise<readonly Mission[]> {
    const rows = await this.db
      .select()
      .from(missions)
      .where(inArray(missions.state, [...ACTIVE_MISSION_STATES]))
      .orderBy(asc(missions.createdAt), asc(missions.id));
    return rows.map(toMission);
  }

  async listOpen(): Promise<readonly Mission[]> {
    const rows = await this.db
      .select()
      .from(missions)
      .where(sql`${missions.state} not in ${[...TERMINAL_MISSION_STATES]}`)
      .orderBy(desc(missions.updatedAt), asc(missions.id));
    return rows.map(toMission);
  }

  async countActive(): Promise<number> {
    const [row] = await this.db
      .select({ value: sql<number>`count(*)::int` })
      .from(missions)
      .where(inArray(missions.state, [...ACTIVE_MISSION_STATES]));
    return row?.value ?? 0;
  }

  async remove(id: string): Promise<void> {
    await this.db.delete(missions).where(eq(missions.id, id));
  }

  async transition(
    id: string,
    to: MissionState,
    patch: MissionStatePatch,
    expectedState?: MissionState,
  ): Promise<Mission | null> {
    const values = { ...buildPatch(patch), state: to, updatedAt: new Date() };
    const where =
      expectedState === undefined
        ? eq(missions.id, id)
        : and(eq(missions.id, id), eq(missions.state, expectedState));
    const [row] = await this.db.update(missions).set(values).where(where).returning();
    return row ? toMission(row) : null;
  }

  async patch(id: string, patch: MissionStatePatch): Promise<Mission> {
    const [row] = await this.db
      .update(missions)
      .set({ ...buildPatch(patch), updatedAt: new Date() })
      .where(eq(missions.id, id))
      .returning();
    if (!row) throw new NotFoundError('Mission');
    return toMission(row);
  }

  /**
   * Claim exactly one queued mission.
   *
   * Everything that could make the claim wrong is inside the sub-select: the mission must still
   * be queued, its approved plan version must still be the current one, it must not already hold
   * a run, and the number of missions already active must be below the limit. `FOR UPDATE SKIP
   * LOCKED` means a second caller passes over a row the first is taking rather than blocking on it.
   */
  async claimNext(request: ClaimRequest): Promise<ClaimResult | null> {
    const activeStates = sql.raw(ACTIVE_MISSION_STATES.map((state) => `'${state}'`).join(', '));

    /*
     * The unattended gate, inside the claim rather than beside it.
     *
     * An autonomous mission is claimable only when its type is one this deployment has qualified
     * to run with nobody watching. Attended missions — everything a person approved — ignore the
     * clause entirely, which is why an unqualified deployment still works exactly as it did.
     *
     * `MISSION_TYPES` is a closed vocabulary and the list is intersected with it before it reaches
     * the statement, so nothing a caller passes can widen the SQL. When the intersection is empty
     * the clause degrades to `not m.autonomous`, which is the safe reading of "qualified for
     * nothing" rather than the dangerous one.
     */
    const unattended = MISSION_TYPES.filter((type) =>
      request.unattendedMissionTypes.includes(type),
    );
    const unattendedClause =
      unattended.length === 0
        ? sql`and not c.autonomous`
        : sql`and (not c.autonomous or c.type in (${sql.raw(
            unattended.map((type) => `'${type}'`).join(', '),
          )}))`;

    const claimed = await this.db.execute(sql`
      update ${missions} as m
      set state = 'claimed',
          claimed_by_worker_id = ${request.workerId},
          attempt_count = m.attempt_count + 1,
          last_activity_at = ${request.now},
          updated_at = ${request.now}
      where m.id = (
        select c.id
        from ${missions} as c
        where c.state = 'queued'
          and c.approved_plan_version is not null
          and c.approved_plan_version = c.current_plan_version
          and c.active_run_id is null
          and c.project_id is not null
          and (
            select count(*) from ${missions} as a where a.state in (${activeStates})
          ) < ${request.concurrencyLimit}
          ${unattendedClause}
        order by
          case c.priority when 'critical' then 0 when 'high' then 1 when 'medium' then 2 else 3 end,
          c.created_at asc,
          c.id asc
        limit 1
        for update skip locked
      )
      returning m.id
    `);

    const claimedId = firstId(claimed);
    if (!claimedId) return null;

    const mission = await this.findById(claimedId);
    if (!mission) return null;

    const attempt = mission.attemptCount;
    const [runRow] = await this.db
      .insert(missionRuns)
      .values({
        missionId: mission.id,
        workerId: request.workerId,
        attempt,
        kind: request.kinds.includes('execution') ? 'execution' : (request.kinds[0] ?? 'execution'),
        planVersion: mission.approvedPlanVersion,
        state: 'starting',
        startedAt: request.now,
      })
      .returning();
    if (!runRow) throw new ConflictError('The run for this mission could not be created.');

    const updated = await this.patch(mission.id, {
      activeRunId: runRow.id,
      startedAt: mission.startedAt ? null : request.now,
      lastActivityAt: request.now,
    });

    return { mission: updated, run: toMissionRun(runRow) };
  }
}

function buildPatch(patch: MissionStatePatch): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  const assign = <K extends keyof MissionStatePatch>(key: K, column: string) => {
    if (patch[key] !== undefined) values[column] = patch[key];
  };
  assign('activeRunId', 'activeRunId');
  assign('claimedByWorkerId', 'claimedByWorkerId');
  assign('currentPlanVersion', 'currentPlanVersion');
  assign('approvedPlanVersion', 'approvedPlanVersion');
  assign('currentGraphVersion', 'currentGraphVersion');
  assign('approvedGraphVersion', 'approvedGraphVersion');
  assign('playbookKey', 'playbookKey');
  assign('playbookVersion', 'playbookVersion');
  assign('integrationBranch', 'integrationBranch');
  assign('repairRoundsUsed', 'repairRoundsUsed');
  assign('receiptId', 'receiptId');
  assign('autonomous', 'autonomous');
  assign('charterVersionId', 'charterVersionId');
  assign('authorizationDecisionId', 'authorizationDecisionId');
  assign('workingBranch', 'workingBranch');
  assign('baseBranch', 'baseBranch');
  assign('baseSha', 'baseSha');
  assign('pullRequestUrl', 'pullRequestUrl');
  assign('pullRequestNumber', 'pullRequestNumber');
  assign('completionSummary', 'completionSummary');
  assign('failureCode', 'failureCode');
  assign('failureMessage', 'failureMessage');
  assign('cancellationReason', 'cancellationReason');
  assign('startedAt', 'startedAt');
  assign('finishedAt', 'finishedAt');
  assign('lastActivityAt', 'lastActivityAt');
  assign('attemptCount', 'attemptCount');
  assign('executionOverrideAt', 'executionOverrideAt');
  assign('executionOverrideReason', 'executionOverrideReason');
  assign('riskLevel', 'riskLevel');
  if (patch.riskRuleIds !== undefined) values.riskRuleIds = [...patch.riskRuleIds];
  if (patch.riskReasons !== undefined) values.riskReasons = [...patch.riskReasons];
  return values;
}

/** The drivers disagree about the shape of `execute`; this normalises it. */
function firstId(result: unknown): string | null {
  const rows = Array.isArray(result)
    ? result
    : result && typeof result === 'object' && 'rows' in result
      ? (result as { rows: unknown }).rows
      : null;
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const row = rows[0] as Record<string, unknown>;
  const id = row.id;
  return typeof id === 'string' ? id : null;
}

/* --------------------------------------------------------------------- plans */

export class DrizzlePlanRepository implements PlanRepository {
  constructor(private readonly db: Database) {}

  async create(input: Parameters<PlanRepository['create']>[0]): Promise<MissionPlan> {
    /* Only one plan is "current"; earlier versions are marked superseded in the same call. */
    await this.db
      .update(missionPlans)
      .set({ supersededAt: new Date() })
      .where(and(eq(missionPlans.missionId, input.missionId), isNull(missionPlans.supersededAt)));

    const [row] = await this.db
      .insert(missionPlans)
      .values({
        missionId: input.missionId,
        version: input.version,
        content: input.content,
        author: input.author,
        provenance: input.provenance,
        riskLevel: input.riskLevel,
        runId: input.runId ?? null,
        fingerprint: input.fingerprint,
      })
      .returning();
    if (!row) throw new ConflictError('That plan version already exists.');
    return toMissionPlan(row);
  }

  async latest(missionId: string): Promise<MissionPlan | null> {
    const [row] = await this.db
      .select()
      .from(missionPlans)
      .where(eq(missionPlans.missionId, missionId))
      .orderBy(desc(missionPlans.version))
      .limit(1);
    return row ? toMissionPlan(row) : null;
  }

  async byVersion(missionId: string, version: number): Promise<MissionPlan | null> {
    const [row] = await this.db
      .select()
      .from(missionPlans)
      .where(and(eq(missionPlans.missionId, missionId), eq(missionPlans.version, version)))
      .limit(1);
    return row ? toMissionPlan(row) : null;
  }

  async list(missionId: string): Promise<readonly MissionPlan[]> {
    const rows = await this.db
      .select()
      .from(missionPlans)
      .where(eq(missionPlans.missionId, missionId))
      .orderBy(desc(missionPlans.version));
    return rows.map(toMissionPlan);
  }

  async nextVersion(missionId: string): Promise<number> {
    const [row] = await this.db
      .select({ value: sql<number>`coalesce(max(${missionPlans.version}), 0)::int` })
      .from(missionPlans)
      .where(eq(missionPlans.missionId, missionId));
    return (row?.value ?? 0) + 1;
  }
}

/* ----------------------------------------------------------------- approvals */

export class DrizzleApprovalRepository implements ApprovalRepository {
  constructor(private readonly db: Database) {}

  async create(input: Parameters<ApprovalRepository['create']>[0]): Promise<MissionApproval> {
    const [row] = await this.db
      .insert(missionApprovals)
      .values({
        missionId: input.missionId,
        planId: input.planId,
        planVersion: input.planVersion,
        approvedBy: input.approvedBy,
        approvedRiskLevel: input.approvedRiskLevel,
        approvedScope: [...input.approvedScope],
        note: input.note ?? null,
        charterVersionId: input.charterVersionId ?? null,
        charterDigest: input.charterDigest ?? null,
        authorizationDecisionId: input.authorizationDecisionId ?? null,
      })
      .returning();
    if (!row) throw new ConflictError('This plan version is already approved.');
    return toMissionApproval(row);
  }

  async activeFor(missionId: string): Promise<MissionApproval | null> {
    const [row] = await this.db
      .select()
      .from(missionApprovals)
      .where(and(eq(missionApprovals.missionId, missionId), isNull(missionApprovals.revokedAt)))
      .orderBy(desc(missionApprovals.approvedAt))
      .limit(1);
    return row ? toMissionApproval(row) : null;
  }

  async revokeAll(missionId: string, reason: string): Promise<number> {
    const rows = await this.db
      .update(missionApprovals)
      .set({ revokedAt: new Date(), revokedReason: reason })
      .where(and(eq(missionApprovals.missionId, missionId), isNull(missionApprovals.revokedAt)))
      .returning({ id: missionApprovals.id });
    return rows.length;
  }

  async list(missionId: string): Promise<readonly MissionApproval[]> {
    const rows = await this.db
      .select()
      .from(missionApprovals)
      .where(eq(missionApprovals.missionId, missionId))
      .orderBy(desc(missionApprovals.approvedAt));
    return rows.map(toMissionApproval);
  }
}

/* ------------------------------------------------------------ clarifications */

export class DrizzleClarificationRepository implements ClarificationRepository {
  constructor(private readonly db: Database) {}

  /** Replaces the unanswered set; answered questions are history and are never removed. */
  async replaceOpen(missionId: string, questions: readonly ClarificationQuestion[]): Promise<void> {
    await this.db
      .delete(missionClarifications)
      .where(
        and(
          eq(missionClarifications.missionId, missionId),
          isNull(missionClarifications.answeredAt),
        ),
      );
    if (questions.length === 0) return;
    await this.db
      .insert(missionClarifications)
      .values(
        questions.map((question) => ({
          missionId,
          questionId: question.id,
          topic: question.topic,
          question: question.question,
          why: question.why,
          options: [...question.options],
          recommendation: question.recommendation,
          rule: question.rule,
        })),
      )
      .onConflictDoNothing();
  }

  async list(missionId: string): Promise<readonly ClarificationRecord[]> {
    const rows = await this.db
      .select()
      .from(missionClarifications)
      .where(eq(missionClarifications.missionId, missionId))
      .orderBy(asc(missionClarifications.askedAt), asc(missionClarifications.questionId));
    return rows.map(toClarification);
  }

  async answer(
    missionId: string,
    questionId: string,
    answer: string,
    provenance: ClarificationRecord['answerProvenance'],
  ): Promise<ClarificationRecord | null> {
    const [row] = await this.db
      .update(missionClarifications)
      .set({ answer, answerProvenance: provenance, answeredAt: new Date() })
      .where(
        and(
          eq(missionClarifications.missionId, missionId),
          eq(missionClarifications.questionId, questionId),
        ),
      )
      .returning();
    return row ? toClarification(row) : null;
  }

  async openCount(missionIds: readonly string[]): Promise<ReadonlyMap<string, number>> {
    if (missionIds.length === 0) return new Map();
    const rows = await this.db
      .select({
        missionId: missionClarifications.missionId,
        value: sql<number>`count(*)::int`,
      })
      .from(missionClarifications)
      .where(
        and(
          inArray(missionClarifications.missionId, [...missionIds]),
          isNull(missionClarifications.answeredAt),
        ),
      )
      .groupBy(missionClarifications.missionId);
    return new Map(rows.map((row) => [row.missionId, row.value]));
  }
}

/* ---------------------------------------------------------------------- runs */

export class DrizzleRunRepository implements RunRepository {
  constructor(private readonly db: Database) {}

  async start(input: Parameters<RunRepository['start']>[0]): Promise<MissionRun> {
    const [row] = await this.db
      .insert(missionRuns)
      .values({
        missionId: input.missionId,
        workerId: input.workerId,
        attempt: input.attempt,
        kind: input.kind,
        planVersion: input.planVersion,
        state: 'starting',
        ...(input.startedAt ? { startedAt: input.startedAt } : {}),
      })
      .returning();
    if (!row) throw new ConflictError('That run already exists.');
    return toMissionRun(row);
  }

  async findById(id: string): Promise<MissionRun | null> {
    const [row] = await this.db.select().from(missionRuns).where(eq(missionRuns.id, id)).limit(1);
    return row ? toMissionRun(row) : null;
  }

  async list(missionId: string): Promise<readonly MissionRun[]> {
    const rows = await this.db
      .select()
      .from(missionRuns)
      .where(eq(missionRuns.missionId, missionId))
      .orderBy(desc(missionRuns.attempt), asc(missionRuns.id));
    return rows.map(toMissionRun);
  }

  async latest(missionId: string): Promise<MissionRun | null> {
    const [row] = await this.db
      .select()
      .from(missionRuns)
      .where(eq(missionRuns.missionId, missionId))
      .orderBy(desc(missionRuns.startedAt), desc(missionRuns.attempt))
      .limit(1);
    return row ? toMissionRun(row) : null;
  }

  async patch(id: string, patch: Parameters<RunRepository['patch']>[1]): Promise<MissionRun> {
    const values: Record<string, unknown> = {};
    for (const key of [
      'state',
      'currentAction',
      'agentSessionId',
      'runtimeName',
      'runtimeVersion',
      'workspacePath',
      'baseBranch',
      'baseSha',
      'branchName',
      'headSha',
      'pullRequestUrl',
      'pullRequestNumber',
      'failureCode',
      'failureMessage',
      'workspacePreserved',
      'finishedAt',
      'lastEventAt',
    ] as const) {
      if (patch[key] !== undefined) values[key] = patch[key];
    }
    if (patch.filesChanged !== undefined) values.filesChanged = [...patch.filesChanged];
    if (patch.usage !== undefined) {
      values.usageInputTokens = patch.usage?.inputTokens ?? null;
      values.usageOutputTokens = patch.usage?.outputTokens ?? null;
      values.usageCacheReadTokens = patch.usage?.cacheReadTokens ?? null;
      values.usageCostUsd = patch.usage?.totalCostUsd ?? null;
      values.usageTurns = patch.usage?.turns ?? null;
      values.usageDurationMs = patch.usage?.durationMs ?? null;
    }
    const [row] = await this.db
      .update(missionRuns)
      .set(values)
      .where(eq(missionRuns.id, id))
      .returning();
    if (!row) throw new NotFoundError('Run');
    return toMissionRun(row);
  }

  async nextAttempt(missionId: string): Promise<number> {
    const [row] = await this.db
      .select({ value: sql<number>`coalesce(max(${missionRuns.attempt}), 0)::int` })
      .from(missionRuns)
      .where(eq(missionRuns.missionId, missionId));
    return (row?.value ?? 0) + 1;
  }
}

/* -------------------------------------------------------------------- events */

export class DrizzleEventRepository implements EventRepository {
  constructor(private readonly db: Database) {}

  /**
   * Append a batch.
   *
   * Redaction happens here rather than at the route, so *every* path into the table is covered —
   * a worker report, an owner action and an internal system note alike.
   */
  async append(
    missionId: string,
    runId: string | null,
    inputs: readonly MissionEventInput[],
  ): Promise<readonly MissionEvent[]> {
    if (inputs.length === 0) return [];
    const rows = await this.db
      .insert(missionEvents)
      .values(
        inputs.map((input) => ({
          missionId,
          runId,
          seq: input.seq,
          type: input.type,
          level: input.level,
          actor: input.actor,
          summary: boundText(redactSecrets(input.summary), EVENT_SUMMARY_MAX),
          detail: (redactDeep(input.detail) ?? {}) as Record<string, unknown>,
          ...(input.occurredAt ? { occurredAt: new Date(input.occurredAt) } : {}),
        })),
      )
      /* A retried batch is not an error: the same (run, seq) simply does not insert twice. */
      .onConflictDoNothing()
      .returning();

    if (runId && rows.length > 0) {
      const highest = Math.max(...inputs.map((input) => input.seq));
      await this.db
        .update(missionRuns)
        .set({ lastEventAt: new Date(), lastEventSeq: highest })
        .where(eq(missionRuns.id, runId));
    }
    return rows.map(toMissionEvent);
  }

  async record(missionId: string, input: ControlPlaneEventInput): Promise<MissionEvent> {
    const [row] = await this.db
      .insert(missionEvents)
      .values({
        missionId,
        runId: null,
        seq: input.seq ?? 0,
        type: input.type,
        level: input.level ?? 'info',
        actor: input.actor ?? 'system',
        summary: boundText(redactSecrets(input.summary), EVENT_SUMMARY_MAX),
        detail: (redactDeep(input.detail ?? {}) ?? {}) as Record<string, unknown>,
      })
      .returning();
    if (!row) throw new ConflictError('That event could not be recorded.');
    return toMissionEvent(row);
  }

  async list(
    missionId: string,
    options: { afterSeq?: number; limit?: number } = {},
  ): Promise<readonly MissionEvent[]> {
    const rows = await this.db
      .select()
      .from(missionEvents)
      .where(eq(missionEvents.missionId, missionId))
      .orderBy(asc(missionEvents.createdAt), asc(missionEvents.seq), asc(missionEvents.id))
      .limit(options.limit ?? 400);
    return rows.map(toMissionEvent);
  }

  async listForRun(runId: string, afterSeq = -1, limit = 300): Promise<readonly MissionEvent[]> {
    const rows = await this.db
      .select()
      .from(missionEvents)
      .where(and(eq(missionEvents.runId, runId), sql`${missionEvents.seq} > ${afterSeq}`))
      .orderBy(asc(missionEvents.seq), asc(missionEvents.id))
      .limit(limit);
    return rows.map(toMissionEvent);
  }

  async latestSeq(runId: string): Promise<number> {
    const [row] = await this.db
      .select({ value: sql<number>`coalesce(max(${missionEvents.seq}), -1)::bigint` })
      .from(missionEvents)
      .where(eq(missionEvents.runId, runId));
    return Number(row?.value ?? -1);
  }
}

/* ------------------------------------------------------------------ commands */

export class DrizzleCommandRepository implements CommandRepository {
  constructor(private readonly db: Database) {}

  /**
   * Create a command, or return the existing one for the same idempotency key.
   *
   * A double-tapped Pause button, or a retried request after a flaky connection, must produce one
   * command. `created` tells the caller which happened so the response can stay honest.
   */
  async create(
    input: Parameters<CommandRepository['create']>[0],
  ): Promise<{ command: MissionCommand; created: boolean }> {
    const inserted = await this.db
      .insert(missionCommands)
      .values({
        missionId: input.missionId,
        runId: input.runId,
        kind: input.kind,
        payload: (redactDeep(input.payload) ?? {}) as Record<string, unknown>,
        requestedBy: input.requestedBy,
        idempotencyKey: input.idempotencyKey,
      })
      .onConflictDoNothing()
      .returning();

    const row = inserted[0];
    if (row) return { command: toMissionCommand(row), created: true };

    const [existing] = await this.db
      .select()
      .from(missionCommands)
      .where(
        and(
          eq(missionCommands.missionId, input.missionId),
          eq(missionCommands.kind, input.kind),
          eq(missionCommands.idempotencyKey, input.idempotencyKey),
        ),
      )
      .limit(1);
    if (!existing) throw new ConflictError('That command could not be recorded.');
    return { command: toMissionCommand(existing), created: false };
  }

  async pendingFor(missionId: string): Promise<readonly MissionCommand[]> {
    const rows = await this.db
      .select()
      .from(missionCommands)
      .where(
        and(
          eq(missionCommands.missionId, missionId),
          inArray(missionCommands.state, ['pending', 'delivered']),
        ),
      )
      .orderBy(asc(missionCommands.requestedAt), asc(missionCommands.id));
    return rows.map(toMissionCommand);
  }

  async list(missionId: string, limit = 50): Promise<readonly MissionCommand[]> {
    const rows = await this.db
      .select()
      .from(missionCommands)
      .where(eq(missionCommands.missionId, missionId))
      .orderBy(desc(missionCommands.requestedAt), asc(missionCommands.id))
      .limit(limit);
    return rows.map(toMissionCommand);
  }

  async markDelivered(ids: readonly string[], at: Date): Promise<void> {
    if (ids.length === 0) return;
    await this.db
      .update(missionCommands)
      .set({ state: 'delivered', deliveredAt: at })
      .where(and(inArray(missionCommands.id, [...ids]), eq(missionCommands.state, 'pending')));
  }

  async setState(
    id: string,
    state: CommandState,
    failureMessage: string | null = null,
  ): Promise<MissionCommand> {
    const now = new Date();
    const values: Record<string, unknown> = { state, failureMessage };
    if (state === 'acknowledged') values.acknowledgedAt = now;
    if (state === 'completed' || state === 'failed') values.completedAt = now;
    const [row] = await this.db
      .update(missionCommands)
      .set(values)
      .where(eq(missionCommands.id, id))
      .returning();
    if (!row) throw new NotFoundError('Command');
    return toMissionCommand(row);
  }

  async supersedePending(missionId: string, kinds: readonly CommandKind[]): Promise<number> {
    if (kinds.length === 0) return 0;
    const rows = await this.db
      .update(missionCommands)
      .set({ state: 'superseded', completedAt: new Date() })
      .where(
        and(
          eq(missionCommands.missionId, missionId),
          inArray(missionCommands.kind, [...kinds]),
          inArray(missionCommands.state, ['pending', 'delivered']),
        ),
      )
      .returning({ id: missionCommands.id });
    return rows.length;
  }
}

/* -------------------------------------------------------- permission requests */

export class DrizzlePermissionRepository implements PermissionRepository {
  constructor(private readonly db: Database) {}

  async create(
    missionId: string,
    runId: string,
    input: PermissionRequestInput,
  ): Promise<MissionPermissionRequest> {
    const values = {
      missionId,
      runId,
      requestKey: input.requestKey,
      kind: input.kind,
      toolName: input.toolName ?? null,
      requestedAction: redactSecrets(input.requestedAction),
      reason: redactSecrets(input.reason),
      risk: input.risk,
      ifApproved: redactSecrets(input.ifApproved),
      alternatives: input.alternatives.map(redactSecrets),
      ...(input.expiresAt ? { expiresAt: new Date(input.expiresAt) } : {}),
    };
    const inserted = await this.db
      .insert(missionPermissionRequests)
      .values(values)
      .onConflictDoNothing()
      .returning();
    const row = inserted[0];
    if (row) return toPermissionRequest(row);

    const [existing] = await this.db
      .select()
      .from(missionPermissionRequests)
      .where(
        and(
          eq(missionPermissionRequests.runId, runId),
          eq(missionPermissionRequests.requestKey, input.requestKey),
        ),
      )
      .limit(1);
    if (!existing) throw new ConflictError('That permission request could not be recorded.');
    return toPermissionRequest(existing);
  }

  async findById(id: string): Promise<MissionPermissionRequest | null> {
    const [row] = await this.db
      .select()
      .from(missionPermissionRequests)
      .where(eq(missionPermissionRequests.id, id))
      .limit(1);
    return row ? toPermissionRequest(row) : null;
  }

  async listOpen(missionId?: string): Promise<readonly MissionPermissionRequest[]> {
    const conditions: SQL[] = [eq(missionPermissionRequests.state, 'pending')];
    if (missionId) conditions.push(eq(missionPermissionRequests.missionId, missionId));
    const rows = await this.db
      .select()
      .from(missionPermissionRequests)
      .where(and(...conditions))
      .orderBy(asc(missionPermissionRequests.createdAt), asc(missionPermissionRequests.id));
    return rows.map(toPermissionRequest);
  }

  async list(missionId: string): Promise<readonly MissionPermissionRequest[]> {
    const rows = await this.db
      .select()
      .from(missionPermissionRequests)
      .where(eq(missionPermissionRequests.missionId, missionId))
      .orderBy(desc(missionPermissionRequests.createdAt), asc(missionPermissionRequests.id));
    return rows.map(toPermissionRequest);
  }

  /** Only a pending request can be decided, so a stale browser tab cannot re-answer one. */
  async decide(
    id: string,
    decision: {
      state: 'approved' | 'denied';
      decidedBy: string;
      note?: string | null;
      answer?: string | null;
    },
  ): Promise<MissionPermissionRequest> {
    const [row] = await this.db
      .update(missionPermissionRequests)
      .set({
        state: decision.state,
        decidedAt: new Date(),
        decidedBy: decision.decidedBy,
        decisionNote: decision.note ?? null,
        answer: decision.answer ? redactSecrets(decision.answer) : null,
      })
      .where(
        and(eq(missionPermissionRequests.id, id), eq(missionPermissionRequests.state, 'pending')),
      )
      .returning();
    if (!row) {
      throw new ConflictError('That request has already been answered or is no longer open.');
    }
    return toPermissionRequest(row);
  }

  async cancelForRun(runId: string): Promise<number> {
    const rows = await this.db
      .update(missionPermissionRequests)
      .set({ state: 'cancelled', decidedAt: new Date() })
      .where(
        and(
          eq(missionPermissionRequests.runId, runId),
          eq(missionPermissionRequests.state, 'pending'),
        ),
      )
      .returning({ id: missionPermissionRequests.id });
    return rows.length;
  }

  async openCount(missionIds: readonly string[]): Promise<ReadonlyMap<string, number>> {
    if (missionIds.length === 0) return new Map();
    const rows = await this.db
      .select({
        missionId: missionPermissionRequests.missionId,
        value: sql<number>`count(*)::int`,
      })
      .from(missionPermissionRequests)
      .where(
        and(
          inArray(missionPermissionRequests.missionId, [...missionIds]),
          eq(missionPermissionRequests.state, 'pending'),
        ),
      )
      .groupBy(missionPermissionRequests.missionId);
    return new Map(rows.map((row) => [row.missionId, row.value]));
  }
}

/* -------------------------------------------------------------- verifications */

export class DrizzleVerificationRepository implements VerificationRepository {
  constructor(private readonly db: Database) {}

  async record(
    missionId: string,
    runId: string,
    input: VerificationInput,
  ): Promise<MissionVerification> {
    const [row] = await this.db
      .insert(missionVerifications)
      .values({
        missionId,
        runId,
        command: redactSecrets(input.command),
        source: input.source,
        outcome: input.outcome,
        exitCode: input.exitCode ?? null,
        startedAt: input.startedAt ? new Date(input.startedAt) : null,
        finishedAt: input.finishedAt ? new Date(input.finishedAt) : null,
        durationMs: input.durationMs ?? null,
        outputExcerpt: input.outputExcerpt
          ? boundText(redactSecrets(input.outputExcerpt), VERIFICATION_OUTPUT_MAX)
          : null,
        missionRelated: input.missionRelated ?? null,
        reason: input.reason ?? null,
      })
      .returning();
    if (!row) throw new ConflictError('That verification result could not be recorded.');
    return toVerification(row);
  }

  async list(missionId: string): Promise<readonly MissionVerification[]> {
    const rows = await this.db
      .select()
      .from(missionVerifications)
      .where(eq(missionVerifications.missionId, missionId))
      .orderBy(asc(missionVerifications.createdAt), asc(missionVerifications.id));
    return rows.map(toVerification);
  }

  async listForRun(runId: string): Promise<readonly MissionVerification[]> {
    const rows = await this.db
      .select()
      .from(missionVerifications)
      .where(eq(missionVerifications.runId, runId))
      .orderBy(asc(missionVerifications.createdAt), asc(missionVerifications.id));
    return rows.map(toVerification);
  }
}

/* ---------------------------------------------------------------- artifacts */

export class DrizzleArtifactRepository implements ArtifactRepository {
  constructor(private readonly db: Database) {}

  async create(
    missionId: string,
    projectId: string | null,
    runId: string | null,
    input: ArtifactInput,
    createdBy: MissionEvent['actor'],
  ): Promise<MissionArtifact> {
    const content = redactSecrets(input.content);
    const [row] = await this.db
      .insert(missionArtifacts)
      .values({
        missionId,
        projectId,
        runId,
        kind: input.kind,
        title: redactSecrets(input.title),
        contentType: input.contentType,
        content,
        sizeBytes: Buffer.byteLength(content, 'utf8'),
        sources: input.sources.map((source) => ({
          label: redactSecrets(source.label),
          url: source.url ? redactSecrets(source.url) : null,
          kind: source.kind,
        })),
        createdBy,
      })
      .returning();
    if (!row) throw new ConflictError('That artifact could not be stored.');
    return toArtifact(row);
  }

  async findById(id: string): Promise<MissionArtifact | null> {
    const [row] = await this.db
      .select()
      .from(missionArtifacts)
      .where(eq(missionArtifacts.id, id))
      .limit(1);
    return row ? toArtifact(row) : null;
  }

  async list(missionId: string): Promise<readonly MissionArtifact[]> {
    const rows = await this.db
      .select()
      .from(missionArtifacts)
      .where(eq(missionArtifacts.missionId, missionId))
      .orderBy(desc(missionArtifacts.createdAt), asc(missionArtifacts.id));
    return rows.map(toArtifact);
  }

  async listByProject(projectId: string, limit = 20): Promise<readonly MissionArtifact[]> {
    const rows = await this.db
      .select()
      .from(missionArtifacts)
      .where(eq(missionArtifacts.projectId, projectId))
      .orderBy(desc(missionArtifacts.createdAt), asc(missionArtifacts.id))
      .limit(limit);
    return rows.map(toArtifact);
  }
}

/* ------------------------------------------------------------------ workers */

export class DrizzleWorkerRepository implements WorkerRepository {
  constructor(private readonly db: Database) {}

  async enrol(input: Parameters<WorkerRepository['enrol']>[0]): Promise<JarvisWorker> {
    const [row] = await this.db
      .insert(workers)
      .values({
        id: input.id,
        name: input.name,
        tokenHash: input.tokenHash,
        tokenPrefix: input.tokenPrefix,
        maxConcurrency: input.maxConcurrency,
      })
      .returning();
    if (!row) throw new ConflictError('That worker could not be enrolled.');
    return toWorker(row);
  }

  async rotate(id: string, tokenHash: string, tokenPrefix: string): Promise<JarvisWorker> {
    const [row] = await this.db
      .update(workers)
      .set({ tokenHash, tokenPrefix, rotatedAt: new Date(), revokedAt: null, revokedReason: null })
      .where(eq(workers.id, id))
      .returning();
    if (!row) throw new NotFoundError('Worker');
    return toWorker(row);
  }

  async revoke(id: string, reason: string): Promise<JarvisWorker> {
    const [row] = await this.db
      .update(workers)
      .set({ revokedAt: new Date(), revokedReason: reason, status: 'revoked' })
      .where(eq(workers.id, id))
      .returning();
    if (!row) throw new NotFoundError('Worker');
    return toWorker(row);
  }

  async findById(id: string): Promise<JarvisWorker | null> {
    const [row] = await this.db.select().from(workers).where(eq(workers.id, id)).limit(1);
    return row ? toWorker(row) : null;
  }

  /**
   * The only query that returns a token hash.
   *
   * It selects exactly three columns so a hash cannot be picked up by a caller that meant to load
   * a worker for display.
   */
  async findAuthRecord(
    id: string,
  ): Promise<{ id: string; tokenHash: string; revokedAt: Date | null } | null> {
    const [row] = await this.db
      .select({ id: workers.id, tokenHash: workers.tokenHash, revokedAt: workers.revokedAt })
      .from(workers)
      .where(eq(workers.id, id))
      .limit(1);
    return row ?? null;
  }

  async list(): Promise<readonly JarvisWorker[]> {
    const rows = await this.db
      .select()
      .from(workers)
      .orderBy(asc(workers.createdAt), asc(workers.id));
    return rows.map(toWorker);
  }

  async heartbeat(
    id: string,
    input: Parameters<WorkerRepository['heartbeat']>[1],
  ): Promise<JarvisWorker> {
    const [row] = await this.db
      .update(workers)
      .set({
        status: input.status,
        version: input.version,
        platform: input.platform,
        runtimeAvailable: input.runtimeAvailable,
        runtimeName: input.runtimeName,
        runtimeDetail: input.runtimeDetail ? redactSecrets(input.runtimeDetail) : null,
        workspaceHealthy: input.workspaceHealthy,
        workspaceRootLabel: input.workspaceRootLabel,
        githubDeliveryConfigured: input.githubDeliveryConfigured,
        diagnostics: input.diagnostics.map(redactSecrets),
        currentMissionId: input.currentMissionId,
        currentRunId: input.currentRunId,
        lastActivityAt: input.lastActivityAt,
        lastHeartbeatAt: input.at,
        /*
         * Spread, so that a heartbeat with nothing new to say writes none of these columns.
         *
         * This is the difference between a governor that works and one that is blind. A worker can
         * only read Claude's capacity from a live session, so between missions it has nothing new
         * — and a heartbeat every few seconds that set these columns to null would erase a good
         * reading within moments of taking it. Omitting them leaves the last reading in place to
         * age honestly on its own timestamp.
         */
        ...capacityColumns(input.capacity),
      })
      .where(eq(workers.id, id))
      .returning();
    if (!row) throw new NotFoundError('Worker');
    return toWorker(row);
  }

  /**
   * One reading per worker, newest-first, skipping every worker that has never taken one.
   *
   * Deliberately not an aggregate. A rate-limit window belongs to the account, so three workers
   * reporting 42% means the account is at 42% — and a SQL `sum` would say 126%, a number that
   * cannot exist, with total confidence. The merge rule lives in `mergeAccountLimits`, which is
   * tested against exactly that mistake.
   */
  async capacityObservations(): Promise<readonly CapacityObservation[]> {
    const rows = await this.db
      .select()
      .from(workers)
      .where(and(isNull(workers.revokedAt), isNotNull(workers.capacityObservedAt)))
      .orderBy(desc(workers.capacityObservedAt));
    return rows
      .map(toCapacityObservation)
      .filter((observation): observation is CapacityObservation => observation !== null);
  }

  async remove(id: string): Promise<void> {
    await this.db.delete(workers).where(eq(workers.id, id));
  }
}

/**
 * The capacity columns for one heartbeat, or nothing at all.
 *
 * Returns an empty object rather than a row of nulls when there is no reading, so that the caller
 * can spread it into an `update` and have it write nothing. See the call site for why that
 * distinction carries the whole design.
 */
function capacityColumns(
  reading: WorkerCapacityReading | null,
): Partial<typeof workers.$inferInsert> {
  if (!reading) return {};
  const windows = reading.windows;
  return {
    capacityAuthMode: reading.authMode,
    /* Bounded and redacted like every other worker-supplied string reaching a text column. */
    capacitySubscriptionType: reading.subscriptionType
      ? redactSecrets(reading.subscriptionType)
      : null,
    capacityRateLimitsApplicable: reading.rateLimitsApplicable,
    capacityFiveHourPercent: windows.fiveHour?.utilisationPercent ?? null,
    capacityFiveHourResetsAt: windows.fiveHour?.resetsAt ?? null,
    capacitySevenDayPercent: windows.sevenDay?.utilisationPercent ?? null,
    capacitySevenDayResetsAt: windows.sevenDay?.resetsAt ?? null,
    capacitySevenDayOpusPercent: windows.sevenDayOpus?.utilisationPercent ?? null,
    capacitySevenDayOpusResetsAt: windows.sevenDayOpus?.resetsAt ?? null,
    capacityContextUsedTokens: reading.context?.usedTokens ?? null,
    capacityContextMaxTokens: reading.context?.maxTokens ?? null,
    capacityContextPercent: reading.context?.percentUsed ?? null,
    capacityContextOverLimit: reading.context?.overLimit ?? null,
    capacityUsingOverage: reading.usingOverage ?? null,
    capacitySource: redactSecrets(reading.source),
    capacityObservedAt: reading.observedAt,
  };
}

/* -------------------------------------------------------------- idempotency */

export class DrizzleIdempotencyRepository implements IdempotencyRepository {
  constructor(private readonly db: Database) {}

  async find(workerId: string, key: string): Promise<IdempotencyRecord | null> {
    const [row] = await this.db
      .select()
      .from(workerIdempotency)
      .where(and(eq(workerIdempotency.workerId, workerId), eq(workerIdempotency.key, key)))
      .limit(1);
    if (!row) return null;
    return {
      status: row.responseStatus,
      body: row.responseBody ?? {},
      requestHash: row.requestHash,
    };
  }

  async save(input: Parameters<IdempotencyRepository['save']>[0]): Promise<void> {
    await this.db
      .insert(workerIdempotency)
      .values({
        workerId: input.workerId,
        key: input.key,
        endpoint: input.endpoint,
        requestHash: input.requestHash,
        responseStatus: input.status,
        responseBody: input.body,
        expiresAt: input.expiresAt,
      })
      .onConflictDoNothing();
  }

  async purgeExpired(now: Date): Promise<number> {
    const rows = await this.db
      .delete(workerIdempotency)
      .where(lt(workerIdempotency.expiresAt, now))
      .returning({ id: workerIdempotency.id });
    return rows.length;
  }
}
