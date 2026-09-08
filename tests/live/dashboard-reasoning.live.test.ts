import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { WORKER_VERSION } from '@/domain/worker-protocol';
import type { WorkerConfig } from '@/worker/config';
import type { getServices } from '@/server/container';

/**
 * The whole path, with a real model on the owner's own subscription.
 *
 * ## What this is
 *
 * Everything a QuickPick message touches except the browser: the real conversation route, the real
 * interpreter, the real proposal store, the real reasoning queue and its lease, the real worker
 * process claiming and reporting over the real authenticated HTTP routes — and, unlike every other
 * suite in this repository, the real `ClaudeAgentRuntime`. No scripted reply. The model actually
 * decides whether QuickPick is worth building.
 *
 * ## Why it exists
 *
 * Because two bugs reached a live morning with a hundred scripted tests passing, and both were
 * about the real runtime rather than the logic around it: a stream that never ends, and an answer
 * that arrives twice with one copy truncated. A stand-in models neither, by construction. The only
 * way to know the path works is to run it.
 *
 * ## What it costs
 *
 * One short reasoning turn of subscription capacity, and a minute or so of waiting. That is why it
 * lives in `tests/live` behind `JARVIS_LIVE_TESTS=true` rather than in the suite people run all
 * day. The scripted suites still carry every regression; this is the confirmation, not the guard.
 *
 * There is no `ANTHROPIC_API_KEY` in this environment, deliberately. The model access under test is
 * the Claude Code subscription login this machine already has.
 */

const MESSAGE_ONE =
  'I have an idea for a tiny app called QuickPick that lets someone enter two choices and ' +
  'randomly selects one with a clean animation. Is this worth building? Ask only questions that ' +
  'materially affect a simple V1. Do not build it yet.';

const cookieStore = new Map<string, string>();

vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => {
      const value = cookieStore.get(name);
      return value === undefined ? undefined : { name, value };
    },
    set: (name: string, value: string) => cookieStore.set(name, value),
    delete: (name: string) => cookieStore.delete(name),
  }),
  headers: async () => ({ get: () => null }),
}));

const BASE = 'http://localhost:3000';

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
  JARVIS_MISSION_CONCURRENCY: '1',
  LOG_LEVEL: 'error',
};

const HEARTBEAT = {
  status: 'idle' as const,
  version: WORKER_VERSION,
  platform: 'test',
  runtimeAvailable: true,
  runtimeName: 'claude-agent-sdk',
  runtimeDetail: 'Real Claude runtime.',
  workspaceHealthy: true,
  workspaceRootLabel: null,
  githubDeliveryConfigured: false,
  diagnostics: [],
  currentMissionId: null,
  currentRunId: null,
  lastActivityAt: null,
};

function workerConfig(workspaceRoot: string): WorkerConfig {
  return {
    controlPlaneUrl: BASE,
    token: 'jarvisw_test',
    name: 'live-reasoning-worker',
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
    pollIntervalMs: 1,
    verifyTimeoutMs: 60_000,
    runTimeoutMs: 300_000,
    accepts: ['execution'],
    allowWebResearch: false,
    runtime: 'claude',
    allowedRepositories: null,
    sandboxRepositories: new Map(),
    version: WORKER_VERSION,
    diagnostics: [],
  };
}

describe('a real dashboard question, answered by a real model', () => {
  let close: () => Promise<void>;
  let services: Awaited<ReturnType<typeof getServices>>;
  let restoreEnv: Array<[string, string | undefined]> = [];
  let workspaceRoot: string;
  let workerToken: string;

  beforeEach(async () => {
    vi.resetModules();
    cookieStore.clear();
    restoreEnv = Object.entries(ENV).map(([key]) => [key, process.env[key]]);
    for (const [key, value] of Object.entries(ENV)) process.env[key] = value;
    delete process.env.ANTHROPIC_API_KEY;

    workspaceRoot = await mkdtemp(path.join(tmpdir(), 'jarvis-live-dashboard-'));

    const { createTestDatabase } = await import('../helpers/test-db');
    const database = await createTestDatabase();
    close = database.close;

    const { resetConfigCache } = await import('@/server/config/env');
    resetConfigCache();
    const { resetServices, getServices } = await import('@/server/container');
    resetServices();
    services = await getServices();

    const { token } = await services.sessions.create({
      githubLogin: 'test-owner',
      githubUserId: '4242',
      displayName: 'Test owner',
      avatarUrl: null,
      ttlHours: 2,
    });
    cookieStore.set('jarvis_session', token);
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
    await rm(workspaceRoot, { recursive: true, force: true });
  });

  it(
    'goes from "Is this worth building?" to a judgement, with nothing built and no API key',
    async () => {
      expect(process.env.ANTHROPIC_API_KEY).toBeUndefined();

      const enrolment = await services.workerService.enrol('live-reasoning-worker', 1);
      workerToken = enrolment.token;
      await services.workerService.poll(enrolment.worker.id, {
        heartbeat: HEARTBEAT,
        wantsWork: true,
        acknowledgedCommandIds: [],
      });

      /* The owner's message, through the route the browser posts to. */
      const { POST } = await import('@/app/api/conversation/route');
      const response = await POST(
        new Request(`${BASE}/api/conversation`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', origin: BASE },
          body: JSON.stringify({ message: MESSAGE_ONE }),
        }),
      );
      expect(response.status).toBe(200);
      const turn = (await response.json()) as Record<string, unknown>;
      const thinking = turn.thinking as { state: string; requestId: string };

      /* Nothing judged yet, nothing invented, and nothing built — he said not to build it. */
      expect(turn.kind).toBe('idea');
      expect(thinking.state).toBe('thinking');
      expect(turn.evaluation).toBeNull();
      expect(await services.projects.listAllForAssessment(true)).toHaveLength(0);
      expect(await services.missionRepo.listOpen()).toHaveLength(0);

      /* And nothing on the wire that looks like a credential or an instruction to get one. */
      const wire = JSON.stringify(turn);
      expect(wire).not.toContain(workerToken);
      expect(wire).not.toMatch(/ANTHROPIC_API_KEY/i);
      expect(wire).not.toMatch(/api key/i);

      await runRealWorkerUntilReported();

      /* Read it back exactly as the browser's poller does. */
      const { GET } = await import('@/app/api/conversation/thinking/route');
      const statusResponse = await GET(
        new Request(
          `${BASE}/api/conversation/thinking?request=${encodeURIComponent(thinking.requestId)}`,
        ),
      );
      expect(statusResponse.status).toBe(200);
      const status = ((await statusResponse.json()) as { thinking: Record<string, unknown> })
        .thinking;

      expect(status.state, JSON.stringify(status)).toBe('ready');
      const evaluation = status.evaluation as {
        basis: string;
        verdict: string;
        smallestV1: string[];
        questions: string[];
      };

      /* A real judgement, from a real model, and stamped as reasoned by the code rather than the model. */
      expect(evaluation.basis).toBe('reasoned');
      expect(evaluation.verdict.length).toBeGreaterThan(40);
      expect(evaluation.smallestV1.length).toBeGreaterThan(0);
      expect(evaluation.questions.length).toBeGreaterThan(0);
      /* Never the sentence this whole path exists to stop saying. */
      expect(evaluation.verdict).not.toMatch(/no model is configured/i);
      expect(evaluation.verdict).not.toMatch(/nothing has judged/i);

      /* It reached the proposal too, so the next thing to read it sees the assessment. */
      const proposal = await services.proposals.findById((turn.proposal as { id: string }).id);
      expect(proposal?.evaluation?.basis).toBe('reasoned');
      expect(proposal?.state).toBe('open');

      /* And still nothing built. Thinking is not doing. */
      expect(await services.projects.listAllForAssessment(true)).toHaveLength(0);
      expect(await services.missionRepo.listOpen()).toHaveLength(0);
    },
    TURN_TIMEOUT_MS,
  );

  /**
   * The real worker process, with the real Claude runtime, over the real routes.
   *
   * Bounded on ticks as well as on time: a worker that never claims should fail this test rather
   * than hold the suite until the runner gives up on it.
   */
  async function runRealWorkerUntilReported(): Promise<void> {
    const { JarvisWorkerProcess } = await import('@/worker/main');
    const { ClaudeAgentRuntime } = await import('@/worker/runtime/claude-agent-sdk');

    const runtime = new ClaudeAgentRuntime({
      apiKey: null,
      oauthToken: process.env.CLAUDE_CODE_OAUTH_TOKEN ?? null,
      authMode: 'subscription',
      apiKeyPresent: false,
      model: null,
    });

    let worker: InstanceType<typeof JarvisWorkerProcess> | null = null;
    let reported = false;

    const post = async (route: string, body: unknown) => {
      const headers = new Headers({ 'content-type': 'application/json' });
      headers.set('authorization', `Bearer ${workerToken}`);
      headers.set('idempotency-key', `live-${Math.random().toString(36).slice(2)}-aaaa`);
      return new Request(`${BASE}${route}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });
    };

    const client = {
      async poll(input: unknown) {
        const { POST } = await import('@/app/api/worker/poll/route');
        const response = await POST(await post('/api/worker/poll', input));
        expect(response.status).toBe(200);
        return response.json();
      },
      async claimReasoning(input: unknown) {
        const { POST } = await import('@/app/api/worker/reasoning/claim/route');
        const response = await POST(await post('/api/worker/reasoning/claim', input));
        expect(response.status).toBe(200);
        return ((await response.json()) as { assignment: unknown }).assignment;
      },
      async reportReasoning(input: unknown) {
        const { POST } = await import('@/app/api/worker/reasoning/route');
        const response = await POST(await post('/api/worker/reasoning', input));
        expect(response.status).toBe(200);
        reported = true;
        worker?.stop();
        return response.json();
      },
      async claim() {
        return null;
      },
      async claimTask() {
        return null;
      },
      async operatorTick() {
        throw new Error('not used by this suite');
      },
    };

    const deadline = Date.now() + TURN_TIMEOUT_MS - 20_000;
    worker = new JarvisWorkerProcess({
      config: workerConfig(workspaceRoot),
      client: client as never,
      runtime,
      delivery: null,
      log: () => undefined,
      sleep: async () => {
        if (Date.now() > deadline) worker?.stop();
        await new Promise((resolve) => setTimeout(resolve, 20));
      },
    });

    await worker.run();
    expect(reported, 'the worker never reported an answer').toBe(true);
  }
});

/** Generous: a real reasoning turn, plus the worker's own poll cadence around it. */
const TURN_TIMEOUT_MS = 180_000;
