import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { APPROVAL_POLICY_KEY, parseApprovalPolicy } from '@/domain/approval-policy';
import { charterContentSchema, type CharterContent } from '@/domain/charter';
import { handsOffStatus, setHandsOff } from '@/server/ops/hands-off';
import { createHarness, type TestHarness } from '../helpers/services';
import { RecordingProvisioner } from '../helpers/recording-provisioner';

/**
 * One switch, and what it actually changes.
 *
 * ## Why this is not covered by the approval-policy tests
 *
 * Those prove that *the policy* changes where a mission stops. This proves that the switch Blake
 * presses sets both of the things it claims to set, and that neither can be left behind. The two
 * records underneath — the operating mode and the approval policy — are what "Hands-off" means
 * between them, and the failure this guards against is the switch writing one and the dashboard
 * reporting both.
 *
 * ## Why every test also asks what the dashboard would say
 *
 * Because a switch whose stored value is right and whose displayed state is wrong is worse than
 * one that does not work: Blake would go to bed believing his machine was working through the
 * night. The status is read back through the same function the Operations screen calls.
 */

const charter = (): CharterContent =>
  charterContentSchema.parse({
    goals: [],
    projectIds: [],
    grants: [],
    limits: {},
    communication: {},
  }) as CharterContent;

describe('the Hands-off switch', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await createHarness({ repositoryProvisioner: new RecordingProvisioner() });
  });

  afterEach(async () => {
    await harness.close();
  });

  /** A charter in force, which is what standing authority is allowed to rest on. */
  const withCharter = async () => {
    const drafted = await harness.services.charterService.draft({
      content: charter(),
      authoredBy: 'test-owner',
    });
    await harness.services.charterService.activate(drafted.id, 'test-owner');
  };

  it('starts off, and says so', async () => {
    const status = await handsOffStatus(harness.services);
    expect(status.on).toBe(false);
    expect(status.policy.autoApproveRoutinePlans).toBe(false);
    /* Both halves are named, so the screen can say which switch is off rather than merely "no". */
    expect(status.gaps.length).toBeGreaterThan(0);
  });

  it('refuses to turn on without a charter, and says why', async () => {
    const before = await handsOffStatus(harness.services);
    expect(before.canEnable).toBe(false);
    expect(before.blockedReason).toMatch(/charter/i);

    await expect(
      setHandsOff(harness.services, { on: true, changedBy: 'test-owner' }),
    ).rejects.toThrow(/charter/i);

    /* And nothing moved. A refused switch that half-applied would be the worst outcome here. */
    const after = await handsOffStatus(harness.services);
    expect(after.mode).toBe(before.mode);
    expect(after.policy.autoApproveRoutinePlans).toBe(false);
  });

  it('sets both halves when it goes on', async () => {
    await withCharter();
    const status = await setHandsOff(harness.services, { on: true, changedBy: 'test-owner' });

    expect(status.on).toBe(true);
    expect(status.mode).toBe('operator');
    expect(status.gaps).toEqual([]);

    /* Read from the store rather than from the return value, so a lying return value fails. */
    const stored = parseApprovalPolicy(await harness.services.settings.get(APPROVAL_POLICY_KEY));
    expect(stored.autoApproveRoutinePlans).toBe(true);
    const state = await harness.services.charterService.state();
    expect(state.mode).toBe('operator');
  });

  it('walks through supervised rather than jumping, and records both moves', async () => {
    await withCharter();
    /*
     * From `off`, which is where a fresh install sits. `off → operator` is not a move the
     * transition table has, and deliberately: it is two decisions, and the audit should show two.
     */
    const before = await handsOffStatus(harness.services);
    expect(before.mode).toBe('off');

    await setHandsOff(harness.services, { on: true, changedBy: 'test-owner' });
    expect((await handsOffStatus(harness.services)).mode).toBe('operator');
  });

  it('pre-authorises nothing, so a merge is still refused', async () => {
    await withCharter();
    const status = await setHandsOff(harness.services, { on: true, changedBy: 'test-owner' });

    /*
     * The whole list stays. Turning Hands-off on delegates the *work*, not the decisions that
     * cannot be undone, and a switch that quietly widened those would be one nobody should press.
     */
    expect(status.policy.preAuthorised).toEqual([]);

    const project = await harness.services.projects.create({
      name: 'Handsoff merge check',
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

  it('narrows both halves when it goes off', async () => {
    await withCharter();
    await setHandsOff(harness.services, { on: true, changedBy: 'test-owner' });

    const status = await setHandsOff(harness.services, { on: false, changedBy: 'test-owner' });
    expect(status.on).toBe(false);
    expect(status.mode).toBe('supervised');
    expect(status.policy.autoApproveRoutinePlans).toBe(false);
  });

  it('does not widen a paused Jarvis on its way off', async () => {
    await withCharter();
    await setHandsOff(harness.services, { on: true, changedBy: 'test-owner' });
    await harness.services.charterService.setMode({
      to: 'paused',
      actor: 'owner',
      changedBy: 'test-owner',
      reason: 'Going out.',
    });

    const status = await setHandsOff(harness.services, { on: false, changedBy: 'test-owner' });

    /*
     * He asked for *less*. A switch with one target mode written into it would have resumed a
     * paused Jarvis as a side effect of turning something off, which is a genuinely dangerous
     * convenience.
     */
    expect(status.mode).toBe('paused');
    expect(status.policy.autoApproveRoutinePlans).toBe(false);
  });

  it('will not lift an emergency stop', async () => {
    await withCharter();
    await harness.services.charterService.setMode({
      to: 'emergency_stop',
      actor: 'owner',
      changedBy: 'test-owner',
      reason: 'Something looked wrong.',
    });

    await expect(
      setHandsOff(harness.services, { on: true, changedBy: 'test-owner' }),
    ).rejects.toThrow(/emergency stop/i);
    expect((await handsOffStatus(harness.services)).mode).toBe('emergency_stop');
  });

  it('carries routine work past the plan screen once it is on', async () => {
    await withCharter();
    await setHandsOff(harness.services, { on: true, changedBy: 'test-owner' });

    const project = await harness.services.projects.create({
      name: 'Handsoff routine work',
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

    const { mission } = await harness.services.missions.requestPlan(created.mission.id);

    /* The point of the whole switch: the same plan, and no screen between it and the work. */
    expect(mission.state).not.toBe('awaiting_plan_approval');
    expect(mission.approvedPlanVersion).not.toBeNull();
  });
});
