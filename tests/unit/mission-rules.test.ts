import { describe, expect, it } from 'vitest';
import { ConflictError, ValidationError } from '@/domain/errors';
import {
  MISSION_STATES,
  isReadOnlyMissionType,
  type Mission,
  type MissionState,
} from '@/domain/mission';
import {
  MISSION_TRANSITIONS,
  allowedNextStates,
  assertTransition,
  canClaimMission,
  canQueueMission,
  canResumeMission,
  findTransition,
} from '@/domain/mission-state';
import { classifyMissionRisk, inferMissionType } from '@/domain/mission-risk';
import { classifyIntake, deriveMissionTitle, extractProjectHint } from '@/domain/mission-intake';
import { assessProjectGate, buildClarificationQuestions } from '@/domain/mission-clarification';
import { planFactsChanged } from '@/domain/mission-plan';
import {
  assertInsideWorkspace,
  assertMissionBranchName,
  buildBranchName,
  evaluatePush,
  isInsideWorkspace,
  missionWorkspaceDirectory,
  normalisePathForComparison,
  slugifyForBranch,
} from '@/domain/workspace-safety';
import { boundText, containsSecret, redactDeep, redactSecrets } from '@/domain/redaction';
import { deriveWorkerHealth, type JarvisWorker } from '@/domain/worker';

/**
 * The deterministic core of Mission Control.
 *
 * Everything here is a pure function, so these tests exercise exactly the code that decides what
 * Jarvis will and will not do — not a simplified restatement of it.
 */

const MISSION_ID = '11111111-2222-4333-8444-555555555555';

function mission(overrides: Partial<Mission> = {}): Mission {
  return {
    id: MISSION_ID,
    projectId: 'project-1',
    ownerLogin: 'owner',
    rawRequest: 'Add invoice scanning',
    title: 'Add invoice scanning',
    description: null,
    type: 'code_change',
    riskLevel: 'moderate',
    riskRuleIds: [],
    riskReasons: [],
    state: 'awaiting_plan_approval',
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

/* ------------------------------------------------------------ state machine */

describe('mission state machine', () => {
  it('refuses to jump from draft straight to running', () => {
    expect(() => assertTransition('draft', 'running', 'owner')).toThrow(ConflictError);
  });

  it('never lets a worker approve a plan or an owner start a run', () => {
    expect(() => assertTransition('awaiting_plan_approval', 'queued', 'worker')).toThrow(
      ConflictError,
    );
    expect(() => assertTransition('preparing_workspace', 'running', 'owner')).toThrow(
      ConflictError,
    );
  });

  it('treats a repeated report of the same state as a no-op rather than an error', () => {
    expect(assertTransition('running', 'running', 'worker')).toBeNull();
  });

  it('has no path that resumes a stopped mission without an owner action', () => {
    const fromStopped = MISSION_TRANSITIONS.filter((entry) => entry.from === 'stopped');
    expect(fromStopped.every((entry) => entry.actors.includes('owner'))).toBe(true);
    expect(findTransition('stopped', 'running')).toBeNull();
    expect(findTransition('stopped', 'claimed')).toBeNull();
  });

  it('never allows a completed or cancelled mission to be claimed', () => {
    expect(findTransition('completed', 'claimed')).toBeNull();
    expect(findTransition('cancelled', 'claimed')).toBeNull();
    expect(findTransition('completed', 'queued')).toBeNull();
  });

  it('only reaches completed from a state where work genuinely finished', () => {
    const into = MISSION_TRANSITIONS.filter((entry) => entry.to === 'completed').map(
      (entry) => entry.from,
    );
    expect(into.sort()).toEqual(['pull_request_ready', 'running', 'verifying']);
  });

  it('lists every state as reachable or terminal, so none is orphaned', () => {
    const reachable = new Set<MissionState>(['draft']);
    for (const transition of MISSION_TRANSITIONS) reachable.add(transition.to);
    for (const state of MISSION_STATES) expect(reachable.has(state)).toBe(true);
  });

  it('reports the moves an actor may make from a state', () => {
    expect(allowedNextStates('queued', 'worker')).toEqual(['claimed']);
    expect(allowedNextStates('queued', 'owner')).toContain('cancelled');
    expect(allowedNextStates('queued', 'owner')).not.toContain('claimed');
  });
});

/* -------------------------------------------------------------------- guards */

describe('canQueueMission', () => {
  const base = {
    projectStatus: 'active' as const,
    projectArchived: false,
    planIsReviewOnly: true,
  };

  it('allows an approved, current plan on an active project', () => {
    expect(canQueueMission({ mission: mission(), ...base }).ok).toBe(true);
  });

  it('refuses a prohibited mission outright', () => {
    const result = canQueueMission({ mission: mission({ riskLevel: 'prohibited' }), ...base });
    expect(result.ok).toBe(false);
    expect(result.rule).toBe('R-MQ1');
  });

  it('refuses when the approved version is not the current one', () => {
    const result = canQueueMission({
      mission: mission({ currentPlanVersion: 2, approvedPlanVersion: 1 }),
      ...base,
    });
    expect(result.ok).toBe(false);
    expect(result.rule).toBe('R-MQ6');
    expect(result.reason).toContain('version 2 is current');
  });

  it('refuses an unapproved plan', () => {
    const result = canQueueMission({ mission: mission({ approvedPlanVersion: null }), ...base });
    expect(result.rule).toBe('R-MQ5');
  });

  it('refuses an archived project even with an approved plan', () => {
    expect(canQueueMission({ mission: mission(), ...base, projectArchived: true }).rule).toBe(
      'R-MQ3',
    );
    expect(canQueueMission({ mission: mission(), ...base, projectStatus: 'archived' }).rule).toBe(
      'R-MQ3',
    );
  });

  it('refuses a paused project without an explicit override, and allows it with one', () => {
    expect(canQueueMission({ mission: mission(), ...base, projectStatus: 'paused' }).rule).toBe(
      'R-MQ7',
    );
    expect(
      canQueueMission({
        mission: mission({ executionOverrideAt: '2026-01-01T00:00:00.000Z' }),
        ...base,
        projectStatus: 'paused',
      }).ok,
    ).toBe(true);
  });

  it('refuses a high-risk mission unless its delivery is review-only', () => {
    expect(
      canQueueMission({
        mission: mission({ riskLevel: 'high' }),
        ...base,
        planIsReviewOnly: false,
      }).rule,
    ).toBe('R-MQ8');
    expect(canQueueMission({ mission: mission({ riskLevel: 'high' }), ...base }).ok).toBe(true);
  });

  it('refuses a mission with no project', () => {
    expect(canQueueMission({ mission: mission({ projectId: null }), ...base }).rule).toBe('R-MQ2');
  });
});

describe('canClaimMission', () => {
  const base = { activeMissionCount: 0, concurrencyLimit: 1, workerRevoked: false };
  const queued = mission({ state: 'queued' });

  it('allows a queued mission with a current approval', () => {
    expect(canClaimMission({ mission: queued, ...base }).ok).toBe(true);
  });

  it('refuses a revoked worker before anything else', () => {
    expect(canClaimMission({ mission: queued, ...base, workerRevoked: true }).rule).toBe('R-MC1');
  });

  it('refuses when the concurrency limit is already used', () => {
    expect(canClaimMission({ mission: queued, ...base, activeMissionCount: 1 }).rule).toBe('R-MC5');
  });

  it('refuses a mission that already has an active run', () => {
    expect(
      canClaimMission({ mission: mission({ state: 'queued', activeRunId: 'run-1' }), ...base })
        .rule,
    ).toBe('R-MC4');
  });

  it('refuses when the plan moved on after approval', () => {
    expect(
      canClaimMission({
        mission: mission({ state: 'queued', currentPlanVersion: 3, approvedPlanVersion: 2 }),
        ...base,
      }).rule,
    ).toBe('R-MC3');
  });
});

describe('canResumeMission', () => {
  const base = { workerConnected: true, workspacePreserved: true };

  it('resumes a paused mission whose worker and workspace are intact', () => {
    expect(canResumeMission({ mission: mission({ state: 'paused' }), ...base }).ok).toBe(true);
  });

  it('never resumes a stopped mission — it must be retried as a new attempt', () => {
    const result = canResumeMission({ mission: mission({ state: 'stopped' }), ...base });
    expect(result.rule).toBe('R-MR1');
    expect(result.reason).toContain('Retry it as a new attempt');
  });

  it('refuses when the plan changed while paused', () => {
    expect(
      canResumeMission({
        mission: mission({ state: 'paused', currentPlanVersion: 2, approvedPlanVersion: 1 }),
        ...base,
      }).rule,
    ).toBe('R-MR3');
  });

  it('refuses when the worker is gone or the workspace is not preserved', () => {
    expect(
      canResumeMission({
        mission: mission({ state: 'paused' }),
        ...base,
        workerConnected: false,
      }).rule,
    ).toBe('R-MR4');
    expect(
      canResumeMission({
        mission: mission({ state: 'paused' }),
        ...base,
        workspacePreserved: false,
      }).rule,
    ).toBe('R-MR5');
  });
});

/* ----------------------------------------------------------- risk classifier */

describe('classifyMissionRisk', () => {
  const prohibited = [
    'force push the fix to main',
    'rewrite the git history to squash those commits',
    'merge the pull request into main once tests pass',
    'delete the repository and start again',
    'add a new GitHub Actions secret for the API key',
    'change the branch protection settings',
    'upload the build to TestFlight',
    'update the provisioning profile',
    'publish a release for version 2',
    'deploy to production once it builds',
    'send money to this account',
    'email the customers about the outage',
    'disable authentication on the admin route',
    'skip the failing tests so the build goes green',
    'modify the Jarvis security policy to allow pushes',
  ];

  it.each(prohibited)('refuses: %s', (text) => {
    const result = classifyMissionRisk({ text });
    expect(result.level).toBe('prohibited');
    expect(result.ruleIds.length).toBeGreaterThan(0);
    expect(result.refusal).toContain('Jarvis will not run this mission.');
  });

  it('refuses a prohibited operation even when it is phrased as research', () => {
    const result = classifyMissionRisk({ text: 'just research how to force push to main' });
    expect(result.level).toBe('prohibited');
  });

  it('classifies authentication and payment work as high risk', () => {
    expect(classifyMissionRisk({ text: 'refactor the login session handling' }).level).toBe('high');
    expect(classifyMissionRisk({ text: 'fix the stripe subscription bug' }).level).toBe('high');
    expect(classifyMissionRisk({ text: 'add a database migration for orders' }).level).toBe('high');
  });

  it('classifies docs and tests as low risk', () => {
    expect(classifyMissionRisk({ text: 'fix a typo in the readme' }).level).toBe('low');
    expect(classifyMissionRisk({ text: 'add tests for the parser' }).level).toBe('low');
  });

  it('treats an unrecognised request as an ordinary code change, not as harmless', () => {
    const result = classifyMissionRisk({ text: 'blorp the frobnicator' });
    expect(result.level).toBe('moderate');
    expect(result.ruleIds).toContain('R-RISK-D01');
  });

  it('forces a read-only level for a read-only mission type', () => {
    expect(
      classifyMissionRisk({ text: 'refactor the auth module', type: 'project_review' }).level,
    ).toBe('read_only');
  });

  it('raises a read-only-sounding request to low when the type writes files', () => {
    expect(
      classifyMissionRisk({ text: 'review and tidy the docs', type: 'documentation' }).level,
    ).toBe('low');
  });

  it('also scans the owner’s constraints, not only the request', () => {
    expect(
      classifyMissionRisk({ text: 'update the readme', constraints: ['force push when done'] })
        .level,
    ).toBe('prohibited');
  });
});

describe('inferMissionType', () => {
  it.each([
    ['research whether this app already exists', 'research_report'],
    ['review the repository and find technical debt', 'project_review'],
    ['investigate why the build fails', 'investigation'],
    ['add tests for the invoice parser', 'test_improvement'],
    ['fix a typo in the readme', 'documentation'],
    ['fix the crash on startup', 'bug_fix'],
    ['upgrade the react dependency', 'repository_maintenance'],
    ['add invoice scanning to the app', 'code_change'],
  ])('reads "%s" as %s', (text, expected) => {
    expect(inferMissionType(text)).toBe(expected);
  });
});

/* -------------------------------------------------------------------- intake */

describe('classifyIntake', () => {
  it('keeps status questions as status questions', () => {
    for (const text of [
      'Where are we on CoreCredit?',
      'What changed?',
      'What needs me?',
      'Which projects are blocked?',
    ]) {
      expect(classifyIntake(text).kind).toBe('status_query');
    }
  });

  it('reads work as a new mission', () => {
    const result = classifyIntake('Add invoice scanning to OffRent');
    expect(result.kind).toBe('new_mission');
    expect(result.subject).toBe('offrent');
    expect(result.missionType).toBe('code_change');
  });

  it('reads a control phrase as a mission command', () => {
    const result = classifyIntake('Pause the OffRent mission');
    expect(result.kind).toBe('mission_command');
    expect(result.action).toBe('pause');
    expect(result.subject).toBe('offrent');
  });

  it('refuses a prohibited request whatever form it takes', () => {
    for (const text of ['Send money to this account', 'Can you force push to main?']) {
      const result = classifyIntake(text);
      expect(result.kind).toBe('prohibited');
      expect(result.refusal).toBeTruthy();
    }
  });

  it('extracts a project hint only from a trailing preposition', () => {
    expect(extractProjectHint('add invoice scanning to offrent')).toBe('offrent');
    expect(extractProjectHint('add invoice scanning')).toBeNull();
  });

  it('derives a readable title without the polite preamble', () => {
    expect(deriveMissionTitle('please add invoice scanning to OffRent. It should use OCR.')).toBe(
      'Add invoice scanning to OffRent.',
    );
    expect(deriveMissionTitle('x'.repeat(300)).length).toBeLessThanOrEqual(160);
  });
});

/* ------------------------------------------------------------- clarification */

describe('buildClarificationQuestions', () => {
  const draft = {
    rawRequest: 'Add invoice scanning',
    type: 'code_change' as const,
    riskLevel: 'moderate' as const,
    projectId: 'project-1',
    deliverable: null,
    acceptanceCriteria: [] as string[],
    constraints: [] as string[],
    doNotTouch: [] as string[],
    sourceId: null,
  };
  const project = {
    name: 'OffRent',
    status: 'active' as const,
    type: 'software' as const,
    archived: false,
    goal: null,
  };

  it('asks which project first when there is none', () => {
    const questions = buildClarificationQuestions({
      mission: { ...draft, projectId: null },
      project: null,
      repositoryChoices: [],
      alreadyAsked: [],
    });
    expect(questions[0]?.topic).toBe('project');
  });

  it('asks about a paused project before anything else', () => {
    const questions = buildClarificationQuestions({
      mission: draft,
      project: { ...project, status: 'paused' },
      repositoryChoices: [],
      alreadyAsked: [],
    });
    expect(questions[0]?.id).toBe('paused_project');
  });

  it('asks which repository only when there is genuinely more than one', () => {
    const one = buildClarificationQuestions({
      mission: draft,
      project,
      repositoryChoices: [{ id: 'a', fullName: 'me/a' }],
      alreadyAsked: [],
    });
    expect(one.some((question) => question.topic === 'repository')).toBe(false);

    const two = buildClarificationQuestions({
      mission: draft,
      project,
      repositoryChoices: [
        { id: 'a', fullName: 'me/a' },
        { id: 'b', fullName: 'me/b' },
      ],
      alreadyAsked: [],
    });
    expect(two.some((question) => question.topic === 'repository')).toBe(true);
  });

  it('asks for acceptance criteria on moderate work but not on a read-only mission', () => {
    expect(
      buildClarificationQuestions({
        mission: draft,
        project,
        repositoryChoices: [],
        alreadyAsked: [],
      }).some((question) => question.topic === 'acceptance'),
    ).toBe(true);

    expect(
      buildClarificationQuestions({
        mission: { ...draft, type: 'research_report', riskLevel: 'read_only' },
        project,
        repositoryChoices: [],
        alreadyAsked: [],
      }).some((question) => question.topic === 'acceptance'),
    ).toBe(false);
  });

  it('never asks more than three at a time, and never repeats an answered question', () => {
    const questions = buildClarificationQuestions({
      mission: { ...draft, riskLevel: 'high', rawRequest: 'fix it' },
      project: { ...project, type: 'ios_app', status: 'paused' },
      repositoryChoices: [
        { id: 'a', fullName: 'me/a' },
        { id: 'b', fullName: 'me/b' },
      ],
      alreadyAsked: [],
    });
    expect(questions.length).toBeLessThanOrEqual(3);

    const skipped = buildClarificationQuestions({
      mission: { ...draft, riskLevel: 'high' },
      project: { ...project, status: 'paused' },
      repositoryChoices: [],
      alreadyAsked: ['paused_project'],
    });
    expect(skipped.some((question) => question.id === 'paused_project')).toBe(false);
  });

  it('asks nothing when everything material is already known', () => {
    const questions = buildClarificationQuestions({
      mission: {
        ...draft,
        acceptanceCriteria: ['Invoices are scanned and the suite is green.'],
        rawRequest: 'Add invoice scanning so uploaded PDFs are parsed into line items.',
      },
      project,
      repositoryChoices: [{ id: 'a', fullName: 'me/a' }],
      alreadyAsked: [],
    });
    expect(questions).toEqual([]);
  });
});

describe('assessProjectGate', () => {
  it('blocks planning and execution for an archived project', () => {
    const gate = assessProjectGate({ status: 'active', archived: true, name: 'X' }, 'moderate');
    expect(gate.canPlan).toBe(false);
    expect(gate.canExecute).toBe(false);
  });

  it('allows planning but not execution for a paused project', () => {
    const gate = assessProjectGate({ status: 'paused', archived: false, name: 'X' }, 'moderate');
    expect(gate.canPlan).toBe(true);
    expect(gate.canExecute).toBe(false);
    expect(gate.requiresOverride).toBe(true);
  });

  it('allows a blocked project to plan without pretending the mission fixes the blocker', () => {
    const gate = assessProjectGate({ status: 'blocked', archived: false, name: 'X' }, 'moderate');
    expect(gate.canExecute).toBe(true);
    expect(gate.notice).toContain('does not assume');
  });
});

/* ---------------------------------------------------------- branch and paths */

describe('branch names', () => {
  it('builds a predictable jarvis/<id>-<slug> name', () => {
    expect(buildBranchName(MISSION_ID, 'Add invoice scanning')).toBe(
      `jarvis/${MISSION_ID}-add-invoice-scanning`,
    );
  });

  it.each([
    ['; rm -rf /', 'rm-rf'],
    ['--upload-pack=evil', 'upload-pack-evil'],
    ['../../etc/passwd', 'etc-passwd'],
    ['feat: café ☕ support', 'feat-cafe-support'],
    ['   ', ''],
    ['-leading-dash', 'leading-dash'],
  ])('strips %s down to a safe slug', (input, expected) => {
    expect(slugifyForBranch(input)).toBe(expected);
  });

  it('falls back to "mission" when nothing survives sanitisation', () => {
    expect(buildBranchName(MISSION_ID, ';;;')).toBe(`jarvis/${MISSION_ID}-mission`);
  });

  it('caps the slug length', () => {
    const branch = buildBranchName(MISSION_ID, 'a'.repeat(200));
    expect(branch.length).toBeLessThanOrEqual(`jarvis/${MISSION_ID}-`.length + 40);
  });

  it('rejects a branch name that did not come from buildBranchName', () => {
    for (const bad of ['main', 'jarvis/main', `jarvis/${MISSION_ID}`, 'feature/x', '']) {
      expect(() => assertMissionBranchName(bad)).toThrow(ValidationError);
    }
  });

  it('rejects a non-uuid mission id', () => {
    expect(() => buildBranchName('not-a-uuid', 'x')).toThrow(ValidationError);
  });
});

describe('workspace paths', () => {
  it('normalises traversal without touching the filesystem', () => {
    expect(normalisePathForComparison('/work/a/../b')).toBe('/work/b');
    expect(normalisePathForComparison('/work/./a//b/')).toBe('/work/a/b');
    expect(normalisePathForComparison('C:\\work\\a')).toBe('C:/work/a');
  });

  it('accepts the root and its descendants', () => {
    expect(isInsideWorkspace('/work', '/work')).toBe(true);
    expect(isInsideWorkspace('/work', '/work/mission/repo/src/index.ts')).toBe(true);
  });

  it('rejects escapes, including a sibling that shares a name prefix', () => {
    expect(isInsideWorkspace('/work', '/work/../etc/passwd')).toBe(false);
    expect(isInsideWorkspace('/work', '/etc/passwd')).toBe(false);
    /* The classic off-by-one: /work-evil must not look like it is inside /work. */
    expect(isInsideWorkspace('/work', '/work-evil/secrets')).toBe(false);
    expect(isInsideWorkspace('/work/mission-1', '/work/mission-10')).toBe(false);
  });

  it('throws with a safe message rather than echoing the whole path', () => {
    expect(() => assertInsideWorkspace('/work', '/etc/passwd')).toThrow(ValidationError);
  });

  it('derives a mission directory only from a valid id', () => {
    expect(missionWorkspaceDirectory('/work/', MISSION_ID)).toBe(`/work/${MISSION_ID}`);
    expect(() => missionWorkspaceDirectory('/work', '../evil')).toThrow(ValidationError);
  });
});

/* ---------------------------------------------------------------- push rules */

describe('evaluatePush', () => {
  const branch = `jarvis/${MISSION_ID}-add-thing`;
  const base = { remote: 'origin', branch, defaultBranch: 'main' };

  it('allows a plain push of the mission branch', () => {
    expect(evaluatePush({ ...base, args: ['--set-upstream', 'origin', branch] }).allowed).toBe(
      true,
    );
  });

  it('refuses anything that is not a mission branch', () => {
    expect(evaluatePush({ ...base, branch: 'main', args: [] }).rule).toBe('R-PUSH1');
    expect(evaluatePush({ ...base, branch: 'feature/x', args: [] }).rule).toBe('R-PUSH1');
  });

  it('refuses a push to the default branch even if it were somehow named like one', () => {
    expect(evaluatePush({ ...base, defaultBranch: branch, args: [] }).rule).toBe('R-PUSH2');
  });

  it.each([
    ['--force'],
    ['-f'],
    ['--force-with-lease'],
    ['--mirror'],
    ['--all'],
    ['--tags'],
    ['--delete'],
  ])('refuses %s', (flag) => {
    expect(evaluatePush({ ...base, args: [flag, 'origin', branch] }).rule).toBe('R-PUSH3');
  });

  it('refuses a forcing refspec and a deleting refspec', () => {
    expect(evaluatePush({ ...base, args: ['origin', `+${branch}`] }).rule).toBe('R-PUSH4');
    expect(evaluatePush({ ...base, args: ['origin', `:${branch}`] }).rule).toBe('R-PUSH5');
  });

  it('refuses a refspec that updates a different branch', () => {
    expect(evaluatePush({ ...base, args: ['origin', `${branch}:main`] }).rule).toBe('R-PUSH6');
    expect(
      evaluatePush({ ...base, args: ['origin', `refs/heads/${branch}:refs/heads/main`] }).rule,
    ).toBe('R-PUSH6');
  });

  it('allows the explicit same-name refspec the worker actually uses', () => {
    expect(
      evaluatePush({
        ...base,
        args: ['--set-upstream', 'origin', `refs/heads/${branch}:refs/heads/${branch}`],
      }).allowed,
    ).toBe(true);
  });
});

/* --------------------------------------------------------------- redaction */

describe('redaction', () => {
  it.each([
    ['ghp_abcdefghijklmnopqrstuvwxyz0123456789'],
    ['github_pat_11ABCDEFG0abcdefghijklmnop'],
    ['sk-ant-api03-abcdefghijklmnopqrstuvwxyz'],
    ['jarvisw_11111111-2222-4333-8444-555555555555.abcdefghijklmnopqrstuvwxyz'],
    ['AKIAIOSFODNN7EXAMPLE'],
  ])('removes %s', (secret) => {
    const output = redactSecrets(`the token is ${secret} ok`);
    expect(output).not.toContain(secret);
    expect(output).toContain('[redacted]');
  });

  it('removes credentials from a URL, a header and an assignment', () => {
    expect(redactSecrets('https://user:hunter2@github.com/me/x.git')).not.toContain('hunter2');
    expect(redactSecrets('Authorization: Bearer abcdef1234567890')).not.toContain('abcdef123');
    expect(redactSecrets('ANTHROPIC_API_KEY=abcdef1234567890')).not.toContain('abcdef123');
    expect(redactSecrets('MY_SECRET_TOKEN: "supersecretvalue"')).not.toContain('supersecret');
  });

  it('leaves ordinary text alone', () => {
    const text = 'Added invoice scanning and updated the tests.';
    expect(redactSecrets(text)).toBe(text);
    expect(containsSecret(text)).toBe(false);
  });

  it('does not leak state between calls on a global regex', () => {
    const secret = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
    for (let index = 0; index < 3; index += 1) {
      expect(redactSecrets(secret)).toBe('[redacted]');
    }
  });

  it('drops any value whose key name says it is a credential', () => {
    const output = redactDeep({ apiKey: 'plainlooking', nested: { token: 'x' } }) as Record<
      string,
      unknown
    >;
    expect(output.apiKey).toBe('[redacted]');
    expect((output.nested as Record<string, unknown>).token).toBe('[redacted]');
  });

  it('bounds deep and wide structures rather than storing them', () => {
    let deep: unknown = 'leaf';
    for (let index = 0; index < 12; index += 1) deep = { next: deep };
    expect(JSON.stringify(redactDeep(deep))).toContain('[truncated]');

    const wide = redactDeep(new Array(500).fill('x')) as unknown[];
    expect(wide.length).toBe(200);
  });

  it('truncates text on a boundary and says that it did', () => {
    expect(boundText('abcdef', 10)).toBe('abcdef');
    expect(boundText('x'.repeat(100), 30)).toContain('[truncated]');
    expect(boundText('x'.repeat(100), 30).length).toBeLessThanOrEqual(30);
  });
});

/* ------------------------------------------------------------ worker health */

describe('deriveWorkerHealth', () => {
  const now = new Date('2026-01-01T12:00:00.000Z');
  const worker = (overrides: Partial<JarvisWorker> = {}): JarvisWorker => ({
    id: 'worker-1',
    name: 'macbook',
    tokenPrefix: 'jarvisw_1111',
    status: 'idle',
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
    lastHeartbeatAt: '2026-01-01T11:59:50.000Z',
    lastActivityAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    rotatedAt: null,
    revokedAt: null,
    revokedReason: null,
    ...overrides,
  });

  it('reports a recent heartbeat as idle', () => {
    expect(deriveWorkerHealth(worker(), now).effectiveStatus).toBe('idle');
  });

  it('reports busy when it holds a mission', () => {
    expect(deriveWorkerHealth(worker({ currentMissionId: 'mission-1' }), now).effectiveStatus).toBe(
      'busy',
    );
  });

  it('reports unhealthy past the grace period and disconnected past the cutoff', () => {
    expect(
      deriveWorkerHealth(worker({ lastHeartbeatAt: '2026-01-01T11:59:00.000Z' }), now)
        .effectiveStatus,
    ).toBe('unhealthy');
    expect(
      deriveWorkerHealth(worker({ lastHeartbeatAt: '2026-01-01T11:50:00.000Z' }), now)
        .effectiveStatus,
    ).toBe('disconnected');
  });

  it('says a disconnected worker’s mission is preserved rather than failed', () => {
    const health = deriveWorkerHealth(worker({ lastHeartbeatAt: '2026-01-01T11:00:00.000Z' }), now);
    expect(health.explanation).toContain('preserved, not failed');
  });

  it('reports a connected worker with no runtime as unhealthy, with the reason', () => {
    const health = deriveWorkerHealth(
      worker({ runtimeAvailable: false, runtimeDetail: 'ANTHROPIC_API_KEY is not set' }),
      now,
    );
    expect(health.effectiveStatus).toBe('unhealthy');
    expect(health.explanation).toContain('ANTHROPIC_API_KEY');
  });

  it('reports revoked and never-connected distinctly', () => {
    expect(
      deriveWorkerHealth(worker({ revokedAt: '2026-01-01T00:00:00.000Z' }), now).effectiveStatus,
    ).toBe('revoked');
    expect(deriveWorkerHealth(worker({ lastHeartbeatAt: null }), now).effectiveStatus).toBe(
      'registered',
    );
  });
});

/* ------------------------------------------------------------- plan drift */

describe('planFactsChanged', () => {
  const facts = {
    summary: 's',
    proposedOutcome: 'o',
    assumptions: [],
    scope: [],
    outOfScope: [],
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
    estimatedComplexity: 'small' as const,
    withinRequestedScope: true,
    reviewOnlyDelivery: true,
    evidenceIds: [],
    repositoryFacts: {
      defaultBranch: 'main',
      headSha: 'abc123',
      repositoryFullName: 'me/app',
    },
  };

  it('reports nothing when the repository is unchanged', () => {
    expect(
      planFactsChanged(facts, {
        defaultBranch: 'main',
        headSha: 'abc123',
        repositoryFullName: 'me/app',
      }),
    ).toEqual([]);
  });

  it('reports a changed default branch, identity and head', () => {
    const changes = planFactsChanged(facts, {
      defaultBranch: 'trunk',
      headSha: 'def456',
      repositoryFullName: 'me/other',
    });
    expect(changes).toHaveLength(3);
    expect(changes.join(' ')).toContain('me/other');
    expect(changes.join(' ')).toContain('trunk');
  });
});

describe('isReadOnlyMissionType', () => {
  it('treats investigation, review, research and planning as read-only', () => {
    expect(isReadOnlyMissionType('investigation')).toBe(true);
    expect(isReadOnlyMissionType('project_review')).toBe(true);
    expect(isReadOnlyMissionType('research_report')).toBe(true);
    expect(isReadOnlyMissionType('planning_only')).toBe(true);
    expect(isReadOnlyMissionType('code_change')).toBe(false);
  });
});
