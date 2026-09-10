/**
 * Injectable clock. Every module that needs time takes a clock so tests can
 * drive scheduling, quiet hours, retry backoff and freshness deterministically.
 */
export class SystemClock {
  now() { return Date.now(); }
  /** @returns {Promise<void>} */
  sleep(ms) { return new Promise((r) => setTimeout(r, ms).unref?.() ?? setTimeout(r, ms)); }
  timezone() {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; }
    catch { return 'UTC'; }
  }
}

export class FakeClock {
  constructor(startMs = 0, timezone = 'UTC') {
    this._now = startMs;
    this._tz = timezone;
    this._timers = [];
  }
  now() { return this._now; }
  timezone() { return this._tz; }
  sleep(ms) {
    return new Promise((resolve) => {
      this._timers.push({ at: this._now + Math.max(0, ms), resolve });
    });
  }
  /** Advance virtual time, firing due sleeps in order. */
  async advance(ms) {
    const target = this._now + ms;
    // Fire timers in chronological order, allowing newly scheduled ones to run.
    for (;;) {
      this._timers.sort((a, b) => a.at - b.at);
      const next = this._timers[0];
      if (!next || next.at > target) break;
      this._timers.shift();
      this._now = next.at;
      next.resolve();
      await Promise.resolve(); // let awaiting continuations run
      await new Promise((r) => setImmediate(r));
    }
    this._now = target;
    await new Promise((r) => setImmediate(r));
  }
  set(ms) { this._now = ms; }
}

export const systemClock = new SystemClock();
