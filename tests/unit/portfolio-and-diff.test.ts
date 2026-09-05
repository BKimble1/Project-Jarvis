import { describe, expect, it } from 'vitest';
import { claim, type Evidence } from '@/domain/evidence';
import type { FreshnessState } from '@/domain/enums';
import type { Project } from '@/domain/project';
import type {
  AttentionReason,
  FreshnessAssessment,
  ProjectAssessment,
  RecommendedAction,
  StatusSnapshot,
} from '@/domain/status';
import { diffSnapshots, evidenceChanges } from '@/server/status/diff';
import { assessPortfolio, buildFocusOrder } from '@/server/status/portfolio';
import {
  NOW,
  daysBefore,
  hoursBefore,
  makeEvidence,
  makeMergedPr,
  makeOpenPr,
  makeProject,
} from '../helpers/factories';

/* ------------------------------------------------------------------ fixtures */

const PROJECT_ID = 'project-under-test';

const freshnessOf = (
  state: FreshnessState,
  lastError: string | null = null,
): FreshnessAssessment => ({
  state,
  observedAt: hoursBefore(1),
  ageHours: 1,
  explanation: `Evidence freshness is ${state}.`,
  lastError,
});

const reason = (
  code: AttentionReason['code'],
  severity: AttentionReason['severity'],
  summary: string,
  rule: string,
  provenance: AttentionReason['provenance'] = 'manual',
  evidenceIds: readonly string[] = [],
): AttentionReason => ({ code, severity, summary, provenance, evidenceIds, rule });

const action = (text: string, rule = 'R-RC4-owner-next-action'): RecommendedAction => ({
  action: text,
  rationale: 'Because the evidence says so.',
  provenance: 'inferred',
  evidenceIds: [],
  requiresOwner: true,
  rule,
});

function makeAssessment(
  overrides: Partial<ProjectAssessment> & { projectId: string },
): ProjectAssessment {
  return {
    generatedAt: NOW.toISOString(),
    status: 'active',
    statusProvenance: 'manual',
    phase: 'Build',
    phaseProvenance: 'manual',
    headline: claim('Work is progressing.', 'inferred'),
    recentlyCompleted: [],
    currentWork: [],
    activeBlockers: [],
    decisionsNeeded: [],
    recommendedActions: [],
    attention: [],
    needsAttention: false,
    freshness: freshnessOf('live'),
    unknowns: [],
    keyEvidenceIds: [],
    evidenceFingerprint: 'fingerprint-default',
    ...overrides,
  };
}

const assessmentsOf = (
  ...items: readonly ProjectAssessment[]
): ReadonlyMap<string, ProjectAssessment> => new Map(items.map((item) => [item.projectId, item]));

function makeSnapshot(overrides: Partial<StatusSnapshot> = {}): StatusSnapshot {
  return {
    id: 'snapshot',
    projectId: PROJECT_ID,
    generatedAt: NOW.toISOString(),
    status: 'active',
    phase: 'Build',
    headline: 'Work is progressing.',
    recentlyCompleted: [],
    currentWork: [],
    blockers: [],
    decisionsNeeded: [],
    recommendedActions: [],
    evidenceIds: [],
    freshness: freshnessOf('live'),
    unknowns: [],
    summaryMethod: 'deterministic',
    fingerprint: 'fingerprint-1',
    narrative: null,
    ...overrides,
  };
}

function workflowRun(
  name: string,
  conclusion: string | null,
  observedAt: string,
  overrides: Partial<Evidence> = {},
): Evidence {
  return makeEvidence({
    projectId: PROJECT_ID,
    kind: 'workflow_run',
    title: `${name} run`,
    observedAt,
    metadata: {
      runId: 1,
      workflowName: name,
      status: conclusion ? 'completed' : 'in_progress',
      conclusion,
      isDefaultBranch: true,
    },
    ...overrides,
  });
}

/* --------------------------------------------------------------- portfolio */

describe('assessPortfolio counts', () => {
  const aurora = makeProject({ id: 'aurora', name: 'Aurora' });
  const borealis = makeProject({ id: 'borealis', name: 'Borealis' });
  const cinder = makeProject({ id: 'cinder', name: 'Cinder' });
  const delta = makeProject({ id: 'delta', name: 'Delta' });
  const echo = makeProject({ id: 'echo', name: 'Echo' });
  const foxtrot = makeProject({ id: 'foxtrot', name: 'Foxtrot' });
  const gale = makeProject({ id: 'gale', name: 'Gale' });
  const helios = makeProject({ id: 'helios', name: 'Helios' });
  const iris = makeProject({
    id: 'iris',
    name: 'Iris',
    status: 'archived',
    archivedAt: daysBefore(5),
  });
  /* Never assessed: the portfolio must fall back to the stored project columns. */
  const juno = makeProject({
    id: 'juno',
    name: 'Juno',
    status: 'blocked',
    needsAttention: true,
    freshness: 'never',
  });

  const projects: readonly Project[] = [
    aurora,
    borealis,
    cinder,
    delta,
    echo,
    foxtrot,
    gale,
    helios,
    iris,
    juno,
  ];

  const assessments = assessmentsOf(
    makeAssessment({ projectId: aurora.id }),
    makeAssessment({ projectId: borealis.id, needsAttention: true }),
    makeAssessment({ projectId: cinder.id, status: 'blocked', needsAttention: true }),
    makeAssessment({ projectId: delta.id, status: 'waiting' }),
    makeAssessment({ projectId: echo.id, status: 'paused' }),
    makeAssessment({ projectId: foxtrot.id, freshness: freshnessOf('stale') }),
    makeAssessment({
      projectId: gale.id,
      freshness: freshnessOf('failing', 'GitHub rejected the credential.'),
    }),
    makeAssessment({ projectId: helios.id, status: 'completed' }),
    makeAssessment({
      projectId: iris.id,
      status: 'archived',
      needsAttention: true,
      attention: [
        reason(
          'decision_required',
          'critical',
          'Decision needed: shut it down',
          'R-AT1-blocker-requires-owner-decision',
        ),
      ],
    }),
  );

  const result = assessPortfolio({ projects, assessments, recentEvidence: [], now: NOW });

  it('counts every live project against the assessment that overrides its stored status', () => {
    expect(result.counts).toEqual({
      total: 10,
      active: 4,
      progressing: 1,
      needsAttention: 3,
      blocked: 2,
      waiting: 1,
      paused: 1,
      completed: 1,
      stale: 2,
      archived: 1,
      syncFailing: 1,
    });
  });

  it('names the projects behind each count', () => {
    expect(result.progressingProjectIds).toEqual(['aurora']);
    expect(result.needsAttentionProjectIds).toEqual(['borealis', 'cinder', 'juno']);
    expect(result.blockedProjectIds).toEqual(['cinder', 'juno']);
    expect(result.waitingProjectIds).toEqual(['delta']);
    expect(result.pausedProjectIds).toEqual(['echo']);
    /* `never` is as untrustworthy as `stale`, so both land in the stale list. */
    expect(result.staleProjectIds).toEqual(['foxtrot', 'juno']);
    expect(result.generatedAt).toBe(NOW.toISOString());
  });

  it('excludes archived projects from live counts and from the attention lists', () => {
    expect(result.counts.archived).toBe(1);
    expect(result.needsAttentionProjectIds).not.toContain('iris');
    expect(result.focusOrder.map((entry) => entry.projectId)).not.toContain('iris');
    /* An archived project's decision must not keep asking for the owner's time. */
    expect(result.decisionsNeeded).toHaveLength(0);
  });
});

describe('assessPortfolio decisions', () => {
  it('aggregates only decision_required reasons, worst severity first', () => {
    const alpha = makeProject({ id: 'alpha', name: 'Alpha' });
    const bravo = makeProject({ id: 'bravo', name: 'Bravo' });
    const charlie = makeProject({ id: 'charlie', name: 'Charlie' });

    const result = assessPortfolio({
      projects: [alpha, bravo, charlie],
      assessments: assessmentsOf(
        makeAssessment({
          projectId: alpha.id,
          needsAttention: true,
          attention: [
            reason(
              'decision_required',
              'high',
              'Decision needed: pick a host',
              'R-AT1-blocker-requires-owner-decision',
            ),
            reason(
              'active_blocker',
              'critical',
              'Blocked: waiting on legal',
              'R-AT2-active-blocker',
            ),
          ],
        }),
        makeAssessment({
          projectId: bravo.id,
          needsAttention: true,
          attention: [
            reason(
              'decision_required',
              'critical',
              'Decision needed: cancel the pilot',
              'R-AT1-blocker-requires-owner-decision',
            ),
          ],
        }),
        makeAssessment({
          projectId: charlie.id,
          needsAttention: true,
          attention: [
            reason(
              'failed_workflow',
              'high',
              'CI failed 2 hours ago',
              'R-AT3-recent-failed-workflow',
              'verified',
            ),
          ],
        }),
      ),
      recentEvidence: [],
      now: NOW,
    });

    expect(result.decisionsNeeded.map((item) => item.summary)).toEqual([
      'Decision needed: cancel the pilot',
      'Decision needed: pick a host',
    ]);
    expect(result.decisionsNeeded.every((item) => item.code === 'decision_required')).toBe(true);
    expect(result.decisionsNeeded.map((item) => item.rule)).toEqual([
      'R-AT1-blocker-requires-owner-decision',
      'R-AT1-blocker-requires-owner-decision',
    ]);
  });
});

describe('buildFocusOrder', () => {
  const withReason = (
    id: string,
    name: string,
    attention: readonly AttentionReason[],
    overrides: Partial<Project> = {},
    assessmentOverrides: Partial<ProjectAssessment> = {},
  ) => ({
    project: makeProject({ id, name, ...overrides }),
    assessment: makeAssessment({ projectId: id, attention, ...assessmentOverrides }),
  });

  const orderOf = (members: readonly { project: Project; assessment: ProjectAssessment }[]) =>
    buildFocusOrder(
      members.map((member) => member.project),
      assessmentsOf(...members.map((member) => member.assessment)),
    );

  it('orders by the worst thing true of a project, not alphabetically', () => {
    const zulu = withReason('zulu', 'Zulu', [
      reason(
        'decision_required',
        'critical',
        'Decision needed: pick a host',
        'R-AT1-blocker-requires-owner-decision',
      ),
    ]);
    const yankee = withReason('yankee', 'Yankee', [
      reason(
        'failed_workflow',
        'high',
        'CI failed 3 hours ago',
        'R-AT3-recent-failed-workflow',
        'verified',
      ),
    ]);
    const xray = withReason('xray', 'Xray', [
      reason('active_blocker', 'high', 'Blocked: waiting on legal', 'R-AT2-active-blocker'),
    ]);
    const whiskey = withReason('whiskey', 'Whiskey', [
      reason(
        'overdue_action',
        'medium',
        'Overdue since 2025-06-01: write the migration',
        'R-AT6-overdue-next-action',
      ),
    ]);
    const victor = withReason('victor', 'Victor', [
      reason(
        'stale_data',
        'low',
        'No new evidence for 3 weeks.',
        'R-AT5-stale-project',
        'verified',
      ),
    ]);
    /* Alphabetically first, but nothing is wrong with it, so it ranks last. */
    const alpha = withReason('alpha', 'Alpha', []);

    const order = orderOf([alpha, victor, whiskey, xray, yankee, zulu]);

    expect(order.map((entry) => entry.projectId)).toEqual([
      'zulu',
      'yankee',
      'xray',
      'whiskey',
      'victor',
      'alpha',
    ]);
    expect(order.map((entry) => entry.rank)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(order[0]?.reason).toBe('Decision needed: pick a host');
    expect(order[1]?.provenance).toBe('verified');
    /* Nothing outstanding still gets a human sentence rather than an empty cell. */
    expect(order[5]?.reason).toBe('Progressing with nothing outstanding.');
    expect(order[5]?.provenance).toBe('inferred');
    expect(order.every((entry) => entry.reason.trim().length > 0)).toBe(true);
  });

  it('breaks bucket ties with the owner priority, then the project name', () => {
    const order = orderOf([
      withReason(
        'anvil',
        'Anvil',
        [reason('active_blocker', 'high', 'Blocked: anvil', 'R-AT2-active-blocker')],
        { priority: 'medium' },
      ),
      withReason(
        'beacon',
        'Beacon',
        [reason('active_blocker', 'high', 'Blocked: beacon', 'R-AT2-active-blocker')],
        { priority: 'medium' },
      ),
      withReason(
        'cobalt',
        'Cobalt',
        [reason('active_blocker', 'high', 'Blocked: cobalt', 'R-AT2-active-blocker')],
        { priority: 'critical' },
      ),
      withReason(
        'dune',
        'Dune',
        [reason('active_blocker', 'high', 'Blocked: dune', 'R-AT2-active-blocker')],
        { priority: 'low' },
      ),
    ]);

    expect(order.map((entry) => entry.projectId)).toEqual(['cobalt', 'anvil', 'beacon', 'dune']);
  });

  it('pushes terminal states behind live work however bad their reason is', () => {
    const order = orderOf([
      withReason(
        'closed',
        'Closed',
        [
          reason(
            'decision_required',
            'critical',
            'Decision needed: archive it',
            'R-AT1-blocker-requires-owner-decision',
          ),
        ],
        { priority: 'critical' },
        { status: 'completed' },
      ),
      withReason(
        'resting',
        'Resting',
        [
          reason(
            'failed_workflow',
            'high',
            'CI failed 1 day ago',
            'R-AT3-recent-failed-workflow',
            'verified',
          ),
        ],
        {},
        { status: 'paused' },
      ),
      withReason(
        'shelved',
        'Shelved',
        [reason('active_blocker', 'high', 'Blocked: shelved', 'R-AT2-active-blocker')],
        {},
        { status: 'archived' },
      ),
      withReason('running', 'Running', []),
    ]);

    expect(order.map((entry) => entry.projectId)).toEqual([
      'running',
      'closed',
      'resting',
      'shelved',
    ]);
    /* The reason is still shown truthfully — only its position changes. */
    expect(order[1]?.reason).toBe('Decision needed: archive it');
  });

  it('labels an unassessed project unknown and shows its short name', () => {
    const project = makeProject({ id: 'nova', name: 'Nova Platform', shortName: 'Nova' });
    const order = buildFocusOrder([project], new Map());

    expect(order).toEqual([
      {
        projectId: 'nova',
        projectName: 'Nova',
        reason: 'Progressing with nothing outstanding.',
        provenance: 'unknown',
        rank: 1,
      },
    ]);
  });
});

describe('assessPortfolio recent changes', () => {
  const aurora = makeProject({ id: 'aurora', name: 'Aurora Platform', shortName: 'Aurora' });

  const runPortfolio = (recentEvidence: readonly Evidence[]) =>
    assessPortfolio({
      projects: [aurora],
      assessments: assessmentsOf(makeAssessment({ projectId: aurora.id })),
      recentEvidence,
      now: NOW,
    });

  it('reports only evidence a person would call a change', () => {
    const result = runPortfolio([
      /* Newest of all, and deliberately not a change: a commit is activity, not an outcome. */
      makeEvidence({ projectId: aurora.id, title: 'Tidy imports', observedAt: daysBefore(0.5) }),
      makeMergedPr({ projectId: aurora.id, observedAt: daysBefore(1) }),
      makeEvidence({
        projectId: aurora.id,
        kind: 'pull_request',
        title: '#9 Abandoned spike',
        observedAt: daysBefore(1.5),
        metadata: { number: 9, state: 'closed', merged: false },
      }),
      makeOpenPr({ projectId: aurora.id, observedAt: daysBefore(2) }),
      workflowRun('CI', 'success', daysBefore(2.5), { projectId: aurora.id }),
      makeEvidence({
        projectId: aurora.id,
        kind: 'release',
        title: 'v1.2.0',
        observedAt: daysBefore(3),
      }),
      workflowRun('CI', 'failure', daysBefore(4), { projectId: aurora.id, title: 'CI on main' }),
      makeEvidence({
        projectId: aurora.id,
        kind: 'deployment',
        title: 'production',
        observedAt: daysBefore(5),
      }),
      makeEvidence({
        projectId: aurora.id,
        kind: 'manual_update',
        sourceSystem: 'manual',
        title: 'Rewrote the onboarding copy.',
        observedAt: daysBefore(6),
      }),
    ]);

    expect(result.recentChanges.map((change) => change.summary)).toEqual([
      'Merged #7 Evidence timeline',
      'Opened #12 Status engine',
      'Released v1.2.0',
      'Build failed: CI on main',
      'Deployment: production',
      'Rewrote the onboarding copy.',
    ]);
    expect(result.recentChanges.every((change) => change.projectName === 'Aurora')).toBe(true);
  });

  it('labels provenance by the system that produced the evidence', () => {
    const merged = makeMergedPr({
      id: 'evidence-pr',
      projectId: aurora.id,
      observedAt: daysBefore(1),
    });
    const manual = makeEvidence({
      id: 'evidence-manual',
      projectId: aurora.id,
      kind: 'manual_update',
      sourceSystem: 'manual',
      title: 'Decided to postpone the launch.',
      observedAt: daysBefore(2),
    });

    const [first, second] = runPortfolio([merged, manual]).recentChanges;

    expect(first?.provenance).toBe('verified');
    expect(first?.evidenceIds).toEqual(['evidence-pr']);
    expect(first?.occurredAt).toBe(merged.observedAt);
    expect(second?.provenance).toBe('manual');
    expect(second?.evidenceIds).toEqual(['evidence-manual']);
  });

  it('drops evidence outside the window or belonging to an unknown project', () => {
    const result = runPortfolio([
      makeEvidence({
        projectId: aurora.id,
        kind: 'release',
        title: 'v0.9.0',
        observedAt: daysBefore(15),
      }),
      makeEvidence({
        projectId: aurora.id,
        kind: 'release',
        title: 'v1.0.0',
        observedAt: daysBefore(13),
      }),
      makeEvidence({
        projectId: 'a-project-that-is-not-in-the-portfolio',
        kind: 'release',
        title: 'v2.0.0',
        observedAt: daysBefore(1),
      }),
    ]);

    expect(result.recentChanges.map((change) => change.summary)).toEqual(['Released v1.0.0']);
  });

  it('caps the list at twenty and keeps the newest', () => {
    const releases = Array.from({ length: 25 }, (_, index) =>
      makeEvidence({
        projectId: aurora.id,
        kind: 'release',
        title: `v1.${index}.0`,
        observedAt: hoursBefore(index + 1),
      }),
    );

    const result = runPortfolio(releases);

    expect(result.recentChanges).toHaveLength(20);
    expect(result.recentChanges[0]?.summary).toBe('Released v1.0.0');
    expect(result.recentChanges.map((change) => change.summary)).not.toContain('Released v1.20.0');
  });
});

describe('assessPortfolio unknowns', () => {
  it('says out loud what it could not see', () => {
    const aurora = makeProject({ id: 'aurora', name: 'Aurora' });
    const borealis = makeProject({ id: 'borealis', name: 'Borealis' });
    const cinder = makeProject({ id: 'cinder', name: 'Cinder', goal: null });
    const delta = makeProject({ id: 'delta', name: 'Delta', goal: null });

    const result = assessPortfolio({
      projects: [aurora, borealis, cinder, delta],
      assessments: assessmentsOf(
        makeAssessment({ projectId: aurora.id }),
        makeAssessment({
          projectId: borealis.id,
          freshness: freshnessOf('failing', 'GitHub rejected the credential.'),
        }),
        /* `cinder` is deliberately absent: it has never been assessed. */
        makeAssessment({ projectId: delta.id }),
      ),
      recentEvidence: [],
      now: NOW,
    });

    expect(result.unknowns).toEqual([
      '1 project has not been assessed yet.',
      "1 project's data could not be refreshed, so recent activity there is unknown.",
      '2 projects have no recorded goal.',
    ]);
  });

  /* Every unknown sentence is read by a person, so each must agree with itself in number. */
  it('writes the singular of every unknown sentence correctly', () => {
    const result = assessPortfolio({
      projects: [makeProject({ id: 'p-1', goal: null })],
      assessments: new Map(),
      recentEvidence: [],
      now: NOW,
    });

    expect(result.unknowns).toEqual([
      '1 project has not been assessed yet.',
      '1 project has no recorded goal.',
    ]);
  });
});

/* -------------------------------------------------------------------- diff */

describe('diffSnapshots', () => {
  it('treats the first snapshot as a baseline rather than a wall of changes', () => {
    const current = makeSnapshot({
      status: 'blocked',
      phase: 'Testing',
      recentlyCompleted: [claim('Merged #7 Evidence timeline', 'verified', ['e-7'])],
      blockers: [claim('Waiting on a provider decision', 'manual', ['b-1'])],
      decisionsNeeded: [claim('Choose the hosting provider', 'manual', ['b-1'])],
      recommendedActions: [action('Compare the two quotes')],
    });

    expect(diffSnapshots({ previous: null, current, evidenceSince: [] })).toEqual([]);
  });

  it('still surfaces evidence-level changes on a baseline snapshot', () => {
    const changes = diffSnapshots({
      previous: null,
      current: makeSnapshot(),
      evidenceSince: [makeMergedPr({ id: 'e-merged', projectId: PROJECT_ID })],
    });

    expect(changes.map((change) => change.kind)).toEqual(['pr_merged']);
    expect(changes[0]?.evidenceIds).toEqual(['e-merged']);
  });

  it('reports nothing when the fingerprint is unchanged — a timestamp is not a change', () => {
    const previous = makeSnapshot({
      id: 'snapshot-1',
      generatedAt: daysBefore(1),
      fingerprint: 'fingerprint-stable',
      freshness: freshnessOf('recent'),
      narrative: { currentState: 'Steady progress on the status engine.' },
      recentlyCompleted: [claim('Merged #7 Evidence timeline', 'verified', ['e-7'])],
      blockers: [claim('Waiting on a provider decision', 'manual', ['b-1'])],
      recommendedActions: [action('Compare the two quotes')],
    });
    const current = makeSnapshot({
      id: 'snapshot-2',
      generatedAt: NOW.toISOString(),
      fingerprint: 'fingerprint-stable',
      freshness: freshnessOf('live'),
      narrative: { currentState: 'Steady progress on the status engine (regenerated).' },
      recentlyCompleted: previous.recentlyCompleted,
      blockers: previous.blockers,
      recommendedActions: previous.recommendedActions,
    });

    expect(diffSnapshots({ previous, current, evidenceSince: [] })).toEqual([]);
  });

  it('reports the status transition with the new snapshot time', () => {
    const previous = makeSnapshot({ status: 'active', fingerprint: 'fingerprint-1' });
    const current = makeSnapshot({
      status: 'blocked',
      fingerprint: 'fingerprint-2',
      generatedAt: hoursBefore(1),
    });

    const changes = diffSnapshots({ previous, current, evidenceSince: [] });

    expect(changes).toEqual([
      {
        kind: 'status_changed',
        projectId: PROJECT_ID,
        summary: 'Status changed from active to blocked',
        detail: null,
        provenance: 'verified',
        evidenceIds: [],
        occurredAt: hoursBefore(1),
      },
    ]);
  });

  it('describes a phase appearing and disappearing as an owner-made change', () => {
    const cleared = diffSnapshots({
      previous: makeSnapshot({ phase: 'Build', fingerprint: 'fingerprint-1' }),
      current: makeSnapshot({ phase: null, fingerprint: 'fingerprint-2' }),
      evidenceSince: [],
    });
    const set = diffSnapshots({
      previous: makeSnapshot({ phase: null, fingerprint: 'fingerprint-1' }),
      current: makeSnapshot({ phase: 'Planning', fingerprint: 'fingerprint-2' }),
      evidenceSince: [],
    });

    expect(cleared.map((change) => [change.kind, change.summary, change.provenance])).toEqual([
      ['phase_changed', 'Phase changed from Build to none', 'manual'],
    ]);
    expect(set[0]?.summary).toBe('Phase changed from none to Planning');
  });

  it('reports only work that was not already in the previous snapshot', () => {
    const previous = makeSnapshot({
      fingerprint: 'fingerprint-1',
      /* Padded on purpose: the comparison trims, so re-formatting is not "new work". */
      recentlyCompleted: [claim('  Merged #7 Evidence timeline  ', 'verified', ['e-7'])],
    });
    const current = makeSnapshot({
      fingerprint: 'fingerprint-2',
      recentlyCompleted: [
        claim('Merged #7 Evidence timeline', 'verified', ['e-7']),
        claim('Released v1.2.0', 'verified', ['e-release']),
      ],
    });

    const changes = diffSnapshots({ previous, current, evidenceSince: [] });

    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      kind: 'work_completed',
      summary: 'Released v1.2.0',
      provenance: 'verified',
      evidenceIds: ['e-release'],
    });
  });

  it('reports blockers appearing and clearing, each keeping its own provenance', () => {
    const previous = makeSnapshot({
      fingerprint: 'fingerprint-1',
      blockers: [claim('Waiting on a provider decision', 'manual', ['b-old'])],
    });
    const current = makeSnapshot({
      fingerprint: 'fingerprint-2',
      blockers: [claim('CI has been red for two days', 'verified', ['e-ci'])],
    });

    const changes = diffSnapshots({ previous, current, evidenceSince: [] });

    expect(changes.map((change) => [change.kind, change.summary])).toEqual([
      ['blocker_added', 'New blocker: CI has been red for two days'],
      ['blocker_resolved', 'Blocker cleared: Waiting on a provider decision'],
    ]);
    expect(changes[0]?.provenance).toBe('verified');
    expect(changes[0]?.evidenceIds).toEqual(['e-ci']);
    expect(changes[1]?.provenance).toBe('manual');
    expect(changes[1]?.evidenceIds).toEqual(['b-old']);
  });

  it('reports a newly recorded decision', () => {
    const changes = diffSnapshots({
      previous: makeSnapshot({
        fingerprint: 'fingerprint-1',
        decisionsNeeded: [claim('Choose the hosting provider', 'manual', ['b-1'])],
      }),
      current: makeSnapshot({
        fingerprint: 'fingerprint-2',
        decisionsNeeded: [
          claim('Choose the hosting provider', 'manual', ['b-1']),
          claim('Decide whether to drop the iOS build', 'manual', ['b-2']),
        ],
      }),
      evidenceSince: [],
    });

    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      kind: 'decision_recorded',
      summary: 'Decision needed: Decide whether to drop the iOS build',
      provenance: 'manual',
      evidenceIds: ['b-2'],
    });
  });

  it('summarises one new recommended action by name and several by count', () => {
    const previous = makeSnapshot({
      fingerprint: 'fingerprint-1',
      recommendedActions: [action('Compare the two quotes')],
    });
    const one = diffSnapshots({
      previous,
      current: makeSnapshot({
        fingerprint: 'fingerprint-2',
        recommendedActions: [action('Compare the two quotes'), action('Fix the failing build')],
      }),
      evidenceSince: [],
    });
    const several = diffSnapshots({
      previous,
      current: makeSnapshot({
        fingerprint: 'fingerprint-3',
        recommendedActions: [
          action('Fix the failing build'),
          action('Write the migration'),
          action('Record a goal'),
        ],
      }),
      evidenceSince: [],
    });

    expect(one).toHaveLength(1);
    expect(one[0]).toMatchObject({
      kind: 'next_actions_changed',
      summary: 'New recommended action: Fix the failing build',
      detail: 'Fix the failing build',
      provenance: 'inferred',
      evidenceIds: [],
    });
    expect(several[0]).toMatchObject({
      kind: 'next_actions_changed',
      summary: '3 new recommended actions',
      detail: 'Fix the failing build · Write the migration · Record a goal',
    });
  });

  it('appends evidence-level changes after the snapshot-level ones', () => {
    const changes = diffSnapshots({
      previous: makeSnapshot({ status: 'active', fingerprint: 'fingerprint-1' }),
      current: makeSnapshot({ status: 'waiting', fingerprint: 'fingerprint-2' }),
      evidenceSince: [makeOpenPr({ id: 'e-open', projectId: PROJECT_ID })],
    });

    expect(changes.map((change) => change.kind)).toEqual(['status_changed', 'pr_opened']);
  });
});

describe('evidenceChanges', () => {
  it('reports merged and opened pull requests, newest first, with their evidence', () => {
    const merged = makeMergedPr({
      id: 'e-merged',
      projectId: PROJECT_ID,
      summary: 'Adds the evidence timeline.',
      observedAt: daysBefore(1),
    });
    const opened = makeOpenPr({ id: 'e-open', projectId: PROJECT_ID, observedAt: daysBefore(2) });

    const changes = evidenceChanges(PROJECT_ID, [opened, merged]);

    expect(changes.map((change) => [change.kind, change.summary])).toEqual([
      ['pr_merged', 'Merged #7 Evidence timeline'],
      ['pr_opened', 'Opened #12 Status engine'],
    ]);
    expect(changes[0]).toMatchObject({
      projectId: PROJECT_ID,
      detail: 'Adds the evidence timeline.',
      provenance: 'verified',
      evidenceIds: ['e-merged'],
      occurredAt: daysBefore(1),
    });
  });

  it('ignores a pull request that was closed without being merged', () => {
    const changes = evidenceChanges(PROJECT_ID, [
      makeEvidence({
        projectId: PROJECT_ID,
        kind: 'pull_request',
        title: '#9 Abandoned spike',
        observedAt: daysBefore(1),
        metadata: { number: 9, state: 'closed', merged: false },
      }),
    ]);

    expect(changes).toEqual([]);
  });

  it('reports a failed build and a recovered one', () => {
    const changes = evidenceChanges(PROJECT_ID, [
      workflowRun('CI', 'failure', daysBefore(1), { id: 'e-ci' }),
      workflowRun('Deploy', 'success', daysBefore(2), { id: 'e-deploy' }),
      workflowRun('Nightly', 'timed_out', daysBefore(3), { id: 'e-nightly' }),
      workflowRun('Release', 'startup_failure', daysBefore(4), { id: 'e-release' }),
      /* Neutral conclusions must never raise an alarm. */
      workflowRun('Lint', 'cancelled', daysBefore(5), { id: 'e-lint' }),
    ]);

    expect(changes.map((change) => [change.kind, change.summary])).toEqual([
      ['workflow_failed', 'CI failed'],
      ['workflow_recovered', 'Deploy is green'],
      ['workflow_failed', 'Nightly failed'],
      ['workflow_failed', 'Release failed'],
    ]);
    expect(changes[0]?.evidenceIds).toEqual(['e-ci']);
  });

  it('judges each workflow by its newest run only', () => {
    const recovered = evidenceChanges(PROJECT_ID, [
      workflowRun('CI', 'failure', daysBefore(3), { id: 'e-old' }),
      workflowRun('CI', 'success', daysBefore(1), { id: 'e-new' }),
    ]);
    const stillFailing = evidenceChanges(PROJECT_ID, [
      workflowRun('CI', 'success', daysBefore(3), { id: 'e-old' }),
      workflowRun('CI', 'failure', daysBefore(1), { id: 'e-new' }),
    ]);

    expect(recovered.map((change) => [change.kind, change.evidenceIds])).toEqual([
      ['workflow_recovered', ['e-new']],
    ]);
    expect(stillFailing.map((change) => [change.kind, change.evidenceIds])).toEqual([
      ['workflow_failed', ['e-new']],
    ]);
  });

  it('takes provenance from the source system, so owner-entered evidence is never verified', () => {
    const changes = evidenceChanges(PROJECT_ID, [
      makeMergedPr({ id: 'e-github', projectId: PROJECT_ID, observedAt: daysBefore(1) }),
      makeOpenPr({
        id: 'e-manual',
        projectId: PROJECT_ID,
        sourceSystem: 'manual',
        observedAt: daysBefore(2),
      }),
    ]);

    expect(changes.map((change) => [change.evidenceIds[0], change.provenance])).toEqual([
      ['e-github', 'verified'],
      ['e-manual', 'manual'],
    ]);
  });
});
