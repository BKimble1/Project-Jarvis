import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { getServices } from '@/server/container';

/**
 * The Ask endpoints, driven through the real shipping handlers.
 *
 * Calling `AnswerService` directly cannot prove the things that matter most about this surface:
 * that an unauthenticated request is refused *before* anything is read, that a wallboard's
 * credential buys nothing here, that a cross-origin write is refused even with a valid session,
 * and that a citation identifier is useless outside the answer that issued it. Those are
 * properties of the handler, so the handler is what runs.
 *
 * `next/headers` is the only thing replaced — it needs Next's per-request storage, which does not
 * exist outside a server. Every other line of every route is the deployed one, including the
 * absence of a configured model: these run in the state a fresh install is in, which is the state
 * most owners will actually meet.
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
  JARVIS_TEST_AUTH_SECRET: 'test-auth-secret-value-000001',
  JARVIS_AI_ENABLED: 'false',
  LOG_LEVEL: 'error',
};

type Services = Awaited<ReturnType<typeof getServices>>;

/* eslint-disable @typescript-eslint/no-explicit-any -- narrowed at each use. */
type Json = Record<string, any>;
/* eslint-enable @typescript-eslint/no-explicit-any */

async function body(response: Response): Promise<Json> {
  return (await response.json()) as Json;
}

function request(
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

const post = (path: string, init: { origin?: string | null; json?: unknown } = {}) =>
  request('POST', path, init);
const get = (path: string) => new Request(`${BASE}${path}`);
const params = <P extends Record<string, string>>(value: P) => ({ params: Promise.resolve(value) });

const CANARY = 'zarquon-http-canary-8842';

describe('Ask HTTP handlers', () => {
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

  async function makeProject(name = 'Alpha'): Promise<string> {
    const { projectInputSchema } = await import('@/domain/project');
    const project = await services.projects.create(
      projectInputSchema.parse({ name, type: 'software' }),
    );
    return project.id;
  }

  /** Ask one question through the real route and hand back the parsed body. */
  async function askOnce(input: Record<string, unknown>): Promise<Json> {
    const route = await import('@/app/api/ask/route');
    const response = await route.POST(post('/api/ask', { json: input }));
    expect(response.status).toBe(201);
    return body(response);
  }

  /* -------------------------------------------------------- authentication */

  it('refuses every Ask endpoint without a session', async () => {
    const [ask, conversations, conversation, answers, cancel, evidence, citation, draft] =
      await Promise.all([
        import('@/app/api/ask/route'),
        import('@/app/api/ask/conversations/route'),
        import('@/app/api/ask/conversations/[id]/route'),
        import('@/app/api/ask/answers/route'),
        import('@/app/api/ask/answers/[id]/cancel/route'),
        import('@/app/api/ask/answers/[id]/evidence/route'),
        import('@/app/api/ask/answers/[id]/citation/route'),
        import('@/app/api/ask/answers/[id]/mission-draft/route'),
      ]);

    const id = '00000000-0000-4000-8000-000000000000';
    const responses = await Promise.all([
      ask.POST(
        post('/api/ask', {
          json: { question: 'Where are we?', idempotencyKey: 'unauth-ask-1' },
        }),
      ),
      conversations.GET(get('/api/ask/conversations')),
      conversations.POST(
        post('/api/ask/conversations', { json: { scope: 'portfolio', projectIds: [] } }),
      ),
      conversation.GET(get(`/api/ask/conversations/${id}`), params({ id })),
      conversation.PATCH(
        request('PATCH', `/api/ask/conversations/${id}`, { json: { title: 'Mine now' } }),
        params({ id }),
      ),
      conversation.DELETE(request('DELETE', `/api/ask/conversations/${id}`), params({ id })),
      answers.GET(get('/api/ask/answers?key=unauth-poll-1')),
      cancel.POST(post(`/api/ask/answers/${id}/cancel`), params({ id })),
      evidence.GET(get(`/api/ask/answers/${id}/evidence`), params({ id })),
      citation.POST(
        post(`/api/ask/answers/${id}/citation`, { json: { ref: `project:${id}` } }),
        params({ id }),
      ),
      draft.POST(
        post(`/api/ask/answers/${id}/mission-draft`, {
          json: { rawRequest: 'Do something substantial for me' },
        }),
        params({ id }),
      ),
    ]);

    for (const response of responses) {
      expect(response.status).toBe(401);
      expect((await body(response)).error.code).toBe('unauthorized');
    }

    /* Refused before anything was written, not after. */
    expect(await services.answerService.listConversations('test-owner')).toHaveLength(0);
    expect(await services.answers.recent(10)).toHaveLength(0);
  });

  it('refuses a cross-origin question even with a valid session', async () => {
    await signIn();
    const route = await import('@/app/api/ask/route');

    const response = await route.POST(
      post('/api/ask', {
        origin: 'https://attacker.example',
        json: { question: 'Where are we?', idempotencyKey: 'cross-origin-1' },
      }),
    );

    expect(response.status).toBe(403);
    expect(await services.answers.recent(10)).toHaveLength(0);
  });

  it('gives a paired wallboard no way in', async () => {
    /*
     * The display credential is a real one, minted through the real pairing route. It is enough
     * to read the wallboard and it must be worth nothing here: Ask is the surface that reaches
     * private notes, and a screen on a kitchen wall is not the owner.
     */
    await signIn();
    const displays = await import('@/app/api/displays/route');
    const paired = await body(
      await displays.POST(post('/api/displays', { json: { name: 'Kitchen tablet' } })),
    );
    const token = paired.token as string;
    expect(token).toMatch(/^jarvisd_/);

    const { DISPLAY_COOKIE_NAME } = await import('@/domain/display-device');
    cookieStore.clear();
    cookieStore.set(DISPLAY_COOKIE_NAME, token);

    const ask = await import('@/app/api/ask/route');
    const response = await ask.POST(
      post('/api/ask', { json: { question: 'Where are we?', idempotencyKey: 'display-token-1' } }),
    );

    expect(response.status).toBe(401);
    expect(await services.answers.recent(10)).toHaveLength(0);
  });

  /* ---------------------------------------------------------------- scope */

  it('refuses a scope that names no project and a project that is not mine', async () => {
    await signIn();
    const conversations = await import('@/app/api/ask/conversations/route');

    const empty = await conversations.POST(
      post('/api/ask/conversations', { json: { scope: 'project', projectIds: [] } }),
    );
    expect(empty.status).toBe(422);
    expect((await body(empty)).error.message).toMatch(/which project/i);

    const foreign = await conversations.POST(
      post('/api/ask/conversations', {
        json: { scope: 'project', projectIds: ['00000000-0000-4000-8000-000000000000'] },
      }),
    );
    expect(foreign.status).toBe(422);

    expect(await services.answerService.listConversations('test-owner')).toHaveLength(0);
  });

  it('refuses a turn that names a project outside the conversation', async () => {
    await signIn();
    const a = await makeProject('Alpha');
    const b = await makeProject('Bravo');

    const conversations = await import('@/app/api/ask/conversations/route');
    const created = await body(
      await conversations.POST(
        post('/api/ask/conversations', { json: { scope: 'project', projectIds: [a] } }),
      ),
    );

    const ask = await import('@/app/api/ask/route');
    const response = await ask.POST(
      post('/api/ask', {
        json: {
          conversationId: created.conversation.id,
          question: 'And the other one?',
          projectIds: [b],
          idempotencyKey: 'widen-turn-1',
        },
      }),
    );

    expect(response.status).toBe(403);
  });

  /* ------------------------------------------------------------- the turn */

  it('answers from evidence, says a model wrote nothing, and can be polled by its key', async () => {
    await signIn();
    const project = await makeProject('Alpha');
    await services.ingestion.addNote({
      kind: 'note',
      title: 'Release process',
      scope: 'project',
      projectId: project,
      sensitivity: 'internal',
      addedBy: 'owner',
      text: `The release process ships from ${CANARY}.`,
    });

    const payload = await askOnce({
      question: 'What is the release process?',
      scope: 'project',
      projectIds: [project],
      idempotencyKey: 'evidence-turn-1',
    });

    expect(payload.answer.mode).toBe('evidence_only');
    expect(payload.answer.modeLabel).toBeTruthy();
    expect(payload.answer.presentable).toBe(true);
    expect(JSON.stringify(payload.answer.claims)).toContain(CANARY);
    /* It is not dressed up as analysis: the mode says plainly what wrote it. */
    expect(payload.answer.limitations.join(' ')).toMatch(/no writing model is configured/i);

    /* The same key polls the state, which is how the interface follows a turn it just sent. */
    const answers = await import('@/app/api/ask/answers/route');
    const polled = await body(await answers.GET(get('/api/ask/answers?key=evidence-turn-1')));
    expect(polled.id).toBe(payload.answer.id);
    expect(polled.state).toBe('complete_with_limitations');
    expect(polled.presentable).toBe(true);

    /* A key belonging to nobody finds nothing rather than somebody else's answer. */
    const missing = await answers.GET(get('/api/ask/answers?key=some-other-key-1'));
    expect(missing.status).toBe(404);
  });

  it('returns the same answer for a repeated request identifier', async () => {
    await signIn();
    const project = await makeProject('Alpha');
    const route = await import('@/app/api/ask/route');

    const turn = {
      question: 'Where are we on Alpha?',
      scope: 'project',
      projectIds: [project],
      idempotencyKey: 'repeat-turn-1',
    };

    const first = await route.POST(post('/api/ask', { json: turn }));
    const second = await route.POST(post('/api/ask', { json: turn }));

    expect(first.status).toBe(201);
    /* 200, not 201: nothing new was created, and the client is told so. */
    expect(second.status).toBe(200);
    const secondBody = await body(second);
    expect(secondBody.reused).toBe(true);
    expect(secondBody.answer.id).toBe((await body(first)).answer.id);
    expect(await services.answers.recent(10)).toHaveLength(1);
  });

  /* ------------------------------------------------------------ citations */

  it('resolves a citation only through the answer that issued it', async () => {
    await signIn();
    const a = await makeProject('Alpha');
    const b = await makeProject('Bravo');

    const answerA = await askOnce({
      question: 'Where are we on Alpha?',
      scope: 'project',
      projectIds: [a],
      idempotencyKey: 'citation-alpha-1',
    });
    const answerB = await askOnce({
      question: 'Where are we on Bravo?',
      scope: 'project',
      projectIds: [b],
      idempotencyKey: 'citation-bravo-1',
    });

    const citation = await import('@/app/api/ask/answers/[id]/citation/route');

    const mine = await citation.POST(
      post(`/api/ask/answers/${answerA.answer.id}/citation`, { json: { ref: `project:${a}` } }),
      params({ id: answerA.answer.id as string }),
    );
    expect(mine.status).toBe(200);
    const resolved = await body(mine);
    expect(resolved.citation.projectId).toBe(a);
    expect(resolved.available).toBe(true);

    /* Bravo's reference, replayed against Alpha's answer. Same 404 as an invented one. */
    const crossed = await citation.POST(
      post(`/api/ask/answers/${answerA.answer.id}/citation`, { json: { ref: `project:${b}` } }),
      params({ id: answerA.answer.id as string }),
    );
    expect(crossed.status).toBe(404);

    const invented = await citation.POST(
      post(`/api/ask/answers/${answerB.answer.id}/citation`, {
        json: { ref: 'source:11111111-1111-4111-8111-111111111111' },
      }),
      params({ id: answerB.answer.id as string }),
    );
    expect(invented.status).toBe(404);
    /* Identical bodies, so the response cannot be used to tell "exists" from "not yours". */
    expect(await body(crossed)).toEqual(await body(invented));
  });

  it('serves the frozen evidence with the revision it was frozen from', async () => {
    await signIn();
    const project = await makeProject('Alpha');
    await services.ingestion.addNote({
      kind: 'note',
      title: 'Release process',
      scope: 'project',
      projectId: project,
      sensitivity: 'internal',
      addedBy: 'owner',
      text: `The release process ships from ${CANARY}.`,
    });

    const answer = await askOnce({
      question: 'What is the release process?',
      scope: 'project',
      projectIds: [project],
      idempotencyKey: 'evidence-route-1',
    });

    const evidence = await import('@/app/api/ask/answers/[id]/evidence/route');
    const response = await evidence.GET(
      get(`/api/ask/answers/${answer.answer.id}/evidence`),
      params({ id: answer.answer.id as string }),
    );
    expect(response.status).toBe(200);

    const payload = await body(response);
    const fromSource = payload.evidence.find((item: Json) => item.origin === 'knowledge_source');
    expect(fromSource).toBeDefined();
    expect(fromSource.excerpt).toContain(CANARY);
    expect(fromSource.revisionId).toBeTruthy();
    expect(fromSource.contentHash).toBeTruthy();
  });

  /* -------------------------------------------------------- conversations */

  it('renames, rescopes and deletes a conversation with everything in it', async () => {
    await signIn();
    const a = await makeProject('Alpha');
    const b = await makeProject('Bravo');

    const conversations = await import('@/app/api/ask/conversations/route');
    const conversation = await import('@/app/api/ask/conversations/[id]/route');

    const created = await body(
      await conversations.POST(
        post('/api/ask/conversations', { json: { scope: 'selected', projectIds: [a, b] } }),
      ),
    );
    const id = created.conversation.id as string;

    await askOnce({
      conversationId: id,
      question: 'Where are we?',
      idempotencyKey: 'conversation-turn-1',
    });

    const renamed = await body(
      await conversation.PATCH(
        request('PATCH', `/api/ask/conversations/${id}`, { json: { title: 'Monday review' } }),
        params({ id }),
      ),
    );
    expect(renamed.conversation.title).toBe('Monday review');

    const rescoped = await body(
      await conversation.PATCH(
        request('PATCH', `/api/ask/conversations/${id}`, {
          json: { scope: 'project', projectIds: [a] },
        }),
        params({ id }),
      ),
    );
    expect(rescoped.conversation.scope).toBe('project');
    expect(rescoped.conversation.projectIds).toEqual([a]);

    const history = await body(
      await conversation.GET(get(`/api/ask/conversations/${id}`), params({ id })),
    );
    expect(history.answers).toHaveLength(1);

    const deleted = await body(
      await conversation.DELETE(request('DELETE', `/api/ask/conversations/${id}`), params({ id })),
    );
    expect(deleted.answersRemoved).toBe(1);
    expect(await services.answers.recent(10)).toHaveLength(0);

    const listed = await body(await conversations.GET(get('/api/ask/conversations')));
    expect(listed.conversations).toHaveLength(0);
  });

  it('refuses to cancel an answer that has already finished', async () => {
    await signIn();
    const project = await makeProject('Alpha');
    const answer = await askOnce({
      question: 'Where are we on Alpha?',
      scope: 'project',
      projectIds: [project],
      idempotencyKey: 'cancel-finished-1',
    });

    const cancel = await import('@/app/api/ask/answers/[id]/cancel/route');
    const response = await cancel.POST(
      post(`/api/ask/answers/${answer.answer.id}/cancel`),
      params({ id: answer.answer.id as string }),
    );

    expect(response.status).toBe(422);
    expect((await body(response)).error.message).toMatch(/already finished|cannot/i);
  });

  /* ------------------------------------------------------- mission drafts */

  it('refuses a mission draft for an answer that proposed nothing', async () => {
    await signIn();
    const project = await makeProject('Alpha');
    const answer = await askOnce({
      question: 'Where are we on Alpha?',
      scope: 'project',
      projectIds: [project],
      idempotencyKey: 'no-suggestion-1',
    });

    const draft = await import('@/app/api/ask/answers/[id]/mission-draft/route');
    const response = await draft.POST(
      post(`/api/ask/answers/${answer.answer.id}/mission-draft`, {
        json: { rawRequest: 'Build the onboarding screen for Alpha' },
      }),
      params({ id: answer.answer.id as string }),
    );

    expect(response.status).toBe(422);
    expect(await services.missions.list({ limit: 10 })).toMatchObject({ items: [] });
  });

  it('turns a proposal into a draft, and a draft is not work', async () => {
    await signIn();
    const project = await makeProject('Alpha');
    const other = await makeProject('Bravo');

    /*
     * A proposal, put there the way a model's would be: through the repository contract the
     * pipeline itself uses. There is no configured model in this environment — that is the point
     * of the evidence-only default — so the precondition is built rather than generated.
     */
    const { run } = await services.answerRuns.begin({
      conversationId: (
        await services.answerService.startConversation(
          { scope: 'project', projectIds: [project] },
          'test-owner',
        )
      ).id,
      question: 'Build the onboarding screen for Alpha',
      scope: 'project',
      projectIds: [project],
      idempotencyKey: 'proposal-seed-1',
      askedBy: 'test-owner',
    });
    await services.answerRuns.transition(run.id, 'validating');
    await services.answerRuns.finish(run.id, {
      state: 'complete',
      mode: 'model_generated',
      method: 'model_synthesised',
      headline: 'Here is what building it would involve.',
      claims: [],
      considered: {
        projectsConsidered: 1,
        evidenceConsidered: 0,
        missionsConsidered: 0,
        knowledgeConsidered: 0,
        sourcesConsidered: 0,
        truncated: false,
        gaps: [],
      },
      limitations: [],
      missionSuggestion: {
        rawRequest: 'Build the onboarding screen',
        projectId: project,
        rationale: 'You asked for it in a question.',
        started: false,
      },
    });

    const draft = await import('@/app/api/ask/answers/[id]/mission-draft/route');

    /* A project the question could not see is refused, however the body is written. */
    const foreign = await draft.POST(
      post(`/api/ask/answers/${run.id}/mission-draft`, {
        json: { rawRequest: 'Build the onboarding screen for Bravo', projectId: other },
      }),
      params({ id: run.id }),
    );
    expect(foreign.status).toBe(403);
    expect((await services.missions.list({ limit: 10 })).items).toHaveLength(0);

    const created = await draft.POST(
      post(`/api/ask/answers/${run.id}/mission-draft`, {
        json: { rawRequest: 'Build the onboarding screen for Alpha' },
      }),
      params({ id: run.id }),
    );
    expect(created.status).toBe(201);

    const payload = await body(created);
    expect(payload.started).toBe(false);
    expect(payload.needsApproval).toBe(true);
    /*
     * Wherever intake puts it — `draft`, or `needs_clarification` when it wants to ask something
     * first — what matters is that it is not a state in which anything runs.
     */
    const { ACTIVE_MISSION_STATES } = await import('@/domain/mission');
    expect(['draft', 'needs_clarification']).toContain(payload.mission.state);
    expect(ACTIVE_MISSION_STATES).not.toContain(payload.mission.state);

    /* And nothing beyond that row exists: no plan, no approval, no run, no branch. */
    const missionId = payload.mission.id as string;
    expect(await services.plans.list(missionId)).toHaveLength(0);
    expect(await services.missionRuns.list(missionId)).toHaveLength(0);
  });

  /* ---------------------------------------------------------------- export */

  it('exports conversations without exporting the evidence a second time', async () => {
    await signIn();
    const project = await makeProject('Alpha');
    await services.ingestion.addNote({
      kind: 'note',
      title: 'Release process',
      scope: 'project',
      projectId: project,
      sensitivity: 'internal',
      addedBy: 'owner',
      text: `The release process ships from ${CANARY}.`,
    });
    await askOnce({
      question: 'What is the release process?',
      scope: 'project',
      projectIds: [project],
      idempotencyKey: 'export-turn-1',
    });

    const exportRoute = await import('@/app/api/export/route');
    const payload = await body(await exportRoute.GET(get('/api/export')));

    expect(payload.conversations).toHaveLength(1);
    const conversation = payload.conversations[0];
    expect(conversation.answers).toHaveLength(1);
    expect(conversation.answers[0].question).toBe('What is the release process?');
    expect(conversation.answers[0].evidenceCount).toBeGreaterThan(0);
    /* Counts, not a second copy of the snapshot. */
    expect(conversation.answers[0].evidence).toBeUndefined();
    /* Token fields survive the export as numbers or nulls, never as strings. */
    expect(conversation.answers[0].inputTokens).toBeNull();
  });
});
