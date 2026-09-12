/**
 * Is the operating loop actually running?
 *
 * ## Why this cannot be read from a setting
 *
 * Nothing in the control plane schedules the loop. The control plane is serverless: a request
 * arrives, is answered, and the process goes away, so the only thing that can drive a loop is the
 * worker, on its own timer, from its own configuration. Which means the deployment does not *know*
 * how often the loop is supposed to run — the machine that decides that is somewhere else, and may
 * be switched off.
 *
 * So this infers the cadence from the ticks themselves. The median gap between recent passes is
 * what the loop has actually been doing, measured rather than declared, and it stays correct when
 * an owner changes the interval, runs two workers, or drives the loop from a schedule instead.
 *
 * ## Why the median and not the mean
 *
 * One pass that took an hour because the machine was asleep would drag a mean far enough that a
 * genuinely stopped loop would still look punctual. The median ignores it.
 *
 * ## What "unknown" means here
 *
 * Fewer than three passes is not enough to measure anything, and this says so rather than
 * inventing a cadence. It falls back to the worker's documented default interval only to answer
 * "is this alarmingly old?", and the explanation says that is what it is doing.
 */

export const SUPERVISOR_STATES = [
  /** No pass has ever finished. Nothing is driving the loop, or nothing has yet. */
  'never_run',
  /** Running about as often as it has been running. */
  'healthy',
  /** Overdue, but not by enough to conclude anything. A slow pass, or a worker that restarted. */
  'late',
  /** Long enough that something is wrong: no worker, no network, or a worker that cannot drive it. */
  'stalled',
  /** Running, and the most recent pass ended in an error. */
  'failing',
] as const;
export type SupervisorState = (typeof SUPERVISOR_STATES)[number];

/** The worker's default, used only when there are too few passes to measure a real cadence. */
export const ASSUMED_TICK_INTERVAL_MS = 60_000;

/** Overdue past this multiple of the cadence, and it is worth mentioning. */
const LATE_MULTIPLE = 3;
/** Overdue past this multiple, and it has stopped. */
const STALLED_MULTIPLE = 10;

export interface SupervisorTick {
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly outcome: 'observed' | 'worked' | 'held' | 'skipped' | 'failed';
  readonly summary: string;
}

export interface SupervisorHealth {
  readonly state: SupervisorState;
  readonly lastTickAt: string | null;
  readonly lastOutcome: SupervisorTick['outcome'] | null;
  readonly lastSummary: string | null;
  readonly sinceLastMs: number | null;
  /** Measured from the passes themselves. Null when there are too few to measure. */
  readonly typicalGapMs: number | null;
  /** When the next pass is due, on the measured cadence. Null when the cadence is unknown. */
  readonly nextExpectedAt: string | null;
  /** The most recent pass that ended in an error, however long ago. Null when there is none. */
  readonly lastError: { readonly at: string; readonly summary: string } | null;
  /** One sentence an owner can act on. */
  readonly explanation: string;
}

/**
 * @param ticks Recent passes, newest first — the order `OperatorTickRepository.recent` returns.
 */
export function supervisorHealth(ticks: readonly SupervisorTick[], now: Date): SupervisorHealth {
  const finished = ticks.filter((tick) => tick.finishedAt !== null);
  const lastError = finished.find((tick) => tick.outcome === 'failed') ?? null;
  const errorAt = lastError?.finishedAt ?? lastError?.startedAt ?? null;

  const latest = finished[0];
  if (!latest) {
    return {
      state: 'never_run',
      lastTickAt: null,
      lastOutcome: null,
      lastSummary: null,
      sinceLastMs: null,
      typicalGapMs: null,
      nextExpectedAt: null,
      lastError: null,
      explanation:
        'The operating loop has never completed a pass. It is driven by the worker, so start one and give it a minute.',
    };
  }

  const lastAt = latest.finishedAt ?? latest.startedAt;
  const lastMs = Date.parse(lastAt);
  const sinceLastMs = Number.isNaN(lastMs) ? null : Math.max(0, now.getTime() - lastMs);
  const typicalGapMs = medianGap(finished);
  const cadence = typicalGapMs ?? ASSUMED_TICK_INTERVAL_MS;

  const state = ((): SupervisorState => {
    if (sinceLastMs !== null && sinceLastMs > cadence * STALLED_MULTIPLE) return 'stalled';
    if (latest.outcome === 'failed') return 'failing';
    if (sinceLastMs !== null && sinceLastMs > cadence * LATE_MULTIPLE) return 'late';
    return 'healthy';
  })();

  return {
    state,
    lastTickAt: lastAt,
    lastOutcome: latest.outcome,
    lastSummary: latest.summary,
    sinceLastMs,
    typicalGapMs,
    nextExpectedAt:
      typicalGapMs === null || Number.isNaN(lastMs)
        ? null
        : new Date(lastMs + typicalGapMs).toISOString(),
    lastError: lastError && errorAt ? { at: errorAt, summary: lastError.summary } : null,
    explanation: explain(state, sinceLastMs, typicalGapMs, latest),
  };
}

function medianGap(finished: readonly SupervisorTick[]): number | null {
  const times = finished
    .map((tick) => Date.parse(tick.finishedAt ?? tick.startedAt))
    .filter((value) => !Number.isNaN(value))
    .sort((left, right) => right - left);
  if (times.length < 3) return null;

  const gaps: number[] = [];
  for (let index = 0; index + 1 < times.length; index += 1) {
    const gap = (times[index] ?? 0) - (times[index + 1] ?? 0);
    if (gap > 0) gaps.push(gap);
  }
  if (gaps.length === 0) return null;
  gaps.sort((left, right) => left - right);
  const middle = Math.floor(gaps.length / 2);
  return gaps.length % 2 === 1
    ? (gaps[middle] ?? null)
    : Math.round(((gaps[middle - 1] ?? 0) + (gaps[middle] ?? 0)) / 2);
}

function explain(
  state: SupervisorState,
  sinceLastMs: number | null,
  typicalGapMs: number | null,
  latest: SupervisorTick,
): string {
  const ago = sinceLastMs === null ? 'at an unreadable time' : `${humanise(sinceLastMs)} ago`;
  const cadence =
    typicalGapMs === null
      ? 'Too few passes so far to say how often it usually runs.'
      : `It usually runs about every ${humanise(typicalGapMs)}.`;

  switch (state) {
    case 'healthy':
      return `The operating loop last ran ${ago}. ${cadence}`;
    case 'late':
      return `The operating loop last ran ${ago}, which is later than usual. ${cadence} A worker that restarted explains this; a worker that stopped does not.`;
    case 'stalled':
      return `The operating loop has not run for ${sinceLastMs === null ? 'an unknown time' : humanise(sinceLastMs)}. Nothing is driving it — check that a worker is running and can reach this deployment.`;
    case 'failing':
      return `The operating loop ran ${ago} and the pass failed: ${latest.summary}`;
    case 'never_run':
      return 'The operating loop has never completed a pass.';
  }
}

function humanise(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 90) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)} days`;
}
