import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '@/domain/errors';
import type { Mission, MissionState } from '@/domain/mission';
import { isReadOnlyMissionType } from '@/domain/mission';
import type { MissionRun } from '@/domain/mission-run';
import type {
  MissionAssignment,
  PendingCommand,
  WorkerClaimInput,
  WorkerEventBatchInput,
  WorkerHeartbeatInput,
  WorkerPlanSubmissionInput,
  WorkerPollInput,
  WorkerPollResponse,
  WorkerRunStateInput,
} from '@/domain/worker-protocol';
import { classifyMissionRisk } from '@/domain/mission-risk';
import { assertMissionBranchName, buildBranchName } from '@/domain/workspace-safety';
import type { WorkerEnrolment } from '@/domain/worker';
import type {
  ArtifactInput,
  PermissionRequestInput,
  VerificationInput,
} from '@/domain/mission-run';
import type {
  ApprovalRepository,
  ArtifactRepository,
  ClarificationRepository,
  CommandRepository,
  EventRepository,
  MissionRepository,
  PermissionRepository,
  PlanRepository,
  RunRepository,
  VerificationRepository,
  WorkerRepository,
} from '@/server/repositories/mission-types';
import type {
  EvidenceRepository,
  ProjectRepository,
  SourceRepository,
} from '@/server/repositories/types';
import { issueWorkerToken } from '@/server/workers/auth';
import type { MissionService } from './mission-service';

/**
 * The worker-facing half of Mission Control.
 *
 * Everything a worker sends passes through here, and the guiding rule is the same in every
 * method: **the worker's claims about the world are never taken at face value.** It says "run
 * <id>"; the control plane looks that run up, checks it belongs to this worker, checks it is the
 * mission's active run, and only then acts. A worker never tells Jarvis which project a mission
 * belongs to — Jarvis reads that from its own table when it builds the assignment.
 */

export interface WorkerServiceDeps {
  readonly missions: MissionRepository;
  readonly plans: PlanRepository;
  readonly approvals: ApprovalRepository;
  readonly clarifications: ClarificationRepository;
  readonly runs: RunRepository;
  readonly events: EventRepository;
  readonly commands: CommandRepository;
  readonly permissions: PermissionRepository;
  readonly verifications: VerificationRepository;
  readonly artifacts: ArtifactRepository;
  readonly workers: WorkerRepository;
  readonly projects: ProjectRepository;
  readonly sources: SourceRepository;
  readonly evidence: EvidenceRepository;
  readonly missionService: MissionService;
  readonly concurrencyLimit: number;
  readonly allowWebResearch: boolean;
  readonly clock?: () => Date;
}

/** How often the worker should come back. Faster while it holds work, slower while idle. */
const POLL_INTERVAL_BUSY_MS = 1000;
const POLL_INTERVAL_IDLE_MS = 3000;

export class WorkerService {
  private readonly clock: () => Date;

  constructor(private readonly deps: WorkerServiceDeps) {
    this.clock = deps.clock ?? (() => new Date());
  }

  /* ---------------------------------------------------------------- enrolment */

  /** Enrol a worker and return its secret — the only time that value exists outside the worker. */
  async enrol(name: string, maxConcurrency: number): Promise<WorkerEnrolment> {
    const placeholder = await this.deps.workers.enrol({
      name,
      tokenHash: 'pending',
      tokenPrefix: 'pending',
      maxConcurrency,
    });
    const { token, hash, prefix } = issueWorkerToken(placeholder.id);
    const worker = await this.deps.workers.rotate(placeholder.id, hash, prefix);
    return { worker, token };
  }

  async rotate(workerId: string): Promise<WorkerEnrolment> {
    const existing = await this.deps.workers.findById(workerId);
    if (!existing) throw new NotFoundError('Worker');
    const { token, hash, prefix } = issueWorkerToken(workerId);
    const worker = await this.deps.workers.rotate(workerId, hash, prefix);
    return { worker, token };
  }

  async revoke(workerId: string, reason: string): Promise<void> {
    const worker = await this.deps.workers.revoke(workerId, reason);
    /*
     * Revoking does not fail whatever the worker was doing. The mission stays where it is with
     * its workspace intact, and the owner decides whether to retry it elsewhere.
     */
    if (worker.currentMissionId) {
      await this.deps.events.record(worker.currentMissionId, {
        type: 'warning',
        actor: 'owner',
        level: 'warning',
        summary: `The worker holding this mission (${worker.name}) was revoked. Its work is preserved.`,
      });
    }
  }

  /* --------------------------------------------------------------------- poll */

  /**
   * One round trip: heartbeat, fetch commands, and learn about any assignment.
   *
   * Deliberately combined. A worker that heartbeats and polls separately can be healthy in one
   * call and stale in the other, and the mission screen would show two different truths.
   */
  async poll(workerId: string, input: WorkerPollInput): Promise<WorkerPollResponse> {
    const now = this.clock();
    await this.applyHeartbeat(workerId, input.heartbeat, now);

    const worker = await this.deps.workers.findById(workerId);
    if (!worker) throw new NotFoundError('Worker');

    if (worker.revokedAt) {
      return {
        workerId,
        serverTime: now.toISOString(),
        assignment: null,
        commands: [],
        directive: 'revoked',
        pollIntervalMs: POLL_INTERVAL_IDLE_MS,
      };
    }

    /* Acknowledge whatever the worker says it has seen, so it is not delivered forever. */
    if (input.acknowledgedCommandIds.length > 0) {
      await this.deps.commands.markDelivered(input.acknowledgedCommandIds, now);
    }

    const held = await this.currentAssignment(workerId);
    const assignment = held ? await this.buildAssignment(held.mission, held.run) : null;
    const commands = held ? await this.pendingCommands(held.mission.id) : [];

    return {
      workerId,
      serverTime: now.toISOString(),
      assignment,
      commands,
      directive: input.heartbeat.status === 'draining' ? 'drain' : 'continue',
      pollIntervalMs: assignment ? POLL_INTERVAL_BUSY_MS : POLL_INTERVAL_IDLE_MS,
    };
  }

  /* -------------------------------------------------------------------- claim */

  /**
   * Take the next runnable mission.
   *
   * Two paths converge here: a mission `queued` for execution, and a mission `inspecting` that
   * needs a read-only planning run. Both end with the worker holding exactly one run.
   */
  async claim(workerId: string, input: WorkerClaimInput): Promise<MissionAssignment | null> {
    const now = this.clock();
    await this.applyHeartbeat(workerId, input.heartbeat, now);

    const worker = await this.deps.workers.findById(workerId);
    if (!worker) throw new NotFoundError('Worker');
    if (worker.revokedAt) throw new ForbiddenError('This worker has been revoked.');

    /* A worker already holding a run gets that run back rather than a second one. */
    const held = await this.currentAssignment(workerId);
    if (held) return this.buildAssignment(held.mission, held.run);

    if (input.accepts.includes('inspection')) {
      const inspection = await this.claimInspection(workerId, now);
      if (inspection) return inspection;
    }
    if (!input.accepts.includes('execution') && !input.accepts.includes('research')) return null;

    const claimed = await this.deps.missions.claimNext({
      workerId,
      kinds: input.accepts,
      concurrencyLimit: this.deps.concurrencyLimit,
      now,
    });
    if (!claimed) return null;

    /* Re-validate the approval after claiming: the guard inside the SQL is necessary, not sufficient. */
    const approval = await this.deps.approvals.activeFor(claimed.mission.id);
    if (!approval || approval.planVersion !== claimed.mission.currentPlanVersion) {
      await this.deps.runs.patch(claimed.run.id, {
        state: 'failed',
        finishedAt: now,
        failureCode: 'plan_superseded',
        failureMessage: 'The approved plan version changed between queueing and claiming.',
      });
      await this.deps.missions.patch(claimed.mission.id, {
        activeRunId: null,
        claimedByWorkerId: null,
      });
      await this.deps.missionService.tryMove(
        claimed.mission,
        'awaiting_plan_approval',
        'system',
        {},
      );
      return null;
    }

    await this.deps.events.append(claimed.mission.id, claimed.run.id, [
      {
        seq: 0,
        type: 'run_started',
        level: 'notice',
        actor: 'worker',
        summary: `Worker ${worker.name} claimed this mission (attempt ${claimed.run.attempt}).`,
        detail: { runId: claimed.run.id, attempt: claimed.run.attempt },
      },
    ]);

    return this.buildAssignment(claimed.mission, claimed.run);
  }

  /** Planning runs bypass the execution queue: they change nothing, so they need no approval. */
  private async claimInspection(workerId: string, now: Date): Promise<MissionAssignment | null> {
    const open = await this.deps.missions.listOpen();
    const candidate = open.find(
      (mission) =>
        mission.state === 'inspecting' && mission.activeRunId === null && mission.projectId,
    );
    if (!candidate) return null;

    const attempt = await this.deps.runs.nextAttempt(candidate.id);
    const run = await this.deps.runs.start({
      missionId: candidate.id,
      workerId,
      attempt,
      kind: 'inspection',
      planVersion: null,
      startedAt: now,
    });
    const mission = await this.deps.missions.patch(candidate.id, {
      activeRunId: run.id,
      claimedByWorkerId: workerId,
      lastActivityAt: now,
    });
    await this.deps.events.append(mission.id, run.id, [
      {
        seq: 0,
        type: 'run_started',
        level: 'notice',
        actor: 'worker',
        summary: 'Read-only inspection started. Nothing will be changed during this run.',
        detail: { runId: run.id, kind: 'inspection' },
      },
    ]);
    return this.buildAssignment(mission, run);
  }

  /* --------------------------------------------------------------- reporting */

  /**
   * Validate that a worker may act on a run.
   *
   * This is the single choke point every worker write goes through, and it enforces three
   * separate things: the run exists, it belongs to *this* worker, and it is still the mission's
   * active run. The third check is what stops a worker resurrected from an old attempt writing
   * over a newer one.
   */
  async authoriseRun(
    workerId: string,
    runId: string,
  ): Promise<{ mission: Mission; run: MissionRun }> {
    const run = await this.deps.runs.findById(runId);
    if (!run) throw new NotFoundError('Run');
    if (run.workerId !== workerId) {
      throw new ForbiddenError('That run belongs to a different worker.');
    }
    const mission = await this.deps.missions.findById(run.missionId);
    if (!mission) throw new NotFoundError('Mission');
    if (mission.activeRunId !== run.id) {
      throw new ConflictError(
        'That run is no longer this mission’s active run. Stop reporting against it.',
        { activeRunId: mission.activeRunId },
      );
    }
    return { mission, run };
  }

  async appendEvents(
    workerId: string,
    input: WorkerEventBatchInput,
  ): Promise<{ accepted: number }> {
    const { mission, run } = await this.authoriseRun(workerId, input.runId);
    /*
     * A stopped or finished mission stops accepting ordinary execution events. It still accepts
     * the errors and run_finished notes that explain *why* it stopped, so the record is complete.
     */
    const terminal =
      mission.state === 'stopped' || mission.state === 'completed' || mission.state === 'cancelled';
    const allowed = terminal
      ? input.events.filter((event) =>
          ['run_finished', 'error', 'warning', 'info'].includes(event.type),
        )
      : input.events;

    if (allowed.length === 0) {
      throw new ConflictError(
        `This mission is ${mission.state}; it no longer accepts execution events.`,
      );
    }
    const written = await this.deps.events.append(mission.id, run.id, allowed);
    await this.deps.missions.patch(mission.id, { lastActivityAt: this.clock() });
    return { accepted: written.length };
  }

  /**
   * Apply a worker's report of where its run has got to.
   *
   * The worker proposes a mission state; the state machine decides whether that move exists and
   * whether a worker is allowed to make it. `completed` in particular is only reachable from the
   * states that genuinely precede finishing, so a crashed worker cannot report success.
   *
   * A report with no `missionState` is metadata only — a session id, a token count. It updates
   * the run row and the activity clock and deliberately leaves the mission state alone.
   */
  async reportRunState(workerId: string, input: WorkerRunStateInput): Promise<Mission> {
    const { mission, run } = await this.authoriseRun(workerId, input.runId);
    const now = this.clock();

    if (input.branchName) assertMissionBranchName(input.branchName);

    await this.deps.runs.patch(run.id, {
      currentAction: input.currentAction ?? null,
      ...(input.agentSessionId !== undefined
        ? { agentSessionId: input.agentSessionId ?? null }
        : {}),
      ...(input.runtimeName !== undefined ? { runtimeName: input.runtimeName ?? null } : {}),
      ...(input.runtimeVersion !== undefined
        ? { runtimeVersion: input.runtimeVersion ?? null }
        : {}),
      ...(input.workspacePath !== undefined ? { workspacePath: input.workspacePath ?? null } : {}),
      ...(input.baseBranch !== undefined ? { baseBranch: input.baseBranch ?? null } : {}),
      ...(input.baseSha !== undefined ? { baseSha: input.baseSha ?? null } : {}),
      ...(input.branchName !== undefined ? { branchName: input.branchName ?? null } : {}),
      ...(input.headSha !== undefined ? { headSha: input.headSha ?? null } : {}),
      ...(input.pullRequestUrl !== undefined
        ? { pullRequestUrl: input.pullRequestUrl ?? null }
        : {}),
      ...(input.pullRequestNumber !== undefined
        ? { pullRequestNumber: input.pullRequestNumber ?? null }
        : {}),
      ...(input.filesChanged ? { filesChanged: input.filesChanged } : {}),
      ...(input.usage !== undefined
        ? {
            usage: input.usage
              ? {
                  inputTokens: input.usage.inputTokens ?? null,
                  outputTokens: input.usage.outputTokens ?? null,
                  cacheReadTokens: input.usage.cacheReadTokens ?? null,
                  totalCostUsd: input.usage.totalCostUsd ?? null,
                  turns: input.usage.turns ?? null,
                  durationMs: input.usage.durationMs ?? null,
                }
              : null,
          }
        : {}),
      ...(input.failureCode !== undefined ? { failureCode: input.failureCode ?? null } : {}),
      ...(input.failureMessage !== undefined
        ? { failureMessage: input.failureMessage ?? null }
        : {}),
      ...(input.workspacePreserved !== undefined && input.workspacePreserved !== null
        ? { workspacePreserved: input.workspacePreserved }
        : {}),
      ...(input.missionState ? { state: runStateFor(input.missionState) } : {}),
      lastEventAt: now,
    });

    const patch = {
      lastActivityAt: now,
      ...(input.branchName !== undefined ? { workingBranch: input.branchName ?? null } : {}),
      ...(input.baseBranch !== undefined ? { baseBranch: input.baseBranch ?? null } : {}),
      ...(input.baseSha !== undefined ? { baseSha: input.baseSha ?? null } : {}),
      ...(input.pullRequestUrl !== undefined
        ? { pullRequestUrl: input.pullRequestUrl ?? null }
        : {}),
      ...(input.pullRequestNumber !== undefined
        ? { pullRequestNumber: input.pullRequestNumber ?? null }
        : {}),
      ...(input.completionSummary !== undefined
        ? { completionSummary: input.completionSummary ?? null }
        : {}),
      ...(input.failureCode !== undefined ? { failureCode: input.failureCode ?? null } : {}),
      ...(input.failureMessage !== undefined
        ? { failureMessage: input.failureMessage ?? null }
        : {}),
    };

    if (!input.missionState) {
      /* Metadata only: record the activity and leave the state machine untouched. */
      return this.deps.missions.patch(mission.id, patch);
    }

    const finished =
      input.missionState === 'completed' ||
      input.missionState === 'failed' ||
      input.missionState === 'stopped';

    const moved = await this.deps.missionService.move(mission, input.missionState, 'worker', {
      ...patch,
      ...(finished ? { finishedAt: now, activeRunId: null } : {}),
    });

    if (finished) {
      await this.deps.runs.patch(run.id, {
        state: runStateFor(input.missionState),
        finishedAt: now,
      });
      await this.deps.permissions.cancelForRun(run.id);
    }
    return moved;
  }

  /** A plan produced by a worker that actually read the repository. */
  async submitPlan(
    workerId: string,
    missionId: string,
    input: WorkerPlanSubmissionInput,
  ): Promise<Mission> {
    const mission = await this.deps.missions.findById(missionId);
    if (!mission) throw new NotFoundError('Mission');
    if (input.runId) await this.authoriseRun(workerId, input.runId);
    else if (mission.claimedByWorkerId !== workerId) {
      throw new ForbiddenError('This mission is not held by that worker.');
    }

    /*
     * The worker's own risk opinion is advisory. The control plane re-classifies from the plan's
     * text, so a plan that describes something prohibited is caught even if the worker said it
     * was low risk.
     */
    const risk = classifyMissionRisk({
      text: [input.content.summary, input.content.proposedOutcome, input.content.approach].join(
        '\n',
      ),
      type: mission.type,
    });
    if (risk.level === 'prohibited') {
      await this.deps.events.record(missionId, {
        type: 'policy_refusal',
        actor: 'system',
        level: 'error',
        summary: 'The submitted plan described a prohibited operation and was rejected.',
        detail: { ruleIds: risk.ruleIds },
      });
      throw new ForbiddenError(risk.refusal ?? 'That plan describes something Jarvis will not do.');
    }

    const planning = await this.deps.missionService.tryMove(mission, 'planning', 'worker', {});
    const stored = await this.deps.missionService.storePlan(
      planning,
      input.content,
      'worker_inspection',
      'verified',
      input.runId ?? null,
    );

    /* An inspection run ends when its plan lands. */
    if (input.runId) {
      await this.deps.runs.patch(input.runId, { state: 'succeeded', finishedAt: this.clock() });
      await this.deps.missions.patch(missionId, { activeRunId: null });
    }
    return stored;
  }

  async recordPermissionRequest(
    workerId: string,
    runId: string,
    input: PermissionRequestInput,
  ): Promise<{ id: string }> {
    const { mission, run } = await this.authoriseRun(workerId, runId);
    const request = await this.deps.permissions.create(mission.id, run.id, input);
    await this.deps.events.record(mission.id, {
      type: 'permission_requested',
      actor: 'agent',
      level: 'warning',
      summary: `Permission needed: ${input.requestedAction}`,
      detail: { requestKey: input.requestKey, risk: input.risk, kind: input.kind },
    });
    await this.deps.missionService.tryMove(
      mission,
      input.kind === 'clarification' ? 'waiting_for_input' : 'waiting_for_permission',
      'worker',
      {},
    );
    return { id: request.id };
  }

  async recordVerification(
    workerId: string,
    runId: string,
    input: VerificationInput,
  ): Promise<{ id: string }> {
    const { mission, run } = await this.authoriseRun(workerId, runId);
    const record = await this.deps.verifications.record(mission.id, run.id, input);
    await this.deps.events.record(mission.id, {
      type: 'verification_finished',
      actor: 'worker',
      level: input.outcome === 'failed' ? 'warning' : 'info',
      summary: describeVerification(input),
      detail: {
        command: record.command,
        outcome: record.outcome,
        exitCode: record.exitCode,
        missionRelated: record.missionRelated,
      },
    });
    return { id: record.id };
  }

  async recordArtifact(
    workerId: string,
    missionId: string,
    runId: string | null,
    input: ArtifactInput,
  ): Promise<{ id: string }> {
    if (runId) await this.authoriseRun(workerId, runId);
    else {
      const mission = await this.deps.missions.findById(missionId);
      if (!mission) throw new NotFoundError('Mission');
      if (mission.claimedByWorkerId !== workerId) {
        throw new ForbiddenError('This mission is not held by that worker.');
      }
    }
    const artifact = await this.deps.missionService.addArtifact(missionId, input, 'agent', runId);
    return { id: artifact.id };
  }

  async acknowledgeCommand(
    workerId: string,
    commandId: string,
    outcome: 'acknowledged' | 'completed' | 'failed',
    detail: string | null,
  ): Promise<void> {
    const worker = await this.deps.workers.findById(workerId);
    if (!worker) throw new NotFoundError('Worker');
    const command = await this.deps.commands.setState(commandId, outcome, detail);
    await this.deps.events.record(command.missionId, {
      type: 'command_acknowledged',
      actor: 'worker',
      summary: `The worker ${outcome} the ${command.kind} command.`,
      detail: { commandId, outcome, ...(detail ? { detail } : {}) },
    });
  }

  /* ---------------------------------------------------------------- internals */

  private async applyHeartbeat(
    workerId: string,
    heartbeat: WorkerHeartbeatInput,
    at: Date,
  ): Promise<void> {
    await this.deps.workers.heartbeat(workerId, {
      status: heartbeat.status,
      version: heartbeat.version ?? null,
      platform: heartbeat.platform ?? null,
      runtimeAvailable: heartbeat.runtimeAvailable,
      runtimeName: heartbeat.runtimeName ?? null,
      runtimeDetail: heartbeat.runtimeDetail ?? null,
      workspaceHealthy: heartbeat.workspaceHealthy,
      workspaceRootLabel: heartbeat.workspaceRootLabel ?? null,
      githubDeliveryConfigured: heartbeat.githubDeliveryConfigured,
      diagnostics: heartbeat.diagnostics,
      /*
       * The mission and run a worker reports are *display* fields. Authorisation always comes
       * from `mission_runs.worker_id`, never from what the worker says it is holding.
       */
      currentMissionId: heartbeat.currentMissionId ?? null,
      currentRunId: heartbeat.currentRunId ?? null,
      lastActivityAt: heartbeat.lastActivityAt ? new Date(heartbeat.lastActivityAt) : null,
      at,
    });
  }

  private async currentAssignment(
    workerId: string,
  ): Promise<{ mission: Mission; run: MissionRun } | null> {
    const active = await this.deps.missions.listActive();
    const held = active.find(
      (mission) => mission.claimedByWorkerId === workerId && mission.activeRunId,
    );
    if (!held?.activeRunId) return null;
    const run = await this.deps.runs.findById(held.activeRunId);
    if (!run || run.workerId !== workerId) return null;
    return { mission: held, run };
  }

  private async pendingCommands(missionId: string): Promise<readonly PendingCommand[]> {
    const commands = await this.deps.commands.pendingFor(missionId);
    return commands.map((command) => ({
      id: command.id,
      kind: command.kind,
      missionId: command.missionId,
      runId: command.runId,
      payload: command.payload,
      requestedAt: command.requestedAt,
    }));
  }

  /**
   * Assemble everything the worker needs for one mission.
   *
   * Built entirely from the control plane's own tables. In particular the repository, the base
   * branch and the branch name are Jarvis's, not the worker's, which is what makes "the worker
   * cannot push to the default branch" enforceable rather than merely requested.
   */
  private async buildAssignment(mission: Mission, run: MissionRun): Promise<MissionAssignment> {
    if (!mission.projectId) throw new ValidationError('That mission has no project.');
    const project = await this.deps.projects.findById(mission.projectId);
    if (!project) throw new NotFoundError('Project');

    const sources = await this.deps.sources.listByProject(project.id);
    const chosen =
      (mission.sourceId ? sources.find((source) => source.id === mission.sourceId) : undefined) ??
      sources.find((source) => source.kind === 'github_repo' && source.isPrimary) ??
      sources.find((source) => source.kind === 'github_repo') ??
      null;

    const plan = mission.currentPlanVersion
      ? await this.deps.plans.byVersion(mission.id, mission.currentPlanVersion)
      : null;
    const clarifications = await this.deps.clarifications.list(mission.id);
    const evidence = await this.deps.evidence.list({ projectId: project.id, limit: 25 });

    const readOnly = run.kind === 'inspection' || isReadOnlyMissionType(mission.type);
    const branchName = readOnly
      ? null
      : (mission.workingBranch ?? buildBranchName(mission.id, mission.title));

    return {
      missionId: mission.id,
      runId: run.id,
      kind: run.kind,
      attempt: run.attempt,
      missionTitle: mission.title,
      missionDescription: mission.description,
      rawRequest: mission.rawRequest,
      missionType: mission.type,
      riskLevel: mission.riskLevel,
      projectId: project.id,
      projectName: project.name,
      projectGoal: project.goal,
      planVersion: run.kind === 'inspection' ? null : mission.approvedPlanVersion,
      /* An inspection run gets no plan: producing one is the point of the run. */
      plan: run.kind === 'inspection' ? null : (plan?.content ?? null),
      constraints: mission.constraints,
      doNotTouch: mission.doNotTouch,
      acceptanceCriteria: mission.acceptanceCriteria,
      deliverable: mission.deliverable,
      repository:
        chosen?.github && chosen.github.owner && chosen.github.repo
          ? {
              owner: chosen.github.owner,
              name: chosen.github.repo,
              fullName: `${chosen.github.owner}/${chosen.github.repo}`,
              defaultBranch: chosen.github.defaultBranch ?? 'main',
              cloneUrl:
                chosen.github.url ??
                `https://github.com/${chosen.github.owner}/${chosen.github.repo}.git`,
              visibility: chosen.github.visibility,
            }
          : null,
      branchName,
      resumeSessionId: run.agentSessionId,
      clarifications: clarifications
        .filter((record) => record.answer !== null)
        .map((record) => ({
          question: record.question,
          answer: record.answer ?? '',
          assumed: record.answerProvenance === 'inferred',
        })),
      projectContext: buildProjectContext(project.goal, project.phase, evidence.slice(0, 8)),
      allowWebResearch: this.deps.allowWebResearch && isReadOnlyMissionType(mission.type),
    };
  }
}

function buildProjectContext(
  goal: string | null,
  phase: string | null,
  evidence: readonly { title: string; kind: string; observedAt: string }[],
): readonly string[] {
  const lines: string[] = [];
  if (goal) lines.push(`Project goal: ${goal}`);
  if (phase) lines.push(`Current phase: ${phase}`);
  for (const item of evidence) {
    lines.push(`Recent ${item.kind.replace(/_/g, ' ')}: ${item.title}`);
  }
  return lines;
}

/** How a mission state maps onto the run's own lifecycle. */
function runStateFor(state: MissionState): MissionRun['state'] {
  switch (state) {
    case 'completed':
    case 'pull_request_ready':
      return 'succeeded';
    case 'failed':
      return 'failed';
    case 'stopped':
      return 'stopped';
    case 'stopping':
      return 'stopping';
    case 'paused':
      return 'paused';
    default:
      return 'running';
  }
}

function describeVerification(input: VerificationInput): string {
  switch (input.outcome) {
    case 'passed':
      return `Verification passed: ${input.command}`;
    case 'failed':
      return `Verification failed: ${input.command}${
        input.missionRelated === false ? ' (pre-existing, not caused by this mission)' : ''
      }`;
    case 'unavailable':
      return `Verification unavailable: ${input.command}${input.reason ? ` — ${input.reason}` : ''}`;
    default:
      return `Verification skipped: ${input.command}${input.reason ? ` — ${input.reason}` : ''}`;
  }
}
