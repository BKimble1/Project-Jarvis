import { createHash } from 'node:crypto';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '@/domain/errors';
import {
  isWriteRole,
  profileForRole,
  resolvePermissionProfile,
  type AgentRole,
} from '@/domain/agent-role';
import {
  DEFAULT_CAPACITY_LIMITS,
  canStartTask,
  summariseMissionCapacity,
  taskExceedsLimits,
  type CapacityLimits,
  type CapacityPosture,
} from '@/domain/capacity';
import {
  buildDeliveryStages,
  deriveNextSteps,
  type CompletionReceiptContent,
  type ReceiptFinding,
  type ReceiptReviewOutcome,
  type ReceiptTaskOutcome,
  type ReceiptVerification,
} from '@/domain/completion-receipt';
import type { Mission } from '@/domain/mission';
import { assertTransition } from '@/domain/mission-state';
import {
  assertTaskTransition,
  isTerminalTaskState,
  type MissionTask,
  type TaskState,
} from '@/domain/mission-task';
import {
  decideVerdict,
  requiredSpecialistReviews,
  triageFindings,
  verdictAllowsDelivery,
  type MissionReview,
  type ReviewFinding,
  type ReviewSubmissionInput,
} from '@/domain/mission-review';
import { buildRepairTasks, decomposePlan } from '@/domain/task-decomposition';
import {
  computeReadiness,
  computeWaves,
  graphMaterialContent,
  validateTaskGraph,
  type MissionTaskGraph,
  type TaskGraphApprovalInput,
  type TaskGraphView,
} from '@/domain/task-graph';
import type { TaskProposal } from '@/domain/mission-task';
import { instantiatePlaybook, playbookSupportsProject, validatePlaybook } from '@/domain/playbook';
import type { MissionPlan } from '@/domain/mission-plan';
import type { ProjectRepository } from '../repositories/types';
import type {
  ArtifactRepository,
  EventRepository,
  MissionRepository,
  PlanRepository,
  RunRepository,
  VerificationRepository,
} from '../repositories/mission-types';
import type {
  PlaybookRepository,
  ReceiptRepository,
  ReviewRepository,
  TaskGraphRepository,
  TaskRepository,
  WriteLeaseRepository,
} from '../repositories/factory-types';
import type { SettingsRepository } from '../repositories/types';

/**
 * The deterministic orchestrator.
 *
 * Everything in Prompt 3 that decides *what happens next* lives here, and nothing here asks a
 * model. A model may research, build, review or recommend; this decides whether a graph may be
 * approved, which task runs next, whether a verdict stands, whether a repair round is available,
 * and whether a mission is delivery-ready. That separation is the whole architecture: the agents
 * are capable and untrusted, the orchestrator is trusted and dull.
 *
 * `tick` is the heartbeat. It is idempotent and safe to call from anywhere — a worker poll, an
 * owner action, a route — because it derives everything from stored state rather than remembering
 * anything between calls. That is what makes a crashed worker, a duplicated claim or a restart
 * converge instead of diverge.
 */

export interface OrchestratorDeps {
  readonly missions: MissionRepository;
  readonly plans: PlanRepository;
  readonly graphs: TaskGraphRepository;
  readonly tasks: TaskRepository;
  readonly leases: WriteLeaseRepository;
  readonly reviews: ReviewRepository;
  readonly receipts: ReceiptRepository;
  readonly playbooks: PlaybookRepository;
  readonly verifications: VerificationRepository;
  readonly artifacts: ArtifactRepository;
  readonly events: EventRepository;
  readonly runs: RunRepository;
  readonly projects: ProjectRepository;
  readonly settings: SettingsRepository;
  readonly limits?: CapacityLimits;
  readonly clock?: () => Date;
}

export const CAPACITY_POSTURE_SETTING = 'jarvis.capacity.posture';
export const CAPACITY_LIMITS_SETTING = 'jarvis.capacity.limits';

export interface GraphProposal {
  readonly graph: MissionTaskGraph;
  readonly tasks: readonly MissionTask[];
  readonly violations: readonly { rule: string; message: string; taskKeys: readonly string[] }[];
  readonly waves: readonly (readonly string[])[];
}

function fingerprint(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

export class MissionOrchestrator {
  private readonly clock: () => Date;

  constructor(private readonly deps: OrchestratorDeps) {
    this.clock = deps.clock ?? (() => new Date());
  }

  /* ------------------------------------------------------------- capacity */

  async posture(): Promise<CapacityPosture> {
    const stored = await this.deps.settings.get(CAPACITY_POSTURE_SETTING);
    const value = (stored as { posture?: string } | null)?.posture;
    return value === 'draining' || value === 'stopped' ? value : 'open';
  }

  async setPosture(posture: CapacityPosture, reason: string | null): Promise<void> {
    await this.deps.settings.set(CAPACITY_POSTURE_SETTING, {
      posture,
      reason,
      at: this.clock().toISOString(),
    });
  }

  async limits(): Promise<CapacityLimits> {
    const stored = (await this.deps.settings.get(
      CAPACITY_LIMITS_SETTING,
    )) as Partial<CapacityLimits> | null;
    const base = this.deps.limits ?? DEFAULT_CAPACITY_LIMITS;
    if (!stored) return base;
    /* Stored adjustments only ever reduce; see `applyAdjustment`. */
    return {
      ...base,
      maxActiveRuns: Math.min(base.maxActiveRuns, stored.maxActiveRuns ?? base.maxActiveRuns),
      maxRunsPerMission: Math.min(
        base.maxRunsPerMission,
        stored.maxRunsPerMission ?? base.maxRunsPerMission,
      ),
      maxParallelReadOnly: Math.min(
        base.maxParallelReadOnly,
        stored.maxParallelReadOnly ?? base.maxParallelReadOnly,
      ),
    };
  }

  /* --------------------------------------------------------- the proposal */

  /**
   * Propose a task graph for an approved plan.
   *
   * Refuses unless the plan is approved and current: a graph decomposes a specific plan version,
   * and decomposing an unapproved one would be inviting the owner to approve the shape of
   * something they have not agreed to do.
   */
  async proposeGraph(
    missionId: string,
    options: {
      playbookKey?: string | null;
      playbookVersion?: number | null;
      inputs?: Record<string, string>;
    } = {},
  ): Promise<GraphProposal> {
    const mission = await this.requireMission(missionId);
    if (mission.approvedPlanVersion === null) {
      throw new ConflictError('Approve the plan before Jarvis proposes how to do it.');
    }
    if (mission.approvedPlanVersion !== mission.currentPlanVersion) {
      throw new ConflictError(
        'The plan has changed since it was approved. Approve it again first.',
      );
    }
    const plan = await this.deps.plans.byVersion(missionId, mission.approvedPlanVersion);
    if (!plan) throw new NotFoundError('Plan');

    const limits = await this.limits();
    const project = mission.projectId ? await this.deps.projects.findById(mission.projectId) : null;

    const specialists = requiredSpecialistReviews({
      changedFiles: plan.content.affectedAreas,
      projectType: project?.type ?? null,
      missionType: mission.type,
      riskLevel: mission.riskLevel,
      canDispatchExternalBuild: false,
    }).map((requirement) => requirement.role);

    let proposals: readonly TaskProposal[];
    let summary: string;
    let notes: readonly string[];
    let playbookKey: string | null = null;
    let playbookVersion: number | null = null;

    if (options.playbookKey) {
      const version = options.playbookVersion
        ? await this.deps.playbooks.version(options.playbookKey, options.playbookVersion)
        : await this.deps.playbooks.latestVersion(options.playbookKey);
      if (!version) throw new NotFoundError('Playbook version');
      const playbook = await this.deps.playbooks.findByKey(options.playbookKey);
      if (!playbook?.enabled) throw new ForbiddenError('That playbook is switched off.');
      const check = validatePlaybook(version.definition);
      if (!check.ok) {
        throw new ValidationError('That playbook is no longer valid.', {
          violations: check.violations.slice(0, 5),
        });
      }
      if (!playbookSupportsProject(version.definition, project?.type ?? null)) {
        throw new ConflictError('That playbook does not apply to this kind of project.');
      }
      proposals = instantiatePlaybook(version.definition, {
        hasRepository: Boolean(mission.repositoryOwner && mission.repositoryName),
        allowWebResearch: false,
        missionWrites: !plan.content.reviewOnlyDelivery ? true : true,
        projectType: project?.type ?? null,
        inputs: options.inputs ?? {},
      });
      summary = `${version.definition.name} v${version.version}`;
      notes = version.definition.ownerApprovalPoints;
      playbookKey = version.playbookKey;
      playbookVersion = version.version;
    } else {
      const decomposed = decomposePlan({
        plan: plan.content,
        missionType: mission.type,
        missionTitle: mission.title,
        hasRepository: Boolean(mission.repositoryOwner && mission.repositoryName),
        allowWebResearch: false,
        requiredSpecialists: specialists,
        maxRepairRounds: limits.maxRepairRounds,
      });
      proposals = decomposed.tasks;
      summary = decomposed.summary;
      notes = decomposed.notes;
    }

    return this.storeProposal(mission, plan, proposals, {
      summary,
      notes,
      playbookKey,
      playbookVersion,
      limits,
      requiredSpecialists: specialists,
      proposedBy: options.playbookKey ? 'playbook' : 'system',
    });
  }

  /** Validate a proposal, store it as the next version, and revoke any earlier approval. */
  private async storeProposal(
    mission: Mission,
    plan: MissionPlan,
    proposals: readonly TaskProposal[],
    context: {
      summary: string;
      notes: readonly string[];
      playbookKey: string | null;
      playbookVersion: number | null;
      limits: CapacityLimits;
      requiredSpecialists: readonly AgentRole[];
      proposedBy: MissionTaskGraph['proposedBy'];
    },
  ): Promise<GraphProposal> {
    const missionWrites = proposals.some((task) => isWriteRole(task.role));
    const validation = validateTaskGraph(proposals, {
      limits: {
        maxParallelTasks: context.limits.maxParallelReadOnly,
        maxWriteTasks: context.limits.maxParallelWriters,
        maxRepairRounds: context.limits.maxRepairRounds,
      },
      missionWrites,
      requiredReviewRoles: context.requiredSpecialists,
    });
    if (!validation.ok) {
      throw new ValidationError('Jarvis will not propose a task graph it would refuse to run.', {
        violations: validation.violations.slice(0, 8),
      });
    }

    const material = graphMaterialContent(proposals);
    const print = fingerprint(material);

    const existing = await this.deps.graphs.latest(mission.id);
    if (existing && existing.fingerprint === print && existing.state !== 'revoked') {
      const tasks = await this.deps.tasks.listByGraph(existing.id);
      return { graph: existing, tasks, violations: [], waves: validation.waves };
    }

    const version = await this.deps.graphs.nextVersion(mission.id);
    const graph = await this.deps.graphs.create({
      missionId: mission.id,
      version,
      planVersion: plan.version,
      summary: context.summary,
      notes: [...context.notes],
      fingerprint: print,
      playbookKey: context.playbookKey,
      playbookVersion: context.playbookVersion,
      maxParallelTasks: context.limits.maxParallelReadOnly,
      maxWriteTasks: context.limits.maxParallelWriters,
      maxRepairRounds: context.limits.maxRepairRounds,
      proposedBy: context.proposedBy,
    });

    const created = await this.deps.tasks.createMany(
      proposals.map((task, index) => ({
        missionId: mission.id,
        graphId: graph.id,
        graphVersion: version,
        planVersion: plan.version,
        key: task.key,
        title: task.title,
        description: task.description,
        role: task.role,
        permissionProfileId: task.permissionProfileId ?? profileForRole(task.role).id,
        taskType: task.taskType,
        position: index,
        expectedInputs: task.expectedInputs,
        expectedOutputs: task.expectedOutputs,
        acceptanceCriteria: task.acceptanceCriteria,
        workspaceRequirement: task.workspaceRequirement,
        requiresRepository: task.requiresRepository,
        expectedFileAreas: task.expectedFileAreas,
        declaredWriteSet: task.declaredWriteSet,
        maxAttempts: task.maxAttempts,
        maxTurns: resolvePermissionProfile(task.permissionProfileId ?? profileForRole(task.role).id)
          .usage.maxTurns,
        timeLimitMs: Math.min(
          resolvePermissionProfile(task.permissionProfileId ?? profileForRole(task.role).id).usage
            .timeLimitMs,
          context.limits.maxTaskRuntimeMs,
        ),
        maxOutputTokens: context.limits.maxTaskOutputTokens,
        repairRound: task.repairRound,
        reviewsTaskKey: task.reviewsTaskKey ?? null,
      })),
    );

    const idByKey = new Map(created.map((task) => [task.key, task.id]));
    await this.deps.tasks.setDependencies(
      graph.id,
      proposals.flatMap((task) =>
        task.dependsOn
          .map((dependency) => ({
            taskId: idByKey.get(task.key) ?? '',
            dependsOnTaskId: idByKey.get(dependency) ?? '',
          }))
          .filter((edge) => edge.taskId && edge.dependsOnTaskId),
      ),
    );

    /* A review task points at the work it reviews, so the receipt can pair them up later. */
    for (const task of proposals) {
      if (!task.reviewsTaskKey) continue;
      const reviewId = idByKey.get(task.key);
      const reviewedId = idByKey.get(task.reviewsTaskKey);
      if (reviewId && reviewedId)
        await this.deps.tasks.patch(reviewId, { reviewsTaskId: reviewedId });
    }

    await this.deps.missions.patch(mission.id, { currentGraphVersion: version });
    /* A new proposal invalidates any approval of an earlier graph. */
    if (mission.approvedGraphVersion !== null) {
      await this.deps.missions.patch(mission.id, { approvedGraphVersion: null });
      await this.deps.graphs.revokeOthers(mission.id, graph.id, 'Superseded by a new proposal.');
    }

    await this.deps.events.record(mission.id, {
      type: 'info',
      actor: 'system',
      summary: `Task graph version ${version} proposed: ${context.summary}`,
      detail: { version, tasks: created.length },
    });

    return {
      graph,
      tasks: await this.deps.tasks.listByGraph(graph.id),
      violations: [],
      waves: validation.waves,
    };
  }

  /* ---------------------------------------------------------- the approval */

  /**
   * Approve a graph version.
   *
   * The fingerprint the owner saw is echoed back and compared, so a graph that changed between
   * being rendered and being approved cannot inherit the approval — the same discipline plan
   * approval already has, for the same reason.
   */
  async approveGraph(
    missionId: string,
    input: TaskGraphApprovalInput,
    approvedBy: string,
  ): Promise<TaskGraphView> {
    const mission = await this.requireMission(missionId);
    const graph = await this.deps.graphs.byVersion(missionId, input.graphVersion);
    if (!graph) throw new NotFoundError('Task graph');
    if (graph.state === 'revoked') {
      throw new ConflictError('That task graph was superseded. Review the current one.');
    }
    if (graph.fingerprint !== input.fingerprint) {
      throw new ConflictError(
        'This task graph changed since it was shown to you. Read it again before approving.',
      );
    }
    if (mission.approvedPlanVersion !== graph.planVersion) {
      throw new ConflictError('This graph is for a plan version that is no longer approved.');
    }

    await this.deps.graphs.setState(graph.id, 'approved', {
      approvedAt: this.clock(),
      approvedBy,
      ...(input.maxParallelTasks !== undefined
        ? { maxParallelTasks: Math.min(graph.maxParallelTasks, input.maxParallelTasks) }
        : {}),
    });
    await this.deps.graphs.revokeOthers(missionId, graph.id, 'A different version was approved.');
    await this.deps.missions.patch(missionId, {
      approvedGraphVersion: graph.version,
      currentGraphVersion: graph.version,
    });

    /* Move every task out of `draft` and into the shape the scheduler understands. */
    const tasks = await this.deps.tasks.listByGraph(graph.id);
    const { ready } = computeReadiness(
      tasks.map((task) => ({ ...task, state: 'blocked' as TaskState })),
    );
    const readyKeys = new Set(ready.map((task) => task.key));
    for (const task of tasks) {
      const next: TaskState = readyKeys.has(task.key) ? 'ready' : 'blocked';
      assertTaskTransition(task.state, next, 'system');
      await this.deps.tasks.transition(task.id, next, {}, task.state);
    }

    await this.deps.events.record(missionId, {
      type: 'info',
      actor: 'owner',
      summary: `You approved task graph version ${graph.version}.`,
      detail: { version: graph.version, tasks: tasks.length },
    });

    return this.view(missionId);
  }

  /* ------------------------------------------------------------- the view */

  async view(missionId: string): Promise<TaskGraphView> {
    const graph = await this.deps.graphs.latest(missionId);
    if (!graph) {
      throw new NotFoundError('Task graph');
    }
    const tasks = await this.deps.tasks.listByGraph(graph.id);
    return {
      graph,
      tasks,
      waves: computeWaves(
        tasks.map((task) => ({
          key: task.key,
          dependsOn: task.dependsOn,
        })) as never,
      ),
      readiness: computeReadiness(tasks),
    };
  }

  async tryView(missionId: string): Promise<TaskGraphView | null> {
    const graph = await this.deps.graphs.latest(missionId);
    if (!graph) return null;
    return this.view(missionId);
  }

  /* --------------------------------------------------------------- the tick */

  /**
   * Advance a mission as far as stored state allows, then stop.
   *
   * Idempotent by construction: it reads the tasks, works out what is true, and writes only the
   * transitions that follow from that. Calling it twice in a row does nothing the second time,
   * which is what makes it safe to call from a worker poll and an owner action at once.
   */
  async tick(missionId: string): Promise<void> {
    const mission = await this.deps.missions.findById(missionId);
    if (!mission || mission.approvedGraphVersion === null) return;
    const graph = await this.deps.graphs.byVersion(missionId, mission.approvedGraphVersion);
    if (!graph || graph.state !== 'approved') return;

    const tasks = await this.deps.tasks.listByGraph(graph.id);
    const now = this.clock();
    const nowIso = now.toISOString();
    const limits = await this.limits();

    /* 1. A task past its own ceiling is stopped rather than left to keep spending. */
    for (const task of tasks) {
      if (isTerminalTaskState(task.state)) continue;
      const verdict = taskExceedsLimits(task, nowIso);
      if (!verdict.allowed) {
        await this.failTask(
          task,
          'limit_reached',
          verdict.reason ?? 'A configured limit was reached.',
        );
      }
    }

    /* 2. Anything whose dependency can never finish is failed rather than left blocked forever. */
    const refreshed = await this.deps.tasks.listByGraph(graph.id);
    const readiness = computeReadiness(refreshed);
    for (const task of readiness.unreachable) {
      await this.failTask(
        task,
        'dependency_failed',
        'Something this task depends on did not finish, so it can never start.',
      );
    }

    /* 3. Promote whatever is genuinely ready. */
    for (const task of readiness.ready) {
      if (task.state !== 'blocked') continue;
      assertTaskTransition('blocked', 'ready', 'system');
      await this.deps.tasks.transition(task.id, 'ready', { lastActivityAt: now }, 'blocked');
    }

    /* 4. Reflect the mission's own state. */
    const current = await this.deps.tasks.listByGraph(graph.id);
    await this.reflectMissionState(mission, current, limits);
  }

  private async reflectMissionState(
    mission: Mission,
    tasks: readonly MissionTask[],
    limits: CapacityLimits,
  ): Promise<void> {
    const anyRunning = tasks.some(
      (task) =>
        !isTerminalTaskState(task.state) && task.state !== 'blocked' && task.state !== 'ready',
    );
    const delivery = tasks.find((task) => task.taskType === 'delivery');
    const allDone = tasks.every((task) => isTerminalTaskState(task.state));
    const anyFailed = tasks.some((task) => task.state === 'failed');

    if (mission.state === 'queued' && anyRunning) {
      await this.moveMission(mission, 'running', 'system');
      return;
    }
    if (delivery?.state === 'succeeded' && mission.state !== 'pull_request_ready') {
      await this.moveMission(mission, 'pull_request_ready', 'system');
      await this.buildReceipt(mission.id);
      return;
    }
    if (allDone && !anyFailed && mission.state === 'running' && !delivery) {
      await this.moveMission(mission, 'completed', 'worker');
      await this.buildReceipt(mission.id);
      return;
    }
    if (allDone && anyFailed && mission.state === 'running') {
      await this.moveMission(mission, 'failed', 'system');
      await this.buildReceipt(mission.id);
    }
    void limits;
  }

  private async moveMission(
    mission: Mission,
    to: Mission['state'],
    actor: 'owner' | 'worker' | 'system',
  ): Promise<void> {
    if (mission.state === to) return;
    const transition = assertTransition(mission.state, to, actor);
    const updated = await this.deps.missions.transition(
      mission.id,
      to,
      { lastActivityAt: this.clock() },
      mission.state,
    );
    if (!updated) return;
    await this.deps.events.record(mission.id, {
      type: 'state_changed',
      actor,
      summary: `${mission.state} → ${to}${transition ? `: ${transition.summary}` : ''}`,
    });
  }

  private async failTask(
    task: MissionTask,
    code: Parameters<TaskRepository['patch']>[1]['failureCode'],
    message: string,
  ): Promise<void> {
    if (isTerminalTaskState(task.state)) return;
    try {
      assertTaskTransition(task.state, 'failed', 'system');
    } catch {
      return;
    }
    await this.deps.tasks.transition(
      task.id,
      'failed',
      {
        failureCode: code,
        failureMessage: message,
        finishedAt: this.clock(),
        workspacePreserved: true,
      },
      task.state,
    );
    await this.deps.leases.release(task.id, message);
    await this.deps.events.record(task.missionId, {
      type: 'error',
      level: 'error',
      actor: 'system',
      summary: `${task.key} failed: ${message}`,
      detail: { taskKey: task.key, code },
    });
  }

  /* --------------------------------------------------------- the review gate */

  /**
   * Record a review, reconcile its verdict with what is actually true, and decide what happens.
   *
   * The reviewer proposes; `decideVerdict` disposes. An approval while a required check failed
   * becomes `repair_required` and is recorded as an override, with the rule that caused it — so
   * the audit trail shows both what the model said and what Jarvis did about it.
   */
  async recordReview(
    input: ReviewSubmissionInput & { readonly reviewerRole: AgentRole },
  ): Promise<{ review: MissionReview; findings: readonly ReviewFinding[]; nextStep: string }> {
    const task = await this.deps.tasks.findById(input.taskId);
    if (!task) throw new NotFoundError('Task');
    const mission = await this.requireMission(task.missionId);

    const verifications = await this.deps.verifications.list(task.missionId);
    const requiredChecks = verifications
      .filter((record) => record.source !== 'optional')
      .map((record) => ({ outcome: record.outcome }));

    const decision = decideVerdict({
      proposedVerdict: input.verdict,
      findings: input.findings.map((finding) => ({
        severity: finding.severity,
        blocksDelivery: finding.blocksDelivery,
      })),
      requiredChecks,
    });

    const { review, findings } = await this.deps.reviews.create({
      missionId: task.missionId,
      taskId: task.id,
      runId: input.runId,
      graphVersion: task.graphVersion,
      planVersion: task.planVersion,
      reviewerRole: input.reviewerRole,
      verdict: decision.verdict,
      proposedVerdict: input.verdict,
      overrideRule: decision.rule,
      overrideReason: decision.reason,
      summary: input.summary,
      diffFingerprint: input.diffFingerprint,
      reviewedFiles: input.reviewedFiles,
      verificationSnapshot: verifications.map((record) => ({
        check: record.command,
        outcome: record.outcome,
        required: record.source !== 'optional',
      })),
      repairRound: task.repairRound,
      unavailableReason: input.unavailableReason ?? null,
      findings: input.findings,
    });

    await this.deps.tasks.patch(task.id, { latestReviewId: review.id });

    /* Triage: deterministic policy decides which findings become repair scope. */
    const triage = triageFindings(
      findings.map((finding) => ({
        key: finding.key,
        severity: finding.severity,
        blocksDelivery: finding.blocksDelivery,
        category: finding.category,
      })),
    );
    const byKey = new Map(findings.map((finding) => [finding.key, finding]));
    for (const decisionRow of triage) {
      const finding = byKey.get(decisionRow.key);
      if (!finding) continue;
      await this.deps.reviews.setFindingState(finding.id, decisionRow.state, {
        triageRule: decisionRow.rule,
      });
    }

    await this.deps.events.record(task.missionId, {
      type: 'info',
      level: decision.verdict === 'approved' ? 'info' : 'warning',
      actor: 'agent',
      summary: decision.overridden
        ? `${input.reviewerRole} proposed "${input.verdict}"; Jarvis recorded "${decision.verdict}" (${decision.rule}).`
        : `${input.reviewerRole} returned "${decision.verdict}" with ${findings.length} finding(s).`,
      detail: { verdict: decision.verdict, findings: findings.length, rule: decision.rule },
    });

    const nextStep = await this.applyVerdict(mission, task, decision.verdict, findings);
    return { review, findings, nextStep };
  }

  /**
   * What a verdict means for the task graph.
   *
   * The bound is enforced here and nowhere else: when a repair round is available it is
   * materialised, and when it is not the task fails with `repair_limit_reached` rather than
   * looping. There is no branch in this method that continues past the limit.
   */
  private async applyVerdict(
    mission: Mission,
    reviewTask: MissionTask,
    verdict: MissionReview['verdict'],
    findings: readonly ReviewFinding[],
  ): Promise<string> {
    const reviewedId = reviewTask.reviewsTaskId;
    const reviewed = reviewedId ? await this.deps.tasks.findById(reviewedId) : null;

    if (verdictAllowsDelivery(verdict)) {
      await this.completeTask(reviewTask, 'Review approved.');
      if (reviewed && reviewed.state === 'awaiting_review') {
        await this.completeTask(reviewed, 'Independently reviewed and approved.');
      }
      await this.tick(mission.id);
      return 'approved';
    }

    if (verdict === 'unavailable') {
      await this.failTask(
        reviewTask,
        'agent_unavailable',
        'The review could not be performed, so nothing may be concluded from it.',
      );
      return 'review_unavailable';
    }

    if (verdict === 'owner_decision_required') {
      await this.deps.tasks.transition(
        reviewTask.id,
        'waiting_for_input',
        { lastActivityAt: this.clock() },
        reviewTask.state,
      );
      await this.deps.events.record(mission.id, {
        type: 'info',
        level: 'warning',
        actor: 'system',
        summary: 'This review needs a decision only you can make.',
      });
      return 'owner_decision';
    }

    /* repair_required or blocked. */
    const limits = await this.limits();
    const graph = await this.deps.graphs.byVersion(mission.id, reviewTask.graphVersion);
    const roundsAllowed = Math.min(graph?.maxRepairRounds ?? 0, limits.maxRepairRounds);
    const nextRound = reviewTask.repairRound + 1;

    if (verdict === 'blocked' || nextRound > roundsAllowed) {
      await this.completeTask(reviewTask, 'Review recorded.');
      if (reviewed) {
        await this.failTask(
          reviewed,
          nextRound > roundsAllowed ? 'repair_limit_reached' : 'review_blocked',
          nextRound > roundsAllowed
            ? `Review still blocks delivery after ${roundsAllowed} repair round(s). Jarvis stops here rather than trying again.`
            : 'Review blocked delivery.',
        );
      }
      await this.deps.events.record(mission.id, {
        type: 'info',
        level: 'error',
        actor: 'system',
        summary:
          nextRound > roundsAllowed
            ? `Every repair round was used and the work still does not pass review. Jarvis has stopped and preserved everything.`
            : 'Review blocked delivery. Jarvis has stopped.',
      });
      await this.tick(mission.id);
      return 'blocked';
    }

    const accepted = findings.filter(
      (finding) => finding.severity === 'critical' || finding.blocksDelivery,
    );
    if (accepted.length === 0) {
      await this.completeTask(reviewTask, 'Review recorded; nothing blocking to repair.');
      if (reviewed) await this.completeTask(reviewed, 'Reviewed.');
      await this.tick(mission.id);
      return 'approved';
    }

    await this.materialiseRepair(mission, reviewTask, reviewed, accepted, nextRound);
    return 'repair_scheduled';
  }

  /**
   * Add a repair task and a fresh review to the approved graph.
   *
   * Not a new graph version, and deliberately so: the owner approved a graph that says "up to N
   * bounded repair rounds", and materialising one of those rounds is doing what was approved, not
   * changing it. A round *beyond* N is a different matter and cannot get here.
   */
  private async materialiseRepair(
    mission: Mission,
    reviewTask: MissionTask,
    reviewed: MissionTask | null,
    findings: readonly ReviewFinding[],
    round: number,
  ): Promise<void> {
    const graph = await this.deps.graphs.byVersion(mission.id, reviewTask.graphVersion);
    if (!graph) return;
    const existing = await this.deps.tasks.listByGraph(graph.id);
    const builder = reviewed ?? existing.find((task) => isWriteRole(task.role));
    if (!builder) return;
    const delivery = existing.find((task) => task.taskType === 'delivery');
    const verification = existing.find((task) => task.taskType === 'verification');

    const proposals = buildRepairTasks({
      round,
      builderKey: builder.key,
      reviewKey: reviewTask.key,
      deliveryKey: delivery?.key ?? '',
      builderWriteSet: builder.declaredWriteSet,
      verificationKey: verification?.key ?? '',
      findings: findings.map((finding) => ({
        key: finding.key,
        title: finding.title,
        recommendation: finding.recommendation,
        file: finding.file,
        severity: finding.severity,
      })),
    });

    const created = await this.deps.tasks.createMany(
      proposals.map((task, index) => ({
        missionId: mission.id,
        graphId: graph.id,
        graphVersion: graph.version,
        planVersion: graph.planVersion,
        key: task.key,
        title: task.title,
        description: task.description,
        role: task.role,
        permissionProfileId: task.permissionProfileId ?? profileForRole(task.role).id,
        taskType: task.taskType,
        position: existing.length + index,
        expectedInputs: task.expectedInputs,
        expectedOutputs: task.expectedOutputs,
        acceptanceCriteria: task.acceptanceCriteria,
        workspaceRequirement: task.workspaceRequirement,
        requiresRepository: task.requiresRepository,
        expectedFileAreas: task.expectedFileAreas,
        declaredWriteSet: task.declaredWriteSet,
        maxAttempts: task.maxAttempts,
        maxTurns: profileForRole(task.role).usage.maxTurns,
        timeLimitMs: profileForRole(task.role).usage.timeLimitMs,
        maxOutputTokens: null,
        repairRound: round,
        reviewsTaskKey: task.reviewsTaskKey ?? null,
      })),
    );

    const all = await this.deps.tasks.listByGraph(graph.id);
    const idByKey = new Map(all.map((task) => [task.key, task.id]));
    const edges: { taskId: string; dependsOnTaskId: string }[] = [];
    for (const task of all) {
      for (const dependency of task.dependsOn) {
        const from = idByKey.get(task.key);
        const to = idByKey.get(dependency);
        if (from && to) edges.push({ taskId: from, dependsOnTaskId: to });
      }
    }
    for (const proposal of proposals) {
      const from = idByKey.get(proposal.key);
      if (!from) continue;
      for (const dependency of proposal.dependsOn) {
        const to = idByKey.get(dependency);
        if (to) edges.push({ taskId: from, dependsOnTaskId: to });
      }
    }
    /* Delivery now waits for the fresh review rather than the one that just failed. */
    const freshReview = created.find((task) => task.taskType === 'review');
    if (delivery && freshReview) {
      edges.push({ taskId: delivery.id, dependsOnTaskId: freshReview.id });
    }
    await this.deps.tasks.setDependencies(
      graph.id,
      edges.filter(
        (edge, index, list) =>
          list.findIndex(
            (other) =>
              other.taskId === edge.taskId && other.dependsOnTaskId === edge.dependsOnTaskId,
          ) === index,
      ),
    );

    for (const task of created) {
      await this.deps.tasks.transition(task.id, 'blocked', {}, task.state);
    }
    await this.completeTask(reviewTask, `Review recorded; repair round ${round} scheduled.`);
    if (reviewed) {
      await this.deps.tasks.transition(
        reviewed.id,
        'repair_required',
        { lastActivityAt: this.clock() },
        reviewed.state,
      );
    }
    for (const finding of findings) {
      await this.deps.reviews.setFindingState(finding.id, 'accepted', {
        resolvedByTaskId: created[0]?.id ?? null,
      });
    }
    await this.deps.missions.patch(mission.id, { repairRoundsUsed: round });
    await this.deps.events.record(mission.id, {
      type: 'info',
      level: 'warning',
      actor: 'system',
      summary: `Repair round ${round} of ${graph.maxRepairRounds}: ${findings.length} accepted finding(s), then a fresh review.`,
      detail: { round, findings: findings.map((finding) => finding.key) },
    });
    await this.tick(mission.id);
  }

  private async completeTask(task: MissionTask, summary: string): Promise<void> {
    if (isTerminalTaskState(task.state)) return;
    try {
      assertTaskTransition(task.state, 'succeeded', 'system');
    } catch {
      return;
    }
    await this.deps.tasks.transition(
      task.id,
      'succeeded',
      { summary, finishedAt: this.clock() },
      task.state,
    );
    await this.deps.leases.release(task.id, 'The task finished.');
  }

  /* ------------------------------------------------------------ the receipt */

  /**
   * Write the completion receipt.
   *
   * Every rung of the delivery ladder is computed from stored evidence, never asserted. A stage
   * with no evidence is `reached: false`, and the three stages Jarvis structurally cannot perform
   * carry the reason they cannot rather than being quietly omitted.
   */
  async buildReceipt(missionId: string): Promise<CompletionReceiptContent> {
    const mission = await this.requireMission(missionId);
    const graph = mission.approvedGraphVersion
      ? await this.deps.graphs.byVersion(missionId, mission.approvedGraphVersion)
      : await this.deps.graphs.latest(missionId);
    const tasks = graph ? await this.deps.tasks.listByGraph(graph.id) : [];
    const reviews = await this.deps.reviews.listByMission(missionId);
    const findings = await this.deps.reviews.listFindings(missionId);
    const verifications = await this.deps.verifications.list(missionId);
    const artifacts = await this.deps.artifacts.list(missionId);
    const project = mission.projectId ? await this.deps.projects.findById(mission.projectId) : null;

    const verification: ReceiptVerification[] = verifications.map((record) => ({
      check: record.command,
      outcome: record.outcome,
      required: record.source !== 'optional',
      blocksDelivery: record.source !== 'optional',
      exitCode: record.exitCode,
      detail: record.reason,
    }));

    const reviewOutcomes: ReceiptReviewOutcome[] = reviews.map((review) => {
      const own = findings.filter((finding) => finding.reviewId === review.id);
      return {
        reviewerRole: review.reviewerRole,
        verdict: review.verdict,
        repairRound: review.repairRound,
        summary: review.summary,
        blockingFindings: own.filter((finding) => finding.blocksDelivery).length,
        totalFindings: own.length,
        diffFingerprint: review.diffFingerprint,
      };
    });

    const taskOutcomes: ReceiptTaskOutcome[] = tasks.map((task) => ({
      key: task.key,
      title: task.title,
      role: task.role,
      state: task.state,
      branchName: task.branchName,
      changedFiles: task.actualChangedFiles.length,
      attempt: task.attempt,
      outputTokens: task.usage.outputTokens,
      durationMs: task.usage.durationMs,
      failureMessage: task.failureMessage,
    }));

    const toReceiptFinding = (finding: ReviewFinding): ReceiptFinding => ({
      key: finding.key,
      severity: finding.severity,
      title: finding.title,
      state: finding.state,
      file: finding.file,
      repairRound: finding.repairRound,
    });

    const changedFiles = [...new Set(tasks.flatMap((task) => task.actualChangedFiles))].sort();
    const integrationTask = tasks.find((task) => task.taskType === 'integration');
    const deliveryTask = tasks.find((task) => task.taskType === 'delivery');

    const stages = buildDeliveryStages({
      hasChangedFiles: changedFiles.length > 0,
      verification,
      reviews: reviewOutcomes,
      pullRequestUrl: mission.pullRequestUrl,
      testFlightUploaded: false,
      testFlightEvidence: null,
    });

    const roleCounts = new Map<AgentRole, number>();
    for (const task of tasks) {
      if (task.attempt === 0) continue;
      roleCounts.set(task.role, (roleCounts.get(task.role) ?? 0) + 1);
    }

    const content: CompletionReceiptContent = {
      missionId: mission.id,
      missionTitle: mission.title,
      rawRequest: mission.rawRequest,
      projectName: project?.name ?? null,
      planVersion: mission.approvedPlanVersion ?? mission.currentPlanVersion ?? 0,
      graphVersion: graph?.version ?? 0,
      playbook:
        graph?.playbookKey && graph.playbookVersion
          ? { key: graph.playbookKey, version: graph.playbookVersion }
          : null,
      agents: [...roleCounts.entries()].map(([role, runs]) => ({ role, runs })),
      tasks: taskOutcomes,
      integrationBranch: mission.integrationBranch,
      taskBranches: tasks
        .map((task) => task.branchName)
        .filter((branch): branch is string => Boolean(branch)),
      integrationResult:
        integrationTask?.state === 'succeeded'
          ? 'clean'
          : integrationTask?.failureCode === 'integration_conflict'
            ? 'conflicted'
            : integrationTask
              ? 'not_attempted'
              : 'not_required',
      integrationDetail: integrationTask?.failureMessage ?? integrationTask?.summary ?? null,
      changedFiles,
      diffSummary: null,
      verification,
      reviews: reviewOutcomes,
      repairedFindings: findings
        .filter((finding) => finding.state === 'repaired')
        .map(toReceiptFinding),
      remainingFindings: findings
        .filter((finding) => finding.state === 'noted' || finding.state === 'owner_decision')
        .map(toReceiptFinding),
      unresolvedRisks: findings
        .filter((finding) => finding.blocksDelivery && finding.state !== 'repaired')
        .map((finding) => `${finding.key}: ${finding.title}`),
      artifacts: artifacts.map((artifact) => ({
        id: artifact.id,
        title: artifact.title,
        kind: artifact.kind,
      })),
      pullRequestUrl: mission.pullRequestUrl,
      pullRequestNumber: mission.pullRequestNumber,
      usage: {
        outputTokens: sum(tasks.map((task) => task.usage.outputTokens)),
        inputTokens: sum(tasks.map((task) => task.usage.inputTokens)),
        durationMs: sum(tasks.map((task) => task.usage.durationMs)),
        agentRuns: tasks.filter((task) => task.attempt > 0).length,
        estimatedCostUsd: sum(tasks.map((task) => task.usage.totalCostUsd)),
      },
      stages,
      nextSteps: deriveNextSteps({
        stages,
        remainingFindings: findings
          .filter((finding) => finding.state === 'noted' || finding.state === 'owner_decision')
          .map(toReceiptFinding),
        verification,
        pullRequestUrl: mission.pullRequestUrl,
      }),
      generatedAt: this.clock().toISOString(),
    };

    const receipt = await this.deps.receipts.upsert({
      missionId: mission.id,
      graphVersion: content.graphVersion,
      planVersion: content.planVersion,
      content,
    });
    await this.deps.missions.patch(mission.id, { receiptId: receipt.id });
    void deliveryTask;
    return content;
  }

  /* ------------------------------------------------------------- utilities */

  /** Whether a task may start right now, with the reason when it may not. */
  async canStart(task: MissionTask): Promise<{ allowed: boolean; reason: string | null }> {
    const limits = await this.limits();
    const posture = await this.posture();
    const tasks = await this.deps.tasks.listByMission(task.missionId);
    const mission = await this.requireMission(task.missionId);
    const verdict = canStartTask({
      limits,
      instance: {
        activeMissions: await this.deps.tasks.countActiveMissions(),
        activeRuns: await this.deps.tasks.countActive(),
        posture,
      },
      mission: summariseMissionCapacity(tasks, { repairRoundsUsed: mission.repairRoundsUsed }),
      task,
      missionAlreadyActive: tasks.some((other) => other.state === 'running'),
    });
    return { allowed: verdict.allowed, reason: verdict.reason };
  }

  private async requireMission(missionId: string): Promise<Mission> {
    const mission = await this.deps.missions.findById(missionId);
    if (!mission) throw new NotFoundError('Mission');
    return mission;
  }
}

function sum(values: readonly (number | null)[]): number | null {
  const present = values.filter((value): value is number => typeof value === 'number');
  return present.length === 0 ? null : present.reduce((total, value) => total + value, 0);
}
