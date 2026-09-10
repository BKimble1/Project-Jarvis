/**
 * Capacity/usage state machine (acceptance req. 5).
 *
 * Three honest states and nothing else:
 *   live        — we have a reading younger than `staleAfterMs` and the last attempt succeeded.
 *   stale       — we have a previous reading, but it is old or the latest attempt failed.
 *                 Presented with the LAST KNOWN windows and a truthful `ageMs`.
 *   unavailable — we have never had a valid reading. `windows` is EMPTY: unknown is never
 *                 rendered as 0%.
 */
import { createLogger } from '../core/logger.js';

const CAPACITY_COLLECTION = 'capacity';
const SNAPSHOT_ID = 'last';

const DEFAULT_EXPLANATION = 'No subscription usage reading has been obtained yet.';
const DEFAULT_RECOVERY =
  'Run `claude setup-token` (or `claude login`) so Jarvis can read your subscription limits, then retry.';

function formatLocal(epochMs, timeZone) {
  if (!Number.isFinite(epochMs)) return null;
  const opts = {
    weekday: 'short', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit', timeZone,
  };
  try {
    return new Intl.DateTimeFormat('en-US', opts).format(new Date(epochMs));
  } catch {
    try {
      return new Intl.DateTimeFormat('en-US', { ...opts, timeZone: 'UTC' }).format(new Date(epochMs));
    } catch {
      return null;
    }
  }
}

function cloneWindow(w) { return { ...w }; }

function round(value, places) {
  const f = 10 ** places;
  return Math.round(value * f) / f;
}

/**
 * The service's own validation gate. Every window that reaches the report, the
 * scheduler or the store passes through here, whichever door it came in by:
 * `refresh()`, `ingestWorkerReport()` or a snapshot reloaded from disk.
 *
 * A window survives only if it carries a key and a genuinely readable
 * `usedPercent`. Nothing is invented and nothing is coerced: an unreadable
 * reading is DROPPED so it can degrade to `stale`/`unavailable`, because a
 * `usedPercent` of `null` reaching the dashboard is exactly the "unknown
 * rendered as 0%" failure this module exists to prevent. `remainingPercent` and
 * `utilization` are then re-derived from the validated `usedPercent`, so an
 * internally inconsistent triple (say `usedPercent:-50, remainingPercent:150`
 * from a buggy worker) can never tell the scheduler there is capacity to burn.
 *
 * @returns {object|null}
 */
function sanitizeWindow(w) {
  if (!w || typeof w !== 'object' || Array.isArray(w)) return null;

  const key = typeof w.key === 'string' && w.key.trim() ? w.key.trim() : null;
  if (!key) return null;

  const used = w.usedPercent;
  if (typeof used !== 'number' || !Number.isFinite(used) || used < 0) return null;

  const usedPercent = round(Math.min(100, used), 2);
  return {
    ...w,
    key,
    label: typeof w.label === 'string' && w.label ? w.label : key,
    usedPercent,
    remainingPercent: round(100 - usedPercent, 2),
    utilization: round(usedPercent / 100, 4),
    unit: 'percent',
    resetsAt: Number.isFinite(w.resetsAt) ? w.resetsAt : null,
  };
}

/** Validate a list of windows; repeated keys collapse (last wins). */
function sanitizeWindows(list) {
  const byKey = new Map();
  for (const w of Array.isArray(list) ? list : []) {
    const clean = sanitizeWindow(w);
    if (clean) byKey.set(clean.key, clean);
  }
  return [...byKey.values()];
}

function usableWindows(measurement) {
  if (!measurement || measurement.ok !== true) return null;
  const windows = sanitizeWindows(measurement.windows);
  return windows.length ? windows : null;
}

export class UsageService {
  constructor({ store, bus, clock, provider, staleAfterMs = 15 * 60_000, logger = createLogger('telemetry:usage') } = {}) {
    if (!store) throw new Error('UsageService requires a store');
    if (!clock) throw new Error('UsageService requires a clock');
    this.store = store;
    this.bus = bus ?? null;
    this.clock = clock;
    this.provider = provider ?? null;
    this.staleAfterMs = staleAfterMs;
    this.logger = logger;

    this._snapshot = null;      // { measuredAt, source, windows }
    this._lastError = null;     // { reason, message, remedy, at }
    this._failedSinceSuccess = false;

    // Reload the last good snapshot through the SAME validation gate as a live
    // measurement. A snapshot written by an older build, half-written, or edited
    // by hand must not be able to resurrect an unreadable window as a reading:
    // that would report `live` while handing the scheduler and the circles a
    // `usedPercent` of null.
    const persisted = this.store.get(CAPACITY_COLLECTION, SNAPSHOT_ID);
    const restored = persisted && Number.isFinite(persisted.measuredAt)
      ? sanitizeWindows(persisted.windows)
      : [];
    if (restored.length) {
      this._snapshot = {
        measuredAt: persisted.measuredAt,
        source: persisted.source ?? 'unknown',
        windows: restored,
      };
    } else if (persisted) {
      this.logger.warn('discarded an unreadable persisted capacity snapshot', {
        windows: Array.isArray(persisted.windows) ? persisted.windows.length : 0,
      });
    }
  }

  /** Ask the provider, persist, emit. Never throws. */
  async refresh() {
    let measurement;
    if (!this.provider || typeof this.provider.measure !== 'function') {
      measurement = {
        ok: false,
        source: 'none',
        measuredAt: this.clock.now(),
        reason: 'unsupported',
        message: 'No telemetry provider is configured.',
        remedy: 'Configure a subscription telemetry provider for Jarvis.',
      };
    } else {
      try {
        measurement = await this.provider.measure();
      } catch (err) {
        measurement = {
          ok: false,
          source: this.provider.name ?? 'unknown',
          measuredAt: this.clock.now(),
          reason: 'network',
          message: `Provider threw: ${err?.message ?? err}`,
          remedy: 'Retry; if it persists check connectivity and credentials.',
        };
      }
    }
    return this._ingest(measurement);
  }

  /**
   * Worker-report leg of the telemetry path: a background worker hands us the same
   * Measurement shape the provider produces. Success updates the stored snapshot and
   * emits capacity.updated exactly like refresh(); failure degrades to stale (when a
   * prior reading exists) or unavailable.
   */
  ingestWorkerReport(measurement) {
    return this._ingest(measurement);
  }

  _ingest(measurement) {
    const now = this.clock.now();
    const windows = usableWindows(measurement);

    if (windows) {
      const measuredAt = Number.isFinite(measurement.measuredAt) ? measurement.measuredAt : now;
      this._snapshot = {
        measuredAt,
        source: measurement.source ?? 'unknown',
        windows: windows.map(cloneWindow),
      };
      this._lastError = null;
      this._failedSinceSuccess = false;
      this.store.put(CAPACITY_COLLECTION, SNAPSHOT_ID, {
        id: SNAPSHOT_ID,
        measuredAt,
        source: this._snapshot.source,
        windows: this._snapshot.windows.map(cloneWindow),
        savedAt: now,
      });
      const report = this.report();
      this.bus?.emit('capacity.updated', report);
      return report;
    }

    const failure = measurement && measurement.ok !== true ? measurement : null;
    this._lastError = {
      reason: failure?.reason ?? 'malformed',
      message: failure?.message ?? 'The measurement contained no usable capacity windows.',
      remedy: failure?.remedy ?? DEFAULT_RECOVERY,
      at: Number.isFinite(failure?.measuredAt) ? failure.measuredAt : now,
    };
    this._failedSinceSuccess = true;
    this.logger.warn('capacity measurement failed', { reason: this._lastError.reason });

    const report = this.report();
    if (report.status === 'unavailable') this.bus?.emit('capacity.unavailable', report);
    else this.bus?.emit('capacity.updated', report);
    return report;
  }

  /** Pure read — no I/O, no clock mutation. */
  report() {
    const now = this.clock.now();
    const timezone = this.clock.timezone();
    const lastError = this._lastError ? { ...this._lastError } : null;

    if (!this._snapshot) {
      return {
        status: 'unavailable',
        measuredAt: null,
        ageMs: null,
        timezone,
        windows: [],
        explanation: lastError?.message ?? DEFAULT_EXPLANATION,
        recovery: lastError?.remedy ?? DEFAULT_RECOVERY,
        lastError,
        staleAfterMs: this.staleAfterMs,
      };
    }

    const ageMs = Math.max(0, now - this._snapshot.measuredAt);
    const aged = ageMs > this.staleAfterMs;
    const status = (aged || this._failedSinceSuccess) ? 'stale' : 'live';
    const freshness = status === 'live' ? 'live' : 'stale';

    let explanation = null;
    let recovery = null;
    if (status === 'stale') {
      explanation = this._failedSinceSuccess
        ? `The last usage refresh failed (${lastError?.reason ?? 'unknown'}); showing the reading from ${Math.round(ageMs / 1000)}s ago.`
        : `This usage reading is ${Math.round(ageMs / 1000)}s old, past the ${Math.round(this.staleAfterMs / 1000)}s freshness limit.`;
      recovery = lastError?.remedy ?? 'Retry the usage refresh.';
    }

    return {
      status,
      measuredAt: this._snapshot.measuredAt,
      ageMs,
      timezone,
      windows: this._snapshot.windows.map((w) => ({
        ...w,
        resetsAtLocal: formatLocal(w.resetsAt, timezone),
        freshness,
      })),
      explanation,
      recovery,
      lastError,
      staleAfterMs: this.staleAfterMs,
    };
  }

  /** Raw CapacityWindow[] for the scheduler; empty when capacity is unknown. */
  windowsForScheduling() {
    if (!this._snapshot) return [];
    return this._snapshot.windows.map(cloneWindow);
  }
}
