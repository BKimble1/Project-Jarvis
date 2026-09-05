import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { getServices } from '@/server/container';
import type { TaskAssignment } from '@/domain/worker-protocol';
import { WORKER_VERSION } from '@/domain/worker-protocol';
import type { WorkerConfig } from '@/worker/config';
import type { AgentSessionRequest } from '@/worker/runtime/types';
import { TaskRunner } from '@/worker/task-runner';
import { ScriptedRuntime, type ScriptedStep } from '@/worker/runtime/scripted';
import { createSandboxRepo, type SandboxRepo } from '../helpers/sandbox-repo';
import { FakeDelivery } from '../helpers/fake-delivery';

/**
 * §30: the deterministic multi-agent smoke test.
 *
 * This is the test the whole phase is answerable to, so almost nothing in it is a stand-in. The
 * control plane is the real one — a real database, the real container, the real route handlers,
 * the real orchestrator and the real state machines. The workers are real `TaskRunner`s. The
 * repository is a real git repository on this disk, so every clone, branch, commit and merge is
 * real, with real refusals. Two things are replaced and only two: **the model**, by the scripted
 * runtime, and **GitHub's API**, by `FakeDelivery`.
 *
 * That is what makes it worth running. When this test says no merge to the default branch
 * occurred, it is because `assertPushAllowed` and the git wrapper refused — not because a mock
 * agreed to say so.
 *
 * It proves, in one run, every claim §30 asks for:
 *
 *  1. a task graph is created from an approved plan and approved by the owner;
 *  2. two read-only tasks run at the same time;
 *  3. the builder waits for the research it depends on;
 *  4. the builder works on an isolated branch of its own;
 *  5. verification runs against the integrated result;
 *  6. the reviewer receives cold context;
 *  7. the reviewer catches a defect deliberately seeded in the builder's output;
 *  8. repair is bounded;
 *  9. a *fresh* reviewer evaluates the repaired work;
 * 10. the integration branch stays separate from the default branch;
 * 11. a draft pull request is produced;
 * 12. no merge happens;
 * 13. no forbidden API is called.
 */

const cookieStore = new Map<string, string>();
const requestHeaders = new Map<string, string>();

vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => {
      const value = cookieStore.get(name);
      return value === undefined ? undefined : { name, value };
    },
    set: (name: string, value: string) => cookieStore.set(name, value),
    delete: (name: string) => cookieStore.delete(name),
  }),
  headers: async () => ({
    get: (name: string) => requestHeaders.get(name.toLowerCase()) ?? null,
  }),
}));

const BASE = 'http://localhost:3000';
const SESSION_COOKIE = 'jarvis_session';

const ENV: Record<string, string> = {
  NODE_ENV: 'test',
  JARVIS_BASE_URL: BASE,
  SESSION_SECRET: 'test-session-secret-value-that-is-long-enough',
  OWNER_GITHUB_LOGIN: 'test-owner',
  OWNER_GITHUB_USER_ID: '4242',
  GITHUB_OAUTH_CLIENT_ID: 'client-id',
  GITHUB_OAUTH_CLIENT_SECRET: 'client-secret',
  JARVIS_DB_DRIVER: 'pglite',
  CRON_SECRET: 'cron-secret-value-000000000001',
  JARVIS_AI_ENABLED: 'false',
  JARVIS_MAX_PARALLEL_READONLY: '3',
  JARVIS_MAX_ACTIVE_AGENT_RUNS: '4',
  JARVIS_MAX_RUNS_PER_MISSION: '3',
  LOG_LEVEL: 'error',
};

type Services = Awaited<ReturnType<typeof getServices>>;

/* eslint-disable @typescript-eslint/no-explicit-any -- narrowed at each use. */
type Json = Record<string, any>;
/* eslint-enable @typescript-eslint/no-explicit-any */

async function body(response: Response): Promise<Json> {
  return (await response.json()) as Json;
}

function ownerPost(path: string, json?: unknown): Request {
  const headers = new Headers({ 'content-type': 'application/json', origin: BASE });
  return new Request(`${BASE}${path}`, {
    method: 'POST',
    headers,
    body: json === undefined ? undefined : JSON.stringify(json),
  });
}

function workerPost(path: string, token: string, json: unknown): Request {
  const headers = new Headers({
    'content-type': 'application/json',
    authorization: `Bearer ${token}`,
    'idempotency-key': `key-${Math.random().toString(36).slice(2)}-aaaa`,
  });
  return new Request(`${BASE}${path}`, { method: 'POST', headers, body: JSON.stringify(json) });
}

const params = <T extends Record<string, string>>(value: T) => ({ params: Promise.resolve(value) });

const HEARTBEAT = {
  status: 'idle' as const,
  /* Either claim route refuses a worker whose build does not match, so this reports a real one. */
  version: WORKER_VERSION,
  runtimeAvailable: true,
  workspaceHealthy: true,
  githubDeliveryConfigured: true,
  diagnostics: [],
};

/**
 * A worker's control-plane client, wired to the real route handlers.
 *
 * Not a mock of the control plane: every call below invokes the module Next.js deploys, with a
 * real worker bearer token, against the real database. What it replaces is only the network.
 * A route that would return 403 in production returns 403 here, and the runner sees it.
 */
class RouteClient {
  /** Every request that left the worker, so the test can prove what was and was not called. */
  readonly calls: { path: string; json: Json }[] = [];

  constructor(private readonly token: string) {}

  private async post<T>(path: string, json: unknown): Promise<T> {
    this.calls.push({ path, json: json as Json });
    const routes: Record<string, () => Promise<{ POST: (request: Request) => Promise<Response> }>> =
      {
        '/api/worker/claim-task': () => import('@/app/api/worker/claim-task/route'),
        '/api/worker/lease': () => import('@/app/api/worker/lease/route'),
        '/api/worker/task': () => import('@/app/api/worker/task/route'),
        '/api/worker/review': () => import('@/app/api/worker/review/route'),
        '/api/worker/events': () => import('@/app/api/worker/events/route'),
        '/api/worker/verification': () => import('@/app/api/worker/verification/route'),
      };
    const loader = routes[path];
    if (!loader) throw new Error(`The worker called an unmapped route: ${path}`);
    const route = await loader();
    const response = await route.POST(workerPost(path, this.token, json));
    const payload = await body(response);
    if (response.status >= 400) {
      throw new Error(`${path} -> ${response.status}: ${JSON.stringify(payload).slice(0, 300)}`);
    }
    return payload as T;
  }

  async claimTask(input: { heartbeat: unknown; roles: readonly string[] }) {
    const response = await this.post<{ assignment: TaskAssignment | null }>(
      '/api/worker/claim-task',
      input,
    );
    return response.assignment;
  }

  acquireLease(input: { runId: string; taskId: string; paths: readonly string[] }) {
    return this.post<{ granted: boolean; reason: string | null }>('/api/worker/lease', input);
  }

  taskState(input: { runId: string; taskId: string; taskState?: string; [key: string]: unknown }) {
    return this.post<{
      ok: true;
      taskState: string;
      stopRequested: boolean;
      pauseRequested: boolean;
    }>('/api/worker/task', input);
  }

  submitReview(input: Record<string, unknown>) {
    return this.post<{ ok: true }>('/api/worker/review', input);
  }

  events(input: { events: readonly unknown[] }) {
    return this.post<{ accepted: number }>('/api/worker/events', input);
  }

  verification(input: Record<string, unknown>) {
    return this.post<{ id: string }>('/api/worker/verification', input);
  }

  artifact(missionId: string, input: Record<string, unknown>) {
    this.calls.push({ path: `/api/worker/missions/${missionId}/artifact`, json: input });
    return import('@/app/api/worker/missions/[id]/artifact/route').then(async (route) => {
      const response = await route.POST(
        workerPost(`/api/worker/missions/${missionId}/artifact`, this.token, input),
        params({ id: missionId }),
      );
      const payload = await body(response);
      if (response.status >= 400) {
        throw new Error(`artifact -> ${response.status}: ${JSON.stringify(payload).slice(0, 300)}`);
      }
      return payload as { id: string };
    });
  }
}

describe('the multi-agent factory, end to end', () => {
  let close: () => Promise<void>;
  let services: Services;
  let restoreEnv: Array<[string, string | undefined]> = [];
  let repo: SandboxRepo;
  let workspaceRoot: string;

  beforeEach(async () => {
    vi.resetModules();
    cookieStore.clear();
    requestHeaders.clear();

    restoreEnv = Object.keys(ENV).map((key) => [key, process.env[key]]);
    for (const [key, value] of Object.entries(ENV)) process.env[key] = value;

    const { createTestDatabase } = await import('../helpers/test-db');
    const database = await createTestDatabase();
    close = database.close;

    const { resetConfigCache } = await import('@/server/config/env');
    resetConfigCache();
    const { resetServices, getServices } = await import('@/server/container');
    resetServices();
    services = await getServices();

    repo = await createSandboxRepo({
      'README.md': '# Sandbox\n\nA repository for tests.\n',
      'src/invoices.ts': 'export function total(lines: number[]): number {\n  return 0;\n}\n',
      /*
       * Every script a plan or discovery might name, and all of them pass. The seeded defect is
       * meant to be caught by the *reviewer*; a check that fails because the sandbox happens not
       * to define a script would prove something else entirely.
       */
      'package.json': JSON.stringify(
        {
          name: 'sandbox',
          version: '1.0.0',
          scripts: {
            lint: 'echo lint ok',
            typecheck: 'echo typecheck ok',
            test: 'echo test ok',
            build: 'echo build ok',
            verify: 'echo verify ok',
          },
        },
        null,
        2,
      ),
    });
    workspaceRoot = await mkdtemp(path.join(tmpdir(), 'jarvis-smoke-'));
  });

  afterEach(async () => {
    const { resetServices } = await import('@/server/container');
    resetServices();
    const { resetConfigCache } = await import('@/server/config/env');
    resetConfigCache();
    for (const [key, value] of restoreEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await close();
    await repo?.cleanup();
    await rm(workspaceRoot, { recursive: true, force: true });
  });

  function workerConfig(): WorkerConfig {
    return {
      controlPlaneUrl: BASE,
      token: 'jarvisw_test',
      name: 'smoke-worker',
      workspaceRoot,
      anthropicApiKey: null,
      anthropicApiKeyPresent: false,
      claudeOauthToken: null,
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
      /* Sandbox mode: every clone of the mission's repository comes from the local bare repo. */
      /* Unset in the real default: delivery is limited by the token alone. */
      allowedRepositories: null,
      sandboxRepositories: new Map([['test-owner/sandbox', repo.remotePath]]),
      /* The real constant: the claim boundary refuses a worker on a different major. */
      version: WORKER_VERSION,
      diagnostics: [],
    };
  }

  /* ------------------------------------------------------ the scripted agents */

  /** A finding shaped the way the review contract asks for it. */
  const seededFinding = {
    key: 'F1',
    severity: 'critical',
    category: 'correctness',
    title: 'total() ignores its input and always returns zero',
    description:
      'The function sums nothing. Every invoice total is reported as 0, which is worse than an error because it looks like a real answer.',
    evidence: 'src/invoices.ts: the body is `return 0;` and never reads `lines`.',
    file: 'src/invoices.ts',
    line: 2,
    recommendation: 'Sum the lines and return the total.',
    confidence: 'high',
    blocksDelivery: true,
  };

  const reviewReply = (verdict: string, findings: unknown[], summary: string): ScriptedStep[] => [
    { kind: 'message', text: summary },
    {
      kind: 'message',
      text: `\`\`\`json\n${JSON.stringify({ verdict, summary, findings }, null, 2)}\n\`\`\``,
    },
    { kind: 'done', result: summary },
  ];

  /**
   * One script per role.
   *
   * The builder deliberately ships the defect. That is the point of the exercise: a review stage
   * that only ever sees correct work proves nothing about whether it would catch incorrect work.
   */
  function stepsFor(request: AgentSessionRequest): readonly ScriptedStep[] | null {
    const prompt = request.prompt;

    if (prompt.includes('## Return your verdict as JSON')) {
      /*
       * Which review is this? The first reviewer sees a `return 0;` diff and must catch it; the
       * fresh reviewer that follows the repair sees the fixed file and approves. The reviewer is
       * told nothing about the previous round's verdict, so this test decides by reading the
       * *diff it was given* — exactly what a real reviewer would do.
       */
      const sawTheDefect = !/lines\.reduce/.test(prompt);
      return sawTheDefect
        ? reviewReply(
            'repair_required',
            [seededFinding],
            'The change adds a total() that never reads its input.',
          )
        : reviewReply(
            'approved',
            [],
            'total() now sums its lines, the required check passed, and the diff stays inside the approved scope.',
          );
    }

    if (prompt.includes('Findings to repair') || prompt.includes('F1')) {
      return [
        { kind: 'message', text: 'Fixing the total.' },
        {
          kind: 'tool',
          toolName: 'Write',
          input: { file_path: 'src/invoices.ts' },
          effect: async (workspace: string) => {
            await writeFile(
              path.join(workspace, 'src/invoices.ts'),
              'export function total(lines: number[]): number {\n  return lines.reduce((sum, line) => sum + line, 0);\n}\n',
              'utf8',
            );
          },
        },
        { kind: 'done', result: 'total() now sums its lines.' },
      ];
    }

    /* The builder: writes the feature, with the defect. */
    if (request.systemPrompt.includes('builder') || prompt.includes('Implement')) {
      return [
        { kind: 'message', text: 'Adding the scanner.' },
        {
          kind: 'tool',
          toolName: 'Write',
          input: { file_path: 'src/invoices.ts' },
          effect: async (workspace: string) => {
            await writeFile(
              path.join(workspace, 'src/invoices.ts'),
              'export function total(lines: number[]): number {\n  return 0;\n}\n\nexport function scan(text: string): number[] {\n  return text.split(",").map(Number);\n}\n',
              'utf8',
            );
          },
        },
        { kind: 'done', result: 'Added scan() and total().' },
      ];
    }

    /* Everything read-only: report and stop. */
    return [
      {
        kind: 'message',
        text: 'src/invoices.ts holds the parsing. Nothing else touches invoices.',
      },
      { kind: 'done', result: 'Findings recorded.' },
    ];
  }

  /* --------------------------------------------------------------- the driver */

  /**
   * Claim and run one task, exactly as `main.ts` does.
   *
   * Returns the assignment so a test can assert on what the worker was handed. A `null` means
   * the control plane had nothing for this worker, which is itself an assertable outcome.
   */
  async function runAssignment(
    client: RouteClient,
    runtime: ScriptedRuntime,
    delivery: FakeDelivery,
    assignment: TaskAssignment,
  ): Promise<void> {
    const runner = new TaskRunner(
      {
        config: workerConfig(),
        /* eslint-disable-next-line @typescript-eslint/no-explicit-any -- the real routes behind it. */
        client: client as any,
        runtime,
        delivery,
      },
      assignment,
    );
    await runner.run();
  }

  async function runOneTask(
    client: RouteClient,
    runtime: ScriptedRuntime,
    delivery: FakeDelivery,
    roles: readonly string[] = ALL_ROLES,
  ): Promise<TaskAssignment | null> {
    const assignment = await client.claimTask({ heartbeat: HEARTBEAT, roles });
    if (!assignment) return null;
    await runAssignment(client, runtime, delivery, assignment);
    return assignment;
  }

  const ALL_ROLES = [
    'researcher',
    'builder',
    'verifier',
    'reviewer',
    'security_reviewer',
    'ux_reviewer',
    'repairer',
    'integrator',
    'documenter',
    'investigator',
  ];

  it('runs a mission through research, build, integration, verification, review, bounded repair and a draft pull request', async () => {
    /* ---------------------------------------------------------- 0. the mission */

    const { token } = await services.sessions.create({
      githubLogin: 'test-owner',
      githubUserId: '4242',
      displayName: 'Test owner',
      avatarUrl: null,
      ttlHours: 2,
    });
    cookieStore.set(SESSION_COOKIE, token);

    const project = await services.projects.create({
      name: 'Sandbox',
      type: 'software',
      status: 'active',
      priority: 'medium',
      tags: [],
      links: [],
    });

    /*
     * The project's repository, added the way an import adds one. The mission resolves its
     * repository from here — which is the path production uses — rather than from a column set
     * by the test.
     */
    await services.sources.addGithubSource(project.id, { owner: 'test-owner', repo: 'sandbox' });

    const missions = await import('@/app/api/missions/route');
    const created = await missions.POST(
      ownerPost('/api/missions', {
        rawRequest: 'Add invoice scanning to src/invoices.ts',
        projectId: project.id,
      }),
    );
    expect(created.status).toBe(201);
    const missionId = (await body(created)).mission.id as string;

    const clarify = await import('@/app/api/missions/[id]/clarify/route');
    for (let round = 0; round < 5; round += 1) {
      const open = (await services.clarifications.list(missionId)).filter(
        (question) => question.answeredAt === null,
      );
      if (open.length === 0) break;
      for (const question of open) {
        await clarify.POST(
          ownerPost(`/api/missions/${missionId}/clarify`, {
            questionId: question.id,
            answer: 'Whatever the plan says is fine.',
          }),
          params({ id: missionId }),
        );
      }
    }

    const planRoute = await import('@/app/api/missions/[id]/plan/route');
    expect(
      (
        await planRoute.POST(
          ownerPost(`/api/missions/${missionId}/plan`),
          params({ id: missionId }),
        )
      ).status,
    ).toBe(201);

    const mission = await services.missionRepo.findById(missionId);
    const approveRoute = await import('@/app/api/missions/[id]/approve/route');
    const approved = await approveRoute.POST(
      ownerPost(`/api/missions/${missionId}/approve`, {
        planVersion: mission?.currentPlanVersion ?? 1,
        acknowledgedRiskLevel: mission?.riskLevel ?? 'moderate',
      }),
      params({ id: missionId }),
    );
    expect(approved.status, JSON.stringify(await approved.clone().json())).toBe(200);

    /* --------------------------------------------------- 1. a task graph exists */

    await services.playbookService.seedBuiltIns();
    const graphRoute = await import('@/app/api/missions/[id]/graph/route');
    const proposed = await graphRoute.POST(
      ownerPost(`/api/missions/${missionId}/graph`, { playbookKey: 'software_feature' }),
      params({ id: missionId }),
    );
    expect(proposed.status, JSON.stringify(await proposed.clone().json())).toBe(201);
    const proposal = (await body(proposed)).proposal as Json;

    const graphTasks = proposal.tasks as Json[];
    expect(graphTasks.map((task) => task.role)).toEqual(
      expect.arrayContaining(['researcher', 'builder', 'integrator', 'verifier', 'reviewer']),
    );

    /* Nothing may be claimed before the owner approves it. */
    const enrolled = await services.workerService.enrol('smoke-worker', 2);
    const preApproval = new RouteClient(enrolled.token);
    expect(await preApproval.claimTask({ heartbeat: HEARTBEAT, roles: ALL_ROLES })).toBeNull();

    const approveGraph = await import('@/app/api/missions/[id]/graph/approve/route');
    const graphApproved = await approveGraph.POST(
      ownerPost(`/api/missions/${missionId}/graph/approve`, {
        graphVersion: proposal.graph.version,
        fingerprint: proposal.graph.fingerprint,
      }),
      params({ id: missionId }),
    );
    expect(graphApproved.status, JSON.stringify(await graphApproved.clone().json())).toBe(200);

    /* ------------------------------------------------------- 3-12. the real run */

    const client = new RouteClient(enrolled.token);
    const runtime = new ScriptedRuntime({ steps: [{ kind: 'done', result: 'ok' }], stepsFor });
    const delivery = new FakeDelivery();

    /*
     * 3. The builder waits for the research it depends on. Asserted while the researcher is
     * *claimed but unfinished*: a second worker asking specifically for builder work at that
     * moment gets nothing, because the dependency is not satisfied yet.
     */
    const second = await services.workerService.enrol('smoke-worker-2', 2);
    const secondClient = new RouteClient(second.token);
    const firstClaim = await client.claimTask({ heartbeat: HEARTBEAT, roles: ALL_ROLES });
    expect(firstClaim?.role).toBe('researcher');
    expect(await secondClient.claimTask({ heartbeat: HEARTBEAT, roles: ['builder'] })).toBeNull();
    await runAssignment(client, runtime, delivery, firstClaim!);

    const seen: { key: string; role: string; branch: string | null }[] = [
      { key: firstClaim!.taskKey, role: firstClaim!.role, branch: firstClaim!.branchName },
    ];
    for (let step = 0; step < 20; step += 1) {
      const assignment = await runOneTask(client, runtime, delivery);
      if (!assignment) break;
      seen.push({
        key: assignment.taskKey,
        role: assignment.role,
        branch: assignment.branchName,
      });
    }

    const roles = seen.map((entry) => entry.role);
    expect(roles).toEqual(
      expect.arrayContaining(['researcher', 'builder', 'integrator', 'verifier', 'reviewer']),
    );

    /* 3. The builder ran only after the research it depends on had finished. */
    expect(roles.indexOf('builder')).toBeGreaterThan(roles.indexOf('researcher'));

    /* 4. The builder worked on a branch of its own, not the integration branch and not main. */
    const builderRun = seen.find((entry) => entry.role === 'builder')!;
    expect(builderRun.branch).toMatch(/^jarvis\//);
    expect(builderRun.branch).not.toBe('main');
    expect(builderRun.branch).not.toContain('integration');

    /* 5. Verification really ran, against the integrated result. */
    const verifications = await services.verifications.list(missionId);
    expect(verifications.length).toBeGreaterThan(0);

    /* 7 & 8. The reviewer caught the seeded defect, and a bounded repair was scheduled. */
    const reviews = await services.reviews.listByMission(missionId);
    expect(reviews.length).toBeGreaterThanOrEqual(2);
    const firstReview = reviews[0]!;
    expect(firstReview.verdict).toBe('repair_required');
    const findings = await services.reviews.listFindings(missionId);
    expect(findings.some((finding) => finding.title.includes('always returns zero'))).toBe(true);

    /* 9. The repair was reviewed by a *fresh* review task, not by the reviewer that found it. */
    const repairTasks = (await services.tasks.listByMission(missionId)).filter(
      (task) => task.repairRound > 0,
    );
    expect(repairTasks.some((task) => task.role === 'repairer')).toBe(true);
    expect(repairTasks.some((task) => task.role === 'reviewer')).toBe(true);
    const freshReview = reviews[reviews.length - 1]!;
    expect(freshReview.id).not.toBe(firstReview.id);
    expect(freshReview.verdict).toBe('approved');

    /* 8 again, explicitly: the graph never went past its approved repair budget. */
    const graph = await services.graphs.byVersion(missionId, proposal.graph.version as number);
    expect(Math.max(...repairTasks.map((task) => task.repairRound))).toBeLessThanOrEqual(
      graph!.maxRepairRounds,
    );

    /* 11. A draft pull request was produced. */
    expect(delivery.created).toHaveLength(1);
    const pullRequest = delivery.created[0]!;
    expect(pullRequest.base).toBe('main');
    expect(pullRequest.head).toContain('integration');
    /*
     * Draft is not a flag the worker chooses. `createDraftPullRequest` is the only creation
     * method there is, and its result is `draft: true` unconditionally — the mission's stored
     * pull-request URL is the one it returned.
     */
    expect((await services.missionRepo.findById(missionId))?.pullRequestUrl).toContain('/pull/');

    /* 10 & 12. The default branch never moved, and no merge happened. */
    const branches = await repo.branches();
    expect(branches).toContain('main');
    expect(branches.some((branch) => branch.includes('integration'))).toBe(true);
    /* `main` still holds the original file — nothing was merged into it. */
    expect(await repo.fileOnBranch('main', 'src/invoices.ts')).toContain('return 0;');
    /* The integration branch holds the *repaired* work. */
    const integrationBranch = branches.find((branch) => branch.includes('integration'))!;
    expect(await repo.fileOnBranch(integrationBranch, 'src/invoices.ts')).toContain('reduce');

    /* 6. The reviewer's prompt carried cold context: evidence, never a builder transcript. */
    const reviewPrompts = runtime.prompts.filter((entry) =>
      entry.user.includes('## Return your verdict as JSON'),
    );
    expect(reviewPrompts.length).toBeGreaterThanOrEqual(2);
    for (const prompt of reviewPrompts) {
      /* The context, without the output contract that necessarily names every verdict word. */
      const context = prompt.user.split('## Return your verdict as JSON')[0]!;
      /* No builder or repairer transcript — the reviewer never learns how the work was argued. */
      expect(context).not.toContain('Adding the scanner.');
      expect(context).not.toContain('Fixing the total.');
      expect(context).not.toContain('Added scan() and total().');
      expect(context).not.toContain('total() now sums its lines.');
      /* But it does carry the evidence a review has to stand on. */
      expect(context).toMatch(/verification|check/i);
      expect(context).toMatch(/diff|changed/i);
    }

    /*
     * And the fresh reviewer was told nothing about what the first one *concluded*.
     *
     * It is told which findings the repair was scoped to — deliberately, because checking that a
     * repair stayed inside its scope is part of its job — but not the verdict that produced them,
     * not the previous reviewer's reasoning, and not whether anyone thought the work was ready.
     */
    const lastContext = reviewPrompts[reviewPrompts.length - 1]!.user.split(
      '## Return your verdict as JSON',
    )[0]!;
    /*
     * Bare verdict words are not checked, and neither is the phrase "previous review": the
     * reviewer's own rules necessarily use both — "you cannot approve while a required check
     * failed", "you have not been told what any earlier reviewer concluded". Matching on those
     * would be matching the safeguard rather than the leak.
     *
     * What must not be there is the previous review itself: its summary, and the finding text it
     * produced beyond the scope line the repair was given.
     */
    expect(lastContext).not.toContain(firstReview.summary);
    expect(lastContext).toContain('You have not been told what any earlier reviewer concluded.');

    /* 13. No forbidden API was called, by the worker or by the delivery client. */
    const workerPaths = new Set(
      client.calls.map((call) => call.path.replace(/[0-9a-f-]{36}/g, ':id')),
    );
    expect([...workerPaths].sort()).toEqual([
      '/api/worker/claim-task',
      '/api/worker/events',
      '/api/worker/lease',
      '/api/worker/missions/:id/artifact',
      '/api/worker/review',
      '/api/worker/task',
      '/api/worker/verification',
    ]);
    /*
     * There is no merge, force-push, release or workflow-dispatch *assertion* to make, because
     * there is no such method to call: `GitHubDelivery` has five — three writes and two reads —
     * and this is all of them. A capability that does not exist cannot be used by mistake, which
     * is a better guarantee than a counter that happens to read zero.
     */
    const { FakeDelivery: DeliveryClass } = await import('../helpers/fake-delivery');
    expect(
      Object.getOwnPropertyNames(DeliveryClass.prototype)
        .filter((name) => name !== 'constructor')
        .sort(),
    ).toEqual([
      'checkStatus',
      'comment',
      'createDraftPullRequest',
      'findOpenPullRequest',
      'updatePullRequestBody',
    ]);

    /* And the mission ended somewhere honest. */
    const finished = await services.missionRepo.findById(missionId);
    expect(finished?.state).toBe('pull_request_ready');
    expect(finished?.pullRequestUrl).toBeTruthy();

    const receiptRoute = await import('@/app/api/missions/[id]/receipt/route');
    const receipt = (
      await body(
        await receiptRoute.GET(
          new Request(`${BASE}/api/missions/${missionId}/receipt`),
          params({ id: missionId }),
        ),
      )
    ).receipt as Json;
    const stages = new Map(
      (receipt.stages as Json[]).map((stage) => [stage.stage as string, stage]),
    );
    expect(stages.get('pull_request_created')?.reached).toBe(true);
    expect(stages.get('pull_request_created')?.evidence).toBeTruthy();
    expect(stages.get('review_completed')?.reached).toBe(true);
    expect(stages.get('verification_completed')?.reached).toBe(true);

    /* The three rungs Jarvis structurally cannot reach say so, rather than merely being false. */
    for (const never of ['pull_request_merged', 'deployed', 'production_released']) {
      expect(stages.get(never)?.reached).toBe(false);
      expect(stages.get(never)?.unreachableReason).toBeTruthy();
    }

    /*
     * The repository on disk still has exactly one commit on `main`.
     *
     * `git log`, not `git rev-list` — the worker's git wrapper allow-lists a small set of
     * subcommands and `rev-list` is deliberately not one of them, so the test uses what the
     * product uses.
     */
    const log = await (
      await import('@/worker/git')
    ).git(['log', '--oneline', 'main'], {
      cwd: repo.remotePath,
    });
    expect(log.stdout.trim().split('\n')).toHaveLength(1);
  }, 180_000);

  /**
   * §30's second claim: two read-only tasks may genuinely run at the same time.
   *
   * Asserted by holding both claims open. Two workers claim, neither finishes, and both are
   * looking at different tasks with live runs — which is the only way to tell parallelism from a
   * queue that happens to be fast.
   */
  it('runs two read-only tasks at the same time, on two workers', async () => {
    const { token } = await services.sessions.create({
      githubLogin: 'test-owner',
      githubUserId: '4242',
      displayName: 'Test owner',
      avatarUrl: null,
      ttlHours: 2,
    });
    cookieStore.set(SESSION_COOKIE, token);

    const project = await services.projects.create({
      name: 'Sandbox',
      type: 'software',
      status: 'active',
      priority: 'medium',
      tags: [],
      links: [],
    });
    await services.sources.addGithubSource(project.id, { owner: 'test-owner', repo: 'sandbox' });

    const missions = await import('@/app/api/missions/route');
    const created = await missions.POST(
      ownerPost('/api/missions', {
        rawRequest: 'Audit this repository and tell me what is risky',
        projectId: project.id,
      }),
    );
    const missionId = (await body(created)).mission.id as string;

    const clarify = await import('@/app/api/missions/[id]/clarify/route');
    for (let round = 0; round < 5; round += 1) {
      const open = (await services.clarifications.list(missionId)).filter(
        (question) => question.answeredAt === null,
      );
      if (open.length === 0) break;
      for (const question of open) {
        await clarify.POST(
          ownerPost(`/api/missions/${missionId}/clarify`, {
            questionId: question.id,
            answer: 'Whatever the plan says is fine.',
          }),
          params({ id: missionId }),
        );
      }
    }
    const planRoute = await import('@/app/api/missions/[id]/plan/route');
    expect(
      (
        await planRoute.POST(
          ownerPost(`/api/missions/${missionId}/plan`),
          params({ id: missionId }),
        )
      ).status,
    ).toBe(201);

    const mission = await services.missionRepo.findById(missionId);
    const approveRoute = await import('@/app/api/missions/[id]/approve/route');
    expect(
      (
        await approveRoute.POST(
          ownerPost(`/api/missions/${missionId}/approve`, {
            planVersion: mission?.currentPlanVersion ?? 1,
            acknowledgedRiskLevel: mission?.riskLevel ?? 'moderate',
          }),
          params({ id: missionId }),
        )
      ).status,
    ).toBe(200);

    /* The audit playbook opens with three independent read-only tasks. */
    await services.playbookService.seedBuiltIns();
    const graphRoute = await import('@/app/api/missions/[id]/graph/route');
    const proposed = await graphRoute.POST(
      ownerPost(`/api/missions/${missionId}/graph`, { playbookKey: 'repository_audit' }),
      params({ id: missionId }),
    );
    expect(proposed.status, JSON.stringify(await proposed.clone().json())).toBe(201);
    const proposal = (await body(proposed)).proposal as Json;

    const approveGraph = await import('@/app/api/missions/[id]/graph/approve/route');
    expect(
      (
        await approveGraph.POST(
          ownerPost(`/api/missions/${missionId}/graph/approve`, {
            graphVersion: proposal.graph.version,
            fingerprint: proposal.graph.fingerprint,
          }),
          params({ id: missionId }),
        )
      ).status,
    ).toBe(200);

    const a = await services.workerService.enrol('reader-a', 1);
    const b = await services.workerService.enrol('reader-b', 1);
    const clientA = new RouteClient(a.token);
    const clientB = new RouteClient(b.token);

    const first = await clientA.claimTask({ heartbeat: HEARTBEAT, roles: ALL_ROLES });
    const second = await clientB.claimTask({ heartbeat: HEARTBEAT, roles: ALL_ROLES });

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(first!.taskId).not.toBe(second!.taskId);
    /* Neither may write: a read-only task declares no write set and gets a read-only clone. */
    for (const assignment of [first!, second!]) {
      expect(assignment.declaredWriteSet).toEqual([]);
      expect(assignment.workspaceRequirement).toBe('readonly_clone');
      expect(assignment.branchName).toBeNull();
    }

    /* Both are live at once, on separate runs, held by separate workers. */
    const held = (await services.tasks.listByMission(missionId)).filter(
      (task) => task.state === 'claimed',
    );
    expect(held).toHaveLength(2);
    expect(new Set(held.map((task) => task.activeRunId)).size).toBe(2);

    /* Two live runs, on two different workers, for two different tasks. */
    const runs = await services.missionRuns.list(missionId);
    const live = runs.filter((run) => run.state === 'starting' || run.state === 'running');
    expect(live).toHaveLength(2);
    expect(new Set(live.map((run) => run.workerId)).size).toBe(2);
    expect(new Set(live.map((run) => run.taskId)).size).toBe(2);
  }, 120_000);
});
