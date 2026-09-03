import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { getServices } from '@/server/container';
import type { MissionTask } from '@/domain/mission-task';

/**
 * The multi-agent factory's HTTP layer, exercised through the real shipping handlers.
 *
 * Same discipline as `mission-http.test.ts`: no route logic is reimplemented here. Each test
 * imports the module Next.js deploys and drives it with a real `Request`, so the owner guard, the
 * same-origin check and the worker bearer check are the ones that ship. `next/headers` is the
 * only replacement, because it needs Next's per-request storage.
 *
 * What these tests are *for* is the set of claims in §27 that are only true if the routes behave:
 * that an agent cannot widen its own permissions, claim two tasks at once, write outside its
 * declared scope, report on another agent's run, see the work it is reviewing being defended,
 * install a playbook, dispatch CI, or approve anything at all.
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
  JARVIS_MISSION_CONCURRENCY: '2',
  LOG_LEVEL: 'error',
};

/**
 * Variables a single test turns on and every other test must not inherit.
 *
 * Listed explicitly rather than restored by prefix, because the failure this prevents is the
 * quiet one: a "the CI controller is switched off" test passing while the controller is on,
 * because the test before it enabled one and nothing turned it back off.
 */
const OPTIONAL_ENV = [
  'JARVIS_CI_ENABLED',
  'JARVIS_CI_GITHUB_TOKEN',
  'JARVIS_CI_API_URL',
  'JARVIS_CI_REPOSITORIES',
  'JARVIS_CI_WORKFLOWS',
  'JARVIS_CI_REFS',
  'JARVIS_CI_MAX_DISPATCHES_PER_HOUR',
] as const;

type Services = Awaited<ReturnType<typeof getServices>>;

/* eslint-disable @typescript-eslint/no-explicit-any -- narrowed at each use. */
type Json = Record<string, any>;
/* eslint-enable @typescript-eslint/no-explicit-any */

async function body(response: Response): Promise<Json> {
  return (await response.json()) as Json;
}

function ownerRequest(
  method: string,
  path: string,
  init: { origin?: string | null; json?: unknown } = {},
): Request {
  const headers = new Headers({ 'content-type': 'application/json' });
  if (init.origin !== null) headers.set('origin', init.origin ?? BASE);
  return new Request(`${BASE}${path}`, {
    method,
    headers,
    body: init.json === undefined ? undefined : JSON.stringify(init.json),
  });
}

const ownerPost = (path: string, init: { origin?: string | null; json?: unknown } = {}) =>
  ownerRequest('POST', path, init);

function workerPost(path: string, token: string | null, json: unknown): Request {
  const headers = new Headers({ 'content-type': 'application/json' });
  if (token) headers.set('authorization', `Bearer ${token}`);
  headers.set('idempotency-key', `key-${Math.random().toString(36).slice(2)}-aaaa`);
  return new Request(`${BASE}${path}`, { method: 'POST', headers, body: JSON.stringify(json) });
}

const params = <T extends Record<string, string>>(value: T) => ({ params: Promise.resolve(value) });

const HEARTBEAT = {
  status: 'idle' as const,
  runtimeAvailable: true,
  workspaceHealthy: true,
  githubDeliveryConfigured: true,
  diagnostics: [],
};


describe('Multi-agent factory HTTP handlers', () => {
  let close: () => Promise<void>;
  let services: Services;
  let restoreEnv: Array<[string, string | undefined]> = [];

  beforeEach(async () => {
    vi.resetModules();
    cookieStore.clear();
    requestHeaders.clear();

    restoreEnv = [...Object.keys(ENV), ...OPTIONAL_ENV].map((key) => [key, process.env[key]]);
    for (const [key, value] of Object.entries(ENV)) process.env[key] = value;
    for (const key of OPTIONAL_ENV) delete process.env[key];

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

  /* ------------------------------------------------------------- fixtures */

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

  async function project(type: 'software' | 'ios_app' = 'software') {
    return services.projects.create({
      name: `Project ${Math.random().toString(36).slice(2, 8)}`,
      type,
      status: 'active',
      priority: 'medium',
      tags: [],
      links: [],
    });
  }

  /** A mission with an approved plan, created and driven entirely through the real routes. */
  async function approvedMission(options: { projectType?: 'software' | 'ios_app' } = {}) {
    await signIn();
    const created = await project(options.projectType ?? 'software');
    const missions = await import('@/app/api/missions/route');
    const response = await missions.POST(
      ownerPost('/api/missions', {
        json: { rawRequest: 'Add invoice scanning to the app', projectId: created.id },
      }),
    );
    expect(response.status).toBe(201);
    const missionId = (await body(response)).mission.id as string;

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
    expect(
      (await plan.POST(ownerPost(`/api/missions/${missionId}/plan`), params({ id: missionId })))
        .status,
    ).toBe(201);

    const mission = await services.missionRepo.findById(missionId);
    const approve = await import('@/app/api/missions/[id]/approve/route');
    const approved = await approve.POST(
      ownerPost(`/api/missions/${missionId}/approve`, {
        json: {
          planVersion: mission?.currentPlanVersion ?? 1,
          acknowledgedRiskLevel: mission?.riskLevel ?? 'moderate',
        },
      }),
      params({ id: missionId }),
    );
    expect(approved.status, JSON.stringify(await approved.clone().json())).toBe(200);
    return { missionId, projectId: created.id };
  }

  /** Propose and approve a task graph through the real routes. Returns its tasks. */
  async function approvedGraph(
    missionId: string,
    options: { playbookKey?: string } = {},
  ): Promise<readonly MissionTask[]> {
    const graph = await import('@/app/api/missions/[id]/graph/route');
    const proposed = await graph.POST(
      ownerPost(`/api/missions/${missionId}/graph`, {
        json: options.playbookKey ? { playbookKey: options.playbookKey } : {},
      }),
      params({ id: missionId }),
    );
    expect(proposed.status, JSON.stringify(await proposed.clone().json())).toBe(201);
    const proposal = (await body(proposed)).proposal as Json;

    const approve = await import('@/app/api/missions/[id]/graph/approve/route');
    const approved = await approve.POST(
      ownerPost(`/api/missions/${missionId}/graph/approve`, {
        json: {
          graphVersion: proposal.graph.version,
          fingerprint: proposal.graph.fingerprint,
        },
      }),
      params({ id: missionId }),
    );
    expect(approved.status, JSON.stringify(await approved.clone().json())).toBe(200);
    return services.tasks.listByGraph(proposal.graph.id as string);
  }

  async function enrolWorker(name = 'worker-a'): Promise<{ id: string; token: string }> {
    const enrolment = await services.workerService.enrol(name, 1);
    return { id: enrolment.worker.id, token: enrolment.token };
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
    'planner',
    'investigator',
    'release_manager',
    'summariser',
  ];

  /**
   * Walk one task from `claimed` to `succeeded` the way a worker really does.
   *
   * Deliberately not a shortcut: `claimed → preparing → running → succeeded` is the sequence the
   * machine allows, and a helper that jumped states would let a test pass against a machine that
   * had stopped enforcing them.
   */
  async function finishTask(
    token: string,
    assignment: Json,
    patch: Record<string, unknown> = {},
  ): Promise<void> {
    const taskRoute = await import('@/app/api/worker/task/route');
    const report = async (fields: Record<string, unknown>) => {
      const response = await taskRoute.POST(
        workerPost('/api/worker/task', token, {
          runId: assignment.runId,
          taskId: assignment.taskId,
          ...fields,
        }),
      );
      expect(response.status, JSON.stringify(await response.clone().json())).toBe(200);
    };
    await report({ taskState: 'preparing' });
    await report({ taskState: 'running' });
    await report({ taskState: 'succeeded', completionSummary: 'Done.', ...patch });
  }

  async function claim(token: string, roles: readonly string[] = ALL_ROLES): Promise<Json | null> {
    const route = await import('@/app/api/worker/claim-task/route');
    const response = await route.POST(
      workerPost('/api/worker/claim-task', token, { heartbeat: HEARTBEAT, roles }),
    );
    expect(response.status, JSON.stringify(await response.clone().json())).toBe(200);
    return ((await body(response)).assignment ?? null) as Json | null;
  }

  /* --------------------------------------------------- owner authentication */

  it('refuses every new owner route without a session', async () => {
    const modules = await Promise.all([
      import('@/app/api/missions/[id]/graph/route'),
      import('@/app/api/missions/[id]/graph/approve/route'),
      import('@/app/api/missions/[id]/tasks/[taskId]/route'),
      import('@/app/api/missions/[id]/findings/[findingId]/route'),
      import('@/app/api/missions/[id]/receipt/route'),
      import('@/app/api/playbooks/route'),
      import('@/app/api/playbooks/[key]/route'),
      import('@/app/api/capacity/route'),
      import('@/app/api/ci/route'),
      import('@/app/api/ci/[id]/dispatch/route'),
      import('@/app/api/releases/approve/route'),
      import('@/app/api/releases/[id]/revoke/route'),
      import('@/app/api/displays/route'),
      import('@/app/api/displays/[id]/route'),
      import('@/app/api/projects/[id]/app-profile/route'),
    ]);
    const [
      graph,
      graphApprove,
      task,
      finding,
      receipt,
      playbooks,
      playbook,
      capacity,
      ci,
      ciDispatch,
      releaseApprove,
      releaseRevoke,
      displays,
      display,
      appProfile,
    ] = modules;

    const id = '11111111-2222-4333-8444-555555555555';
    const responses = await Promise.all([
      graph.GET(new Request(`${BASE}/api/missions/${id}/graph`), params({ id })),
      graph.POST(ownerPost(`/api/missions/${id}/graph`, { json: {} }), params({ id })),
      graphApprove.POST(
        ownerPost(`/api/missions/${id}/graph/approve`, {
          json: { graphVersion: 1, fingerprint: 'x'.repeat(32) },
        }),
        params({ id }),
      ),
      task.GET(new Request(`${BASE}/api/missions/${id}/tasks/${id}`), params({ id, taskId: id })),
      task.POST(
        ownerPost(`/api/missions/${id}/tasks/${id}`, { json: { action: 'skip' } }),
        params({ id, taskId: id }),
      ),
      finding.POST(
        ownerPost(`/api/missions/${id}/findings/${id}`, { json: { decision: 'accept' } }),
        params({ id, findingId: id }),
      ),
      receipt.GET(new Request(`${BASE}/api/missions/${id}/receipt`), params({ id })),
      playbooks.GET(new Request(`${BASE}/api/playbooks`)),
      playbooks.POST(ownerPost('/api/playbooks', { json: { definition: {} } })),
      playbook.GET(new Request(`${BASE}/api/playbooks/software_feature`), {
        params: Promise.resolve({ key: 'software_feature' }),
      }),
      playbook.PATCH(
        ownerRequest('PATCH', '/api/playbooks/software_feature', { json: { enabled: false } }),
        { params: Promise.resolve({ key: 'software_feature' }) },
      ),
      capacity.GET(new Request(`${BASE}/api/capacity`)),
      capacity.POST(ownerPost('/api/capacity', { json: { kind: 'posture', posture: 'stopped' } })),
      ci.GET(new Request(`${BASE}/api/ci`)),
      ciDispatch.POST(ownerPost(`/api/ci/${id}/dispatch`), params({ id })),
      releaseApprove.POST(ownerPost('/api/releases/approve', { json: {} })),
      releaseRevoke.POST(ownerPost(`/api/releases/${id}/revoke`), params({ id })),
      displays.GET(new Request(`${BASE}/api/displays`)),
      displays.POST(ownerPost('/api/displays', { json: { name: 'Kitchen' } })),
      display.DELETE(ownerRequest('DELETE', `/api/displays/${id}`, { json: {} }), params({ id })),
      appProfile.GET(new Request(`${BASE}/api/projects/${id}/app-profile`), params({ id })),
      appProfile.PUT(
        ownerRequest('PUT', `/api/projects/${id}/app-profile`, { json: {} }),
        params({ id }),
      ),
    ]);

    for (const response of responses) expect(response.status).toBe(401);
  });

  it('refuses a cross-origin write to the new owner routes', async () => {
    await signIn();
    const capacity = await import('@/app/api/capacity/route');
    const response = await capacity.POST(
      ownerPost('/api/capacity', {
        origin: 'https://evil.example.com',
        json: { kind: 'posture', posture: 'stopped' },
      }),
    );
    expect(response.status).toBe(403);
    /* And the posture did not change. */
    expect(await services.orchestrator.posture()).toBe('open');
  });

  /* -------------------------------------------------- worker authentication */

  it('refuses every new worker route without a valid bearer token', async () => {
    const [claimTask, lease, task, review] = await Promise.all([
      import('@/app/api/worker/claim-task/route'),
      import('@/app/api/worker/lease/route'),
      import('@/app/api/worker/task/route'),
      import('@/app/api/worker/review/route'),
    ]);
    const id = '11111111-2222-4333-8444-555555555555';

    for (const token of [null, 'jarvisw_not-a-real-token.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa']) {
      const responses = await Promise.all([
        claimTask.POST(
          workerPost('/api/worker/claim-task', token, {
            heartbeat: HEARTBEAT,
            roles: ['builder'],
          }),
        ),
        lease.POST(workerPost('/api/worker/lease', token, { runId: id, taskId: id, paths: [] })),
        task.POST(workerPost('/api/worker/task', token, { runId: id, taskId: id })),
        review.POST(
          workerPost('/api/worker/review', token, {
            runId: id,
            taskId: id,
            verdict: 'approved',
            summary: 'Looks fine.',
            diffFingerprint: 'a'.repeat(16),
          }),
        ),
      ]);
      for (const response of responses) expect(response.status).toBe(401);
    }
  });

  /* ------------------------------------------------------- graph approval */

  it('will not run a task graph the owner has not approved', async () => {
    const { missionId } = await approvedMission();
    const graph = await import('@/app/api/missions/[id]/graph/route');
    const proposed = await graph.POST(
      ownerPost(`/api/missions/${missionId}/graph`, { json: {} }),
      params({ id: missionId }),
    );
    expect(proposed.status).toBe(201);

    const worker = await enrolWorker();
    expect(await claim(worker.token)).toBeNull();
  });

  it('refuses an approval whose fingerprint does not match the graph shown', async () => {
    const { missionId } = await approvedMission();
    const graph = await import('@/app/api/missions/[id]/graph/route');
    const proposed = await graph.POST(
      ownerPost(`/api/missions/${missionId}/graph`, { json: {} }),
      params({ id: missionId }),
    );
    const proposal = (await body(proposed)).proposal as Json;

    const approve = await import('@/app/api/missions/[id]/graph/approve/route');
    const response = await approve.POST(
      ownerPost(`/api/missions/${missionId}/graph/approve`, {
        json: { graphVersion: proposal.graph.version, fingerprint: 'b'.repeat(64) },
      }),
      params({ id: missionId }),
    );
    expect(response.status).toBe(409);
    expect((await body(response)).error.message).toMatch(/changed since it was shown/i);
  });

  it('revokes an approval when a new graph version is proposed', async () => {
    const { missionId } = await approvedMission();
    await approvedGraph(missionId);
    expect((await services.missionRepo.findById(missionId))?.approvedGraphVersion).toBe(1);

    /* A different playbook produces a different graph, so a new version is stored. */
    await services.playbookService.seedBuiltIns();
    const graph = await import('@/app/api/missions/[id]/graph/route');
    const again = await graph.POST(
      ownerPost(`/api/missions/${missionId}/graph`, { json: { playbookKey: 'repository_audit' } }),
      params({ id: missionId }),
    );
    expect(again.status, JSON.stringify(await again.clone().json())).toBe(201);
    expect((await body(again)).proposal.graph.version).toBe(2);
    expect((await services.missionRepo.findById(missionId))?.approvedGraphVersion).toBeNull();

    const worker = await enrolWorker();
    expect(await claim(worker.token)).toBeNull();
  });

  it('refuses a graph proposal before the plan is approved', async () => {
    await signIn();
    const created = await project();
    const missions = await import('@/app/api/missions/route');
    const response = await missions.POST(
      ownerPost('/api/missions', {
        json: { rawRequest: 'Add invoice scanning', projectId: created.id },
      }),
    );
    const missionId = (await body(response)).mission.id as string;

    const graph = await import('@/app/api/missions/[id]/graph/route');
    const proposed = await graph.POST(
      ownerPost(`/api/missions/${missionId}/graph`, { json: {} }),
      params({ id: missionId }),
    );
    expect(proposed.status).toBe(409);
    expect((await body(proposed)).error.message).toMatch(/approve the plan/i);
  });

  /* --------------------------------------------------------- task claiming */

  it('hands one task to exactly one of two workers racing for it', async () => {
    const { missionId } = await approvedMission();
    await approvedGraph(missionId);

    const [a, b] = await Promise.all([enrolWorker('worker-a'), enrolWorker('worker-b')]);
    const route = await import('@/app/api/worker/claim-task/route');
    const [first, second] = await Promise.all([
      route.POST(
        workerPost('/api/worker/claim-task', a.token, { heartbeat: HEARTBEAT, roles: ALL_ROLES }),
      ),
      route.POST(
        workerPost('/api/worker/claim-task', b.token, { heartbeat: HEARTBEAT, roles: ALL_ROLES }),
      ),
    ]);

    const assignments = [(await body(first)).assignment, (await body(second)).assignment].filter(
      Boolean,
    ) as Json[];
    const keys = assignments.map((assignment) => assignment.taskKey as string);
    expect(new Set(keys).size).toBe(keys.length);

    /* Every claim produced its own run, and no run was handed out twice. */
    const runs = await services.missionRuns.list(missionId);
    const runIds = runs.filter((run) => run.taskId !== null).map((run) => run.id);
    expect(new Set(runIds).size).toBe(runIds.length);
  });

  it('gives a worker nothing when it accepts no role the graph needs', async () => {
    const { missionId } = await approvedMission();
    await approvedGraph(missionId);
    const worker = await enrolWorker();
    /* `summariser` appears in no software-feature graph. */
    expect(await claim(worker.token, ['summariser'])).toBeNull();
  });

  it('gives a worker nothing when the instance is drained', async () => {
    const { missionId } = await approvedMission();
    await approvedGraph(missionId);

    const capacity = await import('@/app/api/capacity/route');
    const drained = await capacity.POST(
      ownerPost('/api/capacity', { json: { kind: 'posture', posture: 'draining' } }),
    );
    expect(drained.status).toBe(200);

    const worker = await enrolWorker();
    expect(await claim(worker.token)).toBeNull();
  });

  it('lets an owner only reduce concurrency, never raise it', async () => {
    await signIn();
    const capacity = await import('@/app/api/capacity/route');
    const before = (await body(await capacity.GET(new Request(`${BASE}/api/capacity`)))).limits;

    const raised = await capacity.POST(
      ownerPost('/api/capacity', {
        json: { kind: 'limits', maxActiveRuns: before.maxActiveRuns + 5 },
      }),
    );
    expect(raised.status).toBe(200);
    expect((await body(raised)).limits.maxActiveRuns).toBe(before.maxActiveRuns);

    const lowered = await capacity.POST(
      ownerPost('/api/capacity', { json: { kind: 'limits', maxActiveRuns: 1 } }),
    );
    expect((await body(lowered)).limits.maxActiveRuns).toBe(1);
  });

  /* --------------------------------------------- write scope and isolation */

  it('leases only what the approved graph declared, however much the worker asks for', async () => {
    const { missionId } = await approvedMission();
    const tasks = await approvedGraph(missionId);
    const writeTask = tasks.find((task) => task.role === 'builder');
    expect(writeTask).toBeDefined();

    /* Drive the graph until the builder is the task on offer. */
    const worker = await enrolWorker();
    let assignment = await claim(worker.token);
    for (let step = 0; step < 8 && assignment && assignment.role !== 'builder'; step += 1) {
      await finishTask(worker.token, assignment, { completionSummary: 'Read the code.' });
      assignment = await claim(worker.token);
    }
    expect(assignment?.role).toBe('builder');

    const lease = await import('@/app/api/worker/lease/route');
    const granted = await lease.POST(
      workerPost('/api/worker/lease', worker.token, {
        runId: assignment!.runId,
        taskId: assignment!.taskId,
        /* A worker asking for the entire repository. */
        paths: ['.', 'src', '/etc/passwd'],
      }),
    );
    expect(granted.status).toBe(200);
    expect((await body(granted)).granted).toBe(true);

    const held = await services.leases.listHeld(missionId);
    expect(held).toHaveLength(1);
    expect([...held[0]!.paths].sort()).toEqual([...writeTask!.declaredWriteSet].sort());
    expect(held[0]!.paths).not.toContain('/etc/passwd');
  });

  it('refuses a worker reporting on a run that belongs to another worker', async () => {
    const { missionId } = await approvedMission();
    await approvedGraph(missionId);
    const [a, b] = await Promise.all([enrolWorker('worker-a'), enrolWorker('worker-b')]);
    const assignment = await claim(a.token);
    expect(assignment).not.toBeNull();

    const taskRoute = await import('@/app/api/worker/task/route');
    const stolen = await taskRoute.POST(
      workerPost('/api/worker/task', b.token, {
        runId: assignment!.runId,
        taskId: assignment!.taskId,
        taskState: 'running',
      }),
    );
    expect(stolen.status).toBe(403);

    const leaseRoute = await import('@/app/api/worker/lease/route');
    const stolenLease = await leaseRoute.POST(
      workerPost('/api/worker/lease', b.token, {
        runId: assignment!.runId,
        taskId: assignment!.taskId,
        paths: ['src'],
      }),
    );
    expect(stolenLease.status).toBe(403);
  });

  it('refuses a state move the task machine does not allow', async () => {
    const { missionId } = await approvedMission();
    await approvedGraph(missionId);
    const worker = await enrolWorker();
    const assignment = await claim(worker.token);

    const taskRoute = await import('@/app/api/worker/task/route');
    /* Straight from claimed to succeeded, skipping the work, the verification and the review. */
    const jumped = await taskRoute.POST(
      workerPost('/api/worker/task', worker.token, {
        runId: assignment!.runId,
        taskId: assignment!.taskId,
        taskState: 'succeeded',
        completionSummary: 'Done, trust me.',
      }),
    );
    expect(jumped.status).toBe(409);
    expect((await body(jumped)).error.message).toMatch(/cannot move from claimed to succeeded/i);

    /* And a state that is not a state at all is refused by the schema, not by the machine. */
    const nonsense = await taskRoute.POST(
      workerPost('/api/worker/task', worker.token, {
        runId: assignment!.runId,
        taskId: assignment!.taskId,
        taskState: 'delivered',
      }),
    );
    expect(nonsense.status).toBe(422);

    /* Neither attempt moved it. */
    expect((await services.tasks.findById(assignment!.taskId as string))?.state).toBe('claimed');
  });

  /* ------------------------------------------------------ review isolation */

  it('gives a reviewer no transcript, no verdict hint and no builder defence', async () => {
    const { missionId } = await approvedMission();
    const tasks = await approvedGraph(missionId);
    expect(tasks.some((task) => task.role === 'reviewer')).toBe(true);

    const worker = await enrolWorker();
    let assignment = await claim(worker.token);
    let reviewAssignment: Json | null = null;

    for (let step = 0; step < 12 && assignment; step += 1) {
      if (assignment.role === 'reviewer') {
        reviewAssignment = assignment;
        break;
      }
      await finishTask(worker.token, assignment, {
        completionSummary: 'I am completely confident this work is correct and needs no review.',
        filesChanged: ['src/invoices.ts'],
      });
      assignment = await claim(worker.token);
    }

    expect(reviewAssignment).not.toBeNull();
    const serialised = JSON.stringify(reviewAssignment);
    expect(serialised).not.toContain('completely confident');
    expect(reviewAssignment!.review).not.toBeNull();
    expect(Object.keys(reviewAssignment!.review as Json)).not.toContain('transcript');
    expect(Object.keys(reviewAssignment!.review as Json)).not.toContain('verdict');
    expect(Object.keys(reviewAssignment!.review as Json)).not.toContain('builderSummary');
  });

  it('refuses a review verdict from a task that is not a review task', async () => {
    const { missionId } = await approvedMission();
    await approvedGraph(missionId);
    const worker = await enrolWorker();
    const assignment = await claim(worker.token);
    expect(assignment!.role).not.toBe('reviewer');

    const review = await import('@/app/api/worker/review/route');
    const response = await review.POST(
      workerPost('/api/worker/review', worker.token, {
        runId: assignment!.runId,
        taskId: assignment!.taskId,
        verdict: 'approved',
        summary: 'I reviewed my own work and it is excellent.',
        diffFingerprint: 'a'.repeat(16),
      }),
    );
    expect(response.status).toBe(403);
    expect((await body(response)).error.message).toMatch(/only a review task/i);
  });

  /* ------------------------------------------------------------- playbooks */

  it('installs the built-in playbooks and versions an edit rather than mutating it', async () => {
    await signIn();
    const seeded = await services.playbookService.seedBuiltIns();
    expect(seeded.rejected).toEqual([]);
    expect(seeded.installed).toBeGreaterThanOrEqual(9);

    /* Seeding twice adds no versions: the fingerprint is unchanged. */
    const again = await services.playbookService.seedBuiltIns();
    expect(again.installed).toBe(0);

    const route = await import('@/app/api/playbooks/route');
    const listed = await route.GET(new Request(`${BASE}/api/playbooks`));
    expect(listed.status).toBe(200);
    const playbooks = (await body(listed)).playbooks as Json[];
    const software = playbooks.find((entry) => entry.key === 'software_feature');
    expect(software).toBeDefined();

    const edited = {
      ...software!.definition,
      description: 'An edited description, which should produce version two.',
    };
    const installed = await route.POST(
      ownerPost('/api/playbooks', { json: { definition: edited, note: 'Reworded.' } }),
    );
    expect(installed.status, JSON.stringify(await installed.clone().json())).toBe(201);
    expect((await body(installed)).version.version).toBe(2);

    const versions = await services.playbookService.listVersions('software_feature');
    expect(versions.map((version) => version.version).sort()).toEqual([1, 2]);
    /* Version one is intact — a running mission pinned to it still reads what it approved. */
    expect(versions.find((version) => version.version === 1)!.definition.description).toBe(
      software!.definition.description,
    );
  });

  it('refuses to install a playbook it would refuse to run', async () => {
    await signIn();
    await services.playbookService.seedBuiltIns();
    const route = await import('@/app/api/playbooks/route');
    const listed = await route.GET(new Request(`${BASE}/api/playbooks`));
    const playbooks = (await body(listed)).playbooks as Json[];
    const software = playbooks.find((entry) => entry.key === 'software_feature')!;

    /* Strip every review task: a graph that writes and is never reviewed. */
    const broken = {
      ...software.definition,
      tasks: (software.definition.tasks as Json[]).filter(
        (task) => !String(task.role).includes('review'),
      ),
    };
    const response = await route.POST(
      ownerPost('/api/playbooks', { json: { definition: broken } }),
    );
    expect(response.status).toBe(422);
    expect((await body(response)).error.message).toMatch(/refuse to run/i);
  });

  it('will not propose a graph from a switched-off playbook', async () => {
    const { missionId } = await approvedMission();
    await services.playbookService.seedBuiltIns();
    const toggle = await import('@/app/api/playbooks/[key]/route');
    const disabled = await toggle.PATCH(
      ownerRequest('PATCH', '/api/playbooks/software_feature', { json: { enabled: false } }),
      { params: Promise.resolve({ key: 'software_feature' }) },
    );
    expect(disabled.status).toBe(200);

    const graph = await import('@/app/api/missions/[id]/graph/route');
    const proposed = await graph.POST(
      ownerPost(`/api/missions/${missionId}/graph`, { json: { playbookKey: 'software_feature' } }),
      params({ id: missionId }),
    );
    expect(proposed.status).toBe(403);
  });

  /* ----------------------------------------------------------- CI controller */

  it('refuses a CI dispatch by default, because no controller is configured', async () => {
    await signIn();
    const ci = await import('@/app/api/ci/route');
    const described = (await body(await ci.GET(new Request(`${BASE}/api/ci`)))).controller as Json;
    expect(described.enabled).toBe(false);
    expect(described.credentialConfigured).toBe(false);
    expect(Object.keys(described)).not.toContain('token');

    const outcome = await services.ci.request(
      {
        repositoryFullName: 'test-owner/app',
        workflowFile: 'testflight.yml',
        ref: 'refs/heads/main',
        commitSha: 'a'.repeat(40),
        inputs: {},
        purpose: 'testflight',
      },
      'test-owner',
    );
    expect(outcome.allowed).toBe(false);
    expect(outcome.dispatch.state).toBe('refused');
    expect(outcome.rule).toBe('R-CI1');

    /* And approving it anyway still dispatches nothing. */
    const dispatch = await import('@/app/api/ci/[id]/dispatch/route');
    const response = await dispatch.POST(
      ownerPost(`/api/ci/${outcome.dispatch.id}/dispatch`),
      params({ id: outcome.dispatch.id }),
    );
    expect(response.status).toBe(409);
  });

  it('refuses a repository or workflow that is not on the allow-list', async () => {
    process.env.JARVIS_CI_ENABLED = 'true';
    process.env.JARVIS_CI_GITHUB_TOKEN = 'ghp_test_controller_credential_value';
    process.env.JARVIS_CI_REPOSITORIES = 'test-owner/allowed';
    process.env.JARVIS_CI_WORKFLOWS = 'testflight.yml';
    process.env.JARVIS_CI_REFS = 'refs/heads/main';
    const { resetConfigCache } = await import('@/server/config/env');
    resetConfigCache();
    const { resetServices, getServices } = await import('@/server/container');
    resetServices();
    services = await getServices();
    await signIn();

    const base = {
      repositoryFullName: 'test-owner/allowed',
      workflowFile: 'testflight.yml',
      ref: 'refs/heads/main',
      commitSha: 'a'.repeat(40),
      inputs: {},
      purpose: 'testflight' as const,
    };

    const wrongRepo = await services.ci.request(
      { ...base, repositoryFullName: 'someone-else/private' },
      'test-owner',
    );
    expect(wrongRepo.allowed).toBe(false);
    expect(wrongRepo.rule).toBe('R-CI4');

    const wrongWorkflow = await services.ci.request(
      { ...base, workflowFile: 'deploy-production.yml' },
      'test-owner',
    );
    expect(wrongWorkflow.allowed).toBe(false);
    expect(wrongWorkflow.rule).toBe('R-CI6');

    const wrongRef = await services.ci.request(
      { ...base, ref: 'refs/heads/someone-elses-branch' },
      'test-owner',
    );
    expect(wrongRef.allowed).toBe(false);
    expect(wrongRef.rule).toBe('R-CI8');

    const allowed = await services.ci.request(base, 'test-owner');
    expect(allowed.allowed).toBe(true);
    /* Allowed is not dispatched: it is waiting for the owner. */
    expect(allowed.dispatch.state).toBe('awaiting_approval');
    expect(allowed.dispatch.dispatchedAt).toBeNull();

    /* And the controller's credential never appears in what the route returns. */
    const ci = await import('@/app/api/ci/route');
    const payload = JSON.stringify(await body(await ci.GET(new Request(`${BASE}/api/ci`))));
    expect(payload).not.toContain('ghp_test_controller_credential_value');
  });

  /* ------------------------------------------------------------- TestFlight */

  it('binds a TestFlight approval to one exact commit and drops it when the code moves', async () => {
    process.env.JARVIS_CI_ENABLED = 'true';
    process.env.JARVIS_CI_GITHUB_TOKEN = 'ghp_test_controller_credential_value';
    process.env.JARVIS_CI_REPOSITORIES = 'test-owner/app';
    process.env.JARVIS_CI_WORKFLOWS = 'testflight.yml';
    process.env.JARVIS_CI_REFS = 'refs/heads/main';
    const { resetConfigCache } = await import('@/server/config/env');
    resetConfigCache();
    const { resetServices, getServices } = await import('@/server/container');
    resetServices();
    services = await getServices();
    await signIn();

    const created = await project('ios_app');
    const approveRoute = await import('@/app/api/releases/approve/route');
    const request = {
      projectId: created.id,
      repositoryFullName: 'test-owner/app',
      workflowFile: 'testflight.yml',
      ref: 'refs/heads/main',
      commitSha: 'a'.repeat(40),
      inputs: {},
      confirmation: 'upload to testflight',
    };

    /* The confirmation phrase is not optional. */
    const unconfirmed = await approveRoute.POST(
      ownerPost('/api/releases/approve', { json: { ...request, confirmation: 'yes' } }),
    );
    expect(unconfirmed.status).toBe(422);

    const approved = await approveRoute.POST(ownerPost('/api/releases/approve', { json: request }));
    expect(approved.status, JSON.stringify(await approved.clone().json())).toBe(201);
    const approval = (await body(approved)).approval as Json;
    expect(approval.state).toBe('approved');

    const { dispatchIdentity, evaluateTestFlightDispatch } = await import('@/domain/ci-dispatch');
    const identityFor = (commitSha: string) =>
      dispatchIdentity({
        repositoryFullName: 'test-owner/app',
        workflowFile: 'testflight.yml',
        ref: 'refs/heads/main',
        commitSha,
        inputs: {},
        purpose: 'testflight',
      });

    const stored = await services.releaseApprovals.findActiveForIdentity(
      identityFor('a'.repeat(40)),
    );
    expect(stored).not.toBeNull();

    /* The same approval, asked about a different commit, does not apply. */
    const gate = {
      projectType: 'ios_app',
      repositoryAllowListed: true,
      workflowConfigured: true,
      signingConfigurationPresent: true,
      requiredChecksPassed: true,
      reviewApproved: true,
      approval: stored,
    };
    expect(
      evaluateTestFlightDispatch({
        ...gate,
        commitSha: 'a'.repeat(40),
        requestedIdentity: identityFor('a'.repeat(40)),
      }).allowed,
    ).toBe(true);
    const moved = evaluateTestFlightDispatch({
      ...gate,
      commitSha: 'b'.repeat(40),
      requestedIdentity: identityFor('b'.repeat(40)),
    });
    expect(moved.allowed).toBe(false);

    /* And once the head moves, the stored approval is superseded rather than left live. */
    expect(await services.ci.supersedeForMovedCommit(created.id, 'b'.repeat(40))).toBe(1);
    expect(
      await services.releaseApprovals.findActiveForIdentity(identityFor('a'.repeat(40))),
    ).toBeNull();
  });

  it('refuses a TestFlight approval while the CI controller is switched off', async () => {
    await signIn();
    const created = await project('ios_app');
    const approveRoute = await import('@/app/api/releases/approve/route');
    const response = await approveRoute.POST(
      ownerPost('/api/releases/approve', {
        json: {
          projectId: created.id,
          repositoryFullName: 'test-owner/app',
          workflowFile: 'testflight.yml',
          ref: 'refs/heads/main',
          commitSha: 'a'.repeat(40),
          inputs: {},
          confirmation: 'upload to testflight',
        },
      }),
    );
    expect(response.status).toBe(403);
  });

  it('refuses an app profile that contains anything credential-shaped', async () => {
    await signIn();
    const created = await project('ios_app');
    const route = await import('@/app/api/projects/[id]/app-profile/route');

    const rejected = await route.PUT(
      ownerRequest('PUT', `/api/projects/${created.id}/app-profile`, {
        json: {
          platform: 'ios',
          bundleIdentifier: 'com.example.app',
          signingSecretNames: [
            '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0\n-----END PRIVATE KEY-----',
          ],
        },
      }),
      params({ id: created.id }),
    );
    expect(rejected.status).toBe(422);

    const accepted = await route.PUT(
      ownerRequest('PUT', `/api/projects/${created.id}/app-profile`, {
        json: {
          platform: 'ios',
          bundleIdentifier: 'com.example.app',
          signingSecretNames: ['APP_STORE_CONNECT_KEY', 'MATCH_PASSWORD'],
          testFlightWorkflow: 'testflight.yml',
        },
      }),
      params({ id: created.id }),
    );
    expect(accepted.status, JSON.stringify(await accepted.clone().json())).toBe(200);
    expect((await body(accepted)).profile.signingSecretNames).toEqual([
      'APP_STORE_CONNECT_KEY',
      'MATCH_PASSWORD',
    ]);

    /* A pasted key is refused in a free-text field too, not only where a name is expected. */
    const pastedIntoNotes = await route.PUT(
      ownerRequest('PUT', `/api/projects/${created.id}/app-profile`, {
        json: {
          platform: 'ios',
          notes: '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0\n-----END PRIVATE KEY-----',
        },
      }),
      params({ id: created.id }),
    );
    expect(pastedIntoNotes.status).toBe(422);
  });

  /* ---------------------------------------------------------------- displays */

  it('shows a display token once, stores only its hash, and revokes on demand', async () => {
    await signIn();
    const route = await import('@/app/api/displays/route');
    const paired = await route.POST(
      ownerPost('/api/displays', {
        json: { name: 'Kitchen tablet', location: 'Kitchen', rotationSeconds: 20 },
      }),
    );
    expect(paired.status).toBe(201);
    const issued = await body(paired);
    const token = issued.token as string;
    expect(token).toMatch(/^jarvisd_/);
    expect(Object.keys(issued.device)).not.toContain('tokenHash');

    /* Listing never returns it again. */
    const listed = await body(await route.GET(new Request(`${BASE}/api/displays`)));
    expect(JSON.stringify(listed)).not.toContain(token);

    const authenticated = await services.displays.authenticate(token, {
      userAgent: 'Wallboard/1.0',
    });
    expect(authenticated.name).toBe('Kitchen tablet');

    const revokeRoute = await import('@/app/api/displays/[id]/route');
    const revoked = await revokeRoute.DELETE(
      ownerRequest('DELETE', `/api/displays/${issued.device.id}`, {
        json: { reason: 'Sold the tablet.' },
      }),
      params({ id: issued.device.id as string }),
    );
    expect(revoked.status).toBe(200);
    await expect(
      services.displays.authenticate(token, { userAgent: 'Wallboard/1.0' }),
    ).rejects.toThrow(/not paired/i);
  });

  /* ------------------------------------------------------------- the export */

  it('exports the factory record without a credential of any kind', async () => {
    process.env.JARVIS_CI_ENABLED = 'true';
    process.env.JARVIS_CI_GITHUB_TOKEN = 'ghp_test_controller_credential_value';
    process.env.JARVIS_CI_REPOSITORIES = 'test-owner/app';
    const { resetConfigCache } = await import('@/server/config/env');
    resetConfigCache();
    const { resetServices, getServices } = await import('@/server/container');
    resetServices();
    services = await getServices();

    const { missionId } = await approvedMission();
    await services.playbookService.seedBuiltIns();
    await approvedGraph(missionId);
    const worker = await enrolWorker();
    const workerToken = worker.token;
    await claim(workerToken);

    const displays = await import('@/app/api/displays/route');
    const paired = await body(
      await displays.POST(ownerPost('/api/displays', { json: { name: 'Wallboard' } })),
    );

    const route = await import('@/app/api/export/route');
    const response = await route.GET(new Request(`${BASE}/api/export`));
    expect(response.status).toBe(200);
    const payload = await body(response);
    const serialised = JSON.stringify(payload);

    expect(payload.version).toBe(3);
    expect(payload.missions[0].graphs.length).toBeGreaterThan(0);
    expect(payload.missions[0].tasks.length).toBeGreaterThan(0);
    expect(payload.playbooks.length).toBeGreaterThanOrEqual(9);
    expect(payload.displays.length).toBe(1);
    expect(payload.ciController.credentialConfigured).toBe(true);

    for (const secret of [
      workerToken,
      paired.token as string,
      'ghp_test_controller_credential_value',
      ENV.SESSION_SECRET,
      ENV.GITHUB_OAUTH_CLIENT_SECRET,
      ENV.CRON_SECRET,
      cookieStore.get(SESSION_COOKIE) ?? 'no-session',
    ]) {
      expect(serialised).not.toContain(secret);
    }
    for (const key of ['tokenHash', 'token_hash', 'accessToken', 'clientSecret', 'privateKey']) {
      expect(serialised).not.toContain(key);
    }
  });
});
