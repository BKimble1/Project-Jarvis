import type { AgentRole } from '@/domain/agent-role';
import type { CompletionReceipt, CompletionReceiptContent } from '@/domain/completion-receipt';
import type {
  CiDispatch,
  CiDispatchPurpose,
  CiDispatchState,
  ReleaseApproval,
  ReleaseApprovalState,
} from '@/domain/ci-dispatch';
import type { DisplayDevice, DisplayScope } from '@/domain/display-device';
import type { AppProfile, AppProfileInput } from '@/domain/app-profile';
import type {
  MissionReview,
  ReviewFinding,
  ReviewFindingInput,
  ReviewVerdict,
  FindingState,
} from '@/domain/mission-review';
import type {
  MissionTask,
  TaskFailureCode,
  TaskState,
  TaskType,
  TaskUsage,
} from '@/domain/mission-task';
import type { Playbook, PlaybookDefinition, PlaybookVersion } from '@/domain/playbook';
import type { MissionTaskGraph, TaskGraphState } from '@/domain/task-graph';
import type { VerificationOutcome } from '@/domain/mission-run';

/**
 * The persistence boundary for everything Prompt 3 adds.
 *
 * Kept separate from `mission-types.ts` for one reason that matters: the Prompt 2 repository
 * interfaces are load-bearing and heavily tested, and a phase that grows them by forty methods
 * makes every one of those tests harder to read. These are new interfaces over new tables.
 */

/* ---------------------------------------------------------------- the graph */

export interface TaskGraphCreateInput {
  readonly missionId: string;
  readonly version: number;
  readonly planVersion: number;
  readonly summary: string;
  readonly notes: readonly string[];
  readonly fingerprint: string;
  readonly playbookKey?: string | null;
  readonly playbookVersion?: number | null;
  readonly maxParallelTasks: number;
  readonly maxWriteTasks: number;
  readonly maxRepairRounds: number;
  readonly proposedBy: MissionTaskGraph['proposedBy'];
}

export interface TaskCreateInput {
  readonly missionId: string;
  readonly graphId: string;
  readonly graphVersion: number;
  readonly planVersion: number;
  readonly key: string;
  readonly title: string;
  readonly description: string;
  readonly role: AgentRole;
  readonly permissionProfileId: string;
  readonly taskType: MissionTask['taskType'];
  readonly position: number;
  readonly expectedInputs: readonly string[];
  readonly expectedOutputs: readonly string[];
  readonly acceptanceCriteria: readonly string[];
  readonly workspaceRequirement: MissionTask['workspaceRequirement'];
  readonly requiresRepository: boolean;
  readonly expectedFileAreas: readonly string[];
  readonly declaredWriteSet: readonly string[];
  readonly maxAttempts: number;
  readonly maxTurns: number | null;
  readonly timeLimitMs: number | null;
  readonly maxOutputTokens: number | null;
  readonly repairRound: number;
  readonly reviewsTaskKey: string | null;
}

/** Everything a task row can be patched with. Drizzle property names, never column names. */
export interface TaskPatch {
  readonly state?: TaskState;
  readonly assignedWorkerId?: string | null;
  readonly activeRunId?: string | null;
  readonly attempt?: number;
  readonly branchName?: string | null;
  readonly baseSha?: string | null;
  readonly headSha?: string | null;
  readonly workspacePath?: string | null;
  readonly workspacePreserved?: boolean;
  readonly actualChangedFiles?: readonly string[];
  /*
   * `declaredWriteSet` is deliberately absent.
   *
   * It is set once, when the task is created from an approved graph, and it is the thing every
   * scope check compares against — the tool boundary, the task's own diff, and the union the
   * integrator is given. A patch field for it is a way for a later caller to widen a scope after
   * the work has been approved, which is the one change that would make all three checks agree
   * with each other and with nothing the owner said.
   */
  readonly failureCode?: TaskFailureCode | null;
  readonly failureMessage?: string | null;
  readonly summary?: string | null;
  readonly latestReviewId?: string | null;
  readonly reviewsTaskId?: string | null;
  readonly usage?: Partial<TaskUsage>;
  readonly startedAt?: Date | null;
  readonly finishedAt?: Date | null;
  readonly lastActivityAt?: Date | null;
}

export interface TaskClaimRequest {
  readonly workerId: string;
  readonly now: Date;
  /** Roles this worker is willing to take. A worker with no model takes only deterministic ones. */
  readonly roles: readonly AgentRole[];
  readonly limits: {
    readonly maxActiveRuns: number;
    readonly maxRunsPerMission: number;
    readonly maxParallelWriters: number;
    readonly maxParallelReadOnly: number;
    readonly maxActiveMissions: number;
  };
  /** False while the instance is draining or stopped: nothing new may be claimed. */
  readonly accepting: boolean;
  /**
   * Roles and task types claimable on a mission nobody approved.
   *
   * Two lists rather than one because the gate has two axes — what the role may do, and where the
   * task's result goes — and the claim query can only filter on columns. Both are the *loose*
   * form of the gate: a task passing both filters is still asserted exactly, by role and type
   * together, once it has been claimed.
   */
  readonly unattendedRoles: readonly AgentRole[];
  readonly unattendedTaskTypes: readonly TaskType[];
}

export interface TaskClaimResult {
  readonly task: MissionTask;
  readonly runId: string;
}

export interface TaskGraphRepository {
  create(input: TaskGraphCreateInput): Promise<MissionTaskGraph>;
  findById(id: string): Promise<MissionTaskGraph | null>;
  latest(missionId: string): Promise<MissionTaskGraph | null>;
  byVersion(missionId: string, version: number): Promise<MissionTaskGraph | null>;
  list(missionId: string): Promise<readonly MissionTaskGraph[]>;
  nextVersion(missionId: string): Promise<number>;
  setState(
    id: string,
    state: TaskGraphState,
    patch?: {
      approvedAt?: Date | null;
      approvedBy?: string | null;
      revokedAt?: Date | null;
      revokedReason?: string | null;
      maxParallelTasks?: number;
    },
  ): Promise<MissionTaskGraph>;
  /** Revoke every graph for a mission except the one named. Used when a new version supersedes. */
  revokeOthers(missionId: string, keepId: string, reason: string): Promise<number>;
}

export interface TaskRepository {
  createMany(inputs: readonly TaskCreateInput[]): Promise<readonly MissionTask[]>;
  setDependencies(
    graphId: string,
    edges: readonly { taskId: string; dependsOnTaskId: string }[],
  ): Promise<void>;
  findById(id: string): Promise<MissionTask | null>;
  listByGraph(graphId: string): Promise<readonly MissionTask[]>;
  listByMission(missionId: string): Promise<readonly MissionTask[]>;
  listActive(): Promise<readonly MissionTask[]>;
  patch(id: string, patch: TaskPatch): Promise<MissionTask>;
  /**
   * Compare-and-set on state, exactly like `MissionRepository.transition`.
   *
   * A stale caller gets `null`, which the service turns into a conflict rather than a silent
   * overwrite. Two workers racing to move the same task therefore cannot both win.
   */
  transition(
    id: string,
    to: TaskState,
    patch: TaskPatch,
    expectedState?: TaskState,
  ): Promise<MissionTask | null>;
  /** One statement, `FOR UPDATE SKIP LOCKED`, with every ceiling checked inside the sub-select. */
  claimNext(request: TaskClaimRequest): Promise<TaskClaimResult | null>;
  countActive(): Promise<number>;
  countActiveMissions(): Promise<number>;
}

/* ---------------------------------------------------------------- the lease */

export interface WriteLease {
  readonly id: string;
  readonly missionId: string;
  readonly taskId: string;
  readonly runId: string | null;
  readonly paths: readonly string[];
  readonly state: 'held' | 'released';
  readonly acquiredAt: string;
  readonly releasedAt: string | null;
  readonly releasedReason: string | null;
}

export interface WriteLeaseRepository {
  /**
   * Take a lease, or refuse because someone else holds an overlapping one.
   *
   * Returns `null` on conflict rather than throwing: a task that cannot get its lease is not an
   * error, it is a task that waits.
   */
  acquire(input: {
    missionId: string;
    taskId: string;
    runId: string | null;
    paths: readonly string[];
  }): Promise<WriteLease | null>;
  release(taskId: string, reason: string): Promise<void>;
  listHeld(missionId: string): Promise<readonly WriteLease[]>;
  findForTask(taskId: string): Promise<WriteLease | null>;
}

/* --------------------------------------------------------------- the review */

export interface ReviewCreateInput {
  readonly missionId: string;
  readonly taskId: string;
  readonly runId: string | null;
  readonly graphVersion: number;
  readonly planVersion: number;
  readonly reviewerRole: AgentRole;
  readonly verdict: ReviewVerdict;
  readonly proposedVerdict: ReviewVerdict;
  readonly overrideRule: string | null;
  readonly overrideReason: string | null;
  readonly summary: string;
  readonly diffFingerprint: string;
  readonly reviewedFiles: readonly string[];
  readonly verificationSnapshot: readonly {
    readonly check: string;
    readonly outcome: VerificationOutcome;
    readonly required: boolean;
  }[];
  readonly repairRound: number;
  readonly unavailableReason: string | null;
  readonly findings: readonly ReviewFindingInput[];
}

export interface ReviewRepository {
  create(
    input: ReviewCreateInput,
  ): Promise<{ review: MissionReview; findings: readonly ReviewFinding[] }>;
  findById(id: string): Promise<MissionReview | null>;
  listByMission(missionId: string): Promise<readonly MissionReview[]>;
  latestForTask(taskId: string): Promise<MissionReview | null>;
  listFindings(missionId: string): Promise<readonly ReviewFinding[]>;
  listFindingsForReview(reviewId: string): Promise<readonly ReviewFinding[]>;
  setFindingState(
    id: string,
    state: FindingState,
    patch?: {
      ownerDecision?: string | null;
      resolvedByTaskId?: string | null;
      triageRule?: string | null;
    },
  ): Promise<ReviewFinding>;
}

/* -------------------------------------------------------------- the receipt */

export interface ReceiptRepository {
  upsert(input: {
    missionId: string;
    graphVersion: number;
    planVersion: number;
    content: CompletionReceiptContent;
  }): Promise<CompletionReceipt>;
  findByMission(missionId: string): Promise<CompletionReceipt | null>;
}

/* ------------------------------------------------------------- the playbooks */

export interface PlaybookRepository {
  list(): Promise<readonly (Playbook & { readonly definition: PlaybookDefinition })[]>;
  findByKey(key: string): Promise<Playbook | null>;
  version(key: string, version: number): Promise<PlaybookVersion | null>;
  latestVersion(key: string): Promise<PlaybookVersion | null>;
  install(input: {
    definition: PlaybookDefinition;
    fingerprint: string;
    builtIn: boolean;
    createdBy: string;
    note?: string | null;
  }): Promise<{ playbook: Playbook; version: PlaybookVersion; created: boolean }>;
  setEnabled(key: string, enabled: boolean): Promise<Playbook>;
  listVersions(key: string): Promise<readonly PlaybookVersion[]>;
}

/* -------------------------------------------------------- CI and releases */

export interface CiDispatchRepository {
  record(input: {
    missionId: string | null;
    taskId: string | null;
    projectId: string | null;
    purpose: CiDispatchPurpose;
    repositoryFullName: string;
    workflowFile: string;
    ref: string;
    commitSha: string;
    inputs: Readonly<Record<string, string>>;
    inputsFingerprint: string;
    idempotencyKey: string;
    requestedBy: string;
    state: CiDispatchState;
    refusalRule?: string | null;
    refusalReason?: string | null;
  }): Promise<{ dispatch: CiDispatch; created: boolean }>;
  findById(id: string): Promise<CiDispatch | null>;
  patch(
    id: string,
    patch: Partial<{
      state: CiDispatchState;
      approvedBy: string | null;
      approvedAt: Date | null;
      dispatchedAt: Date | null;
      externalRunId: string | null;
      externalRunUrl: string | null;
      conclusion: string | null;
      stageReport: readonly { stage: string; state: string }[];
      finishedAt: Date | null;
      refusalRule: string | null;
      refusalReason: string | null;
    }>,
  ): Promise<CiDispatch>;
  listRecent(limit?: number): Promise<readonly CiDispatch[]>;
  countSince(since: Date): Promise<number>;
  listForMission(missionId: string): Promise<readonly CiDispatch[]>;
}

export interface ReleaseApprovalRepository {
  create(input: {
    missionId: string | null;
    projectId: string;
    repositoryFullName: string;
    workflowFile: string;
    ref: string;
    commitSha: string;
    inputs: Readonly<Record<string, string>>;
    identity: string;
    approvedBy: string;
    bundleIdentifier: string | null;
  }): Promise<ReleaseApproval>;
  findActiveForIdentity(identity: string): Promise<ReleaseApproval | null>;
  listForProject(projectId: string): Promise<readonly ReleaseApproval[]>;
  setState(
    id: string,
    state: ReleaseApprovalState,
    patch?: { supersededReason?: string | null; dispatchId?: string | null },
  ): Promise<ReleaseApproval>;
  /** Invalidate every live approval for a project whose commit no longer matches. */
  supersedeOthers(projectId: string, keepIdentity: string, reason: string): Promise<number>;
}

/* ------------------------------------------------------------- the wallboard */

export interface DisplayDeviceAuthRecord {
  readonly id: string;
  readonly tokenHash: string;
  readonly revokedAt: string | null;
  readonly expiresAt: string | null;
}

export interface DisplayDeviceRepository {
  create(input: {
    /** Supplied by the caller because the id is part of the token that hashes into this row. */
    id: string;
    name: string;
    location: string | null;
    tokenHash: string;
    tokenPrefix: string;
    scopes: readonly DisplayScope[];
    rotationSeconds: number;
    expiresAt: Date | null;
  }): Promise<DisplayDevice>;
  list(): Promise<readonly DisplayDevice[]>;
  findById(id: string): Promise<DisplayDevice | null>;
  /** Never leaves the display auth module. There is no mapper that exposes the hash. */
  findAuthRecord(id: string): Promise<DisplayDeviceAuthRecord | null>;
  touch(id: string, userAgent: string | null): Promise<void>;
  revoke(id: string, reason: string | null): Promise<DisplayDevice>;
  remove(id: string): Promise<void>;
}

/* --------------------------------------------------------- the app factory */

export interface AppProfileRepository {
  findByProject(projectId: string): Promise<AppProfile | null>;
  upsert(projectId: string, input: AppProfileInput): Promise<AppProfile>;
  remove(projectId: string): Promise<void>;
  list(): Promise<readonly AppProfile[]>;
}
