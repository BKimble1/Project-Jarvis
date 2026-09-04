import { and, asc, desc, eq, gte, inArray, isNull, sql } from 'drizzle-orm';
import { ConflictError, NotFoundError } from '@/domain/errors';
import { CAPACITY_TASK_STATES, TASK_TYPES } from '@/domain/mission-task';
import { AGENT_ROLES, WRITE_ROLES } from '@/domain/agent-role';
import { normaliseWriteSet, writeSetsOverlap } from '@/domain/write-set';
import { boundText, redactSecrets, redactDeep } from '@/domain/redaction';
import type { AppProfileInput } from '@/domain/app-profile';
import type { CompletionReceipt } from '@/domain/completion-receipt';
import type { CiDispatch, ReleaseApproval } from '@/domain/ci-dispatch';
import type { DisplayDevice } from '@/domain/display-device';
import type { MissionReview, ReviewFinding } from '@/domain/mission-review';
import type { MissionTask, TaskState } from '@/domain/mission-task';
import type { Playbook, PlaybookDefinition, PlaybookVersion } from '@/domain/playbook';
import type { MissionTaskGraph, TaskGraphState } from '@/domain/task-graph';
import type { Database } from '@/server/db/client';
import {
  ciDispatches,
  displayDevices,
  missionReceipts,
  missionReviewFindings,
  missionReviews,
  missionRuns,
  missionTaskDependencies,
  missionTaskGraphs,
  missionTasks,
  missionWriteLeases,
  missions,
  playbookVersions,
  playbooks,
  projectAppProfiles,
  releaseApprovals,
} from '@/server/db/schema';
import {
  toAppProfile,
  toCiDispatch,
  toDisplayDevice,
  toMissionReview,
  toMissionTask,
  toPlaybook,
  toPlaybookVersion,
  toReceipt,
  toReleaseApproval,
  toReviewFinding,
  toTaskGraph,
  toWriteLease,
} from './factory-mappers';
import type {
  AppProfileRepository,
  CiDispatchRepository,
  DisplayDeviceAuthRecord,
  DisplayDeviceRepository,
  PlaybookRepository,
  ReceiptRepository,
  ReleaseApprovalRepository,
  ReviewCreateInput,
  ReviewRepository,
  TaskClaimRequest,
  TaskClaimResult,
  TaskCreateInput,
  TaskGraphCreateInput,
  TaskGraphRepository,
  TaskPatch,
  TaskRepository,
  WriteLease,
  WriteLeaseRepository,
} from './factory-types';

/**
 * Persistence for the multi-agent factory.
 *
 * The two things worth reading closely are `DrizzleTaskRepository.claimNext` and
 * `DrizzleWriteLeaseRepository.acquire`. Both are the same shape as Prompt 2's mission claim and
 * for the same reason: every ceiling is checked *inside the statement that does the write*, under
 * `FOR UPDATE SKIP LOCKED`, so two workers polling at the same moment cannot both conclude there
 * is room. Splitting any of those predicates out into a separate read would reintroduce exactly
 * the race the single statement exists to prevent.
 */

/** `db.execute()` returns `{rows}` on neon/pg and an array on PGlite. Normalise once. */
function rowsOf(result: unknown): readonly Record<string, unknown>[] {
  const rows = Array.isArray(result)
    ? result
    : result && typeof result === 'object' && 'rows' in result
      ? (result as { rows: unknown }).rows
      : null;
  return Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
}

function firstId(result: unknown): string | null {
  const row = rowsOf(result)[0];
  const id = row?.id;
  return typeof id === 'string' ? id : null;
}

/* ---------------------------------------------------------------- the graph */

export class DrizzleTaskGraphRepository implements TaskGraphRepository {
  constructor(private readonly db: Database) {}

  async create(input: TaskGraphCreateInput): Promise<MissionTaskGraph> {
    const [row] = await this.db
      .insert(missionTaskGraphs)
      .values({
        missionId: input.missionId,
        version: input.version,
        planVersion: input.planVersion,
        summary: boundText(redactSecrets(input.summary), 600),
        notes: input.notes.map((note) => boundText(redactSecrets(note), 400)),
        fingerprint: input.fingerprint,
        playbookKey: input.playbookKey ?? null,
        playbookVersion: input.playbookVersion ?? null,
        maxParallelTasks: input.maxParallelTasks,
        maxWriteTasks: input.maxWriteTasks,
        maxRepairRounds: input.maxRepairRounds,
        proposedBy: input.proposedBy,
        state: 'proposed',
      })
      .returning();
    if (!row) throw new ConflictError('The task graph could not be created.');
    return toTaskGraph(row);
  }

  async findById(id: string): Promise<MissionTaskGraph | null> {
    const [row] = await this.db
      .select()
      .from(missionTaskGraphs)
      .where(eq(missionTaskGraphs.id, id))
      .limit(1);
    return row ? toTaskGraph(row) : null;
  }

  async latest(missionId: string): Promise<MissionTaskGraph | null> {
    const [row] = await this.db
      .select()
      .from(missionTaskGraphs)
      .where(eq(missionTaskGraphs.missionId, missionId))
      .orderBy(desc(missionTaskGraphs.version))
      .limit(1);
    return row ? toTaskGraph(row) : null;
  }

  async byVersion(missionId: string, version: number): Promise<MissionTaskGraph | null> {
    const [row] = await this.db
      .select()
      .from(missionTaskGraphs)
      .where(
        and(eq(missionTaskGraphs.missionId, missionId), eq(missionTaskGraphs.version, version)),
      )
      .limit(1);
    return row ? toTaskGraph(row) : null;
  }

  async list(missionId: string): Promise<readonly MissionTaskGraph[]> {
    const rows = await this.db
      .select()
      .from(missionTaskGraphs)
      .where(eq(missionTaskGraphs.missionId, missionId))
      .orderBy(desc(missionTaskGraphs.version));
    return rows.map(toTaskGraph);
  }

  async nextVersion(missionId: string): Promise<number> {
    const latest = await this.latest(missionId);
    return (latest?.version ?? 0) + 1;
  }

  async setState(
    id: string,
    state: TaskGraphState,
    patch: Parameters<TaskGraphRepository['setState']>[2] = {},
  ): Promise<MissionTaskGraph> {
    const [row] = await this.db
      .update(missionTaskGraphs)
      .set({
        state,
        ...(patch.approvedAt !== undefined ? { approvedAt: patch.approvedAt } : {}),
        ...(patch.approvedBy !== undefined ? { approvedBy: patch.approvedBy } : {}),
        ...(patch.revokedAt !== undefined ? { revokedAt: patch.revokedAt } : {}),
        ...(patch.revokedReason !== undefined ? { revokedReason: patch.revokedReason } : {}),
        ...(patch.maxParallelTasks !== undefined
          ? { maxParallelTasks: patch.maxParallelTasks }
          : {}),
      })
      .where(eq(missionTaskGraphs.id, id))
      .returning();
    if (!row) throw new NotFoundError('Task graph');
    return toTaskGraph(row);
  }

  async revokeOthers(missionId: string, keepId: string, reason: string): Promise<number> {
    const rows = await this.db
      .update(missionTaskGraphs)
      .set({ state: 'revoked', revokedAt: new Date(), revokedReason: boundText(reason, 300) })
      .where(
        and(
          eq(missionTaskGraphs.missionId, missionId),
          sql`${missionTaskGraphs.id} <> ${keepId}`,
          sql`${missionTaskGraphs.state} <> 'revoked'`,
        ),
      )
      .returning();
    return rows.length;
  }
}

/* ---------------------------------------------------------------- the tasks */

export class DrizzleTaskRepository implements TaskRepository {
  constructor(private readonly db: Database) {}

  async createMany(inputs: readonly TaskCreateInput[]): Promise<readonly MissionTask[]> {
    if (inputs.length === 0) return [];
    const rows = await this.db
      .insert(missionTasks)
      .values(
        inputs.map((input) => ({
          missionId: input.missionId,
          graphId: input.graphId,
          graphVersion: input.graphVersion,
          planVersion: input.planVersion,
          key: input.key,
          title: boundText(redactSecrets(input.title), 160),
          description: boundText(redactSecrets(input.description), 4000),
          role: input.role,
          permissionProfileId: input.permissionProfileId,
          taskType: input.taskType,
          position: input.position,
          state: 'draft' as const,
          expectedInputs: [...input.expectedInputs],
          expectedOutputs: [...input.expectedOutputs],
          acceptanceCriteria: [...input.acceptanceCriteria],
          workspaceRequirement: input.workspaceRequirement,
          requiresRepository: input.requiresRepository,
          expectedFileAreas: [...input.expectedFileAreas],
          declaredWriteSet: [...normaliseWriteSet(input.declaredWriteSet)],
          maxAttempts: input.maxAttempts,
          maxTurns: input.maxTurns,
          timeLimitMs: input.timeLimitMs,
          maxOutputTokens: input.maxOutputTokens,
          repairRound: input.repairRound,
        })),
      )
      .returning();
    return rows.map((row) => toMissionTask(row));
  }

  async setDependencies(
    graphId: string,
    edges: readonly { taskId: string; dependsOnTaskId: string }[],
  ): Promise<void> {
    await this.db
      .delete(missionTaskDependencies)
      .where(eq(missionTaskDependencies.graphId, graphId));
    if (edges.length === 0) return;
    await this.db.insert(missionTaskDependencies).values(
      edges.map((edge) => ({
        graphId,
        taskId: edge.taskId,
        dependsOnTaskId: edge.dependsOnTaskId,
      })),
    );
  }

  /** Dependency keys for a set of tasks, resolved to task *keys* rather than ids. */
  private async dependencyKeys(
    graphId: string,
    tasks: readonly { id: string; key: string }[],
  ): Promise<Map<string, string[]>> {
    const byId = new Map(tasks.map((task) => [task.id, task.key]));
    const edges = await this.db
      .select()
      .from(missionTaskDependencies)
      .where(eq(missionTaskDependencies.graphId, graphId));
    const map = new Map<string, string[]>();
    for (const edge of edges) {
      const key = byId.get(edge.dependsOnTaskId);
      if (!key) continue;
      const list = map.get(edge.taskId) ?? [];
      list.push(key);
      map.set(edge.taskId, list);
    }
    return map;
  }

  async findById(id: string): Promise<MissionTask | null> {
    const [row] = await this.db.select().from(missionTasks).where(eq(missionTasks.id, id)).limit(1);
    if (!row) return null;
    const siblings = await this.db
      .select({ id: missionTasks.id, key: missionTasks.key })
      .from(missionTasks)
      .where(eq(missionTasks.graphId, row.graphId));
    const deps = await this.dependencyKeys(row.graphId, siblings);
    return toMissionTask(row, deps.get(row.id) ?? []);
  }

  async listByGraph(graphId: string): Promise<readonly MissionTask[]> {
    const rows = await this.db
      .select()
      .from(missionTasks)
      .where(eq(missionTasks.graphId, graphId))
      .orderBy(asc(missionTasks.position), asc(missionTasks.key));
    const deps = await this.dependencyKeys(graphId, rows);
    return rows.map((row) => toMissionTask(row, deps.get(row.id) ?? []));
  }

  async listByMission(missionId: string): Promise<readonly MissionTask[]> {
    const rows = await this.db
      .select()
      .from(missionTasks)
      .where(eq(missionTasks.missionId, missionId))
      .orderBy(asc(missionTasks.graphVersion), asc(missionTasks.position));
    if (rows.length === 0) return [];
    const graphIds = [...new Set(rows.map((row) => row.graphId))];
    const map = new Map<string, string[]>();
    for (const graphId of graphIds) {
      const siblings = rows.filter((row) => row.graphId === graphId);
      const deps = await this.dependencyKeys(graphId, siblings);
      for (const [taskId, keys] of deps) map.set(taskId, keys);
    }
    return rows.map((row) => toMissionTask(row, map.get(row.id) ?? []));
  }

  async listActive(): Promise<readonly MissionTask[]> {
    const rows = await this.db
      .select()
      .from(missionTasks)
      .where(inArray(missionTasks.state, [...CAPACITY_TASK_STATES]));
    return rows.map((row) => toMissionTask(row));
  }

  async patch(id: string, patch: TaskPatch): Promise<MissionTask> {
    const [row] = await this.db
      .update(missionTasks)
      .set(buildTaskPatch(patch))
      .where(eq(missionTasks.id, id))
      .returning();
    if (!row) throw new NotFoundError('Task');
    return toMissionTask(row);
  }

  async transition(
    id: string,
    to: TaskState,
    patch: TaskPatch,
    expectedState?: TaskState,
  ): Promise<MissionTask | null> {
    const [row] = await this.db
      .update(missionTasks)
      .set({
        ...buildTaskPatch(patch),
        state: to,
        lastActivityAt: patch.lastActivityAt ?? new Date(),
      })
      .where(
        expectedState
          ? and(eq(missionTasks.id, id), eq(missionTasks.state, expectedState))
          : eq(missionTasks.id, id),
      )
      .returning();
    return row ? toMissionTask(row) : null;
  }

  /**
   * Claim the next ready task.
   *
   * Every ceiling — global runs, runs per mission, writers per mission, read-only per mission,
   * active missions — is a sub-query inside the one `UPDATE`, and the row is selected
   * `FOR UPDATE SKIP LOCKED`. Two workers polling in the same millisecond therefore cannot both
   * see room for one more writer.
   *
   * Dependency readiness is checked here too: a task is claimable only when it has no dependency
   * that has not succeeded or been skipped. That means the scheduler cannot hand out a task whose
   * inputs do not exist yet, even if a stale `ready` state says otherwise.
   */
  async claimNext(request: TaskClaimRequest): Promise<TaskClaimResult | null> {
    if (!request.accepting || request.roles.length === 0) return null;

    const activeStates = sql.raw(CAPACITY_TASK_STATES.map((state) => `'${state}'`).join(', '));
    const writeRoles = sql.raw(WRITE_ROLES.map((role) => `'${role}'`).join(', '));
    const roles = sql.raw(
      request.roles
        .filter((role) => /^[a-z_]{3,40}$/.test(role))
        .map((role) => `'${role}'`)
        .join(', '),
    );
    if (request.roles.filter((role) => /^[a-z_]{3,40}$/.test(role)).length === 0) return null;

    /*
     * The unattended gate, as two filters inside the claim.
     *
     * A task belonging to a mission standing authority queued is claimable only when both its role
     * and its type are ones this deployment has qualified to run with nobody watching. Tasks on a
     * mission a person approved ignore the clause entirely.
     *
     * Both lists are intersected with their closed vocabularies before reaching the statement, so
     * nothing a caller passes can widen the SQL, and an empty intersection degrades to
     * `not m.autonomous` rather than to "everything".
     */
    const allowedRoles = AGENT_ROLES.filter((role) => request.unattendedRoles.includes(role));
    const allowedTypes = TASK_TYPES.filter((type) => request.unattendedTaskTypes.includes(type));
    /*
     * Guarded on the *intersections*, not on what the caller passed. A caller handing over values
     * that are not in the closed vocabularies would otherwise leave an empty list interpolated into
     * `in ()`, which is a syntax error rather than a refusal — and a claim path that throws instead
     * of returning nothing is a worker that stops polling.
     */
    const unattendedClause =
      allowedRoles.length === 0 || allowedTypes.length === 0
        ? sql`and not m.autonomous`
        : sql`and (
            not m.autonomous
            or (
              c.role in (${sql.raw(allowedRoles.map((role) => `'${role}'`).join(', '))})
              and c.task_type in (${sql.raw(allowedTypes.map((type) => `'${type}'`).join(', '))})
            )
          )`;

    const claimed = await this.db.execute(sql`
      update ${missionTasks} as t
      set state = 'claimed',
          assigned_worker_id = ${request.workerId},
          attempt = t.attempt + 1,
          last_activity_at = ${request.now}
      where t.id = (
        select c.id
        from ${missionTasks} as c
        join ${missions} as m on m.id = c.mission_id
        join ${missionTaskGraphs} as g on g.id = c.graph_id
        where c.state = 'ready'
          and c.role in (${roles})
          and c.attempt < c.max_attempts
          and g.state = 'approved'
          and m.approved_graph_version = c.graph_version
          and m.approved_plan_version = c.plan_version
          ${unattendedClause}
          /* Nothing it depends on is still outstanding. */
          and not exists (
            select 1
            from ${missionTaskDependencies} as d
            join ${missionTasks} as dep on dep.id = d.depends_on_task_id
            where d.task_id = c.id and dep.state not in ('succeeded', 'skipped')
          )
          /* Global agent ceiling. */
          and (
            select count(*) from ${missionTasks} as a where a.state in (${activeStates})
          ) < ${request.limits.maxActiveRuns}
          /* Per-mission agent ceiling. */
          and (
            select count(*) from ${missionTasks} as a
            where a.mission_id = c.mission_id and a.state in (${activeStates})
          ) < ${request.limits.maxRunsPerMission}
          /* One writer at a time per mission, unless configured otherwise. */
          and (
            c.role not in (${writeRoles})
            or (
              select count(*) from ${missionTasks} as a
              where a.mission_id = c.mission_id
                and a.state in (${activeStates})
                and a.role in (${writeRoles})
            ) < ${request.limits.maxParallelWriters}
          )
          /* Read-only parallelism ceiling. */
          and (
            c.role in (${writeRoles})
            or (
              select count(*) from ${missionTasks} as a
              where a.mission_id = c.mission_id
                and a.state in (${activeStates})
                and a.role not in (${writeRoles})
            ) < ${request.limits.maxParallelReadOnly}
          )
          /* Global mission ceiling, counted over missions that have something running. */
          and (
            c.mission_id in (
              select a.mission_id from ${missionTasks} as a where a.state in (${activeStates})
            )
            or (
              select count(distinct a.mission_id) from ${missionTasks} as a
              where a.state in (${activeStates})
            ) < ${request.limits.maxActiveMissions}
          )
        order by
          case m.priority when 'critical' then 0 when 'high' then 1 when 'medium' then 2 else 3 end,
          c.position asc,
          c.created_at asc,
          c.id asc
        limit 1
        for update skip locked
      )
      returning t.id
    `);

    const taskId = firstId(claimed);
    if (!taskId) return null;

    const task = await this.findById(taskId);
    if (!task) return null;

    const [runRow] = await this.db
      .insert(missionRuns)
      .values({
        missionId: task.missionId,
        workerId: request.workerId,
        attempt: task.attempt,
        kind:
          task.requiresRepository && (task.role === 'builder' || task.role === 'repairer')
            ? 'execution'
            : 'inspection',
        planVersion: task.planVersion,
        taskId: task.id,
        role: task.role,
        permissionProfileId: task.permissionProfileId,
        repairRound: task.repairRound,
        state: 'starting',
        startedAt: request.now,
      })
      .returning();
    if (!runRow) throw new ConflictError('The run for this task could not be created.');

    await this.patch(task.id, {
      activeRunId: runRow.id,
      startedAt: task.startedAt ? null : request.now,
      lastActivityAt: request.now,
    });

    const refreshed = await this.findById(task.id);
    if (!refreshed) throw new ConflictError('The task vanished while being claimed.');
    return { task: refreshed, runId: runRow.id };
  }

  async countActive(): Promise<number> {
    const rows = await this.db.execute(
      sql`select count(*)::int as id from ${missionTasks} where state in (${sql.raw(
        CAPACITY_TASK_STATES.map((state) => `'${state}'`).join(', '),
      )})`,
    );
    const value = rowsOf(rows)[0]?.id;
    return typeof value === 'number' ? value : Number(value ?? 0);
  }

  async countActiveMissions(): Promise<number> {
    const rows = await this.db.execute(
      sql`select count(distinct mission_id)::int as id from ${missionTasks} where state in (${sql.raw(
        CAPACITY_TASK_STATES.map((state) => `'${state}'`).join(', '),
      )})`,
    );
    const value = rowsOf(rows)[0]?.id;
    return typeof value === 'number' ? value : Number(value ?? 0);
  }
}

/** Drizzle property names, never SQL column names — `set()` takes the former. */
function buildTaskPatch(patch: TaskPatch): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const assign = <K extends keyof TaskPatch>(key: K, column: string): void => {
    if (patch[key] !== undefined) out[column] = patch[key];
  };
  assign('state', 'state');
  assign('assignedWorkerId', 'assignedWorkerId');
  assign('activeRunId', 'activeRunId');
  assign('attempt', 'attempt');
  assign('branchName', 'branchName');
  assign('baseSha', 'baseSha');
  assign('headSha', 'headSha');
  assign('workspacePath', 'workspacePath');
  assign('workspacePreserved', 'workspacePreserved');
  assign('failureCode', 'failureCode');
  assign('latestReviewId', 'latestReviewId');
  assign('reviewsTaskId', 'reviewsTaskId');
  assign('startedAt', 'startedAt');
  assign('finishedAt', 'finishedAt');
  assign('lastActivityAt', 'lastActivityAt');
  if (patch.actualChangedFiles !== undefined)
    out.actualChangedFiles = [...patch.actualChangedFiles];
  if (patch.declaredWriteSet !== undefined) {
    out.declaredWriteSet = [...normaliseWriteSet(patch.declaredWriteSet)];
  }
  if (patch.failureMessage !== undefined) {
    out.failureMessage =
      patch.failureMessage === null ? null : boundText(redactSecrets(patch.failureMessage), 2000);
  }
  if (patch.summary !== undefined) {
    out.summary = patch.summary === null ? null : boundText(redactSecrets(patch.summary), 4000);
  }
  if (patch.usage) {
    if (patch.usage.inputTokens !== undefined) out.usageInputTokens = patch.usage.inputTokens;
    if (patch.usage.outputTokens !== undefined) out.usageOutputTokens = patch.usage.outputTokens;
    if (patch.usage.totalCostUsd !== undefined) out.usageCostUsd = patch.usage.totalCostUsd;
    if (patch.usage.turns !== undefined) out.usageTurns = patch.usage.turns;
    if (patch.usage.durationMs !== undefined) out.usageDurationMs = patch.usage.durationMs;
  }
  return out;
}

/* --------------------------------------------------------------- the leases */

export class DrizzleWriteLeaseRepository implements WriteLeaseRepository {
  constructor(private readonly db: Database) {}

  /**
   * Take a lease if nothing overlapping is held.
   *
   * Postgres cannot express "no held lease whose path list overlaps mine" as an exclusion
   * constraint over a jsonb array of prefixes, so the overlap test happens here — but it happens
   * *inside a serialised read of the held leases followed by an insert that the partial unique
   * index guards*. The index guarantees one held lease per task; the overlap test guarantees two
   * tasks never hold overlapping ones. A losing racer sees its insert fail or its overlap check
   * reject, and either way returns `null` rather than proceeding.
   */
  async acquire(input: {
    missionId: string;
    taskId: string;
    runId: string | null;
    paths: readonly string[];
  }): Promise<WriteLease | null> {
    const wanted = normaliseWriteSet(input.paths);
    if (wanted.length === 0) return null;

    const held = await this.db
      .select()
      .from(missionWriteLeases)
      .where(
        and(
          eq(missionWriteLeases.missionId, input.missionId),
          eq(missionWriteLeases.state, 'held'),
        ),
      )
      .for('update');

    for (const lease of held) {
      if (lease.taskId === input.taskId) return toWriteLease(lease);
      if (writeSetsOverlap(lease.paths ?? [], wanted).overlaps) return null;
    }

    try {
      const [row] = await this.db
        .insert(missionWriteLeases)
        .values({
          missionId: input.missionId,
          taskId: input.taskId,
          runId: input.runId,
          paths: [...wanted],
          state: 'held',
        })
        .returning();
      return row ? toWriteLease(row) : null;
    } catch {
      /* The partial unique index refused: another attempt already holds this task's lease. */
      return null;
    }
  }

  async release(taskId: string, reason: string): Promise<void> {
    await this.db
      .update(missionWriteLeases)
      .set({ state: 'released', releasedAt: new Date(), releasedReason: boundText(reason, 300) })
      .where(and(eq(missionWriteLeases.taskId, taskId), eq(missionWriteLeases.state, 'held')));
  }

  async listHeld(missionId: string): Promise<readonly WriteLease[]> {
    const rows = await this.db
      .select()
      .from(missionWriteLeases)
      .where(
        and(eq(missionWriteLeases.missionId, missionId), eq(missionWriteLeases.state, 'held')),
      );
    return rows.map(toWriteLease);
  }

  async findForTask(taskId: string): Promise<WriteLease | null> {
    const [row] = await this.db
      .select()
      .from(missionWriteLeases)
      .where(and(eq(missionWriteLeases.taskId, taskId), eq(missionWriteLeases.state, 'held')))
      .limit(1);
    return row ? toWriteLease(row) : null;
  }
}

/* --------------------------------------------------------------- the reviews */

export class DrizzleReviewRepository implements ReviewRepository {
  constructor(private readonly db: Database) {}

  async create(
    input: ReviewCreateInput,
  ): Promise<{ review: MissionReview; findings: readonly ReviewFinding[] }> {
    const [reviewRow] = await this.db
      .insert(missionReviews)
      .values({
        missionId: input.missionId,
        taskId: input.taskId,
        runId: input.runId,
        graphVersion: input.graphVersion,
        planVersion: input.planVersion,
        reviewerRole: input.reviewerRole,
        verdict: input.verdict,
        proposedVerdict: input.proposedVerdict,
        overrideRule: input.overrideRule,
        overrideReason: input.overrideReason ? boundText(input.overrideReason, 600) : null,
        summary: boundText(redactSecrets(input.summary), 4000),
        diffFingerprint: input.diffFingerprint,
        reviewedFiles: [...input.reviewedFiles].slice(0, 500),
        verificationSnapshot: [...input.verificationSnapshot],
        repairRound: input.repairRound,
        coldContext: true,
        unavailableReason: input.unavailableReason
          ? boundText(redactSecrets(input.unavailableReason), 600)
          : null,
      })
      .returning();
    if (!reviewRow) throw new ConflictError('The review could not be recorded.');

    const findings = input.findings.length
      ? await this.db
          .insert(missionReviewFindings)
          .values(
            input.findings.map((finding) => ({
              reviewId: reviewRow.id,
              missionId: input.missionId,
              key: finding.key,
              severity: finding.severity,
              category: finding.category,
              title: boundText(redactSecrets(finding.title), 200),
              description: boundText(redactSecrets(finding.description), 4000),
              evidence: boundText(redactSecrets(finding.evidence), 4000),
              file: finding.file ? boundText(finding.file, 400) : null,
              line: finding.line ?? null,
              component: finding.component ? boundText(finding.component, 200) : null,
              violates: finding.violates ? boundText(redactSecrets(finding.violates), 600) : null,
              reproduction: finding.reproduction
                ? boundText(redactSecrets(finding.reproduction), 2000)
                : null,
              recommendation: boundText(redactSecrets(finding.recommendation), 2000),
              confidence: finding.confidence,
              blocksDelivery: finding.blocksDelivery,
              repairRound: input.repairRound,
              state: 'open' as const,
            })),
          )
          .returning()
      : [];

    return { review: toMissionReview(reviewRow), findings: findings.map(toReviewFinding) };
  }

  async findById(id: string): Promise<MissionReview | null> {
    const [row] = await this.db
      .select()
      .from(missionReviews)
      .where(eq(missionReviews.id, id))
      .limit(1);
    return row ? toMissionReview(row) : null;
  }

  async listByMission(missionId: string): Promise<readonly MissionReview[]> {
    const rows = await this.db
      .select()
      .from(missionReviews)
      .where(eq(missionReviews.missionId, missionId))
      .orderBy(asc(missionReviews.createdAt));
    return rows.map(toMissionReview);
  }

  async latestForTask(taskId: string): Promise<MissionReview | null> {
    const [row] = await this.db
      .select()
      .from(missionReviews)
      .where(eq(missionReviews.taskId, taskId))
      .orderBy(desc(missionReviews.createdAt))
      .limit(1);
    return row ? toMissionReview(row) : null;
  }

  async listFindings(missionId: string): Promise<readonly ReviewFinding[]> {
    const rows = await this.db
      .select()
      .from(missionReviewFindings)
      .where(eq(missionReviewFindings.missionId, missionId))
      .orderBy(asc(missionReviewFindings.createdAt));
    return rows.map(toReviewFinding);
  }

  async listFindingsForReview(reviewId: string): Promise<readonly ReviewFinding[]> {
    const rows = await this.db
      .select()
      .from(missionReviewFindings)
      .where(eq(missionReviewFindings.reviewId, reviewId))
      .orderBy(asc(missionReviewFindings.key));
    return rows.map(toReviewFinding);
  }

  async setFindingState(
    id: string,
    state: ReviewFinding['state'],
    patch: {
      ownerDecision?: string | null;
      resolvedByTaskId?: string | null;
      triageRule?: string | null;
    } = {},
  ): Promise<ReviewFinding> {
    const [row] = await this.db
      .update(missionReviewFindings)
      .set({
        state,
        ...(patch.ownerDecision !== undefined
          ? { ownerDecision: patch.ownerDecision ? boundText(patch.ownerDecision, 2000) : null }
          : {}),
        ...(patch.resolvedByTaskId !== undefined
          ? { resolvedByTaskId: patch.resolvedByTaskId }
          : {}),
        ...(patch.triageRule !== undefined ? { triageRule: patch.triageRule } : {}),
        ...(state === 'repaired' || state === 'rejected' ? { resolvedAt: new Date() } : {}),
      })
      .where(eq(missionReviewFindings.id, id))
      .returning();
    if (!row) throw new NotFoundError('Finding');
    return toReviewFinding(row);
  }
}

/* -------------------------------------------------------------- the receipt */

export class DrizzleReceiptRepository implements ReceiptRepository {
  constructor(private readonly db: Database) {}

  async upsert(input: Parameters<ReceiptRepository['upsert']>[0]): Promise<CompletionReceipt> {
    const content = redactDeep(input.content) as typeof input.content;
    const [row] = await this.db
      .insert(missionReceipts)
      .values({
        missionId: input.missionId,
        graphVersion: input.graphVersion,
        planVersion: input.planVersion,
        content,
      })
      .onConflictDoUpdate({
        target: [missionReceipts.missionId, missionReceipts.graphVersion],
        set: { content, createdAt: new Date() },
      })
      .returning();
    if (!row) throw new ConflictError('The completion receipt could not be stored.');
    return toReceipt(row);
  }

  async findByMission(missionId: string): Promise<CompletionReceipt | null> {
    const [row] = await this.db
      .select()
      .from(missionReceipts)
      .where(eq(missionReceipts.missionId, missionId))
      .orderBy(desc(missionReceipts.graphVersion))
      .limit(1);
    return row ? toReceipt(row) : null;
  }
}

/* ------------------------------------------------------------- the playbooks */

export class DrizzlePlaybookRepository implements PlaybookRepository {
  constructor(private readonly db: Database) {}

  async list(): Promise<readonly (Playbook & { definition: PlaybookDefinition })[]> {
    const rows = await this.db.select().from(playbooks).orderBy(asc(playbooks.name));
    const out: (Playbook & { definition: PlaybookDefinition })[] = [];
    for (const row of rows) {
      const version = await this.latestVersion(row.key);
      if (!version) continue;
      out.push({ ...toPlaybook(row), definition: version.definition });
    }
    return out;
  }

  async findByKey(key: string): Promise<Playbook | null> {
    const [row] = await this.db.select().from(playbooks).where(eq(playbooks.key, key)).limit(1);
    return row ? toPlaybook(row) : null;
  }

  async version(key: string, version: number): Promise<PlaybookVersion | null> {
    const [row] = await this.db
      .select()
      .from(playbookVersions)
      .where(and(eq(playbookVersions.playbookKey, key), eq(playbookVersions.version, version)))
      .limit(1);
    return row ? toPlaybookVersion(row) : null;
  }

  async latestVersion(key: string): Promise<PlaybookVersion | null> {
    const [row] = await this.db
      .select()
      .from(playbookVersions)
      .where(eq(playbookVersions.playbookKey, key))
      .orderBy(desc(playbookVersions.version))
      .limit(1);
    return row ? toPlaybookVersion(row) : null;
  }

  /**
   * Install or update a playbook.
   *
   * An identical definition is a no-op returning `created: false` — the same "a no-op edit makes
   * no version" discipline plans already have, so re-seeding the built-ins on every boot does not
   * grow the history by one version per restart.
   */
  async install(input: {
    definition: PlaybookDefinition;
    fingerprint: string;
    builtIn: boolean;
    createdBy: string;
    note?: string | null;
  }): Promise<{ playbook: Playbook; version: PlaybookVersion; created: boolean }> {
    const existing = await this.findByKey(input.definition.key);
    if (existing) {
      const latest = await this.latestVersion(existing.key);
      if (latest && latest.fingerprint === input.fingerprint) {
        return { playbook: existing, version: latest, created: false };
      }
      const nextVersion = (latest?.version ?? 0) + 1;
      const [versionRow] = await this.db
        .insert(playbookVersions)
        .values({
          playbookId: existing.id,
          playbookKey: existing.key,
          version: nextVersion,
          definition: input.definition,
          fingerprint: input.fingerprint,
          createdBy: input.createdBy,
          note: input.note ?? null,
        })
        .returning();
      if (!versionRow) throw new ConflictError('The playbook version could not be stored.');
      const [playbookRow] = await this.db
        .update(playbooks)
        .set({
          name: input.definition.name,
          description: input.definition.description,
          latestVersion: nextVersion,
          updatedAt: new Date(),
        })
        .where(eq(playbooks.id, existing.id))
        .returning();
      return {
        playbook: toPlaybook(playbookRow ?? ({ ...existing } as never)),
        version: toPlaybookVersion(versionRow),
        created: true,
      };
    }

    const [playbookRow] = await this.db
      .insert(playbooks)
      .values({
        key: input.definition.key,
        name: input.definition.name,
        description: input.definition.description,
        builtIn: input.builtIn,
        enabled: true,
        latestVersion: 1,
      })
      .returning();
    if (!playbookRow) throw new ConflictError('The playbook could not be created.');
    const [versionRow] = await this.db
      .insert(playbookVersions)
      .values({
        playbookId: playbookRow.id,
        playbookKey: playbookRow.key,
        version: 1,
        definition: input.definition,
        fingerprint: input.fingerprint,
        createdBy: input.createdBy,
        note: input.note ?? null,
      })
      .returning();
    if (!versionRow) throw new ConflictError('The playbook version could not be stored.');
    return {
      playbook: toPlaybook(playbookRow),
      version: toPlaybookVersion(versionRow),
      created: true,
    };
  }

  async setEnabled(key: string, enabled: boolean): Promise<Playbook> {
    const [row] = await this.db
      .update(playbooks)
      .set({ enabled, updatedAt: new Date() })
      .where(eq(playbooks.key, key))
      .returning();
    if (!row) throw new NotFoundError('Playbook');
    return toPlaybook(row);
  }

  async listVersions(key: string): Promise<readonly PlaybookVersion[]> {
    const rows = await this.db
      .select()
      .from(playbookVersions)
      .where(eq(playbookVersions.playbookKey, key))
      .orderBy(desc(playbookVersions.version));
    return rows.map(toPlaybookVersion);
  }
}

/* -------------------------------------------------------- CI and releases */

export class DrizzleCiDispatchRepository implements CiDispatchRepository {
  constructor(private readonly db: Database) {}

  async record(
    input: Parameters<CiDispatchRepository['record']>[0],
  ): Promise<{ dispatch: CiDispatch; created: boolean }> {
    const [existing] = await this.db
      .select()
      .from(ciDispatches)
      .where(eq(ciDispatches.idempotencyKey, input.idempotencyKey))
      .limit(1);
    if (existing) return { dispatch: toCiDispatch(existing), created: false };

    const [row] = await this.db
      .insert(ciDispatches)
      .values({
        missionId: input.missionId,
        taskId: input.taskId,
        projectId: input.projectId,
        purpose: input.purpose,
        repositoryFullName: input.repositoryFullName,
        workflowFile: input.workflowFile,
        ref: input.ref,
        commitSha: input.commitSha,
        inputs: { ...input.inputs },
        inputsFingerprint: input.inputsFingerprint,
        idempotencyKey: input.idempotencyKey,
        requestedBy: input.requestedBy,
        state: input.state,
        refusalRule: input.refusalRule ?? null,
        refusalReason: input.refusalReason ? boundText(input.refusalReason, 600) : null,
      })
      .returning();
    if (!row) throw new ConflictError('The dispatch could not be recorded.');
    return { dispatch: toCiDispatch(row), created: true };
  }

  async findById(id: string): Promise<CiDispatch | null> {
    const [row] = await this.db.select().from(ciDispatches).where(eq(ciDispatches.id, id)).limit(1);
    return row ? toCiDispatch(row) : null;
  }

  async patch(
    id: string,
    patch: Parameters<CiDispatchRepository['patch']>[1],
  ): Promise<CiDispatch> {
    const [row] = await this.db
      .update(ciDispatches)
      .set({
        ...patch,
        stageReport: patch.stageReport ? [...patch.stageReport] : undefined,
        ...(patch.refusalReason !== undefined
          ? { refusalReason: patch.refusalReason ? boundText(patch.refusalReason, 600) : null }
          : {}),
        updatedAt: new Date(),
      })
      .where(eq(ciDispatches.id, id))
      .returning();
    if (!row) throw new NotFoundError('Dispatch');
    return toCiDispatch(row);
  }

  async listRecent(limit = 30): Promise<readonly CiDispatch[]> {
    const rows = await this.db
      .select()
      .from(ciDispatches)
      .orderBy(desc(ciDispatches.requestedAt))
      .limit(Math.min(limit, 200));
    return rows.map(toCiDispatch);
  }

  async countSince(since: Date): Promise<number> {
    const rows = await this.db
      .select({ id: ciDispatches.id })
      .from(ciDispatches)
      .where(and(gte(ciDispatches.requestedAt, since), sql`${ciDispatches.state} <> 'refused'`));
    return rows.length;
  }

  async listForMission(missionId: string): Promise<readonly CiDispatch[]> {
    const rows = await this.db
      .select()
      .from(ciDispatches)
      .where(eq(ciDispatches.missionId, missionId))
      .orderBy(desc(ciDispatches.requestedAt));
    return rows.map(toCiDispatch);
  }
}

export class DrizzleReleaseApprovalRepository implements ReleaseApprovalRepository {
  constructor(private readonly db: Database) {}

  async create(
    input: Parameters<ReleaseApprovalRepository['create']>[0],
  ): Promise<ReleaseApproval> {
    const [row] = await this.db
      .insert(releaseApprovals)
      .values({
        missionId: input.missionId,
        projectId: input.projectId,
        repositoryFullName: input.repositoryFullName,
        workflowFile: input.workflowFile,
        ref: input.ref,
        commitSha: input.commitSha,
        inputs: { ...input.inputs },
        identity: input.identity,
        state: 'approved',
        approvedBy: input.approvedBy,
        approvedAt: new Date(),
        bundleIdentifier: input.bundleIdentifier,
      })
      .returning();
    if (!row) throw new ConflictError('That approval could not be recorded.');
    return toReleaseApproval(row);
  }

  async findActiveForIdentity(identity: string): Promise<ReleaseApproval | null> {
    const [row] = await this.db
      .select()
      .from(releaseApprovals)
      .where(and(eq(releaseApprovals.identity, identity), eq(releaseApprovals.state, 'approved')))
      .limit(1);
    return row ? toReleaseApproval(row) : null;
  }

  async listForProject(projectId: string): Promise<readonly ReleaseApproval[]> {
    const rows = await this.db
      .select()
      .from(releaseApprovals)
      .where(eq(releaseApprovals.projectId, projectId))
      .orderBy(desc(releaseApprovals.createdAt));
    return rows.map(toReleaseApproval);
  }

  async setState(
    id: string,
    state: ReleaseApproval['state'],
    patch: { supersededReason?: string | null; dispatchId?: string | null } = {},
  ): Promise<ReleaseApproval> {
    const [row] = await this.db
      .update(releaseApprovals)
      .set({
        state,
        ...(state === 'revoked' ? { revokedAt: new Date() } : {}),
        ...(patch.supersededReason !== undefined
          ? {
              supersededReason: patch.supersededReason
                ? boundText(patch.supersededReason, 300)
                : null,
            }
          : {}),
        ...(patch.dispatchId !== undefined ? { dispatchId: patch.dispatchId } : {}),
      })
      .where(eq(releaseApprovals.id, id))
      .returning();
    if (!row) throw new NotFoundError('Approval');
    return toReleaseApproval(row);
  }

  async supersedeOthers(projectId: string, keepIdentity: string, reason: string): Promise<number> {
    const rows = await this.db
      .update(releaseApprovals)
      .set({ state: 'superseded', supersededReason: boundText(reason, 300) })
      .where(
        and(
          eq(releaseApprovals.projectId, projectId),
          eq(releaseApprovals.state, 'approved'),
          sql`${releaseApprovals.identity} <> ${keepIdentity}`,
        ),
      )
      .returning();
    return rows.length;
  }
}

/* ------------------------------------------------------------- the wallboard */

export class DrizzleDisplayDeviceRepository implements DisplayDeviceRepository {
  constructor(private readonly db: Database) {}

  async create(input: Parameters<DisplayDeviceRepository['create']>[0]): Promise<DisplayDevice> {
    const [row] = await this.db
      .insert(displayDevices)
      .values({
        id: input.id,
        name: boundText(input.name, 60),
        location: input.location ? boundText(input.location, 120) : null,
        tokenHash: input.tokenHash,
        tokenPrefix: input.tokenPrefix,
        scopes: [...input.scopes],
        rotationSeconds: input.rotationSeconds,
        expiresAt: input.expiresAt,
      })
      .returning();
    if (!row) throw new ConflictError('The display could not be paired.');
    return toDisplayDevice(row);
  }

  async list(): Promise<readonly DisplayDevice[]> {
    const rows = await this.db
      .select()
      .from(displayDevices)
      .orderBy(desc(displayDevices.createdAt));
    return rows.map(toDisplayDevice);
  }

  async findById(id: string): Promise<DisplayDevice | null> {
    const [row] = await this.db
      .select()
      .from(displayDevices)
      .where(eq(displayDevices.id, id))
      .limit(1);
    return row ? toDisplayDevice(row) : null;
  }

  /** The only method that reads the hash. It never leaves the display auth module. */
  async findAuthRecord(id: string): Promise<DisplayDeviceAuthRecord | null> {
    const [row] = await this.db
      .select({
        id: displayDevices.id,
        tokenHash: displayDevices.tokenHash,
        revokedAt: displayDevices.revokedAt,
        expiresAt: displayDevices.expiresAt,
      })
      .from(displayDevices)
      .where(eq(displayDevices.id, id))
      .limit(1);
    if (!row) return null;
    return {
      id: row.id,
      tokenHash: row.tokenHash,
      revokedAt: row.revokedAt ? row.revokedAt.toISOString() : null,
      expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
    };
  }

  async touch(id: string, userAgent: string | null): Promise<void> {
    await this.db
      .update(displayDevices)
      .set({
        lastSeenAt: new Date(),
        lastSeenUserAgent: userAgent ? boundText(userAgent, 200) : null,
      })
      .where(eq(displayDevices.id, id));
  }

  async revoke(id: string, reason: string | null): Promise<DisplayDevice> {
    const [row] = await this.db
      .update(displayDevices)
      .set({ revokedAt: new Date(), revokedReason: reason ? boundText(reason, 300) : null })
      .where(eq(displayDevices.id, id))
      .returning();
    if (!row) throw new NotFoundError('Display');
    return toDisplayDevice(row);
  }

  async remove(id: string): Promise<void> {
    await this.db.delete(displayDevices).where(eq(displayDevices.id, id));
  }
}

/* --------------------------------------------------------- the app factory */

export class DrizzleAppProfileRepository implements AppProfileRepository {
  constructor(private readonly db: Database) {}

  async findByProject(projectId: string): Promise<ReturnType<typeof toAppProfile> | null> {
    const [row] = await this.db
      .select()
      .from(projectAppProfiles)
      .where(eq(projectAppProfiles.projectId, projectId))
      .limit(1);
    return row ? toAppProfile(row) : null;
  }

  async upsert(
    projectId: string,
    input: AppProfileInput,
  ): Promise<ReturnType<typeof toAppProfile>> {
    const values = {
      projectId,
      platform: input.platform,
      appName: input.appName ?? null,
      bundleIdentifier: input.bundleIdentifier ?? null,
      sku: input.sku ?? null,
      teamIdentifierReference: input.teamIdentifierReference ?? null,
      appCategory: input.appCategory ?? null,
      primaryColor: input.primaryColor ?? null,
      iconState: input.iconState,
      subscriptionModel: input.subscriptionModel,
      storeKitProductIds: [...input.storeKitProductIds],
      requiresWidget: input.requiresWidget,
      requiresAppGroup: input.requiresAppGroup,
      appGroupIdentifier: input.appGroupIdentifier ?? null,
      requiresNotifications: input.requiresNotifications,
      privacySensitiveApis: [...input.privacySensitiveApis],
      websiteRepository: input.websiteRepository ?? null,
      websiteDomain: input.websiteDomain ?? null,
      supportUrl: input.supportUrl ?? null,
      privacyUrl: input.privacyUrl ?? null,
      termsUrl: input.termsUrl ?? null,
      testFlightWorkflow: input.testFlightWorkflow ?? null,
      signingSecretNames: [...input.signingSecretNames],
      notes: input.notes ?? null,
      updatedAt: new Date(),
    };
    const [row] = await this.db
      .insert(projectAppProfiles)
      .values(values)
      .onConflictDoUpdate({ target: projectAppProfiles.projectId, set: values })
      .returning();
    if (!row) throw new ConflictError('The app profile could not be saved.');
    return toAppProfile(row);
  }

  async remove(projectId: string): Promise<void> {
    await this.db.delete(projectAppProfiles).where(eq(projectAppProfiles.projectId, projectId));
  }

  async list(): Promise<readonly ReturnType<typeof toAppProfile>[]> {
    const rows = await this.db.select().from(projectAppProfiles);
    return rows.map(toAppProfile);
  }
}

/* Re-exported so the container imports every factory repository from one place. */
export { isNull };
