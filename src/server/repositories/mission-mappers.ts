import type { Mission } from '@/domain/mission';
import type { MissionApproval, MissionPlan } from '@/domain/mission-plan';
import type { ClarificationRecord } from '@/domain/mission';
import type {
  MissionArtifact,
  MissionCommand,
  MissionEvent,
  MissionPermissionRequest,
  MissionRun,
  MissionVerification,
  RunUsage,
} from '@/domain/mission-run';
import type { JarvisWorker } from '@/domain/worker';
import type {
  missionApprovals,
  missionArtifacts,
  missionClarifications,
  missionCommands,
  missionEvents,
  missionPermissionRequests,
  missionPlans,
  missionRuns,
  missionVerifications,
  missions,
  workers,
} from '@/server/db/schema';
import { iso, isoRequired } from './mappers';

/**
 * Row → domain mapping for Mission Control.
 *
 * Kept separate from `mappers.ts` for the same reason the schema keeps its own section: this is a
 * self-contained subsystem, and the mapping is the one place the two representations can drift.
 */

type Row<T extends { $inferSelect: unknown }> = T['$inferSelect'];

export function toMission(row: Row<typeof missions>): Mission {
  return {
    id: row.id,
    projectId: row.projectId,
    ownerLogin: row.ownerLogin,
    rawRequest: row.rawRequest,
    title: row.title,
    description: row.description,
    type: row.type,
    riskLevel: row.riskLevel,
    riskRuleIds: row.riskRuleIds ?? [],
    riskReasons: row.riskReasons ?? [],
    state: row.state,
    priority: row.priority,
    createdAt: isoRequired(row.createdAt),
    updatedAt: isoRequired(row.updatedAt),
    targetDate: row.targetDate,
    sourceId: row.sourceId,
    repositoryOwner: row.repositoryOwner,
    repositoryName: row.repositoryName,
    baseBranch: row.baseBranch,
    workingBranch: row.workingBranch,
    baseSha: row.baseSha,
    pullRequestUrl: row.pullRequestUrl,
    pullRequestNumber: row.pullRequestNumber,
    activeRunId: row.activeRunId,
    claimedByWorkerId: row.claimedByWorkerId,
    attemptCount: row.attemptCount,
    currentPlanVersion: row.currentPlanVersion,
    approvedPlanVersion: row.approvedPlanVersion,
    currentGraphVersion: row.currentGraphVersion,
    approvedGraphVersion: row.approvedGraphVersion,
    playbookKey: row.playbookKey,
    playbookVersion: row.playbookVersion,
    integrationBranch: row.integrationBranch,
    repairRoundsUsed: row.repairRoundsUsed,
    receiptId: row.receiptId,
    executionOverrideAt: iso(row.executionOverrideAt),
    executionOverrideReason: row.executionOverrideReason,
    constraints: row.constraints ?? [],
    doNotTouch: row.doNotTouch ?? [],
    deliverable: row.deliverable,
    acceptanceCriteria: row.acceptanceCriteria ?? [],
    cancellationReason: row.cancellationReason,
    completionSummary: row.completionSummary,
    failureCode: row.failureCode,
    failureMessage: row.failureMessage,
    evidenceIds: row.evidenceIds ?? [],
    startedAt: iso(row.startedAt),
    finishedAt: iso(row.finishedAt),
    lastActivityAt: iso(row.lastActivityAt),
  };
}

export function toMissionPlan(row: Row<typeof missionPlans>): MissionPlan {
  return {
    id: row.id,
    missionId: row.missionId,
    version: row.version,
    content: row.content,
    author: row.author,
    provenance: row.provenance,
    riskLevel: row.riskLevel,
    runId: row.runId,
    createdAt: isoRequired(row.createdAt),
    supersededAt: iso(row.supersededAt),
    fingerprint: row.fingerprint,
  };
}

export function toMissionApproval(row: Row<typeof missionApprovals>): MissionApproval {
  return {
    id: row.id,
    missionId: row.missionId,
    planId: row.planId,
    planVersion: row.planVersion,
    approvedBy: row.approvedBy,
    approvedAt: isoRequired(row.approvedAt),
    approvedRiskLevel: row.approvedRiskLevel,
    approvedScope: row.approvedScope ?? [],
    note: row.note,
    revokedAt: iso(row.revokedAt),
    revokedReason: row.revokedReason,
  };
}

export function toClarification(row: Row<typeof missionClarifications>): ClarificationRecord {
  return {
    missionId: row.missionId,
    id: row.questionId,
    topic: row.topic as ClarificationRecord['topic'],
    question: row.question,
    why: row.why,
    options: row.options ?? [],
    recommendation: row.recommendation,
    rule: row.rule,
    answer: row.answer,
    answerProvenance: row.answerProvenance,
    askedAt: isoRequired(row.askedAt),
    answeredAt: iso(row.answeredAt),
  };
}

function toUsage(row: Row<typeof missionRuns>): RunUsage | null {
  const hasAny =
    row.usageInputTokens !== null ||
    row.usageOutputTokens !== null ||
    row.usageCostUsd !== null ||
    row.usageTurns !== null ||
    row.usageDurationMs !== null;
  if (!hasAny) return null;
  return {
    inputTokens: row.usageInputTokens,
    outputTokens: row.usageOutputTokens,
    cacheReadTokens: row.usageCacheReadTokens,
    totalCostUsd: row.usageCostUsd,
    turns: row.usageTurns,
    durationMs: row.usageDurationMs,
  };
}

export function toMissionRun(row: Row<typeof missionRuns>): MissionRun {
  return {
    id: row.id,
    missionId: row.missionId,
    workerId: row.workerId,
    attempt: row.attempt,
    kind: row.kind,
    state: row.state,
    planVersion: row.planVersion,
    startedAt: isoRequired(row.startedAt),
    finishedAt: iso(row.finishedAt),
    lastEventAt: iso(row.lastEventAt),
    agentSessionId: row.agentSessionId,
    runtimeName: row.runtimeName,
    runtimeVersion: row.runtimeVersion,
    workspacePath: row.workspacePath,
    baseBranch: row.baseBranch,
    baseSha: row.baseSha,
    branchName: row.branchName,
    headSha: row.headSha,
    pullRequestUrl: row.pullRequestUrl,
    pullRequestNumber: row.pullRequestNumber,
    filesChanged: row.filesChanged ?? [],
    usage: toUsage(row),
    failureCode: row.failureCode,
    failureMessage: row.failureMessage,
    currentAction: row.currentAction,
    workspacePreserved: row.workspacePreserved,
    taskId: row.taskId ?? null,
    role: row.role ?? null,
    permissionProfileId: row.permissionProfileId ?? null,
    repairRound: row.repairRound ?? 0,
  };
}

export function toMissionEvent(row: Row<typeof missionEvents>): MissionEvent {
  return {
    id: row.id,
    missionId: row.missionId,
    runId: row.runId,
    seq: row.seq,
    type: row.type,
    level: row.level,
    actor: row.actor,
    summary: row.summary,
    detail: row.detail ?? {},
    occurredAt: isoRequired(row.occurredAt),
    createdAt: isoRequired(row.createdAt),
  };
}

export function toMissionCommand(row: Row<typeof missionCommands>): MissionCommand {
  return {
    id: row.id,
    missionId: row.missionId,
    runId: row.runId,
    kind: row.kind,
    payload: row.payload ?? {},
    state: row.state,
    requestedBy: row.requestedBy,
    requestedAt: isoRequired(row.requestedAt),
    deliveredAt: iso(row.deliveredAt),
    acknowledgedAt: iso(row.acknowledgedAt),
    completedAt: iso(row.completedAt),
    failureMessage: row.failureMessage,
    idempotencyKey: row.idempotencyKey,
  };
}

export function toPermissionRequest(
  row: Row<typeof missionPermissionRequests>,
): MissionPermissionRequest {
  return {
    id: row.id,
    missionId: row.missionId,
    runId: row.runId,
    requestKey: row.requestKey,
    kind: row.kind,
    toolName: row.toolName,
    requestedAction: row.requestedAction,
    reason: row.reason,
    risk: row.risk,
    ifApproved: row.ifApproved,
    alternatives: row.alternatives ?? [],
    state: row.state,
    expiresAt: iso(row.expiresAt),
    createdAt: isoRequired(row.createdAt),
    decidedAt: iso(row.decidedAt),
    decidedBy: row.decidedBy,
    decisionNote: row.decisionNote,
    answer: row.answer,
  };
}

export function toVerification(row: Row<typeof missionVerifications>): MissionVerification {
  return {
    id: row.id,
    missionId: row.missionId,
    runId: row.runId,
    command: row.command,
    source: row.source,
    outcome: row.outcome,
    exitCode: row.exitCode,
    startedAt: iso(row.startedAt),
    finishedAt: iso(row.finishedAt),
    durationMs: row.durationMs,
    outputExcerpt: row.outputExcerpt,
    missionRelated: row.missionRelated,
    reason: row.reason,
    createdAt: isoRequired(row.createdAt),
  };
}

export function toArtifact(row: Row<typeof missionArtifacts>): MissionArtifact {
  return {
    id: row.id,
    missionId: row.missionId,
    projectId: row.projectId,
    runId: row.runId,
    kind: row.kind,
    title: row.title,
    contentType: row.contentType as MissionArtifact['contentType'],
    content: row.content,
    sizeBytes: row.sizeBytes,
    sources: row.sources ?? [],
    createdBy: row.createdBy,
    createdAt: isoRequired(row.createdAt),
  };
}

/**
 * Worker rows never carry `token_hash` into the domain.
 *
 * The type simply has no field for it, so a worker's verifier cannot reach an API response, a
 * server component's props, or an export by accident.
 */
export function toWorker(row: Row<typeof workers>): JarvisWorker {
  return {
    id: row.id,
    name: row.name,
    tokenPrefix: row.tokenPrefix,
    status: row.status,
    version: row.version,
    platform: row.platform,
    currentMissionId: row.currentMissionId,
    currentRunId: row.currentRunId,
    maxConcurrency: row.maxConcurrency,
    runtimeAvailable: row.runtimeAvailable,
    runtimeName: row.runtimeName,
    runtimeDetail: row.runtimeDetail,
    workspaceHealthy: row.workspaceHealthy,
    workspaceRootLabel: row.workspaceRootLabel,
    githubDeliveryConfigured: row.githubDeliveryConfigured,
    diagnostics: row.diagnostics ?? [],
    lastHeartbeatAt: iso(row.lastHeartbeatAt),
    lastActivityAt: iso(row.lastActivityAt),
    createdAt: isoRequired(row.createdAt),
    rotatedAt: iso(row.rotatedAt),
    revokedAt: iso(row.revokedAt),
    revokedReason: row.revokedReason,
  };
}
