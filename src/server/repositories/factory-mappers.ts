import type { CompletionReceipt } from '@/domain/completion-receipt';
import type { CiDispatch, ReleaseApproval } from '@/domain/ci-dispatch';
import type { DisplayDevice } from '@/domain/display-device';
import type { AppProfile } from '@/domain/app-profile';
import type { MissionReview, ReviewFinding } from '@/domain/mission-review';
import type { MissionTask } from '@/domain/mission-task';
import type { Playbook, PlaybookVersion } from '@/domain/playbook';
import type { MissionTaskGraph } from '@/domain/task-graph';
import type {
  ciDispatches,
  displayDevices,
  missionReceipts,
  missionReviewFindings,
  missionReviews,
  missionTaskGraphs,
  missionTasks,
  missionWriteLeases,
  playbookVersions,
  playbooks,
  projectAppProfiles,
  releaseApprovals,
} from '@/server/db/schema';
import type { WriteLease } from './factory-types';
import { iso, isoRequired } from './mappers';

/**
 * Row → domain mapping for the Prompt 3 tables.
 *
 * Two habits carried over from Prompt 2 deliberately: every jsonb read keeps its `?? []` default
 * (a row written before a column existed reads back null), and **no mapper here has a field for a
 * secret**. `toDisplayDevice` has no `tokenHash`, which is what makes it impossible to leak one
 * by adding a device to a response.
 */

type Row<T extends { $inferSelect: unknown }> = T['$inferSelect'];

export function toTaskGraph(row: Row<typeof missionTaskGraphs>): MissionTaskGraph {
  return {
    id: row.id,
    missionId: row.missionId,
    version: row.version,
    planVersion: row.planVersion,
    state: row.state,
    playbookKey: row.playbookKey,
    playbookVersion: row.playbookVersion,
    summary: row.summary,
    notes: row.notes ?? [],
    fingerprint: row.fingerprint,
    maxParallelTasks: row.maxParallelTasks,
    maxWriteTasks: row.maxWriteTasks,
    maxRepairRounds: row.maxRepairRounds,
    proposedBy: (row.proposedBy as MissionTaskGraph['proposedBy']) ?? 'system',
    createdAt: isoRequired(row.createdAt),
    approvedAt: iso(row.approvedAt),
    approvedBy: row.approvedBy,
    revokedAt: iso(row.revokedAt),
    revokedReason: row.revokedReason,
  };
}

export function toMissionTask(
  row: Row<typeof missionTasks>,
  dependsOn: readonly string[] = [],
): MissionTask {
  return {
    id: row.id,
    missionId: row.missionId,
    graphId: row.graphId,
    graphVersion: row.graphVersion,
    planVersion: row.planVersion,
    key: row.key,
    title: row.title,
    description: row.description,
    role: row.role,
    permissionProfileId: row.permissionProfileId,
    taskType: row.taskType,
    state: row.state,
    position: row.position,
    dependsOn,
    expectedInputs: row.expectedInputs ?? [],
    expectedOutputs: row.expectedOutputs ?? [],
    acceptanceCriteria: row.acceptanceCriteria ?? [],
    workspaceRequirement: row.workspaceRequirement,
    requiresRepository: row.requiresRepository,
    expectedFileAreas: row.expectedFileAreas ?? [],
    declaredWriteSet: row.declaredWriteSet ?? [],
    actualChangedFiles: row.actualChangedFiles ?? [],
    assignedWorkerId: row.assignedWorkerId,
    activeRunId: row.activeRunId,
    attempt: row.attempt,
    maxAttempts: row.maxAttempts,
    maxTurns: row.maxTurns,
    timeLimitMs: row.timeLimitMs,
    maxOutputTokens: row.maxOutputTokens,
    usage: {
      inputTokens: row.usageInputTokens,
      outputTokens: row.usageOutputTokens,
      totalCostUsd: row.usageCostUsd,
      turns: row.usageTurns,
      durationMs: row.usageDurationMs,
    },
    reviewsTaskId: row.reviewsTaskId,
    repairRound: row.repairRound,
    latestReviewId: row.latestReviewId,
    branchName: row.branchName,
    baseSha: row.baseSha,
    headSha: row.headSha,
    workspacePath: row.workspacePath,
    workspacePreserved: row.workspacePreserved,
    failureCode: row.failureCode,
    failureMessage: row.failureMessage,
    summary: row.summary,
    createdAt: isoRequired(row.createdAt),
    startedAt: iso(row.startedAt),
    finishedAt: iso(row.finishedAt),
    lastActivityAt: iso(row.lastActivityAt),
  };
}

export function toWriteLease(row: Row<typeof missionWriteLeases>): WriteLease {
  return {
    id: row.id,
    missionId: row.missionId,
    taskId: row.taskId,
    runId: row.runId,
    paths: row.paths ?? [],
    state: row.state,
    acquiredAt: isoRequired(row.acquiredAt),
    releasedAt: iso(row.releasedAt),
    releasedReason: row.releasedReason,
  };
}

export function toMissionReview(row: Row<typeof missionReviews>): MissionReview {
  return {
    id: row.id,
    missionId: row.missionId,
    taskId: row.taskId,
    runId: row.runId,
    graphVersion: row.graphVersion,
    planVersion: row.planVersion,
    reviewerRole: row.reviewerRole,
    verdict: row.verdict,
    summary: row.summary,
    diffFingerprint: row.diffFingerprint,
    reviewedFiles: row.reviewedFiles ?? [],
    verificationSnapshot: row.verificationSnapshot ?? [],
    repairRound: row.repairRound,
    coldContext: row.coldContext,
    unavailableReason: row.unavailableReason,
    createdAt: isoRequired(row.createdAt),
  };
}

export function toReviewFinding(row: Row<typeof missionReviewFindings>): ReviewFinding {
  return {
    id: row.id,
    reviewId: row.reviewId,
    missionId: row.missionId,
    key: row.key,
    severity: row.severity,
    category: row.category,
    title: row.title,
    description: row.description,
    evidence: row.evidence,
    file: row.file,
    line: row.line,
    component: row.component,
    violates: row.violates,
    reproduction: row.reproduction,
    recommendation: row.recommendation,
    confidence: row.confidence,
    blocksDelivery: row.blocksDelivery,
    state: row.state,
    ownerDecision: row.ownerDecision,
    resolvedByTaskId: row.resolvedByTaskId,
    repairRound: row.repairRound,
    createdAt: isoRequired(row.createdAt),
    resolvedAt: iso(row.resolvedAt),
  };
}

export function toReceipt(row: Row<typeof missionReceipts>): CompletionReceipt {
  return {
    id: row.id,
    missionId: row.missionId,
    graphVersion: row.graphVersion,
    planVersion: row.planVersion,
    content: row.content,
    createdAt: isoRequired(row.createdAt),
  };
}

export function toPlaybook(row: Row<typeof playbooks>): Playbook {
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    description: row.description,
    builtIn: row.builtIn,
    enabled: row.enabled,
    latestVersion: row.latestVersion,
    createdAt: isoRequired(row.createdAt),
    updatedAt: isoRequired(row.updatedAt),
  };
}

export function toPlaybookVersion(row: Row<typeof playbookVersions>): PlaybookVersion {
  return {
    id: row.id,
    playbookId: row.playbookId,
    playbookKey: row.playbookKey,
    version: row.version,
    definition: row.definition,
    fingerprint: row.fingerprint,
    createdAt: isoRequired(row.createdAt),
    createdBy: row.createdBy,
    note: row.note,
  };
}

export function toCiDispatch(row: Row<typeof ciDispatches>): CiDispatch {
  return {
    id: row.id,
    missionId: row.missionId,
    taskId: row.taskId,
    projectId: row.projectId,
    purpose: row.purpose,
    repositoryFullName: row.repositoryFullName,
    workflowFile: row.workflowFile,
    ref: row.ref,
    commitSha: row.commitSha,
    inputs: row.inputs ?? {},
    inputsFingerprint: row.inputsFingerprint,
    state: row.state,
    refusalRule: row.refusalRule,
    refusalReason: row.refusalReason,
    requestedBy: row.requestedBy,
    requestedAt: isoRequired(row.requestedAt),
    approvedBy: row.approvedBy,
    approvedAt: iso(row.approvedAt),
    dispatchedAt: iso(row.dispatchedAt),
    idempotencyKey: row.idempotencyKey,
    externalRunId: row.externalRunId,
    externalRunUrl: row.externalRunUrl,
    conclusion: row.conclusion,
    stageReport: row.stageReport ?? [],
    finishedAt: iso(row.finishedAt),
    updatedAt: isoRequired(row.updatedAt),
  };
}

export function toReleaseApproval(row: Row<typeof releaseApprovals>): ReleaseApproval {
  return {
    id: row.id,
    missionId: row.missionId,
    projectId: row.projectId,
    kind: 'testflight',
    repositoryFullName: row.repositoryFullName,
    workflowFile: row.workflowFile,
    ref: row.ref,
    commitSha: row.commitSha,
    inputs: row.inputs ?? {},
    identity: row.identity,
    state: row.state,
    bundleIdentifier: row.bundleIdentifier,
    buildNumber: row.buildNumber,
    approvedBy: row.approvedBy,
    approvedAt: iso(row.approvedAt),
    revokedAt: iso(row.revokedAt),
    supersededReason: row.supersededReason,
    dispatchId: row.dispatchId,
    createdAt: isoRequired(row.createdAt),
  };
}

/**
 * A display device, without its secret.
 *
 * There is deliberately no `tokenHash` field on `DisplayDevice` and none read here. Adding one
 * would make it possible for a device row to reach a response by accident, which is exactly the
 * mistake the type system should be preventing.
 */
export function toDisplayDevice(row: Row<typeof displayDevices>): DisplayDevice {
  return {
    id: row.id,
    name: row.name,
    tokenPrefix: row.tokenPrefix,
    location: row.location,
    createdAt: isoRequired(row.createdAt),
    lastSeenAt: iso(row.lastSeenAt),
    lastSeenUserAgent: row.lastSeenUserAgent,
    revokedAt: iso(row.revokedAt),
    revokedReason: row.revokedReason,
    expiresAt: iso(row.expiresAt),
    scopes: row.scopes ?? [],
    rotationSeconds: row.rotationSeconds,
  };
}

export function toAppProfile(row: Row<typeof projectAppProfiles>): AppProfile {
  return {
    id: row.id,
    projectId: row.projectId,
    platform: row.platform,
    appName: row.appName,
    bundleIdentifier: row.bundleIdentifier,
    sku: row.sku,
    teamIdentifierReference: row.teamIdentifierReference,
    appCategory: row.appCategory,
    primaryColor: row.primaryColor,
    iconState: row.iconState,
    subscriptionModel: row.subscriptionModel,
    storeKitProductIds: row.storeKitProductIds ?? [],
    requiresWidget: row.requiresWidget,
    requiresAppGroup: row.requiresAppGroup,
    appGroupIdentifier: row.appGroupIdentifier,
    requiresNotifications: row.requiresNotifications,
    privacySensitiveApis: row.privacySensitiveApis ?? [],
    websiteRepository: row.websiteRepository,
    websiteDomain: row.websiteDomain,
    supportUrl: row.supportUrl,
    privacyUrl: row.privacyUrl,
    termsUrl: row.termsUrl,
    testFlightWorkflow: row.testFlightWorkflow,
    signingSecretNames: row.signingSecretNames ?? [],
    notes: row.notes,
    createdAt: isoRequired(row.createdAt),
    updatedAt: isoRequired(row.updatedAt),
  };
}
