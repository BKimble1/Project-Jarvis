import { describe, expect, it } from 'vitest';

import { CAUTIOUS_APPROVAL_POLICY, type ApprovalPolicy } from '@/domain/approval-policy';
import {
  derivePosture,
  handsOffGaps,
  isHandsOff,
  POSTURE_LABELS,
} from '@/domain/operating-posture';

/**
 * The one word the dashboard uses, and the ordering that decides it.
 *
 * Almost every one of these is true at once on a real deployment — Hands-off, with a mission
 * running, and a stalled loop — so the ordering is what the owner actually reads, and it is the
 * only thing this module adds. Each test below is one rung of that ordering, stated as the
 * question it answers rather than as the branch it covers.
 */

const handsOffPolicy: ApprovalPolicy = { preAuthorised: [], autoApproveRoutinePlans: true };

const base = {
  mode: 'operator' as const,
  policy: handsOffPolicy,
  runningCount: 0,
  blockers: [] as readonly string[],
  waitingOnOwner: 0,
};

describe('whether Hands-off is on', () => {
  it('needs both halves', () => {
    expect(isHandsOff('operator', handsOffPolicy)).toBe(true);
    /* Standing authority without automatic plans is the half-delegated thing that started this. */
    expect(isHandsOff('operator', CAUTIOUS_APPROVAL_POLICY)).toBe(false);
    /* And automatic plans without standing authority never starts anything to approve. */
    expect(isHandsOff('supervised', handsOffPolicy)).toBe(false);
  });

  it('names the half that is missing, in words the owner can act on', () => {
    expect(handsOffGaps('operator', handsOffPolicy)).toEqual([]);

    const noAuthority = handsOffGaps('supervised', handsOffPolicy);
    expect(noAuthority).toHaveLength(1);
    expect(noAuthority[0]).toMatch(/wait for you/i);

    const noPlans = handsOffGaps('operator', CAUTIOUS_APPROVAL_POLICY);
    expect(noPlans).toHaveLength(1);
    expect(noPlans[0]).toMatch(/approval/i);

    expect(handsOffGaps('off', CAUTIOUS_APPROVAL_POLICY)).toHaveLength(2);
  });
});

describe('the posture the dashboard shows', () => {
  it('says Hands-off when there is nothing more specific to say', () => {
    const view = derivePosture(base);
    expect(view.posture).toBe('hands_off');
    expect(view.label).toBe(POSTURE_LABELS.hands_off);
    expect(view.handsOff).toBe(true);
    expect(view.sentence.length).toBeGreaterThan(20);
  });

  it('says Supervised when the owner has not delegated', () => {
    const view = derivePosture({ ...base, mode: 'supervised', policy: CAUTIOUS_APPROVAL_POLICY });
    expect(view.posture).toBe('supervised');
    expect(view.handsOff).toBe(false);
  });

  it('prefers the owner’s own choice to a consequence of it', () => {
    /*
     * Paused with no worker running. Reporting that as "Blocked" would be true and useless: of
     * course nothing is running, he stopped it.
     */
    const view = derivePosture({
      ...base,
      mode: 'paused',
      blockers: ['No worker is enrolled, so nothing can run.'],
    });
    expect(view.posture).toBe('paused');
  });

  it('never shows a green light over a broken thing', () => {
    const view = derivePosture({
      ...base,
      runningCount: 2,
      blockers: ['The operator loop is not running, so Jarvis will not start anything by itself.'],
    });
    expect(view.posture).toBe('blocked');
    /* Still Hands-off as a setting: a failing test has not turned the owner's switch off. */
    expect(view.handsOff).toBe(true);
  });

  it('lists every blocker rather than naming one and hiding the rest', () => {
    const view = derivePosture({
      ...base,
      blockers: ['No worker is enrolled, so nothing can run.', 'The loop is not running.'],
    });
    expect(view.blockers).toHaveLength(2);
    /* And the sentence says there is more, so nobody fixes one thing and wonders why. */
    expect(view.sentence).toMatch(/other/i);
  });

  it('calls a waiting decision blocked only when nothing else is happening', () => {
    expect(derivePosture({ ...base, waitingOnOwner: 1 }).posture).toBe('blocked');
    /*
     * A decision waiting alongside running work is not what "blocked" means — something is very
     * much happening, and the decision is on the list of things waiting for him either way.
     */
    expect(derivePosture({ ...base, waitingOnOwner: 1, runningCount: 3 }).posture).toBe('running');
  });

  it('says Running while work is in flight, whatever the setting', () => {
    expect(derivePosture({ ...base, runningCount: 1 }).posture).toBe('running');
    expect(
      derivePosture({
        ...base,
        mode: 'supervised',
        policy: CAUTIOUS_APPROVAL_POLICY,
        runningCount: 1,
      }).posture,
    ).toBe('running');
  });

  it('gives every posture a sentence a person could be read', () => {
    for (const mode of [
      'off',
      'observer',
      'supervised',
      'operator',
      'paused',
      'emergency_stop',
    ] as const) {
      for (const running of [0, 2]) {
        const view = derivePosture({ ...base, mode, runningCount: running });
        expect(view.sentence.trim().length, `${mode}/${running}`).toBeGreaterThan(20);
        expect(view.label.length).toBeGreaterThan(0);
      }
    }
  });
});
