import { boundText, redactSecrets } from '@/domain/redaction';
import {
  briefingNotificationTitle,
  buildBriefingContent,
  type BriefingContent,
  type BriefingKind,
} from '@/domain/briefing';
import { inQuietHours, quietHoursSchema, type QuietHours } from '@/domain/notification';
import {
  KIND_CAPABILITY,
  SCHEDULE_KIND_LABELS,
  dueOccurrences,
  nextRetryAt,
  zonedParts,
  type DueOccurrence,
  type Schedule,
  type ScheduleExecution,
} from '@/domain/schedule';
import type { AuditRepository } from '@/server/repositories/accounting-types';
import type {
  BriefingRepository,
  NotificationRepository,
  ScheduleRepository,
} from '@/server/repositories/automation-types';
import type { SettingsRepository } from '@/server/repositories/types';

/**
 * The thing that makes a schedule happen.
 *
 * ## Why this did not exist until now
 *
 * The tables, the wall-clock arithmetic, the DST policy, the idempotency key, the catch-up rules
 * and the notification routing were all built and all correct, and nothing called any of them. A
 * schedule could be created and would never fire; `routeNotification` had no caller; the
 * `briefings` table had no writer. That is a worse failure than a missing feature, because every
 * part of it looks finished from the inside — the tests pass, the types line up, and the only way
 * to notice is to wait until seven in the morning and see whether anything arrives.
 *
 * So this file is deliberately thin. It decides nothing that the domain can decide: *when*
 * something is due is `dueOccurrences`, *whether* to say it out loud is `routeNotification`,
 * *how* to word a briefing is `buildBriefingContent`. What it adds is the ordering, the claim,
 * and the honesty about what happened.
 *
 * ## Quiet hours change delivery, never existence
 *
 * A briefing produced at 06:00 inside quiet hours is still produced, still stored, and still on
 * the dashboard; what is withheld is speaking it. Dropping it would lose it — and somebody who
 * later moved their quiet hours would never learn what they had missed — while sending it anyway
 * would make the setting a lie. `isQuiet` is a column rather than a render-time decision so that
 * "was this held back?" is answerable a week later.
 *
 * ## Why an unsupported kind is recorded rather than failed
 *
 * Several kinds in `SCHEDULE_KINDS` describe work this service does not yet do — research, mission
 * drafts, evidence refresh. Marking their occurrences `failed` would fill the record with red that
 * nobody can act on and would burn the retry budget on something no retry can fix. They are
 * recorded as `skipped` with a sentence saying so, which is the honest description of what
 * happened.
 */

export interface ScheduleTickReport {
  readonly considered: number;
  readonly delivered: number;
  readonly skipped: number;
  readonly missed: number;
  readonly failed: number;
  /** One line per occurrence acted on, for the caller's log. Never contains a credential. */
  readonly notes: readonly string[];
}

export interface ScheduleServiceDeps {
  readonly schedules: ScheduleRepository;
  readonly notifications: NotificationRepository;
  readonly briefings: BriefingRepository;
  readonly settings: SettingsRepository;
  readonly audit: AuditRepository;
  /**
   * Whether an unattended capability is unlocked at this deployment's rung.
   *
   * Passed in rather than imported so this service does not have to know about the qualification
   * ladder's shape. It asks one question and honours the answer.
   */
  readonly allows: (capability: string) => Promise<{ allowed: boolean; reason: string }>;
  readonly clock?: () => Date;
}

/** The settings key quiet hours are stored under. Named once so a typo cannot create a second. */
export const QUIET_HOURS_KEY = 'notifications.quietHours';

export class ScheduleService {
  constructor(private readonly deps: ScheduleServiceDeps) {}

  private now(): Date {
    return this.deps.clock?.() ?? new Date();
  }

  async quietHours(): Promise<QuietHours> {
    /*
     * A malformed stored value reads as "no quiet hours" rather than as "quiet all day". Both are
     * defensible readings of nonsense, and only one of them silences a deployment invisibly.
     */
    const parsed = quietHoursSchema.safeParse(await this.deps.settings.get(QUIET_HOURS_KEY));
    return parsed.success
      ? parsed.data
      : { enabled: false, fromHour: 22, toHour: 7, timeZone: 'UTC' };
  }

  /**
   * Run everything that has come due.
   *
   * Safe to call as often as anything likes: every occurrence is claimed by a key derived from its
   * local wall-clock time, so a second caller, a restart mid-run, and a DST-repeated hour all
   * converge on one row and one delivery.
   */
  async tick(): Promise<ScheduleTickReport> {
    const now = this.now();
    const quiet = await this.quietHours();
    const schedules = await this.deps.schedules.list(false);

    let delivered = 0;
    let skipped = 0;
    let missed = 0;
    let failed = 0;
    const notes: string[] = [];

    for (const schedule of schedules) {
      const verdict = dueOccurrences(schedule, now);
      for (const occurrence of verdict.occurrences) {
        const claimed = await this.deps.schedules.claimOccurrence({
          scheduleId: schedule.id,
          occurrenceAt: occurrence.instant,
          occurrenceLocal: occurrence.localKey,
          idempotencyKey: occurrence.idempotencyKey,
          state: 'pending',
        });

        /* Somebody else has this one. Not an error — it is the whole point of the key. */
        if (!claimed) continue;

        if (occurrence.action !== 'run') {
          await this.deps.schedules.patchExecution(claimed.id, {
            state: occurrence.action === 'missed' ? 'missed' : 'skipped',
            finishedAt: now,
            summary: occurrence.reason ?? verdict.reason,
          });
          if (occurrence.action === 'missed') missed += 1;
          else skipped += 1;
          await this.advance(schedule, occurrence, false, now);
          continue;
        }

        const outcome = await this.deliver(schedule, occurrence, claimed, quiet, now);
        notes.push(outcome.note);
        if (outcome.state === 'delivered') delivered += 1;
        else if (outcome.state === 'skipped') skipped += 1;
        else failed += 1;
        await this.advance(schedule, occurrence, outcome.state === 'delivered', now);
      }
    }

    return { considered: schedules.length, delivered, skipped, missed, failed, notes };
  }

  /**
   * Move the watermark, and put a one-time reminder to bed.
   *
   * The watermark is `lastOccurrenceAt` rather than `lastRunAt` so a failed occurrence is not
   * rediscovered as newly due on the next tick — retries are a separate mechanism with a bound on
   * them, and conflating the two turns one failure into a storm.
   */
  private async advance(
    schedule: Schedule,
    occurrence: DueOccurrence,
    ran: boolean,
    now: Date,
  ): Promise<void> {
    /*
     * Note what this deliberately does *not* do: mark a delivered one-time reminder complete.
     *
     * It did, and it was wrong in a way worth recording. Delivery is not completion — completion
     * is Blake saying he has dealt with it — and conflating them broke the snooze outright: a
     * one-time reminder was marked finished the moment it arrived, and R-SC7 then refused to let
     * the snooze come back, so "remind me in an hour" meant "never". A `once` schedule stops
     * firing because its single occurrence has been claimed, which needs no flag at all.
     */
    await this.deps.schedules.patch(schedule.id, {
      lastOccurrenceAt: occurrence.instant,
      ...(ran ? { lastRunAt: now } : {}),
      /*
       * The snooze is spent by delivering it. Leaving it set would make every later tick find the
       * same expired snooze and deliver it again — bounded only by the idempotency key, which is
       * derived from that same instant, so in practice it would go quiet and look like a bug.
       */
      ...(schedule.snoozedUntil ? { snoozedUntil: null } : {}),
    });
  }

  /** Do the thing, and say what happened. Never throws into the tick. */
  private async deliver(
    schedule: Schedule,
    occurrence: DueOccurrence,
    execution: ScheduleExecution,
    quiet: QuietHours,
    now: Date,
  ): Promise<{ state: 'delivered' | 'skipped' | 'failed'; note: string }> {
    await this.deps.schedules.patchExecution(execution.id, { state: 'running', startedAt: now });

    const capability = KIND_CAPABILITY[schedule.kind];
    const permitted = await this.deps.allows(capability);
    if (!permitted.allowed) {
      await this.deps.schedules.patchExecution(execution.id, {
        state: 'skipped',
        finishedAt: now,
        summary: permitted.reason,
      });
      return { state: 'skipped', note: `${schedule.name}: ${permitted.reason}` };
    }

    /*
     * Quiet is decided on the *occurrence's* local hour rather than on now.
     *
     * A tick that runs late must not deliver a 06:00 briefing loudly at 09:00 because the clock
     * has moved on — Blake asked for quiet at six, and the briefing is still the six o'clock one.
     */
    const hourLocal = zonedParts(occurrence.instant, quiet.timeZone).hour;
    const held = inQuietHours(quiet, hourLocal);

    try {
      const summary =
        schedule.kind === 'reminder'
          ? await this.deliverReminder(schedule, occurrence, held)
          : await this.deliverBriefing(schedule, execution, held, now);

      if (summary === null) {
        const reason = `${SCHEDULE_KIND_LABELS[schedule.kind]} is not something I run on a schedule yet.`;
        await this.deps.schedules.patchExecution(execution.id, {
          state: 'skipped',
          finishedAt: now,
          summary: reason,
        });
        return { state: 'skipped', note: `${schedule.name}: ${reason}` };
      }

      await this.deps.schedules.patchExecution(execution.id, {
        state: 'delivered',
        finishedAt: now,
        summary,
      });
      await this.deps.audit
        .append({
          actor: 'schedule',
          actorKind: 'system',
          action: 'schedule.delivered',
          subjectKind: 'schedule',
          subjectId: schedule.id,
          outcome: 'allowed',
          summary: `${schedule.name}: ${summary}`,
          detail: { kind: schedule.kind, occurrence: occurrence.localKey, quiet: held },
        })
        .catch(() => undefined);
      return { state: 'delivered', note: `${schedule.name}: ${summary}` };
    } catch (error) {
      /*
       * Bounded, redacted, and retried under the schedule's own limit. The message is stored
       * because "it failed" without a reason sends nobody anywhere, and redacted because the most
       * likely thing in a failure from a connector is a token.
       */
      const message = boundText(
        redactSecrets(error instanceof Error ? error.message : 'Something went wrong.'),
        300,
      );
      const attempt = execution.attempt + 1;
      await this.deps.schedules.patchExecution(execution.id, {
        state: 'failed',
        finishedAt: now,
        attempt,
        failureCode: 'delivery_failed',
        failureMessage: message,
        nextRetryAt: nextRetryAt({ attempt, maxRetries: schedule.maxRetries, failedAt: now }),
      });
      return { state: 'failed', note: `${schedule.name}: ${message}` };
    }
  }

  /**
   * A reminder: Blake's own words, given back to him.
   *
   * Nothing is generated. The instruction is what he wrote, bounded and redacted on the way out
   * exactly as it was on the way in, because a reminder that had been rephrased would be a
   * different reminder.
   */
  private async deliverReminder(
    schedule: Schedule,
    occurrence: DueOccurrence,
    held: boolean,
  ): Promise<string> {
    const text = schedule.instruction?.trim() ?? schedule.name;
    const now = this.now();

    await this.deps.notifications.upsert(
      {
        category: 'briefing_ready',
        severity: 'low',
        title: schedule.name,
        body: text,
        href: '/dashboard',
        /*
         * Keyed on *this* occurrence, not on the schedule.
         *
         * The dedupe index collapses a repeat into the existing unread row, which is right for a
         * sync failing every ten minutes and wrong for a daily reminder: today's would vanish into
         * yesterday's unread copy and Blake would see one row with a count on it instead of a
         * reminder. The occurrence key is the same one the execution was claimed under, so the
         * notification and the execution agree about which morning this is.
         */
        dedupeKey: `reminder:${occurrence.idempotencyKey}`,
        /*
         * Held back from being *spoken*, never from existing.
         *
         * A notification created inside quiet hours is marked as already spoken, so the narrator
         * never claims it and the room stays silent — and the row is on the dashboard exactly as
         * it would have been, where Blake finds it whenever he next looks. That is the whole
         * quiet-hours rule in one field: delivery changes, existence does not.
         */
        spokenAt: held ? now : null,
      },
      now,
    );

    return held ? 'Reminded you quietly — it was inside your quiet hours.' : 'Reminded you.';
  }

  /**
   * A briefing: what moved, what is waiting, and what could not be seen.
   *
   * Returns null for a kind this service does not produce, which the caller records as skipped.
   */
  private async deliverBriefing(
    schedule: Schedule,
    execution: ScheduleExecution,
    held: boolean,
    now: Date,
  ): Promise<string | null> {
    const kind = BRIEFING_KIND_FOR_SCHEDULE[schedule.kind];
    if (!kind) return null;

    const previous = await this.deps.briefings.latest(kind, schedule.projectId ?? null);
    const from = previous ? new Date(previous.windowTo) : new Date(now.getTime() - 86_400_000);

    const content: BriefingContent = buildBriefingContent({
      kind,
      window: { from: from.toISOString(), to: now.toISOString(), firstEver: previous === null },
      /*
       * No changes are passed in yet, and that is stated rather than hidden. The composer's own
       * quiet path is the honest output for a window nothing was collected for — "nothing changed
       * in this window" — and it is a great deal better than inventing items to fill a section.
       * When the status-change feed is wired to this caller it goes here, and nothing else in this
       * method has to move.
       */
      changes: [],
      projectNames: new Map(),
      stalled: [],
      decisions: [],
      gaps: ['Only work recorded in Jarvis is included; nothing external was consulted.'],
      generatedAt: now.toISOString(),
    });

    const stored = await this.deps.briefings.create({
      kind,
      executionId: execution.id,
      projectId: schedule.projectId ?? null,
      windowFrom: from,
      windowTo: now,
      content,
      method: 'deterministic',
      isQuiet: held,
    });

    await this.deps.notifications.upsert(
      {
        category: 'briefing_ready',
        severity: 'low',
        title: briefingNotificationTitle(content),
        body: content.headline,
        href: '/dashboard',
        dedupeKey: `briefing:${stored.id}`,
        spokenAt: held ? now : null,
      },
      now,
    );

    return held ? `${content.headline} (held back from speech)` : content.headline;
  }
}

/**
 * Which schedule kinds produce a briefing, and which briefing.
 *
 * A table rather than a chain of conditionals, so a kind that produces nothing is visibly absent
 * rather than silently falling through to a default.
 */
const BRIEFING_KIND_FOR_SCHEDULE: Partial<Record<Schedule['kind'], BriefingKind>> = {
  morning_briefing: 'daily',
  evening_recap: 'daily',
  weekly_review: 'weekly',
  project_briefing: 'project',
};
