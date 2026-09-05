/**
 * How much Claude Jarvis has left, and how sure it is.
 *
 * An operator that runs continuously spends a shared, invisible resource. If it guesses that
 * resource wrong in the optimistic direction it stops mid-mission with a rate-limit error at three
 * in the morning; if it guesses wrong in the pessimistic direction it sits idle all day. Both are
 * bad, and both are what happens when "we could not read it" is quietly rendered as a number.
 *
 * So the whole module is built around one rule: **absence is unknown, never zero and never
 * unlimited.** Every value carries how it was obtained, and a value nobody could obtain is
 * `unknown` all the way to the screen.
 *
 * ## Two mistakes this exists to prevent
 *
 * **Summing a shared limit across workers.** Rate limits on a subscription are per *account*, not
 * per machine. Three workers each reporting "42% used" means the account is at 42%, not at 126%.
 * `mergeAccountLimits` takes the newest authoritative observation and records where it came from;
 * there is deliberately no code path that adds two utilisation figures together.
 *
 * **Applying subscription assumptions to API workers.** A worker authenticated with an API key has
 * no five-hour window and no weekly Opus allowance; its constraint is spend. Reading a
 * subscription worker's headroom and applying it to an API worker would produce a confident number
 * about a limit that does not exist, so observations are partitioned by auth mode and never cross.
 *
 * Nothing here reads a screen or patches a binary. The inputs are documented interfaces — the
 * Claude Code status-line JSON, the Agent SDK's own usage reporting — and a field those interfaces
 * do not provide is simply absent, which is a state this module can represent.
 */

/* --------------------------------------------------------------- provenance */

export const OBSERVATION_QUALITIES = [
  /** Read from a documented interface, recently. */
  'measured',
  /** Derived from something else measured. Directionally right, not exact. */
  'estimated',
  /** Measured, but long enough ago that it may have moved. */
  'stale',
  /** Not available. Not zero, not unlimited — unknown. */
  'unknown',
] as const;
export type ObservationQuality = (typeof OBSERVATION_QUALITIES)[number];

export const OBSERVATION_QUALITY_LABELS: Record<ObservationQuality, string> = {
  measured: 'Measured',
  estimated: 'Estimated',
  stale: 'Last known',
  unknown: 'Unknown',
};

export interface Observed<T> {
  readonly value: T | null;
  readonly quality: ObservationQuality;
  /** Which interface it came from, so a wrong number can be traced to a wrong reader. */
  readonly source: string | null;
  readonly observedAt: string | null;
}

export function unknown<T>(): Observed<T> {
  return { value: null, quality: 'unknown', source: null, observedAt: null };
}

export function measured<T>(value: T, source: string, observedAt: Date): Observed<T> {
  return { value, quality: 'measured', source, observedAt: observedAt.toISOString() };
}

export function estimated<T>(value: T, source: string, observedAt: Date): Observed<T> {
  return { value, quality: 'estimated', source, observedAt: observedAt.toISOString() };
}

/** How old a measurement may be before it stops being current. */
export const STALE_AFTER_MINUTES = 15;

/**
 * Re-age an observation against the clock.
 *
 * A measurement does not stop being true when it gets old; it stops being *current*, and those
 * are different. Demoting to `stale` rather than to `unknown` keeps the last known figure on the
 * screen — which is genuinely useful — while making it impossible to mistake for a live one.
 */
export function age<T>(observation: Observed<T>, now: Date): Observed<T> {
  if (observation.quality === 'unknown' || observation.observedAt === null) return observation;
  const minutes = (now.getTime() - new Date(observation.observedAt).getTime()) / 60_000;
  if (minutes < STALE_AFTER_MINUTES) return observation;
  return { ...observation, quality: 'stale' };
}

/* -------------------------------------------------------------- auth modes */

export const AUTH_MODES = [
  /** A Claude subscription. Has five-hour and weekly windows, shared across every machine. */
  'subscription',
  /** A first-party API key. No windows; the constraint is money. */
  'api_key',
  /** A cloud provider. No subscription windows, and its own quota rules. */
  'bedrock',
  'vertex',
  'foundry',
  'gateway',
  /** Not yet determined. Treated as its own partition rather than folded into any of the above. */
  'unknown',
] as const;
export type AuthMode = (typeof AUTH_MODES)[number];

/**
 * Whether an auth mode has the shared windows a subscription has.
 *
 * The reason the distinction is a function rather than an inline check: "does this worker have a
 * five-hour window?" is asked in several places, and answering it differently in one of them is
 * how an API worker ends up being throttled against a limit it does not have.
 */
export function hasSubscriptionWindows(mode: AuthMode): boolean {
  return mode === 'subscription';
}

/* ------------------------------------------------------------ observations */

export const RATE_WINDOWS = ['fiveHour', 'sevenDay', 'sevenDayOpus'] as const;
export type RateWindow = (typeof RATE_WINDOWS)[number];

export const RATE_WINDOW_LABELS: Record<RateWindow, string> = {
  fiveHour: 'Five-hour window',
  sevenDay: 'Weekly window',
  sevenDayOpus: 'Weekly Opus window',
};

export interface WindowObservation {
  readonly utilisationPercent: Observed<number>;
  readonly resetsAt: Observed<string>;
}

export function unknownWindow(): WindowObservation {
  return { utilisationPercent: unknown<number>(), resetsAt: unknown<string>() };
}

export interface ContextObservation {
  readonly usedTokens: Observed<number>;
  readonly maxTokens: Observed<number>;
  readonly percentUsed: Observed<number>;
  /** True when the session is over its window and the provider is dropping earlier turns. */
  readonly overLimit: Observed<boolean>;
}

export function unknownContext(): ContextObservation {
  return {
    usedTokens: unknown<number>(),
    maxTokens: unknown<number>(),
    percentUsed: unknown<number>(),
    overLimit: unknown<boolean>(),
  };
}

/** One worker's report of what it can see about itself. */
export interface CapacityObservation {
  readonly workerId: string;
  readonly authMode: AuthMode;
  /** The plan name, when the interface reports one. Never inferred from behaviour. */
  readonly subscriptionType: Observed<string>;
  readonly windows: Readonly<Record<RateWindow, WindowObservation>>;
  readonly context: ContextObservation;
  readonly observedAt: string;
  /** The documented interface this came from, named so a wrong figure can be traced. */
  readonly source: string;
}

/* ----------------------------------------------------------------- merging */

export interface AccountCapacity {
  readonly authMode: AuthMode;
  readonly subscriptionType: Observed<string>;
  readonly windows: Readonly<Record<RateWindow, WindowObservation>>;
  /** Workers whose reports were considered. Named so "42%, from where?" has an answer. */
  readonly workerIds: readonly string[];
}

/**
 * One account's headroom, from however many workers reported it.
 *
 * **Newest wins; nothing is ever added.** A rate-limit window on a subscription belongs to the
 * account, so three workers each reporting 42% means the account is at 42%. Summing them would
 * produce 126% — a number that cannot exist, presented with total confidence — and it is an easy
 * mistake to make because summing is what you do with almost every other per-worker figure.
 *
 * Observations are partitioned by auth mode by the caller and never merged across one, because an
 * API worker has no five-hour window at all and lending it a subscription worker's figure would be
 * inventing a constraint.
 */
export function mergeAccountLimits(
  observations: readonly CapacityObservation[],
  now: Date,
): AccountCapacity {
  const relevant = [...observations].sort(
    (left, right) => Date.parse(right.observedAt) - Date.parse(left.observedAt),
  );
  const newest = relevant[0] ?? null;
  const authMode: AuthMode = newest?.authMode ?? 'unknown';

  const windows = {} as Record<RateWindow, WindowObservation>;
  for (const window of RATE_WINDOWS) {
    if (!hasSubscriptionWindows(authMode)) {
      /*
       * Not "0%" and not "plenty". This auth mode does not have this window, so there is nothing
       * to report about it, and reporting a number would invent a constraint that does not exist.
       */
      windows[window] = unknownWindow();
      continue;
    }
    const withValue = relevant.find(
      (observation) => observation.windows[window].utilisationPercent.value !== null,
    );
    windows[window] = withValue
      ? {
          utilisationPercent: age(withValue.windows[window].utilisationPercent, now),
          resetsAt: age(withValue.windows[window].resetsAt, now),
        }
      : unknownWindow();
  }

  return {
    authMode,
    subscriptionType: newest ? age(newest.subscriptionType, now) : unknown<string>(),
    windows,
    workerIds: [...new Set(relevant.map((observation) => observation.workerId))],
  };
}

/* ------------------------------------------------------------- the reserve */

export const CAPACITY_VERDICTS = [
  /** Room to start new work. */
  'clear',
  /** Inside the reserve the owner asked to keep. Finish what is running; start nothing new. */
  'reserved',
  /** At or over the limit. Nothing starts. */
  'exhausted',
  /** Jarvis cannot tell. Treated as `reserved`, and said out loud. */
  'unknown',
] as const;
export type CapacityVerdict = (typeof CAPACITY_VERDICTS)[number];

export interface CapacityDecision {
  readonly verdict: CapacityVerdict;
  readonly mayStartNewWork: boolean;
  /**
   * How many new things may start on this pass, or null for "capacity is not the constraint".
   *
   * A boolean was not enough, and that was the governor's real structural gap: every ceiling
   * downstream of it is a number, enforced inside a SQL claim, so a governor that could only say
   * yes or no could only ever be off or wide open. With a number it can also say "one at a time" —
   * which is what a tightening window actually calls for, and what keeps Jarvis working slowly
   * instead of stopping dead the first time a figure gets uncomfortable.
   *
   * Null rather than Infinity so the operator's own concurrency limit stays the ceiling in the
   * ordinary case, and this only ever narrows it.
   */
  readonly maxNewWork: number | null;
  /** The sentence an owner reads. Never a bare percentage. */
  readonly reason: string;
  readonly window: RateWindow | null;
  readonly quality: ObservationQuality;
}

/**
 * How much clear air a window needs before Jarvis calls it clear again.
 *
 * Without this, a window sitting on the reserve boundary flips between `reserved` and `clear` on
 * alternating ticks, and an autonomous loop that starts a mission, defers, starts, defers is worse
 * than one that simply waits: it produces half-finished work and a log nobody can read. Coming out
 * of a reserve therefore needs more headroom than going into it did.
 */
export const CAPACITY_HYSTERESIS_PERCENT = 5;

/**
 * Headroom below which Jarvis stops filling every slot, as a multiple of the reserve.
 *
 * Above it, capacity is not the binding constraint and the operator's own concurrency limit
 * decides. Below it — but still outside the reserve — there is room for something, and starting
 * three things at once is how that room gets spent in one pass.
 */
const NARROW_HEADROOM_MULTIPLE = 2;

/**
 * Whether there is room to start something new, and how much.
 *
 * ## Three different silences, and why they are not the same
 *
 * The hard part of this function is not arithmetic, it is telling apart three situations that all
 * look like "no number".
 *
 * **This account has no such window.** An API key, Bedrock, Vertex. There is nothing to reserve
 * and no percentage that would mean anything, so capacity is `clear` and money is the constraint
 * instead — which the charter's spend limits already enforce, against a ledger. Inventing a
 * five-hour window here would just be a second wrong answer.
 *
 * **Jarvis has never managed to read this window.** An older Claude Code without the usage
 * interface, a worker that has not run a mission yet, a call that keeps failing. This used to stop
 * all work, and that was a serious mistake: it is a *capability* gap, not a capacity signal, and it
 * does not go away by waiting. A deployment on a Claude Code that cannot report utilisation would
 * have sat there doing nothing, indefinitely, with a message about holding rather than guessing —
 * the exact "a missing telemetry field silently switches Jarvis off for a day" failure this
 * function's own comment warned about. So it no longer stops: it narrows to one thing at a time
 * and says plainly that it is working blind.
 *
 * **Jarvis read it, and the reading has gone old.** A real measurement that has stopped being
 * current. Here holding back genuinely is right, because something was there and the number is
 * probably still in the right region — so the value is still used, but it can no longer earn a
 * clear run, only a narrowed one.
 *
 * ## Why the answer is a number
 *
 * `mayStartNewWork` alone could only turn Jarvis off or leave it wide open. `maxNewWork` lets a
 * tightening window slow the loop down instead of stopping it, which is what an owner actually
 * wants from a governor: fewer things at once as the window fills, nothing new once it is inside
 * the reserve, and the ordinary concurrency limit back again when there is room.
 *
 * ## Why coming back out is harder than going in
 *
 * A window resting on the reserve boundary would otherwise flip every tick, and an operator that
 * alternates between starting and deferring produces half-finished work. `previous` lets the
 * decision require a margin of clear air before it calls things clear again.
 */
export function decideCapacity(
  capacity: AccountCapacity,
  reserve: { readonly fiveHourPercent: number; readonly sevenDayPercent: number },
  options: { readonly previous?: CapacityVerdict | null } = {},
): CapacityDecision {
  if (!hasSubscriptionWindows(capacity.authMode)) {
    return {
      verdict: 'clear',
      mayStartNewWork: true,
      maxNewWork: null,
      reason:
        capacity.authMode === 'unknown'
          ? 'Jarvis has not established how this worker authenticates, so it is not applying subscription limits it may not have. Spending limits still apply.'
          : 'This worker does not use a Claude subscription, so there is no shared window to reserve. Spending limits still apply.',
      window: null,
      quality: capacity.authMode === 'unknown' ? 'unknown' : 'measured',
    };
  }

  const checks: readonly { window: RateWindow; reservePercent: number }[] = [
    { window: 'fiveHour', reservePercent: reserve.fiveHourPercent },
    { window: 'sevenDay', reservePercent: reserve.sevenDayPercent },
    { window: 'sevenDayOpus', reservePercent: reserve.sevenDayPercent },
  ];

  /*
   * Coming out of a hold needs more room than going into one did. `previous` is the last verdict
   * this deployment recorded, so the margin only applies to a genuine recovery and not to the very
   * first decision after a restart.
   */
  const recovering = options.previous === 'reserved' || options.previous === 'exhausted';
  const margin = recovering ? CAPACITY_HYSTERESIS_PERCENT : 0;

  let unreadable: RateWindow | null = null;
  let stale: RateWindow | null = null;
  let narrow: CapacityDecision | null = null;
  let held: CapacityDecision | null = null;

  for (const check of checks) {
    const observation = capacity.windows[check.window].utilisationPercent;
    if (observation.value === null) {
      unreadable ??= check.window;
      continue;
    }
    if (observation.quality === 'stale') stale ??= check.window;

    const remaining = 100 - observation.value;

    if (remaining <= 0) {
      /*
       * Returned immediately rather than collected. A window that is used up is not a matter of
       * degree and nothing further down can soften it.
       */
      return {
        verdict: 'exhausted',
        mayStartNewWork: false,
        maxNewWork: 0,
        reason: `${RATE_WINDOW_LABELS[check.window]} is used up. Jarvis will start nothing until it resets${describeReset(capacity.windows[check.window].resetsAt)}.`,
        window: check.window,
        quality: observation.quality,
      };
    }

    if (remaining <= check.reservePercent + margin && held === null) {
      held = {
        verdict: 'reserved',
        mayStartNewWork: false,
        maxNewWork: 0,
        reason:
          remaining <= check.reservePercent
            ? `${RATE_WINDOW_LABELS[check.window]} has ${Math.round(remaining)}% left, inside the ${check.reservePercent}% you asked Jarvis to keep for you. It will finish what is running and start nothing new.`
            : `${RATE_WINDOW_LABELS[check.window]} has ${Math.round(remaining)}% left, only just clear of the ${check.reservePercent}% reserve. Jarvis is waiting for a little more room before it starts anything, rather than starting and deferring on alternate passes.`,
        window: check.window,
        quality: observation.quality,
      };
      continue;
    }

    if (remaining <= check.reservePercent * NARROW_HEADROOM_MULTIPLE && narrow === null) {
      narrow = {
        verdict: 'clear',
        mayStartNewWork: true,
        maxNewWork: 1,
        reason: `${RATE_WINDOW_LABELS[check.window]} has ${Math.round(remaining)}% left. Jarvis will start one thing at a time rather than filling every slot.`,
        window: check.window,
        quality: observation.quality,
      };
    }
  }

  if (held) return held;

  if (unreadable) {
    /*
     * Not a stop. See the header: an unreadable window is a gap in what Jarvis can see, and a gap
     * that may never close. It narrows the loop and is stated plainly, so an owner reading the
     * operations page learns that the figure is missing rather than that Jarvis has decided to
     * wait for something that is not coming.
     */
    return {
      verdict: 'unknown',
      mayStartNewWork: true,
      maxNewWork: 1,
      reason: `Jarvis cannot read the ${RATE_WINDOW_LABELS[unreadable].toLowerCase()}, so it is working one thing at a time rather than guessing how much room there is. Spending limits still apply.`,
      window: unreadable,
      quality: 'unknown',
    };
  }

  if (stale) {
    /*
     * A real measurement that has stopped being current. Its value is still the best evidence
     * there is — which is why it was used in the checks above — but it cannot earn a clear run.
     */
    return {
      verdict: 'clear',
      mayStartNewWork: true,
      maxNewWork: 1,
      reason: `Jarvis is working from a ${RATE_WINDOW_LABELS[stale].toLowerCase()} reading that is no longer current, so it is starting one thing at a time until a worker reports a fresh one.`,
      window: stale,
      quality: 'stale',
    };
  }

  if (narrow) return narrow;

  return {
    verdict: 'clear',
    mayStartNewWork: true,
    maxNewWork: null,
    reason: 'There is room in every window Jarvis can see.',
    window: null,
    quality: 'measured',
  };
}

/** " — it resets at 15:00" or nothing, so a reset time never becomes a bare timestamp. */
function describeReset(resetsAt: Observed<string>): string {
  if (resetsAt.value === null) return '';
  const parsed = new Date(resetsAt.value);
  if (Number.isNaN(parsed.getTime())) return '';
  return `, which it does at ${parsed.toISOString().slice(11, 16)} UTC`;
}

/* ------------------------------------------------------------ context health */

export const CONTEXT_STATES = ['healthy', 'filling', 'critical', 'over', 'unknown'] as const;
export type ContextState = (typeof CONTEXT_STATES)[number];

export interface ContextHealth {
  readonly state: ContextState;
  readonly percentUsed: Observed<number>;
  /** True when work should be checkpointed before the window forces a compaction. */
  readonly shouldCheckpoint: boolean;
  readonly reason: string;
}

/**
 * Whether a session is running out of room, and whether to checkpoint.
 *
 * The checkpoint threshold is deliberately well before the wall. A compaction that happens *to* an
 * agent loses whatever was not written down; a checkpoint taken *by* an agent, on purpose, at 75%,
 * writes the state somewhere that survives — a commit, a stored plan, a task record.
 *
 * Which is the other half of this: a checkpoint must be verifiable. A model-generated summary of
 * what it has done is the least reliable form of state there is, and where git, a test result or a
 * structured record can say the same thing, that is what gets stored.
 */
export function assessContext(observation: ContextObservation, now: Date): ContextHealth {
  const percent = age(observation.percentUsed, now);
  const over = observation.overLimit.value === true;

  if (over) {
    return {
      state: 'over',
      percentUsed: percent,
      shouldCheckpoint: true,
      reason: 'The session is over its context window and earlier turns are being dropped.',
    };
  }
  if (percent.value === null) {
    return {
      state: 'unknown',
      percentUsed: percent,
      /*
       * Checkpoint anyway. A checkpoint costs a commit; not checkpointing costs the work. When the
       * gauge is unreadable, the cheap action is the right one.
       */
      shouldCheckpoint: true,
      reason: 'Jarvis cannot read how full this session is, so it is checkpointing to be safe.',
    };
  }
  if (percent.value >= 90) {
    return {
      state: 'critical',
      percentUsed: percent,
      shouldCheckpoint: true,
      reason: `The session is ${Math.round(percent.value)}% full. Work is being checkpointed now.`,
    };
  }
  if (percent.value >= 75) {
    return {
      state: 'filling',
      percentUsed: percent,
      shouldCheckpoint: true,
      reason: `The session is ${Math.round(percent.value)}% full, so Jarvis is writing down where it got to before it has to.`,
    };
  }
  return {
    state: 'healthy',
    percentUsed: percent,
    shouldCheckpoint: false,
    reason: `The session is ${Math.round(percent.value)}% full.`,
  };
}

/* --------------------------------------------------------------- routing */

export const WORK_WEIGHTS = [
  /** Formatting, heartbeats, status lines, structured extraction from something already decided. */
  'mechanical',
  /** Ordinary work: a small change, a summary, a review of something short. */
  'ordinary',
  /** Design, diagnosis, a review that has to be right, anything irreversible. */
  'demanding',
] as const;
export type WorkWeight = (typeof WORK_WEIGHTS)[number];

export interface ModelChoice {
  readonly weight: WorkWeight;
  readonly model: string;
  readonly reason: string;
}

/**
 * Which model to use, given the work and how much room is left.
 *
 * Two rules, both about not wasting the expensive thing. Heartbeat processing and status
 * formatting never reach the strongest model, whatever the headroom — that is not thrift, it is
 * that a mechanical transformation does not get better with a better model and the tokens are gone
 * either way. And when a window is inside its reserve, demanding work steps down one rung rather
 * than stopping, because a slightly weaker review is worth more than no review.
 *
 * The model names come from configuration, not from this function. A hard-coded model id is wrong
 * the week after it is written.
 */
export function routeModel(input: {
  readonly weight: WorkWeight;
  readonly capacity: CapacityVerdict;
  readonly models: { readonly strong: string; readonly balanced: string; readonly fast: string };
}): ModelChoice {
  const { weight, capacity, models } = input;

  if (weight === 'mechanical') {
    return {
      weight,
      model: models.fast,
      reason: 'This is mechanical work; a stronger model would not do it better.',
    };
  }

  const constrained = capacity === 'reserved' || capacity === 'unknown' || capacity === 'exhausted';

  if (weight === 'demanding') {
    return constrained
      ? {
          weight,
          model: models.balanced,
          reason: 'Capacity is tight, so Jarvis is stepping down one model rather than stopping.',
        }
      : { weight, model: models.strong, reason: 'This needs to be right.' };
  }

  return constrained
    ? {
        weight,
        model: models.fast,
        reason: 'Capacity is tight, so ordinary work uses the fast model.',
      }
    : { weight, model: models.balanced, reason: 'Ordinary work.' };
}
