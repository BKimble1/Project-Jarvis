import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MISSION_LEASE_MS } from '@/domain/worker';
import { createHarness, type TestHarness } from '../helpers/services';
import { RecordingProvisioner } from '../helpers/recording-provisioner';

/**
 * What happens to a mission when the worker holding it dies.
 *
 * ## The rule this must not break
 *
 * `reconcileLostWorkers` states it: a mission whose worker went silent is **not** failed. The work
 * on disk is very likely fine and the worker very likely comes back, so inventing a failure throws
 * away a run that was about to resume.
 *
 * The lease adds the missing half — when to stop believing the claim — without touching that rule.
 * These tests are mostly about the *restraint*: which missions are safe to hand to somebody else,
 * and which must be left exactly where they are because a second worker would not resume them, it
 * would do them again on top of themselves.
 */
describe('a mission whose worker stopped reporting', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await createHarness({ repositoryProvisioner: new RecordingProvisioner() });
  });

  afterEach(async () => {
    await harness.close();
  });

  /** A mission sitting in a given state, held by a worker whose lease has already run out. */
  const heldMission = async (state: string) => {
    const project = await harness.services.projects.create({
      name: `Lease ${Math.random().toString(36).slice(2, 8)}`,
      shortName: null,
      description: null,
      type: 'software',
      status: 'active',
      phase: 'Starting',
      goal: 'Build it.',
      priority: 'medium',
      tags: [],
      links: [],
    });

    const worker = await harness.services.workerService.enrol(
      `lease-worker-${Math.random().toString(36).slice(2, 6)}`,
      1,
    );

    const created = await harness.services.missionRepo.create({
      rawRequest: 'Add a settings screen.',
      title: 'Add a settings screen',
      type: 'code_change',
      projectId: project.id,
      priority: 'medium',
      constraints: [],
      doNotTouch: [],
      acceptanceCriteria: [],
      riskLevel: 'low',
      riskRuleIds: [],
      riskReasons: [],
      ownerLogin: 'test-owner',
      state: 'draft',
    });

    /*
     * Put it where the test needs it, holding a claim whose lease expired a minute ago.
     *
     * The repository's `transition` writes the state directly rather than walking the table — the
     * table is enforced by `MissionService.move`. That is what a test wants here: the subject is
     * the reclaim, not the route the mission took to get where it is.
     */
    await harness.services.missionRepo.transition(created.id, state as never, {
      claimedByWorkerId: worker.worker.id,
      leaseExpiresAt: new Date(Date.now() - MISSION_LEASE_MS - 60_000),
    });

    return { missionId: created.id, workerId: worker.worker.id };
  };

  it('puts work back in the queue when nothing had been built yet', async () => {
    const { missionId } = await heldMission('claimed');

    const result = await harness.services.missions.reclaimExpiredMissions();
    expect(result.requeued).toBe(1);

    const mission = await harness.services.missionRepo.findById(missionId);
    expect(mission?.state).toBe('queued');
    /* Released, so `canClaimMission` will let a returning worker take it. */
    expect(mission?.claimedByWorkerId).toBeNull();
    expect(mission?.activeRunId).toBeNull();
    expect(mission?.leaseExpiresAt).toBeNull();
  });

  it('does not re-run work that had already started', async () => {
    const { missionId } = await heldMission('running');

    const result = await harness.services.missions.reclaimExpiredMissions();

    /*
     * The important restraint. A running mission has a branch and possibly commits; handing it to
     * a second worker does not resume it, it repeats it. The claim is released so somebody can
     * pick it up deliberately, and the state is left exactly where it was.
     */
    expect(result.requeued).toBe(0);
    expect(result.released).toBe(1);

    const mission = await harness.services.missionRepo.findById(missionId);
    expect(mission?.state).toBe('running');
    expect(mission?.claimedByWorkerId).toBeNull();
  });

  it('says on the mission itself what happened and that nothing was repeated', async () => {
    const { missionId } = await heldMission('running');
    await harness.services.missions.reclaimExpiredMissions();

    const detail = await harness.services.missions.detail(missionId);
    const said = detail.events.map((event) => event.summary.toLowerCase()).join(' | ');
    expect(said).toContain('stopped reporting');
    expect(said).toContain('nothing was repeated');
  });

  it('leaves a live claim alone', async () => {
    const { missionId } = await heldMission('claimed');
    /* Renewed a moment ago: the worker is working, and this must not touch it. */
    await harness.services.missionRepo.patch(missionId, {
      leaseExpiresAt: new Date(Date.now() + MISSION_LEASE_MS),
    });

    const result = await harness.services.missions.reclaimExpiredMissions();
    expect(result).toEqual({ requeued: 0, released: 0 });

    const mission = await harness.services.missionRepo.findById(missionId);
    expect(mission?.claimedByWorkerId).not.toBeNull();
  });

  it('is safe to run twice, because a sweeper runs on a timer', async () => {
    await heldMission('claimed');

    const first = await harness.services.missions.reclaimExpiredMissions();
    const second = await harness.services.missions.reclaimExpiredMissions();

    expect(first.requeued).toBe(1);
    /* Nothing left holding an expired lease, so the second pass finds nothing to do. */
    expect(second).toEqual({ requeued: 0, released: 0 });
  });

  it('only lets the worker that holds a mission renew it', async () => {
    const { missionId, workerId } = await heldMission('running');

    /* A stale process from before a restart, reporting about a mission it no longer holds. */
    await harness.services.missions.renewMissionLease(missionId, 'a-different-worker');
    const untouched = await harness.services.missionRepo.findById(missionId);
    expect(Date.parse(untouched!.leaseExpiresAt!)).toBeLessThan(Date.now());

    /* The real holder renews it. */
    await harness.services.missions.renewMissionLease(missionId, workerId);
    const renewed = await harness.services.missionRepo.findById(missionId);
    expect(Date.parse(renewed!.leaseExpiresAt!)).toBeGreaterThan(Date.now());
  });
});
