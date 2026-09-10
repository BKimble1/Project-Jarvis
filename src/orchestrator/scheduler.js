/**
 * Capacity-aware scheduling (acceptance req. 5, final clause).
 *
 * The measurements taken by `src/telemetry/*` are not decoration: this module
 * turns them into two numbers that actually change how work runs —
 *   `concurrency()`  how many tasks may execute at once, and
 *   `paceDelayMs()`  how long the pool waits between dispatches.
 *
 * Everything is read from `usage` on EVERY call. Nothing is cached at
 * construction, because capacity moves while a build is in flight and the pool
 * asks again before each dispatch.
 *
 * The Scheduler deliberately emits nothing on the bus: it is a read model over
 * telemetry, and capacity changes are already announced as `capacity.updated`.
 * The bus is accepted so callers can wire it uniformly (and for future use by
 * subclasses) without the scheduler inventing a second, redundant channel.
 */
import { createLogger } from '../core/logger.js';

/** Concurrency ceiling applied when capacity is unknown — deliberately timid. */
export const UNKNOWN_CONCURRENCY = 2;
/** Inter-task delay applied when capacity is unknown. */
export const UNKNOWN_PACE_MS = 500;
/** How often `gate()` re-checks capacity while concurrency is pinned at zero. */
export const ZERO_CAPACITY_POLL_MS = 1_000;

/**
 * Capacity bands, richest first. `atLeastPercent` is inclusive, so the
 * boundaries are exactly the ones in the contract: >=50, 20-50, 5-20, <5.
 * `share` says how much of `maxConcurrency` the band is allowed to use.
 */
export const BANDS = Object.freeze([
  Object.freeze({ name: 'ample', atLeastPercent: 50, share: 'full', paceDelayMs: 0 }),
  Object.freeze({ name: 'moderate', atLeastPercent: 20, share: 'half', paceDelayMs: 250 }),
  Object.freeze({ name: 'low', atLeastPercent: 5, share: 'min', paceDelayMs: 2_000 }),
  Object.freeze({ name: 'critical', atLeastPercent: 0.5, share: 'min', paceDelayMs: 10_000 }),
  // Actually out. Running anyway would just burn retries against a limit that
  // has not reset. `gate()` holds here and releases the moment a refreshed
  // reading shows capacity again, which is how saved work resumes at reset.
  Object.freeze({ name: 'exhausted', atLeastPercent: -Infinity, share: 'none', paceDelayMs: 0 }),
]);

/** @returns {typeof BANDS[number]|null} null when the reading is not a number. */
export function bandFor(remainingPercent) {
  if (!Number.isFinite(remainingPercent)) return null;
  return BANDS.find((b) => remainingPercent >= b.atLeastPercent) ?? BANDS[BANDS.length - 1];
}

/**
 * Remaining capacity for one window, tolerating the three shapes a window can
 * legitimately carry. Returns null (never 0) when the value is unusable —
 * unknown must never masquerade as empty.
 */
function remainingPercentOf(window) {
  if (!window || typeof window !== 'object') return null;
  if (Number.isFinite(window.remainingPercent)) return window.remainingPercent;
  if (Number.isFinite(window.usedPercent)) return 100 - window.usedPercent;
  if (Number.isFinite(window.utilization)) {
    const used = window.utilization > 1 ? window.utilization : window.utilization * 100;
    return 100 - used;
  }
  return null;
}

/** The tightest window decides the band. */
function worstRemainingOf(windows) {
  let worst = null;
  for (const w of Array.isArray(windows) ? windows : []) {
    const remaining = remainingPercentOf(w);
    if (remaining === null) continue;
    if (worst === null || remaining < worst) worst = remaining;
  }
  return worst;
}

function intOr(value, fallback) {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) ? n : fallback;
}

export class Scheduler {
  constructor({
    clock,
    usage = null,
    bus = null,
    maxConcurrency = 4,
    minConcurrency = 1,
    zeroCapacityPollMs = ZERO_CAPACITY_POLL_MS,
    logger = createLogger('orchestrator:scheduler'),
  } = {}) {
    if (!clock || typeof clock.sleep !== 'function') {
      throw new Error('Scheduler requires a clock with sleep()');
    }
    this.clock = clock;
    this.usage = usage;
    this.bus = bus;
    this.logger = logger;
    this.maxConcurrency = Math.max(1, intOr(maxConcurrency, 4));
    this.minConcurrency = Math.max(0, Math.min(this.maxConcurrency, intOr(minConcurrency, 1)));
    this.zeroCapacityPollMs = Math.max(1, intOr(zeroCapacityPollMs, ZERO_CAPACITY_POLL_MS));
    this._lastBand = null;
  }

  /** Live read of the telemetry status; 'unavailable' when there is no usage service. */
  _status() {
    try {
      const status = this.usage?.report?.()?.status;
      return status === 'live' || status === 'stale' ? status : 'unavailable';
    } catch (err) {
      this.logger.warn('usage.report() threw; treating capacity as unknown', err?.message);
      return 'unavailable';
    }
  }

  /** Live read of the windows telemetry considers safe to schedule against. */
  _windows() {
    try {
      const windows = this.usage?.windowsForScheduling?.();
      return Array.isArray(windows) ? windows : [];
    } catch (err) {
      this.logger.warn('usage.windowsForScheduling() threw; treating capacity as unknown', err?.message);
      return [];
    }
  }

  /** Clamp a candidate concurrency into [minConcurrency, maxConcurrency]. */
  _clamp(n) {
    const floored = Math.max(this.minConcurrency, intOr(n, this.minConcurrency));
    return Math.max(0, Math.min(this.maxConcurrency, floored));
  }

  /**
   * The whole decision, recomputed from scratch. Every public method funnels
   * through here, which is what makes the scheduler react mid-run.
   * @returns {{concurrency:number, paceDelayMs:number, basis:'live'|'stale'|'unknown',
   *            worstRemainingPercent:number|null, band:string}}
   */
  _assess() {
    const status = this._status();
    const worst = worstRemainingOf(this._windows());
    const band = status === 'unavailable' ? null : bandFor(worst);

    if (!band) {
      // Unknown capacity: never guess generously, and never pretend it is 0%.
      const plan = {
        concurrency: this._clamp(Math.min(UNKNOWN_CONCURRENCY, this.maxConcurrency)),
        paceDelayMs: UNKNOWN_PACE_MS,
        basis: 'unknown',
        worstRemainingPercent: null,
        band: 'unknown',
      };
      this._note(plan);
      return plan;
    }

    let concurrency;
    if (band.share === 'none') concurrency = 0;
    else if (band.share === 'full') concurrency = this.maxConcurrency;
    else if (band.share === 'half') concurrency = Math.ceil(this.maxConcurrency / 2);
    else concurrency = this.minConcurrency;

    const plan = {
      concurrency: band.share === 'none' ? 0 : this._clamp(concurrency),
      paceDelayMs: band.paceDelayMs,
      basis: status === 'stale' ? 'stale' : 'live',
      worstRemainingPercent: worst,
      band: band.name,
    };
    this._note(plan);
    return plan;
  }

  /** Log band transitions once, so a capacity change is visible in diagnostics. */
  _note(plan) {
    const key = `${plan.band}:${plan.basis}`;
    if (key === this._lastBand) return;
    this._lastBand = key;
    this.logger.info('capacity band changed', {
      band: plan.band,
      basis: plan.basis,
      concurrency: plan.concurrency,
      paceDelayMs: plan.paceDelayMs,
      worstRemainingPercent: plan.worstRemainingPercent,
    });
  }

  /** How many tasks may run at once, right now. */
  concurrency() {
    return this._assess().concurrency;
  }

  /** How long to wait before dispatching the next task, right now. */
  paceDelayMs() {
    return this._assess().paceDelayMs;
  }

  /** Exactly the four fields the dashboard and diagnostics render. */
  describe() {
    const { concurrency, paceDelayMs, basis, worstRemainingPercent } = this._assess();
    return { concurrency, paceDelayMs, basis, worstRemainingPercent };
  }

  /**
   * Pacing gate. Blocks while capacity says "no work at all", then sleeps the
   * band's inter-task delay. Capacity is re-read on every poll so a recovery
   * releases the gate without anyone restarting the loop.
   */
  async gate() {
    for (;;) {
      const plan = this._assess();
      if (plan.concurrency > 0) {
        if (plan.paceDelayMs > 0) await this.clock.sleep(plan.paceDelayMs);
        return;
      }
      await this.clock.sleep(this.zeroCapacityPollMs);
    }
  }
}
