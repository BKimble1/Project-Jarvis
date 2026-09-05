import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { WORKER_VERSION, type WorkerCapacityInput } from '@/domain/worker-protocol';
import { mergeAccountLimits, decideCapacity } from '@/domain/claude-capacity';
import { createHarness, type TestHarness } from '../helpers/services';

/**
 * Claude capacity, from a worker's heartbeat to the governor's decision.
 *
 * These run against the real schema and the real service, because every interesting failure in
 * this path is a persistence failure. The mapping is unit-tested elsewhere; what is tested here is
 * what the database ends up holding after a sequence of heartbeats — which is the thing the
 * governor will actually read, and the thing a mistake would quietly corrupt.
 */

const HEARTBEAT = {
  status: 'idle' as const,
  version: WORKER_VERSION,
  runtimeAvailable: true,
  runtimeName: 'claude-agent-sdk',
  workspaceHealthy: true,
  githubDeliveryConfigured: true,
  diagnostics: [],
};

function reading(overrides: Partial<WorkerCapacityInput> = {}): WorkerCapacityInput {
  return {
    authMode: 'subscription',
    subscriptionType: 'max',
    rateLimitsApplicable: true,
    windows: {
      fiveHour: { utilisationPercent: 40, resetsAt: '2026-03-01T15:00:00.000Z' },
      sevenDay: { utilisationPercent: 12, resetsAt: '2026-03-05T00:00:00.000Z' },
      sevenDayOpus: null,
    },
    context: { usedTokens: 1000, maxTokens: 200_000, percentUsed: 1, overLimit: false },
    usingOverage: false,
    source: 'test',
    observedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('Claude capacity through the heartbeat', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await createHarness();
  });

  afterEach(async () => {
    await harness.close();
  });

  async function enrolled(): Promise<string> {
    const { worker } = await harness.services.workerService.enrol('capacity-worker', 1);
    return worker.id;
  }

  it('stores a reading and offers it to the governor', async () => {
    const id = await enrolled();
    await harness.services.workerService.poll(id, {
      heartbeat: { ...HEARTBEAT, capacity: reading() },
      acknowledgedCommandIds: [],
      wantsWork: true,
    });

    const observations = await harness.services.workerRepo.capacityObservations();
    expect(observations).toHaveLength(1);
    expect(observations[0]?.authMode).toBe('subscription');
    expect(observations[0]?.windows.fiveHour.utilisationPercent.value).toBe(40);
    expect(observations[0]?.windows.fiveHour.utilisationPercent.quality).toBe('measured');
    /* A window the worker could not read stays unknown rather than becoming a number. */
    expect(observations[0]?.windows.sevenDayOpus.utilisationPercent.value).toBeNull();
    expect(observations[0]?.windows.sevenDayOpus.utilisationPercent.quality).toBe('unknown');
  });

  it('does not erase a good reading when a later heartbeat has nothing to report', async () => {
    /*
     * The defect this whole design exists to avoid. Capacity can only be read from a live Claude
     * session, so between missions a worker has nothing new — and it heartbeats every few seconds.
     * If an absent block cleared the columns, a measurement would survive for about as long as it
     * took to take it, and the governor would spend its life deciding on nothing.
     */
    const id = await enrolled();
    const first = reading();
    await harness.services.workerService.poll(id, {
      heartbeat: { ...HEARTBEAT, capacity: first },
      acknowledgedCommandIds: [],
      wantsWork: true,
    });

    for (let beat = 0; beat < 3; beat += 1) {
      await harness.services.workerService.poll(id, {
        heartbeat: HEARTBEAT,
        acknowledgedCommandIds: [],
        wantsWork: true,
      });
    }

    const observations = await harness.services.workerRepo.capacityObservations();
    expect(observations).toHaveLength(1);
    expect(observations[0]?.windows.fiveHour.utilisationPercent.value).toBe(40);
    /* And it is still dated when the worker read it, not when the quiet heartbeats arrived. */
    expect(observations[0]?.observedAt).toBe(new Date(first.observedAt).toISOString());
  });

  it('offers nothing at all for a worker that has never managed to read capacity', async () => {
    /*
     * No row of zeroes. An unmeasured worker must be absent from the observations entirely, so
     * that `mergeAccountLimits` resolves to unknown rather than to a confident, empty account.
     */
    const id = await enrolled();
    await harness.services.workerService.poll(id, {
      heartbeat: HEARTBEAT,
      acknowledgedCommandIds: [],
      wantsWork: true,
    });

    expect(await harness.services.workerRepo.capacityObservations()).toEqual([]);
  });

  it('never adds two workers’ percentages together', async () => {
    /*
     * A subscription window belongs to the account, not to a machine. Three workers each reporting
     * 42% means the account is at 42% — summing them would produce 126%, a number that cannot
     * exist, stated with complete confidence.
     */
    const older = await enrolled();
    const newer = await enrolled();

    await harness.services.workerService.poll(older, {
      heartbeat: {
        ...HEARTBEAT,
        capacity: reading({
          observedAt: '2026-03-01T11:00:00.000Z',
          windows: {
            fiveHour: { utilisationPercent: 42, resetsAt: null },
            sevenDay: { utilisationPercent: 42, resetsAt: null },
            sevenDayOpus: null,
          },
        }),
      },
      acknowledgedCommandIds: [],
      wantsWork: true,
    });
    await harness.services.workerService.poll(newer, {
      heartbeat: {
        ...HEARTBEAT,
        capacity: reading({
          observedAt: '2026-03-01T11:30:00.000Z',
          windows: {
            fiveHour: { utilisationPercent: 42, resetsAt: null },
            sevenDay: { utilisationPercent: 42, resetsAt: null },
            sevenDayOpus: null,
          },
        }),
      },
      acknowledgedCommandIds: [],
      wantsWork: true,
    });

    const merged = mergeAccountLimits(
      await harness.services.workerRepo.capacityObservations(),
      new Date('2026-03-01T11:31:00.000Z'),
    );
    expect(merged.windows.fiveHour.utilisationPercent.value).toBe(42);
    expect(merged.workerIds).toHaveLength(2);
  });

  it('refuses a reading dated in the future rather than trusting it forever', async () => {
    /*
     * A worker's clock is not the control plane's. A reading stamped tomorrow would never age into
     * staleness, because ageing compares against the clock — so the governor would keep deciding
     * on it long after it stopped being true.
     */
    const id = await enrolled();
    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    await harness.services.workerService.poll(id, {
      heartbeat: { ...HEARTBEAT, capacity: reading({ observedAt: tomorrow }) },
      acknowledgedCommandIds: [],
      wantsWork: true,
    });

    expect(await harness.services.workerRepo.capacityObservations()).toEqual([]);
  });

  it('keeps an API worker out of the subscription windows entirely', async () => {
    const id = await enrolled();
    await harness.services.workerService.poll(id, {
      heartbeat: {
        ...HEARTBEAT,
        capacity: reading({
          authMode: 'api_key',
          subscriptionType: null,
          rateLimitsApplicable: false,
          /* Figures arriving alongside "limits do not apply" describe something else. */
          windows: {
            fiveHour: { utilisationPercent: 97, resetsAt: null },
            sevenDay: null,
            sevenDayOpus: null,
          },
        }),
      },
      acknowledgedCommandIds: [],
      wantsWork: true,
    });

    const observations = await harness.services.workerRepo.capacityObservations();
    expect(observations[0]?.windows.fiveHour.utilisationPercent.value).toBeNull();

    /*
     * And the governor lets it work: an API worker's constraint is money, which the budget handles,
     * not a five-hour window it does not have.
     */
    const decision = decideCapacity(mergeAccountLimits(observations, new Date()), {
      fiveHourPercent: 25,
      sevenDayPercent: 20,
    });
    expect(decision.mayStartNewWork).toBe(true);
  });

  it('records what the governor decided, and narrows the loop when a window tightens', async () => {
    /*
     * The governor was written, tested and connected to nothing: with no observations it resolved
     * to "clear" on every pass, so it was a governor that always said yes. This drives the real
     * operator against a real worker reading and asserts that the decision both reaches the loop
     * and is written down where an owner can read it.
     */
    const { charterService, operatorService, workerService, workerRepo } = harness.services;
    await charterService.setMode({ to: 'observer', actor: 'owner', changedBy: 'owner' });

    const { worker } = await workerService.enrol('tight-worker', 1);
    await workerService.poll(worker.id, {
      heartbeat: {
        ...HEARTBEAT,
        capacity: reading({
          windows: {
            /* Well inside the default 25% reserve. */
            fiveHour: { utilisationPercent: 92, resetsAt: '2026-03-01T15:00:00.000Z' },
            sevenDay: { utilisationPercent: 10, resetsAt: null },
            sevenDayOpus: { utilisationPercent: 10, resetsAt: null },
          },
        }),
      },
      acknowledgedCommandIds: [],
      wantsWork: true,
    });

    expect(await workerRepo.capacityObservations()).toHaveLength(1);

    const result = await operatorService.tick();
    expect(result.capacity?.verdict).toBe('reserved');
    expect(result.capacity?.maxNewWork).toBe(0);
    expect(result.capacity?.reason).toMatch(/keep for you/);

    /*
     * And written down. On a quiet day the tick row is the only place that distinguishes "there
     * was nothing worth doing" from "Jarvis was keeping your capacity back for you".
     */
    const ticks = await operatorService.recentTicks();
    expect(ticks[0]?.capacityVerdict).toBe('reserved');
    expect(ticks[0]?.capacityReason).toMatch(/keep for you/);
  });

  it('does not flap when a window is resting on the reserve boundary', async () => {
    /*
     * Hysteresis, end to end. The previous verdict is read from the last finished tick rather than
     * held in memory, because the loop is driven from more than one place and may not be the same
     * process twice — so this only works if the verdict was genuinely persisted.
     */
    const { charterService, operatorService, workerService } = harness.services;
    await charterService.setMode({ to: 'observer', actor: 'owner', changedBy: 'owner' });
    const { worker } = await workerService.enrol('boundary-worker', 1);

    const report = async (utilisation: number) => {
      await workerService.poll(worker.id, {
        heartbeat: {
          ...HEARTBEAT,
          capacity: reading({
            observedAt: new Date().toISOString(),
            windows: {
              fiveHour: { utilisationPercent: utilisation, resetsAt: null },
              sevenDay: { utilisationPercent: 5, resetsAt: null },
              sevenDayOpus: { utilisationPercent: 5, resetsAt: null },
            },
          }),
        },
        acknowledgedCommandIds: [],
        wantsWork: true,
      });
    };

    /* Inside the reserve: hold. */
    await report(80);
    expect((await operatorService.tick()).capacity?.verdict).toBe('reserved');

    /* Barely outside it. Without hysteresis this would immediately read as clear again. */
    await report(73);
    const recovering = await operatorService.tick();
    expect(recovering.capacity?.verdict).toBe('reserved');
    expect(recovering.capacity?.reason).toMatch(/a little more room/);

    /* Properly clear: it starts again — narrowed, because the window is still not roomy. */
    await report(40);
    const resumed = await operatorService.tick();
    expect(resumed.capacity?.verdict).toBe('clear');
    expect(resumed.capacity?.mayStartNewWork).toBe(true);
  });
});
