import { createHash } from 'node:crypto';
import { ConflictError, ForbiddenError, NotFoundError } from '@/domain/errors';
import { AGENT_ROLES, isReviewRole, isWriteRole, type AgentRole } from '@/domain/agent-role';
import type { QualificationLevel } from '@/domain/qualification';
import {
  taskUnattendedCapabilities,
  unattendedTaskRoles,
  unattendedTaskTypes,
  unattendedVerdict,
} from '@/domain/unattended';
import {
  assertTaskTransition,
  isTerminalTaskState,
  type MissionTask,
  type TaskState,
} from '@/domain/mission-task';
import { buildBranchName, slugifyForBranch } from '@/domain/workspace-safety';
import type { UsageRepository } from '@/server/repositories/accounting-types';
import { usageOutcomeFor, usageRowForRun } from './usage-ledger';
import { autonomousWriteScopeVerdict, normaliseWriteSet } from '@/domain/write-set';
import { boundText, redactSecrets } from '@/domain/redaction';
import type { ReviewSubmissionInput } from '@/domain/mission-review';
import type { MissionPlanContent } from '@/domain/mission-plan';
import type { TaskAssignment } from '@/domain/worker-protocol';
import type { CapacityLimits } from '@/domain/capacity';
import type {
  ArtifactRepository,
  EventRepository,
  MissionRepository,
  PlanRepository,
  RunRepository,
  VerificationRepository,
  WorkerRepository,
} from '../repositories/mission-types';
import type { ProjectRepository, SourceRepository } from '../repositories/types';
import type {
  ReviewRepository,
  TaskGraphRepository,
  TaskRepository,
  WriteLeaseRepository,
} from '../repositories/factory-types';
import type { MissionOrchestrator } from './orchestrator';
import { resolveMissionRepository } from './repository-resolution';

/**
 * The worker's side of the task protocol.
 *
 * Same discipline as `WorkerService` in Prompt 2, and for the same reason: every method starts by
 * proving the caller owns what it is talking about. `authoriseTask` is the single choke point —
 * the task exists, its run belongs to *this* worker, and that run is still the task's active run.
 * A worker that has been superseded cannot report on a task it no longer holds.
 *
 * The assignment this service builds is assembled entirely from Jarvis's own tables. Nothing a
 * previous agent said reaches a later one except through a record the orchestrator chose to
 * include — which is what makes the reviewer's cold context a property of the protocol rather
 * than a convention the prompt asks for.
 */

export interface TaskWorkerServiceDeps {
  readonly missions: MissionRepository;
  readonly plans: PlanRepository;
  readonly graphs: TaskGraphRepository;
  readonly tasks: TaskRepository;
  readonly leases: WriteLeaseRepository;
  readonly reviews: ReviewRepository;
  readonly runs: RunRepository;
  readonly events: EventRepository;
  readonly verifications: VerificationRepository;
  readonly artifacts: ArtifactRepository;
  readonly workers: WorkerRepository;
  readonly projects: ProjectRepository;
  readonly sources: SourceRepository;
  readonly orchestrator: MissionOrchestrator;
  /**
   * The spend ledger.
   *
   * Required rather than optional, because this protocol ran without one for its whole life and an
   * optional dependency is one a container eventually forgets to pass.
   */
  readonly usage: UsageRepository;
  readonly limits: CapacityLimits;
  readonly allowWebResearch: boolean;
  /**
   * The qualification rung in force right now.
   *
   * Required and asked late, for the same two reasons as on `WorkerService`: an optional gate is
   * a gate somebody forgets to pass, and a rung read at start-up is a rung that keeps handing out
   * work after a demotion.
   */
  readonly currentLevel: () => Promise<QualificationLevel>;
  readonly clock?: () => Date;
}

export class TaskWorkerService {
  private readonly clock: () => Date;

  constructor(private readonly deps: TaskWorkerServiceDeps) {
    this.clock = deps.clock ?? (() => new Date());
  }

  /* --------------------------------------------------------------- claiming */

  /**
   * Hand out the next task this worker may take.
   *
   * The claim itself is one atomic statement in the repository; everything here is preparation
   * and assembly. A worker that names no roles, or names only roles it cannot perform, gets
   * nothing rather than something it will fail at.
   */
  async claimTask(workerId: string, roles: readonly string[]): Promise<TaskAssignment | null> {
    const worker = await this.deps.workers.findById(workerId);
    if (!worker || worker.revokedAt) return null;

    const valid = roles.filter((role): role is AgentRole =>
      (AGENT_ROLES as readonly string[]).includes(role),
    );
    if (valid.length === 0) return null;

    const posture = await this.deps.orchestrator.posture();
    const limits = await this.deps.orchestrator.limits();

    /*
     * The unattended gate: a loose filter in the claim, an exact assertion after it.
     *
     * The filter cannot express "this role *with* this type", because the two columns are checked
     * independently in SQL; the assertion below can, and does. So a deployment qualified for
     * read-only agent work but not for delivery will filter in a `coordinator` and a `delivery`
     * type separately, claim neither together, and — if the two ever did meet on one row — refuse
     * it here before a pull request is opened.
     */
    const level = await this.deps.currentLevel();
    const claimed = await this.deps.tasks.claimNext({
      workerId,
      now: this.clock(),
      roles: valid,
      limits: {
        maxActiveRuns: limits.maxActiveRuns,
        maxRunsPerMission: limits.maxRunsPerMission,
        maxParallelWriters: limits.maxParallelWriters,
        maxParallelReadOnly: limits.maxParallelReadOnly,
        maxActiveMissions: limits.maxActiveMissions,
      },
      accepting: posture === 'open',
      unattendedRoles: unattendedTaskRoles(level),
      unattendedTaskTypes: unattendedTaskTypes(level),
    });
    if (!claimed) return null;

    /*
     * The exact gate, and the unwind that has to come with it.
     *
     * Reaching the refusal is a bug — the two filters above should have skipped the row — but a
     * gate that only holds while an adjacent SQL clause is correct is not a gate. If it fires, the
     * task has to go back to `ready` rather than sit in `claimed` with a run nobody is executing,
     * where it is invisible to every ceiling and blocks its own mission indefinitely.
     *
     * It returns null rather than throwing: a 403 would kill the worker's poll loop over a
     * control-plane defect the worker had no part in.
     */
    const mission = await this.deps.missions.findById(claimed.task.missionId);
    if (mission?.autonomous) {
      const verdict = unattendedVerdict(
        taskUnattendedCapabilities(claimed.task.role, claimed.task.taskType),
        level,
      );
      if (!verdict.allowed) {
        await this.deps.runs.patch(claimed.runId, {
          state: 'failed',
          finishedAt: this.clock(),
          failureCode: 'policy_violation',
          failureMessage: verdict.reason ?? 'Not qualified to run unattended.',
        });
        await this.deps.tasks.transition(
          claimed.task.id,
          'ready',
          { assignedWorkerId: null, activeRunId: null, lastActivityAt: this.clock() },
          'claimed',
        );
        await this.deps.events.record(claimed.task.missionId, {
          type: 'policy_refusal',
          actor: 'system',
          level: 'warning',
          summary: verdict.reason ?? 'Not qualified to run unattended.',
          detail: { taskKey: claimed.task.key, runId: claimed.runId },
        });
        return null;
      }

      /*
       * The write-scope gate, and why it ends the task rather than releasing it.
       *
       * `deriveWriteSet` falls back to the whole repository when a plan named no path-like areas,
       * and the deterministic planner's only `affectedAreas` entry is the sentence "To be confirmed
       * by inspection before any change is made." That is not a path, so every deterministically
       * planned write mission was granted the entire repository — which turned the write-set
       * control off end to end for precisely the missions nobody was watching.
       *
       * The gate above releases back to `ready`, because reaching it is a bug and the row should
       * be reconsidered. This one must not: the write set is fixed for the attempt, so releasing
       * would re-claim and re-refuse for ever, burning a claim cycle every few seconds and never
       * telling anybody. Failing it stops the loop and puts the reason where the owner reads it —
       * and the mission's own repair and attempt rules then apply as they would to any failure.
       */
      const scope = autonomousWriteScopeVerdict({
        writeSet: claimed.task.declaredWriteSet,
        unattended: true,
      });
      if (!scope.allowed) {
        await this.deps.runs.patch(claimed.runId, {
          state: 'failed',
          finishedAt: this.clock(),
          failureCode: 'policy_violation',
          failureMessage: scope.reason,
        });
        await this.deps.tasks.transition(
          claimed.task.id,
          'failed',
          {
            assignedWorkerId: null,
            activeRunId: null,
            lastActivityAt: this.clock(),
            failureMessage: scope.reason,
          },
          'claimed',
        );
        await this.deps.events.record(claimed.task.missionId, {
          type: 'policy_refusal',
          actor: 'system',
          level: 'warning',
          summary: scope.reason,
          detail: { taskKey: claimed.task.key, runId: claimed.runId, rule: scope.rule },
        });
        return null;
      }
    }

    await this.deps.events.record(claimed.task.missionId, {
      type: 'run_started',
      actor: 'system',
      summary: `${claimed.task.key} (${claimed.task.role}) was claimed by ${worker.name}.`,
      detail: { taskKey: claimed.task.key, runId: claimed.runId },
    });
    await this.deps.orchestrator.tick(claimed.task.missionId);

    return this.buildAssignment(claimed.task, claimed.runId);
  }

  /**
   * Assemble everything a task needs, and nothing it does not.
   *
   * The `review` block is populated only for a review role. That is the mechanism behind cold
   * context: a builder's assignment has `review: null` and a reviewer's has no field that could
   * carry a builder's transcript, so the separation is structural rather than remembered.
   */
  private async buildAssignment(task: MissionTask, runId: string): Promise<TaskAssignment> {
    const mission = await this.deps.missions.findById(task.missionId);
    if (!mission) throw new NotFoundError('Mission');
    const graph = await this.deps.graphs.byVersion(task.missionId, task.graphVersion);
    const plan = await this.deps.plans.byVersion(task.missionId, task.planVersion);
    const project = mission.projectId ? await this.deps.projects.findById(mission.projectId) : null;
    const siblings = graph ? await this.deps.tasks.listByGraph(graph.id) : [];
    const verifications = await this.deps.verifications.list(task.missionId);
    const artifacts = await this.deps.artifacts.list(task.missionId);

    const repository = await this.resolveRepository(mission);
    const branchName = await this.ensureBranch(task, mission);
    const integrationBranch = await this.ensureIntegrationBranch(mission);
    /*
     * A repair continues the branch it repairs. Chosen here rather than by the worker, for the
     * same reason branch names are: the control plane knows which task this repairs, and a
     * worker choosing its own starting point is a worker choosing what it is allowed to build on.
     */
    const repaired = task.reviewsTaskId
      ? null
      : task.repairRound > 0
        ? (siblings.find((sibling) => sibling.repairRound === 0 && isWriteRole(sibling.role)) ??
          null)
        : null;
    const baseTaskBranch = repaired?.branchName ?? null;

    /* An integrator merges the finished write branches, in dependency order. */
    const merging = siblings
      .filter((sibling) => sibling.state === 'succeeded' && sibling.branchName)
      .sort((left, right) => left.position - right.position)
      .filter((sibling) => sibling.branchName !== integrationBranch);
    const mergeBranches = merging.map((sibling) => sibling.branchName!);
    /*
     * What those branches were collectively approved to change. Assembled here from the stored
     * write sets rather than reported by the worker, because a scope the worker supplies is a
     * scope the worker can widen.
     */
    const mergeWriteSet = normaliseWriteSet(
      merging.flatMap((sibling) => [...sibling.declaredWriteSet]),
    );

    const review = isReviewRole(task.role)
      ? await this.buildReviewInputs(task, mission, plan?.content ?? null, artifacts)
      : null;

    const repairScope =
      task.repairRound > 0
        ? (await this.deps.reviews.listFindings(task.missionId))
            .filter((finding) => finding.state === 'accepted')
            .map((finding) => ({
              key: finding.key,
              severity: finding.severity,
              title: finding.title,
              recommendation: finding.recommendation,
              file: finding.file,
            }))
        : null;

    return {
      kind: 'task',
      missionId: mission.id,
      runId,
      taskId: task.id,
      taskKey: task.key,
      graphVersion: task.graphVersion,
      attempt: task.attempt,
      role: task.role,
      permissionProfileId: task.permissionProfileId,
      taskType: task.taskType,
      title: task.title,
      description: task.description,
      acceptanceCriteria: task.acceptanceCriteria,
      expectedInputs: task.expectedInputs,
      expectedOutputs: task.expectedOutputs,
      workspaceRequirement: task.workspaceRequirement,
      declaredWriteSet: task.declaredWriteSet,
      branchName,
      baseTaskBranch,
      integrationBranch,
      mergeBranches,
      mergeWriteSet,
      repairRound: task.repairRound,
      maxTurns: task.maxTurns,
      timeLimitMs: task.timeLimitMs,
      maxOutputTokens: task.maxOutputTokens,

      missionTitle: mission.title,
      rawRequest: mission.rawRequest,
      missionType: mission.type,
      riskLevel: mission.riskLevel,
      projectId: mission.projectId ?? '',
      projectName: project?.name ?? 'this project',
      projectGoal: project?.goal ?? null,
      planVersion: task.planVersion,
      plan: plan?.content ?? null,
      graphSummary: graph?.summary ?? '',
      siblingTasks: siblings.map((sibling) => ({
        key: sibling.key,
        title: sibling.title,
        role: sibling.role,
        state: sibling.state,
      })),
      constraints: mission.constraints,
      doNotTouch: mission.doNotTouch,
      repository,
      clarifications: [],
      projectContext: [],
      allowWebResearch: this.deps.allowWebResearch,
      review,
      repairScope,
      verification: verifications.map((record) => ({
        check: record.command,
        outcome: record.outcome,
        required: record.source !== 'optional',
        detail: record.reason ?? `exit ${record.exitCode ?? '—'}`,
      })),
    };
  }

  /**
   * What the reviewer sees.
   *
   * Assembled from the plan, the criteria, the recorded diff and the artifacts. There is no
   * parameter here for a transcript and no code path that reads `mission_events` of type
   * `agent_message` — a reviewer's world is built from records, never from another agent's words.
   */
  private async buildReviewInputs(
    task: MissionTask,
    mission: Awaited<ReturnType<MissionRepository['findById']>>,
    plan: MissionPlanContent | null,
    artifacts: Awaited<ReturnType<ArtifactRepository['list']>>,
  ): Promise<TaskAssignment['review']> {
    const graph = await this.deps.graphs.byVersion(task.missionId, task.graphVersion);
    const siblings = graph ? await this.deps.tasks.listByGraph(graph.id) : [];
    const integration = siblings.find((sibling) => sibling.taskType === 'integration');
    const changedFiles = [...new Set(siblings.flatMap((sibling) => sibling.actualChangedFiles))];
    const content = plan;

    /*
     * The diff is identified by its head sha rather than carried inline: the worker already has
     * the integration branch checked out and can produce the diff itself, and shipping a large
     * patch through the control plane would be storing a copy of the repository in the database.
     */
    const fingerprint = createHash('sha256')
      .update(`${integration?.headSha ?? ''}|${changedFiles.sort().join('|')}`)
      .digest('hex');

    return {
      planSummary: content?.summary ?? mission?.title ?? '',
      planApproach: content?.approach ?? '',
      planScope: content?.scope ?? [],
      planOutOfScope: content?.outOfScope ?? [],
      acceptanceCriteria: content?.acceptanceCriteria ?? mission?.acceptanceCriteria ?? [],
      /* Empty: the reviewer reads the diff from its own clone, which is the honest source. */
      diff: '',
      changedFiles,
      diffFingerprint: fingerprint,
      artifacts: artifacts.map((artifact) => ({ title: artifact.title, kind: artifact.kind })),
      repositoryInstructions: null,
    };
  }

  private async resolveRepository(
    mission: NonNullable<Awaited<ReturnType<MissionRepository['findById']>>>,
  ): Promise<TaskAssignment['repository']> {
    const sources = mission.projectId
      ? await this.deps.sources.listByProject(mission.projectId)
      : [];
    return resolveMissionRepository(mission, sources);
  }

  /** A task branch is built from the mission id and the task key, then re-validated. */
  private async ensureBranch(
    task: MissionTask,
    mission: NonNullable<Awaited<ReturnType<MissionRepository['findById']>>>,
  ): Promise<string | null> {
    if (task.workspaceRequirement !== 'task_workspace') return task.branchName;
    if (task.branchName) return task.branchName;
    const slug = slugifyForBranch(`${task.key} ${task.title}`) || task.key;
    const branch = buildBranchName(mission.id, slug);
    await this.deps.tasks.patch(task.id, { branchName: branch });
    return branch;
  }

  private async ensureIntegrationBranch(
    mission: NonNullable<Awaited<ReturnType<MissionRepository['findById']>>>,
  ): Promise<string | null> {
    if (mission.integrationBranch) return mission.integrationBranch;
    const branch = buildBranchName(mission.id, 'integration');
    await this.deps.missions.patch(mission.id, { integrationBranch: branch });
    return branch;
  }

  /* ------------------------------------------------------------- reporting */

  /**
   * The single choke point.
   *
   * Everything a worker reports goes through here first: the task exists, the run belongs to this
   * worker, and it is still the task's active run. A worker whose task was reassigned gets a
   * conflict rather than the ability to write over whoever holds it now.
   */
  private async authoriseTask(
    workerId: string,
    taskId: string,
    runId: string,
  ): Promise<MissionTask> {
    const task = await this.deps.tasks.findById(taskId);
    if (!task) throw new NotFoundError('Task');
    const run = await this.deps.runs.findById(runId);
    if (!run) throw new NotFoundError('Run');
    if (run.workerId !== workerId) {
      throw new ForbiddenError('That run belongs to a different worker.');
    }
    if (task.activeRunId !== runId) {
      throw new ConflictError('That run is no longer this task’s active run.');
    }
    return task;
  }

  async reportTaskState(
    workerId: string,
    input: {
      runId: string;
      taskId: string;
      taskState?: string;
      currentAction?: string | null;
      agentSessionId?: string | null;
      workspacePath?: string | null;
      branchName?: string | null;
      baseSha?: string | null;
      headSha?: string | null;
      filesChanged?: readonly string[];
      pullRequestUrl?: string | null;
      pullRequestNumber?: number | null;
      usage?: {
        inputTokens?: number | null;
        outputTokens?: number | null;
        cacheReadTokens?: number | null;
        totalCostUsd?: number | null;
        turns?: number | null;
        durationMs?: number | null;
      } | null;
      completionSummary?: string | null;
      failureCode?: string | null;
      failureMessage?: string | null;
      workspacePreserved?: boolean | null;
      runtimeName?: string | null;
      runtimeVersion?: string | null;
    },
  ): Promise<{ task: MissionTask; stopRequested: boolean }> {
    const task = await this.authoriseTask(workerId, input.taskId, input.runId);
    const now = this.clock();

    await this.deps.runs.patch(input.runId, {
      currentAction: input.currentAction ?? null,
      ...(input.agentSessionId !== undefined ? { agentSessionId: input.agentSessionId } : {}),
      ...(input.runtimeName !== undefined ? { runtimeName: input.runtimeName } : {}),
      ...(input.runtimeVersion !== undefined ? { runtimeVersion: input.runtimeVersion } : {}),
      ...(input.workspacePath !== undefined ? { workspacePath: input.workspacePath } : {}),
      ...(input.branchName !== undefined ? { branchName: input.branchName } : {}),
      ...(input.headSha !== undefined ? { headSha: input.headSha } : {}),
      ...(input.filesChanged ? { filesChanged: [...input.filesChanged] } : {}),
      lastEventAt: now,
    });

    /*
     * The ledger, which this protocol never reached.
     *
     * The mission protocol recorded every run and this one recorded nothing, so the charter's
     * daily and weekly spend caps, the budget page and the capacity governor were all computed
     * over a table containing none of the factory's spending — and the more work Jarvis did
     * through tasks, the more confidently wrong those numbers became.
     *
     * Written on every report that carries usage rather than only on the last, because a task that
     * dies without a final report still spent what it spent. It is keyed on the run, so repeating
     * the report replaces one row rather than appending a second, and a retry or a repair round
     * gets a fresh run and therefore a genuinely distinct row.
     */
    if (input.usage) {
      await this.deps.usage.upsertForRun(
        usageRowForRun({
          kind: isReviewRole(task.role) ? 'review' : task.repairRound > 0 ? 'repair' : 'agent_task',
          runId: input.runId,
          missionId: task.missionId,
          taskId: task.id,
          projectId: (await this.deps.missions.findById(task.missionId))?.projectId ?? null,
          workerId,
          attempt: task.attempt,
          usage: input.usage,
          outcome: usageOutcomeFor({
            terminal: input.taskState === 'succeeded',
            failed: input.taskState === 'failed',
            stopped: input.taskState === 'stopped',
            paused: input.taskState === 'paused',
          }),
          failureCode: input.failureCode ?? null,
          occurredAt: now,
          capacity: await this.deps.workers.capacityObservationFor(workerId),
        }),
      );
    }

    const patch = {
      lastActivityAt: now,
      ...(input.branchName !== undefined ? { branchName: input.branchName } : {}),
      ...(input.baseSha !== undefined ? { baseSha: input.baseSha } : {}),
      ...(input.headSha !== undefined ? { headSha: input.headSha } : {}),
      ...(input.workspacePath !== undefined ? { workspacePath: input.workspacePath } : {}),
      ...(input.filesChanged ? { actualChangedFiles: [...input.filesChanged] } : {}),
      ...(input.completionSummary !== undefined ? { summary: input.completionSummary } : {}),
      ...(input.failureMessage !== undefined ? { failureMessage: input.failureMessage } : {}),
      ...(input.workspacePreserved !== undefined && input.workspacePreserved !== null
        ? { workspacePreserved: input.workspacePreserved }
        : {}),
      ...(input.usage
        ? {
            usage: {
              inputTokens: input.usage.inputTokens ?? null,
              outputTokens: input.usage.outputTokens ?? null,
              totalCostUsd: input.usage.totalCostUsd ?? null,
              turns: input.usage.turns ?? null,
              durationMs: input.usage.durationMs ?? null,
            },
          }
        : {}),
    };

    /* No state named: metadata only, exactly as the mission protocol behaves. */
    if (!input.taskState) {
      const updated = await this.deps.tasks.patch(task.id, patch);
      return { task: updated, stopRequested: false };
    }

    const next = input.taskState as TaskState;
    assertTaskTransition(task.state, next, 'worker');
    const finished = isTerminalTaskState(next);
    const moved = await this.deps.tasks.transition(
      task.id,
      next,
      {
        ...patch,
        ...(input.failureCode !== undefined
          ? { failureCode: input.failureCode as MissionTask['failureCode'] }
          : {}),
        ...(finished ? { finishedAt: now, activeRunId: null } : {}),
      },
      task.state,
    );
    if (!moved) {
      throw new ConflictError('That task changed while you were reporting on it.');
    }

    if (finished) {
      await this.deps.runs.patch(input.runId, {
        state: next === 'succeeded' ? 'succeeded' : next === 'stopped' ? 'stopped' : 'failed',
        finishedAt: now,
      });
      await this.deps.leases.release(task.id, `The task ${next}.`);
      if (input.pullRequestUrl) {
        await this.deps.missions.patch(task.missionId, {
          pullRequestUrl: input.pullRequestUrl,
          pullRequestNumber: input.pullRequestNumber ?? null,
        });
      }
      await this.deps.orchestrator.tick(task.missionId);
    }

    return { task: moved, stopRequested: false };
  }

  /* ---------------------------------------------------------------- leases */

  async acquireLease(
    workerId: string,
    input: { runId: string; taskId: string; paths: readonly string[] },
  ): Promise<{ granted: boolean; reason: string | null }> {
    const task = await this.authoriseTask(workerId, input.taskId, input.runId);

    /*
     * The paths a task may lease are the ones its *approved graph* declared, not the ones the
     * worker asks for. A worker cannot widen its own lease by sending a longer list.
     */
    const lease = await this.deps.leases.acquire({
      missionId: task.missionId,
      taskId: task.id,
      runId: input.runId,
      paths: task.declaredWriteSet,
    });
    if (!lease) {
      const held = await this.deps.leases.listHeld(task.missionId);
      return {
        granted: false,
        reason: `Another task already holds a write lease over ${held[0]?.paths.slice(0, 3).join(', ') ?? 'these files'}.`,
      };
    }
    return { granted: true, reason: null };
  }

  /* ---------------------------------------------------------------- review */

  async submitReview(workerId: string, input: ReviewSubmissionInput): Promise<{ ok: true }> {
    const task = await this.authoriseTask(workerId, input.taskId, input.runId);
    if (!isReviewRole(task.role)) {
      throw new ForbiddenError('Only a review task may submit a verdict.');
    }
    await this.deps.orchestrator.recordReview({ ...input, reviewerRole: task.role });
    return { ok: true };
  }

  /* ------------------------------------------------------------ diagnostics */

  /** A short, redacted description for the workers page. Never a credential, never a path. */
  describeAssignment(assignment: TaskAssignment): string {
    return boundText(
      redactSecrets(`${assignment.taskKey} · ${assignment.role} · ${assignment.title}`),
      200,
    );
  }
}
