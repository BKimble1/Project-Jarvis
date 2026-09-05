import { z } from 'zod';
import { boundText, redactSecrets } from './redaction';

/**
 * Telling me something happened, without telling my lock screen too much.
 *
 * Two rules shape this file.
 *
 * **A notification payload is a summary and a link, never content.** A push notification is
 * rendered by the operating system, cached by it, and shown on a locked screen to whoever is
 * holding the device. So `toPushPayload` builds its text from a fixed template and the category —
 * never from a diff, a document excerpt, a prompt, a repository name or an error body. The
 * interesting information lives behind an authenticated deep link, which is the one place it is
 * safe.
 *
 * **Delivery is downstream of the thing that happened.** A notification that fails to send must
 * never change mission state, and must never cause the underlying action to run twice. So
 * notifications are *recorded first* and delivered afterwards, deliveries are tracked per channel,
 * and a channel failure marks the delivery rather than the notification. The action that produced
 * it has already committed and does not care.
 *
 * Restraint is a feature. Nine categories, per-category preferences, quiet hours, digesting and a
 * dedupe key — because a system that notifies me about everything is one I turn off, and then it
 * cannot notify me about the thing that mattered.
 */

/* -------------------------------------------------------------- categories */

export const NOTIFICATION_CATEGORIES = [
  'approval_needed',
  'mission_blocked',
  'verification_failed',
  'review_blocked',
  'worker_offline',
  'sync_failing',
  'budget_threshold',
  'draft_pr_ready',
  'testflight_status',
  'backup_problem',
  'knowledge_conflict',
  'briefing_ready',
  'qualification_changed',
] as const;
export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number];

export const CATEGORY_LABELS: Record<NotificationCategory, string> = {
  approval_needed: 'Something needs approving',
  mission_blocked: 'A mission is blocked',
  verification_failed: 'A check failed',
  review_blocked: 'A review blocked delivery',
  worker_offline: 'A worker went offline',
  sync_failing: 'Synchronisation is failing',
  budget_threshold: 'A budget threshold was reached',
  draft_pr_ready: 'A draft pull request is ready',
  testflight_status: 'A TestFlight build changed',
  backup_problem: 'A backup or restore problem',
  knowledge_conflict: 'Two notes disagree',
  briefing_ready: 'A briefing is ready',
  qualification_changed: 'Qualification changed',
};

export const SEVERITIES = ['critical', 'high', 'medium', 'low'] as const;
export type NotificationSeverity = (typeof SEVERITIES)[number];

export const SEVERITY_RANK: Record<NotificationSeverity, number> = {
  critical: 3,
  high: 2,
  medium: 1,
  low: 0,
};

/**
 * The default severity of each category.
 *
 * Only two things are `critical`, and both mean *Jarvis has stopped and cannot continue without
 * you*. Making more things critical would make critical mean nothing, which is the failure mode
 * every alerting system reaches eventually.
 */
export const CATEGORY_SEVERITY: Record<NotificationCategory, NotificationSeverity> = {
  approval_needed: 'high',
  mission_blocked: 'high',
  verification_failed: 'medium',
  review_blocked: 'high',
  worker_offline: 'critical',
  sync_failing: 'medium',
  budget_threshold: 'high',
  draft_pr_ready: 'medium',
  testflight_status: 'high',
  backup_problem: 'critical',
  knowledge_conflict: 'low',
  briefing_ready: 'low',
  qualification_changed: 'medium',
};

/**
 * Categories that ignore quiet hours.
 *
 * Exactly the two critical ones. If Jarvis has stopped, or a backup is broken, waking me is the
 * correct behaviour — and if it is not, I can turn the category off, which is a decision I get to
 * make rather than one the code makes for me.
 */
export const BYPASSES_QUIET_HOURS = [
  'worker_offline',
  'backup_problem',
] as const satisfies readonly NotificationCategory[];

/* ------------------------------------------------------------------ channels */

export const CHANNELS = [
  /** Always on and not disableable. The baseline that makes every other channel optional. */
  'in_app',
  'web_push',
  /** Wallboard indicator. Non-sensitive operational status only. */
  'display',
  /** A provider interface exists; no email provider ships in this phase. */
  'email',
] as const;
export type NotificationChannel = (typeof CHANNELS)[number];

export const CHANNEL_LABELS: Record<NotificationChannel, string> = {
  in_app: 'In Jarvis',
  web_push: 'Push notification',
  display: 'On the wallboard',
  email: 'Email',
};

export const DELIVERY_STATES = [
  'pending',
  'delivered',
  'failed',
  /** Held by quiet hours or a digest preference. Will be delivered later, once. */
  'deferred',
  /** Preference said no. Recorded so "why did I not hear about this?" has an answer. */
  'suppressed',
] as const;
export type DeliveryState = (typeof DELIVERY_STATES)[number];

/* ------------------------------------------------------------------ records */

export interface JarvisNotification {
  readonly id: string;
  readonly category: NotificationCategory;
  readonly severity: NotificationSeverity;
  /** One line, already redacted. This is what a push notification may show. */
  readonly title: string;
  /** A sentence or two, already redacted. Shown in app; never pushed. */
  readonly body: string | null;
  readonly projectId: string | null;
  readonly missionId: string | null;
  /** Where to go. Always a Jarvis path, never an external URL. */
  readonly href: string | null;
  /**
   * What makes two notifications "the same thing".
   *
   * A failing sync that fails again in ten minutes is one problem, not two. Collapsing on this
   * key is what stops a broken worker producing four hundred rows overnight.
   */
  readonly dedupeKey: string;
  readonly occurrenceCount: number;
  readonly createdAt: string;
  readonly lastOccurredAt: string;
  readonly readAt: string | null;
  readonly acknowledgedAt: string | null;
  readonly expiresAt: string | null;
}

export interface NotificationDelivery {
  readonly id: string;
  readonly notificationId: string;
  readonly channel: NotificationChannel;
  readonly state: DeliveryState;
  readonly attempt: number;
  readonly deliveredAt: string | null;
  readonly failureMessage: string | null;
  readonly suppressedReason: string | null;
  readonly createdAt: string;
}

export interface NotificationPreference {
  readonly category: NotificationCategory;
  readonly channels: readonly NotificationChannel[];
  readonly minSeverity: NotificationSeverity;
  /** Batch into a digest rather than delivering immediately. */
  readonly digest: boolean;
  readonly enabled: boolean;
  /** Only notify about these projects. Empty means all of them. */
  readonly projectIds: readonly string[];
}

export interface QuietHours {
  readonly enabled: boolean;
  /** Local wall-clock, in `timeZone`. May wrap midnight, which is the normal case. */
  readonly fromHour: number;
  readonly toHour: number;
  readonly timeZone: string;
}

export interface PushSubscription {
  readonly id: string;
  readonly endpointHash: string;
  readonly label: string | null;
  readonly userAgent: string | null;
  readonly createdAt: string;
  readonly lastUsedAt: string | null;
  readonly failureCount: number;
  readonly revokedAt: string | null;
}

/* ------------------------------------------------------------------ schemas */

export const notificationPreferenceSchema = z.object({
  category: z.enum(NOTIFICATION_CATEGORIES),
  channels: z.array(z.enum(CHANNELS)).max(CHANNELS.length).default(['in_app']),
  minSeverity: z.enum(SEVERITIES).default('low'),
  digest: z.boolean().default(false),
  enabled: z.boolean().default(true),
  projectIds: z.array(z.string().uuid()).max(50).default([]),
});
export type NotificationPreferenceInput = z.infer<typeof notificationPreferenceSchema>;

export const quietHoursSchema = z.object({
  enabled: z.boolean().default(false),
  fromHour: z.number().int().min(0).max(23).default(22),
  toHour: z.number().int().min(0).max(23).default(7),
  timeZone: z.string().trim().min(1).max(64).default('UTC'),
});

export const pushSubscriptionSchema = z.object({
  endpoint: z.string().trim().min(20).max(1000).url(),
  keys: z.object({
    p256dh: z.string().trim().min(10).max(200),
    auth: z.string().trim().min(10).max(200),
  }),
  label: z.string().trim().max(60).nullish(),
});
export type PushSubscriptionInput = z.infer<typeof pushSubscriptionSchema>;

export const notificationActionSchema = z.object({
  action: z.enum(['read', 'unread', 'acknowledge', 'dismiss']),
});

/* ------------------------------------------------------------------ routing */

export interface RoutingDecision {
  readonly channels: readonly NotificationChannel[];
  readonly deferred: readonly NotificationChannel[];
  readonly suppressed: readonly {
    readonly channel: NotificationChannel;
    readonly reason: string;
  }[];
  readonly rule: string;
}

/**
 * Which channels should carry this, and which should wait.
 *
 * `in_app` always carries it. That is the baseline that makes everything else safe to switch off:
 * however restrictive my preferences are, opening Jarvis still shows me what happened, so a
 * suppressed push is never a lost event.
 *
 * The rules:
 *
 *  - **R-NT1** — the category is switched off. `in_app` still records it; nothing else fires.
 *  - **R-NT2** — below the minimum severity for that category. Same treatment.
 *  - **R-NT3** — the project is not in the filter.
 *  - **R-NT4** — quiet hours, and the category does not bypass them. Deferred, not dropped.
 *  - **R-NT5** — the preference asks for a digest. Deferred.
 *  - **R-NT6** — deliver now.
 */
export function routeNotification(input: {
  readonly category: NotificationCategory;
  readonly severity: NotificationSeverity;
  readonly projectId: string | null;
  readonly preference: NotificationPreference | null;
  readonly quietHours: QuietHours;
  readonly nowHourLocal: number;
}): RoutingDecision {
  const preference = input.preference;
  const requested = preference?.channels ?? ['in_app'];
  const others = requested.filter((channel) => channel !== 'in_app');

  const suppressAll = (reason: string, rule: string): RoutingDecision => ({
    channels: ['in_app'],
    deferred: [],
    suppressed: others.map((channel) => ({ channel, reason })),
    rule,
  });

  if (preference && !preference.enabled) {
    return suppressAll('You switched this category off.', 'R-NT1');
  }
  if (preference && SEVERITY_RANK[input.severity] < SEVERITY_RANK[preference.minSeverity]) {
    return suppressAll(
      `Below the ${preference.minSeverity} threshold you set for this category.`,
      'R-NT2',
    );
  }
  if (
    preference &&
    preference.projectIds.length > 0 &&
    (input.projectId === null || !preference.projectIds.includes(input.projectId))
  ) {
    return suppressAll('This project is not in your filter for this category.', 'R-NT3');
  }

  const bypasses = (BYPASSES_QUIET_HOURS as readonly NotificationCategory[]).includes(
    input.category,
  );
  if (input.quietHours.enabled && !bypasses && inQuietHours(input.quietHours, input.nowHourLocal)) {
    return { channels: ['in_app'], deferred: others, suppressed: [], rule: 'R-NT4' };
  }
  if (preference?.digest) {
    return { channels: ['in_app'], deferred: others, suppressed: [], rule: 'R-NT5' };
  }

  return { channels: ['in_app', ...others], deferred: [], suppressed: [], rule: 'R-NT6' };
}

/** Handles the wrapping case, which is the normal one: 22:00 to 07:00. */
export function inQuietHours(quiet: QuietHours, hourLocal: number): boolean {
  if (!quiet.enabled) return false;
  if (quiet.fromHour === quiet.toHour) return false;
  return quiet.fromHour < quiet.toHour
    ? hourLocal >= quiet.fromHour && hourLocal < quiet.toHour
    : hourLocal >= quiet.fromHour || hourLocal < quiet.toHour;
}

/* ------------------------------------------------------------- rate limiting */

/** How many notifications of one category may be created in an hour before collapsing. */
export const CATEGORY_HOURLY_LIMIT = 6;

export interface RateVerdict {
  readonly allowed: boolean;
  readonly collapse: boolean;
  readonly reason: string | null;
}

/**
 * Whether to create a new row, collapse into an existing one, or drop.
 *
 * Collapsing is preferred over dropping: incrementing `occurrenceCount` on the existing row keeps
 * "this has now happened 47 times" visible, which is more useful than either 47 rows or silence.
 */
export function evaluateRate(input: {
  readonly existingWithSameKey: Pick<
    JarvisNotification,
    'id' | 'lastOccurredAt' | 'acknowledgedAt'
  > | null;
  readonly countThisHour: number;
  readonly nowIso: string;
}): RateVerdict {
  if (input.existingWithSameKey && input.existingWithSameKey.acknowledgedAt === null) {
    return {
      allowed: true,
      collapse: true,
      reason: 'The same thing is already waiting for you.',
    };
  }
  if (input.countThisHour >= CATEGORY_HOURLY_LIMIT) {
    return {
      allowed: false,
      collapse: false,
      reason: `More than ${CATEGORY_HOURLY_LIMIT} of these in an hour. Jarvis stopped adding rows; look at the ones already here.`,
    };
  }
  return { allowed: true, collapse: false, reason: null };
}

/* -------------------------------------------------------------- push payload */

export interface PushPayload {
  readonly title: string;
  readonly body: string;
  /** The authenticated deep link. Opening it requires an owner session. */
  readonly path: string;
  readonly tag: string;
  readonly category: NotificationCategory;
}

/**
 * What actually leaves the server for a device.
 *
 * Built from the *category* and fixed template text, plus at most a project name — deliberately
 * not from the notification's own body, because that body may quote a verification failure, a
 * review finding or a document. A lock screen is a public surface, and the safe assumption is that
 * whatever goes into this function is read by someone standing behind me.
 *
 * Everything of substance is behind `path`, which needs a session.
 */
export function toPushPayload(input: {
  readonly notification: Pick<
    JarvisNotification,
    'category' | 'severity' | 'dedupeKey' | 'href' | 'occurrenceCount'
  >;
  readonly projectName: string | null;
}): PushPayload {
  const category = input.notification.category;
  const scope = input.projectName ? ` · ${boundText(redactSecrets(input.projectName), 40)}` : '';
  const repeats =
    input.notification.occurrenceCount > 1 ? ` (${input.notification.occurrenceCount}×)` : '';

  return {
    title: `Jarvis: ${CATEGORY_LABELS[category]}${repeats}`,
    body: `${PUSH_BODY[category]}${scope}`,
    path: input.notification.href ?? '/attention',
    tag: input.notification.dedupeKey,
    category,
  };
}

/**
 * The only sentences that may appear on a lock screen.
 *
 * A fixed table rather than generated text, so there is no code path by which a diff, a finding or
 * an error message could reach a device. Each one says enough to decide whether to look now.
 */
const PUSH_BODY: Record<NotificationCategory, string> = {
  approval_needed: 'Something is waiting for your approval.',
  mission_blocked: 'A mission stopped and needs you.',
  verification_failed: 'A check did not pass.',
  review_blocked: 'A review would not sign off.',
  worker_offline: 'The worker stopped reporting.',
  sync_failing: 'Evidence is not refreshing.',
  budget_threshold: 'A spending threshold was reached.',
  draft_pr_ready: 'A draft pull request is ready to read.',
  testflight_status: 'A TestFlight build changed state.',
  backup_problem: 'There is a problem with a backup.',
  knowledge_conflict: 'Two of your notes disagree.',
  briefing_ready: 'Your briefing is ready.',
  qualification_changed: "Jarvis's qualification level changed.",
};

/**
 * Fields a push payload must never contain, asserted by the tests.
 *
 * Written as data so a test can iterate it rather than as a comment nobody runs — the lesson from
 * `FORBIDDEN_DISPATCHER_METHODS`, which claimed to be asserted and was not.
 */
export const FORBIDDEN_PUSH_SUBSTRINGS: readonly string[] = [
  'ghp_',
  'github_pat_',
  'sk-ant-',
  'jarvisw_',
  'jarvisd_',
  'Bearer ',
  'diff --git',
  '-----BEGIN',
];

/* ------------------------------------------------------------------ building */

export interface NotificationDraft {
  readonly category: NotificationCategory;
  readonly severity: NotificationSeverity;
  readonly title: string;
  readonly body: string | null;
  readonly projectId: string | null;
  readonly missionId: string | null;
  readonly href: string | null;
  readonly dedupeKey: string;
  readonly expiresAt: string | null;
}

/**
 * Build a notification, redacting and bounding as it goes.
 *
 * Redaction happens here rather than at storage so that everything downstream — in-app, digest,
 * export, wallboard — reads an already-safe row. A single choke point is the only arrangement that
 * survives someone adding a fifth consumer.
 */
export function buildNotification(input: {
  readonly category: NotificationCategory;
  readonly title: string;
  readonly body?: string | null;
  readonly projectId?: string | null;
  readonly missionId?: string | null;
  readonly href?: string | null;
  /** Defaults to category plus project plus mission, which is the right grain for most things. */
  readonly dedupeKey?: string;
  readonly severity?: NotificationSeverity;
  readonly expiresAt?: string | null;
}): NotificationDraft {
  return {
    category: input.category,
    severity: input.severity ?? CATEGORY_SEVERITY[input.category],
    title: boundText(redactSecrets(input.title), 200),
    body: input.body ? boundText(redactSecrets(input.body), 1000) : null,
    projectId: input.projectId ?? null,
    missionId: input.missionId ?? null,
    href: input.href ?? null,
    dedupeKey:
      input.dedupeKey ?? [input.category, input.projectId ?? '-', input.missionId ?? '-'].join(':'),
    expiresAt: input.expiresAt ?? null,
  };
}

/* ------------------------------------------------------------------ digests */

export interface DigestGroup {
  readonly category: NotificationCategory;
  readonly severity: NotificationSeverity;
  readonly count: number;
  readonly titles: readonly string[];
}

/** Group deferred notifications for one digest, worst first, bounded per category. */
export function buildDigest(notifications: readonly JarvisNotification[]): readonly DigestGroup[] {
  const byCategory = new Map<NotificationCategory, JarvisNotification[]>();
  for (const notification of notifications) {
    const list = byCategory.get(notification.category) ?? [];
    list.push(notification);
    byCategory.set(notification.category, list);
  }
  return [...byCategory.entries()]
    .map(([category, list]) => ({
      category,
      severity: list.reduce<NotificationSeverity>(
        (worst, item) =>
          SEVERITY_RANK[item.severity] > SEVERITY_RANK[worst] ? item.severity : worst,
        'low',
      ),
      count: list.reduce((total, item) => total + item.occurrenceCount, 0),
      titles: list.slice(0, 4).map((item) => item.title),
    }))
    .sort((left, right) => SEVERITY_RANK[right.severity] - SEVERITY_RANK[left.severity]);
}

export function unreadCount(notifications: readonly JarvisNotification[]): number {
  return notifications.filter((notification) => notification.readAt === null).length;
}
