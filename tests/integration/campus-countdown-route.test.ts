import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { getServices } from '@/server/container';

/**
 * The CampusCountdown conversation, driven through the deployed `POST /api/conversation`.
 *
 * ## What was measured before this
 *
 * Blake typed two messages. The first, "Build a new private project called CampusCountdown…",
 * produced a project called **Private** on a repository called **private**: the NAMED pattern in
 * `src/domain/new-project.ts` could only end at a joining word or at the end of the whole message,
 * so the full stop after "CampusCountdown" made it fail and the descriptive frame "a new private
 * project" won the name.
 *
 * The second arrived after a reload, which is the case this file exists for. Jarvis had asked
 * "How will you know this is done and right?", and the reply — "Continue work on the existing
 * CampusCountdown project. The definition of done is…" — was read as an ordinary question, handed
 * to the status router and answered "no matching project". The definition of done was discarded
 * and the mission went on waiting.
 *
 * ## Why this is a route test and not a service test
 *
 * A reload is the only way that second message arrives with no conversation context, and what the
 * browser posts after a reload is decided by the route's schema, not by the service: `context` is
 * optional and `awaitingAnswer` defaults to false. A test that called `ConversationService.handle`
 * directly would be choosing that shape for itself and could not fail if the schema started
 * demanding a context. So each test below imports the module Next.js deploys and drives it with a
 * real `Request`, through the real guard, the real same-origin check and the real container.
 *
 * `next/headers` is the only thing replaced — it needs Next's per-request storage, which does not
 * exist outside a server. `assertSameOrigin` reads `x-forwarded-host` from it on every non-GET, so
 * the mock has to supply headers as well as cookies or every POST here fails for an unrelated
 * reason.
 */

/* The two messages, verbatim from the session that failed. Tidying them would test nobody's words. */
const MESSAGE_ONE =
  'Build a new private project called CampusCountdown. Create a countdown board for campus events.';

const MESSAGE_TWO =
  'Continue work on the existing CampusCountdown project. The definition of done is a page that ' +
  'lists each event with a live countdown and updates without a reload.';

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

/** Only the fields these tests read. Narrow on purpose: the wire shape is what is being pinned. */
interface TurnBody {
  readonly kind: string;
  readonly said: string;
  readonly href: string | null;
  readonly answer: unknown;
  readonly started: {
    readonly missionId: string;
    readonly projectId: string | null;
    readonly projectName: string | null;
    readonly planning: boolean;
  } | null;
}

/**
 * The context the browser posts when it has one.
 *
 * `awaitingAnswer: false` is the whole point of it. A reloaded tab has lost the fact that Jarvis
 * had just asked something, so it posts the flag off — and before the fix that flag was the only
 * thing that could admit a reply, which is why the definition of done was thrown away.
 */
const RELOADED_CONTEXT = {
  actions: [],
  proposal: null,
  lastJarvisTurn: null,
  focusedProjectId: null,
  awaitingAnswer: false,
} as const;

describe('the CampusCountdown conversation, through POST /api/conversation', () => {
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

    const { token } = await services.sessions.create({
      githubLogin: 'test-owner',
      githubUserId: '4242',
      displayName: 'Test owner',
      avatarUrl: null,
      ttlHours: 2,
    });
    cookieStore.set(SESSION_COOKIE, token);
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

  /**
   * `context` is omitted from the body entirely when it is undefined, rather than sent as null.
   * That is what a reloaded tab actually posts, and it is the shape the schema has to accept.
   */
  async function post(message: string, context?: unknown): Promise<Response> {
    const { POST } = await import('@/app/api/conversation/route');
    return POST(
      new Request(`${BASE}/api/conversation`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: BASE },
        body: JSON.stringify(context === undefined ? { message } : { message, context }),
      }),
    );
  }

  async function send(message: string, context?: unknown): Promise<TurnBody> {
    const response = await post(message, context);
    expect(response.status, await response.clone().text()).toBe(200);
    return (await response.json()) as TurnBody;
  }

  const counts = async () => ({
    projects: (await services.projects.listAllForAssessment(true)).length,
    missions: (await services.missionRepo.listOpen()).length,
  });

  /**
   * The first message, on its own.
   *
   * "Private" is the exact name the broken NAMED pattern produced, so it is named here rather than
   * only asserting the right one: a future regression that picks the descriptive frame again fails
   * on a sentence that says what went wrong.
   */
  async function buildIt(): Promise<TurnBody> {
    const first = await send(MESSAGE_ONE);
    expect(first.started, first.said).not.toBeNull();
    expect(first.started!.projectName).not.toBe('Private');
    expect(first.started!.projectName).toBe('CampusCountdown');
    /* Not planning yet: it asked its one question first and is waiting on the answer. */
    expect(first.started!.planning).toBe(false);
    return first;
  }

  it('takes the definition of done after a reload, with no context key at all', async () => {
    const first = await buildIt();
    expect(await counts()).toEqual({ projects: 1, missions: 1 });

    const second = await send(MESSAGE_TWO);

    /*
     * The three fields the screen reads. Before the fix this turn carried an `answer` from the
     * status router saying no matching project, `started` null, and an href that was not the
     * mission — which is what the dashboard drew as "Project: not yet chosen" with a "Prepare this
     * mission" button, while the definition of done went nowhere.
     */
    expect(second.started, second.said).not.toBeNull();
    expect(second.started!.planning).toBe(true);
    expect(second.answer).toBeNull();
    expect(second.href).toBe(`/missions/${first.started!.missionId}`);
    expect(second.started!.missionId).toBe(first.started!.missionId);
    /*
     * The whole sentence, because the end of it is load-bearing: the mission title is the owner's
     * own words and keeps its full stop, so dropping it in unstripped gives "I am planning Build a
     * new private project called CampusCountdown. now".
     */
    expect(second.said).toBe(
      'Noted. I am planning Build a new private project called CampusCountdown now, and I will ' +
        'bring you the plan before anything is built.',
    );

    /* And it answered the waiting question rather than starting a second thing to hold it. */
    expect(await counts()).toEqual({ projects: 1, missions: 1 });
  });

  it('takes it when the reloaded tab posts a context with awaitingAnswer false', async () => {
    const first = await buildIt();

    const second = await send(MESSAGE_TWO, RELOADED_CONTEXT);

    /*
     * The same result as with no context at all, and that is the claim. A browser that reloaded may
     * post either shape; the flag being present and false must not be read as "this is not an
     * answer", because the reply names the project and reads as an answer regardless.
     */
    expect(second.started, second.said).not.toBeNull();
    expect(second.started!.planning).toBe(true);
    expect(second.answer).toBeNull();
    expect(second.href).toBe(`/missions/${first.started!.missionId}`);
    expect(await counts()).toEqual({ projects: 1, missions: 1 });
  });

  /**
   * The schema, on its own.
   *
   * `parseBody` turns a schema failure into a `ValidationError`, so a body without `context` that
   * the schema stopped accepting would come back as a 4xx and the reload path would be dead at the
   * door — before any of the behaviour above got a chance to run. Asserting the status separately
   * means that failure is reported as what it is rather than as a mysteriously missing mission.
   */
  it('still accepts a body with no context at all', async () => {
    await buildIt();

    const response = await post(MESSAGE_TWO);
    expect(response.status, await response.clone().text()).toBe(200);

    /*
     * And through the door, not merely past it. The status alone would still pass against the
     * broken build, because the schema was never the part that was wrong — this line is what ties
     * the admissible shape to the message actually being heard.
     */
    const turn = (await response.json()) as TurnBody;
    expect(turn.started, turn.said).not.toBeNull();
  });

  it('records the definition of done against the one mission it already had', async () => {
    await send(MESSAGE_ONE);
    await send(MESSAGE_TWO);

    /* Read back through the services, because the database is what the next reload will show. */
    const open = await services.missionRepo.listOpen();
    expect(open).toHaveLength(1);

    const detail = await services.missions.detail(open[0]!.id);
    expect(detail.mission.state).toBe('awaiting_plan_approval');
    expect(detail.clarifications.filter((record) => record.answeredAt === null)).toHaveLength(0);

    /*
     * The owner's sentence, whole and unedited. `manual` is the flag that says he decided this
     * rather than Jarvis assuming it, so it has to be what he actually wrote — and the second
     * message is what the mission is meant to be judged against.
     */
    expect(detail.clarifications[0]?.answer).toBe(MESSAGE_TWO);
    expect(detail.clarifications[0]?.answerProvenance).toBe('manual');
    expect(detail.mission.acceptanceCriteria).toEqual([MESSAGE_TWO]);

    const projects = await services.projects.listAllForAssessment(true);
    expect(projects).toHaveLength(1);
    expect(projects[0]!.name).toBe('CampusCountdown');
  });
});
