import { describe, expect, it } from 'vitest';
import {
  AGENT_ROLES,
  PERMISSION_PROFILES,
  ROLE_PERMISSION_PROFILE,
  ceilingForRole,
  describeProfile,
  isWithinCeiling,
  narrowProfile,
  profileForRole,
  resolvePermissionProfile,
} from '@/domain/agent-role';
import {
  TASK_STATES,
  TASK_TRANSITIONS,
  allowedNextTaskStates,
  assertTaskTransition,
  isTerminalTaskState,
  satisfiesDependency,
  type TaskProposal,
} from '@/domain/mission-task';
import {
  DEFAULT_GRAPH_LIMITS,
  computeReadiness,
  computeWaves,
  dependsTransitively,
  findCycle,
  graphMaterialContent,
  validateTaskGraph,
} from '@/domain/task-graph';
import {
  filesOutsideWriteSet,
  groupNonOverlapping,
  normaliseWriteSet,
  writeSetCovers,
  writeSetsOverlap,
} from '@/domain/write-set';
import {
  decideVerdict,
  buildReviewContext,
  requiredSpecialistReviews,
  triageFindings,
  verdictAllowsDelivery,
} from '@/domain/mission-review';
import {
  ABSOLUTE_CAPACITY_CEILINGS,
  applyAdjustment,
  canStartTask,
  clampCapacityLimits,
  DEFAULT_CAPACITY_LIMITS,
  formatTokens,
  staleTasks,
  taskExceedsLimits,
} from '@/domain/capacity';
import {
  buildDeliveryStages,
  describeReceipt,
  receiptIsHonest,
  STAGES_JARVIS_NEVER_PERFORMS,
} from '@/domain/completion-receipt';
import {
  dispatchIdentity,
  evaluateCiDispatch,
  evaluateTestFlightDispatch,
  DISABLED_CI_CONTROLLER,
  type CiControllerConfig,
} from '@/domain/ci-dispatch';
import {
  FORBIDDEN_DISPLAY_KEYS,
  findForbiddenDisplayKeys,
  isDisplayDeviceUsable,
  parseDisplayToken,
} from '@/domain/display-device';
import { appProfileSchema, assessTestFlightReadiness, looksLikeCredential } from '@/domain/app-profile';
import { instantiatePlaybook, mergeRequiredChecks, validatePlaybook } from '@/domain/playbook';
import { BUILT_IN_PLAYBOOKS } from '@/server/playbooks/built-in';
import { decomposePlan, deriveWriteSet, researchIsWorthwhile } from '@/domain/task-decomposition';
import type { MissionPlanContent } from '@/domain/mission-plan';
import type { MissionTask } from '@/domain/mission-task';

/**
 * The deterministic core of the multi-agent factory.
 *
 * Every function here is pure, so these tests exercise exactly the code that decides what Jarvis
 * will and will not do — not a restatement of it. Where a rule has a name (R-TG17, R-RV1, R-CI4),
 * the test asserts the name too: a rule that changes id has changed meaning, and an owner reading
 * a refusal deserves the same id the test pins.
 */

/* ------------------------------------------------------------ roles and profiles */

describe('agent roles and permission profiles', () => {
  it('gives every role a profile that resolves', () => {
    for (const role of AGENT_ROLES) {
      expect(() => profileForRole(role)).not.toThrow();
      expect(() => ceilingForRole(role)).not.toThrow();
    }
  });

  it('refuses an unknown profile rather than falling back to a permissive one', () => {
    expect(() => resolvePermissionProfile('anything_goes')).toThrow(/does not exist/);
    expect(() => resolvePermissionProfile('')).toThrow();
    /* The dangerous failure would be a default; assert there is none. */
    expect(() => resolvePermissionProfile('readonly_repo')).not.toThrow();
  });

  it('freezes profiles so a later mutation cannot widen one', () => {
    const profile = PERMISSION_PROFILES.review_only;
    expect(Object.isFrozen(profile)).toBe(true);
    expect(Object.isFrozen(profile.allowedTools)).toBe(true);
    expect(Object.isFrozen(profile.usage)).toBe(true);
    expect(() => {
      (profile.allowedTools as string[]).push('Write');
    }).toThrow();
  });

  it('never lets a reviewer or a researcher hold a write tool', () => {
    for (const role of ['reviewer', 'security_reviewer', 'ux_reviewer', 'researcher'] as const) {
      const profile = profileForRole(role);
      expect(profile.filesystem).not.toBe('write');
      for (const tool of ['Write', 'Edit', 'MultiEdit', 'NotebookEdit']) {
        expect(profile.allowedTools).not.toContain(tool);
      }
    }
  });

  it('gives the coordinator and the integrator no project access at all', () => {
    for (const role of ['coordinator', 'integrator'] as const) {
      const profile = profileForRole(role);
      expect(profile.filesystem).toBe('none');
      expect(profile.shell).toBe(false);
      expect(profile.git).toBe('none');
    }
  });

  it('never gives any profile the ability to push, merge or dispatch by itself', () => {
    for (const id of Object.keys(PERMISSION_PROFILES) as (keyof typeof PERMISSION_PROFILES)[]) {
      const profile = PERMISSION_PROFILES[id];
      /* `branch_and_commit` is the widest git access that exists; there is no `push`. */
      expect(['none', 'read', 'branch_and_commit']).toContain(profile.git);
      /* GitHub access is read at most: delivery is the worker's job, never the agent's. */
      expect(['none', 'read']).toContain(profile.github);
    }
  });

  it('narrows a profile and never widens one', () => {
    const base = profileForRole('builder');
    const narrowed = narrowProfile(base, {
      maxTurns: 1_000,
      timeLimitMs: 10 * 60_000,
      removeTools: ['Bash'],
      denyNetwork: true,
    });
    expect(isWithinCeiling(narrowed, base)).toBe(true);
    /* Asking for more turns than the base allows has no effect. */
    expect(narrowed.usage.maxTurns).toBe(base.usage.maxTurns);
    expect(narrowed.usage.timeLimitMs).toBeLessThanOrEqual(base.usage.timeLimitMs);
    expect(narrowed.allowedTools).not.toContain('Bash');
  });

  it('holds the ceiling property for every role and every narrowing', () => {
    for (const role of AGENT_ROLES) {
      const base = profileForRole(role);
      const narrowed = narrowProfile(base, { denyShell: true, denyNetwork: true, maxTurns: 1 });
      expect(isWithinCeiling(narrowed, base)).toBe(true);
      expect(isWithinCeiling(base, ceilingForRole(role))).toBe(true);
    }
  });

  it('separates the researcher default from its ceiling, so web access is expressible', () => {
    expect(ROLE_PERMISSION_PROFILE.researcher).toBe('readonly_repo');
    expect(ceilingForRole('researcher').id).toBe('readonly_repo_web');
    expect(isWithinCeiling(PERMISSION_PROFILES.readonly_repo_web, ceilingForRole('researcher'))).toBe(
      true,
    );
    /* And the ceiling still refuses anything that writes. */
    expect(
      isWithinCeiling(PERMISSION_PROFILES.workspace_write, ceilingForRole('researcher')),
    ).toBe(false);
  });

  it('describes a profile from the profile rather than from prose that could drift', () => {
    const lines = describeProfile(profileForRole('reviewer'));
    expect(lines.join(' ')).toContain('Reads files');
    expect(lines.join(' ')).toContain('No network access');
    expect(lines.join(' ')).toContain('Cannot dispatch CI');
  });
});

/* ------------------------------------------------------------- task state machine */

describe('the task state machine', () => {
  it('has no move that finishes a task without verification and review', () => {
    /* The one exception is a task that owes neither, which reaches `succeeded` from `running`. */
    const fromRunning = allowedNextTaskStates('running');
    expect(fromRunning).toContain('verifying');
    expect(fromRunning).toContain('awaiting_review');
    /* But a task in `awaiting_review` can only succeed through the system, never the worker. */
    expect(allowedNextTaskStates('awaiting_review', 'worker')).not.toContain('succeeded');
    expect(allowedNextTaskStates('awaiting_review', 'system')).toContain('succeeded');
  });

  it('never lets a finished task restart without an explicit owner action', () => {
    expect(allowedNextTaskStates('failed', 'worker')).toEqual([]);
    expect(allowedNextTaskStates('failed', 'system')).toEqual([]);
    expect(allowedNextTaskStates('failed', 'owner')).toContain('ready');
    expect(allowedNextTaskStates('stopped', 'owner')).toContain('ready');
  });

  it('rejects a move that is not in the table', () => {
    expect(() => assertTaskTransition('blocked', 'succeeded', 'system')).toThrow(/cannot move/);
    expect(() => assertTaskTransition('draft', 'running', 'worker')).toThrow(/cannot move/);
  });

  it('rejects a move the actor may not make', () => {
    expect(() => assertTaskTransition('ready', 'claimed', 'owner')).toThrow(/cannot move a task/);
    expect(() => assertTaskTransition('running', 'pausing', 'worker')).toThrow(/cannot move a task/);
  });

  it('treats a repeated report of the same state as a no-op rather than a failure', () => {
    expect(() => assertTaskTransition('running', 'running', 'worker')).not.toThrow();
  });

  it('lists every state as reachable, so none is orphaned', () => {
    const reachable = new Set<string>(['draft']);
    for (const transition of TASK_TRANSITIONS) reachable.add(transition.to);
    for (const state of TASK_STATES) expect(reachable.has(state)).toBe(true);
  });

  it('counts only succeeded and skipped as satisfying a dependency', () => {
    expect(satisfiesDependency('succeeded')).toBe(true);
    expect(satisfiesDependency('skipped')).toBe(true);
    for (const state of ['failed', 'stopped', 'cancelled', 'running', 'paused'] as const) {
      expect(satisfiesDependency(state)).toBe(false);
    }
  });

  it('marks exactly the finished states as terminal', () => {
    expect(isTerminalTaskState('succeeded')).toBe(true);
    expect(isTerminalTaskState('skipped')).toBe(true);
    expect(isTerminalTaskState('awaiting_review')).toBe(false);
    expect(isTerminalTaskState('repair_required')).toBe(false);
  });
});

/* ------------------------------------------------------------------ write sets */

describe('write sets', () => {
  it('treats a subtree as overlapping its parent in either direction', () => {
    expect(writeSetsOverlap(['src'], ['src/app/page.tsx']).overlaps).toBe(true);
    expect(writeSetsOverlap(['src/app/page.tsx'], ['src']).overlaps).toBe(true);
    expect(writeSetsOverlap(['src'], ['docs']).overlaps).toBe(false);
  });

  it('does not treat a shared prefix as a shared directory', () => {
    /* `src/apple` is not inside `src/app`, and a naive startsWith would say it was. */
    expect(writeSetsOverlap(['src/app'], ['src/apple']).overlaps).toBe(false);
    expect(writeSetCovers(['src/app'], 'src/apple/index.ts')).toBe(false);
    expect(writeSetCovers(['src/app'], 'src/app/index.ts')).toBe(true);
  });

  it('treats the whole repository as overlapping everything', () => {
    expect(writeSetsOverlap(['.'], ['docs']).overlaps).toBe(true);
    expect(filesOutsideWriteSet(['.'], ['anything/at/all.ts'])).toEqual([]);
  });

  it('refuses to let a path escape the repository', () => {
    expect(normaliseWriteSet(['../outside'])).toEqual([]);
    expect(normaliseWriteSet(['src/../../etc'])).toEqual([]);
    expect(writeSetCovers(['src'], '../etc/passwd')).toBe(false);
  });

  it('normalises globs and trailing slashes to the same subtree', () => {
    expect(normaliseWriteSet(['src/app/**'])).toEqual(['src/app']);
    expect(normaliseWriteSet(['src/app/'])).toEqual(['src/app']);
    expect(normaliseWriteSet(['./src/app'])).toEqual(['src/app']);
  });

  it('names the offenders rather than only reporting that there were some', () => {
    const outside = filesOutsideWriteSet(['src'], ['src/a.ts', 'docs/b.md', 'package.json']);
    expect(outside).toEqual(['docs/b.md', 'package.json']);
  });

  it('groups only genuinely disjoint writers together', () => {
    const groups = groupNonOverlapping([
      { declaredWriteSet: ['src'] },
      { declaredWriteSet: ['docs'] },
      { declaredWriteSet: ['src/app'] },
    ]);
    expect(groups).toHaveLength(2);
    expect(groups[0]).toHaveLength(2);
  });
});

/* ------------------------------------------------------------- graph validation */

const task = (overrides: Partial<TaskProposal> & Pick<TaskProposal, 'key' | 'role'>): TaskProposal => ({
  title: `Task ${overrides.key}`,
  description: 'Do the thing.',
  taskType: 'implementation',
  dependsOn: [],
  expectedInputs: [],
  expectedOutputs: [],
  acceptanceCriteria: [],
  workspaceRequirement: 'readonly_clone',
  requiresRepository: true,
  expectedFileAreas: [],
  declaredWriteSet: [],
  maxAttempts: 1,
  repairRound: 0,
  estimatedCost: 'medium',
  ...overrides,
});

const builder = (key: string, writeSet: readonly string[], dependsOn: string[] = []): TaskProposal =>
  task({
    key,
    role: 'builder',
    taskType: 'implementation',
    workspaceRequirement: 'task_workspace',
    declaredWriteSet: [...writeSet],
    dependsOn,
  });

/** The smallest graph that is actually valid: build, verify, review. */
const validGraph = (): TaskProposal[] => [
  builder('tb', ['src']),
  task({ key: 'tv', role: 'verifier', taskType: 'verification', dependsOn: ['tb'], workspaceRequirement: 'integration' }),
  task({
    key: 'tr',
    role: 'reviewer',
    taskType: 'review',
    dependsOn: ['tv'],
    reviewsTaskKey: 'tb',
  }),
];

describe('task graph validation', () => {
  it('accepts the canonical build → verify → review graph', () => {
    const result = validateTaskGraph(validGraph(), { missionWrites: true });
    expect(result.violations).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.waves).toHaveLength(3);
  });

  it('rejects a cycle and names the loop (R-TG14)', () => {
    const result = validateTaskGraph(
      [
        task({ key: 't1', role: 'researcher', dependsOn: ['t2'] }),
        task({ key: 't2', role: 'researcher', dependsOn: ['t1'] }),
      ],
      { missionWrites: false },
    );
    expect(result.ok).toBe(false);
    expect(result.violations.map((v) => v.rule)).toContain('R-TG14');
    expect(findCycle([task({ key: 't1', role: 'researcher', dependsOn: ['t1'] })])).not.toBeNull();
  });

  it('rejects a write mission with no independent review (R-TG16)', () => {
    const result = validateTaskGraph(
      [
        builder('tb', ['src']),
        task({ key: 'tv', role: 'verifier', taskType: 'verification', dependsOn: ['tb'], workspaceRequirement: 'integration' }),
      ],
      { missionWrites: true },
    );
    expect(result.violations.map((v) => v.rule)).toContain('R-TG16');
  });

  it('rejects a write task nothing reviews (R-TG17)', () => {
    const graph = validGraph();
    graph.push(builder('tb2', ['docs'], ['tb']));
    const result = validateTaskGraph(graph, { missionWrites: true });
    expect(result.violations.map((v) => v.rule)).toContain('R-TG17');
  });

  it('rejects a review that would run before verification (R-TG20)', () => {
    const result = validateTaskGraph(
      [
        builder('tb', ['src']),
        task({ key: 'tr', role: 'reviewer', taskType: 'review', dependsOn: ['tb'], reviewsTaskKey: 'tb' }),
        task({ key: 'tv', role: 'verifier', taskType: 'verification', dependsOn: ['tb'], workspaceRequirement: 'integration' }),
      ],
      { missionWrites: true },
    );
    expect(result.violations.map((v) => v.rule)).toContain('R-TG20');
  });

  it('rejects two parallel writers whose write sets overlap (R-TG22)', () => {
    const result = validateTaskGraph(
      [
        builder('tb', ['src']),
        builder('tc', ['src/app']),
        task({ key: 'tv', role: 'verifier', taskType: 'verification', dependsOn: ['tb', 'tc'], workspaceRequirement: 'integration' }),
        task({ key: 'tr', role: 'reviewer', taskType: 'review', dependsOn: ['tv'], reviewsTaskKey: 'tb' }),
      ],
      { missionWrites: true, limits: { maxWriteTasks: 2 } },
    );
    expect(result.violations.map((v) => v.rule)).toContain('R-TG22');
  });

  it('accepts two parallel writers whose write sets are disjoint', () => {
    const result = validateTaskGraph(
      [
        builder('tb', ['src']),
        builder('tc', ['docs']),
        task({ key: 'tv', role: 'verifier', taskType: 'verification', dependsOn: ['tb', 'tc'], workspaceRequirement: 'integration' }),
        task({ key: 'tr', role: 'reviewer', taskType: 'review', dependsOn: ['tv'], reviewsTaskKey: 'tb' }),
        task({ key: 'ts', role: 'reviewer', taskType: 'review', dependsOn: ['tv'], reviewsTaskKey: 'tc' }),
      ],
      { missionWrites: true, limits: { maxWriteTasks: 2, maxParallelTasks: 3 } },
    );
    expect(result.violations.map((v) => v.rule)).not.toContain('R-TG22');
  });

  it('rejects a non-writer that declares a write set, and a writer that declares none', () => {
    const noSet = validateTaskGraph([builder('tb', [])], { missionWrites: true });
    expect(noSet.violations.map((v) => v.rule)).toContain('R-TG10');

    const reviewerWithSet = validateTaskGraph(
      [task({ key: 'tr', role: 'reviewer', declaredWriteSet: ['src'] })],
      { missionWrites: false },
    );
    expect(reviewerWithSet.violations.map((v) => v.rule)).toContain('R-TG09');
  });

  it('rejects a profile wider than the role allows (R-TG08)', () => {
    const result = validateTaskGraph(
      [task({ key: 'tr', role: 'reviewer', permissionProfileId: 'workspace_write' })],
      { missionWrites: false },
    );
    expect(result.violations.map((v) => v.rule)).toContain('R-TG08');
  });

  it('rejects a missing required specialist (R-TG21)', () => {
    const result = validateTaskGraph(validGraph(), {
      missionWrites: true,
      requiredReviewRoles: ['security_reviewer'],
    });
    expect(result.violations.map((v) => v.rule)).toContain('R-TG21');
  });

  it('rejects a graph beyond the configured limits', () => {
    const many = Array.from({ length: DEFAULT_GRAPH_LIMITS.maxTasks + 1 }, (_, index) =>
      task({ key: `t${index + 1}`, role: 'researcher' }),
    );
    const result = validateTaskGraph(many, { missionWrites: false });
    expect(result.violations.map((v) => v.rule)).toContain('R-TG03');
  });

  it('computes waves in dependency order', () => {
    const waves = computeWaves([
      task({ key: 't1', role: 'researcher' }),
      task({ key: 't2', role: 'researcher' }),
      task({ key: 't3', role: 'researcher', dependsOn: ['t1', 't2'] }),
    ]);
    expect(waves).toEqual([['t1', 't2'], ['t3']]);
  });

  it('finds transitive dependencies', () => {
    const graph = [
      task({ key: 't1', role: 'researcher' }),
      task({ key: 't2', role: 'researcher', dependsOn: ['t1'] }),
      task({ key: 't3', role: 'researcher', dependsOn: ['t2'] }),
    ];
    expect(dependsTransitively(graph, 't3', 't1')).toBe(true);
    expect(dependsTransitively(graph, 't1', 't3')).toBe(false);
  });

  it('fingerprints material content and ignores wording', () => {
    const a = graphMaterialContent(validGraph());
    const reworded = validGraph().map((entry) => ({ ...entry, title: 'Different words entirely' }));
    expect(graphMaterialContent(reworded)).toBe(a);

    const rescoped = validGraph();
    rescoped[0] = builder('tb', ['src', 'docs']);
    expect(graphMaterialContent(rescoped)).not.toBe(a);
  });
});

/* -------------------------------------------------------------------- readiness */

const storedTask = (overrides: Partial<MissionTask> & Pick<MissionTask, 'key' | 'state'>): MissionTask => ({
  id: `id-${overrides.key}`,
  missionId: 'mission-1',
  graphId: 'graph-1',
  graphVersion: 1,
  planVersion: 1,
  title: overrides.key,
  description: '',
  role: 'researcher',
  permissionProfileId: 'readonly_repo',
  taskType: 'research',
  position: 0,
  dependsOn: [],
  expectedInputs: [],
  expectedOutputs: [],
  acceptanceCriteria: [],
  workspaceRequirement: 'readonly_clone',
  requiresRepository: true,
  expectedFileAreas: [],
  declaredWriteSet: [],
  actualChangedFiles: [],
  assignedWorkerId: null,
  activeRunId: null,
  attempt: 0,
  maxAttempts: 1,
  maxTurns: null,
  timeLimitMs: null,
  maxOutputTokens: null,
  usage: { inputTokens: null, outputTokens: null, totalCostUsd: null, turns: null, durationMs: null },
  reviewsTaskId: null,
  repairRound: 0,
  latestReviewId: null,
  branchName: null,
  baseSha: null,
  headSha: null,
  workspacePath: null,
  workspacePreserved: true,
  failureCode: null,
  failureMessage: null,
  summary: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  startedAt: null,
  finishedAt: null,
  lastActivityAt: null,
  ...overrides,
});

describe('readiness', () => {
  it('promotes only tasks whose dependencies all finished well', () => {
    const result = computeReadiness([
      storedTask({ key: 't1', state: 'succeeded' }),
      storedTask({ key: 't2', state: 'blocked', dependsOn: ['t1'] }),
      storedTask({ key: 't3', state: 'blocked', dependsOn: ['t1', 't2'] }),
    ]);
    expect(result.ready.map((entry) => entry.key)).toEqual(['t2']);
    expect(result.blocked.map((entry) => entry.key)).toEqual(['t3']);
  });

  it('marks a task unreachable when a dependency can never succeed', () => {
    const result = computeReadiness([
      storedTask({ key: 't1', state: 'failed' }),
      storedTask({ key: 't2', state: 'blocked', dependsOn: ['t1'] }),
    ]);
    expect(result.unreachable.map((entry) => entry.key)).toEqual(['t2']);
    expect(result.ready).toEqual([]);
  });

  it('treats a skipped dependency as satisfied, so an optional task does not strand the graph', () => {
    const result = computeReadiness([
      storedTask({ key: 't1', state: 'skipped' }),
      storedTask({ key: 't2', state: 'blocked', dependsOn: ['t1'] }),
    ]);
    expect(result.ready.map((entry) => entry.key)).toEqual(['t2']);
  });
});

/* ---------------------------------------------------------------- review rules */

describe('review verdicts', () => {
  const finding = (severity: 'critical' | 'high' | 'medium', blocks: boolean) => ({
    severity,
    blocksDelivery: blocks,
  });

  it('overrides an approval that stands on a failed required check (R-RV1)', () => {
    const decision = decideVerdict({
      proposedVerdict: 'approved',
      findings: [],
      requiredChecks: [{ outcome: 'failed' }],
    });
    expect(decision.verdict).toBe('repair_required');
    expect(decision.rule).toBe('R-RV1');
    expect(decision.overridden).toBe(true);
  });

  it('overrides an approval that coexists with a blocking finding (R-RV2)', () => {
    const decision = decideVerdict({
      proposedVerdict: 'approved_with_notes',
      findings: [finding('critical', false)],
      requiredChecks: [{ outcome: 'passed' }],
    });
    expect(decision.verdict).toBe('repair_required');
    expect(decision.rule).toBe('R-RV2');
  });

  it('routes an unavailable required check to the owner rather than calling it a pass (R-RV3)', () => {
    const decision = decideVerdict({
      proposedVerdict: 'approved',
      findings: [],
      requiredChecks: [{ outcome: 'unavailable' }],
    });
    expect(decision.verdict).toBe('owner_decision_required');
    expect(decision.rule).toBe('R-RV3');
  });

  it('turns an unevidenced block into an owner decision rather than an unexplained stop (R-RV4)', () => {
    const decision = decideVerdict({
      proposedVerdict: 'blocked',
      findings: [],
      requiredChecks: [{ outcome: 'passed' }],
    });
    expect(decision.verdict).toBe('owner_decision_required');
    expect(decision.rule).toBe('R-RV4');
  });

  it('leaves a well-formed approval alone', () => {
    const decision = decideVerdict({
      proposedVerdict: 'approved',
      findings: [finding('low' as 'medium', false)],
      requiredChecks: [{ outcome: 'passed' }, { outcome: 'not_applicable' }],
    });
    expect(decision.verdict).toBe('approved');
    expect(decision.overridden).toBe(false);
  });

  it('lets only two verdicts deliver', () => {
    expect(verdictAllowsDelivery('approved')).toBe(true);
    expect(verdictAllowsDelivery('approved_with_notes')).toBe(true);
    for (const verdict of ['repair_required', 'owner_decision_required', 'blocked', 'unavailable'] as const) {
      expect(verdictAllowsDelivery(verdict)).toBe(false);
    }
  });

  it('triages critical findings for repair and product judgement to the owner', () => {
    const triaged = triageFindings([
      { key: 'F1', severity: 'critical', blocksDelivery: false, category: 'correctness' },
      { key: 'F2', severity: 'high', blocksDelivery: true, category: 'security' },
      { key: 'F3', severity: 'medium', blocksDelivery: true, category: 'correctness' },
      { key: 'F4', severity: 'low', blocksDelivery: false, category: 'scope' },
      { key: 'F5', severity: 'low', blocksDelivery: false, category: 'documentation' },
    ]);
    const byKey = new Map(triaged.map((entry) => [entry.key, entry.state]));
    expect(byKey.get('F1')).toBe('accepted');
    expect(byKey.get('F2')).toBe('accepted');
    expect(byKey.get('F3')).toBe('owner_decision');
    expect(byKey.get('F4')).toBe('owner_decision');
    expect(byKey.get('F5')).toBe('noted');
  });
});

describe('specialist review triggers', () => {
  const base = {
    projectType: 'software',
    missionType: 'code_change',
    riskLevel: 'moderate',
    canDispatchExternalBuild: false,
  };

  it('requires a security review for authentication, credentials and migrations', () => {
    for (const file of [
      'src/server/auth/session.ts',
      'src/lib/credentials.ts',
      'drizzle/0003_thing.sql',
      'src/app/api/export/route.ts',
      'src/domain/worker-protocol.ts',
    ]) {
      const required = requiredSpecialistReviews({ ...base, changedFiles: [file] });
      expect(required.map((entry) => entry.role)).toContain('security_reviewer');
    }
  });

  it('does not require a security review for ordinary code', () => {
    const required = requiredSpecialistReviews({ ...base, changedFiles: ['src/lib/format.ts'] });
    expect(required.map((entry) => entry.role)).not.toContain('security_reviewer');
  });

  it('requires a UI review for user-facing files', () => {
    const required = requiredSpecialistReviews({ ...base, changedFiles: ['src/components/card.tsx'] });
    expect(required.map((entry) => entry.role)).toContain('ux_reviewer');
  });

  it('requires a release verifier whenever an external build is possible', () => {
    const required = requiredSpecialistReviews({
      ...base,
      changedFiles: ['README.md'],
      canDispatchExternalBuild: true,
    });
    expect(required.map((entry) => entry.role)).toContain('release_verifier');
  });
});

describe('the review context', () => {
  const inputs = {
    missionTitle: 'Add pagination',
    missionRequest: 'Paginate the results list',
    planSummary: 'Add pagination',
    planApproach: 'Add a cursor',
    planScope: ['Paginate'],
    planOutOfScope: ['Merging'],
    acceptanceCriteria: ['Ten per page'],
    graphSummary: 'One builder, one reviewer',
    taskSummaries: [{ key: 'tb', title: 'Build', role: 'builder' }],
    diff: 'diff --git a/x b/x',
    changedFiles: ['x'],
    verification: [
      { check: 'npm test', outcome: 'passed' as const, required: true, detail: 'exit 0' },
      { check: 'npm run e2e', outcome: 'unavailable' as const, required: true, detail: 'no browser' },
    ],
    artifacts: [],
    repositoryInstructions: 'Use tabs.',
    repairScope: [],
    repairRound: 0,
  };

  it('tells the reviewer that unavailable is not a pass', () => {
    const context = buildReviewContext(inputs);
    expect(context).toContain('"unavailable" means the check could not run here. It is not a pass.');
  });

  it('carries the plan, the criteria and the diff but never a builder transcript', () => {
    const context = buildReviewContext(inputs);
    expect(context).toContain('Add a cursor');
    expect(context).toContain('Ten per page');
    expect(context).toContain('diff --git');
    /*
     * The real guarantee is structural — `ReviewContextInput` has no transcript field — so this
     * asserts the shape rather than the text: adding one would fail to compile before it could
     * fail here.
     */
    expect(Object.keys(inputs)).not.toContain('builderTranscript');
    expect(Object.keys(inputs)).not.toContain('previousVerdict');
  });

  it('tells a repair-round reviewer the scope but never the earlier verdict', () => {
    const context = buildReviewContext({
      ...inputs,
      repairRound: 1,
      repairScope: [{ key: 'F1', title: 'Off-by-one' }],
    });
    expect(context).toContain('repair round 1');
    expect(context).toContain('F1: Off-by-one');
    expect(context).toContain('You have not been told what any earlier reviewer concluded');
    expect(context).not.toMatch(/previously (approved|blocked|rejected)/i);
  });

  it('marks the repository instructions as guidance rather than policy', () => {
    expect(buildReviewContext(inputs)).toContain('Not security policy');
  });
});

/* -------------------------------------------------------------------- capacity */

describe('capacity', () => {
  const instance = { activeMissions: 0, activeRuns: 0, posture: 'open' as const };
  const mission = {
    activeRuns: 0,
    activeReadOnly: 0,
    activeWriters: 0,
    outputTokensUsed: 0,
    runtimeMsUsed: 0,
    repairRoundsUsed: 0,
  };

  it('permits a task when everything is within its ceiling', () => {
    const verdict = canStartTask({
      limits: DEFAULT_CAPACITY_LIMITS,
      instance,
      mission,
      task: { role: 'researcher', repairRound: 0 },
      missionAlreadyActive: false,
    });
    expect(verdict.allowed).toBe(true);
  });

  it('refuses everything while stopped, and says waiting will not help (R-CAP1)', () => {
    const verdict = canStartTask({
      limits: DEFAULT_CAPACITY_LIMITS,
      instance: { ...instance, posture: 'stopped' },
      mission,
      task: { role: 'researcher', repairRound: 0 },
      missionAlreadyActive: true,
    });
    expect(verdict.rule).toBe('R-CAP1');
    expect(verdict.retryable).toBe(false);
  });

  it('refuses a second writer within one mission (R-CAP6)', () => {
    const verdict = canStartTask({
      limits: DEFAULT_CAPACITY_LIMITS,
      instance,
      mission: { ...mission, activeWriters: 1, activeRuns: 1 },
      task: { role: 'builder', repairRound: 0 },
      missionAlreadyActive: true,
    });
    expect(verdict.rule).toBe('R-CAP6');
    expect(verdict.retryable).toBe(true);
  });

  it('refuses a repair round past the limit, and says waiting will not help (R-CAP8/9)', () => {
    const past = canStartTask({
      limits: DEFAULT_CAPACITY_LIMITS,
      instance,
      mission,
      task: { role: 'repairer', repairRound: 3 },
      missionAlreadyActive: true,
    });
    expect(past.rule).toBe('R-CAP8');
    expect(past.retryable).toBe(false);

    const used = canStartTask({
      limits: DEFAULT_CAPACITY_LIMITS,
      instance,
      mission: { ...mission, repairRoundsUsed: 2 },
      task: { role: 'repairer', repairRound: 1 },
      missionAlreadyActive: true,
    });
    expect(used.rule).toBe('R-CAP9');
  });

  it('refuses when the mission has spent its token allowance (R-CAP10)', () => {
    const verdict = canStartTask({
      limits: DEFAULT_CAPACITY_LIMITS,
      instance,
      mission: { ...mission, outputTokensUsed: DEFAULT_CAPACITY_LIMITS.maxMissionOutputTokens! },
      task: { role: 'researcher', repairRound: 0 },
      missionAlreadyActive: true,
    });
    expect(verdict.rule).toBe('R-CAP10');
    expect(verdict.retryable).toBe(false);
  });

  it('clamps configuration to the absolute ceilings', () => {
    const clamped = clampCapacityLimits({
      maxActiveRuns: 9999,
      maxParallelWriters: 50,
      maxRepairRounds: 99,
    });
    expect(clamped.maxActiveRuns).toBe(ABSOLUTE_CAPACITY_CEILINGS.maxActiveRuns);
    expect(clamped.maxParallelWriters).toBe(ABSOLUTE_CAPACITY_CEILINGS.maxParallelWriters);
    expect(clamped.maxRepairRounds).toBe(ABSOLUTE_CAPACITY_CEILINGS.maxRepairRounds);
  });

  it('only ever reduces on an owner adjustment', () => {
    const raised = applyAdjustment(DEFAULT_CAPACITY_LIMITS, { maxActiveRuns: 12 });
    expect(raised.maxActiveRuns).toBe(DEFAULT_CAPACITY_LIMITS.maxActiveRuns);
    const lowered = applyAdjustment(DEFAULT_CAPACITY_LIMITS, { maxActiveRuns: 1 });
    expect(lowered.maxActiveRuns).toBe(1);
  });

  it('stops a task that has run past its own limits', () => {
    const overTime = taskExceedsLimits(
      {
        timeLimitMs: 60_000,
        maxOutputTokens: null,
        usage: { inputTokens: null, outputTokens: null, totalCostUsd: null, turns: null, durationMs: null },
        startedAt: '2026-01-01T00:00:00.000Z',
      },
      '2026-01-01T00:05:00.000Z',
    );
    expect(overTime.rule).toBe('R-CAP12');
  });

  it('reports a stalled task separately rather than counting it as productive', () => {
    const stale = staleTasks(
      [
        storedTask({
          key: 't1',
          state: 'running',
          startedAt: '2026-01-01T00:00:00.000Z',
          lastActivityAt: '2026-01-01T00:00:00.000Z',
        }),
        storedTask({ key: 't2', state: 'running', lastActivityAt: '2026-01-01T00:09:59.000Z' }),
      ],
      '2026-01-01T00:10:00.000Z',
      120_000,
    );
    expect(stale.map((entry) => entry.key)).toEqual(['t1']);
  });

  it('formats usage as tokens and never as invented money', () => {
    expect(formatTokens(1_500_000)).toBe('1.5M tokens');
    expect(formatTokens(2_400)).toBe('2k tokens');
    expect(formatTokens(12)).toBe('12 tokens');
    expect(formatTokens(1_500_000)).not.toMatch(/\$/);
  });
});

/* -------------------------------------------------------------- the receipt */

describe('the completion receipt', () => {
  const passing = [
    { check: 'npm test', outcome: 'passed' as const, required: true, blocksDelivery: true, exitCode: 0, detail: null },
  ];
  const approved = [
    {
      reviewerRole: 'reviewer' as const,
      verdict: 'approved' as const,
      repairRound: 0,
      summary: 'Fine.',
      blockingFindings: 0,
      totalFindings: 0,
      diffFingerprint: 'abcdef1234567890',
    },
  ];

  it('never marks merged, deployed or released as reached', () => {
    const stages = buildDeliveryStages({
      hasChangedFiles: true,
      verification: passing,
      reviews: approved,
      pullRequestUrl: 'https://github.com/o/r/pull/1',
      testFlightUploaded: false,
      testFlightEvidence: null,
    });
    for (const stage of STAGES_JARVIS_NEVER_PERFORMS) {
      const row = stages.find((entry) => entry.stage === stage);
      expect(row?.reached).toBe(false);
      expect(row?.unreachableReason).toBeTruthy();
    }
  });

  it('requires evidence for every stage it marks reached', () => {
    const stages = buildDeliveryStages({
      hasChangedFiles: true,
      verification: passing,
      reviews: approved,
      pullRequestUrl: 'https://github.com/o/r/pull/1',
      testFlightUploaded: false,
      testFlightEvidence: null,
    });
    expect(
      receiptIsHonest({
        stages,
      } as Parameters<typeof receiptIsHonest>[0]),
    ).toBe(true);
    for (const stage of stages) {
      if (stage.reached) expect(stage.evidence).toBeTruthy();
    }
  });

  it('does not claim review passed when no verdict approved it', () => {
    const stages = buildDeliveryStages({
      hasChangedFiles: true,
      verification: passing,
      reviews: [{ ...approved[0]!, verdict: 'repair_required' }],
      pullRequestUrl: null,
      testFlightUploaded: false,
      testFlightEvidence: null,
    });
    expect(stages.find((entry) => entry.stage === 'review_completed')?.reached).toBe(false);
  });

  it('describes the highest rung honestly and never says deployed', () => {
    const stages = buildDeliveryStages({
      hasChangedFiles: true,
      verification: passing,
      reviews: approved,
      pullRequestUrl: 'https://github.com/o/r/pull/1',
      testFlightUploaded: false,
      testFlightEvidence: null,
    });
    const description = describeReceipt(stages);
    expect(description).toContain('not merged');
    expect(description).not.toMatch(/deployed|released|production/i);
  });
});

/* ------------------------------------------------------------ CI and TestFlight */

describe('the CI controller', () => {
  const enabled: CiControllerConfig = {
    enabled: true,
    credentialConfigured: true,
    repositories: ['owner/app'],
    workflows: ['testflight.yml'],
    refs: ['main', 'jarvis/*'],
    maxDispatchesPerHour: 4,
  };
  const request = {
    repositoryFullName: 'owner/app',
    workflowFile: 'testflight.yml',
    ref: 'main',
    commitSha: 'a'.repeat(40),
    inputs: {},
    purpose: 'testflight' as const,
  };

  it('is off by default and says so first (R-CI1)', () => {
    const verdict = evaluateCiDispatch(request, DISABLED_CI_CONTROLLER);
    expect(verdict.allowed).toBe(false);
    expect(verdict.rule).toBe('R-CI1');
  });

  it('refuses to run without a credential of its own (R-CI2)', () => {
    const verdict = evaluateCiDispatch(request, { ...enabled, credentialConfigured: false });
    expect(verdict.rule).toBe('R-CI2');
    expect(verdict.reason).toContain('will not borrow');
  });

  it('refuses a repository, workflow or ref that is not allow-listed', () => {
    expect(evaluateCiDispatch({ ...request, repositoryFullName: 'other/app' }, enabled).rule).toBe('R-CI4');
    expect(evaluateCiDispatch({ ...request, workflowFile: 'deploy.yml' }, enabled).rule).toBe('R-CI6');
    expect(evaluateCiDispatch({ ...request, ref: 'release' }, enabled).rule).toBe('R-CI8');
  });

  it('refuses a workflow name that is not a workflow file (R-CI5)', () => {
    expect(evaluateCiDispatch({ ...request, workflowFile: '../../etc/passwd' }, enabled).rule).toBe('R-CI5');
  });

  it('requires an exact commit (R-CI9)', () => {
    expect(evaluateCiDispatch({ ...request, commitSha: 'main' }, enabled).rule).toBe('R-CI9');
  });

  it('rate-limits dispatches (R-CI13)', () => {
    expect(evaluateCiDispatch(request, enabled, { dispatchesThisHour: 4 }).rule).toBe('R-CI13');
  });

  it('permits a fully allow-listed request', () => {
    expect(evaluateCiDispatch(request, enabled).allowed).toBe(true);
    expect(evaluateCiDispatch({ ...request, ref: 'jarvis/anything' }, enabled).allowed).toBe(true);
  });

  it('gives a different identity when anything material changes', () => {
    const base = dispatchIdentity(request);
    expect(dispatchIdentity({ ...request, commitSha: 'b'.repeat(40) })).not.toBe(base);
    expect(dispatchIdentity({ ...request, inputs: { lane: 'beta' } })).not.toBe(base);
    expect(dispatchIdentity({ ...request })).toBe(base);
  });
});

describe('the TestFlight gate', () => {
  const ready = {
    projectType: 'software',
    repositoryAllowListed: true,
    workflowConfigured: true,
    signingConfigurationPresent: true,
    commitSha: 'a'.repeat(40),
    requiredChecksPassed: true,
    reviewApproved: true,
    requestedIdentity: 'identity-1',
    approval: { state: 'approved' as const, identity: 'identity-1', commitSha: 'a'.repeat(40) },
  };

  it('permits only a reviewed, verified, approved, exact commit', () => {
    expect(evaluateTestFlightDispatch(ready).allowed).toBe(true);
  });

  it('refuses an unverified or unreviewed commit as separate, explicit reasons', () => {
    expect(evaluateTestFlightDispatch({ ...ready, requiredChecksPassed: false }).rule).toBe('R-TF6');
    expect(evaluateTestFlightDispatch({ ...ready, reviewApproved: false }).rule).toBe('R-TF7');
  });

  it('refuses when the approval was for a different commit (R-TF11)', () => {
    const verdict = evaluateTestFlightDispatch({ ...ready, requestedIdentity: 'identity-2' });
    expect(verdict.rule).toBe('R-TF11');
    expect(verdict.reason).toContain('no longer applies');
  });

  it('refuses a revoked or already-used approval', () => {
    expect(
      evaluateTestFlightDispatch({ ...ready, approval: { ...ready.approval, state: 'revoked' } }).rule,
    ).toBe('R-TF9');
    expect(
      evaluateTestFlightDispatch({ ...ready, approval: { ...ready.approval, state: 'used' } }).rule,
    ).toBe('R-TF10');
  });

  it('refuses with no approval at all (R-TF8)', () => {
    expect(evaluateTestFlightDispatch({ ...ready, approval: null }).rule).toBe('R-TF8');
  });

  it('refuses when the repository is not allow-listed or has no configured workflow', () => {
    expect(evaluateTestFlightDispatch({ ...ready, repositoryAllowListed: false }).rule).toBe('R-TF2');
    expect(evaluateTestFlightDispatch({ ...ready, workflowConfigured: false }).rule).toBe('R-TF3');
  });
});

/* -------------------------------------------------------------- app profiles */

describe('app profiles', () => {
  it('refuses to store anything that looks like a credential', () => {
    expect(looksLikeCredential('-----BEGIN PRIVATE KEY-----')).toBe(true);
    expect(looksLikeCredential('ghp_abcdefghijklmnopqrstuvwxyz0123456789')).toBe(true);
    expect(looksLikeCredential('sk-ant-api03-abcdefghijklmnopqrstuvwxyz')).toBe(true);
    expect(looksLikeCredential('APP_STORE_CONNECT_KEY')).toBe(false);

    const rejected = appProfileSchema.safeParse({
      appName: '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----',
    });
    expect(rejected.success).toBe(false);
  });

  it('stores the names of signing secrets, never their values', () => {
    const parsed = appProfileSchema.safeParse({ signingSecretNames: ['APP_STORE_CONNECT_KEY'] });
    expect(parsed.success).toBe(true);
    /* A lowercase value that looks like a secret rather than a name is refused. */
    expect(appProfileSchema.safeParse({ signingSecretNames: ['abc123secretvalue'] }).success).toBe(false);
  });

  it('reports TestFlight readiness from presence alone', () => {
    const profile = {
      platform: 'ios' as const,
      appName: 'App',
      bundleIdentifier: 'com.example.app',
      testFlightWorkflow: 'testflight.yml',
      signingSecretNames: ['APP_STORE_CONNECT_KEY'],
    };
    expect(assessTestFlightReadiness(profile, ['APP_STORE_CONNECT_KEY']).ready).toBe(true);
    const missing = assessTestFlightReadiness(profile, []);
    expect(missing.ready).toBe(false);
    expect(missing.missing.join(' ')).toContain('never reads them');
  });
});

/* ---------------------------------------------------------------- wallboards */

describe('display devices', () => {
  it('parses only a well-formed token', () => {
    const id = '11111111-2222-4333-8444-555555555555';
    const secret = 'a'.repeat(43);
    expect(parseDisplayToken(`jarvisd_${id}.${secret}`)).toEqual({ deviceId: id, secret });
    expect(parseDisplayToken('jarvisd_nope.short')).toBeNull();
    expect(parseDisplayToken(`jarvisw_${id}.${secret}`)).toBeNull();
    expect(parseDisplayToken('')).toBeNull();
  });

  it('treats a revoked or expired device as unusable', () => {
    const now = '2026-01-01T00:00:00.000Z';
    expect(isDisplayDeviceUsable({ revokedAt: null, expiresAt: null }, now)).toBe(true);
    expect(isDisplayDeviceUsable({ revokedAt: now, expiresAt: null }, now)).toBe(false);
    expect(
      isDisplayDeviceUsable({ revokedAt: null, expiresAt: '2025-12-31T00:00:00.000Z' }, now),
    ).toBe(false);
  });

  it('finds a forbidden key anywhere in a payload', () => {
    expect(findForbiddenDisplayKeys({ missions: [{ title: 'x', pullRequestUrl: 'y' }] })).toEqual([
      '$.missions[0].pullRequestUrl',
    ]);
    expect(findForbiddenDisplayKeys({ missions: [{ title: 'x' }] })).toEqual([]);
    expect(FORBIDDEN_DISPLAY_KEYS).toContain('diff');
    expect(FORBIDDEN_DISPLAY_KEYS).toContain('tokenHash');
  });
});

/* ----------------------------------------------------------------- playbooks */

describe('playbooks', () => {
  it('ships built-ins that all validate and all produce valid graphs', () => {
    for (const definition of BUILT_IN_PLAYBOOKS) {
      const check = validatePlaybook(definition);
      expect({ key: definition.key, violations: check.violations }).toEqual({
        key: definition.key,
        violations: [],
      });

      for (const allowWebResearch of [true, false]) {
        const tasks = instantiatePlaybook(definition, {
          hasRepository: true,
          allowWebResearch,
          missionWrites: true,
          projectType: 'software',
          inputs: {
            feature: 'X',
            symptom: 'Y',
            question: 'Q',
            topic: 'T',
            app_name: 'A',
            bundle_id: 'com.a.b',
            template: 'o/r',
            visibility: 'private',
          },
        });
        const graph = validateTaskGraph(tasks, {
          missionWrites: tasks.some((entry) => entry.role === 'builder'),
          limits: { maxParallelTasks: 3, maxWriteTasks: 1, maxRepairRounds: 2 },
        });
        expect({ key: definition.key, allowWebResearch, violations: graph.violations }).toEqual({
          key: definition.key,
          allowWebResearch,
          violations: [],
        });
      }
    }
  });

  it('refuses a playbook that asks for more than its role allows (R-PB6)', () => {
    const base = BUILT_IN_PLAYBOOKS[0]!;
    const widened = {
      ...base,
      tasks: base.tasks.map((entry) =>
        entry.role === 'reviewer' ? { ...entry, permissionProfileId: 'workspace_write' as const } : entry,
      ),
    };
    const check = validatePlaybook(widened);
    expect(check.ok).toBe(false);
    expect(check.violations.map((v) => v.rule)).toContain('R-PB6');
  });

  it('refuses an external-build playbook with no release verifier (R-PB9)', () => {
    const base = BUILT_IN_PLAYBOOKS.find((entry) => entry.key === 'testflight_build')!;
    const check = validatePlaybook({ ...base, requiredReviews: [] });
    expect(check.violations.map((v) => v.rule)).toContain('R-PB9');
  });

  it('merges checks as a union, so a playbook can add but never remove', () => {
    const merged = mergeRequiredChecks(
      [{ id: 'test', label: 'Tests', required: true, blocksDelivery: true }],
      [{ id: 'test', label: 'Tests', required: false, blocksDelivery: false }],
    );
    expect(merged).toHaveLength(1);
    expect(merged[0]!.required).toBe(true);
    expect(merged[0]!.blocksDelivery).toBe(true);
  });

  it('drops a conditional task and every dependency on it', () => {
    const definition = BUILT_IN_PLAYBOOKS.find((entry) => entry.key === 'research_report')!;
    const withoutWeb = instantiatePlaybook(definition, {
      hasRepository: true,
      allowWebResearch: false,
      missionWrites: false,
      projectType: 'software',
      inputs: { question: 'Q' },
    });
    expect(withoutWeb.map((entry) => entry.key)).not.toContain('t2');
    for (const entry of withoutWeb) expect(entry.dependsOn).not.toContain('t2');
  });
});

/* ------------------------------------------------------------- decomposition */

const plan = (overrides: Partial<MissionPlanContent> = {}): MissionPlanContent => ({
  summary: 'Add pagination',
  proposedOutcome: 'A draft pull request',
  assumptions: [],
  scope: ['Paginate the list'],
  outOfScope: ['Merging'],
  affectedAreas: ['src/app/results'],
  approach: 'Add a cursor and a page size',
  dataMigrations: [],
  testsToAddOrUpdate: ['Pagination tests'],
  verification: [],
  uiValidation: [],
  risks: [],
  rollback: 'Close the pull request',
  acceptanceCriteria: ['Ten per page'],
  openQuestions: [],
  estimatedComplexity: 'small',
  withinRequestedScope: true,
  scopeNotes: null,
  reviewOnlyDelivery: true,
  evidenceIds: [],
  repositoryFacts: {},
  ...overrides,
});

describe('decomposing a plan', () => {
  it('produces a small graph for ordinary work rather than a swarm', () => {
    const result = decomposePlan({
      plan: plan(),
      missionType: 'code_change',
      missionTitle: 'Add pagination',
      hasRepository: true,
      allowWebResearch: false,
      requiredSpecialists: [],
      maxRepairRounds: 2,
    });
    expect(result.tasks.length).toBeLessThanOrEqual(6);
    expect(result.tasks.filter((entry) => entry.role === 'builder')).toHaveLength(1);
    const validation = validateTaskGraph(result.tasks, { missionWrites: true });
    expect(validation.violations).toEqual([]);
  });

  it('adds an investigation only when the plan left real unknowns', () => {
    const without = decomposePlan({
      plan: plan(),
      missionType: 'code_change',
      missionTitle: 'x',
      hasRepository: true,
      allowWebResearch: false,
      requiredSpecialists: [],
      maxRepairRounds: 2,
    });
    expect(without.tasks.some((entry) => entry.taskType === 'investigation')).toBe(false);

    const withQuestions = decomposePlan({
      plan: plan({ openQuestions: ['Which store?', 'Which cursor?'] }),
      missionType: 'code_change',
      missionTitle: 'x',
      hasRepository: true,
      allowWebResearch: false,
      requiredSpecialists: [],
      maxRepairRounds: 2,
    });
    expect(withQuestions.tasks.some((entry) => entry.taskType === 'investigation')).toBe(true);
    expect(researchIsWorthwhile(plan({ openQuestions: ['a', 'b'] }))).toBe(true);
    expect(researchIsWorthwhile(plan())).toBe(false);
  });

  it('includes a required specialist and says why', () => {
    const result = decomposePlan({
      plan: plan(),
      missionType: 'code_change',
      missionTitle: 'x',
      hasRepository: true,
      allowWebResearch: false,
      requiredSpecialists: ['security_reviewer'],
      maxRepairRounds: 2,
    });
    expect(result.tasks.some((entry) => entry.role === 'security_reviewer')).toBe(true);
    expect(result.notes.join(' ')).toContain('security review is required');
    const validation = validateTaskGraph(result.tasks, {
      missionWrites: true,
      requiredReviewRoles: ['security_reviewer'],
    });
    expect(validation.violations).toEqual([]);
  });

  it('says plainly when a plan named no areas, so the whole repository is in scope', () => {
    expect(deriveWriteSet(plan({ affectedAreas: [] }))).toEqual(['.']);
    expect(deriveWriteSet(plan({ affectedAreas: ['the settings screen'] }))).toEqual(['.']);
    expect(deriveWriteSet(plan({ affectedAreas: ['src/app/results'] }))).toEqual(['src/app/results']);

    const result = decomposePlan({
      plan: plan({ affectedAreas: [] }),
      missionType: 'code_change',
      missionTitle: 'x',
      hasRepository: true,
      allowWebResearch: false,
      requiredSpecialists: [],
      maxRepairRounds: 2,
    });
    expect(result.notes.join(' ')).toContain('may change anything in the repository');
  });

  it('produces a read-only graph with no writer for a research mission', () => {
    const result = decomposePlan({
      plan: plan({ openQuestions: ['a', 'b', 'c'] }),
      missionType: 'research_report',
      missionTitle: 'x',
      hasRepository: true,
      allowWebResearch: true,
      requiredSpecialists: [],
      maxRepairRounds: 0,
    });
    expect(result.tasks.every((entry) => entry.declaredWriteSet.length === 0)).toBe(true);
    expect(result.tasks.some((entry) => entry.role === 'builder')).toBe(false);
    expect(result.notes.join(' ')).toContain('read-only');
  });
});
