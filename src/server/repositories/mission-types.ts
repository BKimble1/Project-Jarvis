import type {
  ClarificationQuestion,
  ClarificationRecord,
  Mission,
  MissionFailureCode,
  MissionState,
  MissionType,
} from '@/domain/mission';
import type { MissionApproval, MissionPlan, MissionPlanContent } from '@/domain/mission-plan';
import type {
  ArtifactInput,
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
  RunKind,
  RunState,
  RunUsage,
  VerificationInput,
} from '@/domain/mission-run';
import type { JarvisWorker } from '@/domain/worker';
import type { MissionDraftInput, MissionUpdateInput } from '@/domain/mission';
import type { PlanAuthor } from '@/domain/mission-plan';
import type { MissionRiskLevel } from '@/domain/mission';
import type { ProvenanceLevel } from '@/domain/enums';

/** Persistence boundary for Mission Control. */

/**
 * An event Jarvis records about itself.
 *
 * Unlike a worker's event this carries no sequence — nothing needs to de-duplicate it — and its
 * level and detail are optional because most control-plane notes are plain information.
 */
export interface ControlPlaneEventInput {
  readonly type: MissionEventInput['type'];
  readonly summary: string;
  readonly actor?: MissionEventInput['actor'];
  readonly level?: MissionEventInput['level'];
  readonly detail?: Record<string, unknown>;
  readonly seq?: number;
}

export interface MissionListFilter {
  readonly states?: readonly MissionState[];
  readonly projectId?: string;
  readonly types?: readonly MissionType[];
  readonly search?: string;
  readonly needsOwner?: boolean;
  readonly limit?: number;
  readonly offset?: number;
}

export interface MissionListPage {
  readonly items: readonly Mission[];
  readonly total: number;
}

export interface MissionCreateInput extends MissionDraftInput {
  readonly title: string;
  readonly type: MissionType;
  readonly riskLevel: MissionRiskLevel;
  readonly riskRuleIds: readonly string[];
  readonly riskReasons: readonly string[];
  readonly ownerLogin: string | null;
  readonly state: MissionState;
}

/** Fields the service may set alongside a state change. Never settable from a raw request body. */
export interface MissionStatePatch {
  readonly activeRunId?: string | null;
  readonly claimedByWorkerId?: string | null;
  readonly currentPlanVersion?: number | null;
  readonly approvedPlanVersion?: number | null;
  readonly workingBranch?: string | null;
  readonly baseBranch?: string | null;
  readonly baseSha?: string | null;
  readonly pullRequestUrl?: string | null;
  readonly pullRequestNumber?: number | null;
  readonly completionSummary?: string | null;
  readonly failureCode?: MissionFailureCode | null;
  readonly failureMessage?: string | null;
  readonly cancellationReason?: string | null;
  readonly startedAt?: Date | null;
  readonly finishedAt?: Date | null;
  readonly lastActivityAt?: Date | null;
  readonly attemptCount?: number;
  readonly executionOverrideAt?: Date | null;
  readonly executionOverrideReason?: string | null;
  readonly riskLevel?: MissionRiskLevel;
  readonly riskRuleIds?: readonly string[];
  readonly riskReasons?: readonly string[];
  /* Prompt 3. */
  readonly currentGraphVersion?: number | null;
  readonly approvedGraphVersion?: number | null;
  readonly playbookKey?: string | null;
  readonly playbookVersion?: number | null;
  readonly integrationBranch?: string | null;
  readonly repairRoundsUsed?: number;
  readonly receiptId?: string | null;
  /* V2: which authority queued it. Written only by the approval path. */
  readonly autonomous?: boolean;
  readonly charterVersionId?: string | null;
  readonly authorizationDecisionId?: string | null;
}

export interface ClaimRequest {
  readonly workerId: string;
  readonly kinds: readonly RunKind[];
  readonly concurrencyLimit: number;
  readonly now: Date;
  /**
   * Mission types that may be handed out when nobody approved them.
   *
   * Computed by `unattendedMissionTypes(level)` from the qualification rung in force at the moment
   * of the claim. Missions a person approved ignore it entirely; an empty list means no autonomous
   * mission is claimable at all, which is the correct behaviour on an unqualified deployment.
   */
  readonly unattendedMissionTypes: readonly MissionType[];
}

export interface ClaimResult {
  readonly mission: Mission;
  readonly run: MissionRun;
}

export interface MissionRepository {
  create(input: MissionCreateInput): Promise<Mission>;
  update(id: string, input: MissionUpdateInput): Promise<Mission>;
  findById(id: string): Promise<Mission | null>;
  list(filter?: MissionListFilter): Promise<MissionListPage>;
  listByProject(projectId: string, limit?: number): Promise<readonly Mission[]>;
  listActive(): Promise<readonly Mission[]>;
  /** Every mission that is not finished. Used by the Status Brain and the "needs me" page. */
  listOpen(): Promise<readonly Mission[]>;
  countActive(): Promise<number>;
  remove(id: string): Promise<void>;

  /**
   * Apply a state change plus its side fields in one statement.
   *
   * `expectedState` makes it a compare-and-set: a caller working from a stale read cannot
   * overwrite a change someone else already made.
   */
  transition(
    id: string,
    to: MissionState,
    patch: MissionStatePatch,
    expectedState?: MissionState,
  ): Promise<Mission | null>;

  patch(id: string, patch: MissionStatePatch): Promise<Mission>;

  /**
   * Atomically move one queued mission to `claimed`.
   *
   * The concurrency limit is part of the same statement, so two workers racing cannot both find
   * "zero active missions" and both start one.
   */
  claimNext(request: ClaimRequest): Promise<ClaimResult | null>;
}

export interface PlanRepository {
  create(input: {
    missionId: string;
    version: number;
    content: MissionPlanContent;
    author: PlanAuthor;
    provenance: ProvenanceLevel;
    riskLevel: MissionRiskLevel;
    runId?: string | null;
    fingerprint: string;
  }): Promise<MissionPlan>;
  latest(missionId: string): Promise<MissionPlan | null>;
  byVersion(missionId: string, version: number): Promise<MissionPlan | null>;
  list(missionId: string): Promise<readonly MissionPlan[]>;
  nextVersion(missionId: string): Promise<number>;
}

export interface ApprovalRepository {
  create(input: {
    missionId: string;
    planId: string;
    planVersion: number;
    approvedBy: string;
    approvedRiskLevel: MissionRiskLevel;
    approvedScope: readonly string[];
    note?: string | null;
    /* V2: present only when standing authority approved, absent when a person did. */
    charterVersionId?: string | null;
    charterDigest?: string | null;
    authorizationDecisionId?: string | null;
  }): Promise<MissionApproval>;
  activeFor(missionId: string): Promise<MissionApproval | null>;
  revokeAll(missionId: string, reason: string): Promise<number>;
  list(missionId: string): Promise<readonly MissionApproval[]>;
}

export interface ClarificationRepository {
  replaceOpen(missionId: string, questions: readonly ClarificationQuestion[]): Promise<void>;
  list(missionId: string): Promise<readonly ClarificationRecord[]>;
  answer(
    missionId: string,
    questionId: string,
    answer: string,
    provenance: ProvenanceLevel,
  ): Promise<ClarificationRecord | null>;
  openCount(missionIds: readonly string[]): Promise<ReadonlyMap<string, number>>;
}

export interface RunRepository {
  start(input: {
    missionId: string;
    workerId: string;
    attempt: number;
    kind: RunKind;
    planVersion: number | null;
    startedAt?: Date;
  }): Promise<MissionRun>;
  findById(id: string): Promise<MissionRun | null>;
  list(missionId: string): Promise<readonly MissionRun[]>;
  latest(missionId: string): Promise<MissionRun | null>;
  patch(
    id: string,
    patch: Partial<{
      state: RunState;
      currentAction: string | null;
      agentSessionId: string | null;
      runtimeName: string | null;
      runtimeVersion: string | null;
      workspacePath: string | null;
      baseBranch: string | null;
      baseSha: string | null;
      branchName: string | null;
      headSha: string | null;
      pullRequestUrl: string | null;
      pullRequestNumber: number | null;
      filesChanged: readonly string[];
      usage: RunUsage | null;
      failureCode: MissionFailureCode | null;
      failureMessage: string | null;
      workspacePreserved: boolean;
      finishedAt: Date | null;
      lastEventAt: Date | null;
    }>,
  ): Promise<MissionRun>;
  nextAttempt(missionId: string): Promise<number>;
}

export interface EventRepository {
  /** Idempotent: a `(runId, seq)` already stored is skipped rather than duplicated. */
  append(
    missionId: string,
    runId: string | null,
    inputs: readonly MissionEventInput[],
  ): Promise<readonly MissionEvent[]>;
  /** Convenience for control-plane events, which have no run and need no sequence of their own. */
  record(missionId: string, input: ControlPlaneEventInput): Promise<MissionEvent>;
  list(
    missionId: string,
    options?: { afterSeq?: number; limit?: number },
  ): Promise<readonly MissionEvent[]>;
  listForRun(runId: string, afterSeq?: number, limit?: number): Promise<readonly MissionEvent[]>;
  latestSeq(runId: string): Promise<number>;
}

export interface CommandRepository {
  create(input: {
    missionId: string;
    runId: string | null;
    kind: CommandKind;
    payload: Record<string, unknown>;
    requestedBy: string;
    idempotencyKey: string;
  }): Promise<{ command: MissionCommand; created: boolean }>;
  pendingFor(missionId: string): Promise<readonly MissionCommand[]>;
  list(missionId: string, limit?: number): Promise<readonly MissionCommand[]>;
  markDelivered(ids: readonly string[], at: Date): Promise<void>;
  setState(
    id: string,
    state: CommandState,
    failureMessage?: string | null,
  ): Promise<MissionCommand>;
  supersedePending(missionId: string, kinds: readonly CommandKind[]): Promise<number>;
}

export interface PermissionRepository {
  create(
    missionId: string,
    runId: string,
    input: PermissionRequestInput,
  ): Promise<MissionPermissionRequest>;
  findById(id: string): Promise<MissionPermissionRequest | null>;
  listOpen(missionId?: string): Promise<readonly MissionPermissionRequest[]>;
  list(missionId: string): Promise<readonly MissionPermissionRequest[]>;
  decide(
    id: string,
    decision: {
      state: 'approved' | 'denied';
      decidedBy: string;
      note?: string | null;
      answer?: string | null;
    },
  ): Promise<MissionPermissionRequest>;
  cancelForRun(runId: string): Promise<number>;
  openCount(missionIds: readonly string[]): Promise<ReadonlyMap<string, number>>;
}

export interface VerificationRepository {
  record(missionId: string, runId: string, input: VerificationInput): Promise<MissionVerification>;
  list(missionId: string): Promise<readonly MissionVerification[]>;
  listForRun(runId: string): Promise<readonly MissionVerification[]>;
}

export interface ArtifactRepository {
  create(
    missionId: string,
    projectId: string | null,
    runId: string | null,
    input: ArtifactInput,
    createdBy: MissionEvent['actor'],
  ): Promise<MissionArtifact>;
  findById(id: string): Promise<MissionArtifact | null>;
  list(missionId: string): Promise<readonly MissionArtifact[]>;
  listByProject(projectId: string, limit?: number): Promise<readonly MissionArtifact[]>;
}

export interface WorkerRepository {
  enrol(input: {
    /** Generated by the caller, because the id is part of the token whose hash this row stores. */
    id: string;
    name: string;
    tokenHash: string;
    tokenPrefix: string;
    maxConcurrency: number;
  }): Promise<JarvisWorker>;
  rotate(id: string, tokenHash: string, tokenPrefix: string): Promise<JarvisWorker>;
  revoke(id: string, reason: string): Promise<JarvisWorker>;
  findById(id: string): Promise<JarvisWorker | null>;
  /** Returns the row *including* its hash, for authentication only. Never leaves the auth module. */
  findAuthRecord(
    id: string,
  ): Promise<{ id: string; tokenHash: string; revokedAt: Date | null } | null>;
  list(): Promise<readonly JarvisWorker[]>;
  heartbeat(
    id: string,
    input: {
      status: JarvisWorker['status'];
      version: string | null;
      platform: string | null;
      runtimeAvailable: boolean;
      runtimeName: string | null;
      runtimeDetail: string | null;
      workspaceHealthy: boolean;
      workspaceRootLabel: string | null;
      githubDeliveryConfigured: boolean;
      diagnostics: readonly string[];
      currentMissionId: string | null;
      currentRunId: string | null;
      lastActivityAt: Date | null;
      at: Date;
    },
  ): Promise<JarvisWorker>;
  remove(id: string): Promise<void>;
}

export interface IdempotencyRecord {
  readonly status: number;
  readonly body: Record<string, unknown>;
  readonly requestHash: string;
}

export interface IdempotencyRepository {
  find(workerId: string, key: string): Promise<IdempotencyRecord | null>;
  save(input: {
    workerId: string;
    key: string;
    endpoint: string;
    requestHash: string;
    status: number;
    body: Record<string, unknown>;
    expiresAt: Date;
  }): Promise<void>;
  purgeExpired(now: Date): Promise<number>;
}
