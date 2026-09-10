import test from 'node:test';
import assert from 'node:assert/strict';
import { makeApp, StubProvider, liveMeasurement, failedMeasurement, AutoClock, createScriptedExecutor } from '../helpers/harness.js';

/**
 * Acceptance requirement 5 — "Make the usage circles real".
 * Provider measurement -> worker report -> stored capacity -> dashboard circles,
 * and the same numbers must actually pace the work.
 */

test('req5.1 the whole path carries a real reading through to the dashboard', async (t) => {
  const clock = new AutoClock();
  const provider = new StubProvider([
    liveMeasurement(clock, [
      { key: 'five_hour', label: '5-hour', usedPercent: 32, resetsAt: clock.now() + 90 * 60_000 },
      { key: 'seven_day', label: '7-day', usedPercent: 61, resetsAt: clock.now() + 3 * 86_400_000 },
    ]),
  ]);
  const app = makeApp({ clock, provider });
  t.after(() => app.cleanup());

  await app.usage.refresh();
  const state = app.state('c1');

  assert.equal(state.capacity.status, 'live');
  assert.equal(state.capacity.windows.length, 2, 'one circle per window the provider actually reported');

  const five = state.capacity.windows.find((w) => w.key === 'five_hour');
  assert.equal(five.label, '5-hour', 'labelled as the provider reports it');
  assert.equal(Math.round(five.usedPercent), 32, 'real percentage used');
  assert.equal(Math.round(five.remainingPercent), 68, 'real remaining capacity');
  assert.ok(five.resetsAtLocal, 'a reset time rendered in the operator timezone');
  assert.equal(five.freshness, 'live', 'measurement freshness is shown');
  assert.equal(typeof state.capacity.ageMs, 'number');
});

test('req5.2 a stale reading is shown as last-known with its age, never as live', async (t) => {
  const clock = new AutoClock();
  const provider = new StubProvider([liveMeasurement(clock, [{ key: 'five_hour', usedPercent: 40 }])]);
  const app = makeApp({ clock, provider, appOptions: { staleAfterMs: 60_000 } });
  t.after(() => app.cleanup());

  await app.usage.refresh();
  assert.equal(app.usage.report().status, 'live');

  clock.advance(10 * 60_000);
  const stale = app.usage.report();
  assert.equal(stale.status, 'stale');
  assert.equal(stale.ageMs, 10 * 60_000, 'the age is truthful');
  assert.equal(Math.round(stale.windows[0].usedPercent), 40, 'the last known number is preserved');
  assert.equal(stale.windows[0].freshness, 'stale');
});

test('req5.3 a failed refresh keeps the last known reading instead of inventing one', async (t) => {
  const clock = new AutoClock();
  const provider = new StubProvider([liveMeasurement(clock, [{ key: 'five_hour', usedPercent: 55 }])]);
  const app = makeApp({ clock, provider });
  t.after(() => app.cleanup());

  await app.usage.refresh();
  clock.advance(5 * 60_000);
  provider.push(failedMeasurement(clock, 'network'));
  provider.queue.shift();
  const after = await app.usage.refresh();

  assert.equal(after.status, 'stale');
  assert.equal(Math.round(after.windows[0].usedPercent), 55, 'the last good reading survived the failure');
  assert.ok(after.lastError, 'the failure is recorded, not hidden');
});

test('req5.4 with no reading ever, it says Unavailable — never 0%', async (t) => {
  const clock = new AutoClock();
  const app = makeApp({ clock, provider: new StubProvider([failedMeasurement(clock, 'not_authenticated')]) });
  t.after(() => app.cleanup());

  const report = await app.usage.refresh();
  assert.equal(report.status, 'unavailable');
  assert.deepEqual(report.windows, [], 'no fabricated circles');
  assert.ok(report.explanation && report.explanation.length > 0, 'an expandable explanation exists');
  assert.ok(report.recovery && report.recovery.length > 0, 'a recovery action exists');

  // The killer invariant: unknown must never be presentable as zero usage.
  const serialized = JSON.stringify(report);
  assert.ok(!/"usedPercent":0\b/.test(serialized), 'unknown must not serialize as 0% used');
  assert.ok(!/"utilization":0\b/.test(serialized), 'unknown must not serialize as 0 utilization');

  const { usageViewModel } = await import('../../public/modules/usage.js');
  const vm = usageViewModel(report);
  assert.equal(vm.state, 'unavailable');
  assert.equal(vm.circles.length, 0, 'the UI draws no filled ring for unknown');
  assert.match(vm.headline, /unavailable/i);
  assert.ok(vm.recovery, 'the UI offers the recovery action');
});

test('req5.5 the reading survives a restart and is still marked with its true age', async (t) => {
  const clock = new AutoClock();
  const provider = new StubProvider([liveMeasurement(clock, [{ key: 'five_hour', usedPercent: 12 }])]);
  const app = makeApp({ clock, provider, appOptions: { staleAfterMs: 60_000 } });
  await app.usage.refresh();
  const dataDir = app.testDataDir;
  await app.close();

  clock.advance(30 * 60_000);
  const { createApp } = await import('../../src/app.js');
  const revived = createApp({ dataDir, clock, provider: new StubProvider([failedMeasurement(clock, 'network')]), staleAfterMs: 60_000 });
  t.after(async () => { await revived.close(); });

  const report = revived.usage.report();
  assert.equal(report.status, 'stale', 'a restart does not lose the reading, nor pretend it is fresh');
  assert.equal(Math.round(report.windows[0].usedPercent), 12);
  assert.equal(report.ageMs, 30 * 60_000);
});

test('req5.6 a worker-reported measurement flows into the same stored capacity', async (t) => {
  const clock = new AutoClock();
  const app = makeApp({ clock, provider: new StubProvider([failedMeasurement(clock, 'network')]) });
  t.after(() => app.cleanup());

  await app.usage.refresh();
  assert.equal(app.usage.report().status, 'unavailable');

  app.usage.ingestWorkerReport(liveMeasurement(clock, [{ key: 'seven_day', label: '7-day', usedPercent: 77 }]));

  const report = app.usage.report();
  assert.equal(report.status, 'live', 'the worker leg of the path works');
  assert.equal(Math.round(report.windows[0].usedPercent), 77);
  assert.equal(app.state('c1').capacity.windows[0].label, '7-day', 'and reaches the dashboard');
});

test('req5.7 capacity actually changes work concurrency and pacing', async (t) => {
  // Plenty of capacity: the pool should run wide and not pace.
  const roomy = new AutoClock();
  const appRoomy = makeApp({
    clock: roomy,
    provider: new StubProvider([liveMeasurement(roomy, [{ key: 'five_hour', usedPercent: 5 }])]),
    executor: createScriptedExecutor({ defaultDelayMs: 5 }),
  });
  t.after(() => appRoomy.cleanup());
  await appRoomy.usage.refresh();

  assert.equal(appRoomy.scheduler.concurrency(), 4, 'a healthy plan runs at full width');
  assert.equal(appRoomy.scheduler.paceDelayMs(), 0, 'and without artificial pacing');

  const wide = await appRoomy.orchestrator.submit({
    conversationId: 'c1', title: 'Wide build', goal: 'alpha, bravo, charlie, delta, echo and foxtrot',
  });
  await appRoomy.orchestrator.run(wide.id);
  const widePeak = appRoomy.pool.peakConcurrency;

  // Nearly exhausted: the same build must run narrower and slower.
  const tight = new AutoClock();
  const appTight = makeApp({
    clock: tight,
    provider: new StubProvider([liveMeasurement(tight, [{ key: 'five_hour', usedPercent: 97 }])]),
    executor: createScriptedExecutor({ defaultDelayMs: 5 }),
  });
  t.after(() => appTight.cleanup());
  await appTight.usage.refresh();

  assert.equal(appTight.scheduler.concurrency(), 1, 'a nearly exhausted plan runs one at a time');
  assert.ok(appTight.scheduler.paceDelayMs() >= 10_000, 'and paces hard');

  const narrow = await appTight.orchestrator.submit({
    conversationId: 'c1', title: 'Narrow build', goal: 'alpha, bravo, charlie, delta, echo and foxtrot',
  });
  await appTight.orchestrator.run(narrow.id);

  assert.ok(appTight.pool.peakConcurrency < widePeak,
    `low capacity must reduce real concurrency (tight ${appTight.pool.peakConcurrency} vs roomy ${widePeak})`);
  assert.equal(appTight.pool.peakConcurrency, 1);
  assert.ok(tight.slept.some((ms) => ms >= 10_000), 'the pacing delay was actually applied to real work');
});

test('req5.8 an unknown reading paces conservatively rather than assuming plenty', async (t) => {
  const clock = new AutoClock();
  const app = makeApp({ clock, provider: new StubProvider([failedMeasurement(clock, 'not_authenticated')]) });
  t.after(() => app.cleanup());
  await app.usage.refresh();

  const described = app.scheduler.describe();
  assert.equal(described.basis, 'unknown');
  assert.ok(described.concurrency <= 2, 'unknown capacity is treated cautiously');
  assert.ok(described.paceDelayMs > 0, 'and paced');
  assert.equal(described.worstRemainingPercent, null, 'unknown is reported as unknown, not as a number');
});

test('req5.9 the provider never falls back to a paid API key', async () => {
  const { ClaudeSubscriptionProvider } = await import('../../src/telemetry/providers/claude-cli.js');
  const clock = new AutoClock();
  let called = false;
  const provider = new ClaudeSubscriptionProvider({
    clock,
    fetchImpl: async () => { called = true; return new Response('{}', { status: 200 }); },
    tokenResolver: () => null,
    baseUrl: 'https://api.anthropic.com',
  });
  process.env.ANTHROPIC_API_KEY = 'sk-ant-test-should-never-be-used';
  try {
    const m = await provider.measure();
    assert.equal(m.ok, false);
    assert.equal(m.reason, 'not_authenticated');
    assert.equal(called, false, 'it did not call the API with a paid key');
    assert.match(m.remedy, /setup-token|CLAUDE_CODE_OAUTH_TOKEN/);
    assert.ok(!JSON.stringify(m).includes('sk-ant-test'), 'no credential material leaks into the result');
  } finally {
    delete process.env.ANTHROPIC_API_KEY;
  }
});
