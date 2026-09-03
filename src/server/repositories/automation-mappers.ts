import type {
  JarvisNotification,
  NotificationDelivery,
  NotificationPreference,
  PushSubscription,
} from '@/domain/notification';
import type { LiveQualificationEvidence, QualificationCheckResult } from '@/domain/qualification';
import type { Schedule, ScheduleExecution } from '@/domain/schedule';
import type { VoiceCapture } from '@/domain/voice';
import type {
  briefings,
  liveQualificationEvidence,
  notificationDeliveries,
  notificationPreferences,
  notifications,
  pushSubscriptions,
  qualificationCheckResults,
  qualificationSuiteResults,
  scheduleExecutions,
  schedules,
  voiceCaptures,
} from '@/server/db/schema';
import type { PushSubscriptionRecord, StoredBriefing, SuiteOutcome } from './automation-types';
import { iso, isoRequired } from './mappers';

/**
 * Row → domain mapping for automation.
 *
 * `toPushSubscription` returns the **safe** view: no endpoint, no keys. The sender's view is a
 * separate function with a name that says what it is, so a route handler cannot reach the keys
 * by accident — it has to ask for `toPushRecord` and mean it.
 */

type Row<T extends { $inferSelect: unknown }> = T['$inferSelect'];

export function toCheckResult(
  row: Row<typeof qualificationCheckResults>,
): QualificationCheckResult {
  return {
    id: row.checkId,
    outcome: row.outcome,
    detail: row.detail,
    evidence: row.evidence ?? {},
    checkedAt: isoRequired(row.checkedAt),
    durationMs: row.durationMs,
  };
}

export function toSuiteOutcome(row: Row<typeof qualificationSuiteResults>): SuiteOutcome {
  return {
    kind: row.kind === 'simulated' ? 'simulated' : 'automated',
    passed: row.passed,
    buildRef: row.buildRef,
    detail: row.detail,
    testCount: row.testCount,
    recordedAt: isoRequired(row.recordedAt),
  };
}

export function toLiveEvidence(
  row: Row<typeof liveQualificationEvidence>,
): LiveQualificationEvidence {
  return {
    id: row.id,
    kind: row.kind,
    runId: row.runId,
    missionId: row.missionId,
    performedAt: isoRequired(row.performedAt),
    providerName: row.providerName,
    modelName: row.modelName,
    repositoryFullName: row.repositoryFullName,
    commitSha: row.commitSha,
    branchName: row.branchName,
    pullRequestUrl: row.pullRequestUrl,
    pullRequestNumber: row.pullRequestNumber,
    findingsCount: row.findingsCount,
    outputTokens: row.outputTokens,
    durationMs: row.durationMs,
    qualificationVersion: row.qualificationVersion,
    summary: row.summary,
  };
}

export function toSchedule(row: Row<typeof schedules>): Schedule {
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    enabled: row.enabled,
    cadence: row.cadence,
    hour: row.hour,
    minute: row.minute,
    timeZone: row.timeZone,
    weekday: row.weekday,
    dayOfMonth: row.dayOfMonth,
    projectId: row.projectId,
    catchUp: row.catchUp,
    maxRetries: row.maxRetries,
    instruction: row.instruction,
    createdAt: isoRequired(row.createdAt),
    updatedAt: isoRequired(row.updatedAt),
    lastRunAt: iso(row.lastRunAt),
    lastOccurrenceAt: iso(row.lastOccurrenceAt),
    pausedAt: iso(row.pausedAt),
    pausedReason: row.pausedReason,
  };
}

export function toExecution(row: Row<typeof scheduleExecutions>): ScheduleExecution {
  return {
    id: row.id,
    scheduleId: row.scheduleId,
    state: row.state,
    occurrenceAt: isoRequired(row.occurrenceAt),
    occurrenceLocal: row.occurrenceLocal,
    idempotencyKey: row.idempotencyKey,
    startedAt: iso(row.startedAt),
    finishedAt: iso(row.finishedAt),
    attempt: row.attempt,
    nextRetryAt: iso(row.nextRetryAt),
    failureCode: row.failureCode,
    failureMessage: row.failureMessage,
    evidenceWindowFrom: iso(row.evidenceWindowFrom),
    evidenceWindowTo: iso(row.evidenceWindowTo),
    resultId: row.resultId,
    summary: row.summary,
    createdAt: isoRequired(row.createdAt),
  };
}

export function toStoredBriefing(row: Row<typeof briefings>): StoredBriefing {
  return {
    id: row.id,
    kind: row.kind,
    executionId: row.executionId,
    projectId: row.projectId,
    windowFrom: isoRequired(row.windowFrom),
    windowTo: isoRequired(row.windowTo),
    content: row.content,
    narration: row.narration ?? null,
    narrationRule: row.narrationRule,
    method: row.method,
    isQuiet: row.isQuiet,
    readAt: iso(row.readAt),
    createdAt: isoRequired(row.createdAt),
  };
}

export function toNotification(row: Row<typeof notifications>): JarvisNotification {
  return {
    id: row.id,
    category: row.category,
    severity: row.severity,
    title: row.title,
    body: row.body,
    projectId: row.projectId,
    missionId: row.missionId,
    href: row.href,
    dedupeKey: row.dedupeKey,
    occurrenceCount: row.occurrenceCount,
    createdAt: isoRequired(row.createdAt),
    lastOccurredAt: isoRequired(row.lastOccurredAt),
    readAt: iso(row.readAt),
    acknowledgedAt: iso(row.acknowledgedAt),
    expiresAt: iso(row.expiresAt),
  };
}

export function toDelivery(row: Row<typeof notificationDeliveries>): NotificationDelivery {
  return {
    id: row.id,
    notificationId: row.notificationId,
    channel: row.channel,
    state: row.state,
    attempt: row.attempt,
    deliveredAt: iso(row.deliveredAt),
    failureMessage: row.failureMessage,
    suppressedReason: row.suppressedReason,
    createdAt: isoRequired(row.createdAt),
  };
}

export function toPreference(row: Row<typeof notificationPreferences>): NotificationPreference {
  return {
    category: row.category,
    channels: row.channels ?? ['in_app'],
    minSeverity: row.minSeverity,
    digest: row.digest,
    enabled: row.enabled,
    projectIds: row.projectIds ?? [],
  };
}

/** The safe view. There is no endpoint and no key here, by construction. */
export function toPushSubscription(row: Row<typeof pushSubscriptions>): PushSubscription {
  return {
    id: row.id,
    endpointHash: row.endpointHash,
    label: row.label,
    userAgent: row.userAgent,
    createdAt: isoRequired(row.createdAt),
    lastUsedAt: iso(row.lastUsedAt),
    failureCount: row.failureCount,
    revokedAt: iso(row.revokedAt),
  };
}

/** The sender's view. Named so that reaching credential material is always deliberate. */
export function toPushRecord(row: Row<typeof pushSubscriptions>): PushSubscriptionRecord {
  return {
    ...toPushSubscription(row),
    endpoint: row.endpoint,
    keyP256dh: row.keyP256dh,
    keyAuth: row.keyAuth,
  };
}

export function toVoiceCapture(row: Row<typeof voiceCaptures>): VoiceCapture {
  return {
    id: row.id,
    state: row.state,
    transcript: row.transcript,
    editedTranscript: row.editedTranscript,
    intent: row.intent,
    projectId: row.projectId,
    durationMs: row.durationMs,
    byteSize: row.byteSize,
    providerName: row.providerName,
    confidence: row.confidence,
    failureCode: row.failureCode,
    failureMessage: row.failureMessage,
    audioRetained: row.audioRetained,
    audioDeleteAfter: iso(row.audioDeleteAfter),
    createdAt: isoRequired(row.createdAt),
    confirmedAt: iso(row.confirmedAt),
    resultKind: row.resultKind,
    resultId: row.resultId,
  };
}
