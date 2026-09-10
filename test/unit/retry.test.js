import test from 'node:test';
import assert from 'node:assert/strict';

import { FakeClock } from '../../src/core/clock.js';
import { classifyError, defaultIsRetryable, delayFor, withRetry, RetryBudget } from '../../src/orchestrator/retry.js';

/** Wraps a FakeClock and records every delay `withRetry` sleeps for. */
function recordingClock(clock) {
  return {
    delays: [],
    now: () => clock.now(),
    timezone: () => clock.timezone(),
    sleep(ms) { this.delays.push(ms); return clock.sleep(ms); },
  };
}

/** Drive virtual time until `promise` settles; never waits on real time. */
async function settle(clock, promise) {
  const state = { done: false, ok: false, value: undefined, error: undefined };
  const tracked = promise.then(
    (v) => { state.done = true; state.ok = true; state.value = v; },
    (e) => { state.done = true; state.ok = false; state.error = e; },
  );
  for (let i = 0; i < 50 && !state.done; i += 1) await clock.advance(60_000);
  if (!state.done) throw new Error('promise did not settle within the virtual time budget');
  await tracked;
  if (!state.ok) throw state.error;
  return state.value;
}

function err(props) { return Object.assign(new Error(props.message ?? 'boom'), props); }

test('classifyError: transient network failures', () => {
  assert.equal(classifyError(err({ code: 'ECONNRESET' })), 'transient');
  assert.equal(classifyError(err({ code: 'ETIMEDOUT' })), 'transient');
  assert.equal(classifyError(err({ code: 'EAI_AGAIN' })), 'transient');
  assert.equal(classifyError(err({ status: 502 })), 'transient');
  assert.equal(classifyError(err({ status: 503 })), 'transient');
  assert.equal(classifyError(err({ status: 504 })), 'transient');
  assert.equal(classifyError(err({ message: 'socket hang up' })), 'transient');
  assert.equal(classifyError(err({ message: 'Request timeout after 30s' })), 'transient');
});

test('classifyError: capacity pressure', () => {
  assert.equal(classifyError(err({ status: 429 })), 'capacity');
  assert.equal(classifyError(err({ message: 'Rate limit exceeded' })), 'capacity');
  assert.equal(classifyError(err({ message: 'model is overloaded' })), 'capacity');
  assert.equal(classifyError(err({ message: 'out of capacity for now' })), 'capacity');
});

test('classifyError: permission, credential, fatal', () => {
  assert.equal(classifyError(err({ status: 401 })), 'permission');
  assert.equal(classifyError(err({ status: 403 })), 'permission');
  assert.equal(classifyError(err({ message: 'Unauthorized' })), 'permission');
  assert.equal(classifyError(err({ message: 'forbidden: scope missing' })), 'permission');
  assert.equal(classifyError(err({ message: 'permission denied writing file' })), 'permission');

  assert.equal(classifyError(err({ message: 'no credential found' })), 'credential');
  assert.equal(classifyError(err({ message: 'not authenticated' })), 'credential');
  assert.equal(classifyError(err({ message: 'missing api key' })), 'credential');
  assert.equal(classifyError(err({ message: 'token expired' })), 'credential');

  assert.equal(classifyError(err({ message: 'cannot read properties of undefined' })), 'fatal');
  assert.equal(classifyError(new TypeError('x is not a function')), 'fatal');
  assert.equal(classifyError(null), 'fatal');
  assert.equal(classifyError(undefined), 'fatal');
});

test('classifyError: unwraps a wrapped cause', () => {
  const wrapped = new Error('fetch failed', { cause: err({ code: 'ECONNRESET' }) });
  assert.equal(classifyError(wrapped), 'transient');
  const wrappedFatal = new Error('fetch failed', { cause: new Error('bad json') });
  assert.equal(classifyError(wrappedFatal), 'fatal');
});

test('defaultIsRetryable only allows transient and capacity', () => {
  assert.equal(defaultIsRetryable(err({ code: 'ECONNRESET' })), true);
  assert.equal(defaultIsRetryable(err({ status: 429 })), true);
  assert.equal(defaultIsRetryable(err({ status: 401 })), false);
  assert.equal(defaultIsRetryable(err({ message: 'api key missing' })), false);
  assert.equal(defaultIsRetryable(new Error('nope')), false);
});

test('withRetry returns immediately on success and never sleeps', async () => {
  const clock = recordingClock(new FakeClock(1000));
  let calls = 0;
  const value = await withRetry(async () => { calls += 1; return 'ok'; }, { clock });
  assert.equal(value, 'ok');
  assert.equal(calls, 1);
  assert.deepEqual(clock.delays, []);
});

test('withRetry sleeps 200, 400, 800 through the clock before succeeding', async () => {
  const fake = new FakeClock(0);
  const clock = recordingClock(fake);
  const attemptsSeen = [];
  const promise = withRetry(async (attempt) => {
    attemptsSeen.push(attempt);
    if (attempt < 4) throw err({ code: 'ECONNRESET' });
    return `ok@${attempt}`;
  }, { clock, attempts: 4, baseDelayMs: 200, factor: 2 });

  const value = await settle(fake, promise);
  assert.equal(value, 'ok@4');
  assert.deepEqual(attemptsSeen, [1, 2, 3, 4]);
  assert.deepEqual(clock.delays, [200, 400, 800]);
});

test('withRetry throws a permission error immediately after exactly one attempt', async () => {
  const fake = new FakeClock(0);
  const clock = recordingClock(fake);
  let calls = 0;
  const boom = err({ status: 403, message: 'forbidden' });

  await assert.rejects(
    withRetry(async () => { calls += 1; throw boom; }, { clock, attempts: 5, baseDelayMs: 200 }),
    (e) => e === boom,
  );

  assert.equal(calls, 1);
  assert.deepEqual(clock.delays, []);
  assert.equal(fake.now(), 0, 'no virtual time may pass for a non-retryable error');
});

test('withRetry never retries credential or fatal errors', async () => {
  for (const thrown of [err({ message: 'token expired' }), new TypeError('bad')]) {
    const fake = new FakeClock(0);
    const clock = recordingClock(fake);
    let calls = 0;
    await assert.rejects(
      withRetry(async () => { calls += 1; throw thrown; }, { clock, attempts: 4 }),
      (e) => e === thrown,
    );
    assert.equal(calls, 1);
    assert.deepEqual(clock.delays, []);
  }
});

test('withRetry exhausts the bounded attempts and rethrows the last error', async () => {
  const fake = new FakeClock(0);
  const clock = recordingClock(fake);
  let calls = 0;
  const promise = withRetry(async (attempt) => {
    calls += 1;
    throw err({ status: 503, message: `unavailable ${attempt}` });
  }, { clock, attempts: 3, baseDelayMs: 200, factor: 2 });

  await assert.rejects(settle(fake, promise), (e) => e.message === 'unavailable 3');
  assert.equal(calls, 3, 'bounded at exactly `attempts` calls');
  assert.deepEqual(clock.delays, [200, 400], 'one sleep fewer than attempts');
});

test('withRetry retries capacity errors and reports each retry to onRetry', async () => {
  const fake = new FakeClock(0);
  const clock = recordingClock(fake);
  const seen = [];
  const promise = withRetry(async (attempt) => {
    if (attempt === 1) throw err({ status: 429, message: 'rate limit' });
    return 'through';
  }, {
    clock,
    attempts: 3,
    baseDelayMs: 250,
    onRetry: (info) => seen.push({ attempt: info.attempt, delayMs: info.delayMs, classification: info.classification }),
  });

  assert.equal(await settle(fake, promise), 'through');
  assert.deepEqual(seen, [{ attempt: 1, delayMs: 250, classification: 'capacity' }]);
});

test('withRetry honours a custom isRetryable and custom backoff shape', async () => {
  const fake = new FakeClock(0);
  const clock = recordingClock(fake);
  let calls = 0;
  const promise = withRetry(async () => {
    calls += 1;
    if (calls < 3) throw new Error('policy violation');
    return calls;
  }, { clock, attempts: 3, baseDelayMs: 100, factor: 3, isRetryable: (e) => e.message === 'policy violation' });

  assert.equal(await settle(fake, promise), 3);
  assert.deepEqual(clock.delays, [100, 300]);
});

test('withRetry rejects bad wiring instead of silently using real timers', async () => {
  let calls = 0;
  await assert.rejects(
    () => withRetry(async () => { calls += 1; return 1; }, {}),
    (e) => e instanceof TypeError && /clock with sleep/.test(e.message),
  );
  assert.equal(calls, 0, 'fn must not run at all when there is no clock to wait on');

  await assert.rejects(
    () => withRetry(async () => 1, { clock: { now: () => 0 } }),
    (e) => e instanceof TypeError && /clock with sleep/.test(e.message),
    'a clock without sleep() is still bad wiring',
  );
  await assert.rejects(
    () => withRetry('not a function', { clock: new FakeClock(0) }),
    (e) => e instanceof TypeError && /fn must be a function/.test(e.message),
  );
});

test('delayFor: exponential, jittered and capped', () => {
  assert.equal(delayFor(1, { baseDelayMs: 200, factor: 2 }), 200);
  assert.equal(delayFor(2, { baseDelayMs: 200, factor: 2 }), 400);
  assert.equal(delayFor(3, { baseDelayMs: 200, factor: 2 }), 800);
  assert.equal(delayFor(4, { baseDelayMs: 200, factor: 2, maxDelayMs: 1000 }), 1000);
  assert.equal(delayFor(1, { baseDelayMs: 200, jitter: 100, random: () => 0.5 }), 250);
  assert.equal(delayFor(1, { baseDelayMs: 200, jitter: 100, random: () => 0 }), 200);
});

test('RetryBudget is per-key and bounded', () => {
  const budget = new RetryBudget({ maxAttempts: 3 });
  assert.equal(budget.attemptsFor('task_a'), 0);
  assert.equal(budget.consume('task_a'), true);
  assert.equal(budget.consume('task_a'), true);
  assert.equal(budget.consume('task_a'), true);
  assert.equal(budget.consume('task_a'), false, 'exhausted after maxAttempts');
  assert.equal(budget.consume('task_a'), false, 'stays exhausted');
  assert.equal(budget.attemptsFor('task_a'), 3, 'refused attempts are not counted');
  assert.equal(budget.exhausted('task_a'), true);
  assert.equal(budget.remaining('task_a'), 0);

  assert.equal(budget.consume('task_b'), true, 'other keys are unaffected');
  assert.equal(budget.remaining('task_b'), 2);

  budget.reset('task_a');
  assert.equal(budget.attemptsFor('task_a'), 0);
  assert.equal(budget.consume('task_a'), true);

  budget.reset();
  assert.deepEqual(budget.keys(), []);
});

test('RetryBudget with maxAttempts 0 grants nothing', () => {
  const budget = new RetryBudget({ maxAttempts: 0 });
  assert.equal(budget.consume('x'), false);
  assert.equal(budget.attemptsFor('x'), 0);
});

// --- Added by audit -------------------------------------------------------
// The hardest requirement in this module is the retry gate itself: only
// `transient` and `capacity` may ever be tried again, and each retry must
// really wait out its backoff on the injected clock. Both halves fail quietly
// if classification lets prose outrank a structured signal.

test('a structured status outranks message prose, so non-retryable errors are never retried', async () => {
  // A 403 body that happens to mention a timeout is still a permission failure.
  // Classifying it `transient` would retry it and rob the orchestrator of the
  // chance to block the project with a truthful reason (contract B.5).
  const cases = [
    ['permission', err({ status: 403, message: 'Forbidden: the upstream auth check timed out' })],
    ['permission', err({ status: 401, message: 'timeout while validating the session token' })],
    ['capacity', err({ status: 429, message: 'socket hang up after the rate limit slot expired' })],
    // In-repo producers tag the class on `code` on purpose; that tag must beat
    // whatever wording the underlying CLI happened to print.
    ['credential', err({ code: 'ECREDENTIAL', message: 'Unauthorized. Run `claude setup-token`.' })],
    ['fatal', err({ code: 'EFATAL', message: 'the verify step failed: request timeout' })],
  ];

  for (const [expected, thrown] of cases) {
    assert.equal(classifyError(thrown), expected, `misclassified: ${thrown.message}`);
    assert.equal(defaultIsRetryable(thrown), false, `must not be retryable: ${thrown.message}`);

    const fake = new FakeClock(0);
    const clock = recordingClock(fake);
    let calls = 0;
    await assert.rejects(
      withRetry(async () => { calls += 1; throw thrown; }, { clock, attempts: 5, baseDelayMs: 200 }),
      (e) => e === thrown,
    );
    assert.equal(calls, 1, `exactly one attempt for: ${thrown.message}`);
    assert.deepEqual(clock.delays, [], `no sleep for: ${thrown.message}`);
    assert.equal(fake.now(), 0, `no virtual time may pass for: ${thrown.message}`);
  }
});

test('withRetry applies the contract default backoff to the clock, not just to a counter', async () => {
  const fake = new FakeClock(0);
  const clock = recordingClock(fake);
  const attemptAt = [];
  const boom = err({ status: 429, message: 'Request timed out waiting for a rate limit slot' });

  // No attempts / baseDelayMs / factor: this pins the contract defaults 3 / 200 / 2.
  const promise = withRetry(async () => { attemptAt.push(fake.now()); throw boom; }, { clock });

  await assert.rejects(settle(fake, promise), (e) => e === boom);
  assert.equal(attemptAt.length, 3, 'the default attempts budget is exactly 3');
  assert.deepEqual(clock.delays, [200, 400], 'defaults are baseDelayMs 200, factor 2');
  assert.deepEqual(attemptAt, [0, 200, 600],
    'each retry must resume only after its delay has actually elapsed on the clock');
});

test('classifyError takes exactly one argument, so it is safe as a callback', () => {
  const wrapped = () => new Error('fetch failed', { cause: new Error('upstream', { cause: err({ status: 429 }) }) });
  const errors = [wrapped(), wrapped(), wrapped()];
  assert.equal(classifyError.length, 1, 'the recursion depth must stay private');
  assert.deepEqual(errors.map((e) => classifyError(e)), ['capacity', 'capacity', 'capacity']);
  assert.deepEqual(errors.map(classifyError), ['capacity', 'capacity', 'capacity'],
    'the array index must not leak in as recursion depth');
});

test('classifyError follows a bounded cause chain and survives a cycle', () => {
  const leaf = err({ code: 'ECONNRESET' });
  const wrap = (n) => { let e = leaf; for (let i = 0; i < n; i += 1) e = new Error(`wrapper ${i}`, { cause: e }); return e; };
  assert.equal(classifyError(wrap(1)), 'transient');
  assert.equal(classifyError(wrap(3)), 'transient', 'three links deep is still reachable');
  assert.equal(classifyError(wrap(4)), 'fatal', 'a fourth link is out of reach, not an unbounded walk');

  const cyclic = new Error('loops back on itself');
  cyclic.cause = cyclic;
  assert.equal(classifyError(cyclic), 'fatal', 'a cause cycle terminates instead of hanging');
});
