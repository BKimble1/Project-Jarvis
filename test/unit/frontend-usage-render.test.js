import test from 'node:test';
import assert from 'node:assert/strict';

import {
  usageViewModel,
  ringGeometry,
  formatAge,
  RING_RADIUS,
} from '../../public/modules/usage.js';

/**
 * The dashboard's usage circles (acceptance req. 4 + 5) are driven entirely by
 * `usageViewModel`, a pure function over the server `Report`. Testing it here
 * pins the three honest states — live, stale, unavailable — and above all pins
 * the invariant that "unknown" can never be mistaken for "0% used".
 */

const TZ = 'America/Los_Angeles';

function liveReport(overrides = {}) {
  return {
    status: 'live',
    measuredAt: 1_700_000_000_000,
    ageMs: 12_000,
    timezone: TZ,
    windows: [
      {
        key: 'five_hour',
        label: '5-hour',
        utilization: 0.32,
        usedPercent: 32,
        remainingPercent: 68,
        resetsAt: 1_700_005_400_000,
        unit: 'percent',
        source: 'claude-subscription',
        measuredAt: 1_700_000_000_000,
        resetsAtLocal: 'Tue, Nov 14, 3:30 PM',
        freshness: 'live',
      },
      {
        key: 'seven_day_opus',
        label: '7-day (Opus)',
        utilization: 0.9,
        usedPercent: 90,
        remainingPercent: 10,
        resetsAt: 1_700_300_000_000,
        unit: 'percent',
        source: 'claude-subscription',
        measuredAt: 1_700_000_000_000,
        resetsAtLocal: 'Fri, Nov 17, 9:00 AM',
        freshness: 'live',
      },
    ],
    explanation: null,
    recovery: null,
    lastError: null,
    staleAfterMs: 900_000,
    ...overrides,
  };
}

function staleReport() {
  const base = liveReport();
  return {
    ...base,
    status: 'stale',
    ageMs: 42 * 60_000,
    windows: base.windows.map((w) => ({ ...w, freshness: 'stale' })),
    explanation: 'The last usage refresh failed (network); showing the reading from 2520s ago.',
    recovery: 'Retry the usage refresh.',
    lastError: { reason: 'network', message: 'boom', remedy: 'Retry the usage refresh.', at: 1 },
  };
}

function unavailableReport() {
  return {
    status: 'unavailable',
    measuredAt: null,
    ageMs: null,
    timezone: TZ,
    windows: [],
    explanation: 'No subscription OAuth token is available, so usage cannot be read.',
    recovery: 'Run `claude setup-token` so Jarvis can read your subscription limits, then retry.',
    lastError: { reason: 'not_authenticated', message: 'no token', remedy: 'Run `claude setup-token`.', at: 1 },
    staleAfterMs: 900_000,
  };
}

// ---------------------------------------------------------------------- live

test('live: one solid ring per reported window with real used, remaining and reset time', () => {
  const vm = usageViewModel(liveReport());

  assert.equal(vm.state, 'live');
  assert.equal(vm.circles.length, 2, 'one circle per window the server actually reported');
  assert.equal(vm.placeholder, null, 'a live reading has no unknown placeholder');

  const five = vm.circles.find((c) => c.key === 'five_hour');
  assert.equal(five.label, '5-hour');
  assert.equal(five.ringStyle, 'solid');
  assert.equal(five.usedPercent, 32);
  assert.equal(five.remainingPercent, 68);
  assert.equal(five.usedText, '32% used');
  assert.equal(five.remainingText, '68% left');
  assert.equal(five.percentText, '32%');
  assert.equal(five.resetLabel, 'Resets Tue, Nov 14, 3:30 PM', 'reset time in the operator timezone');
  assert.equal(five.freshness, 'live');
  assert.equal(five.note, null, 'nothing to caveat on a live reading');
  assert.equal(five.tone, 'ok');

  const seven = vm.circles.find((c) => c.key === 'seven_day_opus');
  assert.equal(seven.tone, 'critical', '90% used is flagged, not merely drawn');
  assert.match(seven.ariaLabel, /7-day \(Opus\) window, 90% used, 10% left/);
});

test('live: the freshness line states liveness, age and timezone', () => {
  const vm = usageViewModel(liveReport());
  assert.equal(vm.headline, 'Usage · live');
  assert.equal(vm.ageLabel, '12s');
  assert.match(vm.freshnessLine, /Live reading, measured 12s ago/);
  assert.match(vm.freshnessLine, /America\/Los_Angeles/);
  assert.equal(vm.stale, false);
});

test('ring geometry maps used percent onto the arc', () => {
  const circumference = 2 * Math.PI * RING_RADIUS;
  const empty = ringGeometry(0);
  const quarter = ringGeometry(25);
  const full = ringGeometry(100);

  assert.equal(empty.dashOffset, circumference, '0% leaves the whole ring unpainted');
  assert.ok(Math.abs(quarter.dashOffset - circumference * 0.75) < 1e-9);
  assert.equal(full.dashOffset, 0);
  assert.equal(usageViewModel(liveReport()).circles[0].geometry.dashArray, circumference);
});

// --------------------------------------------------------------------- stale

test('stale: same numbers, but visibly marked as last known with its age', () => {
  const vm = usageViewModel(staleReport());

  assert.equal(vm.state, 'stale');
  assert.equal(vm.stale, true);
  assert.equal(vm.ageLabel, '42m');
  assert.equal(vm.headline, 'Usage · last known, 42m ago');

  assert.equal(vm.circles.length, 2, 'the last known windows are still drawn');
  for (const circle of vm.circles) {
    assert.equal(circle.ringStyle, 'solid', 'a stale reading is a real reading, so the ring stays solid');
    assert.equal(circle.freshness, 'stale');
    assert.equal(circle.note, 'last known, 42m ago');
    assert.match(circle.ariaLabel, /last known, 42m ago/);
  }
  assert.equal(vm.circles[0].usedPercent, 32, 'the last known number is preserved verbatim');
  assert.match(vm.freshnessLine, /Last known reading, 42m old/);
  assert.ok(vm.explanation, 'a stale reading explains why it is not live');
  assert.equal(vm.recoveryAction.endpoint, '/api/capacity/refresh', 'and offers a refresh');
  assert.doesNotMatch(vm.headline, /live/i, 'stale is never presented as live');
});

// --------------------------------------------------------------- unavailable

test('unavailable: a dashed grey ring reading "Unavailable", with explanation and recovery', () => {
  const vm = usageViewModel(unavailableReport());

  assert.equal(vm.state, 'unavailable');
  assert.match(vm.headline, /unavailable/i);
  assert.equal(vm.circles.length, 0, 'no filled ring is drawn for an unknown reading');
  assert.equal(vm.placeholder.ringStyle, 'dashed');
  assert.equal(vm.placeholder.tone, 'grey');
  assert.equal(vm.placeholder.label, 'Unavailable');
  assert.equal(vm.placeholder.percentText, null, 'the placeholder carries no percentage at all');
  assert.equal(vm.explanationExpandable, true);
  assert.match(vm.explanation, /token/i);
  assert.match(vm.recovery, /setup-token/);
  assert.equal(vm.recoveryAction.label, 'Retry usage check');
  assert.equal(vm.recoveryAction.method, 'POST');
  assert.equal(vm.lastErrorReason, 'not_authenticated');
});

test('unavailable can never be confused with 0% used', () => {
  const unknown = usageViewModel(unavailableReport());

  // A genuine zero reading: same shape of report, a real measured 0.
  const zero = usageViewModel(liveReport({
    windows: [{
      key: 'five_hour',
      label: '5-hour',
      usedPercent: 0,
      remainingPercent: 100,
      resetsAt: 1_700_005_400_000,
      resetsAtLocal: 'Tue, Nov 14, 3:30 PM',
      freshness: 'live',
    }],
  }));

  // The zero reading is a real, solid, numbered ring.
  assert.equal(zero.state, 'live');
  assert.equal(zero.circles.length, 1);
  assert.equal(zero.circles[0].ringStyle, 'solid');
  assert.equal(zero.circles[0].percentText, '0%');
  assert.equal(zero.circles[0].usedText, '0% used');
  assert.equal(zero.circles[0].remainingText, '100% left');
  assert.equal(zero.placeholder, null);
  assert.doesNotMatch(zero.headline, /unavailable/i);

  // The unknown reading shares none of that.
  assert.notEqual(unknown.state, zero.state);
  assert.notEqual(unknown.circles.length, zero.circles.length);
  assert.notEqual(unknown.placeholder, null);
  assert.equal(unknown.placeholder.ringStyle, 'dashed');
  assert.notEqual(unknown.placeholder.ringStyle, zero.circles[0].ringStyle);

  // And it carries no number anywhere that a reader (or a screen reader) could
  // mistake for a measurement.
  const serialized = JSON.stringify(unknown);
  assert.ok(!/usedPercent/.test(serialized), 'the unknown view model has no usedPercent field');
  assert.ok(!/remainingPercent/.test(serialized), 'nor a remainingPercent field');
  assert.ok(!/\d+%/.test(serialized), `no percentage text at all, got: ${serialized}`);
  assert.ok(!/\b0\b/.test(unknown.placeholder.label + unknown.placeholder.detail), 'and never the digit 0 as a stand-in');
});

test('a malformed or empty "live" report degrades to unavailable, never to a 0% ring', () => {
  for (const windows of [[], null, [{ key: 'x', usedPercent: null }], [{ key: 'y', usedPercent: 'NaN' }]]) {
    const vm = usageViewModel(liveReport({ windows }));
    assert.equal(vm.state, 'unavailable', `windows=${JSON.stringify(windows)} must not become a ring`);
    assert.equal(vm.circles.length, 0);
    assert.ok(vm.explanation && vm.recovery, 'it still explains itself and offers a way out');
  }
});

test('a missing or nonsense report renders as unavailable rather than throwing', () => {
  for (const input of [null, undefined, {}, 'nope', 42, { status: 'weird' }]) {
    const vm = usageViewModel(input);
    assert.equal(vm.state, 'unavailable');
    assert.equal(vm.circles.length, 0);
    assert.match(vm.headline, /unavailable/i);
    assert.ok(vm.recovery.length > 0);
    assert.equal(vm.timezone, 'UTC', 'an unknown timezone falls back to UTC, not to undefined');
  }
});

test('a window with a partial reading still yields a truthful remaining figure', () => {
  const vm = usageViewModel(liveReport({
    windows: [{ key: 'five_hour', label: '5-hour', usedPercent: 41.4, resetsAtLocal: null, freshness: 'live' }],
  }));
  assert.equal(vm.circles.length, 1);
  assert.equal(vm.circles[0].usedPercent, 41.4, 'the precise reading is kept');
  assert.equal(vm.circles[0].percentText, '41%', 'the ring label is rounded for legibility');
  assert.equal(vm.circles[0].remainingPercent, 58.6, 'remaining is derived, not invented');
  assert.equal(vm.circles[0].resetLabel, null, 'no reset line when the provider did not report one');
});

// ----------------------------------------------------------------- age labels

test('formatAge is compact and honest across the units', () => {
  assert.equal(formatAge(0), '0s');
  assert.equal(formatAge(12_000), '12s');
  assert.equal(formatAge(42 * 60_000), '42m');
  assert.equal(formatAge(90 * 60_000), '1h 30m');
  assert.equal(formatAge(3 * 3_600_000), '3h');
  assert.equal(formatAge(50 * 3_600_000), '2d 2h');
  assert.equal(formatAge(-1), null, 'a negative age is not an age');
  assert.equal(formatAge(Number.NaN), null);
  assert.equal(formatAge(undefined), null);
});
