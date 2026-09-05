import { describe, expect, it } from 'vitest';

import {
  ceilingBreach,
  estimateOutputTokens,
  monotonicNow,
  outputTokensSoFar,
  type RunCeilings,
  type RunConsumption,
} from '@/domain/run-budget';

/**
 * The ceilings that bound a session while it is still running.
 *
 * The defect these exist for: every ceiling was defined, most were stored on the row, and almost
 * none reached a running agent. `MissionOrchestrator.canStart` had no callers, so the mission
 * runtime and token rules never executed. `taskExceedsLimits` ran only from `orchestrator.tick`,
 * which nothing calls on a timer. And `TaskAssignment.timeLimitMs` and `.maxOutputTokens` were
 * assembled, serialised and shipped to the worker, where no line of code read either. A task ran
 * until the model decided it was finished.
 */

function ceilings(overrides: Partial<RunCeilings> = {}): RunCeilings {
  return { timeLimitMs: 60_000, maxOutputTokens: 10_000, maxTurns: 50, ...overrides };
}

function consumption(overrides: Partial<RunConsumption> = {}): RunConsumption {
  return {
    elapsedMs: 0,
    emittedCharacters: 0,
    reportedOutputTokens: null,
    turns: 0,
    ...overrides,
  };
}

describe('whether a session has passed a ceiling', () => {
  it('leaves a session inside every ceiling alone', () => {
    expect(ceilingBreach(ceilings(), consumption({ elapsedMs: 30_000, turns: 10 }))).toBeNull();
  });

  it('stops a session that has run too long', () => {
    const breach = ceilingBreach(ceilings(), consumption({ elapsedMs: 60_001 }));
    expect(breach?.limit).toBe('time');
    expect(breach?.reason).toMatch(/1-minute limit/);
    /* Elapsed time is a fact, never an estimate. */
    expect(breach?.basis).toBe('reported');
  });

  it('stops a session that has produced too much, before a real count exists', () => {
    /*
     * The reason estimation is necessary at all: the SDK reports usage once, in its final result
     * message, after the session has already ended. A token ceiling that waited for that could
     * only ever fire post-mortem.
     */
    const breach = ceilingBreach(
      ceilings({ maxOutputTokens: 1_000 }),
      consumption({ emittedCharacters: 3_000 }),
    );
    expect(breach?.limit).toBe('outputTokens');
    expect(breach?.basis).toBe('estimated');
    /* And it says "about", because it is estimating and must not sound like a measurement. */
    expect(breach?.reason).toMatch(/about/);
  });

  it('prefers the provider’s own figure the moment it arrives', () => {
    const state = outputTokensSoFar(
      consumption({ emittedCharacters: 300_000, reportedOutputTokens: 12 }),
    );
    /* Replaced outright, not averaged: a measurement and a guess are not two opinions. */
    expect(state).toEqual({ outputTokens: 12, basis: 'reported' });

    const breach = ceilingBreach(
      ceilings({ maxOutputTokens: 1_000 }),
      consumption({ emittedCharacters: 300_000, reportedOutputTokens: 12 }),
    );
    expect(breach).toBeNull();
  });

  it('estimates on the high side, so the ceiling bites early rather than late', () => {
    /*
     * Three characters per token is below both English prose and code, which makes the estimate an
     * over-count. Over-counting stops a runaway slightly early; under-counting lets it run long,
     * and a ceiling that errs generously is a ceiling that does not hold.
     */
    expect(estimateOutputTokens(300)).toBe(100);
    expect(estimateOutputTokens(0)).toBe(0);
    expect(estimateOutputTokens(-5)).toBe(0);
  });

  it('treats an absent ceiling as no ceiling, not as zero', () => {
    const none = ceilings({ timeLimitMs: null, maxOutputTokens: null, maxTurns: null });
    expect(
      ceilingBreach(
        none,
        consumption({ elapsedMs: 86_400_000, emittedCharacters: 1e9, turns: 1e6 }),
      ),
    ).toBeNull();
  });

  it('reports the most certain breach first', () => {
    /*
     * Time, then output, then turns — by how sure the measurement is. Elapsed time is a fact, an
     * output figure may be an estimate, and a turn count is only as good as the events the runtime
     * chose to emit.
     */
    const breach = ceilingBreach(
      ceilings({ timeLimitMs: 1, maxOutputTokens: 1, maxTurns: 1 }),
      consumption({ elapsedMs: 10, emittedCharacters: 10, turns: 10 }),
    );
    expect(breach?.limit).toBe('time');
  });

  it('measures elapsed time from a clock that cannot go backwards', () => {
    /*
     * `Date.now()` can move backwards — an NTP correction, a suspended laptop, a container
     * migration — and a limit computed from two wall-clock readings can therefore fire immediately
     * or never.
     */
    const first = monotonicNow();
    const second = monotonicNow();
    expect(second).toBeGreaterThanOrEqual(first);
  });
});
