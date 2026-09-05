import { z } from 'zod';
import { ValidationError } from './errors';
import type { ActivationCapability } from './qualification';

/**
 * Scheduled work, and the arithmetic that makes "every weekday at 07:30" mean what it says.
 *
 * Three problems have to be solved properly here, and each has a wrong answer that looks right
 * for about eleven months.
 *
 * **Timezones.** A schedule is a *wall-clock* intention: 07:30 where I live, not 07:30 UTC. So a
 * schedule stores an IANA zone and the arithmetic runs through `Intl.DateTimeFormat`, which is
 * built into the platform and knows the actual rules. Storing a UTC offset instead is the bug
 * that fires an hour late for half the year.
 *
 * **Daylight saving.** Twice a year a local time either does not exist or exists twice, and both
 * need a stated policy rather than whatever the arithmetic happens to do:
 *
 *  - *Spring forward.* 02:30 on the morning the clocks skip 02:00→03:00 never happens. Jarvis runs
 *    at the first instant that does exist, so a briefing scheduled for 02:30 arrives at 03:00
 *    rather than vanishing for a day.
 *  - *Fall back.* 01:30 happens twice. Jarvis runs on the **first** one, and — this is the part
 *    that matters — the idempotency key is derived from the *local wall-clock occurrence*, not
 *    from the instant. Both 01:30s produce the same key, so the second is recognised as a
 *    duplicate and dropped. The job runs once, which is what "every day at 01:30" means.
 *
 * **Missed runs.** A serverless deployment does not guarantee a tick. When Jarvis wakes up and
 * finds three occurrences it slept through, running all three is almost never wanted and silently
 * running none is worse. So the catch-up policy is explicit, per schedule, and the default runs
 * only the most recent — with the skipped ones recorded as `missed` so the record is honest.
 *
 * Pure and Node-free. The service claims, executes and retries; every question about *when* and
 * *whether* is answered here where it can be tested against a fixed clock.
 */

/* -------------------------------------------------------------------- kinds */

export const SCHEDULE_KINDS = [
  'morning_briefing',
  'evening_recap',
  'weekly_review',
  'project_briefing',
  /** Refresh GitHub evidence. The only kind that runs before qualification. */
  'evidence_refresh',
  /** Read-only research on a project. Needs live-read qualification. */
  'research',
  /** Produce a mission draft for me to review. Needs live-read qualification. */
  'mission_draft',
  /** Check operational health and alert on failures. */
  'health_check',
  /** Knowledge review: expiring operational facts, unresolved conflicts. */
  'knowledge_review',
] as const;
export type ScheduleKind = (typeof SCHEDULE_KINDS)[number];

export const SCHEDULE_KIND_LABELS: Record<ScheduleKind, string> = {
  morning_briefing: 'Morning briefing',
  evening_recap: 'End-of-day recap',
  weekly_review: 'Weekly review',
  project_briefing: 'Project briefing',
  evidence_refresh: 'Refresh evidence',
  research: 'Read-only research',
  mission_draft: 'Draft a mission',
  health_check: 'Health check',
  knowledge_review: 'Review knowledge',
};

/**
 * What each kind is allowed to do.
 *
 * This is the map that makes "a schedule is not blanket permission to change code" enforceable.
 * A schedule declares a kind, the kind declares a capability, and the capability is checked
 * against the qualification level at dispatch. Nothing here reaches `model_task_write`,
 * `github_write`, `ci_dispatch` or `testflight_dispatch` — not because those are hard, but
 * because an unattended schedule is the wrong place for them.
 */
export const KIND_CAPABILITY: Record<ScheduleKind, ActivationCapability> = {
  morning_briefing: 'scheduled_briefing',
  evening_recap: 'scheduled_briefing',
  weekly_review: 'scheduled_briefing',
  project_briefing: 'scheduled_briefing',
  evidence_refresh: 'scheduled_evidence_refresh',
  research: 'scheduled_research',
  mission_draft: 'scheduled_mission_draft',
  health_check: 'scheduled_notification',
  knowledge_review: 'scheduled_briefing',
};

/** Kinds that need a project. A project briefing about nothing is not a thing. */
export const PROJECT_SCOPED_KINDS = [
  'project_briefing',
  'research',
  'mission_draft',
] as const satisfies readonly ScheduleKind[];

/* ------------------------------------------------------------------ cadence */

export const CADENCES = ['daily', 'weekdays', 'weekly', 'monthly'] as const;
export type Cadence = (typeof CADENCES)[number];

export const CADENCE_LABELS: Record<Cadence, string> = {
  daily: 'Every day',
  weekdays: 'Weekdays',
  weekly: 'Once a week',
  monthly: 'Once a month',
};

export const CATCH_UP_POLICIES = [
  /** Run only the most recent missed occurrence. The default, and almost always right. */
  'run_latest',
  /** Record every missed occurrence and run none of them. */
  'skip_missed',
  /** Run every missed occurrence in order. Bounded by `MAX_CATCH_UP`. */
  'run_all',
] as const;
export type CatchUpPolicy = (typeof CATCH_UP_POLICIES)[number];

export const CATCH_UP_LABELS: Record<CatchUpPolicy, string> = {
  run_latest: 'Run the most recent one it missed',
  skip_missed: 'Skip anything it missed',
  run_all: 'Run everything it missed',
};

/** However far behind Jarvis is, it will not run more than this many at once. */
export const MAX_CATCH_UP = 3;

/**
 * How stale an occurrence may be and still run.
 *
 * A morning briefing delivered at 4pm is not a morning briefing; it is confusing. Past this, the
 * occurrence is recorded `missed` with the reason.
 */
export const MAX_OCCURRENCE_AGE_HOURS = 12;

/* ------------------------------------------------------------------ records */

export interface Schedule {
  readonly id: string;
  readonly kind: ScheduleKind;
  readonly name: string;
  readonly enabled: boolean;
  readonly cadence: Cadence;
  /** Local wall-clock time in `timeZone`. Minutes are not optional; 7 is not 07:00. */
  readonly hour: number;
  readonly minute: number;
  /** IANA zone. Validated at write time against the platform's own database. */
  readonly timeZone: string;
  /** 0 = Sunday. Used by `weekly`; ignored otherwise. */
  readonly weekday: number | null;
  /** 1-28 for `monthly`. Capped at 28 so every month has the day. */
  readonly dayOfMonth: number | null;
  readonly projectId: string | null;
  readonly catchUp: CatchUpPolicy;
  readonly maxRetries: number;
  /** Only for `research` and `mission_draft`: what to look into. */
  readonly instruction: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lastRunAt: string | null;
  /** The last occurrence Jarvis has *accounted for*, run or missed. The catch-up watermark. */
  readonly lastOccurrenceAt: string | null;
  readonly pausedAt: string | null;
  readonly pausedReason: string | null;
}

export const EXECUTION_STATES = [
  'pending',
  'running',
  'delivered',
  /** Produced something, but a delivery channel failed. The work is not repeated. */
  'partially_delivered',
  'failed',
  /** Its window passed without Jarvis running it. Recorded so the gap is visible. */
  'missed',
  /** Deliberately not run: paused, unqualified, or superseded by catch-up policy. */
  'skipped',
] as const;
export type ExecutionState = (typeof EXECUTION_STATES)[number];

export const EXECUTION_STATE_LABELS: Record<ExecutionState, string> = {
  pending: 'Due',
  running: 'Running',
  delivered: 'Delivered',
  partially_delivered: 'Delivered, with a problem',
  failed: 'Failed',
  missed: 'Missed',
  skipped: 'Skipped',
};

export interface ScheduleExecution {
  readonly id: string;
  readonly scheduleId: string;
  readonly state: ExecutionState;
  /** The wall-clock occurrence this is for, as an instant. */
  readonly occurrenceAt: string;
  /** The occurrence's local time, which is what the idempotency key is built from. */
  readonly occurrenceLocal: string;
  readonly idempotencyKey: string;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly attempt: number;
  readonly nextRetryAt: string | null;
  readonly failureCode: string | null;
  readonly failureMessage: string | null;
  /** What the briefing looked at, so a later reader can tell what it could have known. */
  readonly evidenceWindowFrom: string | null;
  readonly evidenceWindowTo: string | null;
  readonly resultId: string | null;
  readonly summary: string | null;
  readonly createdAt: string;
}

/* ------------------------------------------------------------------ schemas */

/**
 * Is this a zone the platform actually knows?
 *
 * Asked of `Intl` rather than checked against a list, because a hard-coded list of zones is wrong
 * as soon as a government changes its mind, which they do.
 */
export function isValidTimeZone(value: string): boolean {
  if (!/^[A-Za-z][A-Za-z0-9_+/-]{1,60}$/.test(value)) return false;
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

export const scheduleSchema = z
  .object({
    kind: z.enum(SCHEDULE_KINDS),
    name: z.string().trim().min(2).max(80),
    cadence: z.enum(CADENCES),
    hour: z.number().int().min(0).max(23),
    minute: z.number().int().min(0).max(59),
    timeZone: z.string().trim().min(1).max(64).refine(isValidTimeZone, {
      message: 'That is not a timezone this system recognises. Use something like Europe/London.',
    }),
    weekday: z.number().int().min(0).max(6).nullish(),
    dayOfMonth: z.number().int().min(1).max(28).nullish(),
    projectId: z.string().uuid().nullish(),
    catchUp: z.enum(CATCH_UP_POLICIES).default('run_latest'),
    maxRetries: z.number().int().min(0).max(5).default(2),
    instruction: z.string().trim().max(2000).nullish(),
    enabled: z.boolean().default(true),
  })
  .refine((value) => value.cadence !== 'weekly' || value.weekday !== null, {
    message: 'A weekly schedule needs a day of the week.',
  })
  .refine((value) => value.cadence !== 'monthly' || value.dayOfMonth !== null, {
    message: 'A monthly schedule needs a day of the month.',
  })
  .refine(
    (value) =>
      !(PROJECT_SCOPED_KINDS as readonly ScheduleKind[]).includes(value.kind) ||
      Boolean(value.projectId),
    { message: 'That kind of schedule has to say which project.' },
  )
  .refine(
    (value) =>
      !(value.kind === 'research' || value.kind === 'mission_draft') ||
      (value.instruction?.trim().length ?? 0) >= 10,
    { message: 'Say what Jarvis should look into.' },
  );
export type ScheduleInput = z.infer<typeof scheduleSchema>;

export const schedulePauseSchema = z.object({
  paused: z.boolean(),
  reason: z.string().trim().max(300).nullish(),
});

export const scheduleRunNowSchema = z.object({
  /** Typed, because run-now on a research schedule starts a real agent. */
  confirmation: z.literal('run this now').optional(),
});

/* --------------------------------------------------------- timezone maths */

export interface ZonedParts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
  /** 0 = Sunday, to match `Date.prototype.getDay`. */
  readonly weekday: number;
}

const WEEKDAY_INDEX: Readonly<Record<string, number>> = Object.freeze({
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
});

/** What the clock reads in `timeZone` at this instant. */
export function zonedParts(instant: Date, timeZone: string): ZonedParts {
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    weekday: 'short',
  });
  const parts = new Map(
    formatter.formatToParts(instant).map((part) => [part.type, part.value] as const),
  );
  /* `24` appears for midnight in some ICU versions; normalise it to 0. */
  const hour = Number(parts.get('hour') ?? '0');
  return {
    year: Number(parts.get('year')),
    month: Number(parts.get('month')),
    day: Number(parts.get('day')),
    hour: hour === 24 ? 0 : hour,
    minute: Number(parts.get('minute') ?? '0'),
    second: Number(parts.get('second') ?? '0'),
    weekday: WEEKDAY_INDEX[parts.get('weekday') ?? 'Sun'] ?? 0,
  };
}

/** The zone's offset from UTC, in minutes, at a given instant. */
export function zoneOffsetMinutes(instant: Date, timeZone: string): number {
  const parts = zonedParts(instant, timeZone);
  const asUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  return Math.round((asUtc - instant.getTime()) / 60_000);
}

export interface ZonedResolution {
  readonly instant: Date;
  /** True when the requested local time does not exist — a spring-forward gap. */
  readonly shifted: boolean;
  /** True when it exists twice — a fall-back overlap. The earlier instant is returned. */
  readonly ambiguous: boolean;
}

/**
 * The instant at which a zone's clock reads this local time.
 *
 * Two iterations of offset correction, which is enough for every real zone: the first guess is
 * treated as UTC, the zone's offset *at that guess* is applied, and the offset is recomputed at
 * the corrected instant in case the correction crossed a transition.
 *
 * The two DST cases are then detected by reading the clock back:
 *
 *  - If the resulting instant's local time is **not** the one asked for, the requested time does
 *    not exist. Jarvis returns the first instant after the gap, so the work happens rather than
 *    silently not happening, and flags `shifted`.
 *  - If the instant one hour earlier reads the *same* local time, the time is ambiguous. The
 *    earlier of the two is returned, and `ambiguous` is flagged — the idempotency key stops the
 *    second one running.
 */
export function instantForZonedTime(input: {
  readonly timeZone: string;
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
}): ZonedResolution {
  const naive = Date.UTC(input.year, input.month - 1, input.day, input.hour, input.minute, 0);

  let instant = new Date(naive - zoneOffsetMinutes(new Date(naive), input.timeZone) * 60_000);
  instant = new Date(naive - zoneOffsetMinutes(instant, input.timeZone) * 60_000);

  const readBack = zonedParts(instant, input.timeZone);
  const matches =
    readBack.year === input.year &&
    readBack.month === input.month &&
    readBack.day === input.day &&
    readBack.hour === input.hour &&
    readBack.minute === input.minute;

  if (!matches) {
    /*
     * A gap: the requested local time does not exist on that day.
     *
     * The answer wanted is the *earliest* instant whose local clock reads at or after the
     * requested time — the moment an alarm set for 01:30 would go off on a morning the clocks
     * jump 01:00→02:00, which is 02:00 and not 02:30. Searching forward from the mis-resolved
     * instant gives the latter, because that instant is already past the transition; so the scan
     * starts comfortably *before* the gap and walks forward a minute at a time.
     *
     * Three hours of headroom either side covers every real transition (the largest on record is
     * an hour, and Lord Howe's is thirty minutes). A minute of granularity matches the finest
     * resolution a schedule can express, so the result is exact rather than rounded.
     */
    const wantedMinutes = input.hour * 60 + input.minute;
    const scanFrom = instant.getTime() - 3 * 3_600_000;
    for (let step = 0; step <= 360; step += 1) {
      const candidate = new Date(scanFrom + step * 60_000);
      const parts = zonedParts(candidate, input.timeZone);
      if (parts.year !== input.year || parts.month !== input.month || parts.day !== input.day) {
        continue;
      }
      if (parts.hour * 60 + parts.minute >= wantedMinutes) {
        return { instant: candidate, shifted: true, ambiguous: false };
      }
    }
    /* No instant on that local day reaches the requested time. Fall back to the naive result. */
    return { instant, shifted: true, ambiguous: false };
  }

  const anHourEarlier = new Date(instant.getTime() - 3_600_000);
  const earlierParts = zonedParts(anHourEarlier, input.timeZone);
  const ambiguous =
    earlierParts.hour === input.hour &&
    earlierParts.minute === input.minute &&
    earlierParts.day === input.day;

  return {
    instant: ambiguous ? anHourEarlier : instant,
    shifted: false,
    ambiguous,
  };
}

/** `2026-03-29T07:30` in the schedule's own zone. The basis of the idempotency key. */
export function localOccurrenceKey(instant: Date, timeZone: string): string {
  const parts = zonedParts(instant, timeZone);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}T${pad(parts.hour)}:${pad(parts.minute)}`;
}

/**
 * The idempotency key for one occurrence.
 *
 * Built from the schedule and the *local* occurrence, which is what makes the fall-back duplicate
 * impossible: two instants, one local time, one key, one execution row, one delivery.
 */
export function occurrenceIdempotencyKey(scheduleId: string, localKey: string): string {
  return `${scheduleId}:${localKey}`;
}

/* ------------------------------------------------------------- occurrences */

function matchesCadence(schedule: Schedule, parts: ZonedParts): boolean {
  switch (schedule.cadence) {
    case 'daily':
      return true;
    case 'weekdays':
      return parts.weekday >= 1 && parts.weekday <= 5;
    case 'weekly':
      return parts.weekday === schedule.weekday;
    case 'monthly':
      return parts.day === schedule.dayOfMonth;
  }
}

/**
 * Every occurrence in a window, oldest first.
 *
 * Walks *local calendar days* rather than adding 24-hour increments, because adding 24 hours
 * across a DST transition drifts by an hour and eventually skips or repeats a day. Bounded at 400
 * days so a caller passing a silly window cannot spin.
 */
export function occurrencesBetween(
  schedule: Pick<
    Schedule,
    'cadence' | 'hour' | 'minute' | 'timeZone' | 'weekday' | 'dayOfMonth'
  > & { readonly id?: string },
  fromExclusive: Date,
  toInclusive: Date,
): readonly { readonly instant: Date; readonly localKey: string; readonly shifted: boolean }[] {
  if (toInclusive.getTime() <= fromExclusive.getTime()) return [];

  const out: { instant: Date; localKey: string; shifted: boolean }[] = [];
  /* Start a day early: an occurrence just after `from` may belong to the previous local day. */
  const cursor = zonedParts(new Date(fromExclusive.getTime() - 86_400_000), schedule.timeZone);
  let { year, month, day } = cursor;

  for (let guard = 0; guard < 400; guard += 1) {
    const resolved = instantForZonedTime({
      timeZone: schedule.timeZone,
      year,
      month,
      day,
      hour: schedule.hour,
      minute: schedule.minute,
    });
    const parts = zonedParts(resolved.instant, schedule.timeZone);

    if (
      resolved.instant.getTime() > fromExclusive.getTime() &&
      resolved.instant.getTime() <= toInclusive.getTime() &&
      matchesCadence(schedule as Schedule, parts)
    ) {
      out.push({
        instant: resolved.instant,
        localKey: localOccurrenceKey(resolved.instant, schedule.timeZone),
        shifted: resolved.shifted,
      });
    }

    if (resolved.instant.getTime() > toInclusive.getTime()) break;

    /* Advance one local calendar day using UTC arithmetic on the date parts only. */
    const next = new Date(Date.UTC(year, month - 1, day + 1));
    year = next.getUTCFullYear();
    month = next.getUTCMonth() + 1;
    day = next.getUTCDate();
  }

  return out;
}

export function nextOccurrence(
  schedule: Pick<Schedule, 'cadence' | 'hour' | 'minute' | 'timeZone' | 'weekday' | 'dayOfMonth'>,
  after: Date,
): Date | null {
  const window = occurrencesBetween(schedule, after, new Date(after.getTime() + 400 * 86_400_000));
  return window[0]?.instant ?? null;
}

/* ------------------------------------------------------------------ due-ness */

export interface DueOccurrence {
  readonly instant: Date;
  readonly localKey: string;
  readonly idempotencyKey: string;
  readonly shifted: boolean;
  /** `pending` to run now, `missed` or `skipped` to record without running. */
  readonly action: 'run' | 'missed' | 'skipped';
  readonly reason: string | null;
}

export interface DueVerdict {
  readonly occurrences: readonly DueOccurrence[];
  readonly rule: string;
  readonly reason: string | null;
}

/**
 * What this schedule owes, right now.
 *
 * The rules:
 *
 *  - **R-SC1** — a disabled or paused schedule owes nothing.
 *  - **R-SC2** — nothing has come due since the watermark.
 *  - **R-SC3** — an occurrence older than `MAX_OCCURRENCE_AGE_HOURS` is `missed`, whatever the
 *    catch-up policy says. A briefing about this morning, delivered tomorrow, is noise.
 *  - **R-SC4** — `skip_missed`: everything but nothing runs; all recorded `missed`.
 *  - **R-SC5** — `run_latest`: the newest runs, the rest are `skipped` with a reason.
 *  - **R-SC6** — `run_all`: up to `MAX_CATCH_UP` run, any excess is `skipped`.
 *
 * The watermark is `lastOccurrenceAt` rather than `lastRunAt`, so a *failed* occurrence is not
 * re-discovered as newly due on the next tick — retries are handled by `nextRetryAt`, which is a
 * different mechanism with a bound on it. Conflating the two is how a failing schedule turns into
 * a retry storm.
 */
export function dueOccurrences(schedule: Schedule, now: Date): DueVerdict {
  if (!schedule.enabled || schedule.pausedAt !== null) {
    return {
      occurrences: [],
      rule: 'R-SC1',
      reason: schedule.pausedAt ? 'Paused.' : 'Switched off.',
    };
  }

  /*
   * With no watermark, start from the previous occurrence rather than from the beginning of time:
   * a schedule created this afternoon should not immediately deliver this morning's briefing.
   */
  const since = schedule.lastOccurrenceAt
    ? new Date(schedule.lastOccurrenceAt)
    : new Date(now.getTime() - MAX_OCCURRENCE_AGE_HOURS * 3_600_000);

  const found = occurrencesBetween(schedule, since, now);
  if (found.length === 0) {
    return { occurrences: [], rule: 'R-SC2', reason: null };
  }

  const ageLimitMs = MAX_OCCURRENCE_AGE_HOURS * 3_600_000;
  const decided: DueOccurrence[] = found.map((occurrence) => {
    const tooOld = now.getTime() - occurrence.instant.getTime() > ageLimitMs;
    return {
      instant: occurrence.instant,
      localKey: occurrence.localKey,
      idempotencyKey: occurrenceIdempotencyKey(schedule.id, occurrence.localKey),
      shifted: occurrence.shifted,
      action: tooOld ? 'missed' : 'run',
      reason: tooOld
        ? `More than ${MAX_OCCURRENCE_AGE_HOURS} hours late, so it is recorded rather than delivered.`
        : null,
    };
  });

  const runnable = decided.filter((occurrence) => occurrence.action === 'run');

  if (schedule.catchUp === 'skip_missed' && runnable.length > 1) {
    const [, ...older] = [...runnable].reverse();
    const skipped = new Set(older.map((occurrence) => occurrence.localKey));
    return {
      occurrences: decided.map((occurrence) =>
        skipped.has(occurrence.localKey)
          ? { ...occurrence, action: 'missed', reason: 'Skipped: this schedule does not catch up.' }
          : occurrence,
      ),
      rule: 'R-SC4',
      reason: 'Missed occurrences are recorded, not run.',
    };
  }

  if (schedule.catchUp === 'run_latest' && runnable.length > 1) {
    const newest = runnable[runnable.length - 1]!;
    return {
      occurrences: decided.map((occurrence) =>
        occurrence.action === 'run' && occurrence.localKey !== newest.localKey
          ? {
              ...occurrence,
              action: 'skipped',
              reason: 'Superseded by a more recent one.',
            }
          : occurrence,
      ),
      rule: 'R-SC5',
      reason: `${runnable.length - 1} older occurrence(s) superseded.`,
    };
  }

  if (schedule.catchUp === 'run_all' && runnable.length > MAX_CATCH_UP) {
    const keep = new Set(
      runnable.slice(runnable.length - MAX_CATCH_UP).map((occurrence) => occurrence.localKey),
    );
    return {
      occurrences: decided.map((occurrence) =>
        occurrence.action === 'run' && !keep.has(occurrence.localKey)
          ? {
              ...occurrence,
              action: 'skipped',
              reason: `Jarvis catches up at most ${MAX_CATCH_UP} at a time.`,
            }
          : occurrence,
      ),
      rule: 'R-SC6',
      reason: `Catching up ${MAX_CATCH_UP} of ${runnable.length}.`,
    };
  }

  return { occurrences: decided, rule: 'R-SC3', reason: null };
}

/* -------------------------------------------------------------------- retries */

/**
 * When to try again, if at all.
 *
 * Exponential with a floor and a ceiling, and — the part that prevents a storm — it returns
 * `null` once the attempts are used up rather than backing off forever. A schedule that has
 * failed three times needs a person, not a fourth attempt.
 *
 * Jitter is deliberately omitted: there is one instance and one owner, so there is no herd to
 * spread out, and a deterministic retry time is one a test can assert on.
 */
export function nextRetryAt(input: {
  readonly attempt: number;
  readonly maxRetries: number;
  readonly failedAt: Date;
}): Date | null {
  if (input.attempt > input.maxRetries) return null;
  const minutes = Math.min(60, 5 * 2 ** Math.max(0, input.attempt - 1));
  return new Date(input.failedAt.getTime() + minutes * 60_000);
}

/* ------------------------------------------------------------------ display */

export function describeSchedule(schedule: Schedule): string {
  const time = `${String(schedule.hour).padStart(2, '0')}:${String(schedule.minute).padStart(2, '0')}`;
  const zone = schedule.timeZone.replace(/_/g, ' ');
  switch (schedule.cadence) {
    case 'daily':
      return `Every day at ${time} (${zone})`;
    case 'weekdays':
      return `Weekdays at ${time} (${zone})`;
    case 'weekly':
      return `Every ${weekdayName(schedule.weekday ?? 1)} at ${time} (${zone})`;
    case 'monthly':
      return `On the ${ordinal(schedule.dayOfMonth ?? 1)} at ${time} (${zone})`;
  }
}

function weekdayName(index: number): string {
  return (
    ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][index] ??
    'Monday'
  );
}

function ordinal(value: number): string {
  const suffix =
    value % 10 === 1 && value !== 11
      ? 'st'
      : value % 10 === 2 && value !== 12
        ? 'nd'
        : value % 10 === 3 && value !== 13
          ? 'rd'
          : 'th';
  return `${value}${suffix}`;
}

/** Validate a schedule's own shape beyond what the schema can express. */
export function assertScheduleUsable(schedule: Pick<Schedule, 'timeZone' | 'kind' | 'projectId'>) {
  if (!isValidTimeZone(schedule.timeZone)) {
    throw new ValidationError('That schedule has a timezone this system does not recognise.');
  }
  if (
    (PROJECT_SCOPED_KINDS as readonly ScheduleKind[]).includes(schedule.kind) &&
    !schedule.projectId
  ) {
    throw new ValidationError('That kind of schedule has to say which project.');
  }
}
