import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { APPROVAL_POLICY_KEY } from '@/domain/approval-policy';
import { createHarness, type TestHarness } from '../helpers/services';
import { RecordingProvisioner } from '../helpers/recording-provisioner';

/**
 * Whether routine work still stops at a screen.
 *
 * ## What this is really testing
 *
 * That the policy changes *behaviour*, not just a stored value. It is easy to write a settings page
 * whose switches are read by nothing; the only way to know is to run a mission through the real
 * service with the policy off and then on, and watch where it stops.
 *
 * The mission is created through `MissionService` directly rather than through a conversation,
 * because what is under test is the plan gate rather than the way the idea arrived.
 */
describe('the approval policy, applied to real work', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await createHarness({ repositoryProvisioner: new RecordingProvisioner() });
  });

  afterEach(async () => {
    await harness.close();
  });

  const setPolicy = async (input: {
    preAuthorised?: readonly string[];
    autoApproveRoutinePlans: boolean;
  }) => {
    await harness.services.settings.set(APPROVAL_POLICY_KEY, {
      preAuthorised: input.preAuthorised ?? [],
      autoApproveRoutinePlans: input.autoApproveRoutinePlans,
    });
  };

  /** A small, ordinary piece of work: the kind the owner does not want to be asked about. */
  const routineMission = async () => {
    const project = await harness.services.projects.create({
      name: `Routine ${Math.random().toString(36).slice(2, 8)}`,
      shortName: null,
      description: null,
      type: 'software',
      status: 'active',
      phase: 'Starting',
      goal: 'Build the first version.',
      priority: 'medium',
      tags: [],
      links: [],
    });

    const created = await harness.services.missions.create(
      {
        rawRequest: 'Add a settings screen with tests and documentation.',
        title: 'Add a settings screen',
        type: 'code_change',
        projectId: project.id,
        priority: 'medium',
        constraints: [],
        doNotTouch: [],
        deliverable: 'A settings screen in the repository.',
        acceptanceCriteria: ['The screen renders', 'The suite is still green'],
      },
      'test-owner',
    );
    return created.mission;
  };

  it('stops at the plan when the owner has not turned anything on', async () => {
    await setPolicy({ autoApproveRoutinePlans: false });
    const mission = await routineMission();

    /* No worker with a runtime here, so the deterministic planner writes the plan immediately. */
    const { mission: planned } = await harness.services.missions.requestPlan(mission.id);

    expect(planned.state).toBe('awaiting_plan_approval');
    expect(planned.approvedPlanVersion).toBeNull();
  });

  it('says why it is waiting, rather than simply sitting there', async () => {
    await setPolicy({ autoApproveRoutinePlans: false });
    const mission = await routineMission();
    await harness.services.missions.requestPlan(mission.id);

    const detail = await harness.services.missions.detail(mission.id);
    const explained = detail.events.some((event) =>
      event.summary.toLowerCase().includes('waiting for you to approve'),
    );
    expect(explained, 'the timeline explains why it stopped').toBe(true);
  });

  it('carries routine work past the plan screen once the owner turns it on', async () => {
    await setPolicy({ autoApproveRoutinePlans: true });
    const mission = await routineMission();

    const { mission: planned } = await harness.services.missions.requestPlan(mission.id);

    /*
     * The whole point of the change: the same mission, the same plan, and no human in the loop —
     * approved and queued rather than parked.
     */
    expect(planned.state).not.toBe('awaiting_plan_approval');
    expect(planned.approvedPlanVersion).not.toBeNull();
  });

  it('records that nobody was present, rather than filing it as the owner', async () => {
    await setPolicy({ autoApproveRoutinePlans: true });
    const mission = await routineMission();
    await harness.services.missions.requestPlan(mission.id);

    const detail = await harness.services.missions.detail(mission.id);
    const approval = detail.events.find((event) => event.type === 'plan_approved');
    expect(approval, 'the approval is on the timeline').toBeTruthy();
    /*
     * An approval nobody read must never be indistinguishable in the record from one somebody did.
     * The reason travels with it, so "why did this run" is answerable a week later.
     */
    expect(JSON.stringify(approval?.detail ?? {}).toLowerCase()).toContain('policy');
  });

  it('refuses a merge outright rather than offering it as something to pre-authorise', async () => {
    await setPolicy({ autoApproveRoutinePlans: true, preAuthorised: [] });

    const project = await harness.services.projects.create({
      name: `Merge ${Math.random().toString(36).slice(2, 8)}`,
      shortName: null,
      description: null,
      type: 'software',
      status: 'active',
      phase: 'Starting',
      goal: 'Ship it.',
      priority: 'medium',
      tags: [],
      links: [],
    });

    /*
     * Stronger than this policy, and deliberately so.
     *
     * `classifyMissionRisk` treats merging as prohibited at creation — the mission never exists to
     * be approved. That is a better answer than "ask the owner", and the policy must not be read
     * as a way to unlock it: pre-authorising `merge` widens what an *existing* mission may do, and
     * cannot bring a refused one into being.
     */
    await expect(
      harness.services.missions.create(
        {
          rawRequest: 'Fix the failing check and then merge the pull request into main.',
          title: 'Fix the check and merge',
          type: 'code_change',
          projectId: project.id,
          priority: 'medium',
          constraints: [],
          doNotTouch: [],
          acceptanceCriteria: ['The check passes'],
        },
        'test-owner',
      ),
    ).rejects.toThrow(/never merges/i);
  });

  it('reads a corrupted policy as the cautious one rather than the permissive one', async () => {
    /* A hand-edited row, an older shape, a failed migration: none of them may widen anything. */
    await harness.services.settings.set(APPROVAL_POLICY_KEY, 'yes please');
    const mission = await routineMission();

    const { mission: planned } = await harness.services.missions.requestPlan(mission.id);
    expect(planned.state).toBe('awaiting_plan_approval');
  });
});
