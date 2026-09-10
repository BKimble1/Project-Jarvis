import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Virtual clock whose sleeps resolve immediately but still move time forward,
 * so acceptance tests exercise real pacing/freshness logic in microseconds.
 */
export class AutoClock {
  constructor(startMs = 1_700_000_000_000, timezone = 'UTC') {
    this._now = startMs;
    this._tz = timezone;
    this.slept = [];
  }
  now() { return this._now; }
  timezone() { return this._tz; }
  async sleep(ms) {
    const d = Math.max(0, Number(ms) || 0);
    this.slept.push(d);
    this._now += d;
    await new Promise((r) => setImmediate(r));
  }
  advance(ms) { this._now += ms; }
  setTime(ms) { this._now = ms; }
}

/** Provider stub: scripted measurements, no network. */
export class StubProvider {
  constructor(measurements = []) {
    this.name = 'stub';
    this.queue = [...measurements];
    this.calls = 0;
    this.last = null;
  }
  push(m) { this.queue.push(m); }
  async measure() {
    this.calls += 1;
    const next = this.queue.length > 1 ? this.queue.shift() : (this.queue[0] ?? this.last);
    this.last = next ?? { ok: false, source: 'stub', measuredAt: 0, reason: 'unsupported', message: 'no measurement scripted', remedy: 'script one' };
    return this.last;
  }
}

export function liveMeasurement(clock, windows = [{ key: 'five_hour', usedPercent: 20 }]) {
  const measuredAt = clock.now();
  return {
    ok: true,
    source: 'stub',
    measuredAt,
    windows: windows.map((w) => ({
      key: w.key,
      label: w.label ?? w.key,
      utilization: (w.usedPercent ?? 0) / 100,
      usedPercent: w.usedPercent ?? 0,
      remainingPercent: 100 - (w.usedPercent ?? 0),
      resetsAt: w.resetsAt ?? measuredAt + 3_600_000,
      unit: 'percent',
      source: 'stub',
      measuredAt,
    })),
  };
}

export function failedMeasurement(clock, reason = 'network') {
  return {
    ok: false, source: 'stub', measuredAt: clock.now(), reason,
    message: `stubbed ${reason} failure`, remedy: 'retry later',
  };
}

/**
 * Executor that behaves like real work: deterministic success, plus a script
 * for failures, questions and slow tasks keyed by task title.
 */
export function createScriptedExecutor({ script = {}, onTask = null, defaultDelayMs = 0 } = {}) {
  const attempts = new Map();
  return async function execute(task, ctx) {
    const n = (attempts.get(task.id) ?? 0) + 1;
    attempts.set(task.id, n);
    onTask?.(task, ctx, n);

    const steps = script[task.title] ?? script[task.kind] ?? null;
    const step = Array.isArray(steps) ? (steps[n - 1] ?? steps.at(-1)) : steps;

    if (step?.delayMs) await ctx?.clock?.sleep?.(step.delayMs);
    if (step?.throw) {
      const err = new Error(step.throw.message ?? step.throw);
      if (step.throw.code) err.code = step.throw.code;
      if (step.throw.status) err.status = step.throw.status;
      throw err;
    }
    if (step?.needsAnswer) return { needsAnswer: step.needsAnswer };
    if (step?.ok === false) return { ok: false, reason: step.reason ?? 'check failed' };

    if (defaultDelayMs) await ctx?.clock?.sleep?.(defaultDelayMs);
    return { taskId: task.id, title: task.title, kind: task.kind, output: `${task.kind} complete: ${task.title}`, attempt: n };
  };
}

export function silentLogger() {
  const noop = () => {};
  const l = { debug: noop, info: noop, warn: noop, error: noop };
  l.child = () => l;
  return l;
}

/** Record every bus event for assertions. */
export function recordEvents(bus, types = null) {
  const seen = [];
  bus.on('*', (evt) => {
    if (!types || types.includes(evt.type)) seen.push(evt);
  });
  return {
    all: () => seen,
    ofType: (t) => seen.filter((e) => e.type === t),
    count: (t) => seen.filter((e) => e.type === t).length,
    types: () => seen.map((e) => e.type),
  };
}

export async function settle(times = 5) {
  for (let i = 0; i < times; i++) await new Promise((r) => setImmediate(r));
}
