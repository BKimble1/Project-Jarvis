import { describe, expect, it } from 'vitest';
import {
  activeOpenPullRequests,
  assessProject,
  computeFreshness,
  deriveStatus,
  failingWorkflows,
  fingerprint,
  latestWorkflowStates,
  recentCommits,
  recentReleases,
  recentlyMergedPullRequests,
  staleOpenPullRequests,
  type AssessmentInput,
} from '@/server/status/engine';
import {
  FAILING_CONCLUSIONS,
  NEUTRAL_CONCLUSIONS,
  STATUS_WINDOWS,
} from '@/server/status/constants';
import type { Claim, Evidence } from '@/domain/evidence';
import type { GithubSourceState, ProjectAggregate } from '@/domain/project';
import type { ProjectStatus } from '@/domain/enums';
import type { AttentionReason, ProjectAssessment, RecommendedAction } from '@/domain/status';
import {
  NOW,
  daysBefore,
  hoursBefore,
  makeAggregate,
  makeBlocker,
  makeEvidence,
  makeGoal,
  makeMergedPr,
  makeMilestone,
  makeNextAction,
  makeOpenPr,
  makeProject,
  makeSource,
  makeUpdate,
  makeWorkflowRun,
} from '../helpers/factories';

const inputFor = (
  aggregate: ProjectAggregate,
  evidence: readonly Evidence[] = [],
  now: Date = NOW,
): AssessmentInput => ({ aggregate, evidence, now });

const assess = (
  aggregate: ProjectAggregate,
  evidence: readonly Evidence[] = [],
  now: Date = NOW,
): ProjectAssessment => assessProject(inputFor(aggregate, evidence, now));

const githubState = (overrides: Partial<GithubSourceState> = {}): GithubSourceState => ({
  repoId: 1,
  owner: 'owner',
  repo: 'aurora',
  url: 'https://github.com/owner/aurora',
  visibility: 'private',
  defaultBranch: 'main',
  archived: false,
  primaryLanguage: 'TypeScript',
  lastActivityAt: hoursBefore(4),
  ...overrides,
});

/* Lookups that fail loudly: a missing rule must read as "rule never fired", not as `undefined`. */
function requireReason(
  assessment: ProjectAssessment,
  code: AttentionReason['code'],
): AttentionReason {
  const found = assessment.attention.find((reason) => reason.code === code);
  if (!found) {
    throw new Error(`No attention reason "${code}" in ${JSON.stringify(assessment.attention)}`);
  }
  return found;
}

function requireAction(assessment: ProjectAssessment, rule: string): RecommendedAction {
  const found = assessment.recommendedActions.find((action) => action.rule === rule);
  if (!found) {
    throw new Error(
      `No recommended action "${rule}" in ${JSON.stringify(assessment.recommendedActions)}`,
    );
  }
  return found;
}

function requireClaim(claims: readonly Claim[], rule: string): Claim {
  const found = claims.find((item) => item.rule === rule);
  if (!found) throw new Error(`No claim "${rule}" in ${JSON.stringify(claims)}`);
  return found;
}

const codes = (assessment: ProjectAssessment): readonly string[] =>
  assessment.attention.map((reason) => reason.code);
const actionRules = (assessment: ProjectAssessment): readonly string[] =>
  assessment.recommendedActions.map((action) => action.rule);
const claimRules = (claims: readonly Claim[]): readonly string[] =>
  claims.map((item) => item.rule ?? '(no rule)');

/* ------------------------------------------------------------------- status */

describe('deriveStatus', () => {
  it('reports an archived project as archived on the owner’s authority (R-ST1)', () => {
    const aggregate = makeAggregate({
      project: makeProject({ status: 'active', archivedAt: daysBefore(5) }),
      sources: [makeSource()],
    });

    expect(deriveStatus(inputFor(aggregate))).toEqual({
      status: 'archived',
      provenance: 'manual',
      rule: 'R-ST1-archived-project',
    });
  });

  it('reports a project as archived when GitHub says the repository is archived (R-ST2)', () => {
    const aggregate = makeAggregate({
      project: makeProject({ status: 'active' }),
      sources: [makeSource({ github: githubState({ archived: true }) })],
    });

    expect(deriveStatus(inputFor(aggregate))).toEqual({
      status: 'archived',
      provenance: 'verified',
      rule: 'R-ST2-archived-repository',
    });
  });

  it.each<ProjectStatus>(['completed', 'paused', 'archived'])(
    'never overrides the owner-declared terminal state "%s" with evidence (R-ST3)',
    (status) => {
      const aggregate = makeAggregate({
        project: makeProject({ status }),
        sources: [makeSource()],
        blockers: [makeBlocker({ isActive: true, requiresOwnerDecision: true })],
      });
      const evidence = [makeWorkflowRun('failure'), makeEvidence({ observedAt: hoursBefore(3) })];

      expect(deriveStatus(inputFor(aggregate, evidence))).toEqual({
        status,
        provenance: 'manual',
        rule: 'R-ST3-owner-declared-terminal-state',
      });
    },
  );

  it('infers "blocked" from an active blocker and labels the inference (R-ST4)', () => {
    const aggregate = makeAggregate({
      project: makeProject({ status: 'active' }),
      blockers: [
        makeBlocker({ isActive: false, title: 'Already resolved' }),
        makeBlocker({ isActive: true, title: 'Waiting on the design review' }),
      ],
    });

    expect(deriveStatus(inputFor(aggregate))).toEqual({
      status: 'blocked',
      provenance: 'inferred',
      rule: 'R-ST4-active-blocker-implies-blocked',
    });
  });

  it('does not infer "blocked" when every blocker is resolved', () => {
    const aggregate = makeAggregate({
      project: makeProject({ status: 'active' }),
      blockers: [makeBlocker({ isActive: false, resolvedAt: daysBefore(1) })],
    });

    expect(deriveStatus(inputFor(aggregate))).toEqual({
      status: 'active',
      provenance: 'manual',
      rule: 'R-ST6-owner-declared-status',
    });
  });

  it('leaves a stored "unknown" status unknown rather than guessing (R-ST5)', () => {
    const aggregate = makeAggregate({ project: makeProject({ status: 'unknown' }) });

    expect(deriveStatus(inputFor(aggregate))).toEqual({
      status: 'unknown',
      provenance: 'unknown',
      rule: 'R-ST5-no-status-recorded',
    });
  });
});

describe('paused projects', () => {
  it('is never described as progressing, however much evidence arrives', () => {
    const aggregate = makeAggregate({
      project: makeProject({ status: 'paused', name: 'Aurora' }),
      sources: [makeSource()],
      milestones: [makeMilestone({ state: 'in_progress', title: 'Second release' })],
    });
    const evidence = [
      makeEvidence({ title: 'Tidy the router', observedAt: hoursBefore(4) }),
      makeOpenPr(),
    ];

    const assessment = assess(aggregate, evidence);

    expect(assessment.status).toBe('paused');
    expect(assessment.statusProvenance).toBe('manual');
    expect(claimRules(assessment.currentWork)).toEqual(['R-CW0-paused-not-progressing']);
    expect(assessment.currentWork[0]?.text).toBe(
      'Paused — no work is expected until you resume it.',
    );
    expect(assessment.headline.rule).toBe('R-HL3-paused');
    expect(assessment.headline.text).toBe('Aurora is paused; no work is expected right now.');
  });

  it('does not raise stale-data attention on a project the owner deliberately paused', () => {
    const aggregate = makeAggregate({
      project: makeProject({ status: 'paused', lastManualUpdateAt: daysBefore(40) }),
      sources: [makeSource({ lastSyncOkAt: daysBefore(40) })],
    });

    const assessment = assess(aggregate);

    expect(assessment.freshness.state).toBe('stale');
    expect(codes(assessment)).toEqual([]);
    expect(assessment.needsAttention).toBe(false);
  });
});

describe('completed and archived projects', () => {
  it('receives wrap-up advice only, never ordinary development advice (R-RC6)', () => {
    const aggregate = makeAggregate({
      project: makeProject({ status: 'completed' }),
      sources: [makeSource()],
      blockers: [makeBlocker({ isActive: true, title: 'Flaky end-to-end test' })],
      nextActions: [makeNextAction({ action: 'Write the release notes', status: 'open' })],
    });
    const evidence = [makeWorkflowRun('failure'), makeOpenPr({ observedAt: daysBefore(40) })];

    const assessment = assess(aggregate, evidence);

    expect(actionRules(assessment)).toEqual(['R-RC6-completed-project-wrap-up-only']);
    expect(assessment.recommendedActions[0]?.action).toBe(
      'Close out 1 remaining action or archive the project.',
    );
    expect(assessment.recommendedActions[0]?.requiresOwner).toBe(true);
    expect(assessment.headline.rule).toBe('R-HL2-completed');
    /* The contradicting evidence was present: the rule suppressed advice, not data. */
    expect(codes(assessment)).toContain('failed_workflow');
  });

  it('suggests archiving a completed project with nothing outstanding (R-RC6)', () => {
    const aggregate = makeAggregate({
      project: makeProject({ status: 'completed' }),
      nextActions: [makeNextAction({ status: 'done', completedAt: daysBefore(1) })],
    });

    const assessment = assess(aggregate);

    expect(actionRules(assessment)).toEqual(['R-RC6-completed-project-wrap-up-only']);
    expect(assessment.recommendedActions[0]?.action).toBe(
      'Archive this project to keep the portfolio focused.',
    );
  });

  it('offers an archived project only the confirm-or-restore choice (R-RC7)', () => {
    const aggregate = makeAggregate({
      project: makeProject({ status: 'active', archivedAt: daysBefore(2) }),
      sources: [makeSource()],
      nextActions: [makeNextAction({ action: 'Ship the migration' })],
    });

    const assessment = assess(aggregate, [makeWorkflowRun('failure')]);

    expect(actionRules(assessment)).toEqual(['R-RC7-archived-no-development-advice']);
    expect(assessment.recommendedActions[0]?.action).toBe(
      'Confirm this project is finished, or restore it if work is resuming.',
    );
    expect(assessment.headline.rule).toBe('R-HL1-archived');
  });
});

/* ---------------------------------------------------------------- workflows */

describe('latestWorkflowStates (R-WF1)', () => {
  it('keeps only the newest run per workflow name', () => {
    const olderCi = makeWorkflowRun('failure', { observedAt: daysBefore(3) });
    const newerCi = makeWorkflowRun('success', { observedAt: daysBefore(1) });
    const deploy = makeWorkflowRun('success', {
      observedAt: daysBefore(2),
      metadata: {
        runId: 9,
        workflowName: 'Deploy',
        status: 'completed',
        conclusion: 'success',
        isDefaultBranch: true,
      },
    });

    /* Deliberately unordered input: the rule sorts by observation time, it does not trust order. */
    const states = latestWorkflowStates([newerCi, deploy, olderCi]);

    expect([...states].map((state) => state.name).sort()).toEqual(['CI', 'Deploy']);
    const ci = states.find((state) => state.name === 'CI');
    expect(ci?.conclusion).toBe('success');
    expect(ci?.evidenceId).toBe(newerCi.id);
  });

  it('ignores evidence that is not a workflow run', () => {
    const states = latestWorkflowStates([
      makeEvidence(),
      makeMergedPr(),
      makeWorkflowRun('success'),
    ]);

    expect(states).toHaveLength(1);
    expect(states[0]?.name).toBe('CI');
  });
});

describe('failingWorkflows (R-WF2)', () => {
  it('does not report a failure that a later successful run replaced', () => {
    const failed = makeWorkflowRun('failure', { observedAt: daysBefore(3) });
    const succeeded = makeWorkflowRun('success', { observedAt: daysBefore(1) });

    expect(failingWorkflows([failed, succeeded], NOW)).toEqual([]);
  });

  it('does not raise an alarm for a failure older than the window', () => {
    const stale = makeWorkflowRun('failure', {
      observedAt: daysBefore(STATUS_WINDOWS.failedWorkflowDays + 1),
    });

    expect(latestWorkflowStates([stale])).toHaveLength(1);
    expect(failingWorkflows([stale], NOW)).toEqual([]);
  });

  it('still reports a failure sitting exactly on the window boundary', () => {
    const edge = makeWorkflowRun('failure', {
      observedAt: daysBefore(STATUS_WINDOWS.failedWorkflowDays),
    });

    expect(failingWorkflows([edge], NOW).map((state) => state.evidenceId)).toEqual([edge.id]);
  });

  it('treats cancelled and skipped conclusions as neutral, not as failures', () => {
    expect(FAILING_CONCLUSIONS.has('cancelled')).toBe(false);
    expect(NEUTRAL_CONCLUSIONS.has('cancelled')).toBe(true);
    expect(failingWorkflows([makeWorkflowRun('cancelled')], NOW)).toEqual([]);
    expect(failingWorkflows([makeWorkflowRun('timed_out')], NOW)).toHaveLength(1);
  });
});

describe('failing workflows in an assessment (R-AT3 / R-RC2 / R-BL2)', () => {
  it('drives an attention reason, a recommended action and a blocker claim', () => {
    const run = makeWorkflowRun('failure', { observedAt: hoursBefore(5) });
    const aggregate = makeAggregate({
      project: makeProject({ status: 'active' }),
      sources: [makeSource()],
    });

    const assessment = assess(aggregate, [run]);

    const reason = requireReason(assessment, 'failed_workflow');
    expect(reason.rule).toBe('R-AT3-recent-failed-workflow');
    expect(reason.severity).toBe('high');
    expect(reason.provenance).toBe('verified');
    expect(reason.evidenceIds).toEqual([run.id]);
    expect(reason.summary).toBe('CI failed 5 hours ago');

    const action = requireAction(assessment, 'R-RC2-fix-failing-build');
    expect(action.action).toBe('Fix the failing CI workflow.');
    expect(action.rationale).toBe('The most recent CI run concluded "failure".');
    expect(action.provenance).toBe('verified');
    expect(action.evidenceIds).toEqual([run.id]);
    expect(action.requiresOwner).toBe(false);

    const blocker = requireClaim(assessment.activeBlockers, 'R-BL2-failing-workflow-as-blocker');
    expect(blocker.text).toBe('CI is failing on GitHub Actions.');
    expect(blocker.provenance).toBe('verified');
  });

  it('lowers the severity when the failure is not on the default branch', () => {
    const run = makeWorkflowRun('failure', {
      observedAt: hoursBefore(5),
      metadata: {
        runId: 4,
        workflowName: 'Nightly',
        status: 'completed',
        conclusion: 'failure',
        isDefaultBranch: false,
      },
    });

    const assessment = assess(makeAggregate({ sources: [makeSource()] }), [run]);

    expect(requireReason(assessment, 'failed_workflow').severity).toBe('medium');
  });
});

/* ------------------------------------------------------------ pull requests */

describe('recentlyMergedPullRequests (R-PR1)', () => {
  it('counts a merged pull request inside the window as verified completed work', () => {
    const pr = makeMergedPr({ observedAt: daysBefore(2), title: '#7 Evidence timeline' });
    const aggregate = makeAggregate({ sources: [makeSource()] });

    expect(recentlyMergedPullRequests([pr], NOW).map((item) => item.id)).toEqual([pr.id]);

    const assessment = assess(aggregate, [pr]);
    const completed = requireClaim(
      assessment.recentlyCompleted,
      'R-PR1-merged-pr-is-completed-work',
    );
    expect(completed.text).toBe('Merged #7 Evidence timeline');
    expect(completed.provenance).toBe('verified');
    expect(completed.evidenceIds).toEqual([pr.id]);
    expect(assessment.keyEvidenceIds).toContain(pr.id);
  });

  it('drops a merged pull request older than the recent window', () => {
    const old = makeMergedPr({
      observedAt: daysBefore(STATUS_WINDOWS.recentlyCompletedDays + 1),
    });

    expect(recentlyMergedPullRequests([old], NOW)).toEqual([]);
    expect(assess(makeAggregate({ sources: [makeSource()] }), [old]).recentlyCompleted).toEqual([]);
  });

  it('ignores an open pull request that has not been merged', () => {
    expect(recentlyMergedPullRequests([makeOpenPr()], NOW)).toEqual([]);
  });
});

describe('open pull requests (R-PR2 / R-RC5)', () => {
  it('treats a recently touched open pull request as work in progress', () => {
    const pr = makeOpenPr({ observedAt: daysBefore(1), title: '#12 Status engine' });

    expect(activeOpenPullRequests([pr], NOW).map((item) => item.id)).toEqual([pr.id]);
    expect(staleOpenPullRequests([pr], NOW)).toEqual([]);

    const assessment = assess(makeAggregate({ sources: [makeSource()] }), [pr]);
    const claim = requireClaim(assessment.currentWork, 'R-PR2-active-open-pr');
    expect(claim.text).toBe('Open pull request #12 Status engine');
    expect(claim.provenance).toBe('verified');
    expect(claim.evidenceIds).toEqual([pr.id]);
  });

  it('does not treat a long-untouched open pull request as evidence of active work', () => {
    const pr = makeOpenPr({
      observedAt: daysBefore(STATUS_WINDOWS.openPrActiveDays + 16),
      title: '#3 Import flow',
    });

    expect(activeOpenPullRequests([pr], NOW)).toEqual([]);
    expect(staleOpenPullRequests([pr], NOW).map((item) => item.id)).toEqual([pr.id]);

    const assessment = assess(makeAggregate({ sources: [makeSource()] }), [pr]);
    expect(claimRules(assessment.currentWork)).not.toContain('R-PR2-active-open-pr');

    const action = requireAction(assessment, 'R-RC5-stalled-pull-requests');
    expect(action.action).toBe('Review or close the stalled pull request #3 Import flow');
    expect(action.rationale).toBe('Open for more than 14 days with no update.');
    expect(action.provenance).toBe('verified');
    expect(action.evidenceIds).toEqual([pr.id]);
  });

  it('does not treat a draft pull request as active work', () => {
    const draft = makeOpenPr({
      observedAt: daysBefore(1),
      metadata: { number: 20, state: 'open', merged: false, draft: true },
    });

    expect(activeOpenPullRequests([draft], NOW)).toEqual([]);
  });
});

/* ------------------------------------------------------------- milestones */

describe('milestone completion (R-MS1)', () => {
  it('keeps an owner-ticked milestone at manual provenance', () => {
    const aggregate = makeAggregate({
      milestones: [
        makeMilestone({ title: 'Schema frozen', state: 'done', completedAt: daysBefore(3) }),
      ],
    });

    const claim = requireClaim(
      assess(aggregate).recentlyCompleted,
      'R-MS1-manual-milestone-stays-manual',
    );
    expect(claim.text).toBe('Milestone completed: Schema frozen');
    expect(claim.provenance).toBe('manual');
    expect(claim.evidenceIds).toEqual([]);
  });

  it('upgrades the same milestone to verified once evidence backs it', () => {
    const pr = makeMergedPr({ observedAt: daysBefore(3) });
    const aggregate = makeAggregate({
      milestones: [
        makeMilestone({
          title: 'Schema frozen',
          state: 'done',
          completedAt: daysBefore(3),
          evidenceIds: [pr.id],
        }),
      ],
    });

    const claim = requireClaim(
      assess(aggregate, [pr]).recentlyCompleted,
      'R-MS1-manual-milestone-stays-manual',
    );
    expect(claim.provenance).toBe('verified');
    expect(claim.evidenceIds).toEqual([pr.id]);
  });

  it('ignores a milestone that is done but was never given a completion time', () => {
    const aggregate = makeAggregate({
      milestones: [makeMilestone({ state: 'done', completedAt: null })],
    });

    expect(assess(aggregate).recentlyCompleted).toEqual([]);
  });
});

/* ------------------------------------------------------------ current work */

describe('current work', () => {
  it('summarises commits inside the active window and ignores older ones (R-CW1)', () => {
    const newest = makeEvidence({ title: 'Add the parser', observedAt: hoursBefore(3) });
    const middle = makeEvidence({ title: 'Tidy the router', observedAt: daysBefore(2) });
    const oldest = makeEvidence({ title: 'Rename the module', observedAt: daysBefore(6) });
    const outside = makeEvidence({
      title: 'Initial commit',
      observedAt: daysBefore(STATUS_WINDOWS.activeCommitDays + 3),
    });
    const evidence = [middle, outside, newest, oldest];

    expect(recentCommits(evidence, NOW).map((item) => item.id)).toEqual([
      newest.id,
      middle.id,
      oldest.id,
    ]);

    const assessment = assess(makeAggregate({ sources: [makeSource()] }), evidence);
    const claim = requireClaim(assessment.currentWork, 'R-CW1-recent-commits');
    expect(claim.text).toBe('3 commits in the last 7 days, most recently "Add the parser"');
    expect(claim.provenance).toBe('verified');
    expect(claim.evidenceIds).toEqual([newest.id, middle.id, oldest.id]);
    expect(assessment.headline.rule).toBe('R-HL8-progressing');
  });

  it('reports an in-progress milestone as manual work, not verified progress (R-CW2)', () => {
    const aggregate = makeAggregate({
      milestones: [
        makeMilestone({
          title: 'Status brain',
          state: 'in_progress',
          evidenceIds: ['evidence-notes'],
        }),
      ],
    });

    const claim = requireClaim(assess(aggregate).currentWork, 'R-CW2-in-progress-milestone');
    expect(claim.text).toBe('Working on milestone: Status brain');
    /* The owner ticking "in progress" is a statement, not an observation. */
    expect(claim.provenance).toBe('manual');
    expect(claim.evidenceIds).toEqual(['evidence-notes']);
  });

  it('repeats the owner’s own account of current work as a manual claim (R-CW3)', () => {
    const aggregate = makeAggregate({
      updates: [makeUpdate({ currentWork: 'Rewriting the sync loop', createdAt: daysBefore(1) })],
    });

    const claim = requireClaim(assess(aggregate).currentWork, 'R-CW3-owner-reported-current-work');
    expect(claim.text).toBe('Rewriting the sync loop');
    expect(claim.provenance).toBe('manual');
    expect(claim.evidenceIds).toEqual([]);
  });

  it('does not repeat an owner update that is older than the recent window (R-CW3)', () => {
    const aggregate = makeAggregate({
      updates: [
        makeUpdate({
          currentWork: 'Rewriting the sync loop',
          createdAt: daysBefore(STATUS_WINDOWS.recentlyCompletedDays + 1),
        }),
      ],
    });

    expect(claimRules(assess(aggregate).currentWork)).toEqual([]);
  });
});

describe('recently completed work', () => {
  it('counts a published release and ignores a draft (R-RL1)', () => {
    const released = makeEvidence({
      kind: 'release',
      title: 'v1.2.0',
      observedAt: daysBefore(3),
      metadata: { tag: 'v1.2.0', draft: false },
    });
    const draft = makeEvidence({
      kind: 'release',
      title: 'v1.3.0-rc1',
      observedAt: daysBefore(1),
      metadata: { tag: 'v1.3.0-rc1', draft: true },
    });
    const evidence = [released, draft];

    expect(recentReleases(evidence, NOW).map((item) => item.id)).toEqual([released.id]);

    const claim = requireClaim(
      assess(makeAggregate({ sources: [makeSource()] }), evidence).recentlyCompleted,
      'R-RL1-release-is-completed-work',
    );
    expect(claim.text).toBe('Released v1.2.0');
    expect(claim.provenance).toBe('verified');
    expect(claim.evidenceIds).toEqual([released.id]);
  });

  it('keeps an owner-written update at manual provenance with no evidence to cite (R-MU1)', () => {
    const aggregate = makeAggregate({
      updates: [
        makeUpdate({ whatChanged: 'Rewrote the onboarding copy.', createdAt: daysBefore(1) }),
      ],
    });

    const claim = requireClaim(
      assess(aggregate).recentlyCompleted,
      'R-MU1-manual-update-is-manual',
    );
    expect(claim.text).toBe('Rewrote the onboarding copy.');
    expect(claim.provenance).toBe('manual');
    expect(claim.evidenceIds).toEqual([]);
  });
});

describe('active blocker claims (R-BL1)', () => {
  it('joins the title and description and stays manual', () => {
    const aggregate = makeAggregate({
      blockers: [
        makeBlocker({
          title: 'Vendor API is down',
          description: 'Support ticket 4412 is open.',
          evidenceIds: ['evidence-ticket'],
        }),
        makeBlocker({ title: 'Resolved last week', isActive: false }),
      ],
    });

    const assessment = assess(aggregate);

    expect(claimRules(assessment.activeBlockers)).toEqual(['R-BL1-active-blocker']);
    expect(assessment.activeBlockers[0]?.text).toBe(
      'Vendor API is down — Support ticket 4412 is open.',
    );
    expect(assessment.activeBlockers[0]?.provenance).toBe('manual');
    expect(assessment.activeBlockers[0]?.evidenceIds).toEqual(['evidence-ticket']);
    expect(assessment.headline.rule).toBe('R-HL4-blocked');
    expect(assessment.headline.text).toBe('Aurora is blocked by 1 open item.');
  });
});

/* -------------------------------------------------------- recommendations */

describe('recommended actions', () => {
  it('suggests clearing at most two blockers that do not need a decision (R-RC3)', () => {
    const aggregate = makeAggregate({
      blockers: [
        makeBlocker({ title: 'First', resolutionRequirement: 'Upgrade the runtime.' }),
        makeBlocker({ title: 'Second' }),
        makeBlocker({ title: 'Third' }),
      ],
    });

    const clearing = assess(aggregate).recommendedActions.filter(
      (action) => action.rule === 'R-RC3-clear-active-blocker',
    );

    expect(clearing.map((action) => action.action)).toEqual([
      'Clear the blocker: First',
      'Clear the blocker: Second',
    ]);
    expect(clearing[0]?.rationale).toBe('Upgrade the runtime.');
    expect(clearing[1]?.rationale).toBe('This blocker is still open.');
    expect(clearing[0]?.requiresOwner).toBe(false);
  });

  it('puts the owner’s own next actions ahead of anything Jarvis would invent (R-RC4)', () => {
    const aggregate = makeAggregate({
      nextActions: [
        makeNextAction({ action: 'Write the migration', dueDate: '2025-06-20' }),
        makeNextAction({ action: 'Review the schema', status: 'in_progress', requiresOwner: true }),
        makeNextAction({ action: 'Book the review call' }),
        makeNextAction({ action: 'Fourth action, dropped by the cap' }),
        makeNextAction({ action: 'Already finished', status: 'done' }),
      ],
    });

    const owned = assess(aggregate).recommendedActions.filter(
      (action) => action.rule === 'R-RC4-owner-next-action',
    );

    expect(owned.map((action) => action.action)).toEqual([
      'Write the migration',
      'Review the schema',
      'Book the review call',
    ]);
    expect(owned[0]?.rationale).toBe('You planned this for 2025-06-20.');
    expect(owned[1]?.rationale).toBe('On your next-action list.');
    expect(owned[1]?.requiresOwner).toBe(true);
    expect(owned[0]?.provenance).toBe('manual');
  });

  it('asks for a goal when there is nothing else to say and none is recorded (R-RC10)', () => {
    const aggregate = makeAggregate({ project: makeProject({ goal: null }) });

    const assessment = assess(aggregate);

    expect(actionRules(assessment)).toEqual(['R-RC10-missing-goal']);
    expect(assessment.recommendedActions[0]?.action).toBe('Write down the goal for this project.');
    expect(assessment.recommendedActions[0]?.rationale).toBe(
      'Jarvis has no recorded goal, so it cannot judge progress.',
    );
    expect(assessment.recommendedActions[0]?.provenance).toBe('unknown');
  });

  it('does not ask for a goal that has already been recorded as a goal record (R-RC10)', () => {
    const aggregate = makeAggregate({
      project: makeProject({ goal: null }),
      goals: [makeGoal({ statement: 'Ship the first usable version.' })],
    });

    expect(actionRules(assess(aggregate))).toEqual([]);
  });

  it('caps the list at six so the owner is given a shortlist, not a backlog', () => {
    const aggregate = makeAggregate({
      sources: [makeSource()],
      blockers: [
        makeBlocker({ title: 'Choose the provider', requiresOwnerDecision: true }),
        makeBlocker({ title: 'Vendor API is down' }),
        makeBlocker({ title: 'Flaky test' }),
      ],
      nextActions: [
        makeNextAction({ action: 'Write the migration' }),
        makeNextAction({ action: 'Review the schema' }),
        makeNextAction({ action: 'Book the review call' }),
      ],
    });
    const evidence = [
      makeWorkflowRun('failure', { observedAt: hoursBefore(4) }),
      makeOpenPr({ observedAt: daysBefore(40) }),
    ];

    expect(actionRules(assess(aggregate, evidence))).toEqual([
      'R-RC1-decision-blocker-first',
      'R-RC2-fix-failing-build',
      'R-RC3-clear-active-blocker',
      'R-RC3-clear-active-blocker',
      'R-RC4-owner-next-action',
      'R-RC4-owner-next-action',
    ]);
  });
});

/* --------------------------------------------------------------- headlines */

describe('headlines', () => {
  it('says the state is unknown when nothing has ever been recorded (R-HL6)', () => {
    const aggregate = makeAggregate({
      project: makeProject({ lastManualUpdateAt: null, lastSyncedAt: null }),
    });

    const assessment = assess(aggregate);

    expect(assessment.headline.rule).toBe('R-HL6-no-evidence');
    expect(assessment.headline.text).toBe(
      'Aurora has no recorded evidence yet, so its current state is unknown.',
    );
    expect(assessment.headline.provenance).toBe('unknown');
  });

  it('separates "shipped recently" from "working right now" (R-HL9)', () => {
    const assessment = assess(makeAggregate({ sources: [makeSource()] }), [
      makeMergedPr({ observedAt: daysBefore(5) }),
    ]);

    expect(assessment.currentWork).toEqual([]);
    expect(assessment.headline.rule).toBe('R-HL9-recent-completion-no-current-work');
    expect(assessment.headline.text).toBe(
      'Aurora shipped work recently but has nothing obviously in flight.',
    );
    expect(assessment.headline.provenance).toBe('inferred');
  });

  it('reports a waiting project as waiting on something external (R-HL10)', () => {
    const aggregate = makeAggregate({ project: makeProject({ status: 'waiting' }) });

    const assessment = assess(aggregate);

    expect(assessment.status).toBe('waiting');
    expect(assessment.headline.rule).toBe('R-HL10-waiting');
    expect(assessment.headline.text).toBe('Aurora is waiting on something external.');
  });

  it('admits it has no evidence rather than implying progress (R-HL11)', () => {
    const assessment = assess(makeAggregate({ project: makeProject({ shortName: 'AUR' }) }));

    expect(assessment.headline.rule).toBe('R-HL11-active-without-evidence');
    expect(assessment.headline.text).toBe(
      'AUR is active, but Jarvis has no evidence of work in progress.',
    );
    expect(assessment.headline.provenance).toBe('unknown');
  });
});

/* --------------------------------------------------------------- unknowns */

describe('unknowns (R-UK1..R-UK5)', () => {
  it('lists exactly what is missing instead of assuming a default', () => {
    const aggregate = makeAggregate({
      project: makeProject({ goal: null, phase: null, status: 'unknown' }),
    });

    const assessment = assess(aggregate);

    expect(assessment.unknowns).toEqual([
      'No goal has been recorded, so Jarvis cannot judge whether the project is on track.',
      'No phase has been recorded.',
      'The project status has not been set and no evidence implies one.',
    ]);
    expect(assessment.status).toBe('unknown');
    expect(assessment.statusProvenance).toBe('unknown');
    expect(assessment.phase).toBeNull();
    expect(assessment.phaseProvenance).toBe('unknown');
    expect(assessment.headline.provenance).toBe('unknown');
    expect(assessment.recentlyCompleted).toEqual([]);
    expect(assessment.currentWork).toEqual([]);
  });

  it('says build health and repository activity are unknown when a repo produced nothing', () => {
    const aggregate = makeAggregate({ sources: [makeSource()] });

    expect(assess(aggregate).unknowns).toEqual([
      'No GitHub Actions runs were found, so build health is unknown.',
      'No repository activity has been observed yet.',
    ]);
  });

  it('names the categories a partially readable source could not provide', () => {
    const aggregate = makeAggregate({
      sources: [
        makeSource({
          github: githubState({ owner: 'owner', repo: 'aurora' }),
          availableCapabilities: ['metadata', 'commits'],
          unavailableCapabilities: ['workflow_runs', 'releases'],
        }),
      ],
    });

    expect(assess(aggregate, [makeWorkflowRun('success')]).unknowns).toContain(
      'Jarvis could not read workflow_runs, releases for owner/aurora.',
    );
  });
});

/* --------------------------------------------- no invented numbers anywhere */

describe('no fabricated progress metrics', () => {
  /** Every numeric leaf in the assessment, so an invented score cannot slip in unnoticed. */
  function numericPaths(value: unknown, path = ''): readonly string[] {
    if (typeof value === 'number') return [path];
    if (Array.isArray(value)) {
      return value.flatMap((item, index) => numericPaths(item, `${path}[${index}]`));
    }
    if (value !== null && typeof value === 'object') {
      return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) =>
        numericPaths(child, path ? `${path}.${key}` : key),
      );
    }
    return [];
  }

  it('never reports a completion percentage or a health score', () => {
    const pr = makeMergedPr({ observedAt: daysBefore(2) });
    const openPr = makeOpenPr({ observedAt: daysBefore(1) });
    const commit = makeEvidence({ title: 'Add the diffing rules', observedAt: hoursBefore(6) });
    const aggregate = makeAggregate({
      project: makeProject({ status: 'active', targetDate: '2025-06-01' }),
      sources: [makeSource()],
      milestones: [
        makeMilestone({ state: 'done', completedAt: daysBefore(2), title: 'Schema frozen' }),
        makeMilestone({ state: 'in_progress', title: 'Status brain' }),
        makeMilestone({ state: 'planned', title: 'Launch' }),
      ],
      blockers: [makeBlocker({ isActive: true, requiresOwnerDecision: true })],
      nextActions: [makeNextAction({ action: 'Draft the release notes' })],
      updates: [makeUpdate({ createdAt: daysBefore(1) })],
    });

    const assessment = assess(aggregate, [pr, openPr, commit, makeWorkflowRun('success')]);
    const serialised = JSON.stringify(assessment);

    expect(serialised).not.toMatch(/\d+\s*%/);
    expect(serialised).not.toMatch(/percent/i);
    expect(serialised).not.toMatch(/\bscore\b/i);
    expect(serialised).not.toMatch(/\d+\s*(?:of|\/)\s*\d+\s*(?:done|complete)/i);
    /* The freshness age is an observation, not a judgement: it is the only number allowed. */
    expect(numericPaths(assessment)).toEqual(['freshness.ageHours']);
  });
});

/* ------------------------------------------------------------ sync failures */

describe('failed source synchronisation (R-AT4 / R-RC8)', () => {
  it('warns operationally without erasing verified evidence from a healthy source', () => {
    const healthy = makeSource({
      github: githubState({ owner: 'owner', repo: 'aurora' }),
      syncStatus: 'ok',
      lastSyncOkAt: hoursBefore(2),
    });
    const broken = makeSource({
      isPrimary: false,
      label: 'owner/legacy',
      github: githubState({ owner: 'owner', repo: 'legacy', repoId: 2 }),
      syncStatus: 'failed',
      lastSyncOkAt: daysBefore(3),
      lastSyncFailedAt: hoursBefore(1),
      lastSyncError: 'GitHub rejected the credential.',
    });
    const pr = makeMergedPr({
      sourceId: healthy.id,
      observedAt: daysBefore(2),
      fetchedAt: hoursBefore(2),
      title: '#7 Evidence timeline',
    });
    const aggregate = makeAggregate({
      project: makeProject({ status: 'active', lastManualUpdateAt: hoursBefore(3) }),
      sources: [healthy, broken],
    });

    const assessment = assess(aggregate, [pr]);

    expect(codes(assessment)).toEqual(['failed_sync']);
    const reason = requireReason(assessment, 'failed_sync');
    expect(reason.rule).toBe('R-AT4-source-sync-failed');
    expect(reason.severity).toBe('medium');
    expect(reason.provenance).toBe('verified');
    expect(reason.summary).toBe(
      'Could not synchronise owner/legacy. The information below may be out of date.',
    );

    const action = requireAction(assessment, 'R-RC8-recover-sync');
    expect(action.action).toBe('Re-run synchronisation and check the GitHub credential.');
    expect(action.requiresOwner).toBe(true);

    /* The whole point: last-known-good evidence from the healthy source survives the failure. */
    const completed = requireClaim(
      assessment.recentlyCompleted,
      'R-PR1-merged-pr-is-completed-work',
    );
    expect(completed.text).toBe('Merged #7 Evidence timeline');
    expect(completed.provenance).toBe('verified');
    expect(completed.evidenceIds).toEqual([pr.id]);

    expect(assessment.freshness.state).toBe('failing');
    expect(assessment.freshness.lastError).toBe('GitHub rejected the credential.');
    expect(assessment.headline.rule).toBe('R-HL5-sync-failing');
    expect(assessment.unknowns).toContain(
      'Anything that happened since the last successful synchronisation is unknown ' +
        '(GitHub rejected the credential.).',
    );
  });
});

/* -------------------------------------------------------------- attention */

describe('attention reasons', () => {
  it('raises a critical decision_required reason for a blocker awaiting the owner (R-AT1)', () => {
    const aggregate = makeAggregate({
      blockers: [
        makeBlocker({
          title: 'Choose the hosting provider',
          severity: 'medium',
          requiresOwnerDecision: true,
          resolutionRequirement: 'Compare the two quotes.',
          evidenceIds: ['evidence-quote'],
        }),
      ],
    });

    const assessment = assess(aggregate);

    const reason = requireReason(assessment, 'decision_required');
    expect(reason.rule).toBe('R-AT1-blocker-requires-owner-decision');
    /* A decision the owner owes the project outranks everything else, whatever its severity. */
    expect(reason.severity).toBe('critical');
    expect(reason.summary).toBe('Decision needed: Choose the hosting provider');
    expect(reason.provenance).toBe('manual');
    expect(reason.evidenceIds).toEqual(['evidence-quote']);

    const decision = requireClaim(assessment.decisionsNeeded, 'R-DC1-decision-blocker');
    expect(decision.text).toBe('Choose the hosting provider — Compare the two quotes.');
    expect(requireAction(assessment, 'R-RC1-decision-blocker-first').action).toBe(
      'Decide: Choose the hosting provider',
    );
  });

  it.each<['critical' | 'high' | 'medium' | 'low']>([['critical'], ['high'], ['medium'], ['low']])(
    'carries the blocker severity %s through to the active_blocker reason (R-AT2)',
    (severity) => {
      const aggregate = makeAggregate({
        blockers: [
          makeBlocker({ title: 'Vendor API is down', severity, requiresOwnerDecision: false }),
        ],
      });

      const reason = requireReason(assess(aggregate), 'active_blocker');
      expect(reason.rule).toBe('R-AT2-active-blocker');
      expect(reason.severity).toBe(severity);
      expect(reason.summary).toBe('Blocked: Vendor API is down');
    },
  );

  it('reports an overdue next action and escalates a critical one (R-AT6)', () => {
    const aggregate = makeAggregate({
      nextActions: [
        makeNextAction({ action: 'Send the invoice', dueDate: '2025-06-10', priority: 'medium' }),
        makeNextAction({ action: 'Renew the domain', dueDate: '2025-06-01', priority: 'critical' }),
      ],
    });

    const overdue = assess(aggregate).attention.filter(
      (reason) => reason.code === 'overdue_action',
    );

    expect(overdue.map((reason) => reason.rule)).toEqual([
      'R-AT6-overdue-next-action',
      'R-AT6-overdue-next-action',
    ]);
    expect(overdue[0]?.summary).toBe('Overdue since 2025-06-10: Send the invoice');
    expect(overdue[0]?.severity).toBe('medium');
    expect(overdue[1]?.severity).toBe('high');
    expect(overdue[0]?.provenance).toBe('manual');
  });

  it('does not call an action overdue on its due date, nor once it is done (R-AT6)', () => {
    const aggregate = makeAggregate({
      nextActions: [
        makeNextAction({ action: 'Due today', dueDate: '2025-06-15' }),
        makeNextAction({ action: 'Finished late', dueDate: '2025-06-01', status: 'done' }),
        makeNextAction({ action: 'Abandoned', dueDate: '2025-06-01', status: 'dropped' }),
      ],
    });

    expect(codes(assess(aggregate))).toEqual([]);
  });

  it('reports a target date that has passed on an unfinished project (R-AT7)', () => {
    const aggregate = makeAggregate({
      project: makeProject({ status: 'active', targetDate: '2025-06-01' }),
    });

    const assessment = assess(aggregate);

    expect(codes(assessment)).toEqual(['overdue_target_date']);
    const reason = requireReason(assessment, 'overdue_target_date');
    expect(reason.rule).toBe('R-AT7-target-date-passed');
    expect(reason.severity).toBe('medium');
    expect(reason.provenance).toBe('manual');
    expect(reason.summary).toBe(
      'Target date 2025-06-01 has passed and the project is not marked complete.',
    );
    expect(assessment.needsAttention).toBe(true);
  });

  it('says nothing about a passed target date once the project is complete (R-AT7)', () => {
    const aggregate = makeAggregate({
      project: makeProject({ status: 'completed', targetDate: '2025-06-01' }),
    });

    expect(codes(assess(aggregate))).toEqual([]);
  });

  it('flags stale evidence on a project the owner still calls active (R-AT5)', () => {
    const aggregate = makeAggregate({
      project: makeProject({ status: 'active', lastManualUpdateAt: daysBefore(30) }),
      sources: [makeSource({ lastSyncOkAt: daysBefore(30) })],
    });

    const assessment = assess(aggregate);

    expect(assessment.freshness.state).toBe('stale');
    const reason = requireReason(assessment, 'stale_data');
    expect(reason.rule).toBe('R-AT5-stale-project');
    expect(reason.severity).toBe('low');
    expect(reason.provenance).toBe('verified');
    expect(reason.summary).toBe('No new evidence for 30 days.');
    expect(assessment.headline.rule).toBe('R-HL7-stale');
    expect(requireAction(assessment, 'R-RC9-stale-needs-update').action).toBe(
      'Synchronise this project, or record what is actually happening.',
    );
  });

  it('flags a repository archived on GitHub behind a live project (R-AT8)', () => {
    const aggregate = makeAggregate({
      project: makeProject({ status: 'active' }),
      sources: [makeSource({ github: githubState({ archived: true }) })],
    });

    const assessment = assess(aggregate, [makeWorkflowRun('success')]);

    const reason = requireReason(assessment, 'archived_repository');
    expect(reason.rule).toBe('R-AT8-archived-repository');
    expect(reason.severity).toBe('low');
    expect(reason.provenance).toBe('verified');
    expect(reason.summary).toBe(
      'owner/aurora is archived on GitHub, but this project is not marked complete.',
    );
  });

  it('leaves a project with nothing outstanding out of the attention list', () => {
    const aggregate = makeAggregate({
      project: makeProject({ status: 'active' }),
      sources: [makeSource()],
    });

    const assessment = assess(aggregate, [makeWorkflowRun('success'), makeMergedPr()]);

    expect(codes(assessment)).toEqual([]);
    expect(assessment.needsAttention).toBe(false);
  });
});

/* -------------------------------------------------------------- freshness */

describe('computeFreshness', () => {
  it('counts a manual update as an observation when there are no sources at all', () => {
    const aggregate = makeAggregate({
      project: makeProject({ type: 'school', lastManualUpdateAt: hoursBefore(2) }),
    });

    const freshness = computeFreshness(inputFor(aggregate));

    expect(freshness.state).toBe('live');
    expect(freshness.observedAt).toBe(hoursBefore(2));
    expect(freshness.ageHours).toBeCloseTo(2, 5);
    expect(freshness.lastError).toBeNull();
  });

  it('marks the data failing and reports the newest failure when a source sync failed', () => {
    const older = makeSource({
      label: 'owner/first',
      syncStatus: 'failed',
      lastSyncOkAt: daysBefore(3),
      lastSyncFailedAt: hoursBefore(10),
      lastSyncError: 'Rate limit exceeded.',
    });
    const newest = makeSource({
      label: 'owner/second',
      syncStatus: 'failed',
      lastSyncOkAt: null,
      lastSyncFailedAt: hoursBefore(1),
      lastSyncError: 'GitHub rejected the credential.',
    });
    const aggregate = makeAggregate({
      project: makeProject({ lastManualUpdateAt: daysBefore(2) }),
      sources: [older, newest],
    });

    const freshness = computeFreshness(inputFor(aggregate));

    expect(freshness.state).toBe('failing');
    expect(freshness.lastError).toBe('GitHub rejected the credential.');
    /*
     * The last good observation is kept so the UI can still show what it was — and it is the last
     * successful *synchronisation*, not the owner's later manual edit, because that is the moment
     * the repository data on screen actually dates from.
     */
    expect(freshness.observedAt).toBe(daysBefore(3));
    expect(freshness.explanation).toContain('last data that synchronised successfully');
  });

  it('takes the newest of evidence, successful syncs and manual updates', () => {
    const aggregate = makeAggregate({
      project: makeProject({ lastManualUpdateAt: daysBefore(4) }),
      sources: [makeSource({ lastSyncOkAt: daysBefore(3) })],
    });
    const evidence = [makeEvidence({ observedAt: daysBefore(9), fetchedAt: hoursBefore(1) })];

    expect(computeFreshness(inputFor(aggregate, evidence)).observedAt).toBe(hoursBefore(1));
  });

  it('reports "never" and distinguishes a source that has never synchronised', () => {
    const withoutSources = makeAggregate({
      project: makeProject({ lastManualUpdateAt: null, lastSyncedAt: null }),
    });
    const withSource = makeAggregate({
      project: makeProject({ lastManualUpdateAt: null, lastSyncedAt: null }),
      sources: [makeSource({ syncStatus: 'never', lastSyncOkAt: null })],
    });

    expect(computeFreshness(inputFor(withoutSources))).toMatchObject({
      state: 'never',
      observedAt: null,
      ageHours: null,
      explanation: 'Nothing has been recorded for this project yet.',
    });
    expect(computeFreshness(inputFor(withSource)).explanation).toBe(
      'This project has a source but has never been synchronised.',
    );
  });

  it('does not let a later manual update paper over a source whose sync is failing', () => {
    const aggregate = makeAggregate({
      project: makeProject({ lastManualUpdateAt: hoursBefore(1) }),
      sources: [
        makeSource({
          syncStatus: 'failed',
          lastSyncOkAt: daysBefore(3),
          lastSyncFailedAt: hoursBefore(5),
          lastSyncError: 'GitHub rejected the credential.',
        }),
      ],
    });

    const assessment = assess(aggregate);

    /*
     * The owner typing a note does not make the repository half of the picture current. Reporting
     * "live" here would be the exact failure the product forbids: presenting last-known-good data
     * as if it were up to date.
     */
    expect(assessment.freshness.state).toBe('failing');
    expect(assessment.freshness.observedAt).toBe(daysBefore(3));
    expect(assessment.freshness.lastError).toBe('GitHub rejected the credential.');
    /* The operational warning about the broken source is never swallowed either. */
    expect(codes(assessment)).toContain('failed_sync');
    expect(actionRules(assessment)).toContain('R-RC8-recover-sync');
  });

  it('keeps a healthy source current even when a different source is failing', () => {
    const healthy = makeSource({ id: 'source-healthy', label: 'owner/healthy' });
    const broken = makeSource({
      id: 'source-broken',
      label: 'owner/broken',
      syncStatus: 'failed',
      lastSyncOkAt: daysBefore(20),
      lastSyncFailedAt: hoursBefore(2),
      lastSyncError: 'GitHub rejected the credential.',
    });
    const aggregate = makeAggregate({
      project: makeProject({ lastManualUpdateAt: null }),
      sources: [healthy, broken],
    });
    /* Evidence belonging to the broken source must not vouch for how current the picture is. */
    const evidence = [
      makeEvidence({ sourceId: 'source-broken', fetchedAt: hoursBefore(2) }),
      makeEvidence({ sourceId: 'source-healthy', fetchedAt: hoursBefore(1) }),
    ];

    const freshness = computeFreshness(inputFor(aggregate, evidence));

    /* One broken source still degrades the whole project's freshness — but the healthy source's
       evidence is what dates the observation, and it is never discarded. */
    expect(freshness.state).toBe('failing');
    expect(freshness.observedAt).toBe(hoursBefore(1));
  });
});

/* ------------------------------------------------------------ fingerprint */

describe('fingerprint', () => {
  const stableAggregate = (): ProjectAggregate =>
    makeAggregate({
      project: makeProject({ id: 'project-fingerprint', status: 'active' }),
      sources: [makeSource({ id: 'source-fingerprint' })],
    });

  it('is stable when the same inputs are assessed again', () => {
    const aggregate = stableAggregate();
    const evidence = [makeMergedPr({ id: 'evidence-pr', observedAt: daysBefore(2) })];

    const first = assess(aggregate, evidence);
    const second = assess(aggregate, evidence);

    expect(second.evidenceFingerprint).toBe(first.evidenceFingerprint);
    expect(first.evidenceFingerprint).toHaveLength(32);
  });

  it('changes when a blocker is added', () => {
    const before = assess(stableAggregate());
    const after = assess(
      makeAggregate({
        project: makeProject({ id: 'project-fingerprint', status: 'active' }),
        sources: [makeSource({ id: 'source-fingerprint' })],
        blockers: [makeBlocker({ isActive: true, title: 'Waiting on the vendor' })],
      }),
    );

    expect(after.evidenceFingerprint).not.toBe(before.evidenceFingerprint);
  });

  it('ignores generatedAt so an unchanged project does not re-trigger narration', () => {
    const aggregate = stableAggregate();
    const later = new Date(NOW.getTime() + 60_000);

    const first = assess(aggregate, [], NOW);
    const second = assess(aggregate, [], later);
    const material: Omit<ProjectAssessment, 'evidenceFingerprint'> = first;

    expect(second.generatedAt).not.toBe(first.generatedAt);
    expect(second.evidenceFingerprint).toBe(first.evidenceFingerprint);
    expect(fingerprint({ ...material, generatedAt: '2030-01-01T00:00:00.000Z' })).toBe(
      first.evidenceFingerprint,
    );
  });
});
