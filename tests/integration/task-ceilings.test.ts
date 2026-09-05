import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { WORKER_VERSION, type TaskAssignment } from '@/domain/worker-protocol';
import type { WorkerConfig } from '@/worker/config';
import { TaskRunner } from '@/worker/task-runner';
import { ScriptedRuntime, type ScriptedStep } from '@/worker/runtime/scripted';
import { createSandboxRepo, type SandboxRepo } from '../helpers/sandbox-repo';

/**
 * A task that will not stop on its own.
 *
 * Every ceiling in this system was defined, most were stored on the row, and almost none reached a
 * running agent. `MissionOrchestrator.canStart` — the only caller of the mission runtime and token
 * rules — had no call sites. `taskExceedsLimits` ran only from `orchestrator.tick`, which nothing
 * calls on a timer, so the sweep never ran *while* a task was running. And `timeLimitMs` and
 * `maxOutputTokens` were assembled, serialised and shipped to the worker, where no line of code
 * read either of them.
 *
 * These drive a real `TaskRunner` against a real git repository with a scripted agent that keeps
 * producing, and assert it stops itself.
 */

const MISSION_ID = 'cccccccc-dddd-4eee-8fff-aaaaaaaaaaaa';
const RUN_ID = '99999999-8888-4777-8666-555555555555';
const TASK_ID = '11111111-2222-4333-8444-666666666666';

/** Everything the runner reports, so a test can assert on how the task ended. */
class RecordingTaskClient {
  readonly states: { state: string | null; patch: Record<string, unknown> }[] = [];
  readonly events: { type: string; summary: string }[] = [];
  readonly artifacts: { title: string; content: string }[] = [];
  stopRequested = false;

  async taskState(input: Record<string, unknown>) {
    this.states.push({ state: (input.taskState as string) ?? null, patch: input });
    return {
      ok: true as const,
      taskState: (input.taskState as string) ?? 'running',
      stopRequested: this.stopRequested,
      pauseRequested: false,
    };
  }

  async events_(input: { events: { type: string; summary: string }[] }) {
    for (const event of input.events) this.events.push(event);
    return { accepted: input.events.length };
  }

  async artifact(_missionId: string, input: { title: string; content: string }) {
    this.artifacts.push(input);
    return { id: 'artifact-1' };
  }

  async acquireLease() {
    return { granted: true as const, reason: null };
  }

  /** The terminal report, which is what these tests are about. */
  last(): { state: string | null; patch: Record<string, unknown> } | undefined {
    return this.states[this.states.length - 1];
  }

  failureOf(): { code: unknown; message: unknown } {
    const failed = this.states.find((entry) => entry.state === 'failed');
    return { code: failed?.patch.failureCode, message: failed?.patch.failureMessage };
  }
}

function asClient(recorder: RecordingTaskClient) {
  return {
    taskState: (input: Record<string, unknown>) => recorder.taskState(input),
    events: (input: { events: { type: string; summary: string }[] }) => recorder.events_(input),
    artifact: (missionId: string, input: { title: string; content: string }) =>
      recorder.artifact(missionId, input),
    acquireLease: () => recorder.acquireLease(),
  } as unknown as ConstructorParameters<typeof TaskRunner>[0]['client'];
}

describe('a task that reaches a ceiling', () => {
  let repo: SandboxRepo;
  let workspaceRoot: string;

  beforeEach(async () => {
    repo = await createSandboxRepo();
    workspaceRoot = await mkdtemp(path.join(tmpdir(), 'jarvis-ceiling-'));
  });

  afterEach(async () => {
    await repo.cleanup();
    await rm(workspaceRoot, { recursive: true, force: true });
  });

  function config(): WorkerConfig {
    return {
      controlPlaneUrl: 'http://localhost:3000',
      token: 'jarvisw_test',
      name: 'ceiling-worker',
      workspaceRoot,
      anthropicApiKey: null,
      anthropicApiKeyPresent: false,
      claudeOauthToken: null,
      operatorTickIntervalMs: null,
      authMode: 'subscription',
      model: null,
      maxTurns: 100,
      githubToken: null,
      githubApiUrl: 'https://api.github.test',
      pollIntervalMs: 1000,
      verifyTimeoutMs: 60_000,
      runTimeoutMs: 300_000,
      accepts: ['inspection', 'execution', 'research'],
      allowWebResearch: false,
      runtime: 'scripted',
      allowedRepositories: null,
      sandboxRepositories: new Map(),
      version: WORKER_VERSION,
      diagnostics: [],
    };
  }

  function assignment(overrides: Partial<TaskAssignment> = {}): TaskAssignment {
    return {
      kind: 'task',
      missionId: MISSION_ID,
      runId: RUN_ID,
      taskId: TASK_ID,
      taskKey: 't1',
      graphVersion: 1,
      attempt: 1,
      role: 'researcher',
      permissionProfileId: 'readonly_repo',
      taskType: 'research',
      title: 'Look into the invoice totals',
      description: 'Read the code and report what you find.',
      acceptanceCriteria: [],
      expectedInputs: [],
      expectedOutputs: [],
      workspaceRequirement: 'clone',
      declaredWriteSet: [],
      branchName: null,
      baseTaskBranch: null,
      integrationBranch: null,
      mergeBranches: [],
      mergeWriteSet: [],
      repairRound: 0,
      maxTurns: null,
      timeLimitMs: null,
      maxOutputTokens: null,
      missionTitle: 'Improve invoicing',
      rawRequest: 'Improve invoicing',
      missionType: 'investigation',
      riskLevel: 'low',
      projectId: 'project-1',
      projectName: 'Sandbox',
      projectGoal: null,
      planVersion: 1,
      plan: null,
      graphSummary: 'One research task.',
      siblingTasks: [],
      constraints: [],
      doNotTouch: [],
      repository: {
        owner: 'test-owner',
        name: 'sandbox',
        fullName: 'test-owner/sandbox',
        defaultBranch: 'main',
        cloneUrl: repo.remotePath,
        visibility: 'private',
      },
      clarifications: [],
      projectContext: [],
      allowWebResearch: false,
      review: null,
      repairScope: null,
      verification: [],
      ...overrides,
    } as TaskAssignment;
  }

  /** An agent that keeps talking and never says it is done. */
  function chatty(paragraphs: number): ScriptedStep[] {
    const steps: ScriptedStep[] = [];
    for (let index = 0; index < paragraphs; index += 1) {
      steps.push({ kind: 'message', text: 'x'.repeat(2_000) });
    }
    steps.push({ kind: 'done', result: 'Finished, eventually.' });
    return steps;
  }

  it('stops itself when it has produced more than its allowance', async () => {
    const recorder = new RecordingTaskClient();
    const runtime = new ScriptedRuntime({ steps: chatty(40) });

    const runner = new TaskRunner(
      { config: config(), client: asClient(recorder), runtime, delivery: null },
      /* 1,000 tokens is about 3,000 characters, which two messages exceed. */
      assignment({ maxOutputTokens: 1_000 }),
    );
    await runner.run();

    const failure = recorder.failureOf();
    expect(failure.code).toBe('limit_reached');
    expect(String(failure.message)).toMatch(/allowance/);
    /* It says "about", because no real token count exists until the session ends. */
    expect(String(failure.message)).toMatch(/about/);

    /*
     * And it stopped well short of the script. Without the ceiling the runner would have consumed
     * all forty messages and reported success.
     */
    expect(recorder.states.some((entry) => entry.state === 'succeeded')).toBe(false);
  });

  it('keeps the findings it had already produced', async () => {
    /*
     * A run that spent an allowance and produced a half-written report has still produced
     * something. Throwing it away means paying for the same reading twice.
     */
    const recorder = new RecordingTaskClient();
    const runtime = new ScriptedRuntime({ steps: chatty(40) });

    const runner = new TaskRunner(
      { config: config(), client: asClient(recorder), runtime, delivery: null },
      assignment({ maxOutputTokens: 1_000 }),
    );
    await runner.run();

    expect(recorder.artifacts).toHaveLength(1);
    expect(recorder.artifacts[0]?.content.length).toBeGreaterThan(0);
  });

  it('runs to completion when its allowance is generous', async () => {
    /* The control has to be off when it should be off, or it is just a broken worker. */
    const recorder = new RecordingTaskClient();
    const runtime = new ScriptedRuntime({ steps: chatty(2) });

    const runner = new TaskRunner(
      { config: config(), client: asClient(recorder), runtime, delivery: null },
      assignment({ maxOutputTokens: 10_000_000 }),
    );
    await runner.run();

    expect(recorder.states.some((entry) => entry.state === 'succeeded')).toBe(true);
    expect(recorder.failureOf().code).toBeUndefined();
  });

  it('stops when the owner asked the mission to stop, mid-session', async () => {
    /*
     * `stopRequested` used to be the literal `false` on both of the control plane's return paths,
     * so an owner's Stop reached the mission, the mission's runner honoured it, and every task in
     * the factory carried on regardless.
     */
    const recorder = new RecordingTaskClient();
    recorder.stopRequested = true;
    const runtime = new ScriptedRuntime({ steps: chatty(40) });

    const runner = new TaskRunner(
      { config: config(), client: asClient(recorder), runtime, delivery: null },
      assignment(),
    );
    await runner.run();

    expect(recorder.states.some((entry) => entry.state === 'stopped')).toBe(true);
  });
});
