import { describe, expect, it } from 'vitest';

import {
  AUTH_MODES,
  RATE_WINDOWS,
  STALE_AFTER_MINUTES,
  age,
  assessContext,
  decideCapacity,
  hasSubscriptionWindows,
  measured,
  mergeAccountLimits,
  routeModel,
  unknown,
  unknownContext,
  unknownWindow,
  type AuthMode,
  type CapacityObservation,
  type RateWindow,
  type WindowObservation,
} from '@/domain/claude-capacity';

/**
 * How much Claude is left, and how sure Jarvis is.
 *
 * Every test here is about a wrong number presented confidently. Three workers reporting 42% must
 * not become 126%. An API key must not be throttled against a five-hour window it does not have.
 * A field the interface did not send must not become zero, and must not become "plenty" either.
 */

const NOW = new Date('2026-06-15T12:00:00.000Z');
const EARLIER = new Date('2026-06-15T11:58:00.000Z');
const LONG_AGO = new Date('2026-06-15T10:00:00.000Z');

function window(percent: number | null, at: Date = NOW): WindowObservation {
  return percent === null
    ? unknownWindow()
    : {
        utilisationPercent: measured(percent, 'statusline', at),
        resetsAt: measured('2026-06-15T15:00:00.000Z', 'statusline', at),
      };
}

function observation(overrides: Partial<CapacityObservation> = {}): CapacityObservation {
  return {
    workerId: 'worker-1',
    authMode: 'subscription',
    subscriptionType: measured('max', 'statusline', NOW),
    windows: { fiveHour: window(42), sevenDay: window(20), sevenDayOpus: window(10) },
    context: unknownContext(),
    observedAt: NOW.toISOString(),
    source: 'statusline',
    ...overrides,
  };
}

const RESERVE = { fiveHourPercent: 25, sevenDayPercent: 20 };
const MODELS = { strong: 'strong-model', balanced: 'balanced-model', fast: 'fast-model' };

describe('provenance', () => {
  it('starts unknown rather than at zero', () => {
    const value = unknown<number>();
    expect(value.value).toBeNull();
    expect(value.quality).toBe('unknown');
  });

  it('goes stale rather than unknown, so the last known figure survives', () => {
    const fresh = age(measured(42, 'statusline', EARLIER), NOW);
    expect(fresh.quality).toBe('measured');

    const old = age(measured(42, 'statusline', LONG_AGO), NOW);
    expect(old.quality).toBe('stale');
    expect(old.value).toBe(42);
    expect(STALE_AFTER_MINUTES).toBeGreaterThan(0);
  });

  it('leaves an unknown value alone however long it sits there', () => {
    expect(age(unknown<number>(), NOW).quality).toBe('unknown');
  });
});

describe('merging what several workers saw', () => {
  /*
   * The mistake this exists to prevent. Rate limits belong to the account, so three workers each
   * reporting 42% means the account is at 42% — and summing, which is what you do with almost
   * every other per-worker figure, would produce 126%: a number that cannot exist, stated with
   * total confidence.
   */
  it('never adds one worker’s utilisation to another’s', () => {
    const merged = mergeAccountLimits(
      [
        observation({ workerId: 'a', windows: { fiveHour: window(42), sevenDay: window(20), sevenDayOpus: window(10) } }),
        observation({ workerId: 'b', windows: { fiveHour: window(42), sevenDay: window(20), sevenDayOpus: window(10) } }),
        observation({ workerId: 'c', windows: { fiveHour: window(42), sevenDay: window(20), sevenDayOpus: window(10) } }),
      ],
      NOW,
    );
    expect(merged.windows.fiveHour.utilisationPercent.value).toBe(42);
    expect(merged.workerIds).toEqual(['a', 'b', 'c']);
  });

  it('takes the newest observation, not the highest or the first', () => {
    const merged = mergeAccountLimits(
      [
        observation({
          workerId: 'stale-but-alarming',
          observedAt: LONG_AGO.toISOString(),
          windows: { fiveHour: window(95, LONG_AGO), sevenDay: window(20, LONG_AGO), sevenDayOpus: window(10, LONG_AGO) },
        }),
        observation({
          workerId: 'current',
          observedAt: NOW.toISOString(),
          windows: { fiveHour: window(12), sevenDay: window(20), sevenDayOpus: window(10) },
        }),
      ],
      NOW,
    );
    expect(merged.windows.fiveHour.utilisationPercent.value).toBe(12);
  });

  it('falls back to an older worker only when the newest could not read the field', () => {
    const merged = mergeAccountLimits(
      [
        observation({
          workerId: 'current',
          observedAt: NOW.toISOString(),
          windows: { fiveHour: unknownWindow(), sevenDay: window(20), sevenDayOpus: window(10) },
        }),
        observation({
          workerId: 'earlier',
          observedAt: EARLIER.toISOString(),
          windows: { fiveHour: window(33, EARLIER), sevenDay: window(20, EARLIER), sevenDayOpus: window(10, EARLIER) },
        }),
      ],
      NOW,
    );
    expect(merged.windows.fiveHour.utilisationPercent.value).toBe(33);
  });

  /*
   * An API worker has no five-hour window. Lending it a subscription worker's figure would invent
   * a constraint, and inventing constraints is how an operator sits idle against a limit that does
   * not exist.
   */
  it('reports no window at all for an auth mode that has none', () => {
    for (const mode of AUTH_MODES.filter((entry) => entry !== 'subscription')) {
      const merged = mergeAccountLimits([observation({ authMode: mode as AuthMode })], NOW);
      for (const rateWindow of RATE_WINDOWS) {
        expect(merged.windows[rateWindow].utilisationPercent.value, mode).toBeNull();
        expect(merged.windows[rateWindow].utilisationPercent.quality, mode).toBe('unknown');
      }
    }
  });

  it('says a mode has subscription windows only when it is a subscription', () => {
    expect(hasSubscriptionWindows('subscription')).toBe(true);
    for (const mode of AUTH_MODES.filter((entry) => entry !== 'subscription')) {
      expect(hasSubscriptionWindows(mode as AuthMode), mode).toBe(false);
    }
  });

  it('reports unknown from no observations at all rather than inventing an account', () => {
    const merged = mergeAccountLimits([], NOW);
    expect(merged.authMode).toBe('unknown');
    expect(merged.windows.fiveHour.utilisationPercent.value).toBeNull();
  });
});

describe('whether there is room', () => {
  const subscription = (windows: Partial<Record<RateWindow, WindowObservation>>) =>
    mergeAccountLimits(
      [
        observation({
          windows: {
            fiveHour: window(10),
            sevenDay: window(10),
            sevenDayOpus: window(10),
            ...windows,
          },
        }),
      ],
      NOW,
    );

  it('is clear with room in every window', () => {
    const decision = decideCapacity(subscription({}), RESERVE);
    expect(decision.verdict).toBe('clear');
    expect(decision.mayStartNewWork).toBe(true);
  });

  it('holds once a window is inside the reserve the owner asked for', () => {
    const decision = decideCapacity(subscription({ fiveHour: window(80) }), RESERVE);
    expect(decision.verdict).toBe('reserved');
    expect(decision.mayStartNewWork).toBe(false);
    expect(decision.reason).toContain('finish what is running');
  });

  it('stops entirely once a window is used up', () => {
    const decision = decideCapacity(subscription({ fiveHour: window(100) }), RESERVE);
    expect(decision.verdict).toBe('exhausted');
    expect(decision.mayStartNewWork).toBe(false);
  });

  /*
   * Unknown holds rather than proceeding or stopping. Proceeding is how an operator gets
   * rate-limited halfway through a mission it cannot resume; stopping is how a missing telemetry
   * field switches Jarvis off for a day. Holding is wrong in the recoverable direction.
   */
  it('holds when it cannot read a window, and says that is what it is doing', () => {
    const decision = decideCapacity(subscription({ sevenDayOpus: unknownWindow() }), RESERVE);
    expect(decision.verdict).toBe('unknown');
    expect(decision.mayStartNewWork).toBe(false);
    expect(decision.quality).toBe('unknown');
    expect(decision.reason).toMatch(/cannot read/);
  });

  it('does not apply a subscription reserve to a worker that has no subscription', () => {
    const apiKey = mergeAccountLimits([observation({ authMode: 'api_key' })], NOW);
    const decision = decideCapacity(apiKey, RESERVE);
    expect(decision.verdict).toBe('clear');
    expect(decision.mayStartNewWork).toBe(true);
    expect(decision.reason).toMatch(/Spending limits still apply/);
  });

  it('says so plainly when it has not established how a worker authenticates', () => {
    const decision = decideCapacity(mergeAccountLimits([], NOW), RESERVE);
    expect(decision.quality).toBe('unknown');
    expect(decision.reason).toMatch(/has not established/);
  });
});

describe('context health', () => {
  const context = (percent: number | null, over = false) => ({
    usedTokens: unknown<number>(),
    maxTokens: unknown<number>(),
    percentUsed: percent === null ? unknown<number>() : measured(percent, 'sdk', NOW),
    overLimit: measured(over, 'sdk', NOW),
  });

  it('is healthy with room to spare and does not checkpoint for nothing', () => {
    const health = assessContext(context(30), NOW);
    expect(health.state).toBe('healthy');
    expect(health.shouldCheckpoint).toBe(false);
  });

  it('checkpoints well before the wall rather than at it', () => {
    expect(assessContext(context(76), NOW).shouldCheckpoint).toBe(true);
    expect(assessContext(context(76), NOW).state).toBe('filling');
    expect(assessContext(context(95), NOW).state).toBe('critical');
  });

  it('knows the difference between nearly full and already over', () => {
    const over = assessContext(context(99, true), NOW);
    expect(over.state).toBe('over');
    expect(over.reason).toMatch(/being dropped/);
  });

  /* A checkpoint costs a commit; not checkpointing costs the work. */
  it('checkpoints when it cannot read the gauge at all', () => {
    const health = assessContext(context(null), NOW);
    expect(health.state).toBe('unknown');
    expect(health.shouldCheckpoint).toBe(true);
  });
});

describe('model routing', () => {
  it('never sends mechanical work to the strongest model, however much room there is', () => {
    for (const capacity of ['clear', 'reserved', 'unknown', 'exhausted'] as const) {
      const choice = routeModel({ weight: 'mechanical', capacity, models: MODELS });
      expect(choice.model, capacity).toBe(MODELS.fast);
    }
  });

  it('uses the strongest model for work that has to be right', () => {
    expect(routeModel({ weight: 'demanding', capacity: 'clear', models: MODELS }).model).toBe(
      MODELS.strong,
    );
  });

  /* A slightly weaker review is worth more than no review. */
  it('steps down one rung under pressure rather than stopping', () => {
    const choice = routeModel({ weight: 'demanding', capacity: 'reserved', models: MODELS });
    expect(choice.model).toBe(MODELS.balanced);
    expect(choice.reason).toMatch(/rather than stopping/);
  });

  it('takes its model names from configuration rather than knowing any', () => {
    const other = { strong: 'x', balanced: 'y', fast: 'z' };
    expect(routeModel({ weight: 'demanding', capacity: 'clear', models: other }).model).toBe('x');
  });
});
