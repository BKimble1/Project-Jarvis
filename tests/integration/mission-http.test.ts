import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { getServices } from '@/server/container';
import type { MissionPlanContent } from '@/domain/mission-plan';
import { WORKER_VERSION } from '@/domain/worker-protocol';

/**
 * Mission Control's HTTP layer, exercised through the real shipping handlers.
 *
 * The same discipline as `http-routes.test.ts`: nothing here is a copy of route logic. Each test
 * imports the module Next.js deploys and drives it with a real `Request`, so the guard, the
 * same-origin check, the worker bearer check and the idempotency replay are the ones that ship.
 *
 * `next/headers` is the only thing replaced — it needs Next's per-request storage, which does not
 * exist outside a server.
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
  JARVIS_MISSION_CONCURRENCY: '1',
  LOG_LEVEL: 'error',
};

type Services = Awaited<ReturnType<typeof getServices>>;

/* eslint-disable @typescript-eslint/no-explicit-any -- narrowed at each use. */
type Json = Record<string, any>;
/* eslint-enable @typescript-eslint/no-explicit-any */

async function body(response: Response): Promise<Json> {
  return (await response.json()) as Json;
}

function ownerPost(path: string, init: { origin?: string | null; json?: unknown } = {}): Request {
  const headers = new Headers({ 'content-type': 'application/json' });
  if (init.origin !== null) headers.set('origin', init.origin ?? BASE);
  return new Request(`${BASE}${path}`, {
    method: 'POST',
    headers,
    body: init.json === undefined ? undefined : JSON.stringify(init.json),
  });
}

function workerPost(
  path: string,
  token: string | null,
  json: unknown,
  options: { idempotencyKey?: string | null } = {},
): Request {
  const headers = new Headers({ 'content-type': 'application/json' });
  if (token) headers.set('authorization', `Bearer ${token}`);
  if (options.idempotencyKey !== null) {
    headers.set(
      'idempotency-key',
      options.idempotencyKey ?? `key-${Math.random().toString(36).slice(2)}-aaaa`,
    );
  }
  return new Request(`${BASE}${path}`, { method: 'POST', headers, body: JSON.stringify(json) });
}

const params = <T extends Record<string, string>>(value: T) => ({ params: Promise.resolve(value) });

const HEARTBEAT = {
  status: 'idle' as const,
  /* A claim is refused unless the worker's build matches, so the fixture reports a real one. */
  version: WORKER_VERSION,
  runtimeAvailable: true,
  workspaceHealthy: true,
  githubDeliveryConfigured: true,
  diagnostics: [],
};

const PLAN: MissionPlanContent = {
  summary: 'Add invoice scanning',
  proposedOutcome: 'A draft pull request adding invoice scanning.',
  assumptions: [],
  scope: ['Add invoice scanning'],
  outOfScope: ['Merging the pull request.'],
  affectedAreas: ['src/invoices.ts'],
  approach: 'Read the parser, add the scanner, add tests, open a draft pull request.',
  dataMigrations: [],
  testsToAddOrUpdate: ['Scanner unit tests'],
  verification: [
    {
      command: 'npm test',
      purpose: 'Run the suite.',
      source: 'package_script',
      expectedUnavailableReason: null,
    },
  ],
  uiValidation: [],
  risks: [],
  rollback: 'Close the pull request and delete the branch.',
  acceptanceCriteria: ['Invoices are scanned and the suite is green.'],
  openQuestions: [],
  estimatedComplexity: 'small',
  withinRequestedScope: true,
  scopeNotes: null,
  reviewOnlyDelivery: true,
  evidenceIds: [],
  repositoryFacts: {},
};

describe('Mission Control HTTP handlers', () => {
  let close: () => Promise<void>;
  let services: Services;
  let restoreEnv: Array<[string, string | undefined]> = [];

  beforeEach(async () => {
    vi.resetModules();
    cookieStore.clear();
    requestHeaders.clear();

    restoreEnv = Object.entries(ENV).map(([key]) => [key, process.env[key]]);
    for (const [key, value] of Object.entries(ENV)) process.env[key] = value;

    const { createTestDatabase } = await import('../helpers/test-db');
    const database = await createTestDatabase();
    close = database.close;

    const { resetConfigCache } = await import('@/server/config/env');
    resetConfigCache();
    const { resetServices, getServices } = await import('@/server/container');
    resetServices();
    services = await getServices();
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
  });

  async function signIn(): Promise<void> {
    const { token } = await services.sessions.create({
      githubLogin: 'test-owner',
      githubUserId: '4242',
      displayName: 'Test owner',
      avatarUrl: null,
      ttlHours: 2,
    });
    cookieStore.set(SESSION_COOKIE, token);
  }

  /** Answers every open question until Jarvis stops asking, so the mission can be planned. */
  async function answerOpenQuestions(missionId: string, answer = 'fine'): Promise<void> {
    for (let round = 0; round < 5; round += 1) {
      const open = (await services.clarifications.list(missionId)).filter(
        (question) => question.answeredAt === null,
      );
      if (open.length === 0) return;
      for (const question of open) {
        await services.clarifications.answer(missionId, question.id, answer, 'manual');
      }
      await services.missions.refreshClarifications(missionId);
    }
  }

  async function project(overrides: { status?: 'active' | 'paused' | 'completed' } = {}) {
    const created = await services.projects.create({
      name: `Project ${Math.random().toString(36).slice(2, 8)}`,
      type: 'software',
      status: overrides.status ?? 'active',
      priority: 'medium',
      tags: [],
      links: [],
    });
    return created;
  }

  /** A mission created through the real route, planned and approved. Returns its id. */
  async function approvedMission(options: { paused?: boolean } = {}): Promise<string> {
    await signIn();
    const created = await project(options.paused ? { status: 'paused' } : {});
    const missions = await import('@/app/api/missions/route');

    const response = await missions.POST(
      ownerPost('/api/missions', {
        json: { rawRequest: 'Add invoice scanning to the app', projectId: created.id },
      }),
    );
    expect(response.status).toBe(201);
    const missionId = (await body(response)).mission.id as string;

    /*
     * Answer whatever Jarvis asks until it stops asking. Answering one batch can reveal the next
     * (a repository choice unlocks the acceptance question), so a single pass is not enough.
     */
    const clarify = await import('@/app/api/missions/[id]/clarify/route');
    for (let round = 0; round < 5; round += 1) {
      const open = (await services.clarifications.list(missionId)).filter(
        (question) => question.answeredAt === null,
      );
      if (open.length === 0) break;
      for (const question of open) {
        await clarify.POST(
          ownerPost(`/api/missions/${missionId}/clarify`, {
            json: { questionId: question.id, answer: 'Whatever the plan says is fine.' },
          }),
          params({ id: missionId }),
        );
      }
    }

    const plan = await import('@/app/api/missions/[id]/plan/route');
    const planned = await plan.POST(
      ownerPost(`/api/missions/${missionId}/plan`),
      params({ id: missionId }),
    );
    expect(planned.status).toBe(201);

    const mission = await services.missionRepo.findById(missionId);
    const approve = await import('@/app/api/missions/[id]/approve/route');
    const approved = await approve.POST(
      ownerPost(`/api/missions/${missionId}/approve`, {
        json: {
          planVersion: mission?.currentPlanVersion ?? 1,
          acknowledgedRiskLevel: mission?.riskLevel ?? 'moderate',
          pausedProjectOverride: options.paused === true,
        },
      }),
      params({ id: missionId }),
    );
    expect(approved.status, JSON.stringify(await approved.clone().json())).toBe(200);
    return missionId;
  }

  async function enrolWorker(name = 'worker-a'): Promise<{ id: string; token: string }> {
    const enrolment = await services.workerService.enrol(name, 1);
    return { id: enrolment.worker.id, token: enrolment.token };
  }

  /* ------------------------------------------------------- owner authentication */

  it('refuses every owner mission route without a session', async () => {
    const [missions, detail, plan, approve, clarify, commands, retry, events, workers, permission] =
      await Promise.all([
        import('@/app/api/missions/route'),
        import('@/app/api/missions/[id]/route'),
        import('@/app/api/missions/[id]/plan/route'),
        import('@/app/api/missions/[id]/approve/route'),
        import('@/app/api/missions/[id]/clarify/route'),
        import('@/app/api/missions/[id]/commands/route'),
        import('@/app/api/missions/[id]/retry/route'),
        import('@/app/api/missions/[id]/events/route'),
        import('@/app/api/workers/route'),
        import('@/app/api/permission-requests/[id]/route'),
      ]);

    const id = params({ id: '11111111-2222-4333-8444-555555555555' });
    const responses = await Promise.all([
      missions.GET(new Request(`${BASE}/api/missions`)),
      missions.POST(ownerPost('/api/missions', { json: { rawRequest: 'do a thing' } })),
      detail.GET(new Request(`${BASE}/api/missions/x`), id),
      detail.PATCH(ownerPost('/api/missions/x', { json: { title: 'x' } }), id),
      plan.POST(ownerPost('/api/missions/x/plan'), id),
      approve.POST(
        ownerPost('/api/missions/x/approve', {
          json: { planVersion: 1, acknowledgedRiskLevel: 'moderate' },
        }),
        id,
      ),
      clarify.POST(ownerPost('/api/missions/x/clarify', { json: { questionId: 'q' } }), id),
      commands.POST(
        ownerPost('/api/missions/x/commands', {
          json: { command: 'pause', idempotencyKey: 'abcdefgh' },
        }),
        id,
      ),
      retry.POST(ownerPost('/api/missions/x/retry'), id),
      events.GET(new Request(`${BASE}/api/missions/x/events`), id),
      workers.GET(new Request(`${BASE}/api/workers`)),
      workers.POST(ownerPost('/api/workers', { json: { name: 'evil' } })),
      permission.POST(
        ownerPost('/api/permission-requests/x', { json: { decision: 'approve' } }),
        id,
      ),
    ]);

    for (const response of responses) {
      expect(response.status).toBe(401);
      expect((await body(response)).error.code).toBe('unauthorized');
    }
  });

  it('rejects a cross-origin mission write even with a valid session', async () => {
    await signIn();
    const missions = await import('@/app/api/missions/route');
    const response = await missions.POST(
      ownerPost('/api/missions', {
        origin: 'https://attacker.example',
        json: { rawRequest: 'Add a backdoor' },
      }),
    );
    expect(response.status).toBe(403);
    expect((await body(response)).error.code).toBe('forbidden');
  });

  it('accepts a same-origin mission creation and shows what it understood', async () => {
    await signIn();
    const created = await project();
    const missions = await import('@/app/api/missions/route');
    const response = await missions.POST(
      ownerPost('/api/missions', {
        json: { rawRequest: 'Add invoice scanning to the app', projectId: created.id },
      }),
    );
    expect(response.status).toBe(201);
    const payload = await body(response);
    expect(payload.mission.title).toBe('Add invoice scanning to the app');
    expect(payload.mission.state).toMatch(/draft|needs_clarification/);
    expect(payload.mission.riskLevel).toBe('moderate');
    expect(payload.mission.riskRuleIds.length).toBeGreaterThan(0);
  });

  it('refuses to create a prohibited mission at all', async () => {
    await signIn();
    const created = await project();
    const missions = await import('@/app/api/missions/route');
    const response = await missions.POST(
      ownerPost('/api/missions', {
        json: { rawRequest: 'Force push the fix to main', projectId: created.id },
      }),
    );
    expect(response.status).toBe(403);
    expect((await body(response)).error.message).toContain('Jarvis will not run this mission');
    expect((await services.missionRepo.list()).total).toBe(0);
  });

  /* ------------------------------------------------------------------ approval */

  it('will not queue a mission whose plan has not been approved', async () => {
    await signIn();
    const created = await project();
    const missions = await import('@/app/api/missions/route');
    const response = await missions.POST(
      ownerPost('/api/missions', {
        json: { rawRequest: 'Add invoice scanning', projectId: created.id },
      }),
    );
    const missionId = (await body(response)).mission.id as string;

    const mission = await services.missionRepo.findById(missionId);
    expect(mission?.state).not.toBe('queued');
    expect(mission?.approvedPlanVersion).toBeNull();

    const claimed = await services.workerService.claim((await enrolWorker()).id, {
      heartbeat: HEARTBEAT,
      accepts: ['execution'],
    });
    expect(claimed).toBeNull();
  });

  it('applies an approval to exactly one plan version', async () => {
    const missionId = await approvedMission();
    expect((await services.missionRepo.findById(missionId))?.state).toBe('queued');

    /* Editing the plan creates version 2 and revokes the approval of version 1. */
    const planRoute = await import('@/app/api/missions/[id]/plan/route');
    const edited = await planRoute.PATCH(
      ownerPost(`/api/missions/${missionId}/plan`, {
        json: {
          action: 'edit',
          content: { ...PLAN, approach: 'A completely different approach.' },
        },
      }),
      params({ id: missionId }),
    );
    expect(edited.status).toBe(200);

    const mission = await services.missionRepo.findById(missionId);
    expect(mission?.currentPlanVersion).toBe(2);
    expect(mission?.approvedPlanVersion).toBeNull();
    expect(mission?.state).toBe('awaiting_plan_approval');

    /* And the old version can no longer be approved. */
    const approve = await import('@/app/api/missions/[id]/approve/route');
    const stale = await approve.POST(
      ownerPost(`/api/missions/${missionId}/approve`, {
        json: { planVersion: 1, acknowledgedRiskLevel: 'moderate' },
      }),
      params({ id: missionId }),
    );
    expect(stale.status).toBe(409);
    expect((await body(stale)).error.message).toContain('no longer the current plan');
  });

  it('refuses an approval whose acknowledged risk level is stale', async () => {
    await signIn();
    const created = await project();
    const missions = await import('@/app/api/missions/route');
    const response = await missions.POST(
      ownerPost('/api/missions', {
        json: { rawRequest: 'Refactor the login session handling', projectId: created.id },
      }),
    );
    const missionId = (await body(response)).mission.id as string;
    await answerOpenQuestions(missionId);
    const plan = await import('@/app/api/missions/[id]/plan/route');
    await plan.POST(ownerPost(`/api/missions/${missionId}/plan`), params({ id: missionId }));

    const approve = await import('@/app/api/missions/[id]/approve/route');
    const wrong = await approve.POST(
      ownerPost(`/api/missions/${missionId}/approve`, {
        json: { planVersion: 1, acknowledgedRiskLevel: 'low' },
      }),
      params({ id: missionId }),
    );
    expect(wrong.status).toBe(409);
    expect((await body(wrong)).error.message).toContain('risk level changed');
  });

  it('refuses to run a mission on an archived project', async () => {
    const missionId = await approvedMission();
    const mission = await services.missionRepo.findById(missionId);
    await services.projects.archive(mission!.projectId!);

    /* Reset to awaiting approval, then try to approve again against the archived project. */
    await services.missionRepo.transition(missionId, 'awaiting_plan_approval', {
      approvedPlanVersion: null,
    });
    await services.approvals.revokeAll(missionId, 'test');

    const approve = await import('@/app/api/missions/[id]/approve/route');
    const response = await approve.POST(
      ownerPost(`/api/missions/${missionId}/approve`, {
        json: { planVersion: 1, acknowledgedRiskLevel: mission!.riskLevel },
      }),
      params({ id: missionId }),
    );
    expect(response.status).toBe(403);
    expect((await body(response)).error.message).toContain('archived');
  });

  it('refuses a paused project without an override and accepts it with one', async () => {
    await signIn();
    const created = await project({ status: 'paused' });
    const missions = await import('@/app/api/missions/route');
    const response = await missions.POST(
      ownerPost('/api/missions', {
        json: { rawRequest: 'Add invoice scanning', projectId: created.id },
      }),
    );
    const missionId = (await body(response)).mission.id as string;
    await answerOpenQuestions(missionId, 'Just this once.');
    const plan = await import('@/app/api/missions/[id]/plan/route');
    const planned = await plan.POST(
      ownerPost(`/api/missions/${missionId}/plan`),
      params({ id: missionId }),
    );
    expect(planned.status, JSON.stringify(await planned.clone().json())).toBe(201);

    const approve = await import('@/app/api/missions/[id]/approve/route');
    const mission = await services.missionRepo.findById(missionId);

    const refused = await approve.POST(
      ownerPost(`/api/missions/${missionId}/approve`, {
        json: {
          planVersion: mission!.currentPlanVersion,
          acknowledgedRiskLevel: mission!.riskLevel,
          pausedProjectOverride: false,
        },
      }),
      params({ id: missionId }),
    );
    expect(refused.status).toBe(403);
    expect((await body(refused)).error.message).toContain('paused');

    const allowed = await approve.POST(
      ownerPost(`/api/missions/${missionId}/approve`, {
        json: {
          planVersion: mission!.currentPlanVersion,
          acknowledgedRiskLevel: mission!.riskLevel,
          pausedProjectOverride: true,
        },
      }),
      params({ id: missionId }),
    );
    expect(allowed.status).toBe(200);
    expect((await services.missionRepo.findById(missionId))?.state).toBe('queued');
  });

  /* ------------------------------------------------------- worker authentication */

  it('refuses a worker request with no, an unknown, or a malformed credential', async () => {
    const poll = await import('@/app/api/worker/poll/route');
    const payload = { heartbeat: HEARTBEAT, wantsWork: true, acknowledgedCommandIds: [] };

    const none = await poll.POST(workerPost('/api/worker/poll', null, payload));
    expect(none.status).toBe(401);

    const malformed = await poll.POST(workerPost('/api/worker/poll', 'not-a-token', payload));
    expect(malformed.status).toBe(401);

    const unknown = await poll.POST(
      workerPost(
        '/api/worker/poll',
        'jarvisw_99999999-9999-4999-8999-999999999999.abcdefghijklmnopqrstuvwxyz012345',
        payload,
      ),
    );
    expect(unknown.status).toBe(401);
  });

  it('accepts a header-less worker call — a worker is not a browser and sends no Origin', async () => {
    const { token } = await enrolWorker();
    const poll = await import('@/app/api/worker/poll/route');
    const response = await poll.POST(
      workerPost('/api/worker/poll', token, {
        heartbeat: HEARTBEAT,
        wantsWork: true,
        acknowledgedCommandIds: [],
      }),
    );
    expect(response.status).toBe(200);
    expect((await body(response)).directive).toBe('continue');
  });

  it('refuses a revoked worker and tells it to shut down', async () => {
    const { id, token } = await enrolWorker();
    await services.workerService.revoke(id, 'no longer trusted');

    const poll = await import('@/app/api/worker/poll/route');
    const response = await poll.POST(
      workerPost('/api/worker/poll', token, {
        heartbeat: HEARTBEAT,
        wantsWork: true,
        acknowledgedCommandIds: [],
      }),
    );
    expect(response.status).toBe(403);
    expect((await body(response)).error.message).toContain('revoked');
  });

  it('rotates a token, and the old one stops working immediately', async () => {
    const { id, token: oldToken } = await enrolWorker();
    const rotated = await services.workerService.rotate(id);
    expect(rotated.token).not.toBe(oldToken);

    const poll = await import('@/app/api/worker/poll/route');
    const payload = { heartbeat: HEARTBEAT, wantsWork: true, acknowledgedCommandIds: [] };
    expect((await poll.POST(workerPost('/api/worker/poll', oldToken, payload))).status).toBe(401);
    expect((await poll.POST(workerPost('/api/worker/poll', rotated.token, payload))).status).toBe(
      200,
    );
  });

  it('never returns a worker token hash from an owner route', async () => {
    await signIn();
    await enrolWorker();
    const workers = await import('@/app/api/workers/route');
    const response = await workers.GET(new Request(`${BASE}/api/workers`));
    const text = JSON.stringify(await body(response));
    expect(text).not.toContain('tokenHash');
    expect(text).not.toContain('token_hash');
    expect(text).toContain('tokenPrefix');
  });

  /* -------------------------------------------------------------- claiming */

  it('refuses work to a worker on an incompatible build, and says which version it expects', async () => {
    /*
     * The mismatch used to be *observed* — a qualification check counted it — while the
     * incompatible worker went on claiming missions and reporting states this control plane may
     * read differently. A 403 is fatal to the worker client, so it exits with the message rather
     * than looping.
     */
    const missionId = await approvedMission();
    const { token } = await enrolWorker('old-worker');
    const claim = await import('@/app/api/worker/claim/route');

    const refused = await claim.POST(
      workerPost('/api/worker/claim', token, {
        heartbeat: { ...HEARTBEAT, version: '1.4.2' },
        accepts: ['execution'],
      }),
    );
    expect(refused.status).toBe(403);
    const message = (await body(refused)).error.message as string;
    expect(message).toContain('1.4.2');
    expect(message).toContain(WORKER_VERSION);

    /* Refused, not merely warned: the mission is untouched and still claimable. */
    expect((await services.missionRepo.findById(missionId))?.state).toBe('queued');

    /* A worker reporting no version at all is in the same position, not a lenient one. */
    const { token: silent } = await enrolWorker('silent-worker');
    const noVersion = await claim.POST(
      workerPost('/api/worker/claim', silent, {
        heartbeat: { ...HEARTBEAT, version: null },
        accepts: ['execution'],
      }),
    );
    expect(noVersion.status).toBe(403);

    /* And the matching build still gets the mission. */
    const { token: current } = await enrolWorker('current-worker');
    const accepted = await claim.POST(
      workerPost('/api/worker/claim', current, {
        heartbeat: HEARTBEAT,
        accepts: ['execution'],
      }),
    );
    expect(accepted.status).toBe(200);
    expect((await body(accepted)).assignment).toBeTruthy();
  });

  it('lets exactly one of two workers claim the same queued mission', async () => {
    const missionId = await approvedMission();
    const a = await enrolWorker('worker-a');
    const b = await enrolWorker('worker-b');

    const claim = await import('@/app/api/worker/claim/route');
    const request = { heartbeat: HEARTBEAT, accepts: ['execution'] };

    const [first, second] = await Promise.all([
      claim.POST(workerPost('/api/worker/claim', a.token, request)),
      claim.POST(workerPost('/api/worker/claim', b.token, request)),
    ]);

    const assignments = [(await body(first)).assignment, (await body(second)).assignment].filter(
      Boolean,
    );

    expect(assignments).toHaveLength(1);
    expect(assignments[0].missionId).toBe(missionId);
    expect((await services.missionRepo.findById(missionId))?.state).toBe('claimed');
  });

  it('honours the concurrency limit of one active mission', async () => {
    const first = await approvedMission();
    const second = await approvedMission();
    expect(first).not.toBe(second);

    const worker = await enrolWorker();
    const claim = await import('@/app/api/worker/claim/route');
    const request = { heartbeat: HEARTBEAT, accepts: ['execution'] };

    const one = await body(
      await claim.POST(workerPost('/api/worker/claim', worker.token, request)),
    );
    expect(one.assignment).not.toBeNull();

    /* A second worker cannot start the other mission while one is active. */
    const other = await enrolWorker('worker-b');
    const two = await body(await claim.POST(workerPost('/api/worker/claim', other.token, request)));
    expect(two.assignment).toBeNull();
  });

  it('assembles the assignment from Jarvis’s own tables, never from the worker', async () => {
    const missionId = await approvedMission();
    const worker = await enrolWorker();
    const claim = await import('@/app/api/worker/claim/route');
    const assignment = (
      await body(
        await claim.POST(
          workerPost('/api/worker/claim', worker.token, {
            heartbeat: HEARTBEAT,
            accepts: ['execution'],
          }),
        ),
      )
    ).assignment;

    const mission = await services.missionRepo.findById(missionId);
    expect(assignment.projectId).toBe(mission?.projectId);
    expect(assignment.planVersion).toBe(mission?.approvedPlanVersion);
    expect(assignment.plan).not.toBeNull();
    /*
     * No credential *value* reaches the worker in the assignment. The plan's prose legitimately
     * mentions secrets — "Changing repository settings, secrets or CI credentials" is in its
     * out-of-scope list — so the assertion is about credential shapes, not the word.
     */
    const text = JSON.stringify(assignment);
    expect(text).not.toMatch(/ghp_|github_pat_|sk-ant-|jarvisw_/);
    expect(text).not.toContain(ENV.SESSION_SECRET);
    expect(text).not.toContain(ENV.CRON_SECRET);
  });

  /* ------------------------------------------------------- run authorisation */

  it('refuses a worker posting events for another worker’s run', async () => {
    await approvedMission();
    const a = await enrolWorker('worker-a');
    const b = await enrolWorker('worker-b');

    const claim = await import('@/app/api/worker/claim/route');
    const assignment = (
      await body(
        await claim.POST(
          workerPost('/api/worker/claim', a.token, {
            heartbeat: HEARTBEAT,
            accepts: ['execution'],
          }),
        ),
      )
    ).assignment;

    const events = await import('@/app/api/worker/events/route');
    const response = await events.POST(
      workerPost('/api/worker/events', b.token, {
        runId: assignment.runId,
        events: [{ seq: 1, type: 'agent_message', summary: 'I am not this run’s worker.' }],
      }),
    );
    expect(response.status).toBe(403);
    expect((await body(response)).error.message).toContain('different worker');
  });

  it('refuses a stale run id once the mission has moved on', async () => {
    const missionId = await approvedMission();
    const worker = await enrolWorker();
    const claim = await import('@/app/api/worker/claim/route');
    const assignment = (
      await body(
        await claim.POST(
          workerPost('/api/worker/claim', worker.token, {
            heartbeat: HEARTBEAT,
            accepts: ['execution'],
          }),
        ),
      )
    ).assignment;

    /* The control plane detaches the run — as it does on a stop or a retry. */
    await services.missionRepo.patch(missionId, { activeRunId: null });

    const events = await import('@/app/api/worker/events/route');
    const response = await events.POST(
      workerPost('/api/worker/events', worker.token, {
        runId: assignment.runId,
        events: [{ seq: 2, type: 'agent_message', summary: 'still going' }],
      }),
    );
    expect(response.status).toBe(409);
    expect((await body(response)).error.message).toContain('no longer this mission');
  });

  it('stops accepting execution events once a mission is stopped', async () => {
    const missionId = await approvedMission();
    const worker = await enrolWorker();
    const claim = await import('@/app/api/worker/claim/route');
    const assignment = (
      await body(
        await claim.POST(
          workerPost('/api/worker/claim', worker.token, {
            heartbeat: HEARTBEAT,
            accepts: ['execution'],
          }),
        ),
      )
    ).assignment;

    await services.missionRepo.transition(missionId, 'stopping', {});
    await services.missionRepo.transition(missionId, 'stopped', {});

    const events = await import('@/app/api/worker/events/route');
    const refused = await events.POST(
      workerPost('/api/worker/events', worker.token, {
        runId: assignment.runId,
        events: [{ seq: 3, type: 'tool_use', summary: 'editing a file anyway' }],
      }),
    );
    expect(refused.status).toBe(409);

    /* But the record of *why* it stopped is still accepted. */
    const accepted = await events.POST(
      workerPost('/api/worker/events', worker.token, {
        runId: assignment.runId,
        events: [{ seq: 4, type: 'run_finished', summary: 'Stopped; workspace preserved.' }],
      }),
    );
    expect(accepted.status).toBe(200);
  });

  it('rejects an invalid state transition proposed by a worker', async () => {
    await approvedMission();
    const worker = await enrolWorker();
    const claim = await import('@/app/api/worker/claim/route');
    const assignment = (
      await body(
        await claim.POST(
          workerPost('/api/worker/claim', worker.token, {
            heartbeat: HEARTBEAT,
            accepts: ['execution'],
          }),
        ),
      )
    ).assignment;

    const run = await import('@/app/api/worker/run/route');
    const response = await run.POST(
      workerPost('/api/worker/run', worker.token, {
        runId: assignment.runId,
        /* claimed → completed is not a transition that exists. */
        missionState: 'completed',
        completionSummary: 'All done, honest.',
      }),
    );
    expect(response.status).toBe(409);
    expect((await body(response)).error.message).toContain('cannot move');
  });

  it('applies a metadata-only report without touching the mission state', async () => {
    const missionId = await approvedMission();
    const worker = await enrolWorker();
    const claim = await import('@/app/api/worker/claim/route');
    const assignment = (
      await body(
        await claim.POST(
          workerPost('/api/worker/claim', worker.token, {
            heartbeat: HEARTBEAT,
            accepts: ['execution'],
          }),
        ),
      )
    ).assignment;
    const runId = (assignment as { runId: string }).runId;

    const run = await import('@/app/api/worker/run/route');

    /*
     * A session id or a token count says nothing about where the mission has got to. Sending one
     * must not be read as a state assertion — during a read-only inspection the worker's last
     * state is `inspecting`, from which `running` is not a move that exists at all.
     */
    const metadata = await body(
      await run.POST(
        workerPost('/api/worker/run', worker.token, {
          runId,
          agentSessionId: 'session-abc',
          usage: { inputTokens: 120, outputTokens: 40 },
        }),
      ),
    );
    expect(metadata.missionState).toBe('claimed');

    /* Get the mission genuinely running, then let the owner ask for a pause. */
    for (const state of ['preparing_workspace', 'running']) {
      const moved = await run.POST(
        workerPost('/api/worker/run', worker.token, { runId, missionState: state }),
      );
      expect(moved.status).toBe(200);
    }
    const commands = await import('@/app/api/missions/[id]/commands/route');
    const paused = await commands.POST(
      ownerPost(`/api/missions/${missionId}/commands`, {
        json: { command: 'pause', idempotencyKey: 'metadata-pause-0001' },
      }),
      params({ id: missionId }),
    );
    expect(paused.status).toBe(200);
    expect((await services.missionRepo.findById(missionId))?.state).toBe('pausing');

    /* The next token count that happens to arrive must not undo it. */
    const afterPause = await body(
      await run.POST(
        workerPost('/api/worker/run', worker.token, {
          runId,
          usage: { inputTokens: 200, outputTokens: 80 },
        }),
      ),
    );
    expect(afterPause.missionState).toBe('pausing');
    expect(afterPause.pauseRequested).toBe(true);
  });

  /* ----------------------------------------------------------- idempotency */

  it('replays a retried worker request instead of applying it twice', async () => {
    await approvedMission();
    const worker = await enrolWorker();
    const claim = await import('@/app/api/worker/claim/route');
    const assignment = (
      await body(
        await claim.POST(
          workerPost('/api/worker/claim', worker.token, {
            heartbeat: HEARTBEAT,
            accepts: ['execution'],
          }),
        ),
      )
    ).assignment;

    const events = await import('@/app/api/worker/events/route');
    const payload = {
      runId: assignment.runId,
      events: [{ seq: 10, type: 'agent_message', summary: 'Reading the parser.' }],
    };

    const first = await events.POST(
      workerPost('/api/worker/events', worker.token, payload, { idempotencyKey: 'retry-key-0001' }),
    );
    const second = await events.POST(
      workerPost('/api/worker/events', worker.token, payload, { idempotencyKey: 'retry-key-0001' }),
    );

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.headers.get('idempotent-replay')).toBe('true');

    const stored = await services.missionEvents.listForRun(assignment.runId as string);
    expect(stored.filter((event) => event.seq === 10)).toHaveLength(1);
  });

  it('rejects the same idempotency key used with a different body', async () => {
    await approvedMission();
    const worker = await enrolWorker();
    const claim = await import('@/app/api/worker/claim/route');
    const assignment = (
      await body(
        await claim.POST(
          workerPost('/api/worker/claim', worker.token, {
            heartbeat: HEARTBEAT,
            accepts: ['execution'],
          }),
        ),
      )
    ).assignment;

    const events = await import('@/app/api/worker/events/route');
    await events.POST(
      workerPost(
        '/api/worker/events',
        worker.token,
        { runId: assignment.runId, events: [{ seq: 20, type: 'info', summary: 'one' }] },
        { idempotencyKey: 'shared-key-0001' },
      ),
    );
    const conflicting = await events.POST(
      workerPost(
        '/api/worker/events',
        worker.token,
        { runId: assignment.runId, events: [{ seq: 21, type: 'info', summary: 'two' }] },
        { idempotencyKey: 'shared-key-0001' },
      ),
    );
    expect(conflicting.status).toBe(409);
    expect((await body(conflicting)).error.message).toContain('different request body');
  });

  it('requires an idempotency key on state-changing worker routes', async () => {
    const { token } = await enrolWorker();
    const claim = await import('@/app/api/worker/claim/route');
    const response = await claim.POST(
      workerPost(
        '/api/worker/claim',
        token,
        { heartbeat: HEARTBEAT, accepts: ['execution'] },
        { idempotencyKey: null },
      ),
    );
    expect(response.status).toBe(422);
    expect((await body(response)).error.message).toContain('idempotency-key');
  });

  it('makes a duplicated owner command idempotent', async () => {
    const missionId = await approvedMission();
    const worker = await enrolWorker();
    const claim = await import('@/app/api/worker/claim/route');
    await claim.POST(
      workerPost('/api/worker/claim', worker.token, {
        heartbeat: HEARTBEAT,
        accepts: ['execution'],
      }),
    );
    await services.missionRepo.transition(missionId, 'preparing_workspace', {});
    await services.missionRepo.transition(missionId, 'running', {});

    const commands = await import('@/app/api/missions/[id]/commands/route');
    const payload = { command: 'pause', idempotencyKey: 'double-tap-0001' };
    await commands.POST(
      ownerPost(`/api/missions/${missionId}/commands`, { json: payload }),
      params({ id: missionId }),
    );
    await commands.POST(
      ownerPost(`/api/missions/${missionId}/commands`, { json: payload }),
      params({ id: missionId }),
    );

    const stored = await services.missionCommands.list(missionId);
    expect(stored.filter((command) => command.kind === 'pause')).toHaveLength(1);
  });

  /* -------------------------------------------------------------- delivery */

  it('bounds a worker request body', async () => {
    const { token } = await enrolWorker();
    const events = await import('@/app/api/worker/events/route');
    const response = await events.POST(
      workerPost('/api/worker/events', token, {
        runId: '11111111-2222-4333-8444-555555555555',
        events: [{ seq: 1, type: 'agent_message', summary: 'x'.repeat(5000) }],
      }),
    );
    expect(response.status).toBe(422);
  });

  it('rejects a worker-submitted plan that describes a prohibited operation', async () => {
    await signIn();
    const created = await project();
    const missions = await import('@/app/api/missions/route');
    const missionId = (
      await body(
        await missions.POST(
          ownerPost('/api/missions', {
            json: { rawRequest: 'Tidy up the release process', projectId: created.id },
          }),
        ),
      )
    ).mission.id as string;

    await answerOpenQuestions(missionId);
    await services.missionRepo.transition(missionId, 'inspecting', {}, undefined);

    const worker = await enrolWorker();
    const claim = await import('@/app/api/worker/claim/route');
    const assignment = (
      await body(
        await claim.POST(
          workerPost('/api/worker/claim', worker.token, {
            heartbeat: HEARTBEAT,
            accepts: ['inspection'],
          }),
        ),
      )
    ).assignment;

    const planRoute = await import('@/app/api/worker/missions/[id]/plan/route');
    const response = await planRoute.POST(
      workerPost(`/api/worker/missions/${missionId}/plan`, worker.token, {
        runId: assignment.runId,
        content: {
          ...PLAN,
          approach: 'Build it, then force push to main and publish a release.',
        },
      }),
      params({ id: missionId }),
    );
    expect(response.status).toBe(403);
    expect((await body(response)).error.message).toContain('Jarvis will not run this mission');
  });

  /* ---------------------------------------------------------------- export */

  it('exports missions without any credential, session or worker secret', async () => {
    const missionId = await approvedMission();

    /* Seed the kinds of value that must never appear. */
    const worker = await enrolWorker();
    await services.missionEvents.record(missionId, {
      type: 'agent_message',
      summary: 'The token ghp_abcdefghijklmnopqrstuvwxyz0123456789 was rejected.',
      actor: 'agent',
      detail: { apiKey: 'sk-ant-should-never-appear' },
    });

    const exportRoute = await import('@/app/api/export/route');
    const response = await exportRoute.GET(new Request(`${BASE}/api/export`));
    expect(response.status).toBe(200);
    const text = JSON.stringify(await body(response));

    expect(text).not.toContain('ghp_abcdef');
    expect(text).not.toContain('sk-ant-should-never-appear');
    expect(text).not.toContain(worker.token);
    expect(text).not.toContain('tokenHash');
    expect(text).not.toContain('token_hash');
    expect(text).not.toContain(cookieStore.get(SESSION_COOKIE) ?? 'no-session');
    expect(text).not.toContain('SESSION_SECRET');
    expect(text).not.toContain('CRON_SECRET');

    /* But it does carry the mission history the owner would expect. */
    const payload = await body(
      await (await import('@/app/api/export/route')).GET(new Request(`${BASE}/api/export`)),
    );
    expect(payload.missions).toHaveLength(1);
    expect(payload.missions[0].plans.length).toBeGreaterThan(0);
    expect(payload.missions[0].runs.every((run: Json) => run.workerId === undefined)).toBe(true);
    expect(payload.missions[0].runs.every((run: Json) => typeof run.workerName === 'string')).toBe(
      true,
    );
  });

  it('refuses an artifact that belongs to a different mission', async () => {
    const first = await approvedMission();
    const second = await approvedMission();
    const artifact = await services.missions.addArtifact(
      first,
      {
        kind: 'research_report',
        title: 'Findings',
        contentType: 'text/markdown',
        content: 'Secret findings.',
        sources: [],
      },
      'agent',
      null,
    );

    const route = await import('@/app/api/missions/[id]/artifacts/[artifactId]/route');
    const wrong = await route.GET(
      new Request(`${BASE}/api/missions/${second}/artifacts/${artifact.id}`),
      params({ id: second, artifactId: artifact.id }),
    );
    expect(wrong.status).toBe(404);

    const right = await route.GET(
      new Request(`${BASE}/api/missions/${first}/artifacts/${artifact.id}`),
      params({ id: first, artifactId: artifact.id }),
    );
    expect(right.status).toBe(200);
    expect((await body(right)).artifact.title).toBe('Findings');
  });

  it('refuses an artifact request without a session', async () => {
    const missionId = await approvedMission();
    const artifact = await services.missions.addArtifact(
      missionId,
      {
        kind: 'research_report',
        title: 'Findings',
        contentType: 'text/markdown',
        content: 'Secret findings.',
        sources: [],
      },
      'agent',
      null,
    );
    cookieStore.clear();

    const route = await import('@/app/api/missions/[id]/artifacts/[artifactId]/route');
    const response = await route.GET(
      new Request(`${BASE}/api/missions/${missionId}/artifacts/${artifact.id}`),
      params({ id: missionId, artifactId: artifact.id }),
    );
    expect(response.status).toBe(401);
  });

  /* --------------------------------------------------------------- messages */

  it('pauses for a revised plan when a message changes the approved scope', async () => {
    const missionId = await approvedMission();
    const worker = await enrolWorker();
    const claim = await import('@/app/api/worker/claim/route');
    await claim.POST(
      workerPost('/api/worker/claim', worker.token, {
        heartbeat: HEARTBEAT,
        accepts: ['execution'],
      }),
    );
    await services.missionRepo.transition(missionId, 'preparing_workspace', {});
    await services.missionRepo.transition(missionId, 'running', {});

    const commands = await import('@/app/api/missions/[id]/commands/route');
    const response = await commands.POST(
      ownerPost(`/api/missions/${missionId}/commands`, {
        json: {
          command: 'message',
          idempotencyKey: 'scope-change-0001',
          message: 'Also add a CSV export while you are there',
          expectsScopeChange: false,
        },
      }),
      params({ id: missionId }),
    );
    expect(response.status).toBe(200);
    const payload = await body(response);
    expect(payload.requiresReplan).toBe(true);

    const mission = await services.missionRepo.findById(missionId);
    expect(mission?.approvedPlanVersion).toBeNull();
    expect(mission?.state).toBe('pausing');
  });

  it('delivers an ordinary message without replanning', async () => {
    const missionId = await approvedMission();
    const worker = await enrolWorker();
    const claim = await import('@/app/api/worker/claim/route');
    await claim.POST(
      workerPost('/api/worker/claim', worker.token, {
        heartbeat: HEARTBEAT,
        accepts: ['execution'],
      }),
    );
    await services.missionRepo.transition(missionId, 'preparing_workspace', {});
    await services.missionRepo.transition(missionId, 'running', {});

    const commands = await import('@/app/api/missions/[id]/commands/route');
    const response = await commands.POST(
      ownerPost(`/api/missions/${missionId}/commands`, {
        json: {
          command: 'message',
          idempotencyKey: 'ordinary-message-01',
          message: 'Prefer the existing parser rather than writing a new one.',
          expectsScopeChange: false,
        },
      }),
      params({ id: missionId }),
    );
    expect((await body(response)).requiresReplan).toBe(false);
    expect((await services.missionRepo.findById(missionId))?.state).toBe('running');
    expect(
      (await services.missionCommands.pendingFor(missionId)).some(
        (command) => command.kind === 'message',
      ),
    ).toBe(true);
  });

  it('refuses a message or an answer that looks like a credential', async () => {
    const missionId = await approvedMission();
    const worker = await enrolWorker();
    const claim = await import('@/app/api/worker/claim/route');
    await claim.POST(
      workerPost('/api/worker/claim', worker.token, {
        heartbeat: HEARTBEAT,
        accepts: ['execution'],
      }),
    );
    await services.missionRepo.transition(missionId, 'preparing_workspace', {});
    await services.missionRepo.transition(missionId, 'running', {});

    const commands = await import('@/app/api/missions/[id]/commands/route');
    const response = await commands.POST(
      ownerPost(`/api/missions/${missionId}/commands`, {
        json: {
          command: 'message',
          idempotencyKey: 'credential-message-1',
          message: 'Use this token: ghp_abcdefghijklmnopqrstuvwxyz0123456789',
          expectsScopeChange: false,
        },
      }),
      params({ id: missionId }),
    );
    expect(response.status).toBe(422);
    expect((await body(response)).error.message).toContain('credential');
  });

  /* ----------------------------------------------------------------- stop */

  it('marks a mission stopped only once the worker is confirmed gone, preserving its work', async () => {
    const missionId = await approvedMission();
    const worker = await enrolWorker();
    const claim = await import('@/app/api/worker/claim/route');
    await claim.POST(
      workerPost('/api/worker/claim', worker.token, {
        heartbeat: HEARTBEAT,
        accepts: ['execution'],
      }),
    );
    await services.missionRepo.transition(missionId, 'preparing_workspace', {});
    await services.missionRepo.transition(missionId, 'running', {});

    const commands = await import('@/app/api/missions/[id]/commands/route');
    const response = await commands.POST(
      ownerPost(`/api/missions/${missionId}/commands`, {
        json: {
          command: 'stop',
          idempotencyKey: 'stop-request-0001',
          confirm: true,
          reason: 'Changed my mind.',
        },
      }),
      params({ id: missionId }),
    );
    expect(response.status).toBe(200);

    /*
     * The worker is connected, so the mission is *stopping* — not stopped. Only the worker's
     * confirmation, or a determination that it is gone, completes the stop.
     */
    const mission = await services.missionRepo.findById(missionId);
    expect(mission?.state).toBe('stopping');
    expect(mission?.cancellationReason).toBe('Changed my mind.');
  });

  it('completes a stop whose worker never came back, and fails nothing else', async () => {
    /*
     * The deadlock this clears. `stop()` moves a mission to `stopping` and waits for the worker
     * to confirm; a worker that never returns leaves it there for ever — not stopped, not
     * resumable, not retryable — and `stop()`'s own comment has always named this function as
     * what resolves that.
     *
     * The second half is the more important half: a mission that is merely *running* under the
     * same absent worker is left exactly where it is. Its work is very likely intact on disk, and
     * inventing a `failed` for a process that was restarted would throw away a run that is about
     * to resume.
     */
    const stopping = await approvedMission();
    const running = await approvedMission();
    const worker = await enrolWorker();

    /*
     * Both missions are put in the worker's hands directly rather than through two claims: a
     * worker holds one run at a time, and what is under test is the reconciliation, not the
     * claim. The states below are walked through the real transitions all the same.
     */
    await services.missionRepo.patch(stopping, { claimedByWorkerId: worker.id });
    await services.missionRepo.patch(running, { claimedByWorkerId: worker.id });
    await services.missionRepo.transition(stopping, 'claimed', {});
    await services.missionRepo.transition(stopping, 'preparing_workspace', {});
    await services.missionRepo.transition(stopping, 'running', {});
    await services.missionRepo.transition(stopping, 'stopping', {});
    await services.missionRepo.transition(running, 'claimed', {});
    await services.missionRepo.transition(running, 'preparing_workspace', {});
    await services.missionRepo.transition(running, 'running', {});

    /* Nothing changes while the worker is still reachable. */
    const quiet = await services.missions.reconcileLostWorkers();
    expect(quiet.stoppedConfirmed).toBe(0);
    expect((await services.missionRepo.findById(stopping))?.state).toBe('stopping');

    await services.workerService.revoke(worker.id, 'the machine was retired');

    const result = await services.missions.reconcileLostWorkers();
    expect(result.stoppedConfirmed).toBe(1);
    expect(result.stalled).toBe(1);

    expect((await services.missionRepo.findById(stopping))?.state).toBe('stopped');
    /* Left alone, deliberately. Not failed, not stopped, not silently retried. */
    expect((await services.missionRepo.findById(running))?.state).toBe('running');
  });

  it('refuses to retry a mission that failed for a policy reason', async () => {
    const missionId = await approvedMission();
    await services.missionRepo.transition(missionId, 'claimed', {});
    await services.missionRepo.transition(missionId, 'failed', {
      failureCode: 'policy_violation',
      failureMessage: 'It tried to force push.',
    });

    const retry = await import('@/app/api/missions/[id]/retry/route');
    const response = await retry.POST(
      ownerPost(`/api/missions/${missionId}/retry`),
      params({ id: missionId }),
    );
    expect(response.status).toBe(403);
    expect((await body(response)).error.message).toContain('policy or authorization reason');
  });
});
