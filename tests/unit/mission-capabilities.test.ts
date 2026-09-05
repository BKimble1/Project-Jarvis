import { describe, expect, it } from 'vitest';

import { CAPABILITY_BY_CLASS, CAPABILITY_CLASSES } from '@/domain/charter';
import { MISSION_TYPES, isReadOnlyMissionType } from '@/domain/mission';
import {
  coversPlan,
  isAutonomousMissionType,
  missionCapabilityClasses,
  missionCapabilityRequests,
} from '@/domain/mission-capabilities';
import type { MissionPlanContent } from '@/domain/mission-plan';

/**
 * What a mission would actually need permission to do.
 *
 * The hole this fills: an operator asks for permission to update a project's status, is granted
 * it, and then runs a mission that rewrites a repository. Every other check passes — the decision
 * exists, it was authorised, it was made for that mission — because nothing compared the two.
 */

const PLAN: MissionPlanContent = {
  summary: 'Tidy the importer',
  proposedOutcome: 'A draft pull request.',
  assumptions: [],
  scope: [],
  outOfScope: [],
  affectedAreas: [],
  approach: 'Rename two functions.',
  dataMigrations: [],
  testsToAddOrUpdate: [],
  verification: [],
  uiValidation: [],
  risks: [],
  rollback: 'Close the pull request.',
  acceptanceCriteria: [],
  openQuestions: [],
  estimatedComplexity: 'small',
  withinRequestedScope: true,
  scopeNotes: null,
  reviewOnlyDelivery: true,
  evidenceIds: [],
  repositoryFacts: {},
};

describe('what a mission needs', () => {
  it('gives every mission type a set of capabilities that all exist', () => {
    for (const type of MISSION_TYPES) {
      for (const capability of missionCapabilityClasses({ type, plan: null })) {
        expect(CAPABILITY_BY_CLASS[capability], `${type} → ${capability}`).toBeDefined();
      }
    }
  });

  /* Every mission delivers through a branch and a draft pull request; that is not optional. */
  it('adds the branch and the pull request to every writing mission', () => {
    for (const type of MISSION_TYPES) {
      const classes = missionCapabilityClasses({ type, plan: null });
      if (isReadOnlyMissionType(type)) {
        expect(classes, type).not.toContain('branch.create');
        expect(classes, type).not.toContain('pull_request.open');
      } else if (type !== 'manual_task') {
        expect(classes, type).toContain('branch.create');
        expect(classes, type).toContain('pull_request.open');
      }
    }
  });

  /*
   * Not "asks for nothing", which `coversPlan` would read as full coverage and wave through. Work
   * for a person is refused as a *type*, and no charter can grant the ability to do something only
   * a human can do.
   */
  it('will not let standing authority take work that belongs to a person', () => {
    expect(isAutonomousMissionType('manual_task')).toBe(false);
    const gap = coversPlan({ authorised: [], type: 'manual_task', plan: null });
    expect(gap).not.toBeNull();
    expect(gap?.ownerCanGrant).toBe(false);
    expect(gap?.reason).toMatch(/work for a person/);

    /* And granting everything does not help. */
    const generous = coversPlan({
      authorised: [...CAPABILITY_CLASSES],
      type: 'manual_task',
      plan: null,
    });
    expect(generous?.ownerCanGrant).toBe(false);
  });

  it('lets standing authority take every other type', () => {
    for (const type of MISSION_TYPES.filter((entry) => entry !== 'manual_task')) {
      expect(isAutonomousMissionType(type), type).toBe(true);
    }
  });

  /*
   * The mission type is what the owner asked for; the plan is what Jarvis intends to do, and the
   * second is the one that has to be authorised.
   */
  it('reads the plan as well as the type', () => {
    const withTests = missionCapabilityClasses({
      type: 'code_change',
      plan: { ...PLAN, testsToAddOrUpdate: ['Importer unit tests'] },
    });
    expect(withTests).toContain('test.add');
    expect(missionCapabilityClasses({ type: 'code_change', plan: PLAN })).not.toContain('test.add');
  });

  it('asks for the wider set when the mapping is uncertain', () => {
    const maintenance = missionCapabilityClasses({ type: 'repository_maintenance', plan: null });
    expect(maintenance).toContain('code.change');
    expect(maintenance).toContain('dependency.update');
  });

  /*
   * A scoped capability with nothing named is refused under R-AU4 before the charter is consulted
   * at all, so every request has to carry the project, the repository and the branch.
   */
  it('names the project, the repository and the branch on every request', () => {
    const requests = missionCapabilityRequests({
      type: 'code_change',
      plan: PLAN,
      projectId: 'project-1',
      repository: 'owner/repo',
      branch: 'jarvis/change',
      reason: 'because the plan said so',
    });
    expect(requests.length).toBeGreaterThan(0);
    for (const entry of requests) {
      expect(entry.projectId).toBe('project-1');
      expect(entry.repository).toBe('owner/repo');
      expect(entry.branch).toBe('jarvis/change');
    }
  });
});

describe('coverage', () => {
  it('accepts an authorisation that covers everything', () => {
    const needed = missionCapabilityClasses({ type: 'code_change', plan: PLAN });
    expect(coversPlan({ authorised: needed, type: 'code_change', plan: PLAN })).toBeNull();
  });

  it('accepts an authorisation that covers more than enough', () => {
    const needed = missionCapabilityClasses({ type: 'code_change', plan: PLAN });
    expect(
      coversPlan({ authorised: [...needed, 'testflight.dispatch'], type: 'code_change', plan: PLAN }),
    ).toBeNull();
  });

  /* Permission to read a repository is not permission to rewrite one. */
  it('refuses permission to read as though it were permission to write', () => {
    const gap = coversPlan({
      authorised: ['repository.audit'],
      type: 'code_change',
      plan: PLAN,
    });
    expect(gap).not.toBeNull();
    expect(gap?.missing).toContain('code.change');
    expect(gap?.missing).toContain('pull_request.open');
  });

  it('names every missing capability, not the first', () => {
    const gap = coversPlan({ authorised: [], type: 'bug_fix', plan: PLAN });
    expect(gap?.missing.length).toBeGreaterThan(2);
    for (const capability of gap?.missing ?? []) {
      expect(gap?.reason).toContain(capability);
    }
  });

  it('refuses an empty authorisation for work that needs anything at all', () => {
    expect(coversPlan({ authorised: [], type: 'research_report', plan: null })).not.toBeNull();
  });
});
