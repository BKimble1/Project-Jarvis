import { z } from 'zod';
import { MISSION_FAILURE_CODES, MISSION_STATES, type MissionType } from './mission';
import type { MissionPlanContent } from './mission-plan';
import { missionPlanContentSchema } from './mission-plan';
import {
  COMMAND_KINDS,
  EVENT_BATCH_MAX,
  RUN_KINDS,
  artifactInputSchema,
  missionEventInputSchema,
  permissionRequestInputSchema,
  runUsageSchema,
  verificationInputSchema,
  type CommandKind,
  type RunKind,
} from './mission-run';
import { WORKER_REPORTED_STATUSES } from './worker';

/**
 * The worker ↔ control-plane wire protocol.
 *
 * Both sides compile against this file, so a change that breaks the worker fails the same
 * `tsc --noEmit` that checks the application. Every worker-supplied field is bounded: an
 * authenticated worker is still an untrusted client.
 */

/* ------------------------------------------------------------------ version */

/**
 * The worker build this control plane expects.
 *
 * It lives in `@/domain` rather than in the worker's own configuration so that both sides read
 * the same constant. A version string held on one side and compared on the other is a version
 * string that drifts the first time somebody edits only one file.
 */
export const WORKER_VERSION = '2.0.0';

/**
 * Compatible means the same major.
 *
 * A minor difference is a worker that gained a capability the control plane does not use yet, and
 * that is fine. A major difference means the two disagree about what a report *means*, which is
 * the case where continuing quietly is worse than refusing.
 */
export function isCompatibleWorkerVersion(version: string | null | undefined): boolean {
  if (!version) return false;
  const theirs = version.trim().split('.')[0];
  const ours = WORKER_VERSION.split('.')[0];
  return theirs !== undefined && theirs === ours;
}

/* ---------------------------------------------------------------- heartbeat */

export const workerHeartbeatSchema = z.object({
  status: z.enum(WORKER_REPORTED_STATUSES),
  version: z.string().trim().max(40).nullish(),
  platform: z.string().trim().max(80).nullish(),
  runtimeAvailable: z.boolean(),
  runtimeName: z.string().trim().max(80).nullish(),
  runtimeDetail: z.string().trim().max(400).nullish(),
  workspaceHealthy: z.boolean(),
  workspaceRootLabel: z.string().trim().max(200).nullish(),
  githubDeliveryConfigured: z.boolean(),
  /** Safe, human-readable notes. Never an environment dump; the control plane bounds it anyway. */
  diagnostics: z.array(z.string().trim().min(1).max(300)).max(12).default([]),
  currentMissionId: z.string().uuid().nullish(),
  currentRunId: z.string().uuid().nullish(),
  lastActivityAt: z.string().datetime().nullish(),
});
export type WorkerHeartbeatInput = z.infer<typeof workerHeartbeatSchema>;

/* --------------------------------------------------------------------- poll */

export const workerPollSchema = z.object({
  heartbeat: workerHeartbeatSchema,
  /** False while draining or when the runtime is unavailable — the worker declines new work. */
  wantsWork: z.boolean().default(true),
  /** Highest command id the worker has already seen, so delivery is resumable. */
  acknowledgedCommandIds: z.array(z.string().uuid()).max(50).default([]),
});
export type WorkerPollInput = z.infer<typeof workerPollSchema>;

/** Everything the worker needs to run one mission. Assembled by the control plane, never asserted by the worker. */
export interface MissionAssignment {
  readonly missionId: string;
  readonly runId: string;
  readonly kind: RunKind;
  readonly attempt: number;
  readonly missionTitle: string;
  readonly missionDescription: string | null;
  readonly rawRequest: string;
  readonly missionType: MissionType;
  readonly riskLevel: string;
  readonly projectId: string;
  readonly projectName: string;
  readonly projectGoal: string | null;
  readonly planVersion: number | null;
  readonly plan: MissionPlanContent | null;
  readonly constraints: readonly string[];
  readonly doNotTouch: readonly string[];
  readonly acceptanceCriteria: readonly string[];
  readonly deliverable: string | null;
  readonly repository: AssignmentRepository | null;
  readonly branchName: string | null;
  readonly resumeSessionId: string | null;
  /** Owner answers and Jarvis assumptions, so the agent is not asked to re-derive them. */
  readonly clarifications: readonly { question: string; answer: string; assumed: boolean }[];
  /** Read-only project facts from Jarvis's own evidence, so the agent starts informed. */
  readonly projectContext: readonly string[];
  readonly allowWebResearch: boolean;
}

/**
 * A single task of a task graph, assigned to a worker.
 *
 * Superset of what a `MissionAssignment` carries, plus everything the task itself needs: its
 * role, the profile that confines it, the write set it declared, the branch it owns, and — for a
 * reviewer — the *constructed* review context.
 *
 * Two absences are load-bearing. There is no field carrying another agent's transcript, so a
 * reviewer cannot inherit the builder's conversation by any route. And there is no field naming a
 * permission: `permissionProfileId` names a profile the worker resolves from its own installation,
 * so the control plane cannot widen what a task may do by sending a different value.
 */
export interface TaskAssignment {
  readonly kind: 'task';
  readonly missionId: string;
  readonly runId: string;
  readonly taskId: string;
  readonly taskKey: string;
  readonly graphVersion: number;
  readonly attempt: number;
  readonly role: string;
  readonly permissionProfileId: string;
  readonly taskType: string;
  readonly title: string;
  readonly description: string;
  readonly acceptanceCriteria: readonly string[];
  readonly expectedInputs: readonly string[];
  readonly expectedOutputs: readonly string[];
  readonly workspaceRequirement: string;
  readonly declaredWriteSet: readonly string[];
  readonly branchName: string | null;
  /**
   * The branch this task's own branch starts from.
   *
   * `null` for ordinary work, which starts from the default branch. Set for a repair, whose
   * branch continues the branch it is repairing — otherwise the repair would be a sibling of the
   * work it fixes rather than a continuation of it, and integrating the two would collide on
   * exactly the lines the repair changed.
   */
  readonly baseTaskBranch: string | null;
  readonly integrationBranch: string | null;
  /** Task branches this task must merge, in dependency order. Only for an integrator. */
  readonly mergeBranches: readonly string[];
  readonly repairRound: number;
  readonly maxTurns: number | null;
  readonly timeLimitMs: number | null;
  readonly maxOutputTokens: number | null;

  readonly missionTitle: string;
  readonly rawRequest: string;
  readonly missionType: MissionType;
  readonly riskLevel: string;
  readonly projectId: string;
  readonly projectName: string;
  readonly projectGoal: string | null;
  readonly planVersion: number;
  readonly plan: MissionPlanContent | null;
  readonly graphSummary: string;
  readonly siblingTasks: readonly { key: string; title: string; role: string; state: string }[];
  readonly constraints: readonly string[];
  readonly doNotTouch: readonly string[];
  readonly repository: AssignmentRepository | null;
  readonly clarifications: readonly { question: string; answer: string; assumed: boolean }[];
  readonly projectContext: readonly string[];
  readonly allowWebResearch: boolean;

  /**
   * Inputs a reviewer needs and only a reviewer gets.
   *
   * Assembled by the control plane from stored records. `null` for every other role, which is why
   * a builder never receives the review context and a reviewer never receives anything else.
   */
  readonly review: TaskReviewInputs | null;
  /** Findings a repair round is scoped to. `null` outside a repair. */
  readonly repairScope: readonly TaskRepairFinding[] | null;
  readonly verification: readonly {
    check: string;
    outcome: string;
    required: boolean;
    detail: string;
  }[];
}

export interface TaskReviewInputs {
  readonly planSummary: string;
  readonly planApproach: string;
  readonly planScope: readonly string[];
  readonly planOutOfScope: readonly string[];
  readonly acceptanceCriteria: readonly string[];
  readonly diff: string;
  readonly changedFiles: readonly string[];
  readonly diffFingerprint: string;
  readonly artifacts: readonly { title: string; kind: string }[];
  readonly repositoryInstructions: string | null;
}

export interface TaskRepairFinding {
  readonly key: string;
  readonly severity: string;
  readonly title: string;
  readonly recommendation: string;
  readonly file: string | null;
}

export interface AssignmentRepository {
  readonly owner: string;
  readonly name: string;
  readonly fullName: string;
  readonly defaultBranch: string;
  readonly cloneUrl: string;
  readonly visibility: string | null;
}

export interface PendingCommand {
  readonly id: string;
  readonly kind: CommandKind;
  readonly missionId: string;
  readonly runId: string | null;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly requestedAt: string;
}

export interface WorkerPollResponse {
  readonly workerId: string;
  readonly serverTime: string;
  /** Null when there is nothing to do. The worker keeps polling either way. */
  readonly assignment: MissionAssignment | null;
  readonly commands: readonly PendingCommand[];
  /** Set when the owner revoked the worker or asked it to drain; the worker obeys and exits. */
  readonly directive: 'continue' | 'drain' | 'revoked';
  readonly pollIntervalMs: number;
}

/* -------------------------------------------------------------------- claim */

export const workerClaimSchema = z.object({
  heartbeat: workerHeartbeatSchema,
  /** Which kinds of run this worker is able to take right now. */
  accepts: z.array(z.enum(RUN_KINDS)).min(1).max(RUN_KINDS.length),
  /**
   * Roles this worker will take, for the Prompt 3 task queue.
   *
   * Optional so a Prompt 2 worker keeps working unchanged. A worker with no model credential
   * sends only the deterministic roles, so it can still integrate and verify without ever being
   * handed something it cannot do.
   */
  roles: z.array(z.string().trim().min(3).max(40)).max(20).optional(),
});
export type WorkerClaimInput = z.infer<typeof workerClaimSchema>;

/* ------------------------------------------------------------ run reporting */

export const workerRunStateSchema = z.object({
  runId: z.string().uuid(),
  /**
   * The state the worker believes the mission is in.
   *
   * Omitted for a metadata-only report — an agent session id, a token count — where the worker
   * has no opinion about state. That is not the same as re-asserting the state it last saw: an
   * owner may have asked for a pause in the meantime, and a stale re-assertion would read as a
   * `pausing → running` move and quietly cancel it. Absent means "do not touch the state".
   */
  missionState: z.enum(MISSION_STATES).nullish(),
  currentAction: z.string().trim().max(300).nullish(),
  agentSessionId: z.string().trim().max(200).nullish(),
  runtimeName: z.string().trim().max(80).nullish(),
  runtimeVersion: z.string().trim().max(40).nullish(),
  workspacePath: z.string().trim().max(500).nullish(),
  baseBranch: z.string().trim().max(255).nullish(),
  baseSha: z.string().trim().max(64).nullish(),
  branchName: z.string().trim().max(255).nullish(),
  headSha: z.string().trim().max(64).nullish(),
  pullRequestUrl: z.string().trim().max(500).nullish(),
  pullRequestNumber: z.number().int().min(1).max(1_000_000).nullish(),
  filesChanged: z.array(z.string().trim().min(1).max(400)).max(500).nullish(),
  usage: runUsageSchema.nullish(),
  completionSummary: z.string().trim().max(4000).nullish(),
  failureCode: z.enum(MISSION_FAILURE_CODES).nullish(),
  failureMessage: z.string().trim().max(2000).nullish(),
  workspacePreserved: z.boolean().nullish(),
});
export type WorkerRunStateInput = z.infer<typeof workerRunStateSchema>;

export const workerEventBatchSchema = z.object({
  runId: z.string().uuid(),
  events: z.array(missionEventInputSchema).min(1).max(EVENT_BATCH_MAX),
});
export type WorkerEventBatchInput = z.infer<typeof workerEventBatchSchema>;

export const workerPlanSubmissionSchema = z.object({
  runId: z.string().uuid().nullish(),
  content: missionPlanContentSchema,
  /** The worker's read of the risk, advisory only: the control plane re-classifies. */
  suggestedRiskLevel: z.string().trim().max(30).nullish(),
});
export type WorkerPlanSubmissionInput = z.infer<typeof workerPlanSubmissionSchema>;

export const workerPermissionRequestSchema = permissionRequestInputSchema.extend({
  runId: z.string().uuid(),
});

export const workerVerificationSchema = verificationInputSchema.extend({
  runId: z.string().uuid(),
});

export const workerArtifactSchema = artifactInputSchema.extend({
  runId: z.string().uuid().nullish(),
});

export const workerCommandAckSchema = z.object({
  commandId: z.string().uuid(),
  outcome: z.enum(['acknowledged', 'completed', 'failed']),
  detail: z.string().trim().max(1000).nullish(),
});
export type WorkerCommandAckInput = z.infer<typeof workerCommandAckSchema>;

/* ---------------------------------------------------------------- responses */

export interface WorkerAckResponse {
  readonly ok: true;
  /** Echoed so a worker can detect that the control plane moved the mission underneath it. */
  readonly missionState: string;
  readonly stopRequested: boolean;
  readonly pauseRequested: boolean;
}

/* ------------------------------------------------------------------- limits */

/** Worker request bodies are small by construction. Anything larger is rejected before parsing. */
export const WORKER_REQUEST_MAX_BYTES = 512_000;

export const COMMAND_KIND_VALUES: readonly CommandKind[] = COMMAND_KINDS;
