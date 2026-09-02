import { randomUUID } from 'node:crypto';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '@/domain/errors';
import {
  MISSION_RISK_LABELS,
  MISSION_STATE_LABELS,
  isReadOnlyMissionType,
  type ClarificationRecord,
  type Mission,
  type MissionDraftInput,
  type MissionState,
  type MissionSummary,
  type MissionUpdateInput,
} from '@/domain/mission';
import {
  assertTransition,
  canQueueMission,
  canResumeMission,
  type MissionActor,
} from '@/domain/mission-state';
import { classifyMissionRisk, inferMissionType } from '@/domain/mission-risk';
import { deriveMissionTitle } from '@/domain/mission-intake';
import { assessProjectGate, buildClarificationQuestions } from '@/domain/mission-clarification';
import type { MissionPlan, MissionPlanContent, PlanApprovalInput } from '@/domain/mission-plan';
import { planFactsChanged } from '@/domain/mission-plan';
import type {
  ArtifactInput,
  CommandKind,
  MissionArtifact,
  MissionCommand,
  MissionEvent,
  MissionPermissionRequest,
  MissionRun,
  MissionVerification,
  PermissionDecisionInput,
} from '@/domain/mission-run';
import { containsSecret } from '@/domain/redaction';
import { buildBranchName } from '@/domain/workspace-safety';
import { deriveWorkerHealth, type WorkerHealth } from '@/domain/worker';
import { resolveProjectName, type MatchResult } from '@/server/query/parser';
import type {
  ProjectRepository,
  SourceRepository,
  EvidenceRepository,
  ActivityLogService,
} from '@/server/repositories/types';
import type {
  ApprovalRepository,
  ArtifactRepository,
  ClarificationRepository,
  CommandRepository,
  EventRepository,
  MissionListFilter,
  MissionRepository,
  PermissionRepository,
  PlanRepository,
  RunRepository,
  VerificationRepository,
  WorkerRepository,
} from '@/server/repositories/mission-types';
import { buildDeterministicPlan, fingerprintPlan, planIsReviewOnly } from './planner';

/**
 * Mission Control orchestration.
 *
 * Every rule that decides whether something is allowed lives in `@/domain/mission-state` as a
 * pure function; this service is what wires those rules to the database, records the audit trail,
 * and refuses politely when a rule says no.
 *
 * Two habits run through it:
 *  - **Every state change goes through `move()`**, which validates the transition against the
 *    table and writes an event. There is no other way to change `missions.state`.
 *  - **Nothing trusts its caller's view of the world.** A route hands in an id; the service
 *    re-reads the mission, the plan and the project before deciding anything.
 */

export interface MissionServiceDeps {
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
  readonly activity: ActivityLogService;
  readonly concurrencyLimit: number;
  readonly clock?: () => Date;
}

export interface MissionDetail {
  readonly mission: Mission;
  readonly project: { readonly id: string; readonly name: string } | null;
  readonly plans: readonly MissionPlan[];
  readonly currentPlan: MissionPlan | null;
  readonly approval: Awaited<ReturnType<ApprovalRepository['activeFor']>>;
  readonly clarifications: readonly ClarificationRecord[];
  readonly runs: readonly MissionRun[];
  readonly activeRun: MissionRun | null;
  readonly events: readonly MissionEvent[];
  readonly permissionRequests: readonly MissionPermissionRequest[];
  readonly verifications: readonly MissionVerification[];
  readonly artifacts: readonly MissionArtifact[];
  readonly commands: readonly MissionCommand[];
  readonly worker: WorkerHealth | null;
  readonly canQueue: { ok: boolean; reason: string | null };
  readonly stalled: boolean;
}

export interface MissionCreationResult {
  readonly mission: Mission;
  readonly questions: readonly ClarificationRecord[];
  readonly projectMatch: MatchResult | null;
  readonly notice: string | null;
  readonly refusal: string | null;
}

export class MissionService {
  private readonly clock: () => Date;

  constructor(private readonly deps: MissionServiceDeps) {
    this.clock = deps.clock ?? (() => new Date());
  }

  /* ------------------------------------------------------------------ intake */

  /**
   * Create a mission from a plain-language request.
   *
   * A prohibited request never becomes a mission at all: it is refused with the rule that caught
   * it, so there is no row to later be approved by mistake.
   */
  async create(
    input: MissionDraftInput,
    ownerLogin: string | null,
    options: { projectHint?: string | null } = {},
  ): Promise<MissionCreationResult> {
    const type = input.type ?? inferMissionType(input.rawRequest);
    const risk = classifyMissionRisk({
      text: `${input.rawRequest}\n${input.description ?? ''}`,
      type,
      constraints: input.constraints,
    });

    if (risk.level === 'prohibited') {
      throw new ForbiddenError(risk.refusal ?? 'Jarvis will not run this mission.');
    }

    let projectId = input.projectId ?? null;
    let projectMatch: MatchResult | null = null;
    if (!projectId && options.projectHint) {
      projectMatch = await this.matchProject(options.projectHint);
      if (projectMatch.kind === 'exact' || projectMatch.kind === 'close') {
        projectId = projectMatch.matches[0]?.id ?? null;
      }
    }

    const mission = await this.deps.missions.create({
      ...input,
      projectId,
      title: input.title ?? deriveMissionTitle(input.rawRequest),
      type,
      riskLevel: risk.level,
      riskRuleIds: risk.ruleIds,
      riskReasons: risk.reasons,
      ownerLogin,
      state: 'draft',
    });

    await this.deps.events.record(mission.id, {
      type: 'mission_created',
      actor: 'owner',
      level: 'notice',
      summary: `Mission created: ${mission.title}`,
      detail: { riskLevel: risk.level, riskRuleIds: risk.ruleIds, type },
    });

    const refreshed = await this.refreshClarifications(mission.id);
    const notice = await this.projectNotice(refreshed.mission);

    return {
      mission: refreshed.mission,
      questions: refreshed.questions,
      projectMatch,
      notice,
      refusal: null,
    };
  }

  /** Reuses the Phase 1 matcher so a mission and a status question resolve names identically. */
  async matchProject(query: string): Promise<MatchResult> {
    const page = await this.deps.projects.list({ includeArchived: true, limit: 500 });
    return resolveProjectName(
      query,
      page.items.map((project) => ({
        id: project.id,
        name: project.name,
        shortName: project.shortName,
      })),
    );
  }

  async update(id: string, input: MissionUpdateInput): Promise<MissionCreationResult> {
    const existing = await this.require(id);
    if (this.isLocked(existing.state)) {
      throw new ConflictError(
        `A mission that is ${MISSION_STATE_LABELS[existing.state].toLowerCase()} cannot be edited. Stop it first.`,
      );
    }
    const updated = await this.deps.missions.update(id, input);

    /* Re-classify: an edit can change the risk, and a stale risk level is a security problem. */
    const risk = classifyMissionRisk({
      text: `${updated.rawRequest}\n${updated.description ?? ''}\n${updated.title}`,
      type: updated.type,
      constraints: updated.constraints,
    });
    if (risk.level === 'prohibited') {
      throw new ForbiddenError(risk.refusal ?? 'That edit turns this into a prohibited mission.');
    }
    if (risk.level !== updated.riskLevel) {
      await this.deps.missions.patch(id, {
        riskLevel: risk.level,
        riskRuleIds: risk.ruleIds,
        riskReasons: risk.reasons,
      });
      await this.deps.events.record(id, {
        type: 'info',
        actor: 'system',
        summary: `Risk re-classified as ${MISSION_RISK_LABELS[risk.level].toLowerCase()} after the edit.`,
        detail: { ruleIds: risk.ruleIds },
      });
    }

    const refreshed = await this.refreshClarifications(id);
    return {
      mission: refreshed.mission,
      questions: refreshed.questions,
      projectMatch: null,
      notice: await this.projectNotice(refreshed.mission),
      refusal: null,
    };
  }

  /* ---------------------------------------------------------- clarification */

  /** Recompute the open questions and park the mission wherever they leave it. */
  async refreshClarifications(
    missionId: string,
  ): Promise<{ mission: Mission; questions: readonly ClarificationRecord[] }> {
    const mission = await this.require(missionId);
    if (this.isLocked(mission.state) || mission.state === 'awaiting_plan_approval') {
      return { mission, questions: await this.deps.clarifications.list(missionId) };
    }

    const project = mission.projectId ? await this.deps.projects.findById(mission.projectId) : null;
    const sources = mission.projectId
      ? await this.deps.sources.listByProject(mission.projectId)
      : [];
    const existing = await this.deps.clarifications.list(missionId);
    const answered = existing.filter((record) => record.answeredAt !== null);

    const questions = buildClarificationQuestions({
      mission,
      project: project
        ? {
            name: project.name,
            status: project.status,
            type: project.type,
            archived: project.archivedAt !== null,
            goal: project.goal,
          }
        : null,
      repositoryChoices: sources
        .filter((source) => source.kind === 'github_repo' && source.github)
        .map((source) => ({
          id: source.id,
          fullName: `${source.github?.owner}/${source.github?.repo}`,
        })),
      alreadyAsked: answered.map((record) => record.id),
    });

    await this.deps.clarifications.replaceOpen(missionId, questions);
    if (questions.length > 0) {
      await this.deps.events.record(missionId, {
        type: 'clarification_asked',
        actor: 'system',
        summary:
          questions.length === 1
            ? 'Jarvis has one question before planning.'
            : `Jarvis has ${questions.length} questions before planning.`,
        detail: { topics: questions.map((question) => question.topic) },
      });
    }

    const target: MissionState = questions.length > 0 ? 'needs_clarification' : 'draft';
    const moved =
      mission.state === target ? mission : await this.tryMove(mission, target, 'system', {});

    return { mission: moved, questions: await this.deps.clarifications.list(missionId) };
  }

  async answerClarification(
    missionId: string,
    questionId: string,
    input: { answer?: string; acceptRecommendation: boolean },
  ): Promise<{ mission: Mission; questions: readonly ClarificationRecord[] }> {
    const mission = await this.require(missionId);
    const records = await this.deps.clarifications.list(missionId);
    const record = records.find((item) => item.id === questionId);
    if (!record) throw new NotFoundError('Question');

    let answer = input.answer?.trim() ?? '';
    let provenance: ClarificationRecord['answerProvenance'] = 'manual';

    if (input.acceptRecommendation) {
      if (!record.recommendation) {
        throw new ValidationError('Jarvis has no recommendation for that question.');
      }
      answer = record.recommendation;
      /*
       * Marked `inferred`, never `manual`. An assumption Jarvis made on the owner's behalf must
       * not later read as a decision the owner took.
       */
      provenance = 'inferred';
    }
    if (answer.length === 0) throw new ValidationError('An answer is required.');
    if (containsSecret(answer)) {
      throw new ValidationError(
        'That answer looks like it contains a credential. Jarvis never needs one — describe what you want instead.',
      );
    }

    await this.deps.clarifications.answer(missionId, questionId, answer, provenance);
    await this.deps.events.record(missionId, {
      type: 'clarification_answered',
      actor: provenance === 'inferred' ? 'system' : 'owner',
      summary:
        provenance === 'inferred'
          ? `Jarvis assumed an answer to: ${record.question}`
          : `Answered: ${record.question}`,
      detail: { questionId, provenance },
    });

    /* Some answers change the mission itself rather than just informing the plan. */
    await this.applyStructuralAnswer(mission, record, answer);

    return this.refreshClarifications(missionId);
  }

  /** A repository choice or a paused-project override is a change to the mission, not a note. */
  private async applyStructuralAnswer(
    mission: Mission,
    record: ClarificationRecord,
    answer: string,
  ): Promise<void> {
    if (record.topic === 'repository') {
      const sources = mission.projectId
        ? await this.deps.sources.listByProject(mission.projectId)
        : [];
      const chosen = sources.find(
        (source) => `${source.github?.owner}/${source.github?.repo}` === answer,
      );
      if (chosen) await this.deps.missions.update(mission.id, { sourceId: chosen.id });
      return;
    }
    if (record.id === 'paused_project' && /one-time|one time/i.test(answer)) {
      await this.grantExecutionOverride(mission.id, answer);
    }
    if (record.id === 'completed_project' && /^yes/i.test(answer)) {
      await this.grantExecutionOverride(mission.id, answer);
    }
    if (record.topic === 'acceptance' && answer.length > 0) {
      await this.deps.missions.update(mission.id, { acceptanceCriteria: [answer] });
    }
    if (record.topic === 'do_not_touch' && !/^nothing/i.test(answer)) {
      await this.deps.missions.update(mission.id, { doNotTouch: [answer] });
    }
  }

  /** The explicit, recorded override that lets a paused or completed project run one mission. */
  async grantExecutionOverride(missionId: string, reason: string): Promise<Mission> {
    const mission = await this.deps.missions.patch(missionId, {
      executionOverrideAt: this.clock(),
      executionOverrideReason: reason.slice(0, 500),
    });
    await this.deps.events.record(missionId, {
      type: 'info',
      actor: 'owner',
      level: 'notice',
      summary: 'You granted a one-time override for this project’s state.',
      detail: { reason: reason.slice(0, 500) },
    });
    return mission;
  }

  /* ----------------------------------------------------------------- planning */

  /** Move a mission into planning. Where the plan comes from depends on whether a worker exists. */
  async requestPlan(missionId: string): Promise<{ mission: Mission; plan: MissionPlan | null }> {
    const mission = await this.require(missionId);
    const project = mission.projectId ? await this.deps.projects.findById(mission.projectId) : null;

    const gate = assessProjectGate(
      project
        ? { status: project.status, archived: project.archivedAt !== null, name: project.name }
        : null,
      mission.riskLevel,
    );
    if (!gate.canPlan) throw new ForbiddenError(gate.notice ?? 'This mission cannot be planned.');

    const open = (await this.deps.clarifications.list(missionId)).filter(
      (record) => record.answeredAt === null,
    );
    if (open.length > 0) {
      throw new ConflictError('Answer the outstanding questions before Jarvis plans this.', {
        questions: open.map((record) => record.id),
      });
    }

    const workers = await this.deps.workers.list();
    const healthy = workers
      .map((worker) => deriveWorkerHealth(worker, this.clock()))
      .filter(
        (health) =>
          health.effectiveStatus === 'idle' ||
          health.effectiveStatus === 'busy' ||
          health.effectiveStatus === 'unhealthy',
      );

    if (healthy.some((health) => health.worker.runtimeAvailable)) {
      /* A worker can really inspect the repository; queue an inspection run for it. */
      const moved = await this.move(mission, 'inspecting', 'owner', {});
      await this.deps.events.record(missionId, {
        type: 'info',
        actor: 'system',
        summary: 'Queued for read-only inspection by a worker.',
      });
      return { mission: moved, plan: null };
    }

    return {
      mission: await this.generateDeterministicPlan(mission),
      plan: await this.deps.plans.latest(missionId),
    };
  }

  /** The fallback plan: honest about not having inspected anything. */
  private async generateDeterministicPlan(mission: Mission): Promise<Mission> {
    if (!mission.projectId) throw new ValidationError('This mission has no project yet.');
    const project = await this.deps.projects.findById(mission.projectId);
    if (!project) throw new NotFoundError('Project');

    const planning = await this.tryMove(mission, 'planning', 'owner', {});
    const sources = await this.deps.sources.listByProject(project.id);
    const evidence = await this.deps.evidence.list({ projectId: project.id, limit: 40 });
    const clarifications = await this.deps.clarifications.list(mission.id);

    const content = buildDeterministicPlan({
      mission: planning,
      project,
      sources,
      evidence,
      clarifications: clarifications
        .filter((record) => record.answer !== null)
        .map((record) => ({
          question: record.question,
          answer: record.answer ?? '',
          assumed: record.answerProvenance === 'inferred',
        })),
    });

    return this.storePlan(planning, content, 'jarvis_deterministic', 'inferred', null);
  }

  /**
   * Store a new plan version.
   *
   * An identical fingerprint is a no-op: an "edit" that changed nothing must not revoke an
   * approval, because that would let a stray click un-approve a queued mission.
   */
  async storePlan(
    mission: Mission,
    content: MissionPlanContent,
    author: MissionPlan['author'],
    provenance: MissionPlan['provenance'],
    runId: string | null,
  ): Promise<Mission> {
    const fingerprint = fingerprintPlan(content);
    const latest = await this.deps.plans.latest(mission.id);
    if (latest && latest.fingerprint === fingerprint) {
      return this.tryMove(mission, 'awaiting_plan_approval', 'system', {});
    }

    const version = await this.deps.plans.nextVersion(mission.id);
    await this.deps.plans.create({
      missionId: mission.id,
      version,
      content,
      author,
      provenance,
      riskLevel: mission.riskLevel,
      runId,
      fingerprint,
    });

    /* A new version invalidates any approval: this is the plan-version enforcement rule. */
    const revoked = await this.deps.approvals.revokeAll(
      mission.id,
      `Plan version ${version} replaced the approved version.`,
    );

    await this.deps.missions.patch(mission.id, {
      currentPlanVersion: version,
      ...(revoked > 0 ? { approvedPlanVersion: null } : {}),
    });

    await this.deps.events.record(mission.id, {
      type: author === 'owner_edit' ? 'plan_edited' : 'plan_submitted',
      actor:
        author === 'worker_inspection' ? 'worker' : author === 'owner_edit' ? 'owner' : 'system',
      level: 'notice',
      summary: `Plan version ${version} is ready for review.`,
      detail: { version, author, provenance, approvalRevoked: revoked > 0 },
    });
    if (revoked > 0) {
      await this.deps.events.record(mission.id, {
        type: 'approval_revoked',
        actor: 'system',
        level: 'warning',
        summary: 'The earlier approval no longer applies because the plan changed.',
      });
    }

    const current = await this.require(mission.id);
    return this.tryMove(current, 'awaiting_plan_approval', 'system', {});
  }

  async editPlan(missionId: string, content: MissionPlanContent): Promise<Mission> {
    const mission = await this.require(missionId);
    if (this.isLocked(mission.state) && mission.state !== 'paused') {
      throw new ConflictError('Stop the mission before editing its plan.');
    }
    return this.storePlan(mission, content, 'owner_edit', 'manual', null);
  }

  async requestRevision(missionId: string, instruction: string): Promise<Mission> {
    const mission = await this.require(missionId);
    await this.deps.approvals.revokeAll(missionId, 'Revision requested.');
    await this.deps.missions.patch(missionId, { approvedPlanVersion: null });
    await this.deps.events.record(missionId, {
      type: 'plan_revision_requested',
      actor: 'owner',
      level: 'notice',
      summary: 'You asked for a revised plan.',
      detail: { instruction: instruction.slice(0, 1000) },
    });
    return this.move(mission, 'planning', 'owner', {});
  }

  async rejectPlan(missionId: string, reason: string | null): Promise<Mission> {
    const mission = await this.require(missionId);
    await this.deps.approvals.revokeAll(missionId, 'Plan rejected.');
    await this.deps.missions.patch(missionId, { approvedPlanVersion: null });
    await this.deps.events.record(missionId, {
      type: 'plan_rejected',
      actor: 'owner',
      level: 'notice',
      summary: 'You rejected the plan.',
      detail: reason ? { reason: reason.slice(0, 1000) } : {},
    });
    return this.move(mission, 'draft', 'owner', {});
  }

  /* ---------------------------------------------------------------- approval */

  /**
   * Approve a plan version and queue the mission.
   *
   * Deliberately one operation. Approving and queueing separately would create a window in which
   * an approval exists but the mission is not runnable, and every guard would have to be checked
   * twice — once when approving, once when queueing — with the second check able to drift.
   */
  async approvePlan(
    missionId: string,
    input: PlanApprovalInput,
    approvedBy: string,
  ): Promise<Mission> {
    const mission = await this.require(missionId);
    if (mission.state !== 'awaiting_plan_approval') {
      throw new ConflictError(
        `Only a plan awaiting approval can be approved; this mission is ${MISSION_STATE_LABELS[mission.state].toLowerCase()}.`,
      );
    }

    const plan = await this.deps.plans.byVersion(missionId, input.planVersion);
    if (!plan) throw new NotFoundError('Plan version');
    if (plan.version !== mission.currentPlanVersion) {
      throw new ConflictError(
        `Version ${input.planVersion} is no longer the current plan (version ${mission.currentPlanVersion} is). Re-read it before approving.`,
      );
    }
    /* The owner must be acknowledging the risk they were actually shown. */
    if (input.acknowledgedRiskLevel !== mission.riskLevel) {
      throw new ConflictError(
        `The risk level changed to ${MISSION_RISK_LABELS[mission.riskLevel]} since this page was loaded. Re-read the plan before approving.`,
      );
    }

    const project = mission.projectId ? await this.deps.projects.findById(mission.projectId) : null;
    if (input.pausedProjectOverride && project) {
      await this.grantExecutionOverride(
        missionId,
        `Approved with a one-time override while ${project.name} is ${project.status}.`,
      );
    }

    const withOverride = await this.require(missionId);
    /*
     * The guard runs against the mission *as if already approved* — the approval row is written
     * just below — so its two approval checks are satisfied here rather than skipped.
     */
    const guard = canQueueMission({
      mission: { ...withOverride, approvedPlanVersion: plan.version },
      projectStatus: project?.status ?? null,
      projectArchived: project?.archivedAt !== null,
      planIsReviewOnly: planIsReviewOnly(plan.content, withOverride.riskLevel),
    });
    if (!guard.ok) {
      throw new ForbiddenError(guard.reason ?? 'This mission cannot run.');
    }

    await this.deps.approvals.revokeAll(missionId, 'Superseded by a newer approval.');
    await this.deps.approvals.create({
      missionId,
      planId: plan.id,
      planVersion: plan.version,
      approvedBy,
      approvedRiskLevel: withOverride.riskLevel,
      approvedScope: plan.content.scope,
      note: input.note ?? null,
    });

    await this.deps.missions.patch(missionId, { approvedPlanVersion: plan.version });
    await this.deps.events.record(missionId, {
      type: 'plan_approved',
      actor: 'owner',
      level: 'notice',
      summary: `You approved plan version ${plan.version}.`,
      detail: {
        planVersion: plan.version,
        approvedBy,
        riskLevel: withOverride.riskLevel,
        note: input.note ?? null,
      },
    });
    await this.deps.activity.record({
      projectId: mission.projectId,
      kind: 'decision_recorded',
      summary: `Approved mission plan: ${mission.title}`,
      detail: { missionId, planVersion: plan.version },
    });

    const approved = await this.require(missionId);
    return this.move(approved, 'queued', 'owner', {
      workingBranch:
        approved.workingBranch ??
        (isReadOnlyMissionType(approved.type)
          ? null
          : buildBranchName(approved.id, approved.title)),
    });
  }

  /* ---------------------------------------------------------------- controls */

  async pause(missionId: string, requestedBy: string, idempotencyKey?: string): Promise<Mission> {
    const mission = await this.require(missionId);
    if (mission.state === 'paused' || mission.state === 'pausing') return mission;
    await this.enqueueCommand(mission, 'pause', {}, requestedBy, idempotencyKey);
    return this.move(mission, 'pausing', 'owner', {});
  }

  async resume(missionId: string, requestedBy: string, idempotencyKey?: string): Promise<Mission> {
    const mission = await this.require(missionId);
    const run = mission.activeRunId ? await this.deps.runs.findById(mission.activeRunId) : null;
    const worker = mission.claimedByWorkerId
      ? await this.deps.workers.findById(mission.claimedByWorkerId)
      : null;
    const health = worker ? deriveWorkerHealth(worker, this.clock()) : null;

    const guard = canResumeMission({
      mission,
      workerConnected:
        health !== null &&
        health.effectiveStatus !== 'disconnected' &&
        health.effectiveStatus !== 'revoked',
      workspacePreserved: run?.workspacePreserved ?? false,
    });
    if (!guard.ok) throw new ConflictError(guard.reason ?? 'This mission cannot be resumed.');

    await this.enqueueCommand(mission, 'resume', {}, requestedBy, idempotencyKey);
    return this.move(mission, 'resuming', 'owner', {});
  }

  /**
   * Send an instruction to a running mission.
   *
   * A message that materially widens the approved scope does not get delivered as a nudge: the
   * mission pauses and the plan goes back for approval, which is the difference between "also
   * check the logging" and "also rewrite the payment flow".
   */
  async sendMessage(
    missionId: string,
    message: string,
    requestedBy: string,
    idempotencyKey?: string,
  ): Promise<{ mission: Mission; requiresReplan: boolean; reason: string | null }> {
    const mission = await this.require(missionId);
    if (containsSecret(message)) {
      throw new ValidationError(
        'That message looks like it contains a credential. Jarvis never needs one — describe what you want instead.',
      );
    }

    const plan = mission.currentPlanVersion
      ? await this.deps.plans.byVersion(missionId, mission.currentPlanVersion)
      : null;
    const assessment = assessScopeChange(message, plan?.content ?? null, mission);

    await this.deps.events.record(missionId, {
      type: 'owner_message',
      actor: 'owner',
      level: 'notice',
      summary: message.slice(0, 400),
      detail: { scopeChange: assessment.materiallyChangesScope, reason: assessment.reason },
    });

    if (assessment.materiallyChangesScope) {
      await this.enqueueCommand(
        mission,
        'pause',
        {},
        requestedBy,
        `scope-${idempotencyKey ?? randomUUID()}`,
      );
      await this.deps.approvals.revokeAll(
        missionId,
        'A message changed the scope, so the approval no longer applies.',
      );
      await this.deps.missions.patch(missionId, { approvedPlanVersion: null });
      await this.deps.events.record(missionId, {
        type: 'approval_revoked',
        actor: 'system',
        level: 'warning',
        summary:
          'That message changes the approved scope, so the mission is pausing for a revised plan.',
        detail: { reason: assessment.reason },
      });
      const paused = await this.tryMove(mission, 'pausing', 'owner', {});
      return { mission: paused, requiresReplan: true, reason: assessment.reason };
    }

    await this.enqueueCommand(mission, 'message', { message }, requestedBy, idempotencyKey);
    return { mission, requiresReplan: false, reason: null };
  }

  async stop(
    missionId: string,
    reason: string | null,
    requestedBy: string,
    idempotencyKey?: string,
  ): Promise<Mission> {
    const mission = await this.require(missionId);
    if (mission.state === 'stopped' || mission.state === 'stopping') return mission;

    await this.enqueueCommand(mission, 'stop', { reason }, requestedBy, idempotencyKey);
    await this.deps.events.record(missionId, {
      type: 'command_requested',
      actor: 'owner',
      level: 'warning',
      summary: 'You asked Jarvis to stop this mission. Its work is preserved.',
      detail: reason ? { reason: reason.slice(0, 500) } : {},
    });

    /*
     * The mission is only *stopping* here. It reaches `stopped` when the worker confirms it
     * terminated, or when `reconcileLostWorkers` finds the worker gone — never optimistically.
     */
    const stopping = await this.move(mission, 'stopping', 'owner', {
      cancellationReason: reason,
    });

    const worker = mission.claimedByWorkerId
      ? await this.deps.workers.findById(mission.claimedByWorkerId)
      : null;
    if (!worker || deriveWorkerHealth(worker, this.clock()).effectiveStatus === 'disconnected') {
      return this.confirmStopped(
        stopping,
        'The worker was not reachable, so Jarvis recorded the mission as stopped. Its workspace and branch are untouched.',
      );
    }
    return stopping;
  }

  async confirmStopped(mission: Mission, summary: string): Promise<Mission> {
    const now = this.clock();
    if (mission.activeRunId) {
      await this.deps.runs.patch(mission.activeRunId, {
        state: 'stopped',
        finishedAt: now,
        workspacePreserved: true,
      });
      await this.deps.permissions.cancelForRun(mission.activeRunId);
    }
    await this.deps.events.record(mission.id, {
      type: 'run_finished',
      actor: 'system',
      level: 'warning',
      summary,
    });
    return this.move(mission, 'stopped', 'system', {
      activeRunId: null,
      finishedAt: now,
      lastActivityAt: now,
    });
  }

  async cancel(missionId: string, reason: string | null): Promise<Mission> {
    const mission = await this.require(missionId);
    await this.deps.events.record(missionId, {
      type: 'state_changed',
      actor: 'owner',
      summary: 'You cancelled this mission.',
      detail: reason ? { reason: reason.slice(0, 500) } : {},
    });
    return this.move(mission, 'cancelled', 'owner', {
      cancellationReason: reason,
      finishedAt: this.clock(),
    });
  }

  /**
   * Start a new attempt.
   *
   * Manual only in this phase, and never automatic for a policy or authorization failure: a
   * mission that was refused does not become allowed by being tried again.
   */
  async retry(missionId: string): Promise<Mission> {
    const mission = await this.require(missionId);
    if (mission.state !== 'failed' && mission.state !== 'stopped') {
      throw new ConflictError('Only a failed or stopped mission can be retried.');
    }
    if (mission.failureCode === 'policy_violation' || mission.failureCode === 'github_auth_error') {
      throw new ForbiddenError(
        'This mission failed for a policy or authorization reason. Fix the cause and approve a revised plan rather than retrying.',
      );
    }
    if (mission.approvedPlanVersion !== mission.currentPlanVersion) {
      await this.deps.events.record(missionId, {
        type: 'info',
        actor: 'system',
        summary: 'The plan changed since the last attempt, so it needs approving again.',
      });
      return this.move(mission, 'awaiting_plan_approval', 'owner', {});
    }

    await this.deps.events.record(missionId, {
      type: 'info',
      actor: 'owner',
      level: 'notice',
      summary: `Retrying as attempt ${mission.attemptCount + 1}. The previous attempt is preserved.`,
    });
    return this.move(mission, 'queued', 'owner', {
      activeRunId: null,
      claimedByWorkerId: null,
      failureCode: null,
      failureMessage: null,
      finishedAt: null,
    });
  }

  /* ------------------------------------------------- permission requests */

  async decidePermission(
    requestId: string,
    input: PermissionDecisionInput,
    decidedBy: string,
  ): Promise<MissionPermissionRequest> {
    const request = await this.deps.permissions.findById(requestId);
    if (!request) throw new NotFoundError('Permission request');
    if (input.answer && containsSecret(input.answer)) {
      throw new ValidationError(
        'That response looks like it contains a credential. Jarvis never needs one pasted here.',
      );
    }

    const decided = await this.deps.permissions.decide(requestId, {
      state: input.decision === 'deny' ? 'denied' : 'approved',
      decidedBy,
      note: input.note ?? null,
      answer: input.answer ?? null,
    });

    const mission = await this.require(request.missionId);
    await this.enqueueCommand(
      mission,
      input.decision === 'answer' ? 'answer' : 'permission_response',
      {
        /* The decision is bound to this exact request key, never to a tool or a category. */
        requestKey: request.requestKey,
        requestId: request.id,
        decision: input.decision,
        answer: input.answer ?? null,
      },
      decidedBy,
      `perm-${request.id}`,
    );
    await this.deps.events.record(request.missionId, {
      type: 'permission_resolved',
      actor: 'owner',
      level: 'notice',
      summary:
        input.decision === 'deny'
          ? `You denied: ${request.requestedAction}`
          : `You approved: ${request.requestedAction}`,
      detail: { requestKey: request.requestKey, decision: input.decision },
    });

    if (mission.state === 'waiting_for_permission' || mission.state === 'waiting_for_input') {
      await this.tryMove(mission, 'running', 'owner', {});
    }
    return decided;
  }

  /* -------------------------------------------------------------- artifacts */

  async addArtifact(
    missionId: string,
    input: ArtifactInput,
    createdBy: MissionEvent['actor'],
    runId: string | null,
  ): Promise<MissionArtifact> {
    const mission = await this.require(missionId);
    const artifact = await this.deps.artifacts.create(
      missionId,
      mission.projectId,
      runId,
      input,
      createdBy,
    );
    await this.deps.events.record(missionId, {
      type: 'artifact_created',
      actor: createdBy,
      level: 'notice',
      summary: `Report ready: ${artifact.title}`,
      detail: { artifactId: artifact.id, kind: artifact.kind, sizeBytes: artifact.sizeBytes },
    });
    return artifact;
  }

  /* ------------------------------------------------------------------ views */

  async detail(missionId: string): Promise<MissionDetail> {
    const mission = await this.require(missionId);
    const [
      plans,
      approval,
      clarifications,
      runs,
      events,
      permissionRequests,
      verifications,
      artifacts,
      commands,
    ] = await Promise.all([
      this.deps.plans.list(missionId),
      this.deps.approvals.activeFor(missionId),
      this.deps.clarifications.list(missionId),
      this.deps.runs.list(missionId),
      this.deps.events.list(missionId, { limit: 400 }),
      this.deps.permissions.list(missionId),
      this.deps.verifications.list(missionId),
      this.deps.artifacts.list(missionId),
      this.deps.commands.list(missionId),
    ]);

    const project = mission.projectId ? await this.deps.projects.findById(mission.projectId) : null;
    const worker = mission.claimedByWorkerId
      ? await this.deps.workers.findById(mission.claimedByWorkerId)
      : null;
    const workerHealth = worker ? deriveWorkerHealth(worker, this.clock()) : null;
    const activeRun = mission.activeRunId
      ? (runs.find((run) => run.id === mission.activeRunId) ?? null)
      : null;
    const currentPlan =
      plans.find((plan) => plan.version === mission.currentPlanVersion) ?? plans[0] ?? null;

    const guard = canQueueMission({
      mission,
      projectStatus: project?.status ?? null,
      projectArchived: project?.archivedAt !== null,
      planIsReviewOnly: currentPlan
        ? planIsReviewOnly(currentPlan.content, mission.riskLevel)
        : false,
    });

    return {
      mission,
      project: project ? { id: project.id, name: project.name } : null,
      plans,
      currentPlan,
      approval,
      clarifications,
      runs,
      activeRun,
      events,
      permissionRequests,
      verifications,
      artifacts,
      commands,
      worker: workerHealth,
      canQueue: { ok: guard.ok, reason: guard.reason },
      stalled: this.isStalled(mission, workerHealth),
    };
  }

  async list(filter: MissionListFilter = {}): Promise<{
    items: readonly MissionSummary[];
    total: number;
  }> {
    const page = await this.deps.missions.list(filter);
    const ids = page.items.map((mission) => mission.id);
    const [permissionCounts, clarificationCounts, workers, projectsPage] = await Promise.all([
      this.deps.permissions.openCount(ids),
      this.deps.clarifications.openCount(ids),
      this.deps.workers.list(),
      this.deps.projects.list({ includeArchived: true, limit: 500 }),
    ]);
    const projectNames = new Map(projectsPage.items.map((p) => [p.id, p.shortName ?? p.name]));
    const workerNames = new Map(workers.map((worker) => [worker.id, worker.name]));

    return {
      total: page.total,
      items: page.items.map((mission) => ({
        mission,
        projectName: mission.projectId ? (projectNames.get(mission.projectId) ?? null) : null,
        workerName: mission.claimedByWorkerId
          ? (workerNames.get(mission.claimedByWorkerId) ?? null)
          : null,
        openPermissionRequests: permissionCounts.get(mission.id) ?? 0,
        openClarifications: clarificationCounts.get(mission.id) ?? 0,
        planVersion: mission.currentPlanVersion,
        planApproved:
          mission.approvedPlanVersion !== null &&
          mission.approvedPlanVersion === mission.currentPlanVersion,
      })),
    };
  }

  async workerHealth(): Promise<readonly WorkerHealth[]> {
    const workers = await this.deps.workers.list();
    const now = this.clock();
    return workers.map((worker) => deriveWorkerHealth(worker, now));
  }

  /**
   * Notice a mission whose worker has gone silent.
   *
   * Deliberately does *not* change the mission's state. A crash must never produce a false
   * `completed`, and it must not produce a false `failed` either — the work on disk may be fine.
   * The mission stays where it is and the UI says so.
   */
  isStalled(mission: Mission, worker: WorkerHealth | null): boolean {
    if (!isActiveState(mission.state)) return false;
    if (!worker) return true;
    return worker.effectiveStatus === 'disconnected' || worker.effectiveStatus === 'revoked';
  }

  async listStalled(): Promise<readonly Mission[]> {
    const active = await this.deps.missions.listActive();
    if (active.length === 0) return [];
    const workers = await this.deps.workers.list();
    const now = this.clock();
    const health = new Map(
      workers.map((worker) => [worker.id, deriveWorkerHealth(worker, now)] as const),
    );
    return active.filter((mission) =>
      this.isStalled(
        mission,
        mission.claimedByWorkerId ? (health.get(mission.claimedByWorkerId) ?? null) : null,
      ),
    );
  }

  /** Has the repository moved since the approved plan was written? */
  async validateApprovedPlan(
    mission: Mission,
    current: {
      defaultBranch: string | null;
      headSha: string | null;
      repositoryFullName: string | null;
    },
  ): Promise<readonly string[]> {
    if (!mission.approvedPlanVersion) return ['No approved plan.'];
    const plan = await this.deps.plans.byVersion(mission.id, mission.approvedPlanVersion);
    if (!plan) return ['The approved plan version no longer exists.'];
    return planFactsChanged(plan.content, current);
  }

  /* --------------------------------------------------------------- internals */

  async require(missionId: string): Promise<Mission> {
    const mission = await this.deps.missions.findById(missionId);
    if (!mission) throw new NotFoundError('Mission');
    return mission;
  }

  /** The only path to a state change. Validates the transition, then records it. */
  async move(
    mission: Mission,
    to: MissionState,
    actor: MissionActor,
    patch: Parameters<MissionRepository['transition']>[2],
  ): Promise<Mission> {
    const transition = assertTransition(mission.state, to, actor);
    if (!transition) return mission;

    const updated = await this.deps.missions.transition(mission.id, to, patch, mission.state);
    if (!updated) {
      throw new ConflictError(
        'This mission changed while you were looking at it. Reload and try again.',
        { expected: mission.state, wanted: to },
      );
    }
    await this.deps.events.record(mission.id, {
      type: 'state_changed',
      actor,
      level: to === 'failed' ? 'error' : 'info',
      summary: `${MISSION_STATE_LABELS[mission.state]} → ${MISSION_STATE_LABELS[to]}: ${transition.summary}`,
      detail: { from: mission.state, to, actor },
    });
    return updated;
  }

  /** `move`, but a disallowed transition is simply not made rather than thrown. */
  async tryMove(
    mission: Mission,
    to: MissionState,
    actor: MissionActor,
    patch: Parameters<MissionRepository['transition']>[2],
  ): Promise<Mission> {
    try {
      return await this.move(mission, to, actor, patch);
    } catch {
      return mission;
    }
  }

  private async enqueueCommand(
    mission: Mission,
    kind: CommandKind,
    payload: Record<string, unknown>,
    requestedBy: string,
    idempotencyKey?: string,
  ): Promise<MissionCommand> {
    const { command, created } = await this.deps.commands.create({
      missionId: mission.id,
      runId: mission.activeRunId,
      kind,
      payload,
      requestedBy,
      idempotencyKey: idempotencyKey ?? randomUUID(),
    });
    if (created) {
      await this.deps.events.record(mission.id, {
        type: 'command_requested',
        actor: 'owner',
        summary: `${kind} requested.`,
        detail: { commandId: command.id, kind },
      });
    }
    return command;
  }

  private async projectNotice(mission: Mission): Promise<string | null> {
    if (!mission.projectId) return 'Choose a project before Jarvis plans this.';
    const project = await this.deps.projects.findById(mission.projectId);
    if (!project) return 'That project no longer exists.';
    return assessProjectGate(
      { status: project.status, archived: project.archivedAt !== null, name: project.name },
      mission.riskLevel,
    ).notice;
  }

  private isLocked(state: MissionState): boolean {
    return isActiveState(state);
  }
}

function isActiveState(state: MissionState): boolean {
  return (
    state === 'claimed' ||
    state === 'preparing_workspace' ||
    state === 'running' ||
    state === 'waiting_for_permission' ||
    state === 'waiting_for_input' ||
    state === 'pausing' ||
    state === 'resuming' ||
    state === 'verifying' ||
    state === 'creating_pull_request'
  );
}

/* -------------------------------------------------------------- scope change */

/** Words too common to identify anything, in either direction. */
const GENERIC_SCOPE_WORDS = new Set([
  'changing',
  'change',
  'changes',
  'adding',
  'removing',
  'deleting',
  'updating',
  'editing',
  'modifying',
  'creating',
  'writing',
  'making',
  'merging',
  'anything',
  'nothing',
  'something',
  'everything',
  'request',
  'requests',
  'should',
  'anywhere',
]);

export interface ScopeAssessment {
  readonly materiallyChangesScope: boolean;
  readonly reason: string | null;
}

/**
 * Does an owner message widen the approved scope?
 *
 * Conservative in the direction that costs least: an ordinary clarification flows straight
 * through to the agent, while anything that reads like new work, a new risk area, or an explicit
 * override pauses for a revised plan. Getting this wrong in the cautious direction costs one
 * extra approval click; getting it wrong the other way means unapproved work happened.
 */
export function assessScopeChange(
  message: string,
  plan: MissionPlanContent | null,
  mission: Pick<Mission, 'doNotTouch'>,
): ScopeAssessment {
  const text = message.toLowerCase();

  const newWork =
    /\b(?:also|additionally|while you(?:'re| are) (?:there|at it)|as well|on top of that|and then)\b.*\b(?:add|implement|build|create|write|fix|refactor|change|update|remove|delete|migrate|upgrade)\b/;
  if (newWork.test(text)) {
    return {
      materiallyChangesScope: true,
      reason: 'It asks for work the approved plan does not cover.',
    };
  }

  const overrideAttempt =
    /\b(?:ignore|forget|disregard|override|skip)\s+(?:the\s+)?(?:plan|scope|constraints?|instructions?|rules?)\b/;
  if (overrideAttempt.test(text)) {
    return {
      materiallyChangesScope: true,
      reason: 'It asks Jarvis to set aside the approved plan.',
    };
  }

  for (const area of mission.doNotTouch) {
    if (area.trim().length >= 3 && text.includes(area.trim().toLowerCase())) {
      return {
        materiallyChangesScope: true,
        reason: `It touches "${area}", which you marked as off limits.`,
      };
    }
  }

  /*
   * Out-of-scope items are matched on their *distinctive* nouns. Taking the first long word
   * would compare against the leading verb ("Changing…", "Deploying…"), which every out-of-scope
   * line starts with and no owner message ever contains; the generic words below are skipped for
   * the opposite reason — "anything" would match half the messages ever sent.
   */
  const outOfScope = plan?.outOfScope ?? [];
  for (const item of outOfScope) {
    const keywords = item
      .toLowerCase()
      .replace(/[^a-z0-9 ]/g, ' ')
      .split(/\s+/)
      .filter((word) => word.length > 5 && !GENERIC_SCOPE_WORDS.has(word));
    const hit = keywords.find((keyword) => text.includes(keyword));
    if (hit) {
      return {
        materiallyChangesScope: true,
        reason: `It asks about "${item}", which the plan lists as out of scope.`,
      };
    }
  }

  return { materiallyChangesScope: false, reason: null };
}
