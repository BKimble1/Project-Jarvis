import { describe, expect, it } from 'vitest';

import { AGENT_ROLES, isDeterministicRole, isWriteRole } from '@/domain/agent-role';
import { MISSION_TYPES, isReadOnlyMissionType } from '@/domain/mission';
import { TASK_TYPES } from '@/domain/mission-task';
import {
  CHARTER_TRANSITIONS,
  MISSION_TRANSITIONS,
  assertTransition,
  charterMayMove,
} from '@/domain/mission-state';
import { ConflictError } from '@/domain/errors';
import { ForbiddenError } from '@/domain/errors';
import { QUALIFICATION_LEVELS, meetsLevel } from '@/domain/qualification';
import {
  assertUnattended,
  missionUnattendedCapabilities,
  taskUnattendedCapabilities,
  unattendedMissionTypes,
  unattendedTaskRoles,
  unattendedTaskTypes,
  unattendedVerdict,
} from '@/domain/unattended';

/**
 * The gate between "Jarvis can do this" and "Jarvis may do this with nobody watching".
 *
 * Phase 4A built an activation lock and wired it to one caller. Standing authority is what makes
 * that gap matter: as long as a person approved every mission, the person *was* the gate, and the
 * lock's silence was survivable. These tests exist to make the enforced behaviour a property of
 * the code rather than of whoever last remembered to call it — which is exactly what it was not.
 */

describe('what work consumes', () => {
  it('gives every mission a model capability, and only writing ones the write capabilities', () => {
    for (const type of MISSION_TYPES) {
      const capabilities = missionUnattendedCapabilities(type);
      expect(capabilities).toContain('model_task_readonly');
      if (isReadOnlyMissionType(type)) {
        expect(capabilities).toEqual(['model_task_readonly']);
      } else {
        expect(capabilities).toContain('model_task_write');
        expect(capabilities).toContain('github_write');
      }
    }
  });

  it('asks nothing of a role that runs no model, and everything of one that writes', () => {
    for (const role of AGENT_ROLES) {
      const capabilities = taskUnattendedCapabilities(role, 'research');
      if (isDeterministicRole(role)) expect(capabilities).toEqual([]);
      else if (isWriteRole(role))
        expect([...capabilities].sort()).toEqual(['model_task_readonly', 'model_task_write']);
      else expect(capabilities).toEqual(['model_task_readonly']);
    }
  });

  /*
   * The delivery task is deterministic — no model, no latitude — and it is the single moment a
   * branch reaches GitHub. Keying it on the role would have missed it entirely, which is the
   * mistake this asserts against.
   */
  it('gates delivery on github_write even though delivery runs no model', () => {
    expect(taskUnattendedCapabilities('integrator', 'integration')).toEqual([]);
    expect(taskUnattendedCapabilities('integrator', 'delivery')).toEqual(['github_write']);
  });

  it('gates a CI dispatch task on ci_dispatch', () => {
    expect(taskUnattendedCapabilities('release_verifier', 'ci_dispatch')).toContain('ci_dispatch');
  });
});

describe('the ladder decides what may be handed out', () => {
  it('hands out no mission at all below live_read', () => {
    expect(unattendedMissionTypes('built')).toEqual([]);
    expect(unattendedMissionTypes('automated')).toEqual([]);
    expect(unattendedMissionTypes('simulated')).toEqual([]);
  });

  it('hands out read-only missions at live_read and writing ones only at live_write', () => {
    const readOnly = unattendedMissionTypes('live_read');
    expect(readOnly.length).toBeGreaterThan(0);
    expect(readOnly.every(isReadOnlyMissionType)).toBe(true);
    expect(unattendedMissionTypes('live_write')).toEqual([...MISSION_TYPES]);
  });

  it('never lets a builder be claimed unattended below live_write', () => {
    for (const level of QUALIFICATION_LEVELS) {
      const allowed = unattendedTaskRoles(level).includes('builder');
      expect(allowed).toBe(meetsLevel(level, 'live_write'));
    }
  });

  it('never lets a delivery task be claimed unattended below live_write', () => {
    for (const level of QUALIFICATION_LEVELS) {
      const allowed = unattendedTaskTypes(level).includes('delivery');
      expect(allowed).toBe(meetsLevel(level, 'live_write'));
    }
  });

  it('never lets a ci_dispatch task be claimed unattended below production', () => {
    for (const level of QUALIFICATION_LEVELS) {
      const allowed = unattendedTaskTypes(level).includes('ci_dispatch');
      expect(allowed).toBe(meetsLevel(level, 'production'));
    }
  });

  /*
   * The two claim queries filter on role and on type independently, because SQL is filtering on
   * columns. That is only safe if the filters are looser than the assertion, never tighter — a
   * filter that lets something through is caught at the boundary, a filter that excludes something
   * silently loses work.
   */
  it('keeps both query filters looser than the exact assertion', () => {
    for (const level of QUALIFICATION_LEVELS) {
      const roles = new Set<string>(unattendedTaskRoles(level));
      const types = new Set<string>(unattendedTaskTypes(level));
      for (const role of AGENT_ROLES) {
        for (const type of TASK_TYPES) {
          if (unattendedVerdict(taskUnattendedCapabilities(role, type), level).allowed) {
            expect(roles.has(role)).toBe(true);
            expect(types.has(type)).toBe(true);
          }
        }
      }
    }
  });
});

describe('the verdict', () => {
  it('names every missing capability rather than only the first', () => {
    const verdict = unattendedVerdict(missionUnattendedCapabilities('code_change'), 'built');
    expect(verdict.allowed).toBe(false);
    expect(verdict.missing.map((entry) => entry.capability)).toEqual([
      'model_task_readonly',
      'model_task_write',
      'github_write',
    ]);
    expect(verdict.reason).toContain('Built');
  });

  it('names the highest rung that would clear everything', () => {
    const verdict = unattendedVerdict(['model_task_readonly', 'ci_dispatch'], 'built');
    expect(verdict.reason).toContain('production');
  });

  it('throws a ForbiddenError, because the caller is already holding the work', () => {
    expect(() => assertUnattended(['model_task_write'], 'live_read')).toThrow(ForbiddenError);
    expect(() => assertUnattended(['model_task_write'], 'live_write')).not.toThrow();
  });

  it('allows an empty capability set at every rung', () => {
    for (const level of QUALIFICATION_LEVELS) {
      expect(unattendedVerdict([], level).allowed).toBe(true);
    }
  });
});

describe('standing authority in the mission state machine', () => {
  it('may make exactly the four moves that are written down, and no others', () => {
    const actual = MISSION_TRANSITIONS.filter((transition) =>
      transition.actors.includes('charter'),
    ).map((transition) => `${transition.from}→${transition.to}`);
    expect(actual.sort()).toEqual(CHARTER_TRANSITIONS.map(([from, to]) => `${from}→${to}`).sort());
    expect(actual).toHaveLength(4);
  });

  /*
   * The three refusals that matter. Each one is a way standing authority could overrule a live
   * owner decision, and each is refused by the table rather than by a caller's good manners.
   */
  it('cannot cancel a mission', () => {
    for (const transition of MISSION_TRANSITIONS.filter((t) => t.to === 'cancelled')) {
      expect(charterMayMove(transition.from, 'cancelled')).toBe(false);
    }
  });

  it('cannot stop or pause a mission', () => {
    for (const transition of MISSION_TRANSITIONS.filter(
      (t) => t.to === 'stopping' || t.to === 'pausing',
    )) {
      expect(charterMayMove(transition.from, transition.to)).toBe(false);
    }
  });

  it('cannot re-queue a mission a person stopped', () => {
    expect(charterMayMove('failed', 'queued')).toBe(true);
    expect(charterMayMove('stopped', 'queued')).toBe(false);
    expect(() => assertTransition('stopped', 'queued', 'charter')).toThrow(ConflictError);
  });

  it('explains a refusal in terms of the owner rather than in terms of an actor name', () => {
    expect(() => assertTransition('running', 'stopping', 'charter')).toThrow(
      /Standing authority cannot move a mission.*needs you/s,
    );
  });

  it('does not widen anything an owner could not do already', () => {
    for (const transition of MISSION_TRANSITIONS) {
      if (transition.actors.includes('charter')) {
        expect(transition.actors).toContain('owner');
      }
    }
  });
});
