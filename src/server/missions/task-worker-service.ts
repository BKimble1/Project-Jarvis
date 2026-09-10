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
import type { MissionFailureCode } from '@/domain/mission';
import { buildBranchName, slugifyForBranch } from '@/domain/workspace-safety';
import { deriveWorkerHealth } from '@/domain/worker';

/**
 * How long a *worker* may be silent before Jarvis takes back the tasks it is holding.
 *
 * Several multiples of `WORKER_DISCONNECT_SECONDS`, which is the point at which a worker stops
 * being *described* as connected — right for a status light, far too eager for taking work away.
 * A restart, a closed laptop lid or a home connection dropping for a minute crosses that line
 * routinely; the worker's poll loop beats every second or three, so ten minutes of nothing at all
 * is a process that has really gone rather than one that hiccuped.
 *
 * The word "worker" is the whole of the fix this constant carries. It used to be spent on the
 * *task's* last activity, which is a different quantity: a task speaks when its agent does
 * something, and a real Claude session thinks for many minutes at a time without emitting an
 * event. Every long session therefore satisfied the ten-minute half of the test permanently, and
 * the only thing still standing between a running agent and having its work re-queued under
 * another worker was the two-minute disconnect line — which a brief blip crosses.
 */
export const ABANDONED_AFTER_MS = 10 * 60_000;

/**
 * How many times one task may be taken back before Jarvis stops trying.
 *
 * One. A crash is bad luck and deserves another go; two crashes on the same task is a pattern —
 * the workspace, the repository or the task itself — and handing it out a third time spends real
 * money discovering that again. The owner sees a `worker_lost` failure and can decide.
 */
export const RECLAIM_GRACE = 1;

/**
 * What one reclaim pass took back.
 *
 * Counted rather than listed because the caller is a loop that writes one summary line. The
 * per-task detail is recorded where the person who cares about it will look — a warning on the
 * timeline of the mission whose task it was, and, through `EventRepository.recent`, on Operations.
 */
export interface ReclaimSummary {
  /** Tasks that went back to `ready` and can be claimed again. */
  readonly reclaimed: number;
  /** Tasks that had no attempts left and ended as `failed`. */
  readonly failed: number;
  /** Write leases handed back, which is what unblocks everything queued behind them. */
  readonly leasesReleased: number;
}
import type { UsageRepository } from '@/server/repositories/accounting-types';
import type { CommandRepository } from '@/server/repositories/mission-types';
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
  TaskPatch,
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
  /** Mission commands, so a running task can be told the owner asked it to stop. */
  readonly commands: CommandRepository;
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
     * Past this line the row is `claimed`: it holds a run, it counts against every ceiling, and it
     * is no longer visible to any queue. So every way out of here has to either hand the task to
     * the worker or put it back — including the ways out nobody wrote deliberately, which is what
     * the `try` is for.
     *
     * There was no `try`. `orchestrator.tick` and `buildAssignment` both run after the claim, and
     * `buildAssignment` throws `NotFoundError` outright for a mission that has gone; the route
     * turned that into a 404, and the worker's client refuses to retry anything under 500, so the
     * worker never came back for it. The task then sat in `claimed` for ever, doing no work and
     * holding a slot against `maxActiveRuns`, `maxRunsPerMission` and `maxParallelWriters` — and
     * `reclaimAbandoned` could not rescue it, because that acts on tasks whose *worker* looks
     * gone and this worker is alive and heartbeating.
     */
    try {
      const mission = await this.deps.missions.findById(claimed.task.missionId);
      if (mission?.autonomous) {
        /*
         * The exact gate, and the unwind that has to come with it.
         *
         * Reaching the refusal is a bug — the two filters above should have skipped the row — but
         * a gate that only holds while an adjacent SQL clause is correct is not a gate. If it
         * fires, the task has to go back to `ready` rather than sit in `claimed` with a run nobody
         * is executing, where it is invisible to every ceiling and blocks its own mission
         * indefinitely.
         *
         * It returns null rather than throwing: a 403 would kill the worker's poll loop over a
         * control-plane defect the worker had no part in.
         */
        const verdict = unattendedVerdict(
          taskUnattendedCapabilities(claimed.task.role, claimed.task.taskType),
          level,
        );
        if (!verdict.allowed) {
          await this.releaseClaim(claimed.task, claimed.runId, {
            returnTo: 'ready',
            failureCode: 'policy_violation',
            failureMessage: verdict.reason ?? 'Not qualified to run unattended.',
            eventType: 'policy_refusal',
          });
          return null;
        }

        /*
         * The write-scope gate, and why it ends the task rather than releasing it.
         *
         * `deriveWriteSet` falls back to the whole repository when a plan named no path-like
         * areas, and the deterministic planner's only `affectedAreas` entry is the sentence "To be
         * confirmed by inspection before any change is made." That is not a path, so every
         * deterministically planned write mission was granted the entire repository — which turned
         * the write-set control off end to end for precisely the missions nobody was watching.
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
          await this.releaseClaim(claimed.task, claimed.runId, {
            returnTo: 'failed',
            failureCode: 'policy_violation',
            failureMessage: scope.reason,
            eventType: 'policy_refusal',
            detail: { rule: scope.rule },
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

      /* Awaited rather than returned: a bare `return` hands the rejection past this `catch`. */
      return await this.buildAssignment(claimed.task, claimed.runId);
    } catch (error) {
      await this.unwindFailedHandOut(claimed.task, claimed.runId, error);
      throw error;
    }
  }

  /**
   * Put back a task Jarvis claimed and then could not hand out.
   *
   * ## Why the attempt has to come back with it
   *
   * `claimNext` increments `attempt` as part of the claim, and every built-in playbook allows a
   * single attempt. Releasing the row to `ready` and stopping there would leave it claimable in
   * name only: the claim filters on `attempt < max_attempts`, so nothing would ever look at the
   * row again and its mission would stall at exactly the point where it looked healthy. Raising
   * `maxAttempts` by one gives back the attempt this consumed, the same trade the reclaim path
   * makes — and for the same reason it does *not* simply decrement `attempt` instead:
   * `mission_runs_task_attempt_idx` is unique on `(task_id, attempt)`, so re-using the number
   * would make the next claim's run insert fail and turn a recoverable hand-out into a dead task.
   *
   * ## Why it can only happen once
   *
   * `reclaimCount`, bounded by `RECLAIM_GRACE`, exactly as a crashed worker's task is bounded. A
   * hand-out that fails for a permanent reason — a mission that has genuinely gone — would
   * otherwise be re-claimed and re-failed on every poll for ever, writing rows every few seconds
   * and telling nobody. The second failure ends the task instead, where an owner can see it.
   */
  private async unwindFailedHandOut(
    task: MissionTask,
    runId: string,
    cause: unknown,
  ): Promise<void> {
    const reason = boundText(
      redactSecrets(
        `Jarvis claimed ${task.key} and could not finish handing it out: ${
          cause instanceof Error ? cause.message : 'the reason was not recorded'
        }`,
      ),
      500,
    );
    const canRetry = task.reclaimCount < RECLAIM_GRACE;
    /*
     * Swallowed, and this is the one place in the claim path where that is right. If putting the
     * task back also fails, the failure that caused the unwind is the more useful of the two — it
     * is what the worker is answered with and what the route records — and replacing it with a
     * second database error would hide the first while fixing nothing, because a control plane
     * that cannot write these four rows cannot write better ones either.
     */
    await this.releaseClaim(task, runId, {
      returnTo: canRetry ? 'ready' : 'failed',
      failureCode: 'unknown',
      failureMessage: reason,
      eventType: 'warning',
      taskPatch: {
        reclaimCount: task.reclaimCount + 1,
        ...(canRetry ? { maxAttempts: task.maxAttempts + 1 } : { failureCode: 'unknown' as const }),
      },
    }).catch(() => undefined);
  }

  /**
   * Let go of a claim, whatever the reason for letting go.
   *
   * Two refusals and one failure land here, because the unwind is the part that is easy to get
   * subtly wrong three times over: the row has to leave `claimed`, the run has to be closed with a
   * reason, the write lease has to go back, and an owner has to be able to see that the task was
   * picked up and put down again — which otherwise looks exactly like nothing having happened.
   * `WorkerService.releaseClaim` is the same idea for a mission, and this is deliberately its
   * shape rather than a second one.
   *
   * The transition leads, because it is the compare-and-set: it is what proves the claim was still
   * this caller's to release. A `null` from it means something else moved the row first, and every
   * write below it describes *this* release — writing them over somebody else's would replace a
   * true record with a guess.
   *
   * The lease goes back immediately after, before anything that could fail. A task returning to
   * `ready` while still holding a lease over its own files blocks its own next attempt, because
   * the acquire path only hands a task its existing lease back after the overlap check has already
   * refused every other writer. It is a no-op when nothing is held, which is the ordinary case
   * here — a lease is taken by the worker, after the hand-out this is undoing.
   */
  private async releaseClaim(
    task: MissionTask,
    runId: string,
    input: {
      readonly returnTo: 'ready' | 'failed';
      readonly failureCode: MissionFailureCode;
      readonly failureMessage: string;
      readonly eventType: 'policy_refusal' | 'warning';
      /** Anything the caller needs on the task row beyond letting go of the claim. */
      readonly taskPatch?: TaskPatch;
      readonly detail?: Readonly<Record<string, unknown>>;
    },
  ): Promise<void> {
    const now = this.clock();
    const released = await this.deps.tasks.transition(
      task.id,
      input.returnTo,
      {
        assignedWorkerId: null,
        activeRunId: null,
        lastActivityAt: now,
        ...(input.returnTo === 'failed' ? { failureMessage: input.failureMessage } : {}),
        ...input.taskPatch,
      },
      'claimed',
    );
    if (!released) return;

    await this.deps.leases.release(task.id, input.failureMessage);
    await this.deps.runs.patch(runId, {
      state: 'failed',
      finishedAt: now,
      failureCode: input.failureCode,
      failureMessage: input.failureMessage,
    });
    await this.deps.events.record(task.missionId, {
      type: input.eventType,
      actor: 'system',
      level: 'warning',
      summary: input.failureMessage,
      detail: { taskKey: task.key, runId, ...input.detail },
    });
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
  /**
   * Give back the work a departed worker was holding.
   *
   * ## The hole this closes
   *
   * There was no reclaim path for a task at all. `reconcileLostWorkers` handles *missions*, and
   * handles only the one case where an owner had already decided the ending — a mission whose
   * worker went silent is deliberately left alone, because the work on disk is very likely fine
   * and the worker very likely comes back. That reasoning is right for a mission and leaves a
   * task stranded: a worker that crashed after claiming holds its task in `claimed` or `running`
   * for ever, holds a write lease over its files for ever, and therefore holds a concurrency slot
   * and blocks every future writer on that mission. One crash and that part of the factory is shut
   * until somebody notices.
   *
   * ## Why a longer threshold than "disconnected", and why it is measured on the heartbeat
   *
   * `WORKER_DISCONNECT_SECONDS` is the point at which Jarvis stops *describing* a worker as
   * connected, which is the right answer for a status light and much too eager for taking work
   * away from it. A restart, a laptop lid, a flaky home connection all cross that line routinely,
   * and a reclaim that fired on one of them would run the same task twice. `ABANDONED_AFTER_MS` is
   * deliberately several multiples of it.
   *
   * That margin only means anything if it is spent on the quantity that measures life. It was
   * spent on the task's `lastActivityAt` instead, and a task is quiet for as long as its agent is
   * thinking — measured in tens of minutes on real sessions, with nothing wrong. So a running
   * agent was one two-minute gap in heartbeats away from having its task taken back and handed to
   * a live worker, with every owner command from that moment on delivered to a run nobody was
   * executing. The worker's heartbeat is the only thing here that is independent of what an agent
   * is doing, so the window is measured against that and the task's silence decides nothing on its
   * own.
   *
   * ## What fences the old worker out
   *
   * The task's `activeRunId`. Reclaiming clears it and a re-claim sets a new one, and every
   * report a worker makes goes through `authoriseTask`, which refuses a run that is no longer the
   * task's active run. So a worker that wakes up after a reclaim and reports its results gets a
   * conflict rather than the ability to write over whoever holds the task now. The generation is
   * the run id: it is already unique per attempt, already carried in every request, and already
   * checked — it did not need inventing, it needed a reclaim path to make it mean something.
   */
  async reclaimAbandoned(): Promise<ReclaimSummary> {
    const now = this.clock();
    const workers = await this.deps.workers.list();
    const health = new Map(
      workers.map((worker) => [worker.id, deriveWorkerHealth(worker, now)] as const),
    );

    /*
     * Has the worker holding this task really gone?
     *
     * Three cases answer themselves without a window. A task with no worker is held by nobody. A
     * worker row that is not in the list has been deleted underneath its own task. `registered`
     * means "enrolled but never seen", and a process that has never once beaten cannot be the one
     * running the agent session in question — either it died before its first beat, or the row was
     * left behind by something worse. `revoked` may not report at all, so waiting for it to fall
     * silent would be waiting for something that already happened.
     *
     * Everything else is judged on how long it has actually been silent, not on the label derived
     * from that silence. `disconnected` is only the two-minute mark, and this is the sweep that
     * must not act on two minutes.
     */
    const workerGone = (workerId: string | null): boolean => {
      if (!workerId) return true;
      const state = health.get(workerId);
      if (!state) return true;
      if (state.effectiveStatus === 'registered' || state.effectiveStatus === 'revoked') {
        return true;
      }
      /*
       * A heartbeat timestamp that will not parse, which `deriveWorkerHealth` reports as an age of
       * null. Treated as gone for the same reason an unreadable task timestamp is below: a clock
       * that cannot be read is not evidence that something is alive, and the task-side test still
       * has to agree before anything is taken.
       */
      if (state.heartbeatAgeSeconds === null) return true;
      return state.heartbeatAgeSeconds * 1000 >= ABANDONED_AFTER_MS;
    };

    /*
     * The second half, which decides nothing on its own and exists for one narrow case.
     *
     * Task reports and heartbeats travel on different routes, from different loops in the worker,
     * so a worker can be reporting its task's progress while its polls are failing. A task that
     * said something thirty seconds ago is demonstrably being worked on, whatever the heartbeat
     * looks like, and must not be taken from it.
     */
    const taskQuiet = (task: MissionTask): boolean => {
      const last = task.lastActivityAt ? Date.parse(task.lastActivityAt) : null;
      if (last === null || Number.isNaN(last)) return true;
      return now.getTime() - last >= ABANDONED_AFTER_MS;
    };

    let reclaimed = 0;
    let failed = 0;
    let leasesReleased = 0;

    for (const task of await this.deps.tasks.listActive()) {
      if (!workerGone(task.assignedWorkerId) || !taskQuiet(task)) continue;

      /*
       * The lease first. A task returning to `ready` that still holds a lease over its own files
       * would block its own next attempt — the acquire path hands a task back its existing lease,
       * but only after the overlap check has already refused every *other* writer in the meantime.
       *
       * Looked up before releasing so the count is the truth. `release` is a no-op update when
       * nothing is held, and a read-only task never holds one, so counting the call rather than
       * the lease would report a number of rescued leases that was really a number of attempts.
       */
      if (await this.deps.leases.findForTask(task.id)) {
        await this.deps.leases.release(
          task.id,
          'The worker holding this task stopped reporting, so Jarvis took the work back.',
        );
        leasesReleased += 1;
      }

      if (task.activeRunId) {
        await this.deps.runs.patch(task.activeRunId, {
          state: 'failed',
          finishedAt: now,
          failureCode: 'worker_lost',
          failureMessage:
            'The worker holding this task stopped reporting. Its results can no longer be accepted.',
        });
      }

      /*
       * Back to `ready` while the grace remains, `failed` when it does not.
       *
       * The bound is `reclaimCount`, not `attempt`. Every built-in playbook allows a single
       * attempt, deliberately — agent work is expensive and non-deterministic, and silently
       * running it twice is not a favour. But a worker crash is not the task failing, and charging
       * it to that budget would mean one unstable machine could permanently kill any task it
       * touched. So the reclaim hands back the attempt the crash consumed, raising `maxAttempts`
       * by exactly one so `claimNext` will look at the row again, and records the reclaim in a
       * counter of its own. `attempt` therefore stays truthful about how many times the task was
       * handed out, and `RECLAIM_GRACE` stops this from repeating.
       *
       * A retry is a fresh run rather than a continuation, which is what makes this idempotent: if
       * the old worker was in fact still alive and finishes later, its report is refused and its
       * work is confined to its own workspace, while the new attempt starts from the branch as it
       * was last committed.
       */
      const canRetry = task.reclaimCount < RECLAIM_GRACE;
      const moved = await this.deps.tasks.transition(
        task.id,
        canRetry ? 'ready' : 'failed',
        {
          assignedWorkerId: null,
          activeRunId: null,
          lastActivityAt: now,
          reclaimCount: task.reclaimCount + 1,
          ...(canRetry
            ? { maxAttempts: task.maxAttempts + 1 }
            : {
                failureCode: 'worker_lost' as const,
                failureMessage:
                  'The worker holding this task stopped reporting, and it had already been taken back once.',
              }),
        },
        task.state,
      );
      /* `null` means somebody else moved it first, which is the compare-and-set doing its job. */
      if (!moved) continue;

      if (canRetry) reclaimed += 1;
      else failed += 1;

      await this.deps.events.record(task.missionId, {
        type: 'warning',
        actor: 'system',
        level: 'warning',
        summary: canRetry
          ? `${task.key} was taken back from a worker that stopped reporting, and can be claimed again.`
          : `${task.key} was taken back from a worker that stopped reporting for the second time, so Jarvis stopped it.`,
        detail: { taskKey: task.key, previousRunId: task.activeRunId },
      });
    }

    return { reclaimed, failed, leasesReleased };
  }

  /**
   * Has the owner asked the mission this task belongs to to stop?
   *
   * Read from the mission's pending commands rather than from a task-level flag, because Stop is
   * a decision about the *mission* — an owner stopping a mission means stopping the work inside
   * it, and a per-task stop switch would be a second thing to remember to press.
   */
  private async stopRequestedFor(missionId: string): Promise<boolean> {
    const pending = await this.deps.commands.pendingFor(missionId);
    return pending.some((command) => command.kind === 'stop');
  }

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

    /*
     * Whether the owner has asked this task's mission to stop.
     *
     * This used to be the literal `false`, on both return paths — which meant the control plane
     * had no way at all to tell a running task to stop. An owner's Stop reached the mission, the
     * mission's runner honoured it, and every task in the factory carried on regardless. The
     * mission protocol has always derived it from pending commands; this now does the same, so a
     * stop reaches the work rather than only the record of it.
     */
    const stopRequested = await this.stopRequestedFor(task.missionId);

    /* No state named: metadata only, exactly as the mission protocol behaves. */
    if (!input.taskState) {
      const updated = await this.deps.tasks.patch(task.id, patch);
      return { task: updated, stopRequested };
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

    return { task: moved, stopRequested };
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
