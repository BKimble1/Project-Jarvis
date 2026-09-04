import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { getServices } from '@/server/container';

/**
 * The HTTP layer, exercised through the real route handlers.
 *
 * Everything else in the integration suite calls services directly, which cannot prove the thing
 * this product most needs to be true: that an unauthenticated request is refused *before* it
 * reaches any data. These tests import the shipping handlers and drive them with real `Request`
 * objects, so the guard, the same-origin check and the response shape are the ones deployed.
 *
 * `next/headers` is the only thing replaced. It requires Next's per-request storage, which does
 * not exist outside a server; the fake below is a plain cookie/header store, so the handlers'
 * own logic is untouched.
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
  JARVIS_TEST_AUTH_SECRET: 'test-auth-secret-value-000001',
  JARVIS_AI_ENABLED: 'false',
  LOG_LEVEL: 'error',
};

const SESSION_COOKIE = 'jarvis_session';

/* Imported for its type only; the modules themselves are loaded fresh inside each test. */
type Services = Awaited<ReturnType<typeof getServices>>;

let restoreEnv: Array<[string, string | undefined]> = [];

/* eslint-disable @typescript-eslint/no-explicit-any -- narrowed immediately below. */
type Json = Record<string, any>;
/* eslint-enable @typescript-eslint/no-explicit-any */

async function body(response: Response): Promise<Json> {
  return (await response.json()) as Json;
}

function post(path: string, init: { origin?: string | null; json?: unknown } = {}): Request {
  const headers = new Headers({ 'content-type': 'application/json' });
  if (init.origin !== null) headers.set('origin', init.origin ?? BASE);
  return new Request(`${BASE}${path}`, {
    method: 'POST',
    headers,
    body: init.json === undefined ? undefined : JSON.stringify(init.json),
  });
}

describe('HTTP route handlers', () => {
  let close: () => Promise<void>;
  let services: Services;

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

  /* ------------------------------------------------------------ authentication */

  it('refuses every private endpoint without a session', async () => {
    const [projects, exportRoute, query] = await Promise.all([
      import('@/app/api/projects/route'),
      import('@/app/api/export/route'),
      import('@/app/api/query/route'),
    ]);

    const responses = await Promise.all([
      projects.GET(new Request(`${BASE}/api/projects`)),
      projects.POST(post('/api/projects', { json: { name: 'Sneaky', type: 'software' } })),
      exportRoute.GET(new Request(`${BASE}/api/export`)),
      query.POST(post('/api/query', { json: { query: 'Where are we?' } })),
    ]);

    for (const response of responses) {
      expect(response.status).toBe(401);
      expect((await body(response)).error.code).toBe('unauthorized');
    }
    /* Refusal must happen before anything is written. */
    expect((await services.projects.list()).total).toBe(0);
  });

  it('refuses a session token that has expired', async () => {
    const { token } = await services.sessions.create({
      githubLogin: 'test-owner',
      githubUserId: '4242',
      displayName: 'Test owner',
      avatarUrl: null,
      ttlHours: -1,
    });
    cookieStore.set(SESSION_COOKIE, token);

    const projects = await import('@/app/api/projects/route');
    const response = await projects.GET(new Request(`${BASE}/api/projects`));

    expect(response.status).toBe(401);
    /* The expired row is cleaned up on read rather than left to accumulate. */
    expect(await services.sessions.find(token)).toBeNull();
  });

  it('accepts the owner session and creates a project', async () => {
    await signIn();
    const projects = await import('@/app/api/projects/route');

    const response = await projects.POST(
      post('/api/projects', { json: { name: 'Harbour Lights', type: 'business' } }),
    );

    expect(response.status).toBe(201);
    expect((await body(response)).project.name).toBe('Harbour Lights');
    expect((await services.projects.list()).total).toBe(1);
  });

  /* ------------------------------------------------------------------- CSRF */

  it('rejects a cross-origin write even with a valid session', async () => {
    await signIn();
    const projects = await import('@/app/api/projects/route');

    const response = await projects.POST(
      post('/api/projects', {
        origin: 'https://attacker.example',
        json: { name: 'Cross site', type: 'software' },
      }),
    );

    expect(response.status).toBe(403);
    expect((await body(response)).error.code).toBe('forbidden');
    expect((await services.projects.list()).total).toBe(0);
  });

  it('allows a same-origin write and a request with no Origin header at all', async () => {
    await signIn();
    const projects = await import('@/app/api/projects/route');

    const sameOrigin = await projects.POST(
      post('/api/projects', { origin: BASE, json: { name: 'Same origin', type: 'software' } }),
    );
    /* Non-browser clients (curl, the Netlify function) send no Origin; they are not cross-site. */
    const noOrigin = await projects.POST(
      post('/api/projects', { origin: null, json: { name: 'No origin', type: 'software' } }),
    );

    expect(sameOrigin.status).toBe(201);
    expect(noOrigin.status).toBe(201);
    expect((await services.projects.list()).total).toBe(2);
  });

  /* ----------------------------------------------------------------- export */

  it('exports through the real handler, carrying data but no credential', async () => {
    await signIn();
    const project = await services.projects.create(
      (await import('@/domain/project')).projectInputSchema.parse({
        name: 'Aurora',
        type: 'software',
        goal: 'Ship the first release.',
      }),
    );
    await services.evidence.upsertMany([
      {
        projectId: project.id,
        kind: 'git_commit',
        sourceSystem: 'github',
        externalId: 'abc123',
        title: 'Add the evidence timeline',
        observedAt: new Date().toISOString(),
        metadata: { shortSha: 'abc123' },
      },
    ]);

    /* Secrets that genuinely exist in this instance, so the assertion has something to catch. */
    const { token } = await services.sessions.create({
      githubLogin: 'test-owner',
      githubUserId: '4242',
      displayName: 'Test owner',
      avatarUrl: null,
      ttlHours: 24,
    });
    const oauthState = await services.oauthStates.issue('/dashboard');
    expect(await services.sessions.find(token)).not.toBeNull();

    const exportRoute = await import('@/app/api/export/route');
    const response = await exportRoute.GET(new Request(`${BASE}/api/export`));

    expect(response.status).toBe(200);
    expect(response.headers.get('content-disposition')).toContain('jarvis-export.json');
    expect(response.headers.get('cache-control')).toBe('no-store');

    const payload = await body(response);
    /*
     * Version 4 since Prompt 4B: everything version 3 carried, plus what Jarvis knows — memories,
     * sources, revisions, conflicts and deletion receipts. The version moves whenever the payload
     * genuinely gains top-level keys, which is what makes this assertion useful: it fails when
     * the export grows, forcing whoever grew it to re-read the guarantee below rather than
     * discovering later that something new slipped past it.
     */
    expect(payload.version).toBe(4);
    expect(Array.isArray(payload.missions)).toBe(true);
    expect(Array.isArray(payload.playbooks)).toBe(true);
    expect(Array.isArray(payload.displays)).toBe(true);
    expect(Array.isArray(payload.knowledge.memories)).toBe(true);
    expect(Array.isArray(payload.knowledge.sources)).toBe(true);
    expect(Array.isArray(payload.knowledge.deletionReceipts)).toBe(true);
    expect(payload.projects).toHaveLength(1);
    expect(payload.projects[0].project.name).toBe('Aurora');
    expect(payload.projects[0].evidence[0].title).toBe('Add the evidence timeline');

    /*
     * The guarantee, asserted against the shipping payload rather than a copy of it: no session,
     * no OAuth state and no credential-shaped key or value anywhere in the export.
     */
    const serialised = JSON.stringify(payload);
    for (const forbidden of [
      token,
      oauthState,
      'tokenHash',
      'token_hash',
      'oauthStates',
      'oauth_states',
      'clientSecret',
      'client_secret',
      ENV.SESSION_SECRET,
      ENV.CRON_SECRET,
      ENV.GITHUB_OAUTH_CLIENT_SECRET,
      ENV.JARVIS_TEST_AUTH_SECRET,
    ]) {
      expect(serialised, `export must not contain ${forbidden}`).not.toContain(forbidden);
    }

    /*
     * A value scan can only catch the secrets this test happens to know about; a key scan catches
     * a whole shape of mistake, including one added by a future change to the route.
     */
    const keys = new Set<string>();
    const collectKeys = (value: unknown): void => {
      if (Array.isArray(value)) {
        for (const entry of value) collectKeys(entry);
        return;
      }
      if (value !== null && typeof value === 'object') {
        for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
          keys.add(key);
          collectKeys(nested);
        }
      }
    };
    collectKeys(payload);

    /*
     * Three key names survive the scan, and each one is deliberately *about* a credential rather
     * than being one:
     *
     *  - `credentialConfigured` is a boolean saying whether the CI controller has its own token.
     *  - `tokenPrefix` is the first eight characters of a worker's or display's id, shown so the
     *    owner can tell two devices apart. It is not part of the secret and cannot authenticate.
     *  - `signingSecretNames` is a list of GitHub Actions secret *names*; storing a value there
     *    is refused at the schema.
     *
     * Anything else matching this pattern is a new field that needs thinking about, which is what
     * this assertion is for.
     */
    const ABOUT_A_CREDENTIAL = ['credentialConfigured', 'tokenPrefix', 'signingSecretNames'];
    expect(
      [...keys]
        .filter((key) => /token|secret|session|oauth|password|credential/i.test(key))
        .filter((key) => !ABOUT_A_CREDENTIAL.includes(key))
        .sort(),
    ).toEqual([]);

    /* The route's audit side effect is part of the behaviour, not incidental. */
    const activity = await services.activity.listRecent(20);
    expect(activity.some((entry) => entry.kind === 'data_exported')).toBe(true);
  });

  /* ------------------------------------------------------------- scheduled sync */

  it('closes the scheduled endpoint to anyone without the shared secret', async () => {
    const cron = await import('@/app/api/cron/sync/route');

    const missing = await cron.POST(new Request(`${BASE}/api/cron/sync`, { method: 'POST' }));
    const wrong = await cron.POST(
      new Request(`${BASE}/api/cron/sync`, {
        method: 'POST',
        headers: { 'x-jarvis-cron-secret': 'not-the-secret-000000000000' },
      }),
    );
    /* A signed-in owner session is not a substitute for the shared secret. */
    await signIn();
    const sessionOnly = await cron.POST(new Request(`${BASE}/api/cron/sync`, { method: 'POST' }));

    for (const response of [missing, wrong, sessionOnly]) {
      expect(response.status).toBe(403);
      expect((await body(response)).error.code).toBe('forbidden');
    }
  });

  it('accepts the scheduled endpoint with the shared secret, by header or bearer token', async () => {
    const cron = await import('@/app/api/cron/sync/route');

    const byHeader = await cron.POST(
      new Request(`${BASE}/api/cron/sync`, {
        method: 'POST',
        headers: { 'x-jarvis-cron-secret': ENV.CRON_SECRET as string },
      }),
    );
    const byBearer = await cron.POST(
      new Request(`${BASE}/api/cron/sync`, {
        method: 'POST',
        headers: { authorization: `Bearer ${ENV.CRON_SECRET}` },
      }),
    );

    for (const response of [byHeader, byBearer]) {
      expect(response.status).toBe(200);
      expect((await body(response)).ok).toBe(true);
    }
  });

  /* -------------------------------------------------------------- test auth */

  it('guards the test-auth endpoint and refuses a wrong or missing secret', async () => {
    const testAuth = await import('@/app/api/auth/test/route');

    const missing = await testAuth.POST(new Request(`${BASE}/api/auth/test`, { method: 'POST' }));
    const wrong = await testAuth.POST(
      new Request(`${BASE}/api/auth/test`, {
        method: 'POST',
        headers: { 'x-jarvis-test-secret': 'wrong-secret-value-0000000000' },
      }),
    );

    for (const response of [missing, wrong]) {
      expect(response.status).toBe(403);
      expect((await body(response)).error.code).toBe('forbidden');
    }

    const accepted = await testAuth.POST(
      new Request(`${BASE}/api/auth/test`, {
        method: 'POST',
        headers: { 'x-jarvis-test-secret': ENV.JARVIS_TEST_AUTH_SECRET as string },
      }),
    );
    expect(accepted.status).toBe(200);
    expect(accepted.headers.get('set-cookie')).toContain(`${SESSION_COOKIE}=`);
  });

  it('makes the test-auth endpoint inert when no test secret is configured', async () => {
    process.env.JARVIS_TEST_AUTH_SECRET = '';
    const { resetConfigCache } = await import('@/server/config/env');
    resetConfigCache();

    const testAuth = await import('@/app/api/auth/test/route');
    const response = await testAuth.POST(
      new Request(`${BASE}/api/auth/test`, {
        method: 'POST',
        headers: { 'x-jarvis-test-secret': ENV.JARVIS_TEST_AUTH_SECRET as string },
      }),
    );

    expect(response.status).toBe(403);
  });


  /* ---------------------------------------------------------------- operator */

  describe('standing authority', () => {
    const CHARTER = {
      goals: [{ id: 'g1', statement: 'Keep the invoice work moving', priority: 1 }],
      projectIds: [],
      grants: [{ capability: 'project.status.update', scope: { projects: ['*'] } }],
      limits: {},
      communication: {},
    };

    async function draftAndActivate(): Promise<string> {
      const charter = await import('@/app/api/operator/charter/route');
      const created = await charter.POST(
        post('/api/operator/charter', { json: { content: CHARTER } }),
      );
      expect(created.status).toBe(201);
      const id = (await body(created)).charter.id as string;

      const activate = await import('@/app/api/operator/charter/[id]/activate/route');
      const activated = await activate.POST(
        post(`/api/operator/charter/${id}/activate`),
        { params: Promise.resolve({ id }) },
      );
      expect(activated.status).toBe(200);
      return id;
    }

    it('refuses every operator endpoint without a session', async () => {
      const [operator, charter, mode, decisions] = await Promise.all([
        import('@/app/api/operator/route'),
        import('@/app/api/operator/charter/route'),
        import('@/app/api/operator/mode/route'),
        import('@/app/api/operator/decisions/route'),
      ]);

      const responses = await Promise.all([
        operator.GET(new Request(`${BASE}/api/operator`)),
        charter.POST(post('/api/operator/charter', { json: { content: CHARTER } })),
        mode.POST(post('/api/operator/mode', { json: { mode: 'operator' } })),
        decisions.GET(new Request(`${BASE}/api/operator/decisions`)),
      ]);

      for (const response of responses) {
        expect(response.status).toBe(401);
        expect((await body(response)).error.code).toBe('unauthorized');
      }
    });

    /*
     * A charter is the owner's document, so writing one is a cross-origin-protected owner action
     * like every other write. A CSRF-shaped request that could grant Jarvis capabilities would be
     * the worst possible one to leave open.
     */
    it('refuses a charter written from another origin', async () => {
      await signIn();
      const charter = await import('@/app/api/operator/charter/route');
      const response = await charter.POST(
        post('/api/operator/charter', { json: { content: CHARTER }, origin: 'https://evil.test' }),
      );
      expect(response.status).toBe(403);
    });

    it('saves a charter as a draft that is explicitly not in force', async () => {
      await signIn();
      const charter = await import('@/app/api/operator/charter/route');
      const response = await charter.POST(
        post('/api/operator/charter', { json: { content: CHARTER } }),
      );

      expect(response.status).toBe(201);
      const payload = await body(response);
      expect(payload.inForce).toBe(false);
      expect(payload.message).toContain('authorises nothing until you activate it');

      const operator = await import('@/app/api/operator/route');
      const state = await body(await operator.GET(new Request(`${BASE}/api/operator`)));
      expect(state.charter).toBeNull();
      expect(state.mode.current).toBe('off');
    });

    it('refuses a charter whose grants cannot be honoured as written', async () => {
      await signIn();
      const charter = await import('@/app/api/operator/charter/route');
      const response = await charter.POST(
        post('/api/operator/charter', {
          json: {
            content: {
              ...CHARTER,
              /* `deploy.website` must name its environments; `*` is not an answer. */
              grants: [{ capability: 'deploy.website', scope: { environments: ['*'] } }],
            },
          },
        }),
      );
      expect(response.status).toBe(422);
      expect((await body(response)).error.message).toContain('cannot be honoured');
    });

    /*
     * The one move that stops a person approving each mission needs a typed phrase. It is not a
     * second factor and does not pretend to be — the session already authenticated the owner.
     * It is there so the move cannot be made by a mis-click on a page somebody was skimming.
     */
    it('will not hand over standing authority on a mis-click', async () => {
      await signIn();
      await draftAndActivate();
      const mode = await import('@/app/api/operator/mode/route');

      await mode.POST(post('/api/operator/mode', { json: { mode: 'supervised' } }));
      const unconfirmed = await mode.POST(
        post('/api/operator/mode', { json: { mode: 'operator' } }),
      );
      expect(unconfirmed.status).toBe(422);
      expect((await body(unconfirmed)).error.code).toBe('confirmation_required');

      const confirmed = await mode.POST(
        post('/api/operator/mode', {
          json: { mode: 'operator', confirmation: 'let Jarvis operate on its own' },
        }),
      );
      expect(confirmed.status).toBe(200);
      expect((await body(confirmed)).mode).toBe('operator');
    });

    /* Reaching for the brake must never require typing a sentence first. */
    it('accepts an emergency stop with no ceremony at all', async () => {
      await signIn();
      await draftAndActivate();
      const mode = await import('@/app/api/operator/mode/route');
      await mode.POST(post('/api/operator/mode', { json: { mode: 'supervised' } }));
      await mode.POST(
        post('/api/operator/mode', {
          json: { mode: 'operator', confirmation: 'let Jarvis operate on its own' },
        }),
      );

      const stopped = await mode.POST(
        post('/api/operator/mode', { json: { mode: 'emergency_stop' } }),
      );
      expect(stopped.status).toBe(200);
      expect((await body(stopped)).mode).toBe('emergency_stop');
    });

    it('refuses operator mode with no charter in force', async () => {
      await signIn();
      const mode = await import('@/app/api/operator/mode/route');
      await mode.POST(post('/api/operator/mode', { json: { mode: 'supervised' } }));

      const response = await mode.POST(
        post('/api/operator/mode', {
          json: { mode: 'operator', confirmation: 'let Jarvis operate on its own' },
        }),
      );
      expect(response.status).toBe(409);
      expect((await body(response)).error.message).toContain('without a charter in force');
    });

    /*
     * The three answers stay separate. Operating *and* still refusing to write code is the normal
     * state of a fresh deployment, and an interface that could not say so would read as broken.
     */
    it('reports the mode, the charter and the rung as three separate answers', async () => {
      await signIn();
      await draftAndActivate();
      const mode = await import('@/app/api/operator/mode/route');
      await mode.POST(post('/api/operator/mode', { json: { mode: 'supervised' } }));
      await mode.POST(
        post('/api/operator/mode', {
          json: { mode: 'operator', confirmation: 'let Jarvis operate on its own' },
        }),
      );

      const operator = await import('@/app/api/operator/route');
      const payload = await body(await operator.GET(new Request(`${BASE}/api/operator`)));

      expect(payload.mode.current).toBe('operator');
      expect(payload.charter).not.toBeNull();
      expect(payload.qualification.level).toBe('built');
      expect(payload.standingAuthority).toBe(true);
      expect(Array.isArray(payload.exceptionalActions)).toBe(true);
      expect(JSON.stringify(payload)).not.toMatch(/sk-ant-|gh[pousr]_|-----BEGIN/);
    });

    it('lists refusals, because they are what "why has nothing happened?" reads', async () => {
      await signIn();
      await draftAndActivate();

      await services.charterService.decide({
        missionId: null,
        capabilities: [
          {
            capability: 'marketing.publish',
            projectId: null,
            repository: null,
            branch: null,
            environment: null,
            releaseChannel: null,
            connectorId: null,
            reason: 'wanted to',
          },
        ],
        estimatedSpendUsd: null,
        estimatedMinutes: null,
        parallelAgents: 1,
        exceptional: [],
      });

      const decisions = await import('@/app/api/operator/decisions/route');
      const payload = await body(
        await decisions.GET(new Request(`${BASE}/api/operator/decisions`)),
      );
      expect(payload.decisions).toHaveLength(1);
      expect(payload.decisions[0].outcome).not.toBe('authorized');
      expect(payload.decisions[0].requested).toContain('marketing.publish');
    });
  });

  it('never populates the test-auth secret in production, whatever the environment says', async () => {
    const { buildConfig } = await import('@/server/config/env');
    const production = buildConfig({
      ...ENV,
      NODE_ENV: 'production',
      JARVIS_BASE_URL: 'https://jarvis.example.com',
      DATABASE_URL: 'postgres://user:pw@db.example.com:5432/jarvis',
      JARVIS_DB_DRIVER: 'pg',
      JARVIS_TEST_AUTH_SECRET: 'a-perfectly-valid-looking-secret',
    } as NodeJS.ProcessEnv);

    expect(production.testAuthSecret).toBeNull();
  });
});
