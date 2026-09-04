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
  /** The sentence an owner reads. Never a bare percentage. */
  readonly reason: string;
  readonly window: RateWindow | null;
  readonly quality: ObservationQuality;
}

/**
 * Whether there is room to start something new.
 *
 * Unknown capacity is treated as `reserved` — finish what is running, start nothing new — rather
 * than as either "go ahead" or "stop everything". Going ahead is how an operator gets rate-limited
 * halfway through a mission it cannot resume; stopping everything is how a missing telemetry field
 * silently switches Jarvis off for a day. Holding is the only reading that is wrong in a
 * recoverable direction, and it is reported as a guess rather than as a measurement.
 *
 * An auth mode with no windows is `clear` here and constrained by money instead. That is not a
 * loophole: the charter's spend limits are enforced separately, against a ledger, and pretending
 * an API key has a five-hour window would just be a second wrong answer.
 */
export function decideCapacity(
  capacity: AccountCapacity,
  reserve: { readonly fiveHourPercent: number; readonly sevenDayPercent: number },
): CapacityDecision {
  if (!hasSubscriptionWindows(capacity.authMode)) {
    return {
      verdict: 'clear',
      mayStartNewWork: true,
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

  let sawUnknown: RateWindow | null = null;
  let worst: CapacityDecision | null = null;

  for (const check of checks) {
    const observation = capacity.windows[check.window].utilisationPercent;
    if (observation.value === null) {
      sawUnknown ??= check.window;
      continue;
    }
    const remaining = 100 - observation.value;
    if (remaining <= 0) {
      return {
        verdict: 'exhausted',
        mayStartNewWork: false,
        reason: `${RATE_WINDOW_LABELS[check.window]} is used up. Jarvis will start nothing until it resets.`,
        window: check.window,
        quality: observation.quality,
      };
    }
    if (remaining <= check.reservePercent && (worst === null || worst.verdict !== 'reserved')) {
      worst = {
        verdict: 'reserved',
        mayStartNewWork: false,
        reason: `${RATE_WINDOW_LABELS[check.window]} has ${Math.round(remaining)}% left, inside the ${check.reservePercent}% you asked Jarvis to keep for you. It will finish what is running and start nothing new.`,
        window: check.window,
        quality: observation.quality,
      };
    }
  }

  if (worst) return worst;

  if (sawUnknown) {
    return {
      verdict: 'unknown',
      mayStartNewWork: false,
      reason: `Jarvis cannot read the ${RATE_WINDOW_LABELS[sawUnknown].toLowerCase()}, so it is holding rather than guessing. It will finish what is running.`,
      window: sawUnknown,
      quality: 'unknown',
    };
  }

  return {
    verdict: 'clear',
    mayStartNewWork: true,
    reason: 'There is room in every window Jarvis can see.',
    window: null,
    quality: 'measured',
  };
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
    ? { weight, model: models.fast, reason: 'Capacity is tight, so ordinary work uses the fast model.' }
    : { weight, model: models.balanced, reason: 'Ordinary work.' };
}
