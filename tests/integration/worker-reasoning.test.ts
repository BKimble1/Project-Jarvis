import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { WORKER_VERSION } from '@/domain/worker-protocol';
import type { WorkerConfig } from '@/worker/config';
import type { getServices } from '@/server/container';

/**
 * The dashboard thinking on Blake's own Claude subscription.
 *
 * ## What this suite is for
 *
 * The first QuickPick message used to come back as "I have not judged whether QuickPick is worth
 * building — there is no model configured here to reason with." That sentence was true of the
 * control plane and false of the system: a worker was connected, holding a real Claude Code
 * runtime authenticated through Blake's subscription, doing nothing while the dashboard asked for
 * an API key he should not have needed.
 *
 * ## What is real here, and what is not
 *
 * Real: the database, the container, the conversation service, the interpreter, the proposal
 * store, the reasoning queue and its lease, the `ownerRoute` and `workerRoute` HTTP handlers, the
 * bearer-token authentication, the idempotency guard, and the actual `JarvisWorkerProcess` with
 * its four loops. The worker claims and reports over the same HTTP routes it will use in
 * production, with a real token it had to be enrolled to get.
 *
 * Not real: the model. `ScriptedRuntime` returns the fenced JSON block that Claude would return,
 * so the assertions are about the path rather than about a model's prose. Everything the answer
 * travels through on the way there and back is the shipping code.
 *
 * There is no `ANTHROPIC_API_KEY` in this environment, on purpose. It is the point.
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

/** Deliberately without `ANTHROPIC_API_KEY`. See the note at the top of this file. */
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

/** The answer a real Claude turn would produce, in the shape the prompt asks for. */
const MODEL_REPLY = [
  'Here is what I make of it.',
  '',
  '```json',
  JSON.stringify({
    likelyUser: 'Someone stuck between two options who wants the decision taken away from them.',
    problem: 'Choosing between two things when neither is obviously better, and stalling on it.',
    verdict:
      'Worth an afternoon. It is small enough that building it settles the question faster than debating it.',
    smallestV1: ['Two text inputs', 'A pick button', 'One animation on the result'],
    assumptions: ['It is used on a phone', 'Nothing needs saving between uses'],
    uncertainties: ['Whether anyone but you would open it twice'],
    questions: ['Does it need to remember past picks?', 'Web page, or an installed app?'],
  }),
  '```',
].join('\n');

const HEARTBEAT = {
  status: 'idle' as const,
  version: WORKER_VERSION,
  platform: 'test',
  runtimeAvailable: true,
  runtimeName: 'scripted',
  runtimeDetail: 'Scripted runtime for tests.',
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
    name: 'reasoning-worker',
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
    runtime: 'scripted',
    allowedRepositories: null,
    sandboxRepositories: new Map(),
    version: WORKER_VERSION,
    diagnostics: [],
  };
}

describe('worker-mediated reasoning, over the real protocol', () => {
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

    workspaceRoot = await mkdtemp(path.join(tmpdir(), 'jarvis-reasoning-'));

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

  /**
   * Enrol a worker, and let it say hello.
   *
   * The heartbeat is not decoration. A worker that has been enrolled and never seen is
   * `registered`, not connected, and the control plane is right to say there is nothing out there
   * that can think — so a test that skipped this would be testing a worker Blake has not started.
   */
  async function enrolWorker(): Promise<string> {
    const enrolment = await services.workerService.enrol('reasoning-worker', 1);
    workerToken = enrolment.token;
    await services.workerService.poll(enrolment.worker.id, {
      heartbeat: HEARTBEAT,
      wantsWork: true,
      acknowledgedCommandIds: [],
    });
    return workerToken;
  }

  async function send(message: string, context?: unknown): Promise<Record<string, unknown>> {
    const { POST } = await import('@/app/api/conversation/route');
    const response = await POST(
      new Request(`${BASE}/api/conversation`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: BASE },
        body: JSON.stringify(context === undefined ? { message } : { message, context }),
      }),
    );
    expect(response.status).toBe(200);
    return (await response.json()) as Record<string, unknown>;
  }

  async function thinkingStatus(requestId: string): Promise<Record<string, unknown>> {
    const { GET } = await import('@/app/api/conversation/thinking/route');
    const response = await GET(
      new Request(`${BASE}/api/conversation/thinking?request=${encodeURIComponent(requestId)}`),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { thinking: Record<string, unknown> };
    return body.thinking;
  }

  /**
   * A control-plane client that goes through the real HTTP handlers with a real bearer token.
   *
   * Every request carries `Authorization` and an `Idempotency-Key`, and every response comes back
   * through `workerRoute` — so authentication, the body cap, the schema and the idempotency replay
   * are all exercised rather than bypassed.
   */
  function routeClient(token: string, onReported: () => void) {
    const requests: string[] = [];

    const post = async (path: string, body: unknown, idempotent = true) => {
      requests.push(path);
      const headers = new Headers({ 'content-type': 'application/json' });
      headers.set('authorization', `Bearer ${token}`);
      if (idempotent) {
        headers.set('idempotency-key', `key-${Math.random().toString(36).slice(2)}-aaaa`);
      }
      const request = new Request(`${BASE}${path}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });

      if (path === '/api/worker/poll') {
        const { POST } = await import('@/app/api/worker/poll/route');
        return POST(request);
      }
      if (path === '/api/worker/reasoning/claim') {
        const { POST } = await import('@/app/api/worker/reasoning/claim/route');
        return POST(request);
      }
      const { POST } = await import('@/app/api/worker/reasoning/route');
      return POST(request);
    };

    const client = {
      requests,
      async poll(input: unknown) {
        const response = await post('/api/worker/poll', input, false);
        expect(response.status).toBe(200);
        return response.json();
      },
      async claimReasoning(input: unknown) {
        const response = await post('/api/worker/reasoning/claim', input);
        expect(response.status).toBe(200);
        const body = (await response.json()) as { assignment: unknown };
        return body.assignment;
      },
      async reportReasoning(input: unknown) {
        const response = await post('/api/worker/reasoning', input);
        expect(response.status).toBe(200);
        onReported();
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
    return client;
  }

  /**
   * Run the real worker until it has reported once, or until a bounded number of ticks.
   *
   * Bounded on purpose: a bug that never claims should fail this test rather than hang the suite.
   */
  async function runWorkerUntilAnswered(reply = MODEL_REPLY): Promise<{ requests: string[] }> {
    const { JarvisWorkerProcess } = await import('@/worker/main');
    const { ScriptedRuntime } = await import('@/worker/runtime/scripted');

    const runtime = new ScriptedRuntime({ steps: [{ kind: 'done', result: reply }] });

    let worker: InstanceType<typeof JarvisWorkerProcess> | null = null;
    const client = routeClient(workerToken, () => worker?.stop());

    let ticks = 0;
    worker = new JarvisWorkerProcess({
      config: workerConfig(workspaceRoot),
      client: client as never,
      runtime,
      delivery: null,
      log: () => undefined,
      sleep: async () => {
        ticks += 1;
        if (ticks > 400) worker?.stop();
        await new Promise((resolve) => setTimeout(resolve, 0));
      },
    });

    await worker.run();
    return { requests: client.requests };
  }

  /* ------------------------------------------------------------------- 1, 2, 3 */

  it('has the worker do the thinking, over the authenticated protocol, with no API key here', async () => {
    await enrolWorker();
    expect(process.env.ANTHROPIC_API_KEY).toBeUndefined();

    const first = await send(MESSAGE_ONE);
    const thinking = first.thinking as { state: string; requestId: string };

    /* Nothing has judged it yet, and Jarvis says so rather than inventing a verdict. */
    expect(first.kind).toBe('idea');
    expect(thinking.state).toBe('thinking');
    expect(first.evaluation).toBeNull();

    /* Nothing was built, either — the message said not to, and the idea path never does anyway. */
    expect(await services.projects.listAllForAssessment(true)).toHaveLength(0);
    expect(await services.missionRepo.listOpen()).toHaveLength(0);
    expect(await services.sources.listAllGithubSources()).toHaveLength(0);

    const { requests } = await runWorkerUntilAnswered();
    expect(requests).toContain('/api/worker/reasoning/claim');
    expect(requests).toContain('/api/worker/reasoning');

    const answered = await thinkingStatus(thinking.requestId);
    expect(answered.state).toBe('ready');
    const evaluation = answered.evaluation as Record<string, unknown>;
    expect(evaluation.verdict).toContain('Worth an afternoon');
    expect(evaluation.basis).toBe('reasoned');
    expect((evaluation.questions as string[]).length).toBeGreaterThan(0);

    /* And still nothing built. Thinking is not doing. */
    expect(await services.projects.listAllForAssessment(true)).toHaveLength(0);
    expect(await services.missionRepo.listOpen()).toHaveLength(0);
  });

  it('writes the answer onto the proposal, so anything reading it later sees the assessment', async () => {
    await enrolWorker();
    const first = await send(MESSAGE_ONE);
    const proposalId = (first.proposal as { id: string }).id;

    await runWorkerUntilAnswered();

    const proposal = await services.proposals.findById(proposalId);
    expect(proposal?.state).toBe('open');
    expect(proposal?.evaluation?.verdict).toContain('Worth an afternoon');
    expect(proposal?.recommendedV1.length).toBeGreaterThan(0);
    expect(proposal?.openQuestions.length).toBeGreaterThan(0);
  });

  /* ---------------------------------------------------------------------- 4 */

  it('asking again, or restarting, does not queue a second question or a second proposal', async () => {
    await enrolWorker();

    const first = await send(MESSAGE_ONE);
    const second = await send(MESSAGE_ONE);
    const third = await send(MESSAGE_ONE);

    const ids = [first, second, third].map((turn) => (turn.proposal as { id: string }).id);
    expect(new Set(ids).size).toBe(1);

    const requestIds = [first, second, third].map(
      (turn) => (turn.thinking as { requestId: string }).requestId,
    );
    expect(new Set(requestIds).size).toBe(1);

    /*
     * One question in the queue, and exactly one claim available. If the second and third
     * descriptions had each enqueued their own, the worker would answer three times and spend
     * Blake's subscription three times to learn one thing.
     */
    expect(await services.reasoningRepo.countActive()).toBe(1);

    const { ReasoningWorkerHarness } = await import('../helpers/reasoning-worker');
    const drainer = new ReasoningWorkerHarness(services, 'drainer');
    expect(await drainer.answerAll()).toBe(1);
    expect(await services.reasoningRepo.countActive()).toBe(0);

    /* And describing it once more after the answer does not ask again. */
    const fourth = await send(MESSAGE_ONE);
    expect((fourth.thinking as { state: string }).state).toBe('ready');
    expect(await services.reasoningRepo.countActive()).toBe(0);
  });

  /* ---------------------------------------------------------------------- 5 */

  it('"Go ahead" continues the same proposal and creates exactly one of each', async () => {
    await enrolWorker();
    const first = await send(MESSAGE_ONE);
    await runWorkerUntilAnswered();

    const accepted = await send('Go ahead', {
      actions: [],
      proposal: first.proposal,
      lastJarvisTurn: first.said,
    });

    expect(accepted.started).not.toBeNull();
    const projects = await services.projects.listAllForAssessment(true);
    const missions = await services.missionRepo.listOpen();
    expect(projects).toHaveLength(1);
    expect(missions).toHaveLength(1);

    const proposal = await services.proposals.findById((first.proposal as { id: string }).id);
    expect(proposal?.state).toBe('accepted');
    expect(proposal?.projectId).toBe(projects[0]!.id);

    /* Said twice, built once. */
    const again = await send('Go ahead', {
      actions: [],
      proposal: first.proposal,
      lastJarvisTurn: first.said,
    });
    expect(again.kind).toBe('follow_up');
    expect(await services.projects.listAllForAssessment(true)).toHaveLength(1);
    expect(await services.missionRepo.listOpen()).toHaveLength(1);

    /*
     * There is no repository in this suite because no provisioning token is configured, and Jarvis
     * says so rather than inventing a URL — the same guarantee the QuickPick suite pins.
     */
    expect(JSON.stringify(accepted)).not.toContain('github.com/');
  });

  /* ---------------------------------------------------------------------- 6 */

  it('says exactly why it cannot think when no worker is connected, and keeps the question', async () => {
    const first = await send(MESSAGE_ONE);
    const thinking = first.thinking as {
      state: string;
      reason: string;
      detail: string;
      retryable: boolean;
      requestId: string;
    };

    expect(thinking.state).toBe('blocked');
    expect(thinking.reason).toBe('no_worker');
    expect(thinking.retryable).toBe(true);
    expect(thinking.detail).toMatch(/worker/i);
    /* Never sends him looking for a key he should not need. */
    expect(JSON.stringify(first)).not.toMatch(/ANTHROPIC_API_KEY/i);
    expect(JSON.stringify(first)).not.toMatch(/api key/i);

    /* The request survives, so starting the worker later finishes the thought. */
    expect(await services.reasoningRepo.countActive()).toBe(1);

    await enrolWorker();
    await runWorkerUntilAnswered();
    expect((await thinkingStatus(thinking.requestId)).state).toBe('ready');
  });

  it('says exactly why it cannot think when the Claude window is full, and keeps the question', async () => {
    const token = await enrolWorker();

    /*
     * The real governor, driven by a real heartbeat, rather than a stubbed decision. A five-hour
     * window reported at 100% is exactly what a saturated subscription looks like on the wire, and
     * making the test produce it that way means the sentence Blake reads and the gate that stops
     * the claim are the same verdict — which is the property worth pinning.
     */
    const { POST } = await import('@/app/api/worker/poll/route');
    const saturated = await POST(
      new Request(`${BASE}/api/worker/poll`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({
          heartbeat: {
            ...HEARTBEAT,
            capacity: {
              authMode: 'subscription',
              subscriptionType: 'max',
              rateLimitsApplicable: true,
              windows: {
                fiveHour: { utilisationPercent: 100, resetsAt: null },
                sevenDay: { utilisationPercent: 80, resetsAt: null },
                sevenDayOpus: null,
              },
              context: null,
              observedAt: new Date().toISOString(),
              source: 'test',
            },
          },
          wantsWork: true,
          acknowledgedCommandIds: [],
        }),
      }),
    );
    expect(saturated.status).toBe(200);

    const first = await send(MESSAGE_ONE);
    const thinking = first.thinking as { state: string; reason: string; detail: string };
    expect(thinking.state).toBe('blocked');
    expect(thinking.reason).toBe('capacity_exhausted');
    expect(thinking.detail).toMatch(/five-hour/i);

    /* Queued, not failed — and the worker is not handed it while the window is full. */
    expect(await services.reasoningRepo.countActive()).toBe(1);
    const claimRoute = await import('@/app/api/worker/reasoning/claim/route');
    const refused = await claimRoute.POST(
      new Request(`${BASE}/api/worker/reasoning/claim`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
          'idempotency-key': 'claim-while-exhausted-0001',
        },
        body: JSON.stringify({ heartbeat: HEARTBEAT }),
      }),
    );
    expect(refused.status).toBe(200);
    expect(((await refused.json()) as { assignment: unknown }).assignment).toBeNull();
    expect(await services.reasoningRepo.countActive()).toBe(1);
  });

  it('reports a worker that could not run its model, rather than a silent nothing', async () => {
    await enrolWorker();
    const first = await send(MESSAGE_ONE);
    const requestId = (first.thinking as { requestId: string }).requestId;

    const { ReasoningWorkerHarness } = await import('../helpers/reasoning-worker');
    const failing = new ReasoningWorkerHarness(services, 'failing-worker');

    /* Three attempts, because that is the ceiling; the third turns it into something to read. */
    expect(await failing.failNext('runtime_unavailable', 'claude: command not found')).toBe(true);
    expect((await thinkingStatus(requestId)).state).toBe('thinking');
    expect(await failing.failNext('runtime_unavailable', 'claude: command not found')).toBe(true);
    expect(await failing.failNext('runtime_unavailable', 'claude: command not found')).toBe(true);

    const status = await thinkingStatus(requestId);
    expect(status.state).toBe('blocked');
    expect(status.reason).toBe('failed');
    expect(String(status.detail)).toContain('Claude runtime');
    expect(status.retryable).toBe(false);
  });

  it('does not fabricate an evaluation when the model answers in the wrong shape', async () => {
    await enrolWorker();
    const first = await send(MESSAGE_ONE);
    const requestId = (first.thinking as { requestId: string }).requestId;

    await runWorkerUntilAnswered('I think it is a lovely idea, honestly. No JSON here.');

    const status = await thinkingStatus(requestId);
    /* Either still queued for another attempt, or reported — never "ready" with invented content. */
    expect(status.state).not.toBe('ready');
    const proposal = await services.proposals.findById((first.proposal as { id: string }).id);
    expect(proposal?.evaluation).toBeNull();
  });

  /* ------------------------------------------------------------- credentials */

  it('never puts a credential on the wire, in either direction', async () => {
    await enrolWorker();
    const first = await send(MESSAGE_ONE);

    /* Nothing the browser receives carries a worker token, a session, or a model credential. */
    const wire = JSON.stringify(first);
    expect(wire).not.toContain(workerToken);
    expect(wire).not.toContain('jarvisw_');
    expect(wire).not.toMatch(/sk-ant/i);

    const { JarvisWorkerProcess } = await import('@/worker/main');
    const { ScriptedRuntime } = await import('@/worker/runtime/scripted');
    const runtime = new ScriptedRuntime({ steps: [{ kind: 'done', result: MODEL_REPLY }] });

    let worker: InstanceType<typeof JarvisWorkerProcess> | null = null;
    const client = routeClient(workerToken, () => worker?.stop());
    let ticks = 0;
    worker = new JarvisWorkerProcess({
      config: workerConfig(workspaceRoot),
      client: client as never,
      runtime,
      delivery: null,
      log: () => undefined,
      sleep: async () => {
        ticks += 1;
        if (ticks > 400) worker?.stop();
        await new Promise((resolve) => setTimeout(resolve, 0));
      },
    });
    await worker.run();

    /*
     * And nothing the control plane sent the worker reached the prompt. The question travels; the
     * credential does not, in either direction.
     */
    expect(runtime.prompts.length).toBeGreaterThan(0);
    const prompts = JSON.stringify(runtime.prompts);
    expect(prompts).not.toContain(workerToken);
    expect(prompts).not.toContain('jarvisw_');
    expect(prompts).not.toContain(ENV.SESSION_SECRET);
    expect(prompts).toContain('QuickPick');
  });

  /* --------------------------------------------- the live failure, end to end */

  /**
   * The three faults the live morning exposed, each pinned through the real routes.
   *
   * The first is the one that mattered most: a proposal carrying the old "no model is configured
   * here" placeholder was treated as *answered*, so the worker was never asked and the screen
   * showed that sentence for ever. The second is the retry — a genuine timeout has to be
   * repeatable without duplicating anything. The third is the fence: the timed-out attempt's
   * answer must not be able to land on top of a newer one.
   */

  it('replaces a pre-worker "nothing judged this" placeholder instead of showing it for ever', async () => {
    await enrolWorker();

    const first = await send(MESSAGE_ONE);
    const proposalId = (first.proposal as { id: string }).id;

    /*
     * Exactly what a row written before the worker path existed looks like: an evaluation, with
     * `basis: 'not_assessed'`, produced by the control plane when it had no model to reason with.
     */
    const { NOT_ASSESSED_NOTICE } = await import('@/domain/proposal');
    await services.proposals.recordEvaluation(
      proposalId,
      {
        likelyUser: 'Not assessed.',
        problem: 'Not assessed.',
        verdict: NOT_ASSESSED_NOTICE,
        smallestV1: [],
        assumptions: [],
        uncertainties: [],
        questions: ['Who is this for?'],
        basis: 'not_assessed',
      },
      new Date(),
    );

    /* Describing the idea again must ask the worker, not hand back the placeholder. */
    const again = await send(MESSAGE_ONE);
    const thinking = again.thinking as { state: string; requestId: string };
    expect(thinking.state).not.toBe('ready');
    expect(JSON.stringify(again.evaluation ?? {})).not.toContain('Nothing has judged');

    await runWorkerUntilAnswered();

    const answered = await thinkingStatus(thinking.requestId);
    expect(answered.state).toBe('ready');
    expect((answered.evaluation as { basis: string }).basis).toBe('reasoned');

    const proposal = await services.proposals.findById(proposalId);
    expect(proposal?.evaluation?.basis).toBe('reasoned');
    expect(proposal?.evaluation?.verdict).toContain('Worth an afternoon');

    /* And one proposal throughout — replacing a placeholder is not a second idea. */
    expect((again.proposal as { id: string }).id).toBe(proposalId);
  });

  it('shows the current request rather than an older evaluation while it is pending', async () => {
    await enrolWorker();
    const first = await send(MESSAGE_ONE);
    const requestId = (first.thinking as { requestId: string }).requestId;

    /* A reasoned answer arrives, and is what the status reports. */
    await runWorkerUntilAnswered();
    expect((await thinkingStatus(requestId)).state).toBe('ready');

    /*
     * Now the same idea again. The answer is real this time, so it is returned as ready without
     * spending the subscription a second time — the counterpart to the placeholder case above.
     */
    const repeat = await send(MESSAGE_ONE);
    expect((repeat.thinking as { state: string }).state).toBe('ready');
    expect(await services.reasoningRepo.countActive()).toBe(0);
  });

  it('retries a timed-out question on the same proposal, and stops after the ceiling', async () => {
    await enrolWorker();
    const first = await send(MESSAGE_ONE);
    const requestId = (first.thinking as { requestId: string }).requestId;
    const proposalId = (first.proposal as { id: string }).id;

    const { ReasoningWorkerHarness } = await import('../helpers/reasoning-worker');
    const { REASONING_MAX_ATTEMPTS, REASONING_MAX_MANUAL_RETRIES } =
      await import('@/domain/reasoning');
    const slow = new ReasoningWorkerHarness(services, 'slow-worker');

    const exhaust = async () => {
      for (let attempt = 0; attempt < REASONING_MAX_ATTEMPTS; attempt += 1) {
        expect(await slow.failNext('timed_out', 'The model did not answer in time.')).toBe(true);
      }
    };

    await exhaust();

    const blocked = await thinkingStatus(requestId);
    expect(blocked.state).toBe('blocked');
    expect(blocked.reason).toBe('failed');
    expect(blocked.canRetry).toBe(true);
    /* The stage is carried through, so the sentence says where it stopped rather than only that it did. */
    expect(String(blocked.detail)).toContain('It got as far as');
    /* And it is not charged twice for one fact. */
    expect(String(blocked.detail).match(/did not answer in time/g)).toHaveLength(1);

    const retry = async () => {
      const { POST } = await import('@/app/api/conversation/thinking/retry/route');
      return POST(
        new Request(`${BASE}/api/conversation/thinking/retry`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', origin: BASE },
          body: JSON.stringify({ request: requestId }),
        }),
      );
    };

    const retried = await retry();
    expect(retried.status).toBe(200);
    expect(await services.reasoningRepo.countActive()).toBe(1);
    /* Nothing was duplicated: the same request, the same proposal, no new work of any kind. */
    expect(await services.proposals.findById(proposalId)).not.toBeNull();
    expect(await services.projects.listAllForAssessment(true)).toHaveLength(0);
    expect(await services.missionRepo.listOpen()).toHaveLength(0);

    /* Pressing it again while it is queued does nothing — there is no failure to retry. */
    expect((await retry()).status).toBe(409);
    expect(await services.reasoningRepo.countActive()).toBe(1);

    /* This time the worker answers, and the same proposal gets the assessment. */
    await runWorkerUntilAnswered();
    const answered = await thinkingStatus(requestId);
    expect(answered.state).toBe('ready');
    const proposal = await services.proposals.findById(proposalId);
    expect(proposal?.evaluation?.verdict).toContain('Worth an afternoon');

    /* One proposal and nothing built, across the failures and the retry alike. */
    expect((await send(MESSAGE_ONE)).proposal).toMatchObject({ id: proposalId });
    expect(await services.projects.listAllForAssessment(true)).toHaveLength(0);
    expect(await services.missionRepo.listOpen()).toHaveLength(0);
    /* `REASONING_MAX_MANUAL_RETRIES` is what bounds the button; the next test spends it. */
    expect(REASONING_MAX_MANUAL_RETRIES).toBeGreaterThan(0);
  });

  it('stops offering a retry once the owner has spent them, rather than looping', async () => {
    await enrolWorker();
    const first = await send(MESSAGE_ONE);
    const requestId = (first.thinking as { requestId: string }).requestId;

    const { ReasoningWorkerHarness } = await import('../helpers/reasoning-worker');
    const { REASONING_MAX_ATTEMPTS, REASONING_MAX_MANUAL_RETRIES } =
      await import('@/domain/reasoning');
    const broken = new ReasoningWorkerHarness(services, 'broken-worker');

    const exhaust = async () => {
      for (let attempt = 0; attempt < REASONING_MAX_ATTEMPTS; attempt += 1) {
        expect(await broken.failNext('timed_out', 'The model did not answer in time.')).toBe(true);
      }
    };
    const retry = async () => {
      const { POST } = await import('@/app/api/conversation/thinking/retry/route');
      return POST(
        new Request(`${BASE}/api/conversation/thinking/retry`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', origin: BASE },
          body: JSON.stringify({ request: requestId }),
        }),
      );
    };

    /* Every retry the owner is allowed, each one preceded by a genuine run of failures. */
    for (let spent = 0; spent < REASONING_MAX_MANUAL_RETRIES; spent += 1) {
      await exhaust();
      expect((await thinkingStatus(requestId)).canRetry).toBe(true);
      expect((await retry()).status).toBe(200);
    }

    /* And then it stops. A broken runtime ends in a sentence rather than an unbounded loop. */
    await exhaust();
    const final = await thinkingStatus(requestId);
    expect(final.state).toBe('blocked');
    expect(final.reason).toBe('failed');
    expect(final.canRetry).toBe(false);
    expect((await retry()).status).toBe(409);

    /* Bounded work, too: attempts and retries, and not one thing built by any of them. */
    expect(broken.claims).toBe(REASONING_MAX_ATTEMPTS * (REASONING_MAX_MANUAL_RETRIES + 1));
    expect(await services.reasoningRepo.countActive()).toBe(0);
    expect(await services.projects.listAllForAssessment(true)).toHaveLength(0);
    expect(await services.missionRepo.listOpen()).toHaveLength(0);
  });

  it('a late answer from an abandoned attempt cannot overwrite the newer one', async () => {
    await enrolWorker();
    const first = await send(MESSAGE_ONE);
    const requestId = (first.thinking as { requestId: string }).requestId;
    const proposalId = (first.proposal as { id: string }).id;

    const { ReasoningWorkerHarness, SAMPLE_EVALUATION } =
      await import('../helpers/reasoning-worker');
    const stalled = new ReasoningWorkerHarness(services, 'stalled-worker');
    const workerId = await stalled.ensureEnrolled();
    const claim = () => services.workerService.claimReasoning(workerId, { heartbeat: HEARTBEAT });

    /*
     * The exact live shape, and the reason the fence exists.
     *
     * Attempt one is claimed and goes quiet — the run that timed out. Its lease expires, and the
     * *same* worker picks the question up again as attempt two. So when attempt one finally comes
     * back, the row is running and the lease owner matches: every guard except the attempt agrees
     * with it. Only the attempt says no.
     */
    const stale = await claim();
    expect(stale?.attempt).toBe(1);

    await services.reasoningRepo.reclaimExpired({
      now: new Date(Date.now() + 10 * 60 * 1000),
      maxAttempts: 3,
    });
    const current = await claim();
    expect(current?.attempt).toBe(2);

    const lateAnswer = await services.reasoningService.apply(workerId, {
      status: 'succeeded',
      requestId,
      attempt: 1,
      evaluation: { ...SAMPLE_EVALUATION, verdict: 'A stale verdict from a dead attempt.' },
      usage: { inputTokens: 1, outputTokens: 1, durationMs: 1 },
    });
    expect(lateAnswer.applied).toBe(false);

    /* A late *failure* loses the same way — it must not fail a turn that is still running. */
    const lateFailure = await services.reasoningService.apply(workerId, {
      status: 'failed',
      requestId,
      attempt: 1,
      failure: 'timed_out',
      detail: 'The model did not answer in time.',
      stage: 'model_replied',
    });
    expect(lateFailure.applied).toBe(false);

    /* Neither reached the screen or the proposal: the newer attempt is still the one in flight. */
    expect((await thinkingStatus(requestId)).state).toBe('thinking');
    expect((await services.proposals.findById(proposalId))?.evaluation).toBeNull();

    /* And the attempt that actually holds the question is applied, exactly as it should be. */
    const applied = await services.reasoningService.apply(workerId, {
      status: 'succeeded',
      requestId,
      attempt: 2,
      evaluation: SAMPLE_EVALUATION,
      usage: { inputTokens: 10, outputTokens: 10, durationMs: 10 },
    });
    expect(applied.applied).toBe(true);

    const status = await thinkingStatus(requestId);
    expect(status.state).toBe('ready');
    expect((status.evaluation as { verdict: string }).verdict).not.toContain('stale verdict');
    const proposal = await services.proposals.findById(proposalId);
    expect(proposal?.evaluation?.verdict).toBe(SAMPLE_EVALUATION.verdict);

    /* Once it is answered, the dead attempt still cannot un-answer it. */
    const later = await services.reasoningService.apply(workerId, {
      status: 'failed',
      requestId,
      attempt: 1,
      failure: 'timed_out',
      detail: 'The model did not answer in time.',
      stage: 'model_replied',
    });
    expect(later.applied).toBe(false);
    expect((await thinkingStatus(requestId)).state).toBe('ready');
  });

  /* ---------------------------------------------------------------------- 7 */

  it('leaves the mission claim and the heartbeat working exactly as they were', async () => {
    const token = await enrolWorker();
    const { POST } = await import('@/app/api/worker/poll/route');

    const response = await POST(
      new Request(`${BASE}/api/worker/poll`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({
          heartbeat: {
            status: 'idle',
            version: WORKER_VERSION,
            platform: 'test',
            runtimeAvailable: true,
            runtimeName: 'scripted',
            runtimeDetail: 'ok',
            workspaceHealthy: true,
            workspaceRootLabel: null,
            githubDeliveryConfigured: false,
            diagnostics: [],
            currentMissionId: null,
            currentRunId: null,
            lastActivityAt: null,
            capacity: {
              authMode: 'subscription',
              subscriptionType: 'max',
              rateLimitsApplicable: true,
              windows: {
                fiveHour: { utilisationPercent: 12, resetsAt: null },
                sevenDay: { utilisationPercent: 30, resetsAt: null },
                sevenDayOpus: null,
              },
              context: null,
              observedAt: new Date().toISOString(),
              source: 'test',
            },
          },
          wantsWork: true,
          acknowledgedCommandIds: [],
        }),
      }),
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { assignment: unknown; directive: string };
    expect(body.assignment).toBeNull();
    expect(body.directive).toBe('continue');

    /* The capacity telemetry the heartbeat carries still lands where the governor reads it. */
    const observations = await services.workerRepo.capacityObservations();
    expect(observations.length).toBeGreaterThan(0);
    expect(observations[0]?.windows.fiveHour.utilisationPercent.value).toBe(12);
    expect(observations[0]?.authMode).toBe('subscription');
  });
});
