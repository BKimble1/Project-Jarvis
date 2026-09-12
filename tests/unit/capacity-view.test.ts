import { describe, expect, it } from 'vitest';

import { measured, unknownContext, unknownWindow } from '@/domain/claude-capacity';
import type { CapacityObservation, RateWindow } from '@/domain/claude-capacity';
import { buildCapacityView } from '@/server/operator/capacity-view';
import type { Services } from '@/server/container';

/**
 * What the operations page and the wallboard are told about Claude capacity.
 *
 * The rule these hold to is the one the view exists for: a percentage never appears without how it
 * was known *and* how old it is. "Last known" on its own is the half of the sentence that does not
 * help — a reading taken four minutes ago and one taken four hours ago render identically, and only
 * one of them is a basis for starting a mission.
 */

const NOW = new Date('2026-03-01T12:00:00.000Z');

function reporting(
  windows: Partial<Record<RateWindow, number>>,
  readAt: Date,
): CapacityObservation {
  const window = (name: RateWindow) =>
    windows[name] === undefined
      ? unknownWindow()
      : {
          utilisationPercent: measured(windows[name], 'test', readAt),
          resetsAt: measured('2026-03-01T15:00:00.000Z', 'test', readAt),
        };

  return {
    workerId: 'worker-1',
    authMode: 'subscription',
    subscriptionType: measured('max', 'test', readAt),
    windows: {
      fiveHour: window('fiveHour'),
      sevenDay: window('sevenDay'),
      sevenDayOpus: window('sevenDayOpus'),
    },
    context: unknownContext(),
    observedAt: readAt.toISOString(),
    source: 'test',
  };
}

/*
 * Only the three the capacity decision actually reads. `CapacitySources` names that slice, and a
 * fake built to it rather than to the whole container is what keeps this a unit test.
 */
function services(observations: readonly CapacityObservation[]): Services {
  return {
    workerRepo: { capacityObservations: async () => observations },
    charterService: { authority: async () => ({ charter: null }) },
    operatorService: { recentTicks: async () => [] },
  } as unknown as Services;
}

describe('the capacity view an owner reads', () => {
  it('carries when each figure was read, not only how it was known', async () => {
    /* Forty minutes old: past the point where the domain stops calling a reading current. */
    const readAt = new Date('2026-03-01T11:20:00.000Z');
    const view = await buildCapacityView(services([reporting({ fiveHour: 42 }, readAt)]), NOW);

    const fiveHour = view.windows.find((window) => window.window === 'fiveHour');
    expect(fiveHour?.percentUsed).toBe(42);
    expect(fiveHour?.qualityLabel).toBe('Last known');
    /*
     * The whole point. Without this the card can say "Last known" and nothing else, so a figure
     * from before lunch and one from a minute ago look the same on the page.
     */
    expect(fiveHour?.observedAt).toBe('2026-03-01T11:20:00.000Z');
  });

  it('reports the time the figure was read, not the time the page was built', async () => {
    /*
     * `mergeAccountLimits` answers each window from the newest worker that had a figure for it,
     * which need not be a worker that has said anything since. Stamping the render time would make
     * every reading on the page look freshly taken.
     */
    const readAt = new Date('2026-03-01T11:55:00.000Z');
    const view = await buildCapacityView(services([reporting({ sevenDay: 12 }, readAt)]), NOW);

    const weekly = view.windows.find((window) => window.window === 'sevenDay');
    expect(weekly?.qualityLabel).toBe('Measured');
    expect(weekly?.observedAt).toBe('2026-03-01T11:55:00.000Z');
    expect(weekly?.observedAt).not.toBe(NOW.toISOString());
  });

  it('says nothing about the age of a window it never read', async () => {
    const view = await buildCapacityView(
      services([reporting({ fiveHour: 42 }, new Date('2026-03-01T11:55:00.000Z'))]),
      NOW,
    );

    const opus = view.windows.find((window) => window.window === 'sevenDayOpus');
    expect(opus?.percentUsed).toBeNull();
    /*
     * Null, not the time of the report that failed to include it. An observation time beside "Not
     * readable" would read as "we looked at this window then", which is exactly what did not
     * happen.
     */
    expect(opus?.observedAt).toBeNull();
  });

  it('has no ages at all when no worker has ever reported', async () => {
    const view = await buildCapacityView(services([]), NOW);

    expect(view.reportingWorkers).toBe(0);
    expect(view.windows.map((window) => window.observedAt)).toEqual([null, null, null]);
  });
});
