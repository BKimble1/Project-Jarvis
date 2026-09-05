import type { BriefingContent, BriefingKind, BriefingNarration } from '@/domain/briefing';
import type {
  DeliveryState,
  JarvisNotification,
  NotificationCategory,
  NotificationChannel,
  NotificationDelivery,
  NotificationPreference,
  NotificationSeverity,
  PushSubscription,
} from '@/domain/notification';
import type {
  CheckOutcome,
  LiveQualificationEvidence,
  QualificationAssumptions,
  QualificationCheckId,
  QualificationCheckResult,
  QualificationLevel,
  QualificationRun,
} from '@/domain/qualification';
import type {
  Cadence,
  CatchUpPolicy,
  ExecutionState,
  Schedule,
  ScheduleExecution,
  ScheduleKind,
} from '@/domain/schedule';
import type { SummaryMethod } from '@/domain/enums';
import type {
  CaptureFailureCode,
  CaptureState,
  TranscriptIntent,
  VoiceCapture,
} from '@/domain/voice';

/**
 * The persistence boundary for qualification, scheduling, briefings, notifications and voice.
 *
 * One shared theme: every one of these tables records *what actually happened*, including the
 * unflattering cases. A missed occurrence is a row. A suppressed notification is a row with a
 * reason. A qualification check that could not run is a row saying `unavailable`. None of them
 * can be made to disappear by the thing that failed.
 */

/* --------------------------------------------------------- qualification */

export interface QualificationRunCreateInput {
  readonly startedBy: string;
  readonly buildRef?: string | null;
  readonly assumptions: QualificationAssumptions;
  readonly note?: string | null;
  readonly qualificationVersion: string;
}

export interface QualificationCheckInput {
  readonly id: QualificationCheckId;
  readonly outcome: CheckOutcome;
  readonly detail: string;
  readonly evidence: Readonly<Record<string, string>>;
  readonly waivedReason?: string | null;
  readonly durationMs?: number | null;
}

export interface SuiteOutcome {
  readonly kind: 'automated' | 'simulated';
  readonly passed: boolean;
  readonly buildRef: string | null;
  readonly detail: string;
  readonly testCount: number | null;
  readonly recordedAt: string;
}

export interface LiveEvidenceInput {
  readonly kind: 'live_read' | 'live_write';
  readonly runId: string;
  readonly missionId?: string | null;
  readonly providerName?: string | null;
  readonly modelName?: string | null;
  readonly repositoryFullName: string;
  readonly commitSha?: string | null;
  readonly branchName?: string | null;
  readonly pullRequestUrl?: string | null;
  readonly pullRequestNumber?: number | null;
  readonly findingsCount?: number | null;
  readonly outputTokens?: number | null;
  readonly durationMs?: number | null;
  readonly qualificationVersion: string;
  readonly summary: string;
}

export interface QualificationRepository {
  createRun(input: QualificationRunCreateInput): Promise<QualificationRun>;
  /** Idempotent per (run, check): re-running one check replaces its result. */
  recordCheck(runId: string, input: QualificationCheckInput): Promise<QualificationCheckResult>;
  finishRun(runId: string, level: QualificationLevel, finishedAt: Date): Promise<QualificationRun>;
  findRun(id: string): Promise<QualificationRun | null>;
  /** The most recent run that has not been superseded. The one the activation lock consults. */
  latestRun(): Promise<QualificationRun | null>;
  listRuns(limit?: number): Promise<readonly QualificationRun[]>;
  supersedeOlderThan(runId: string, now: Date): Promise<number>;

  recordSuiteOutcome(input: Omit<SuiteOutcome, 'recordedAt'>): Promise<SuiteOutcome>;
  suiteOutcomes(): Promise<readonly SuiteOutcome[]>;

  recordLiveEvidence(input: LiveEvidenceInput): Promise<LiveQualificationEvidence>;
  listLiveEvidence(limit?: number): Promise<readonly LiveQualificationEvidence[]>;
}

/* --------------------------------------------------------------- schedules */

export interface ScheduleCreateInput {
  readonly kind: ScheduleKind;
  readonly name: string;
  readonly cadence: Cadence;
  readonly hour: number;
  readonly minute: number;
  readonly timeZone: string;
  readonly weekday?: number | null;
  readonly dayOfMonth?: number | null;
  readonly projectId?: string | null;
  readonly catchUp: CatchUpPolicy;
  readonly maxRetries: number;
  readonly instruction?: string | null;
  readonly enabled?: boolean;
  readonly createdBy: string;
}

export interface SchedulePatch {
  readonly name?: string;
  readonly enabled?: boolean;
  readonly cadence?: Cadence;
  readonly hour?: number;
  readonly minute?: number;
  readonly timeZone?: string;
  readonly weekday?: number | null;
  readonly dayOfMonth?: number | null;
  readonly catchUp?: CatchUpPolicy;
  readonly maxRetries?: number;
  readonly instruction?: string | null;
  readonly lastRunAt?: Date | null;
  readonly lastOccurrenceAt?: Date | null;
  readonly pausedAt?: Date | null;
  readonly pausedReason?: string | null;
}

export interface ExecutionCreateInput {
  readonly scheduleId: string;
  readonly occurrenceAt: Date;
  readonly occurrenceLocal: string;
  readonly idempotencyKey: string;
  readonly state: ExecutionState;
  readonly summary?: string | null;
}

export interface ExecutionPatch {
  readonly state?: ExecutionState;
  readonly startedAt?: Date | null;
  readonly finishedAt?: Date | null;
  readonly attempt?: number;
  readonly nextRetryAt?: Date | null;
  readonly failureCode?: string | null;
  readonly failureMessage?: string | null;
  readonly evidenceWindowFrom?: Date | null;
  readonly evidenceWindowTo?: Date | null;
  readonly resultId?: string | null;
  readonly summary?: string | null;
}

export interface ScheduleRepository {
  create(input: ScheduleCreateInput): Promise<Schedule>;
  findById(id: string): Promise<Schedule | null>;
  list(includeDisabled?: boolean): Promise<readonly Schedule[]>;
  patch(id: string, patch: SchedulePatch): Promise<Schedule>;
  remove(id: string): Promise<void>;

  /**
   * Claim an occurrence, or discover that it is already claimed.
   *
   * Returns null when the idempotency key already exists. That is the whole durability story:
   * two schedulers, a restart mid-run, and a DST-repeated wall-clock hour all converge on one
   * row, because the key is derived from the *local occurrence* rather than from an instant.
   */
  claimOccurrence(input: ExecutionCreateInput): Promise<ScheduleExecution | null>;
  findExecution(id: string): Promise<ScheduleExecution | null>;
  patchExecution(id: string, patch: ExecutionPatch): Promise<ScheduleExecution>;
  listExecutions(scheduleId: string, limit?: number): Promise<readonly ScheduleExecution[]>;
  /** Executions that are due to be retried, and ones left running past a deadline. */
  pendingRetries(now: Date): Promise<readonly ScheduleExecution[]>;
  recentExecutions(limit?: number): Promise<readonly ScheduleExecution[]>;
}

/* --------------------------------------------------------------- briefings */

export interface BriefingCreateInput {
  readonly kind: BriefingKind;
  readonly executionId?: string | null;
  readonly projectId?: string | null;
  readonly windowFrom: Date;
  readonly windowTo: Date;
  readonly content: BriefingContent;
  readonly narration?: BriefingNarration | null;
  readonly narrationRule?: string | null;
  readonly method: SummaryMethod;
  readonly isQuiet: boolean;
}

export interface StoredBriefing extends Omit<BriefingCreateInput, 'windowFrom' | 'windowTo'> {
  readonly id: string;
  readonly windowFrom: string;
  readonly windowTo: string;
  readonly readAt: string | null;
  readonly createdAt: string;
}

export interface BriefingRepository {
  create(input: BriefingCreateInput): Promise<StoredBriefing>;
  findById(id: string): Promise<StoredBriefing | null>;
  latest(kind?: BriefingKind, projectId?: string | null): Promise<StoredBriefing | null>;
  list(limit?: number): Promise<readonly StoredBriefing[]>;
  markRead(id: string, now: Date): Promise<StoredBriefing>;
}

/* ----------------------------------------------------------- notifications */

export interface NotificationCreateInput {
  readonly category: NotificationCategory;
  readonly severity: NotificationSeverity;
  readonly title: string;
  readonly body?: string | null;
  readonly projectId?: string | null;
  readonly missionId?: string | null;
  readonly href?: string | null;
  readonly dedupeKey: string;
  readonly expiresAt?: Date | null;
}

export interface NotificationRepository {
  /**
   * Create, or collapse into an existing open notification.
   *
   * Collapsing increments `occurrenceCount` rather than inserting, which is what keeps a sync
   * that fails every ten minutes from producing four hundred rows overnight.
   */
  upsert(
    input: NotificationCreateInput,
    now: Date,
  ): Promise<{
    readonly notification: JarvisNotification;
    readonly collapsed: boolean;
  }>;
  findById(id: string): Promise<JarvisNotification | null>;
  list(input?: {
    readonly unreadOnly?: boolean;
    readonly categories?: readonly NotificationCategory[];
    readonly limit?: number;
  }): Promise<readonly JarvisNotification[]>;
  unreadCount(): Promise<number>;
  markRead(id: string, now: Date): Promise<JarvisNotification>;
  markUnread(id: string): Promise<JarvisNotification>;
  acknowledge(id: string, now: Date): Promise<JarvisNotification>;
  markAllRead(now: Date): Promise<number>;
  /** How many of a category were created inside a window. Feeds the rate check. */
  countSince(category: NotificationCategory, since: Date): Promise<number>;
  expire(now: Date): Promise<number>;

  recordDelivery(input: {
    readonly notificationId: string;
    readonly channel: NotificationChannel;
    readonly state: DeliveryState;
    readonly attempt: number;
    readonly deliveredAt?: Date | null;
    readonly failureMessage?: string | null;
    readonly suppressedReason?: string | null;
  }): Promise<NotificationDelivery>;
  listDeliveries(notificationId: string): Promise<readonly NotificationDelivery[]>;
}

export interface PreferenceRepository {
  all(): Promise<readonly NotificationPreference[]>;
  upsert(preference: NotificationPreference): Promise<NotificationPreference>;
}

export interface PushSubscriptionRecord extends PushSubscription {
  readonly endpoint: string;
  readonly keyP256dh: string;
  readonly keyAuth: string;
}

export interface PushRepository {
  /** Returns the safe view. The keys never leave this module except through `active`. */
  register(input: {
    readonly endpoint: string;
    readonly endpointHash: string;
    readonly keyP256dh: string;
    readonly keyAuth: string;
    readonly label?: string | null;
    readonly userAgent?: string | null;
  }): Promise<PushSubscription>;
  list(): Promise<readonly PushSubscription[]>;
  /** The only method that returns credential material, and it exists only for the sender. */
  active(): Promise<readonly PushSubscriptionRecord[]>;
  recordFailure(id: string, revoke: boolean, now: Date): Promise<void>;
  recordSuccess(id: string, now: Date): Promise<void>;
  revoke(id: string, now: Date): Promise<void>;
}

/* ------------------------------------------------------------------- voice */

export interface VoiceCreateInput {
  readonly transcript: string;
  readonly intent: TranscriptIntent;
  readonly projectId?: string | null;
  readonly durationMs?: number | null;
  readonly byteSize?: number | null;
  readonly providerName?: string | null;
  readonly confidence?: number | null;
  readonly audioRetained?: boolean;
  readonly audioDeleteAfter?: Date | null;
}

export interface VoicePatch {
  readonly state?: CaptureState;
  readonly editedTranscript?: string | null;
  readonly intent?: TranscriptIntent | null;
  readonly projectId?: string | null;
  readonly failureCode?: CaptureFailureCode | null;
  readonly failureMessage?: string | null;
  readonly confirmedAt?: Date | null;
  readonly resultKind?: string | null;
  readonly resultId?: string | null;
  readonly audioRetained?: boolean;
  readonly audioDeleteAfter?: Date | null;
}

export interface VoiceRepository {
  create(input: VoiceCreateInput): Promise<VoiceCapture>;
  findById(id: string): Promise<VoiceCapture | null>;
  patch(id: string, patch: VoicePatch): Promise<VoiceCapture>;
  recent(limit?: number): Promise<readonly VoiceCapture[]>;
  /** Clears the client-retention flag once its stated window has passed. */
  expireRetention(now: Date): Promise<number>;
}
