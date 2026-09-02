import { z } from 'zod';
import type { MissionFailureCode } from './mission';

/**
 * Runs, events, commands, permission requests, verifications and artifacts.
 *
 * Everything a mission actually *did*. These are append-mostly records: the mission row holds
 * current state, and these hold the history that explains it.
 */

/* --------------------------------------------------------------------- runs */

export const RUN_KINDS = ['inspection', 'execution', 'research'] as const;
export type RunKind = (typeof RUN_KINDS)[number];

export const RUN_STATES = [
  'starting',
  'running',
  'paused',
  'stopping',
  'stopped',
  'succeeded',
  'failed',
] as const;
export type RunState = (typeof RUN_STATES)[number];

export interface MissionRun {
  readonly id: string;
  readonly missionId: string;
  readonly workerId: string;
  readonly attempt: number;
  readonly kind: RunKind;
  readonly state: RunState;
  readonly planVersion: number | null;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly lastEventAt: string | null;
  /** The runtime's own session identifier, so a resume continues the same conversation. */
  readonly agentSessionId: string | null;
  readonly runtimeName: string | null;
  readonly runtimeVersion: string | null;
  readonly workspacePath: string | null;
  readonly baseBranch: string | null;
  readonly baseSha: string | null;
  readonly branchName: string | null;
  readonly headSha: string | null;
  readonly pullRequestUrl: string | null;
  readonly pullRequestNumber: number | null;
  readonly filesChanged: readonly string[];
  readonly usage: RunUsage | null;
  readonly failureCode: MissionFailureCode | null;
  readonly failureMessage: string | null;
  readonly currentAction: string | null;
  readonly workspacePreserved: boolean;
}

export interface RunUsage {
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly cacheReadTokens: number | null;
  readonly totalCostUsd: number | null;
  readonly turns: number | null;
  readonly durationMs: number | null;
}

export const runUsageSchema = z.object({
  inputTokens: z.number().int().min(0).max(1_000_000_000).nullish(),
  outputTokens: z.number().int().min(0).max(1_000_000_000).nullish(),
  cacheReadTokens: z.number().int().min(0).max(1_000_000_000).nullish(),
  totalCostUsd: z.number().min(0).max(100_000).nullish(),
  turns: z.number().int().min(0).max(100_000).nullish(),
  durationMs: z.number().int().min(0).max(2_147_483_647).nullish(),
});

/* ------------------------------------------------------------------- events */

export const MISSION_EVENT_TYPES = [
  'mission_created',
  'state_changed',
  'clarification_asked',
  'clarification_answered',
  'plan_submitted',
  'plan_edited',
  'plan_approved',
  'plan_rejected',
  'plan_revision_requested',
  'approval_revoked',
  'run_started',
  'workspace_prepared',
  'agent_message',
  'agent_summary',
  'tool_use',
  'tool_result',
  'file_changed',
  'verification_started',
  'verification_finished',
  'permission_requested',
  'permission_resolved',
  'owner_message',
  'command_requested',
  'command_acknowledged',
  'branch_created',
  'commit_created',
  'branch_pushed',
  'pull_request_created',
  'pull_request_updated',
  'ci_status',
  'artifact_created',
  'policy_refusal',
  'warning',
  'error',
  'run_finished',
  'info',
] as const;
export type MissionEventType = (typeof MISSION_EVENT_TYPES)[number];

export const EVENT_ACTORS = ['owner', 'worker', 'agent', 'system'] as const;
export type EventActor = (typeof EVENT_ACTORS)[number];

export const EVENT_LEVELS = ['debug', 'info', 'notice', 'warning', 'error'] as const;
export type EventLevel = (typeof EVENT_LEVELS)[number];

export interface MissionEvent {
  readonly id: string;
  readonly missionId: string;
  readonly runId: string | null;
  /** Monotonic per run. Lets the browser ask for "everything after N" and the worker retry safely. */
  readonly seq: number;
  readonly type: MissionEventType;
  readonly level: EventLevel;
  readonly actor: EventActor;
  readonly summary: string;
  readonly detail: Readonly<Record<string, unknown>>;
  readonly occurredAt: string;
  readonly createdAt: string;
}

/** Hard caps. A worker is authenticated, not trusted: it cannot post an unbounded transcript. */
export const EVENT_SUMMARY_MAX = 2000;
export const EVENT_DETAIL_MAX_BYTES = 16_000;
export const EVENT_BATCH_MAX = 50;

export const missionEventInputSchema = z.object({
  seq: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  type: z.enum(MISSION_EVENT_TYPES),
  level: z.enum(EVENT_LEVELS).default('info'),
  actor: z.enum(EVENT_ACTORS).default('worker'),
  summary: z.string().trim().min(1).max(EVENT_SUMMARY_MAX),
  detail: z.record(z.string(), z.unknown()).default({}),
  occurredAt: z.string().datetime().optional(),
});
export type MissionEventInput = z.infer<typeof missionEventInputSchema>;

/* ----------------------------------------------------------------- commands */

export const COMMAND_KINDS = [
  'pause',
  'resume',
  'message',
  'stop',
  'permission_response',
  'answer',
] as const;
export type CommandKind = (typeof COMMAND_KINDS)[number];

export const COMMAND_STATES = [
  'pending',
  'delivered',
  'acknowledged',
  'completed',
  'failed',
  'superseded',
] as const;
export type CommandState = (typeof COMMAND_STATES)[number];

export interface MissionCommand {
  readonly id: string;
  readonly missionId: string;
  readonly runId: string | null;
  readonly kind: CommandKind;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly state: CommandState;
  readonly requestedBy: string;
  readonly requestedAt: string;
  readonly deliveredAt: string | null;
  readonly acknowledgedAt: string | null;
  readonly completedAt: string | null;
  readonly failureMessage: string | null;
  readonly idempotencyKey: string;
}

export const ownerMessageSchema = z.object({
  message: z.string().trim().min(1).max(4000),
  /** The owner's own judgement, checked against Jarvis's scope analysis rather than trusted. */
  expectsScopeChange: z.boolean().default(false),
});

export const stopRequestSchema = z.object({
  reason: z.string().trim().max(1000).nullish(),
  /** Stop is destructive enough to require a typed confirmation, not just a click. */
  confirm: z.literal(true),
});

/* ------------------------------------------------------- permission requests */

export const PERMISSION_REQUEST_KINDS = [
  'tool_permission',
  'clarification',
  'scope_decision',
  'unavailable_access',
  'tradeoff',
  'external_dependency',
] as const;
export type PermissionRequestKind = (typeof PERMISSION_REQUEST_KINDS)[number];

export const PERMISSION_REQUEST_STATES = [
  'pending',
  'approved',
  'denied',
  'expired',
  'cancelled',
] as const;
export type PermissionRequestState = (typeof PERMISSION_REQUEST_STATES)[number];

export interface MissionPermissionRequest {
  readonly id: string;
  readonly missionId: string;
  readonly runId: string;
  /** Stable per run. An approval applies to exactly this key and nothing else. */
  readonly requestKey: string;
  readonly kind: PermissionRequestKind;
  readonly toolName: string | null;
  readonly requestedAction: string;
  readonly reason: string;
  readonly risk: 'critical' | 'high' | 'medium' | 'low';
  readonly ifApproved: string;
  readonly alternatives: readonly string[];
  readonly state: PermissionRequestState;
  readonly expiresAt: string | null;
  readonly createdAt: string;
  readonly decidedAt: string | null;
  readonly decidedBy: string | null;
  readonly decisionNote: string | null;
  readonly answer: string | null;
}

export const permissionRequestInputSchema = z.object({
  requestKey: z.string().trim().min(1).max(120),
  kind: z.enum(PERMISSION_REQUEST_KINDS),
  toolName: z.string().trim().max(120).nullish(),
  requestedAction: z.string().trim().min(1).max(1000),
  reason: z.string().trim().min(1).max(1000),
  risk: z.enum(['critical', 'high', 'medium', 'low']).default('medium'),
  ifApproved: z.string().trim().min(1).max(1000),
  alternatives: z.array(z.string().trim().min(1).max(400)).max(6).default([]),
  expiresAt: z.string().datetime().nullish(),
});
export type PermissionRequestInput = z.infer<typeof permissionRequestInputSchema>;

export const permissionDecisionSchema = z.object({
  decision: z.enum(['approve', 'deny', 'answer']),
  /** Only ever the answer to the question asked; never a place to paste a credential. */
  answer: z.string().trim().max(2000).nullish(),
  note: z.string().trim().max(1000).nullish(),
});
export type PermissionDecisionInput = z.infer<typeof permissionDecisionSchema>;

/* ------------------------------------------------------------ verifications */

export const VERIFICATION_OUTCOMES = ['passed', 'failed', 'unavailable', 'skipped'] as const;
export type VerificationOutcome = (typeof VERIFICATION_OUTCOMES)[number];

export interface MissionVerification {
  readonly id: string;
  readonly missionId: string;
  readonly runId: string;
  readonly command: string;
  readonly source: string;
  readonly outcome: VerificationOutcome;
  readonly exitCode: number | null;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly durationMs: number | null;
  readonly outputExcerpt: string | null;
  /** Null when Jarvis genuinely cannot tell whether the failure belongs to this mission. */
  readonly missionRelated: boolean | null;
  readonly reason: string | null;
  readonly createdAt: string;
}

export const VERIFICATION_OUTPUT_MAX = 8000;

export const verificationInputSchema = z.object({
  command: z.string().trim().min(1).max(300),
  source: z.string().trim().min(1).max(60),
  outcome: z.enum(VERIFICATION_OUTCOMES),
  exitCode: z.number().int().min(-1).max(255).nullish(),
  startedAt: z.string().datetime().nullish(),
  finishedAt: z.string().datetime().nullish(),
  durationMs: z.number().int().min(0).max(86_400_000).nullish(),
  outputExcerpt: z.string().max(VERIFICATION_OUTPUT_MAX).nullish(),
  missionRelated: z.boolean().nullish(),
  reason: z.string().trim().max(600).nullish(),
});
export type VerificationInput = z.infer<typeof verificationInputSchema>;

/* --------------------------------------------------------------- artifacts */

export const ARTIFACT_KINDS = [
  'research_report',
  'technical_report',
  'diff',
  'verification_log',
  'file_list',
  'summary',
  'plan_snapshot',
] as const;
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

export interface MissionArtifact {
  readonly id: string;
  readonly missionId: string;
  readonly projectId: string | null;
  readonly runId: string | null;
  readonly kind: ArtifactKind;
  readonly title: string;
  readonly contentType: 'text/markdown' | 'text/plain' | 'application/json' | 'text/x-diff';
  readonly content: string;
  readonly sizeBytes: number;
  readonly sources: readonly ArtifactSource[];
  readonly createdBy: EventActor;
  readonly createdAt: string;
}

/** A cited source for a research finding, so findings can be told apart from inference. */
export interface ArtifactSource {
  readonly label: string;
  readonly url: string | null;
  readonly kind: 'web' | 'repository' | 'jarvis_evidence' | 'inference';
}

export const ARTIFACT_CONTENT_MAX = 200_000;

export const artifactInputSchema = z.object({
  kind: z.enum(ARTIFACT_KINDS),
  title: z.string().trim().min(1).max(200),
  contentType: z
    .enum(['text/markdown', 'text/plain', 'application/json', 'text/x-diff'])
    .default('text/markdown'),
  content: z.string().max(ARTIFACT_CONTENT_MAX),
  sources: z
    .array(
      z.object({
        label: z.string().trim().min(1).max(300),
        url: z.string().trim().max(2000).nullish(),
        kind: z.enum(['web', 'repository', 'jarvis_evidence', 'inference']),
      }),
    )
    .max(50)
    .default([]),
});
export type ArtifactInput = z.infer<typeof artifactInputSchema>;
