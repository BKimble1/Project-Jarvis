import { RATE_WINDOWS, type AuthMode, type RateWindow } from '@/domain/claude-capacity';
import type { WorkerCapacityInput } from '@/domain/worker-protocol';

/**
 * Reading Claude's own account capacity, from the interfaces Claude Code actually publishes.
 *
 * ## Why this file is so careful about where numbers come from
 *
 * Anthropic does not publish a "tokens remaining on my subscription" figure, and it would be very
 * easy to manufacture one — add up the tokens this worker has spent, subtract from a plan size
 * read off a pricing page, and print a confident number. That number would be wrong in a way
 * nobody could see: it would ignore every other machine, every conversation the owner had in the
 * app, and every change Anthropic made to what a plan includes.
 *
 * So this reads only what is actually reported: percentage utilisation of the five-hour and weekly
 * windows, the reset times that come with them, and the context usage of the session in front of
 * it. Where a figure is not reported it stays null, and null travels the whole way to the screen
 * as "unknown" rather than collapsing into a zero somewhere in the middle.
 *
 * ## Account-wide, session-specific, and the difference
 *
 * The window percentages describe *the account*, shared across every machine the owner is signed
 * in on. The context figures describe *one session* and nothing else. They are kept in separate
 * fields with separate names for the whole length of this pipeline because a session at 90% of its
 * context window says nothing whatsoever about how much subscription is left, and a display that
 * blurred them would be lying in the most reassuring possible direction.
 *
 * ## What is deliberately not read
 *
 * The same payloads carry an email address, an organisation name, a list of memory-file paths and
 * a breakdown of MCP tool names. None of that is capacity, none of it is needed to decide whether
 * to start a mission, and a path out of somebody's home directory has no business in a Jarvis
 * database. The mappers below take named fields one at a time rather than spreading an object, so
 * nothing arrives here by accident when the payload gains a field.
 */

/* ------------------------------------------------------- the SDK's shapes */

/*
 * Declared structurally rather than imported, for two reasons. The package is an optional
 * dependency loaded dynamically, so importing its types would make it a hard one — and the usage
 * call is explicitly experimental, so a version bump can change this shape underneath us. Matching
 * structurally means a change shows up as fields going quietly absent, which the mappers already
 * treat as unknown, instead of as a build that will not compile.
 */

/** One window as the usage response reports it: a percentage and an ISO reset time. */
export interface SdkUsageWindow {
  utilization?: number | null;
  resets_at?: string | null;
}

export interface SdkUsageResponse {
  subscription_type?: string | null;
  /** False when plan limits do not apply at all — an API key, Bedrock, Vertex, a missing scope. */
  rate_limits_available?: boolean;
  rate_limits?: {
    five_hour?: SdkUsageWindow | null;
    seven_day?: SdkUsageWindow | null;
    seven_day_opus?: SdkUsageWindow | null;
  } | null;
}

export interface SdkAccountInfo {
  subscriptionType?: string;
  tokenSource?: string;
  apiKeySource?: string;
  apiProvider?: string;
}

/** A rate-limit event, which arrives mid-session and describes one window at a time. */
export interface SdkRateLimitInfo {
  status?: string;
  /** Seconds since the epoch, unlike the usage response's ISO string. */
  resetsAt?: number;
  rateLimitType?: string;
  utilization?: number;
  isUsingOverage?: boolean;
}

export interface SdkContextUsage {
  total_tokens?: number;
  raw_max_tokens?: number;
  percentage?: number;
  over_limit?: { tokens_over?: number } | null;
}

/* ------------------------------------------------------------- auth modes */

/**
 * Which credential the figures describe, from the provider rather than from configuration.
 *
 * Configuration says what the owner asked for; this says what is actually in force, and when they
 * disagree the provider is right. `apiProvider` is the authoritative field — a Bedrock or Vertex
 * session has no subscription window at all, and treating it as though it did would invent a
 * constraint out of nothing.
 *
 * The three Anthropic-operated backends (`anthropicAws`, `anthropicGoogleCloud`, `mantle`) map to
 * `gateway` rather than to `subscription`: they are first-party in the sense of who runs them, but
 * they are not the personal subscription whose five-hour window this governor exists to protect.
 */
export function authModeFromProvider(
  account: SdkAccountInfo | null | undefined,
  configured: AuthMode,
): AuthMode {
  switch (account?.apiProvider) {
    case 'bedrock':
      return 'bedrock';
    case 'vertex':
      return 'vertex';
    case 'foundry':
      return 'foundry';
    case 'gateway':
    case 'anthropicAws':
    case 'anthropicGoogleCloud':
    case 'mantle':
      return 'gateway';
    case 'firstParty':
      /*
       * First-party covers both a subscription login and an API key, and only `tokenSource` /
       * `apiKeySource` separate them. When the SDK names neither, the worker's own configured mode
       * is the better answer than a guess — it is what LIVE-1's auth verdict already established
       * from `claude auth status`.
       */
      if (account.apiKeySource) return 'api_key';
      if (account.tokenSource) return 'subscription';
      return configured;
    default:
      return configured;
  }
}

/* --------------------------------------------------------------- mapping */

const WINDOW_BY_NAME: Readonly<Record<string, RateWindow>> = {
  five_hour: 'fiveHour',
  seven_day: 'sevenDay',
  seven_day_opus: 'sevenDayOpus',
};

/**
 * The value above which a reported share can only be a percentage.
 *
 * One field, two possible scales, and nothing in the payload that says which is in force.
 * `utilization` is meant to be a percentage, and a fraction of the same window is the other obvious
 * way to express the same quantity — a shape-compatible difference, which is precisely the kind the
 * structural typing above is built to survive and this validation is not. The usage call is
 * explicitly experimental, so "it is a percentage today" is not a guarantee about tomorrow.
 *
 * So a figure in (0, 1] is refused, because both readings survive it and they disagree in the
 * direction that costs the most. Read as a percentage, `0.42` renders as "100% left" and clears the
 * governor to spend an account that is nearly half gone; `1` — the value a fraction-scale reader
 * sends for a window that is *completely used up* — renders as "99% left". Above 1 the fraction
 * reading is impossible, so the figure is believed; at exactly 0 the two readings agree, so it is
 * believed too. Those are the only two cases where believing it is not a guess.
 *
 * What the refusal costs is small and bounded: an unreadable window makes `decideCapacity` narrow
 * the loop to one thing at a time and say so, rather than stop, so a genuine 0.4% just after a
 * reset buys a couple of cautious passes until utilisation climbs past 1. Believing a fraction
 * buys a confident wrong number that an owner is being asked to act on.
 */
export const AMBIGUOUS_FRACTION_CEILING = 1;

/**
 * True for a figure that could be a fraction of a whole rather than a percentage of one.
 *
 * Shared by the window and the context paths rather than written into `percentage` alone: both take
 * a share from the same experimental interface, and a rule that lived in only one of them would
 * leave the other believing the reading it refused.
 */
function ambiguousFraction(value: number): boolean {
  return value > 0 && value <= AMBIGUOUS_FRACTION_CEILING;
}

/**
 * A percentage, or null.
 *
 * Anything that is not a finite number in 0–100 is refused rather than clamped. A clamp turns a
 * nonsensical 140 into a confident 100 — "you are out of capacity" — and a negative into a
 * confident 0 — "spend freely". Both are decisions, and neither is one this function is entitled
 * to make on the provider's behalf. A figure that cannot be told apart from a fraction is refused
 * for the same reason and on the same principle: see `AMBIGUOUS_FRACTION_CEILING`.
 */
function percentage(value: number | null | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  if (value < 0 || value > 100) return null;
  if (ambiguousFraction(value)) return null;
  return value;
}

function isoFrom(value: string | null | undefined): string | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

/**
 * A reset time from a rate-limit event, whose `resetsAt` is epoch *seconds*, not milliseconds.
 *
 * Worth its own function and its own comment: the two interfaces that report a reset time disagree
 * about the unit, and reading one with the other's assumption puts the reset either fifty-five
 * years in the past or fifty thousand years in the future. Both are absurd enough to notice by
 * eye and quiet enough to survive a code review.
 */
function isoFromEpochSeconds(value: number | null | undefined): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  const parsed = new Date(value * 1000);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function tokenCount(value: number | null | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  return Math.round(value);
}

/** Every window unknown. The starting point, and what a non-subscription account keeps. */
function emptyWindows(): Record<
  RateWindow,
  { utilisationPercent: number | null; resetsAt: string | null } | null
> {
  return { fiveHour: null, sevenDay: null, sevenDayOpus: null };
}

export interface TelemetrySources {
  readonly usage?: SdkUsageResponse | null;
  readonly account?: SdkAccountInfo | null;
  readonly rateLimit?: SdkRateLimitInfo | null;
  readonly context?: SdkContextUsage | null;
}

export interface TelemetryOptions {
  /** What the worker was configured to use, as a fallback when the provider does not say. */
  readonly configuredAuthMode: AuthMode;
  /** The worker's own reading time. Not the control plane's receipt time. */
  readonly now: Date;
  /** Names the interface the figures came from, so a wrong number can be traced to a wrong reader. */
  readonly source: string;
}

/**
 * Everything one worker managed to read, as the block a heartbeat carries — or null.
 *
 * Null when nothing at all was readable, and that is the important return value. A worker between
 * missions has no live session to ask, so it has nothing new to say, and saying nothing leaves the
 * last known reading in place to age honestly. A block of nulls would instead overwrite a good
 * measurement with an absence several times a minute.
 */
export function buildCapacityReport(
  sources: TelemetrySources,
  options: TelemetryOptions,
): WorkerCapacityInput | null {
  const authMode = authModeFromProvider(sources.account, options.configuredAuthMode);

  /*
   * `rate_limits_available` is the provider's own statement that plan limits do not apply, and it
   * is treated as authoritative when present. It is the difference between "this account has no
   * five-hour window" and "I could not read the five-hour window" — the first is a fact about the
   * account, the second is a fact about this attempt, and only the second is a reason to be
   * cautious about starting work.
   */
  const applicable =
    typeof sources.usage?.rate_limits_available === 'boolean'
      ? sources.usage.rate_limits_available
      : authMode === 'subscription';

  const windows = emptyWindows();

  if (applicable) {
    const reported = sources.usage?.rate_limits ?? null;
    const byName: Record<string, SdkUsageWindow | null | undefined> = {
      five_hour: reported?.five_hour,
      seven_day: reported?.seven_day,
      seven_day_opus: reported?.seven_day_opus,
    };
    for (const [name, window] of Object.entries(WINDOW_BY_NAME)) {
      const value = percentage(byName[name]?.utilization);
      if (value === null) continue;
      windows[window] = { utilisationPercent: value, resetsAt: isoFrom(byName[name]?.resets_at) };
    }

    /*
     * A rate-limit event names exactly one window, and it is newer than the usage snapshot that
     * came before it, so it wins for that window and leaves the others alone. Merging by field
     * rather than replacing wholesale is what keeps a mid-session warning about the five-hour
     * window from blanking a perfectly good weekly figure.
     */
    const eventWindow = sources.rateLimit?.rateLimitType
      ? WINDOW_BY_NAME[sources.rateLimit.rateLimitType]
      : undefined;
    const eventValue = percentage(sources.rateLimit?.utilization);
    if (eventWindow && eventValue !== null) {
      windows[eventWindow] = {
        utilisationPercent: eventValue,
        resetsAt: isoFromEpochSeconds(sources.rateLimit?.resetsAt),
      };
    }
  }

  const context = sources.context
    ? {
        usedTokens: tokenCount(sources.context.total_tokens),
        maxTokens: tokenCount(sources.context.raw_max_tokens),
        /*
         * The same ambiguity, with its own consequence. A context share of `0.85` is either a
         * session 85% full — the point at which work has to be checkpointed before a compaction
         * takes it — or one 0.85% full, and believing the second reads as "healthy" right up until
         * the turns start being dropped. Null is the safe answer here by construction: an
         * unreadable context makes `assessContext` checkpoint anyway.
         */
        percentUsed:
          typeof sources.context.percentage === 'number' &&
          Number.isFinite(sources.context.percentage) &&
          sources.context.percentage >= 0 &&
          !ambiguousFraction(sources.context.percentage)
            ? Math.min(sources.context.percentage, 1000)
            : null,
        overLimit: Boolean(sources.context.over_limit),
      }
    : null;

  const subscriptionType =
    sources.usage?.subscription_type ?? sources.account?.subscriptionType ?? null;

  const overage =
    typeof sources.rateLimit?.isUsingOverage === 'boolean'
      ? sources.rateLimit.isUsingOverage
      : null;

  /*
   * Nothing readable means nothing to report. The auth mode alone is not a reading — it is already
   * carried by the worker's runtime detail, and sending a capacity block for it would stamp a
   * fresh `observedAt` on a row that contains no measurement, making an empty report look like a
   * recent one for the next fifteen minutes.
   */
  const readAnything =
    RATE_WINDOWS.some((window) => windows[window] !== null) ||
    context !== null ||
    subscriptionType !== null ||
    overage !== null ||
    typeof sources.usage?.rate_limits_available === 'boolean';
  if (!readAnything) return null;

  return {
    authMode,
    subscriptionType,
    rateLimitsApplicable: applicable,
    windows: {
      fiveHour: windows.fiveHour,
      sevenDay: windows.sevenDay,
      sevenDayOpus: windows.sevenDayOpus,
    },
    context,
    usingOverage: overage,
    source: options.source,
    observedAt: options.now.toISOString(),
  };
}
