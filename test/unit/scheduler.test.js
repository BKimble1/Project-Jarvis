import test from 'node:test';
import assert from 'node:assert/strict';

import { FakeClock } from '../../src/core/clock.js';
import { EventBus } from '../../src/core/bus.js';
import { Scheduler, bandFor, BANDS, UNKNOWN_CONCURRENCY, UNKNOWN_PACE_MS } from '../../src/orchestrator/scheduler.js';
import { WorkerPool } from '../../src/workers/pool.js';
// Helpers come from fakes.js rather than harness.js: harness.js wires the whole
// app, and these are unit tests of the scheduler alone.
import { silentLogger } from '../helpers/fakes.js';

/** A CapacityWindow with a given remaining percentage. */
function win(remainingPercent, key = 'five_hour') {
  return {
    key,
    label: key === 'five_hour' ? '5-hour' : key,
    utilization: (100 - remainingPercent) / 100,
    usedPercent: 100 - remainingPercent,
    remainingPercent,
    resetsAt: 3_600_000,
    unit: 'percent',
    source: 'stub',
    measuredAt: 0,
  };
}

/**
 * Stand-in for UsageService: mutable between calls so a test can prove the
 * scheduler re-reads capacity instead of caching it at construction.
 */
function stubUsage({ status = 'live', windows = [] } = {}) {
  return {
    status,
    windows,
    reads: { report: 0, windows: 0 },
    report() {
      this.reads.report += 1;
      return {
        status: this.status,
        measuredAt: this.status === 'unavailable' ? null : 0,
        ageMs: this.status === 'unavailable' ? null : 0,
        timezone: 'UTC',
        windows: this.status === 'unavailable' ? [] : this.windows,
        explanation: this.status === 'unavailable' ? 'no reading' : null,
        recovery: this.status === 'unavailable' ? 'run claude setup-token' : null,
        lastError: null,
        staleAfterMs: 900_000,
      };
    },
    windowsForScheduling() {
      this.reads.windows += 1;
      return this.status === 'unavailable' ? [] : this.windows.map((w) => ({ ...w }));
    },
  };
}

function makeScheduler(usage, opts = {}) {
  return new Scheduler({
    clock: opts.clock ?? new FakeClock(0),
    usage,
    bus: opts.bus ?? new EventBus(),
    maxConcurrency: opts.maxConcurrency ?? 4,
    minConcurrency: opts.minConcurrency ?? 1,
    logger: silentLogger(),
  });
}

/** Advance virtual time until `promise` settles. Never waits on real time. */
async function drive(clock, promise, { stepMs = 1_000, maxSteps = 500 } = {}) {
  const state = { done: false, ok: false, value: undefined, error: undefined };
  const tracked = promise.then(
    (v) => { state.done = true; state.ok = true; state.value = v; },
    (e) => { state.done = true; state.ok = false; state.error = e; },
  );
  for (let i = 0; i < maxSteps && !state.done; i += 1) await clock.advance(stepMs);
  if (!state.done) throw new Error('promise did not settle within the virtual time budget');
  await tracked;
  return state;
}

// --------------------------------------------------------------- banding

test('band >= 50% remaining: full concurrency, no pacing', () => {
  const usage = stubUsage({ windows: [win(72)] });
  const scheduler = makeScheduler(usage, { maxConcurrency: 4 });

  assert.equal(scheduler.concurrency(), 4);
  assert.equal(scheduler.paceDelayMs(), 0);
  assert.deepEqual(scheduler.describe(), {
    concurrency: 4, paceDelayMs: 0, basis: 'live', worstRemainingPercent: 72,
  });
});

test('band 20-50% remaining: half concurrency rounded up, 250ms pacing', () => {
  const usage = stubUsage({ windows: [win(35)] });

  assert.equal(makeScheduler(usage, { maxConcurrency: 4 }).concurrency(), 2);
  assert.equal(makeScheduler(usage, { maxConcurrency: 5 }).concurrency(), 3, 'rounds up');
  assert.equal(makeScheduler(usage, { maxConcurrency: 1 }).concurrency(), 1, 'never below minConcurrency');
  assert.equal(makeScheduler(usage, { maxConcurrency: 4 }).paceDelayMs(), 250);
  assert.equal(makeScheduler(usage, { maxConcurrency: 4 }).describe().basis, 'live');
});

test('band 5-20% remaining: minimum concurrency, 2000ms pacing', () => {
  const usage = stubUsage({ windows: [win(12)] });
  const scheduler = makeScheduler(usage, { maxConcurrency: 6, minConcurrency: 1 });

  assert.equal(scheduler.concurrency(), 1);
  assert.equal(scheduler.paceDelayMs(), 2_000);
  assert.equal(makeScheduler(usage, { maxConcurrency: 6, minConcurrency: 2 }).concurrency(), 2);
});

test('band < 5% remaining: minimum concurrency, 10000ms pacing', () => {
  const usage = stubUsage({ windows: [win(2)] });
  const scheduler = makeScheduler(usage, { maxConcurrency: 8, minConcurrency: 1 });

  assert.equal(scheduler.concurrency(), 1);
  assert.equal(scheduler.paceDelayMs(), 10_000);
  assert.equal(scheduler.describe().worstRemainingPercent, 2);
});

test('unknown capacity: conservative min(2, maxConcurrency), 500ms pacing, basis unknown', () => {
  const usage = stubUsage({ status: 'unavailable', windows: [] });
  const scheduler = makeScheduler(usage, { maxConcurrency: 4 });

  assert.equal(scheduler.concurrency(), Math.min(UNKNOWN_CONCURRENCY, 4));
  assert.equal(scheduler.concurrency(), 2);
  assert.equal(scheduler.paceDelayMs(), UNKNOWN_PACE_MS);
  assert.deepEqual(scheduler.describe(), {
    concurrency: 2, paceDelayMs: 500, basis: 'unknown', worstRemainingPercent: null,
  });
  // Unknown must never be reported as 0% remaining.
  assert.notEqual(scheduler.describe().worstRemainingPercent, 0);

  assert.equal(makeScheduler(usage, { maxConcurrency: 1 }).concurrency(), 1, 'capped by maxConcurrency');
});

test('an empty window list is unknown, not 100% free', () => {
  const scheduler = makeScheduler(stubUsage({ status: 'live', windows: [] }), { maxConcurrency: 4 });
  assert.deepEqual(scheduler.describe(), {
    concurrency: 2, paceDelayMs: 500, basis: 'unknown', worstRemainingPercent: null,
  });
});

test('band boundaries are inclusive at 50, 20 and 5', () => {
  assert.equal(bandFor(50).name, 'ample');
  assert.equal(bandFor(49.9).name, 'moderate');
  assert.equal(bandFor(20).name, 'moderate');
  assert.equal(bandFor(19.9).name, 'low');
  assert.equal(bandFor(5).name, 'low');
  assert.equal(bandFor(4.9).name, 'critical');
  assert.equal(bandFor(0.5).name, 'critical');
  assert.equal(bandFor(0.4).name, 'exhausted', 'an emptied window is its own band');
  assert.equal(bandFor(0).name, 'exhausted');
  assert.equal(bandFor(null), null);
  assert.equal(bandFor(Number.NaN), null);
  assert.equal(BANDS.length, 5);
});

test('an exhausted window holds work until capacity comes back', async () => {
  const clock = new FakeClock(0);
  const usage = stubUsage({ windows: [win(0, 'five_hour')] });
  const scheduler = makeScheduler(usage, { clock, maxConcurrency: 4 });

  assert.equal(scheduler.concurrency(), 0, 'nothing runs against a spent limit');
  assert.equal(scheduler.paceDelayMs(), 0, 'it waits rather than paces');

  // The gate holds while there is no capacity at all...
  let released = false;
  const gate = scheduler.gate().then(() => { released = true; });
  await clock.advance(5_000);
  assert.equal(released, false, 'the gate held while the limit was spent');

  // ...and releases as soon as a refreshed reading shows the window reset.
  usage.windows = [win(100, 'five_hour')];
  await drive(clock, gate);
  assert.equal(released, true, 'saved work resumes the moment capacity resets');
  assert.equal(scheduler.concurrency(), 4);
});

test('the tightest window decides the band', () => {
  const usage = stubUsage({ windows: [win(90, 'five_hour'), win(8, 'seven_day'), win(60, 'seven_day_opus')] });
  const scheduler = makeScheduler(usage, { maxConcurrency: 4 });

  assert.equal(scheduler.describe().worstRemainingPercent, 8);
  assert.equal(scheduler.concurrency(), 1);
  assert.equal(scheduler.paceDelayMs(), 2_000);
});

test('windows carrying only utilization or usedPercent still band correctly', () => {
  const utilizationOnly = { key: 'five_hour', label: '5-hour', utilization: 0.9 };
  const usedOnly = { key: 'seven_day', label: '7-day', usedPercent: 88 };

  assert.equal(makeScheduler(stubUsage({ windows: [utilizationOnly] })).describe().worstRemainingPercent, 10);
  assert.equal(makeScheduler(stubUsage({ windows: [usedOnly] })).describe().worstRemainingPercent, 12);
});

test('stale readings are still used, but reported as basis stale', () => {
  const usage = stubUsage({ status: 'stale', windows: [win(12)] });
  const scheduler = makeScheduler(usage, { maxConcurrency: 4 });

  assert.deepEqual(scheduler.describe(), {
    concurrency: 1, paceDelayMs: 2_000, basis: 'stale', worstRemainingPercent: 12,
  });
});

test('a usage service that throws is treated as unknown, not as free capacity', () => {
  const exploding = {
    report() { throw new Error('boom'); },
    windowsForScheduling() { throw new Error('boom'); },
  };
  const scheduler = makeScheduler(exploding, { maxConcurrency: 4 });
  assert.equal(scheduler.concurrency(), 2);
  assert.equal(scheduler.describe().basis, 'unknown');
});

// ------------------------------------------------------- reacting mid-run

test('capacity is re-read on every call, never cached at construction', () => {
  const usage = stubUsage({ windows: [win(80)] });
  const scheduler = makeScheduler(usage, { maxConcurrency: 4 });

  assert.equal(scheduler.concurrency(), 4);
  assert.equal(scheduler.paceDelayMs(), 0);

  usage.windows = [win(30)];
  assert.equal(scheduler.concurrency(), 2);
  assert.equal(scheduler.paceDelayMs(), 250);

  usage.windows = [win(9)];
  assert.equal(scheduler.concurrency(), 1);
  assert.equal(scheduler.paceDelayMs(), 2_000);

  usage.status = 'unavailable';
  assert.equal(scheduler.describe().basis, 'unknown');

  assert.ok(usage.reads.windows >= 6, 'windowsForScheduling() is consulted on every call');
  assert.ok(usage.reads.report >= 6, 'report().status is consulted on every call');
});

// ------------------------------------------------------------------ gate

test('gate sleeps the band pace through the injected clock', async () => {
  const clock = new FakeClock(0);
  const usage = stubUsage({ windows: [win(12)] });          // 5-20% -> 2000ms
  const scheduler = makeScheduler(usage, { clock, maxConcurrency: 4 });

  let released = 0;
  const gate = scheduler.gate().then(() => { released = clock.now(); });

  await clock.advance(1_999);
  assert.equal(released, 0, 'still gated before the pace elapses');

  await clock.advance(1);
  assert.equal(released, 2_000);
  await gate;
});

test('gate does not sleep at all when capacity is ample', async () => {
  const clock = new FakeClock(0);
  const scheduler = makeScheduler(stubUsage({ windows: [win(80)] }), { clock });

  await scheduler.gate();
  assert.equal(clock.now(), 0);
});

test('gate blocks while concurrency is zero and releases when capacity returns', async () => {
  const clock = new FakeClock(0);
  const usage = stubUsage({ windows: [win(12)] });
  // minConcurrency 0 is the only way the band maths can reach zero.
  const scheduler = makeScheduler(usage, { clock, maxConcurrency: 4, minConcurrency: 0 });
  assert.equal(scheduler.concurrency(), 0);

  let released = false;
  const gate = scheduler.gate().then(() => { released = true; });

  await clock.advance(10_000);
  assert.equal(released, false, 'zero capacity keeps the gate shut');

  usage.windows = [win(80)];
  await clock.advance(1_000);
  assert.equal(released, true, 'the gate re-reads capacity and releases');
  await gate;
});

// ------------------------------------------------- capacity changes work

test('a low-capacity report actually reduces observed peak concurrency', async () => {
  async function peakFor(windows, { maxConcurrency = 4, tasks = 8, taskMs = 100 } = {}) {
    const clock = new FakeClock(0);
    const usage = stubUsage({ windows });
    const scheduler = makeScheduler(usage, { clock, maxConcurrency });
    let active = 0;
    let observedPeak = 0;
    const executor = async (task, ctx) => {
      active += 1;
      observedPeak = Math.max(observedPeak, active);
      await ctx.clock.sleep(taskMs);
      active -= 1;
      return { taskId: task.id };
    };
    const pool = new WorkerPool({ clock, bus: new EventBus(), scheduler, size: maxConcurrency, executor, logger: silentLogger() });
    const all = Promise.all(
      Array.from({ length: tasks }, (_, i) => pool.submit({ id: `t${i}`, projectId: 'p1', title: `task ${i}`, kind: 'implement' }, {})),
    );
    const state = await drive(clock, all);
    assert.equal(state.ok, true, state.error?.message);
    assert.equal(state.value.length, tasks);
    return { poolPeak: pool.peakConcurrency, observedPeak };
  }

  const ample = await peakFor([win(80)]);
  assert.equal(ample.poolPeak, 4);
  assert.equal(ample.observedPeak, 4);

  const scarce = await peakFor([win(8)]);
  assert.equal(scarce.poolPeak, 1, 'low capacity must narrow the pipe, not just the display');
  assert.equal(scarce.observedPeak, 1);

  // Unknown capacity: two at a time, and only because each task outlasts the
  // 500ms conservative pace — shorter tasks would be serialised by it.
  const unknown = await peakFor([], { taskMs: 2_000 });
  assert.equal(unknown.poolPeak, 2, 'unknown capacity is capped at two');
  assert.equal(unknown.observedPeak, 2);
});

// ------------------------------------------------------------ guardrails

test('Scheduler requires a clock and clamps its bounds', () => {
  assert.throws(() => new Scheduler({ usage: stubUsage() }), /clock/);

  const weird = new Scheduler({
    clock: new FakeClock(0),
    usage: stubUsage({ windows: [win(80)] }),
    maxConcurrency: 2,
    minConcurrency: 9,
    logger: silentLogger(),
  });
  assert.equal(weird.minConcurrency, 2, 'minConcurrency can never exceed maxConcurrency');
  assert.equal(weird.concurrency(), 2);
});
