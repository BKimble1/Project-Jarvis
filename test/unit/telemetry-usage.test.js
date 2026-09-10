import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { FakeClock } from '../../src/core/clock.js';
import { EventBus } from '../../src/core/bus.js';
import { Store } from '../../src/core/store.js';
import { createLogger } from '../../src/core/logger.js';
import { UsageService } from '../../src/telemetry/usage.js';
import { summarizeForSpeech, worstRemaining } from '../../src/telemetry/report.js';

const T0 = 1_700_000_000_000;                  // 2023-11-14T22:13:20Z
const RESET_AT = 1_700_018_000_000;
const SILENT = createLogger('test:usage', { level: 'silent' });

function tmpStore(t, clock) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-usage-'));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });
  return { dir, store: new Store({ dir, clock }) };
}

function window(key, usedPercent, { resetsAt = RESET_AT, measuredAt = T0 } = {}) {
  return {
    key,
    label: key === 'five_hour' ? '5-hour' : '7-day',
    utilization: usedPercent / 100,
    usedPercent,
    remainingPercent: 100 - usedPercent,
    resetsAt,
    unit: 'percent',
    source: 'claude-subscription',
    measuredAt,
  };
}

function success(measuredAt, windows) {
  return { ok: true, source: 'claude-subscription', measuredAt, windows };
}

function failure(measuredAt, reason = 'network') {
  return {
    ok: false,
    source: 'claude-subscription',
    measuredAt,
    reason,
    message: `simulated ${reason} failure`,
    remedy: 'Run `claude setup-token` and retry.',
  };
}

/** Provider double: hands back queued measurements in order. */
function fakeProvider(...queue) {
  return {
    name: 'claude-subscription',
    calls: 0,
    queue: [...queue],
    async measure() {
      this.calls += 1;
      const next = this.queue.length > 1 ? this.queue.shift() : this.queue[0];
      if (next instanceof Error) throw next;
      return next;
    },
  };
}

function harness(t, { provider, staleAfterMs = 15 * 60_000, timezone = 'UTC', startMs = T0 } = {}) {
  const clock = new FakeClock(startMs, timezone);
  const { dir, store } = tmpStore(t, clock);
  const bus = new EventBus();
  const events = [];
  bus.on('capacity.updated', (e) => events.push(e));
  bus.on('capacity.unavailable', (e) => events.push(e));
  const usage = new UsageService({ store, bus, clock, provider, staleAfterMs, logger: SILENT });
  return { clock, store, bus, events, usage, dir };
}

// ---------------------------------------------------------------- live

test('a fresh successful refresh reports status live with the full window shape', async (t) => {
  const provider = fakeProvider(success(T0, [window('five_hour', 40)]));
  const { usage, clock, events } = harness(t, { provider, timezone: 'America/New_York' });

  clock.set(T0 + 1_200);
  const report = await usage.refresh();

  assert.equal(report.status, 'live');
  assert.equal(report.measuredAt, T0);
  assert.equal(report.ageMs, 1_200);
  assert.equal(report.timezone, 'America/New_York');
  assert.equal(report.explanation, null);
  assert.equal(report.recovery, null);
  assert.equal(report.lastError, null);
  assert.equal(report.staleAfterMs, 15 * 60_000);
  assert.equal(report.windows.length, 1);

  const w = report.windows[0];
  assert.equal(w.key, 'five_hour');
  assert.equal(w.usedPercent, 40);
  assert.equal(w.remainingPercent, 60);
  assert.equal(w.unit, 'percent');
  assert.equal(w.freshness, 'live');

  const expected = new Intl.DateTimeFormat('en-US', {
    weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
    timeZone: 'America/New_York',
  }).format(new Date(RESET_AT));
  assert.equal(w.resetsAtLocal, expected);
  const utc = new Intl.DateTimeFormat('en-US', {
    weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'UTC',
  }).format(new Date(RESET_AT));
  assert.notEqual(w.resetsAtLocal, utc, 'resetsAtLocal must honour clock.timezone()');

  assert.deepEqual(events.map((e) => e.type), ['capacity.updated']);
  assert.equal(events[0].payload.status, 'live');
  assert.equal(usage.windowsForScheduling().length, 1);
  assert.deepEqual(usage.report(), report, 'report() is a pure read of the same state');
});

// ---------------------------------------------------------------- stale by age

test('a reading older than staleAfterMs becomes stale with a truthful ageMs', async (t) => {
  const provider = fakeProvider(success(T0, [window('five_hour', 10), window('seven_day', 55)]));
  const { usage, clock } = harness(t, { provider, staleAfterMs: 60_000 });

  const live = await usage.refresh();
  assert.equal(live.status, 'live');

  clock.set(T0 + 60_001);
  const stale = usage.report();
  assert.equal(stale.status, 'stale');
  assert.equal(stale.ageMs, 60_001);
  assert.equal(stale.measuredAt, T0);
  assert.deepEqual(stale.windows.map((w) => w.usedPercent), [10, 55]);
  assert.equal(stale.windows.every((w) => w.freshness === 'stale'), true);
  assert.equal(typeof stale.explanation, 'string');
  assert.ok(stale.explanation.length > 0);
  assert.equal(usage.windowsForScheduling().length, 2, 'stale readings are still usable for pacing');
});

/**
 * ADDED BY AUDIT — the freshness boundary itself.
 *
 * "Older than staleAfterMs" is a strict comparison, and the whole honesty
 * guarantee ("never present a stale reading as live") lives on the exact
 * millisecond it flips. A `>=` here would call a just-in-time reading stale;
 * a `>` on the wrong side of the age arithmetic would keep serving an expired
 * one as live. Pin both sides of the edge, and the emitted payload with them.
 */
test('the live/stale edge is exact: staleAfterMs is still live, one millisecond more is not', async (t) => {
  const provider = fakeProvider(success(T0, [window('five_hour', 40)]));
  const { usage, clock, events } = harness(t, { provider, staleAfterMs: 60_000 });

  await usage.refresh();

  clock.set(T0 + 59_999);
  assert.equal(usage.report().status, 'live', 'just inside the window is live');

  clock.set(T0 + 60_000);
  const atEdge = usage.report();
  assert.equal(atEdge.status, 'live', 'exactly staleAfterMs old is not yet older than staleAfterMs');
  assert.equal(atEdge.ageMs, 60_000);
  assert.equal(atEdge.windows[0].freshness, 'live');
  assert.equal(atEdge.explanation, null);

  clock.set(T0 + 60_001);
  const past = usage.report();
  assert.equal(past.status, 'stale', 'one millisecond past the limit is stale');
  assert.equal(past.ageMs, 60_001);
  assert.equal(past.windows[0].freshness, 'stale');
  assert.equal(past.windows[0].usedPercent, 40, 'the last known number is still the one shown');
  assert.match(past.explanation, /60s/, 'the explanation states the real age, not a placeholder');
  assert.ok(past.recovery);

  // Re-measuring at the same instant clears it again — the edge is about age, not a latch.
  provider.queue = [success(T0 + 60_001, [window('five_hour', 41, { measuredAt: T0 + 60_001 })])];
  const refreshed = await usage.refresh();
  assert.equal(refreshed.status, 'live');
  assert.equal(refreshed.ageMs, 0);
  assert.deepEqual(events.map((e) => e.payload.status), ['live', 'live']);
});

// ---------------------------------------------------------------- stale after failure

test('a failure after a success keeps the last-known windows and marks them stale', async (t) => {
  const provider = fakeProvider(success(T0, [window('five_hour', 33)]), failure(T0 + 5_000, 'network'));
  const { usage, clock, events } = harness(t, { provider });

  await usage.refresh();
  clock.set(T0 + 5_000);
  const report = await usage.refresh();

  assert.equal(report.status, 'stale');
  assert.equal(report.measuredAt, T0, 'the failed attempt must not become the measurement time');
  assert.equal(report.ageMs, 5_000);
  assert.equal(report.windows.length, 1);
  assert.equal(report.windows[0].usedPercent, 33, 'last-known value is preserved');
  assert.equal(report.windows[0].freshness, 'stale');
  assert.equal(report.lastError.reason, 'network');
  assert.equal(report.recovery, provider.queue[0].remedy);
  assert.match(report.explanation, /network/);

  assert.deepEqual(events.map((e) => e.type), ['capacity.updated', 'capacity.updated']);
  assert.equal(events[1].payload.status, 'stale', 'a degraded report is never published as live');

  // Recovering flips it back to live.
  provider.queue = [success(T0 + 9_000, [window('five_hour', 35)])];
  clock.set(T0 + 9_000);
  const recovered = await usage.refresh();
  assert.equal(recovered.status, 'live');
  assert.equal(recovered.lastError, null);
  assert.equal(recovered.ageMs, 0);
});

// ---------------------------------------------------------------- unavailable

test('no reading ever gives status unavailable with empty windows plus explanation and recovery', async (t) => {
  const provider = fakeProvider(failure(T0, 'not_authenticated'));
  const { usage, events } = harness(t, { provider });

  const before = usage.report();
  assert.equal(before.status, 'unavailable');
  assert.deepEqual(before.windows, []);
  assert.equal(before.measuredAt, null);
  assert.equal(before.ageMs, null);
  assert.ok(before.explanation);
  assert.ok(before.recovery);

  const report = await usage.refresh();
  assert.equal(report.status, 'unavailable');
  assert.deepEqual(report.windows, [], 'unknown must render as nothing, never as a 0% window');
  assert.equal(report.measuredAt, null);
  assert.equal(report.ageMs, null);
  assert.equal(typeof report.explanation, 'string');
  assert.ok(report.explanation.length > 0);
  assert.equal(typeof report.recovery, 'string');
  assert.match(report.recovery, /claude setup-token/);
  assert.equal(report.lastError.reason, 'not_authenticated');

  assert.deepEqual(events.map((e) => e.type), ['capacity.unavailable']);
  assert.deepEqual(usage.windowsForScheduling(), []);
});

test('the unknown-is-never-0% invariant holds for empty and unusable measurements', async (t) => {
  const provider = fakeProvider({ ok: true, source: 'claude-subscription', measuredAt: T0, windows: [] });
  const { usage } = harness(t, { provider });

  const report = await usage.refresh();
  assert.equal(report.status, 'unavailable');
  assert.deepEqual(report.windows, []);
  assert.equal(JSON.stringify(report).includes('"usedPercent":0'), false);
  assert.equal(worstRemaining(report), null, 'unknown capacity is null, not 100 or 0');

  // A window whose usedPercent is not a finite number is discarded rather than zeroed.
  const bogus = usage.ingestWorkerReport(success(T0, [{ key: 'five_hour', usedPercent: null, remainingPercent: null }]));
  assert.equal(bogus.status, 'unavailable');
  assert.deepEqual(bogus.windows, []);
});

// ---------------------------------------------------------------- persistence

test('the last good snapshot survives a fresh UsageService over the same store', async (t) => {
  const clock = new FakeClock(T0, 'UTC');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-usage-persist-'));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

  const storeA = new Store({ dir, clock });
  const first = new UsageService({
    store: storeA, bus: new EventBus(), clock,
    provider: fakeProvider(success(T0, [window('five_hour', 72)])),
    logger: SILENT,
  });
  await first.refresh();
  storeA.flush();

  const persisted = storeA.get('capacity', 'last');
  assert.ok(persisted, 'the snapshot is written to capacity/last');
  assert.equal(persisted.measuredAt, T0);
  assert.equal(persisted.windows[0].usedPercent, 72);

  // A brand new process: new Store over the same dir, new service, provider never called.
  const storeB = new Store({ dir, clock });
  const provider = fakeProvider(failure(T0, 'network'));
  const reborn = new UsageService({ store: storeB, bus: new EventBus(), clock, provider, logger: SILENT });

  const report = reborn.report();
  assert.equal(provider.calls, 0, 'reload must come from the store, not a fresh measurement');
  assert.equal(report.status, 'live');
  assert.equal(report.measuredAt, T0);
  assert.equal(report.windows[0].usedPercent, 72);

  clock.set(T0 + 16 * 60_000);
  assert.equal(reborn.report().status, 'stale', 'a reloaded old snapshot ages honestly');
});

/**
 * ADDED BY AUDIT — hardest requirement #2: "unknown must never render as 0%",
 * including across a restart.
 *
 * The live ingest path validates its windows, but the constructor's reload from
 * `capacity/last` is a second, quieter door into exactly the same state. A
 * snapshot written by an older build, truncated by a crash, or edited by hand
 * must not be able to walk back in as a reading: doing so reports `live` while
 * handing the dashboard a `usedPercent` of null (a 0% ring) and the scheduler a
 * window it will happily read as free capacity.
 */
test('a corrupt persisted snapshot is discarded, not resurrected as a reading', async (t) => {
  const clock = new FakeClock(T0, 'UTC');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-usage-corrupt-'));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

  const store = new Store({ dir, clock });
  store.put('capacity', 'last', {
    id: 'last',
    measuredAt: T0,
    source: 'claude-subscription',
    savedAt: T0,
    windows: [
      { key: 'five_hour', label: '5-hour', usedPercent: null, remainingPercent: null, unit: 'percent' },
      { key: 'seven_day', label: '7-day', usedPercent: Number.NaN, remainingPercent: 0, unit: 'percent' },
    ],
  });

  const provider = fakeProvider(failure(T0, 'network'));
  const usage = new UsageService({ store, bus: new EventBus(), clock, provider, logger: SILENT });

  const report = usage.report();
  assert.equal(provider.calls, 0, 'this is the reload path, not a fresh measurement');
  assert.equal(report.status, 'unavailable', 'an unreadable snapshot is no reading at all');
  assert.deepEqual(report.windows, [], 'and certainly not a 0% ring');
  assert.equal(report.measuredAt, null);
  assert.equal(report.ageMs, null);
  assert.ok(report.explanation && report.explanation.length > 0);
  assert.ok(report.recovery && report.recovery.length > 0);
  assert.equal(JSON.stringify(report).includes('"usedPercent":0'), false);
  assert.deepEqual(usage.windowsForScheduling(), [],
    'the scheduler must be told "unknown", never handed a null-valued window');
  assert.equal(worstRemaining(report), null);

  // A partially corrupt snapshot keeps only the windows that are real.
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-usage-partial-'));
  t.after(() => { try { fs.rmSync(dir2, { recursive: true, force: true }); } catch { /* ignore */ } });
  const store2 = new Store({ dir: dir2, clock });
  store2.put('capacity', 'last', {
    id: 'last', measuredAt: T0, source: 'claude-subscription', savedAt: T0,
    windows: [
      { key: 'five_hour', label: '5-hour', usedPercent: 'lots', unit: 'percent' },
      window('seven_day', 44),
    ],
  });
  const partial = new UsageService({
    store: store2, bus: new EventBus(), clock, provider: fakeProvider(failure(T0)), logger: SILENT,
  }).report();
  assert.equal(partial.status, 'live');
  assert.deepEqual(partial.windows.map((w) => w.key), ['seven_day'], 'only the readable window came back');
  assert.equal(partial.windows[0].usedPercent, 44);
});

// ---------------------------------------------------------------- worker report leg

test('ingestWorkerReport updates the snapshot and emits capacity.updated like refresh', async (t) => {
  const { usage, store, events, clock } = harness(t, { provider: fakeProvider(failure(T0)) });

  clock.set(T0 + 100);
  const report = usage.ingestWorkerReport(success(T0 + 100, [window('seven_day', 20, { measuredAt: T0 + 100 })]));

  assert.equal(report.status, 'live');
  assert.equal(report.windows[0].usedPercent, 20);
  assert.deepEqual(events.map((e) => e.type), ['capacity.updated']);
  assert.equal(events[0].payload.windows[0].key, 'seven_day');
  assert.equal(store.get('capacity', 'last').windows[0].usedPercent, 20,
    'the worker leg persists the snapshot exactly like the provider leg');
});

test('a failed worker report degrades to stale when a prior reading exists, unavailable otherwise', async (t) => {
  const coldHarness = harness(t, { provider: fakeProvider(failure(T0)) });
  const cold = coldHarness.usage.ingestWorkerReport(failure(T0, 'unauthorized'));
  assert.equal(cold.status, 'unavailable');
  assert.deepEqual(cold.windows, []);
  assert.deepEqual(coldHarness.events.map((e) => e.type), ['capacity.unavailable']);

  const warm = harness(t, { provider: fakeProvider(success(T0, [window('five_hour', 15)])) });
  await warm.usage.refresh();
  warm.clock.set(T0 + 2_000);
  const degraded = warm.usage.ingestWorkerReport(failure(T0 + 2_000, 'unauthorized'));
  assert.equal(degraded.status, 'stale');
  assert.equal(degraded.ageMs, 2_000);
  assert.equal(degraded.windows[0].usedPercent, 15);
  assert.equal(degraded.lastError.reason, 'unauthorized');
});

/**
 * ADDED BY AUDIT — the worker leg is an untrusted door into the same state.
 *
 * `ingestWorkerReport` takes a Measurement from a background worker, not from
 * the provider that carefully drops aberrant values. An internally inconsistent
 * window is worse than a missing one: `usedPercent:-50, remainingPercent:150`
 * reads as "more than full capacity" and would push the scheduler to maximum
 * concurrency at exactly the moment it should be backing off.
 */
test('an aberrant worker window is dropped, never trusted as spare capacity', async (t) => {
  const cold = harness(t, { provider: fakeProvider(failure(T0)) });

  const impossible = cold.usage.ingestWorkerReport({
    ok: true, source: 'worker', measuredAt: T0,
    windows: [{ key: 'five_hour', label: '5-hour', usedPercent: -50, remainingPercent: 150, unit: 'percent' }],
  });
  assert.equal(impossible.status, 'unavailable', 'a negative usage is not a reading');
  assert.deepEqual(impossible.windows, []);
  assert.equal(worstRemaining(impossible), null, 'and never 150% of anything');
  assert.deepEqual(cold.usage.windowsForScheduling(), []);
  assert.deepEqual(cold.events.map((e) => e.type), ['capacity.unavailable']);

  // Keyless and non-object entries are dropped for the same reason.
  const keyless = cold.usage.ingestWorkerReport({
    ok: true, source: 'worker', measuredAt: T0, windows: [{ usedPercent: 30 }, null, 'five_hour'],
  });
  assert.equal(keyless.status, 'unavailable');
  assert.deepEqual(keyless.windows, []);

  // A real reading still lands — and its derived fields are made consistent.
  const warm = harness(t, { provider: fakeProvider(failure(T0)) });
  const good = warm.usage.ingestWorkerReport({
    ok: true, source: 'worker', measuredAt: T0,
    windows: [
      { key: 'five_hour', label: '5-hour', usedPercent: 82, remainingPercent: 99, utilization: 0.01, unit: 'percent' },
      { key: 'five_hour', label: '5-hour', usedPercent: 84, unit: 'percent' },
    ],
  });
  assert.equal(good.status, 'live');
  assert.equal(good.windows.length, 1, 'a repeated key is one limit, not two circles');
  assert.equal(good.windows[0].usedPercent, 84, 'the later reading wins');
  assert.equal(good.windows[0].remainingPercent, 16,
    'remaining is re-derived, so a contradictory 99 cannot claim spare capacity');
  assert.equal(good.windows[0].utilization, 0.84);
  assert.equal(worstRemaining(good), 16);
});

// ---------------------------------------------------------------- robustness

test('refresh() does not throw when the provider throws, and records a network failure', async (t) => {
  const provider = fakeProvider(new Error('boom'));
  const { usage } = harness(t, { provider });

  const report = await usage.refresh();
  assert.equal(report.status, 'unavailable');
  assert.equal(report.lastError.reason, 'network');
  assert.match(report.lastError.message, /boom/);
});

test('windowsForScheduling hands out copies, not internal state', async (t) => {
  const { usage } = harness(t, { provider: fakeProvider(success(T0, [window('five_hour', 10)])) });
  await usage.refresh();

  const windows = usage.windowsForScheduling();
  windows[0].usedPercent = 999;
  assert.equal(usage.windowsForScheduling()[0].usedPercent, 10);
  assert.equal(usage.report().windows[0].usedPercent, 10);
});

// ---------------------------------------------------------------- report.js

test('worstRemaining picks the tightest window and is null when unknown', async (t) => {
  const { usage } = harness(t, { provider: fakeProvider(success(T0, [window('five_hour', 30), window('seven_day', 91)])) });
  const report = await usage.refresh();
  assert.equal(worstRemaining(report), 9);
  assert.equal(worstRemaining({ status: 'unavailable', windows: [] }), null);
  assert.equal(worstRemaining(null), null);
});

test('summarizeForSpeech stays quiet unless something is worth saying', async (t) => {
  const provider = fakeProvider(success(T0, [window('five_hour', 30)]));
  const { usage, clock } = harness(t, { provider, timezone: 'UTC' });

  const healthy = await usage.refresh();
  assert.equal(summarizeForSpeech(healthy), null, 'plenty of capacity is not worth speaking');

  // First transition to unavailable speaks once, then goes quiet.
  const cold = harness(t, { provider: fakeProvider(failure(T0, 'not_authenticated')) });
  const down = await cold.usage.refresh();
  const first = summarizeForSpeech(down);
  assert.equal(typeof first, 'string');
  assert.match(first, /can't read your Claude usage limits/i, 'it names what is actually wrong');
  assert.match(first, /conservativ/i, 'and what it is doing about it');
  assert.equal(/\d+\s*%/.test(first), false,
    'unknown capacity must never be spoken as a percentage — not even 0%');
  assert.equal(summarizeForSpeech(down, { previous: down }), null, 'must not repeat itself');
  assert.equal(summarizeForSpeech(down, { previous: healthy }), first,
    'but a live -> unavailable transition still speaks');

  // Crossing into the low band speaks; staying there does not.
  provider.queue = [success(T0 + 1_000, [window('five_hour', 92, { measuredAt: T0 + 1_000 })])];
  clock.set(T0 + 1_000);
  const low = await usage.refresh();
  const said = summarizeForSpeech(low, { previous: healthy });
  assert.match(said, /8%/);
  assert.match(said, /5-hour/);
  assert.ok(said.length <= 120, `speech should stay short: ${said.length} chars`);
  assert.equal(summarizeForSpeech(low, { previous: low }), null);

  // Getting worse still speaks.
  provider.queue = [success(T0 + 2_000, [window('five_hour', 97, { measuredAt: T0 + 2_000 })])];
  clock.set(T0 + 2_000);
  const critical = await usage.refresh();
  const escalated = summarizeForSpeech(critical, { previous: low });
  assert.equal(typeof escalated, 'string');
  assert.match(escalated, /3%/);
  assert.equal(summarizeForSpeech(healthy, { previous: critical }), null, 'recovery is not chatter');
});
