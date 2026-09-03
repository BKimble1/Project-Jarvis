import { describe, expect, it } from 'vitest';
import type { Mission, MissionState } from '@/domain/mission';
import { assessScopeChange } from '@/server/missions/mission-service';
import { buildMissionSignals, countMissions } from '@/server/status/missions';
import { fingerprintPlan, planIsReviewOnly } from '@/server/missions/planner';
import type { MissionPlanContent } from '@/domain/mission-plan';
import { deriveWorkerHealth, type JarvisWorker, type WorkerHealth } from '@/domain/worker';

/**
 * How missions become status.
 *
 * The property under test throughout is honesty: a mission whose worker has gone quiet must not
 * be described as progressing, and a draft pull request must not be described as finished work.
 */

const NOW = new Date('2026-01-01T12:00:00.000Z');

function mission(state: MissionState, overrides: Partial<Mission> = {}): Mission {
  return {
    id: `mission-${state}`,
    projectId: 'project-1',
    ownerLogin: 'owner',
    rawRequest: 'Add invoice scanning',
    title: 'Add invoice scanning',
    description: null,
    type: 'code_change',
    riskLevel: 'moderate',
    riskRuleIds: [],
    riskReasons: [],
    state,
    priority: 'medium',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    targetDate: null,
    sourceId: null,
    repositoryOwner: null,
    repositoryName: null,
    baseBranch: null,
    workingBranch: null,
    baseSha: null,
    pullRequestUrl: null,
    pullRequestNumber: null,
    activeRunId: null,
    claimedByWorkerId: null,
    attemptCount: 0,
    currentPlanVersion: 1,
    approvedPlanVersion: 1,
    currentGraphVersion: null,
    approvedGraphVersion: null,
    playbookKey: null,
    playbookVersion: null,
    integrationBranch: null,
    repairRoundsUsed: 0,
    receiptId: null,
    executionOverrideAt: null,
    executionOverrideReason: null,
    constraints: [],
    doNotTouch: [],
    deliverable: null,
    acceptanceCriteria: [],
    cancellationReason: null,
    completionSummary: null,
    failureCode: null,
    failureMessage: null,
    evidenceIds: [],
    startedAt: null,
    finishedAt: null,
    lastActivityAt: null,
    ...overrides,
  };
}

function health(overrides: Partial<JarvisWorker> = {}): WorkerHealth {
  return deriveWorkerHealth(
    {
      id: 'worker-1',
      name: 'macbook',
      tokenPrefix: 'jarvisw_1',
      status: 'busy',
      version: '2.0.0',
      platform: 'linux',
      currentMissionId: null,
      currentRunId: null,
      maxConcurrency: 1,
      runtimeAvailable: true,
      runtimeName: 'claude-agent-sdk',
      runtimeDetail: null,
      workspaceHealthy: true,
      workspaceRootLabel: 'workspaces',
      githubDeliveryConfigured: true,
      diagnostics: [],
      lastHeartbeatAt: '2026-01-01T11:59:55.000Z',
      lastActivityAt: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      rotatedAt: null,
      revokedAt: null,
      revokedReason: null,
      ...overrides,
    },
    NOW,
  );
}

const connected = new Map([['worker-1', health()]]);
const silent = new Map([['worker-1', health({ lastHeartbeatAt: '2026-01-01T10:00:00.000Z' })]]);

describe('buildMissionSignals', () => {
  it('puts a plan awaiting approval under what needs me', () => {
    const signals = buildMissionSignals({
      missions: [mission('awaiting_plan_approval')],
      workers: connected,
      now: NOW,
    });
    expect(signals.attention).toHaveLength(1);
    expect(signals.attention[0]?.rule).toBe('R-MS2');
    expect(signals.attention[0]?.code).toBe('decision_required');
  });

  it('treats a permission request as the most severe thing on the list', () => {
    const signals = buildMissionSignals({
      missions: [mission('waiting_for_permission', { claimedByWorkerId: 'worker-1' })],
      workers: connected,
      now: NOW,
    });
    expect(signals.attention[0]?.severity).toBe('critical');
  });

  it('describes a running mission as progressing only while its worker reports', () => {
    const live = buildMissionSignals({
      missions: [mission('running', { claimedByWorkerId: 'worker-1' })],
      workers: connected,
      now: NOW,
    });
    expect(live.currentWork.some((claim) => claim.text.includes('Jarvis is working on'))).toBe(
      true,
    );
    expect(live.unknowns).toEqual([]);

    const stalled = buildMissionSignals({
      missions: [mission('running', { claimedByWorkerId: 'worker-1' })],
      workers: silent,
      now: NOW,
    });
    expect(stalled.currentWork).toEqual([]);
    expect(stalled.attention[0]?.rule).toBe('R-MS11');
    expect(stalled.unknowns[0]).toContain('Nothing has been marked complete or failed');
  });

  it('presents a draft pull request as ready for review, never as completed work', () => {
    const signals = buildMissionSignals({
      missions: [mission('pull_request_ready')],
      workers: connected,
      now: NOW,
    });
    expect(signals.attention[0]?.summary).toContain('Nothing is merged');
    expect(signals.currentWork[0]?.text).toContain('awaiting review, not merged');
    expect(signals.recentlyCompleted).toEqual([]);
  });

  it('says whether a failed mission preserved anything', () => {
    const withBranch = buildMissionSignals({
      missions: [
        mission('failed', {
          failureMessage: 'The build broke.',
          workingBranch: 'jarvis/x-add-thing',
        }),
      ],
      workers: connected,
      now: NOW,
    });
    expect(withBranch.attention[0]?.summary).toContain('jarvis/x-add-thing');

    const withNothing = buildMissionSignals({
      missions: [mission('failed', { failureMessage: 'Clone failed.' })],
      workers: connected,
      now: NOW,
    });
    expect(withNothing.attention[0]?.summary).toContain('nothing to recover');
  });

  it('never shows a stopped mission as active', () => {
    const signals = buildMissionSignals({
      missions: [mission('stopped')],
      workers: connected,
      now: NOW,
    });
    expect(signals.currentWork).toEqual([]);
    expect(signals.attention[0]?.rule).toBe('R-MS7');
  });

  it('reports a recent completion but not an old one', () => {
    const recent = buildMissionSignals({
      missions: [
        mission('completed', {
          finishedAt: '2026-01-01T09:00:00.000Z',
          completionSummary: 'Scanner added.',
        }),
      ],
      workers: connected,
      now: NOW,
    });
    expect(recent.recentlyCompleted[0]?.text).toContain('Scanner added.');

    const old = buildMissionSignals({
      missions: [mission('completed', { finishedAt: '2025-11-01T00:00:00.000Z' })],
      workers: connected,
      now: NOW,
    });
    expect(old.recentlyCompleted).toEqual([]);
  });

  it('marks every mission claim as verified — Jarvis wrote these rows itself', () => {
    const signals = buildMissionSignals({
      missions: [mission('queued'), mission('paused'), mission('awaiting_plan_approval')],
      workers: connected,
      now: NOW,
    });
    for (const claim of [...signals.currentWork, ...signals.recentlyCompleted]) {
      expect(claim.provenance).toBe('verified');
    }
    for (const reason of signals.attention) expect(reason.provenance).toBe('verified');
  });

  it('attaches a rule id to every conclusion', () => {
    const signals = buildMissionSignals({
      missions: [
        mission('needs_clarification'),
        mission('awaiting_plan_approval'),
        mission('failed'),
        mission('stopped'),
        mission('pull_request_ready'),
      ],
      workers: connected,
      now: NOW,
    });
    for (const reason of signals.attention) expect(reason.rule).toMatch(/^R-MS\d+$/);
    for (const claim of signals.currentWork) expect(claim.rule).toMatch(/^R-MS\d+/);
  });
});

describe('countMissions', () => {
  it('counts a mission with a silent worker as stalled, not running', () => {
    const counts = countMissions(
      [
        mission('running', { claimedByWorkerId: 'worker-1' }),
        mission('verifying', { claimedByWorkerId: 'worker-1', id: 'm2' }),
      ],
      silent,
    );
    expect(counts.running).toBe(0);
    expect(counts.stalled).toBe(2);
  });

  it('counts each waiting state under the right heading', () => {
    const counts = countMissions(
      [
        mission('queued'),
        mission('awaiting_plan_approval', { id: 'm2' }),
        mission('needs_clarification', { id: 'm3' }),
        mission('waiting_for_permission', { id: 'm4', claimedByWorkerId: 'worker-1' }),
        mission('waiting_for_input', { id: 'm5', claimedByWorkerId: 'worker-1' }),
        mission('pull_request_ready', { id: 'm6' }),
        mission('failed', { id: 'm7' }),
        mission('stopped', { id: 'm8' }),
        mission('paused', { id: 'm9' }),
      ],
      connected,
    );
    expect(counts).toMatchObject({
      queued: 1,
      awaitingApproval: 1,
      needsClarification: 1,
      needsPermission: 2,
      prReady: 1,
      failed: 1,
      stopped: 1,
      paused: 1,
    });
  });
});

/* ------------------------------------------------------------- scope change */

describe('assessScopeChange', () => {
  const plan = (overrides: Partial<MissionPlanContent> = {}): MissionPlanContent => ({
    summary: 's',
    proposedOutcome: 'o',
    assumptions: [],
    scope: ['Add invoice scanning'],
    outOfScope: ['Changing the subscription billing flow.'],
    affectedAreas: [],
    approach: 'a',
    dataMigrations: [],
    testsToAddOrUpdate: [],
    verification: [],
    uiValidation: [],
    risks: [],
    rollback: 'r',
    acceptanceCriteria: [],
    openQuestions: [],
    estimatedComplexity: 'small',
    withinRequestedScope: true,
    reviewOnlyDelivery: true,
    evidenceIds: [],
    repositoryFacts: {},
    ...overrides,
  });

  it('lets an ordinary clarification through without replanning', () => {
    for (const message of [
      'Use the existing parser rather than writing a new one.',
      'Prefer the smaller change if there is a choice.',
      'What are you working on right now?',
    ]) {
      expect(assessScopeChange(message, plan(), { doNotTouch: [] }).materiallyChangesScope).toBe(
        false,
      );
    }
  });

  it('catches an "also do X" that adds work the plan does not cover', () => {
    const result = assessScopeChange('Also add a CSV export while you are there', plan(), {
      doNotTouch: [],
    });
    expect(result.materiallyChangesScope).toBe(true);
    expect(result.reason).toContain('does not cover');
  });

  it('catches an attempt to set the plan aside', () => {
    const result = assessScopeChange('Ignore the plan and just do what looks right', plan(), {
      doNotTouch: [],
    });
    expect(result.materiallyChangesScope).toBe(true);
    expect(result.reason).toContain('set aside the approved plan');
  });

  it('catches a message touching an area the owner marked off limits', () => {
    const result = assessScopeChange('Have a look at the subscription code too', plan(), {
      doNotTouch: ['subscription code'],
    });
    expect(result.materiallyChangesScope).toBe(true);
    expect(result.reason).toContain('off limits');
  });

  it('catches a message reaching into something the plan called out of scope', () => {
    const result = assessScopeChange('Can you fix the billing flow as well', plan(), {
      doNotTouch: [],
    });
    expect(result.materiallyChangesScope).toBe(true);
  });
});

/* ---------------------------------------------------------------- plan rules */

describe('planIsReviewOnly', () => {
  const content = (overrides: Partial<MissionPlanContent> = {}): MissionPlanContent => ({
    summary: 'Add invoice scanning',
    proposedOutcome: 'A draft pull request.',
    assumptions: [],
    scope: [],
    outOfScope: [],
    affectedAreas: [],
    approach: 'Write the code, add tests, open a draft PR.',
    dataMigrations: [],
    testsToAddOrUpdate: [],
    verification: [],
    uiValidation: [],
    risks: [],
    rollback: 'Close the PR.',
    acceptanceCriteria: [],
    openQuestions: [],
    estimatedComplexity: 'small',
    withinRequestedScope: true,
    reviewOnlyDelivery: true,
    evidenceIds: [],
    repositoryFacts: {},
    ...overrides,
  });

  it('accepts an ordinary draft-PR plan', () => {
    expect(planIsReviewOnly(content(), 'moderate')).toBe(true);
  });

  it('refuses a plan that claims to be review-only while describing a deploy or a merge', () => {
    expect(
      planIsReviewOnly(content({ approach: 'Build it, then deploy to production.' }), 'moderate'),
    ).toBe(false);
    expect(
      planIsReviewOnly(content({ proposedOutcome: 'Merge into main once green.' }), 'moderate'),
    ).toBe(false);
    expect(planIsReviewOnly(content({ approach: 'Then upload to TestFlight.' }), 'high')).toBe(
      false,
    );
  });

  it('respects a plan that says outright it is not review-only', () => {
    expect(planIsReviewOnly(content({ reviewOnlyDelivery: false }), 'moderate')).toBe(false);
  });
});

describe('fingerprintPlan', () => {
  const base: MissionPlanContent = {
    summary: 'a',
    proposedOutcome: 'b',
    assumptions: ['x'],
    scope: ['y'],
    outOfScope: [],
    affectedAreas: [],
    approach: 'c',
    dataMigrations: [],
    testsToAddOrUpdate: [],
    verification: [],
    uiValidation: [],
    risks: [],
    rollback: 'd',
    acceptanceCriteria: [],
    openQuestions: [],
    estimatedComplexity: 'small',
    withinRequestedScope: true,
    reviewOnlyDelivery: true,
    evidenceIds: [],
    repositoryFacts: {},
  };

  it('is stable regardless of key order', () => {
    const reordered = { ...base } as Record<string, unknown>;
    const shuffled = Object.fromEntries(
      Object.entries(reordered).reverse(),
    ) as unknown as MissionPlanContent;
    expect(fingerprintPlan(base)).toBe(fingerprintPlan(shuffled));
  });

  it('changes when anything meaningful changes', () => {
    expect(fingerprintPlan(base)).not.toBe(fingerprintPlan({ ...base, approach: 'different' }));
    expect(fingerprintPlan(base)).not.toBe(fingerprintPlan({ ...base, scope: ['y', 'z'] }));
  });
});
