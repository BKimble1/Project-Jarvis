import { readFile, writeFile } from 'node:fs/promises';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { MissionAssignment, PendingCommand } from '@/domain/worker-protocol';
import { WORKER_VERSION } from '@/domain/worker-protocol';
import type { MissionState } from '@/domain/mission';
import { assertTransition } from '@/domain/mission-state';
import type {
  ArtifactInput,
  PermissionRequestInput,
  VerificationInput,
} from '@/domain/mission-run';
import type { WorkerConfig } from '@/worker/config';
import { MissionRunner } from '@/worker/mission-runner';
import { JarvisWorkerProcess, type WorkerRuntimeDeps } from '@/worker/main';
import { ScriptedRuntime, type ScriptedStep } from '@/worker/runtime/scripted';
import { git } from '@/worker/git';
import { createSandboxRepo, type SandboxRepo } from '../helpers/sandbox-repo';
import { FakeDelivery } from '../helpers/fake-delivery';

/**
 * The worker, end to end, against a real git repository.
 *
 * The repository is a bare repo on the local disk — created per test, deleted afterwards — so
 * every clone, branch, commit and push is real, with real refusals, and **no test touches a
 * repository that exists anywhere else**. Only the model and the GitHub API are replaced.
 *
 * That distinction is what makes these tests worth having: when the force-push test passes, it
 * passes because `assertPushAllowed` refused, not because a mock agreed to.
 */

const MISSION_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const RUN_ID = '11111111-2222-4333-8444-555555555555';

/** Records everything the runner reports, so a test can assert on the run's whole story. */
class RecordingClient {
  readonly events: { type: string; summary: string; level: string }[] = [];
  readonly states: string[] = [];
  readonly verifications: VerificationInput[] = [];
  readonly permissions: PermissionRequestInput[] = [];
  readonly artifacts: ArtifactInput[] = [];
  readonly plans: unknown[] = [];
  readonly acknowledgements: { commandId: string; outcome: string }[] = [];
  stopRequested = false;
  pauseRequested = false;
  /** Where the control plane believes the mission is; a claimed mission starts here. */
  missionState: MissionState = 'claimed';
  /** Set the runner's last reported state fields, for assertions. */
  last: Record<string, unknown> = {};

  async events_(): Promise<void> {}

  async poll(): Promise<never> {
    throw new Error('not used');
  }

  async claim(): Promise<never> {
    throw new Error('not used');
  }

  /**
   * Apply a state report exactly as the control plane would.
   *
   * The state machine runs here rather than a mock accepting whatever it is handed: a report the
   * real Jarvis would reject with a 409 must fail the test too. A report with no `missionState`
   * is metadata only — an agent session id, a token count — and must leave the state alone.
   */
  async runState(input: Record<string, unknown>) {
    this.last = { ...this.last, ...input };
    if (input.missionState !== undefined) {
      const next = input.missionState as MissionState;
      assertTransition(this.missionState, next, 'worker');
      this.missionState = next;
      this.states.push(next);
    }
    return {
      ok: true as const,
      missionState: this.missionState,
      stopRequested: this.stopRequested,
      pauseRequested: this.pauseRequested,
    };
  }

  async eventsBatch(input: { events: { type: string; summary: string; level?: string }[] }) {
    for (const event of input.events) {
      this.events.push({ type: event.type, summary: event.summary, level: event.level ?? 'info' });
    }
    return { accepted: input.events.length };
  }

  async submitPlan(_missionId: string, input: { content: unknown }) {
    this.plans.push(input.content);
    return { ok: true as const, missionState: 'awaiting_plan_approval', planVersion: 1 };
  }

  async permission(input: PermissionRequestInput & { runId: string }) {
    this.permissions.push(input);
    return { id: `permission-${this.permissions.length}` };
  }

  async verification(input: VerificationInput & { runId: string }) {
    this.verifications.push(input);
    return { id: `verification-${this.verifications.length}` };
  }

  async artifact(_missionId: string, input: ArtifactInput) {
    this.artifacts.push(input);
    return { id: `artifact-${this.artifacts.length}` };
  }

  async acknowledgeCommand(commandId: string, outcome: string) {
    this.acknowledgements.push({ commandId, outcome });
    return { ok: true as const };
  }

  /**
   * The move the owner's own request makes before the command reaches the worker.
   *
   * `MissionService.stop` puts the mission in `stopping` and only then queues the command, so a
   * test that hands the runner a stop command has to do the same — otherwise the worker's
   * `stopped` report would be judged against a state the real system was never in.
   */
  ownerMove(next: MissionState): void {
    assertTransition(this.missionState, next, 'owner');
    this.missionState = next;
  }

  summary(): string {
    return this.events.map((event) => `${event.type}: ${event.summary}`).join('\n');
  }
}

/* The runner takes a `ControlPlaneClient`; the recorder implements the calls it actually makes. */
function asClient(recorder: RecordingClient) {
  return {
    runState: (input: Record<string, unknown>) => recorder.runState(input),
    events: (input: { events: { type: string; summary: string; level?: string }[] }) =>
      recorder.eventsBatch(input),
    submitPlan: (missionId: string, input: { content: unknown }) =>
      recorder.submitPlan(missionId, input),
    permission: (input: PermissionRequestInput & { runId: string }) => recorder.permission(input),
    verification: (input: VerificationInput & { runId: string }) => recorder.verification(input),
    artifact: (missionId: string, input: ArtifactInput) => recorder.artifact(missionId, input),
    acknowledgeCommand: (commandId: string, outcome: string) =>
      recorder.acknowledgeCommand(commandId, outcome),
  } as unknown as ConstructorParameters<typeof MissionRunner>[0]['client'];
}

/**
 * Config and assignment at module scope, for the process-level suite below.
 *
 * The `MissionRunner` suite has its own copies closed over its own temporary directory; these are
 * parameterised instead, because the process suite creates a separate workspace root and a
 * separate sandbox repository per test and cannot reach into that closure.
 */
function processConfig(workspaceRoot: string): WorkerConfig {
  return {
    controlPlaneUrl: 'http://localhost:3000',
    token: 'jarvisw_test',
    name: 'loop-worker',
    workspaceRoot,
    anthropicApiKey: null,
    anthropicApiKeyPresent: false,
    claudeOauthToken: null,
    operatorTickIntervalMs: null,
    authMode: 'subscription',
    model: null,
    maxTurns: 10,
    githubToken: null,
    githubApiUrl: 'https://api.github.test',
    pollIntervalMs: 5,
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

function assignmentFor(repo: SandboxRepo): MissionAssignment {
  return {
    missionId: MISSION_ID,
    runId: RUN_ID,
    kind: 'execution',
    attempt: 1,
    missionTitle: 'Improve the readme',
    missionDescription: null,
    rawRequest: 'Improve the readme',
    missionType: 'documentation',
    riskLevel: 'low',
    projectId: 'project-1',
    projectName: 'Sandbox',
    projectGoal: null,
    planVersion: 1,
    plan: null,
    constraints: [],
    doNotTouch: [],
    acceptanceCriteria: [],
    deliverable: null,
    repository: {
      owner: 'test-owner',
      name: 'sandbox',
      fullName: 'test-owner/sandbox',
      defaultBranch: 'main',
      cloneUrl: repo.remotePath,
      visibility: 'private',
    },
    branchName: `jarvis/${MISSION_ID}-improve-the-readme`,
    resumeSessionId: null,
    missionState: 'claimed',
    clarifications: [],
    projectContext: [],
    allowWebResearch: false,
  };
}

describe('MissionRunner', () => {
  let repo: SandboxRepo;
  let workspaceRoot: string;

  beforeEach(async () => {
    repo = await createSandboxRepo();
    workspaceRoot = await mkdtemp(path.join(tmpdir(), 'jarvis-workspaces-'));
  });

  afterEach(async () => {
    await repo.cleanup();
    await rm(workspaceRoot, { recursive: true, force: true });
  });

  function config(overrides: Partial<WorkerConfig> = {}): WorkerConfig {
    return {
      controlPlaneUrl: 'http://localhost:3000',
      token: 'jarvisw_test',
      name: 'test-worker',
      workspaceRoot,
      anthropicApiKey: null,
      anthropicApiKeyPresent: false,
      claudeOauthToken: null,
      operatorTickIntervalMs: null,
      authMode: 'subscription',
      model: null,
      maxTurns: 10,
      githubToken: null,
      githubApiUrl: 'https://api.github.test',
      pollIntervalMs: 1000,
      verifyTimeoutMs: 60_000,
      runTimeoutMs: 300_000,
      accepts: ['inspection', 'execution', 'research'],
      allowWebResearch: false,
      runtime: 'scripted',
      /* Unset in the real default: delivery is limited by the token alone. */
      allowedRepositories: null,
      sandboxRepositories: new Map(),
      /* The real constant: the claim boundary refuses a worker on a different major. */
      version: WORKER_VERSION,
      diagnostics: [],
      ...overrides,
    };
  }

  function assignment(overrides: Partial<MissionAssignment> = {}): MissionAssignment {
    return {
      missionId: MISSION_ID,
      runId: RUN_ID,
      kind: 'execution',
      attempt: 1,
      missionTitle: 'Improve the readme',
      missionDescription: null,
      rawRequest: 'Improve the readme',
      missionType: 'documentation',
      riskLevel: 'low',
      projectId: 'project-1',
      projectName: 'Sandbox',
      projectGoal: null,
      planVersion: 1,
      plan: null,
      constraints: [],
      doNotTouch: [],
      acceptanceCriteria: [],
      deliverable: null,
      repository: {
        owner: 'test-owner',
        name: 'sandbox',
        fullName: 'test-owner/sandbox',
        defaultBranch: 'main',
        cloneUrl: repo.remotePath,
        visibility: 'private',
      },
      branchName: `jarvis/${MISSION_ID}-improve-the-readme`,
      resumeSessionId: null,
      missionState: 'claimed',
      clarifications: [],
      projectContext: [],
      allowWebResearch: false,
      ...overrides,
    };
  }

  const pathExists = async (target: string): Promise<boolean> => {
    try {
      await stat(target);
      return true;
    } catch {
      return false;
    }
  };

  /** Writes a file inside the mission workspace, as an approved Edit would. */
  const editReadme = (content: string) => async (workspace: string) => {
    await writeFile(path.join(workspace, 'README.md'), content, 'utf8');
  };

  async function run(
    steps: readonly ScriptedStep[],
    options: {
      assignment?: Partial<MissionAssignment>;
      config?: Partial<WorkerConfig>;
      delivery?: FakeDelivery | null;
      recorder?: RecordingClient;
      onMessage?: (text: string) => void;
    } = {},
  ): Promise<{ recorder: RecordingClient; runtime: ScriptedRuntime; runner: MissionRunner }> {
    const recorder = options.recorder ?? new RecordingClient();
    /*
     * Where the control plane really has the mission when this run starts.
     *
     * An explicit `missionState` on the assignment is how a *re-*claim is expressed: the worker
     * restarted, and the run it still holds was handed straight back to it.
     */
    recorder.missionState =
      options.assignment?.missionState ??
      (options.assignment?.kind === 'inspection' ? 'inspecting' : 'claimed');
    const runtime = new ScriptedRuntime({
      steps,
      ...(options.onMessage ? { onMessage: options.onMessage } : {}),
    });
    const runner = new MissionRunner(
      {
        config: config(options.config),
        client: asClient(recorder),
        runtime,
        delivery: options.delivery === undefined ? new FakeDelivery() : options.delivery,
      },
      assignment(options.assignment),
    );
    await runner.run();
    return { recorder, runtime, runner };
  }

  /* ------------------------------------------------------------- inspection */

  it('plans in read-only mode and changes nothing', async () => {
    const { recorder, runtime } = await run(
      [
        { kind: 'message', text: 'Looking at the repository.' },
        { kind: 'tool', toolName: 'Read', input: { file_path: 'README.md' } },
        /* An inspection run must not be able to write, even if it tries. */
        {
          kind: 'tool',
          toolName: 'Write',
          input: { file_path: 'README.md' },
          effect: editReadme('should never happen'),
        },
        {
          kind: 'done',
          result:
            '```json\n{"summary":"Improve the readme","approach":"Rewrite the intro","scope":["Rewrite the intro"],"verification":[{"command":"npm test","purpose":"suite","source":"package_script"}],"estimatedComplexity":"small"}\n```',
        },
      ],
      { assignment: { kind: 'inspection', branchName: null } },
    );

    expect(recorder.plans).toHaveLength(1);
    const plan = recorder.plans[0] as { approach: string; verification: unknown[] };
    expect(plan.approach).toBe('Rewrite the intro');
    expect(plan.verification).toHaveLength(1);

    /* The write was refused by the policy, so the file on disk is untouched. */
    expect(recorder.summary()).toContain('policy_refusal');
    const readme = await readFile(
      path.join(workspaceRoot, MISSION_ID, 'inspect', 'README.md'),
      'utf8',
    );
    expect(readme).toContain('# Sandbox');
    expect(readme).not.toContain('should never happen');

    /* And the agent was told, in its system prompt, that repository text is untrusted. */
    expect(runtime.prompts[0]?.system).toContain('untrusted source');
  });

  it('tells the inspecting agent to change nothing and produce a plan', async () => {
    const { runtime } = await run([{ kind: 'done', result: 'no plan' }], {
      assignment: { kind: 'inspection', branchName: null },
    });
    expect(runtime.prompts[0]?.user).toContain('**Change nothing.**');
    expect(runtime.prompts[0]?.user).toContain('read-only inspection');
    expect(runtime.prompts[0]?.system).toContain('READ-ONLY');
  });

  /* -------------------------------------------------------------- execution */

  it('creates a branch, commits, pushes and opens a draft pull request', async () => {
    const delivery = new FakeDelivery();
    const { recorder } = await run(
      [
        { kind: 'message', text: 'Rewriting the introduction.' },
        {
          kind: 'tool',
          toolName: 'Edit',
          input: { file_path: 'README.md' },
          effect: editReadme('# Sandbox\n\nA much better introduction.\n'),
        },
        { kind: 'done', result: 'Rewrote the introduction.' },
      ],
      { delivery, config: { githubToken: 'ghp_fake_worker_token_for_tests_only_00' } },
    );

    /* The mission branch exists on the remote and the default branch is untouched. */
    const branches = await repo.branches();
    expect(branches).toContain(`jarvis/${MISSION_ID}-improve-the-readme`);
    expect(branches).toContain('main');

    const onBranch = await repo.fileOnBranch(
      `jarvis/${MISSION_ID}-improve-the-readme`,
      'README.md',
    );
    expect(onBranch).toContain('A much better introduction.');

    /* The default branch's README is exactly as it started. */
    const onMain = await repo.fileOnBranch('main', 'README.md');
    expect(onMain).toBe('# Sandbox\n\nA repository for tests.\n');

    /* A draft pull request was opened, and it is a draft. */
    expect(delivery.created).toHaveLength(1);
    expect(delivery.created[0]?.base).toBe('main');
    expect(delivery.created[0]?.head).toBe(`jarvis/${MISSION_ID}-improve-the-readme`);
    expect(delivery.created[0]?.body).toContain('has not been merged');

    expect(recorder.states).toContain('pull_request_ready');
    expect(recorder.last.pullRequestNumber).toBe(1);
  });

  it('records verification results, including one that cannot run here', async () => {
    const { recorder } = await run(
      [
        {
          kind: 'tool',
          toolName: 'Edit',
          input: { file_path: 'README.md' },
          effect: editReadme('# Sandbox\n\nEdited.\n'),
        },
        { kind: 'done', result: 'Edited the readme.' },
      ],
      {
        config: { githubToken: 'ghp_fake_worker_token_for_tests_only_00' },
        assignment: {
          plan: {
            summary: 's',
            proposedOutcome: 'o',
            assumptions: [],
            scope: [],
            outOfScope: [],
            affectedAreas: [],
            approach: 'a',
            dataMigrations: [],
            testsToAddOrUpdate: [],
            verification: [
              {
                command: 'xcodebuild test',
                purpose: 'Run the iOS suite.',
                source: 'ci_workflow',
                expectedUnavailableReason: null,
              },
              {
                command: 'rm -rf /',
                purpose: 'Definitely not verification.',
                source: 'agent_inference',
                expectedUnavailableReason: null,
              },
            ],
            uiValidation: [],
            risks: [],
            rollback: 'r',
            acceptanceCriteria: [],
            openQuestions: [],
            estimatedComplexity: 'small',
            withinRequestedScope: true,
            scopeNotes: null,
            reviewOnlyDelivery: true,
            evidenceIds: [],
            repositoryFacts: {},
          },
        },
      },
    );

    const byCommand = new Map(recorder.verifications.map((entry) => [entry.command, entry]));
    const apple = byCommand.get('xcodebuild test');
    /* On a non-macOS worker this must be `unavailable`, never a claimed pass and never a failure. */
    if (process.platform !== 'darwin') {
      expect(apple?.outcome).toBe('unavailable');
      expect(apple?.reason).toContain('CI workflow');
    }
    const dangerous = byCommand.get('rm -rf /');
    expect(dangerous?.outcome).toBe('skipped');
    expect(dangerous?.reason).toContain('not one of the runners');
  });

  it('refuses a force push, a default-branch push and a merge — from inside the agent', async () => {
    const { recorder } = await run(
      [
        { kind: 'tool', toolName: 'Bash', input: { command: 'git push --force origin main' } },
        { kind: 'tool', toolName: 'Bash', input: { command: 'git push origin main' } },
        { kind: 'tool', toolName: 'Bash', input: { command: 'git merge main' } },
        { kind: 'tool', toolName: 'Bash', input: { command: 'gh pr merge 1 --squash' } },
        { kind: 'tool', toolName: 'Bash', input: { command: 'sudo cat /etc/shadow' } },
        { kind: 'tool', toolName: 'Read', input: { file_path: '/root/.ssh/id_rsa' } },
        { kind: 'tool', toolName: 'Write', input: { file_path: '/etc/hosts' } },
        { kind: 'done', result: 'I could not do any of that.' },
      ],
      { config: { githubToken: 'ghp_fake_worker_token_for_tests_only_00' } },
    );

    const refusals = recorder.events.filter((event) => event.type === 'policy_refusal');
    expect(refusals).toHaveLength(7);

    /* Nothing reached the remote: only the default branch exists. */
    expect(await repo.branches()).toEqual(['main']);
  });

  it('preserves the workspace and the branch when the owner stops it', async () => {
    const recorder = new RecordingClient();
    const runtime = new ScriptedRuntime({
      steps: [
        {
          kind: 'tool',
          toolName: 'Edit',
          input: { file_path: 'README.md' },
          effect: editReadme('# Sandbox\n\nHalf-finished work.\n'),
        },
        { kind: 'wait_for_message' },
        { kind: 'done', result: 'never reached' },
      ],
    });
    const runner = new MissionRunner(
      {
        config: config({ githubToken: 'ghp_fake_worker_token_for_tests_only_00' }),
        client: asClient(recorder),
        runtime,
        delivery: new FakeDelivery(),
      },
      assignment(),
    );

    const finished = runner.run();
    /* Let the edit land, then stop. */
    await new Promise((resolve) => setTimeout(resolve, 60));
    recorder.ownerMove('stopping');
    await runner.applyCommand({
      id: 'command-1',
      kind: 'stop',
      missionId: MISSION_ID,
      runId: RUN_ID,
      payload: { reason: 'Changed my mind.' },
      requestedAt: new Date().toISOString(),
    } satisfies PendingCommand);
    await finished;

    expect(recorder.states).toContain('stopped');
    expect(recorder.last.workspacePreserved).toBe(true);

    /* The half-finished work is still on disk. */
    const readme = await readFile(
      path.join(workspaceRoot, MISSION_ID, 'repo', 'README.md'),
      'utf8',
    );
    expect(readme).toContain('Half-finished work.');

    /* And nothing was pushed. */
    expect(await repo.branches()).toEqual(['main']);
    expect(recorder.summary()).toContain('preserved — nothing was deleted');
  });

  it('delivers an owner message into the running conversation', async () => {
    const delivered: string[] = [];
    const recorder = new RecordingClient();
    const runtime = new ScriptedRuntime({
      steps: [{ kind: 'wait_for_message' }, { kind: 'done', result: 'Took your note.' }],
      onMessage: (text) => delivered.push(text),
    });
    const runner = new MissionRunner(
      { config: config(), client: asClient(recorder), runtime, delivery: null },
      assignment(),
    );

    const finished = runner.run();
    await new Promise((resolve) => setTimeout(resolve, 60));
    await runner.applyCommand({
      id: 'command-2',
      kind: 'message',
      missionId: MISSION_ID,
      runId: RUN_ID,
      payload: { message: 'Do not change the licence file.' },
      requestedAt: new Date().toISOString(),
    } satisfies PendingCommand);
    await finished;

    expect(delivered).toContain('Do not change the licence file.');
    expect(recorder.acknowledgements).toContainEqual({
      commandId: 'command-2',
      outcome: 'completed',
    });
  });

  it('turns an ask into an owner permission request and honours the answer', async () => {
    const recorder = new RecordingClient();
    const runtime = new ScriptedRuntime({
      steps: [
        /* Web access is not enabled, so the policy asks rather than allowing or denying. */
        { kind: 'tool', toolName: 'WebFetch', input: { url: 'https://example.com' } },
        { kind: 'done', result: 'Finished.' },
      ],
    });
    const runner = new MissionRunner(
      { config: config(), client: asClient(recorder), runtime, delivery: null },
      assignment(),
    );

    const finished = runner.run();
    /* Wait for the request to be raised, then deny it. */
    for (let attempt = 0; attempt < 40 && recorder.permissions.length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(recorder.permissions).toHaveLength(1);
    const request = recorder.permissions[0]!;
    expect(request.requestedAction).toContain('WebFetch');
    expect(request.ifApproved).toContain('does not extend to any other call');

    await runner.applyCommand({
      id: 'command-3',
      kind: 'permission_response',
      missionId: MISSION_ID,
      runId: RUN_ID,
      payload: { requestKey: request.requestKey, decision: 'deny' },
      requestedAt: new Date().toISOString(),
    } satisfies PendingCommand);
    await finished;

    expect(recorder.states).toContain('waiting_for_permission');
    expect(recorder.summary()).toContain('You denied this request.');
  });

  /* ------------------------------------------------------------- resilience */

  it('reports an agent failure honestly and never as completed', async () => {
    const { recorder } = await run([
      { kind: 'message', text: 'Starting.' },
      { kind: 'error', message: 'The model returned an invalid response.' },
      { kind: 'done', result: 'should not be reached' },
    ]);
    expect(recorder.states).toContain('failed');
    expect(recorder.states).not.toContain('completed');
    expect(recorder.last.failureCode).toBe('agent_error');
    expect(recorder.last.workspacePreserved).toBe(true);
  });

  it('fails honestly when GitHub rejects the delivery, and keeps the commit', async () => {
    const { recorder } = await run(
      [
        {
          kind: 'tool',
          toolName: 'Edit',
          input: { file_path: 'README.md' },
          effect: editReadme('# Sandbox\n\nEdited.\n'),
        },
        { kind: 'done', result: 'Edited.' },
      ],
      {
        delivery: new FakeDelivery({ failWithStatus: 403 }),
        config: { githubToken: 'ghp_fake_worker_token_for_tests_only_00' },
      },
    );

    expect(recorder.states).toContain('failed');
    expect(recorder.last.failureCode).toBe('github_auth_error');
    /* The branch was still pushed, so the work is not lost. */
    expect(await repo.branches()).toContain(`jarvis/${MISSION_ID}-improve-the-readme`);
  });

  it('says plainly when it has no GitHub credential rather than pretending to deliver', async () => {
    const { recorder } = await run(
      [
        {
          kind: 'tool',
          toolName: 'Edit',
          input: { file_path: 'README.md' },
          effect: editReadme('# Sandbox\n\nEdited.\n'),
        },
        { kind: 'done', result: 'Edited.' },
      ],
      { delivery: null, config: { githubToken: null } },
    );

    expect(recorder.states).toContain('completed');
    expect(String(recorder.last.completionSummary)).toContain('no GitHub write credential');
    expect(await repo.branches()).toEqual(['main']);
  });

  it('executes in a fresh clone after having inspected the same mission', async () => {
    /*
     * The ordinary sequence: plan, approve, run. Inspection clones the repository read-only, so
     * unless the two phases keep their own directories the execution run finds a workspace in its
     * way and refuses to start — which is exactly what the smoke test caught.
     */
    await run([{ kind: 'done', result: 'inspected' }], {
      assignment: { kind: 'inspection', branchName: null },
    });

    const { recorder } = await run(
      [
        {
          kind: 'tool',
          toolName: 'Edit',
          input: { file_path: 'README.md' },
          effect: editReadme('# Sandbox\n\nA note.\n'),
        },
        { kind: 'done', result: 'Added the note.' },
      ],
      { config: { githubToken: 'ghp_fake_worker_token_for_tests_only_00' } },
    );

    expect(recorder.states).toContain('pull_request_ready');
    expect(await repo.branches()).toContain(`jarvis/${MISSION_ID}-improve-the-readme`);

    /* Both clones are still on disk; neither phase deleted the other's. */
    expect(await pathExists(path.join(workspaceRoot, MISSION_ID, 'inspect'))).toBe(true);
    expect(await pathExists(path.join(workspaceRoot, MISSION_ID, 'repo'))).toBe(true);
  });

  it('re-inspects a mission the owner asked to re-plan', async () => {
    await run([{ kind: 'done', result: 'first look' }], {
      assignment: { kind: 'inspection', branchName: null },
    });
    const { recorder } = await run([{ kind: 'done', result: 'second look' }], {
      assignment: { kind: 'inspection', branchName: null },
    });

    expect(recorder.states).not.toContain('failed');
    expect(recorder.plans).toHaveLength(1);
    expect(recorder.summary()).toContain('changed nothing');
  });

  it('refuses to reuse a workspace left behind by an earlier attempt', async () => {
    await run([{ kind: 'done', result: 'first attempt' }]);
    const { recorder } = await run([{ kind: 'done', result: 'second attempt' }]);
    expect(recorder.states).toContain('failed');
    expect(String(recorder.last.failureMessage)).toContain('already exists');
    expect(String(recorder.last.failureMessage)).toContain('remove it deliberately');
  });

  /* ------------------------------------------------------ delivery limits */

  it('refuses to deliver to a repository this worker was not allowed', async () => {
    /*
     * The second lock. The token is the first, and it is set on the same machine by the same
     * person — so a token scoped more widely than intended is a mistake with no other control
     * behind it. This one is held by the worker, so the control plane cannot widen it by sending
     * a different assignment, and it is checked before a request is made rather than relying on
     * GitHub to say no.
     */
    const delivery = new FakeDelivery();
    const { recorder } = await run(
      [
        {
          kind: 'tool',
          toolName: 'Edit',
          input: { file_path: 'README.md' },
          effect: editReadme('# Sandbox\n\nEdited.\n'),
        },
        { kind: 'done', result: 'Edited.' },
      ],
      {
        delivery,
        config: {
          githubToken: 'ghp_fake_worker_token_for_tests_only_00',
          allowedRepositories: new Set(['someone-else/a-different-repository']),
        },
      },
    );

    /* Nothing was attempted: not a failed request, no request. */
    expect(delivery.created).toHaveLength(0);

    /* And the work is not lost — it is committed, and the mission says exactly why it stopped. */
    expect(recorder.states).toContain('completed');
    expect(recorder.states).not.toContain('pull_request_ready');
    expect(recorder.summary()).toContain('not permitted to deliver');
    expect(recorder.summary()).toContain('JARVIS_WORKER_ALLOWED_REPOS');
  });

  it('delivers normally to a repository that is on the list', async () => {
    const delivery = new FakeDelivery();
    const { recorder } = await run(
      [
        {
          kind: 'tool',
          toolName: 'Edit',
          input: { file_path: 'README.md' },
          effect: editReadme('# Sandbox\n\nEdited.\n'),
        },
        { kind: 'done', result: 'Edited.' },
      ],
      {
        delivery,
        config: {
          githubToken: 'ghp_fake_worker_token_for_tests_only_00',
          /* Upper-cased on purpose: a repository is not a different repository for its casing. */
          allowedRepositories: new Set(['test-owner/sandbox']),
        },
      },
    );

    expect(delivery.created).toHaveLength(1);
    expect(recorder.states).toContain('pull_request_ready');
  });

  /* ---------------------------------------------------- restart and resume */

  /**
   * What a restarted worker does with the run it is still holding.
   *
   * All three of these go through `RecordingClient.runState`, which runs the real state machine —
   * so a report the live Jarvis would answer with a 409 fails the test the same way it failed the
   * mission. That is exactly how the defect these cover used to present: the restarted worker
   * announced `preparing_workspace`, the machine refused it, the non-retryable 409 was classified
   * as `worker_lost`, and a mission whose work was sitting intact on disk was marked failed.
   */
  it('picks a running mission back up after a restart instead of failing it', async () => {
    const { recorder } = await run(
      [
        {
          kind: 'tool',
          toolName: 'Edit',
          input: { file_path: 'README.md' },
          effect: editReadme('# Sandbox\n\nFinished after the restart.\n'),
        },
        { kind: 'done', result: 'Finished after the restart.' },
      ],
      {
        assignment: { missionState: 'running', resumeSessionId: 'agent-session-1' },
        config: { githubToken: 'ghp_fake_worker_token_for_tests_only_00' },
      },
    );

    /* The mission finished. Before the fix this was `failed` with `worker_lost`. */
    expect(recorder.states).not.toContain('failed');
    expect(recorder.states).toContain('pull_request_ready');

    /*
     * And it did not re-announce a state the mission had already left. This is the assertion that
     * would fail if the opening report were restored, not merely a description of one.
     */
    expect(recorder.states).not.toContain('preparing_workspace');
    expect(recorder.summary()).toContain('after a worker restart');
  });

  it('delivers an interrupted pull request without running the agent again', async () => {
    const delivery = new FakeDelivery();
    const withCredential = { githubToken: 'ghp_fake_worker_token_for_tests_only_00' };

    /* A first run that gets as far as a commit, a push and one draft pull request. */
    await run(
      [
        {
          kind: 'tool',
          toolName: 'Edit',
          input: { file_path: 'README.md' },
          effect: editReadme('# Sandbox\n\nWork that was already committed.\n'),
        },
        { kind: 'done', result: 'Committed.' },
      ],
      { delivery, config: withCredential },
    );
    expect(delivery.created).toHaveLength(1);

    /*
     * Now the worker comes back to a mission the control plane left in `creating_pull_request`:
     * killed after the commit, somewhere around the delivery.
     */
    const recorder = new RecordingClient();
    const runtime = new ScriptedRuntime({ steps: [{ kind: 'done', result: 'should not run' }] });
    recorder.missionState = 'creating_pull_request';
    const resumed = new MissionRunner(
      { config: config(withCredential), client: asClient(recorder), runtime, delivery },
      assignment({ missionState: 'creating_pull_request', resumeSessionId: 'agent-session-1' }),
    );
    await resumed.run();

    /* No second pull request, and no second run of the model. */
    expect(delivery.created).toHaveLength(1);
    expect(runtime.prompts).toHaveLength(0);

    /* The existing one was adopted and its body brought up to date. */
    expect(delivery.bodyUpdates).toHaveLength(1);
    expect(recorder.states).toContain('pull_request_ready');
    expect(recorder.last.pullRequestNumber).toBe(1);
    expect(recorder.summary()).toContain('already open for this branch');
    expect(recorder.summary()).toContain('the agent is not run again');
  });

  it('confirms a stop it was restarted before it could confirm', async () => {
    const recorder = new RecordingClient();
    recorder.missionState = 'stopping';
    const runtime = new ScriptedRuntime({ steps: [{ kind: 'done', result: 'should not run' }] });
    const runner = new MissionRunner(
      {
        config: config(),
        client: asClient(recorder),
        runtime,
        delivery: new FakeDelivery(),
      },
      assignment({ missionState: 'stopping' }),
    );
    await runner.run();

    /* The owner's decision stands: nothing resumed, no agent, no clone. */
    expect(recorder.states).toEqual(['stopped']);
    expect(runtime.prompts).toHaveLength(0);
    expect(recorder.last.workspacePreserved).toBe(true);
    expect(recorder.summary()).toContain('Nothing was resumed');
  });

  it('completes without delivering when the agent changed nothing', async () => {
    const { recorder } = await run([{ kind: 'done', result: 'Nothing needed changing.' }], {
      config: { githubToken: 'ghp_fake_worker_token_for_tests_only_00' },
    });
    expect(recorder.states).toContain('completed');
    expect(recorder.summary()).toContain('nothing to deliver');
    expect(await repo.branches()).toEqual(['main']);
  });

  /* --------------------------------------------------------------- research */

  it('produces a sourced report and no branch for a research mission', async () => {
    const { recorder } = await run(
      [
        { kind: 'message', text: '## Findings\n\nThe idea already exists in two products.' },
        { kind: 'done', result: 'Report complete.' },
      ],
      {
        assignment: {
          missionType: 'research_report',
          riskLevel: 'read_only',
          branchName: null,
          missionTitle: 'Does this idea already exist?',
        },
      },
    );

    expect(recorder.artifacts).toHaveLength(1);
    expect(recorder.artifacts[0]?.kind).toBe('research_report');
    expect(recorder.artifacts[0]?.content).toContain('already exists in two products');
    expect(recorder.states).toContain('completed');
    /* No branch, ever, for a read-only mission. */
    expect(await repo.branches()).toEqual(['main']);
  });

  /* ----------------------------------------------------------- git wrapper */

  it('refuses a git subcommand that is not on the worker’s allow-list', async () => {
    await expect(git(['gc', '--aggressive'], { cwd: repo.inspectPath })).rejects.toThrow(
      'not available to the worker',
    );
  });

  it('never puts the credential in the remote URL, where the agent could read it', async () => {
    await run(
      [
        {
          kind: 'tool',
          toolName: 'Edit',
          input: { file_path: 'README.md' },
          effect: editReadme('# Sandbox\n\nEdited.\n'),
        },
        { kind: 'done', result: 'Edited.' },
      ],
      { config: { githubToken: 'ghp_fake_worker_token_for_tests_only_00' } },
    );

    const gitConfig = await readFile(
      path.join(workspaceRoot, MISSION_ID, 'repo', '.git', 'config'),
      'utf8',
    );
    expect(gitConfig).not.toContain('ghp_fake_worker_token');
  });
});

/**
 * The worker *process*, with a real mission in flight.
 *
 * `MissionRunner` is covered exhaustively above; what these cover is the loop around it, which had
 * no test and which had stopped talking to the control plane for the whole duration of every run.
 * The mission here is a real one — a real clone of the sandbox repo, a real branch, a real
 * scripted agent waiting for a message — so the heartbeats being asserted are taken while an
 * actual run is in progress, not while a stub sleeps.
 */
describe('JarvisWorkerProcess with a mission in flight', () => {
  let repo: SandboxRepo;
  let workspaceRoot: string;

  beforeEach(async () => {
    repo = await createSandboxRepo();
    workspaceRoot = await mkdtemp(path.join(tmpdir(), 'jarvis-loop-'));
  });

  afterEach(async () => {
    await repo.cleanup();
    await rm(workspaceRoot, { recursive: true, force: true });
  });

  it('heartbeats throughout a run and delivers an owner stop into it', async () => {
    const recorder = new RecordingClient();
    const polls: { status: string; wantsWork: boolean }[] = [];

    /* An agent that starts work and then waits — a stand-in for a mission that takes minutes. */
    const runtime = new ScriptedRuntime({
      steps: [
        { kind: 'message', text: 'Starting.' },
        { kind: 'wait_for_message' },
        { kind: 'done', result: 'never reached' },
      ],
    });

    let claimed = false;
    let stopSent = false;

    const client = {
      ...asClient(recorder),
      async poll(input: { heartbeat: { status: string }; wantsWork: boolean }) {
        polls.push({ status: input.heartbeat.status, wantsWork: input.wantsWork });

        /*
         * Once the worker has been seen alive several times *while running*, send the owner's
         * stop through the poll — which is the only channel a command has, and the channel that
         * did not exist during a run before the loop was split.
         */
        const commands: PendingCommand[] = [];
        if (
          recorder.states.includes('running') &&
          polls.filter((entry) => entry.status === 'busy').length >= 3 &&
          !stopSent
        ) {
          stopSent = true;
          recorder.ownerMove('stopping');
          commands.push({
            id: 'command-1',
            kind: 'stop',
            missionId: MISSION_ID,
            runId: RUN_ID,
            payload: { reason: 'Changed my mind.' },
            requestedAt: new Date().toISOString(),
          } satisfies PendingCommand);
        }

        return {
          workerId: 'worker-1',
          serverTime: new Date().toISOString(),
          assignment: null,
          commands,
          /* Once the run has finished, end the process so the test terminates. */
          directive:
            recorder.states.includes('stopped') || polls.length > 80
              ? ('revoked' as const)
              : ('continue' as const),
          pollIntervalMs: 5,
        };
      },
      async claim() {
        if (claimed) return null;
        claimed = true;
        return assignmentFor(repo);
      },
      async claimTask() {
        return null;
      },
    };

    const worker = new JarvisWorkerProcess({
      config: {
        ...processConfig(workspaceRoot),
        githubToken: 'ghp_fake_worker_token_for_tests_only_00',
      },
      client: client as unknown as WorkerRuntimeDeps['client'],
      runtime,
      delivery: new FakeDelivery(),
      sleep: async (ms: number) => {
        await new Promise((resolve) => setTimeout(resolve, Math.min(ms, 5)));
      },
      log: () => undefined,
    });

    await worker.run();

    /*
     * Heartbeats arrived *while the mission was running*. Before the loop was split there would be
     * one poll before the claim and then nothing until the run ended — which, for a real Claude
     * mission, is well past the point where the control plane declares the worker disconnected.
     */
    const busy = polls.filter((entry) => entry.status === 'busy');
    expect(busy.length).toBeGreaterThanOrEqual(3);

    /* And it did not ask for more work while it was holding a mission. */
    expect(busy.every((entry) => entry.wantsWork === false)).toBe(true);

    /*
     * The owner's stop reached the running agent through the poll, and the run honoured it. This
     * is the dishonesty that mattered most: without it Jarvis confirmed "stopped, nothing touched"
     * while the agent carried on and would still have opened a pull request.
     */
    expect(stopSent).toBe(true);
    expect(recorder.states).toContain('stopped');
    expect(recorder.last.workspacePreserved).toBe(true);
    expect(await repo.branches()).toEqual(['main']);
  });
});
