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

function usableWindows(measurement) {
  if (!measurement || measurement.ok !== true) return null;
  const windows = Array.isArray(measurement.windows)
    ? measurement.windows.filter((w) => w && typeof w === 'object' && Number.isFinite(w.usedPercent))
    : [];
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

    const persisted = this.store.get(CAPACITY_COLLECTION, SNAPSHOT_ID);
    if (persisted && Array.isArray(persisted.windows) && persisted.windows.length
        && Number.isFinite(persisted.measuredAt)) {
      this._snapshot = {
        measuredAt: persisted.measuredAt,
        source: persisted.source ?? 'unknown',
        windows: persisted.windows.map(cloneWindow),
      };
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
