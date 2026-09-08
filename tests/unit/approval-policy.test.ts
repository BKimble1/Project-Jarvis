import { describe, expect, it } from 'vitest';

import {
  APPROVAL_CATEGORIES,
  APPROVAL_CATEGORY_INFO,
  CAUTIOUS_APPROVAL_POLICY,
  categoriesForWork,
  decideAutoApproval,
  outstandingApprovals,
  parseApprovalPolicy,
  requiresOwnerApproval,
  type ApprovalPolicy,
} from '@/domain/approval-policy';

/**
 * What Jarvis may do without asking.
 *
 * These rules decide whether a merge happens while the owner is asleep, so the tests are written
 * from the failure end: what would have to be true for something irreversible to proceed unasked.
 */
describe('the approval policy', () => {
  const permissive: ApprovalPolicy = {
    preAuthorised: [...APPROVAL_CATEGORIES],
    autoApproveRoutinePlans: true,
  };

  it('starts by asking about everything', () => {
    for (const category of APPROVAL_CATEGORIES) {
      expect(requiresOwnerApproval(category, CAUTIOUS_APPROVAL_POLICY), category).toBe(true);
    }
    expect(CAUTIOUS_APPROVAL_POLICY.autoApproveRoutinePlans).toBe(false);
  });

  it('says what pre-authorising each category actually permits', () => {
    for (const category of APPROVAL_CATEGORIES) {
      const info = APPROVAL_CATEGORY_INFO[category];
      expect(info.label, `${category} label`).toBeTruthy();
      expect(info.permits, `${category} permits`).toBeTruthy();
    }
    /* The three that cannot be undone are marked, so the interface can say so before he chooses. */
    expect(APPROVAL_CATEGORY_INFO.spend.irreversible).toBe(true);
    expect(APPROVAL_CATEGORY_INFO.credential_change.irreversible).toBe(true);
    expect(APPROVAL_CATEGORY_INFO.destructive_delete.irreversible).toBe(true);
    expect(APPROVAL_CATEGORY_INFO.merge.irreversible).toBe(false);
  });

  describe('reading a stored policy back', () => {
    it('never widens itself on rubbish', () => {
      /*
       * A settings row is not necessarily the shape it was written in. Every one of these must
       * come back cautious rather than permissive, because the failure mode of guessing
       * generously is a merge nobody approved.
       */
      for (const value of [null, undefined, 42, 'yes', [], { preAuthorised: 'all' }]) {
        expect(parseApprovalPolicy(value), String(value)).toEqual(CAUTIOUS_APPROVAL_POLICY);
      }
    });

    it('drops categories it does not recognise rather than keeping them', () => {
      const policy = parseApprovalPolicy({
        preAuthorised: ['merge', 'not_a_category', 'deploy', 'merge'],
        autoApproveRoutinePlans: true,
      });
      expect([...policy.preAuthorised].sort()).toEqual(['deploy', 'merge']);
      expect(policy.autoApproveRoutinePlans).toBe(true);
    });

    it('treats anything but true as not automatic', () => {
      expect(parseApprovalPolicy({ autoApproveRoutinePlans: 'true' }).autoApproveRoutinePlans).toBe(
        false,
      );
      expect(parseApprovalPolicy({ autoApproveRoutinePlans: 1 }).autoApproveRoutinePlans).toBe(
        false,
      );
    });
  });

  describe('reading what a piece of work would do', () => {
    it('notices the things that need a person', () => {
      expect(categoriesForWork({ text: 'Merge the pull request into main' })).toContain('merge');
      expect(categoriesForWork({ text: 'Deploy it to production' })).toContain('deploy');
      expect(categoriesForWork({ text: 'Publish a version to npm' })).toContain('release');
      expect(categoriesForWork({ text: 'Delete the repository' })).toContain('destructive_delete');
      expect(categoriesForWork({ text: 'Send an email to the customer' })).toContain(
        'external_message',
      );
      expect(categoriesForWork({ text: 'Rotate the token' })).toContain('credential_change');
    });

    it('leaves ordinary building work alone', () => {
      /*
       * The whole point. Creating a project, a branch, tests, docs and a draft pull request is the
       * work, not a decision about the work — and a system that asks about each has delegated
       * nothing.
       */
      const routine = categoriesForWork({
        text:
          'Create the project and a private repository, add a branch, write the first version ' +
          'with tests and documentation, run the checks and open a draft pull request.',
      });
      expect(routine).toEqual([]);
    });

    it('does not read a promise of restraint as an intention', () => {
      /*
       * The bug this pins: a deterministic plan says it will stop at a draft pull request, and says
       * so using the words "merge" and "deploy". Reading those as intent is the same mistake that
       * once named a project after the sentence forbidding it.
       */
      expect(
        categoriesForWork({
          text: 'Delivered as a draft pull request for your review before anything merges.',
        }),
      ).toEqual([]);
      expect(
        categoriesForWork({ text: 'This will not deploy, publish or release anything.' }),
      ).toEqual([]);
      expect(categoriesForWork({ text: 'Never delete the repository.' })).toEqual([]);
      /* And still catches the sentence that means it. */
      expect(categoriesForWork({ text: 'Merge it into main when the checks pass.' })).toContain(
        'merge',
      );
    });

    it('takes the facts it cannot read from prose as facts', () => {
      expect(categoriesForWork({ text: 'anything', outsideBoundary: true })).toContain(
        'outside_boundary',
      );
      expect(categoriesForWork({ text: 'anything', spends: true })).toContain('spend');
    });
  });

  describe('deciding whether to proceed unasked', () => {
    it('does nothing automatically until the owner turns it on', () => {
      const decision = decideAutoApproval({
        policy: CAUTIOUS_APPROVAL_POLICY,
        categories: [],
        riskLevel: 'low',
      });
      expect(decision.approve).toBe(false);
      expect(decision.reason).toBeTruthy();
    });

    it('lets low-risk work through once it is on', () => {
      const decision = decideAutoApproval({
        policy: { preAuthorised: [], autoApproveRoutinePlans: true },
        categories: [],
        riskLevel: 'low',
      });
      expect(decision.approve).toBe(true);
    });

    it('still stops for anything above low risk, however permissive the policy', () => {
      for (const riskLevel of ['moderate', 'high', 'prohibited'] as const) {
        const decision = decideAutoApproval({ policy: permissive, categories: [], riskLevel });
        expect(decision.approve, riskLevel).toBe(false);
        expect(decision.reason, riskLevel).toContain(riskLevel.replace(/_/g, ' '));
      }
    });

    it('stops for a category the owner has not pre-authorised, and names it', () => {
      const decision = decideAutoApproval({
        policy: { preAuthorised: ['deploy'], autoApproveRoutinePlans: true },
        categories: ['deploy', 'merge'],
        riskLevel: 'low',
      });
      expect(decision.approve).toBe(false);
      expect(decision.reason.toLowerCase()).toContain('merge');
      /* And does not complain about the one he did authorise. */
      expect(decision.reason.toLowerCase()).not.toContain('deploy');
    });

    it('proceeds when every category it would touch was pre-authorised', () => {
      const decision = decideAutoApproval({
        policy: { preAuthorised: ['merge', 'deploy'], autoApproveRoutinePlans: true },
        categories: ['merge'],
        riskLevel: 'low',
      });
      expect(decision.approve).toBe(true);
    });

    it('gives a reason whichever way it goes', () => {
      const refused = decideAutoApproval({
        policy: CAUTIOUS_APPROVAL_POLICY,
        categories: ['merge'],
        riskLevel: 'low',
      });
      const allowed = decideAutoApproval({
        policy: permissive,
        categories: ['merge'],
        riskLevel: 'low',
      });
      expect(refused.reason).toBeTruthy();
      expect(allowed.reason).toBeTruthy();
    });
  });

  it('reports what is outstanding in a stable order', () => {
    const outstanding = outstandingApprovals(['deploy', 'merge', 'spend'], {
      preAuthorised: ['merge'],
      autoApproveRoutinePlans: true,
    });
    /* Declaration order, not call order, so the same set always reads the same way. */
    expect(outstanding).toEqual(['deploy', 'spend']);
  });
});
