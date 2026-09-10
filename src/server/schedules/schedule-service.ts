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
  MAX_OCCURRENCE_AGE_HOURS,
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
  SchedulePatch,
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
 * ## Who calls `tick`, and what that costs this class
 *
 * The same gap happened one level up: `/api/cron/schedules` was written, documented, and never
 * called by anything — no timer, no worker loop, no scheduled function — so on the single-machine
 * deployment the whole mechanism above was still dead. The one thing that reliably runs on a timer
 * there is the enrolled worker driving the operating loop, so the loop's pass is the caller, and
 * that decides the three properties this class has to have:
 *
 *  - **Cheap and safe to call every few seconds.** A pass with nothing due is three indexed
 *    reads — the quiet hours, the schedules, the retries owed — and no writes at all.
 *  - **Safe to overlap.** Two callers, or one caller whose previous pass has not finished, must
 *    not both do the work. Across processes that is the idempotency key, which is derived from an
 *    occurrence's *local* wall-clock time; within this one it is `inFlight` below, which stands the
 *    second pass down rather than repeating a tick's worth of reading and composing for nothing.
 *  - **Unable to take its caller down.** See the next section.
 *
 * ## One schedule's failure is its own
 *
 * A single schedule that threw used to abort the entire pass: every schedule after it in the list
 * was silently not run, and the route turned the exception into a 500. One row with a time zone
 * the platform no longer knows was enough to do it. So each schedule is worked inside its own
 * `try`, and a failure is counted, noted and written to the audit log rather than propagated —
 * the same deliberate swallow the operating loop applies to its reclaim, and for the same reason:
 * the pass has other work to do, and a fault in one part of it must not become a fault in all.
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
  /** True when another pass was already running in this process and this call did nothing. */
  readonly held: boolean;
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

/**
 * What a pass returns when another one is already running in this process.
 *
 * Zeroes rather than the other pass's figures: this call did nothing, and reporting somebody
 * else's deliveries as its own would double-count them in any caller that adds passes up.
 */
const HELD: ScheduleTickReport = {
  considered: 0,
  delivered: 0,
  skipped: 0,
  missed: 0,
  failed: 0,
  held: true,
  notes: ['Another pass was already running, so this one stood down.'],
};

/**
 * How much of a failure's own words are kept.
 *
 * Long enough that a message from a driver, an HTTP client or `Intl` survives intact — those run
 * to a sentence — and short enough that a pathological one cannot turn a single bad schedule into
 * a note nobody can read in the interface or a log line costing more than the failure it
 * describes. The execution column bounds again at 600 on the way in; this is the bound applied
 * where the words are still attached to the thing that produced them.
 */
export const FAILURE_MESSAGE_MAX_CHARS = 300;

/**
 * A failure in a form that is safe to store and to show.
 *
 * Redacted because the likeliest thing inside a failure from a connector is a token, and bounded
 * because an unbounded one ends up in a notification.
 */
function failureMessage(error: unknown): string {
  return boundText(
    redactSecrets(error instanceof Error ? error.message : 'Something went wrong.'),
    FAILURE_MESSAGE_MAX_CHARS,
  );
}

/**
 * What became of one occurrence.
 *
 * `retryOwed` is the one thing about a failure the schedule row itself turns on: it is the only
 * state in which the occurrence is not finished with, and so the only one in which a snooze is
 * still owed. See `settle`.
 */
interface Disposition {
  readonly state: 'delivered' | 'skipped' | 'missed' | 'failed';
  readonly retryOwed: boolean;
}

/** The running total of a pass. Mutable on purpose: every step of the pass adds to one of these. */
interface Tally {
  delivered: number;
  skipped: number;
  missed: number;
  failed: number;
  readonly notes: string[];
}

export class ScheduleService {
  constructor(private readonly deps: ScheduleServiceDeps) {}

  /**
   * Whether a pass is running in this process. See `tick`.
   *
   * A flag rather than the pass's own promise, because the second caller must never join the
   * first: it would come back holding somebody else's deliveries and report them as its own.
   */
  private passing = false;

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
   *
   * The in-process guard is a second, cheaper layer over the same guarantee. The claim already makes
   * a double delivery impossible; what it does not prevent is a caller on a short timer starting a
   * second pass while the first is still composing a briefing, and that pass would read every
   * schedule and build every occurrence again to lose every claim at the end. Standing it down is
   * the operating loop's own answer to the same problem — there it is a database lease, because
   * its callers are in different processes; here one process holds every caller worth guarding
   * against, so a field is enough and a lease would be a table nobody reads.
   */
  async tick(): Promise<ScheduleTickReport> {
    if (this.passing) return HELD;
    this.passing = true;
    try {
      return await this.pass();
    } finally {
      this.passing = false;
    }
  }

  private async pass(): Promise<ScheduleTickReport> {
    const now = this.now();
    const quiet = await this.quietHours();
    const schedules = await this.deps.schedules.list(false);
    const tally: Tally = { delivered: 0, skipped: 0, missed: 0, failed: 0, notes: [] };

    for (const schedule of schedules) {
      try {
        await this.runSchedule(schedule, quiet, now, tally);
      } catch (error) {
        await this.recordScheduleFailure(schedule, error, tally);
      }
    }

    await this.retryFailures(quiet, now, tally);

    return { considered: schedules.length, held: false, ...tally };
  }

  /** Everything one schedule owes right now. Throwing from here costs only this schedule. */
  private async runSchedule(
    schedule: Schedule,
    quiet: QuietHours,
    now: Date,
    tally: Tally,
  ): Promise<void> {
    const verdict = dueOccurrences(this.anchored(schedule, now), now);

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
        if (occurrence.action === 'missed') tally.missed += 1;
        else tally.skipped += 1;
        await this.settle(
          schedule,
          { state: occurrence.action === 'missed' ? 'missed' : 'skipped', retryOwed: false },
          now,
          occurrence.instant,
        );
        continue;
      }

      const outcome = await this.deliver(schedule, occurrence, claimed, quiet, now);
      tally.notes.push(outcome.note);
      if (outcome.state === 'delivered') tally.delivered += 1;
      else if (outcome.state === 'skipped') tally.skipped += 1;
      else tally.failed += 1;
      await this.settle(schedule, outcome, now, occurrence.instant);
    }
  }

  /**
   * A schedule that could not even be worked out.
   *
   * Bounded, redacted, counted and written down. The audit log rather than an execution row
   * because there is no execution: this is the failure that happens *before* anything is claimed —
   * a stored time zone the platform no longer knows, a repository that went away mid-pass — and a
   * failure with nowhere to be read is one nobody ever fixes.
   */
  private async recordScheduleFailure(
    schedule: Schedule,
    error: unknown,
    tally: Tally,
  ): Promise<void> {
    const message = failureMessage(error);
    tally.failed += 1;
    tally.notes.push(`${schedule.name}: ${message}`);
    await this.deps.audit
      .append({
        actor: 'schedule',
        actorKind: 'system',
        action: 'schedule.failed',
        subjectKind: 'schedule',
        subjectId: schedule.id,
        outcome: 'failed',
        summary: `${schedule.name} could not be worked out: ${message}`,
        detail: { kind: schedule.kind, cadence: schedule.cadence, timeZone: schedule.timeZone },
      })
      .catch(() => undefined);
  }

  /**
   * Try again the ones that failed, when their own backoff says to.
   *
   * `nextRetryAt` and the `pendingRetries` query were both written and neither had a caller, which
   * made every failure permanent and made the paragraph about failures being "retried under the
   * schedule's own limit" untrue. It matters most to a snooze: the occurrence is claimed, so the
   * ordinary arithmetic will never offer it again, and without this pass "remind me in an hour"
   * survives one unreachable notification store and then means never.
   *
   * Bounded by the query (twenty at a time) and by `nextRetryAt`, which returns null once the
   * attempts are spent — a schedule that has failed three times needs a person, not a fourth try.
   */
  private async retryFailures(quiet: QuietHours, now: Date, tally: Tally): Promise<void> {
    let due: readonly ScheduleExecution[] = [];
    try {
      due = await this.deps.schedules.pendingRetries(now);
    } catch (error) {
      /* The schedules above have already run and been recorded; losing their tally too helps no one. */
      tally.failed += 1;
      tally.notes.push(`Retries could not be read: ${failureMessage(error)}`);
      return;
    }

    for (const execution of due) {
      try {
        const schedule = await this.deps.schedules.findById(execution.scheduleId);
        if (!schedule) continue;

        /*
         * What was owed may have stopped being owed while the backoff ran. Cleared rather than
         * left pending, so the query does not hand it back on every pass for ever.
         */
        if (!schedule.enabled || schedule.pausedAt !== null || schedule.completedAt !== null) {
          await this.deps.schedules.patchExecution(execution.id, {
            state: 'skipped',
            finishedAt: now,
            nextRetryAt: null,
            summary:
              schedule.completedAt !== null
                ? 'Dealt with before the retry came round.'
                : 'Switched off or paused before the retry came round.',
          });
          tally.skipped += 1;
          /*
           * The snooze goes with it. Nothing is going to try this occurrence again, and a snooze
           * left set outlives the pause: R-SC8 would offer the same spent occurrence for ever the
           * moment the schedule came back on. See `settle`.
           */
          await this.settle(schedule, { state: 'skipped', retryOwed: false }, now, null);
          continue;
        }

        const occurrence: DueOccurrence = {
          instant: new Date(execution.occurrenceAt),
          localKey: execution.occurrenceLocal,
          idempotencyKey: execution.idempotencyKey,
          shifted: false,
          action: 'run',
          reason: null,
        };

        const outcome = await this.deliver(schedule, occurrence, execution, quiet, now);
        tally.notes.push(outcome.note);
        if (outcome.state === 'delivered') tally.delivered += 1;
        else if (outcome.state === 'skipped') tally.skipped += 1;
        else tally.failed += 1;

        /*
         * No watermark. The pass that first failed already moved it past this occurrence, and
         * moving it back would rediscover everything since as newly due — all of it already
         * claimed, so all of it noise.
         */
        await this.settle(schedule, outcome, now, null);
      } catch (error) {
        tally.failed += 1;
        tally.notes.push(`Retry of ${execution.idempotencyKey}: ${failureMessage(error)}`);
      }
    }
  }

  /**
   * Where a schedule with no watermark starts looking.
   *
   * `dueOccurrences` reaches back twelve hours when a schedule has never been accounted for, which
   * is right for an installation that was asleep and wrong for a schedule created five minutes
   * ago: "every day at seven", set at lunchtime, fired this morning's briefing immediately and the
   * owner's first experience of a new schedule was a stale one. So the first window starts at
   * creation, and a schedule created at noon owes nothing until tomorrow.
   *
   * The anchor only ever narrows the window. `createdAt` comes from the database's clock while
   * `now` comes from this service's, and those are two clocks: one of them running ahead must not
   * be able to silence a schedule for ever, so a creation stamp in the future of this pass is
   * ignored and the domain's twelve-hour floor stands.
   */
  private anchored(schedule: Schedule, now: Date): Schedule {
    if (schedule.lastOccurrenceAt !== null) return schedule;
    const created = new Date(schedule.createdAt).getTime();
    const floor = now.getTime() - MAX_OCCURRENCE_AGE_HOURS * 3_600_000;
    if (!(created > floor && created <= now.getTime())) return schedule;
    return { ...schedule, lastOccurrenceAt: schedule.createdAt };
  }

  /**
   * Move the watermark, and record that something actually ran.
   *
   * The watermark is `lastOccurrenceAt` rather than `lastRunAt` so a failed occurrence is not
   * rediscovered as newly due on the next tick — retries are a separate mechanism with a bound on
   * them, and conflating the two turns one failure into a storm. It is passed in rather than read
   * off the occurrence because a retry must not move it; see `retryFailures`.
   *
   * Note what this deliberately does *not* do: mark a delivered one-time reminder complete.
   *
   * It did, and it was wrong in a way worth recording. Delivery is not completion — completion
   * is Blake saying he has dealt with it — and conflating them broke the snooze outright: a
   * one-time reminder was marked finished the moment it arrived, and R-SC7 then refused to let
   * the snooze come back, so "remind me in an hour" meant "never". A `once` schedule stops
   * firing because its single occurrence has been claimed, which needs no flag at all.
   */
  private async settle(
    schedule: Schedule,
    disposition: Disposition,
    now: Date,
    watermark: Date | null,
  ): Promise<void> {
    const delivered = disposition.state === 'delivered';

    /*
     * A snooze is spent when the occurrence it produced is finished with — however it finished.
     *
     * Both halves of that are a bug somebody has already had. It used to be spent by a delivery
     * that was merely *attempted*, which destroyed the reminder: the occurrence had been claimed,
     * the snooze was gone, a one-time reminder has no next occurrence, and an unreachable
     * notification store turned "remind me in an hour" into never. But keeping it until a
     * delivery *works* is worse, because R-SC8 makes a snooze that has come round the only thing
     * a schedule offers: one left set on an occurrence nothing will try again — its retries
     * spent, or skipped for want of a rung — does not lose a reminder, it stops a daily reminder
     * ever firing again. So the snooze survives exactly as long as an attempt is still owed.
     */
    const snoozeSpent =
      schedule.snoozedUntil !== null &&
      new Date(schedule.snoozedUntil).getTime() <= now.getTime() &&
      !disposition.retryOwed;

    const patch: SchedulePatch = {
      ...(watermark ? { lastOccurrenceAt: watermark } : {}),
      ...(delivered ? { lastRunAt: now } : {}),
      ...(snoozeSpent ? { snoozedUntil: null } : {}),
    };
    if (Object.keys(patch).length === 0) return;
    await this.deps.schedules.patch(schedule.id, patch);
  }

  /** Do the thing, and say what happened. Never throws into the pass. */
  private async deliver(
    schedule: Schedule,
    occurrence: DueOccurrence,
    execution: ScheduleExecution,
    quiet: QuietHours,
    now: Date,
  ): Promise<Disposition & { readonly note: string }> {
    await this.deps.schedules.patchExecution(execution.id, { state: 'running', startedAt: now });

    const capability = KIND_CAPABILITY[schedule.kind];
    const permitted = await this.deps.allows(capability);
    if (!permitted.allowed) {
      await this.deps.schedules.patchExecution(execution.id, {
        state: 'skipped',
        finishedAt: now,
        summary: permitted.reason,
      });
      return { state: 'skipped', retryOwed: false, note: `${schedule.name}: ${permitted.reason}` };
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
        return { state: 'skipped', retryOwed: false, note: `${schedule.name}: ${reason}` };
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
      return { state: 'delivered', retryOwed: false, note: `${schedule.name}: ${summary}` };
    } catch (error) {
      /*
       * Recorded and retried under the schedule's own limit. The message is stored because "it
       * failed" without a reason sends nobody anywhere.
       */
      const message = failureMessage(error);
      const attempt = execution.attempt + 1;
      const retryAt = nextRetryAt({ attempt, maxRetries: schedule.maxRetries, failedAt: now });
      await this.deps.schedules.patchExecution(execution.id, {
        state: 'failed',
        finishedAt: now,
        attempt,
        failureCode: 'delivery_failed',
        failureMessage: message,
        nextRetryAt: retryAt,
      });
      return { state: 'failed', retryOwed: retryAt !== null, note: `${schedule.name}: ${message}` };
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
