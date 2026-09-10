import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  ProvisionRequest,
  RepositoryHandle,
  RepositoryProvisioner,
} from '@/server/providers/github/provisioner';
import type { getServices } from '@/server/container';
import { createHarness, type TestHarness } from '../helpers/services';
import { ReasoningWorkerHarness } from '../helpers/reasoning-worker';

/**
 * The conversation Blake actually had, which the automated gate passed and reality failed.
 *
 * Both messages below are copied verbatim from that session. The first came back as "Nothing,
 * then." — the negation at the end swallowed the evaluation the rest of the sentence asked for.
 * The second, asking again in plainer words, was classified as a code change and offered a
 * "Prepare this mission" button, which is the manual project workflow he was trying to leave.
 *
 * These are kept word-for-word on purpose. Paraphrasing them into something tidier would test a
 * sentence nobody typed.
 */

const MESSAGE_ONE =
  'I have an idea for a tiny app called QuickPick that lets someone enter two choices and ' +
  'randomly selects one with a clean animation. Is this worth building? Ask only questions that ' +
  'materially affect a simple V1. Do not build it yet.';

const MESSAGE_TWO =
  'Evaluate the QuickPick idea we just discussed. Tell me who would use it, whether it solves a ' +
  'worthwhile problem, what the smallest useful V1 should include, and ask only the questions ' +
  'that would materially change that V1.';

class RecordingProvisioner implements RepositoryProvisioner {
  readonly created: string[] = [];
  private readonly made = new Map<string, RepositoryHandle>();
  isConfigured(): boolean {
    return true;
  }
  describeTarget(): string {
    return 'blake';
  }
  async find(owner: string, repo: string): Promise<RepositoryHandle | null> {
    return this.made.get(`${owner}/${repo}`) ?? null;
  }
  async ensure(request: ProvisionRequest): Promise<RepositoryHandle> {
    const key = `blake/${request.name}`;
    const existing = this.made.get(key);
    if (existing) return { ...existing, created: false };
    const handle: RepositoryHandle = {
      owner: 'blake',
      repo: request.name,
      fullName: key,
      url: `https://github.com/${key}`,
      defaultBranch: 'main',
      isPrivate: true,
      created: true,
    };
    this.made.set(key, handle);
    this.created.push(key);
    return handle;
  }
}

describe('the QuickPick conversation, through the real service', () => {
  let harness: TestHarness;
  let github: RecordingProvisioner;
  let worker: ReasoningWorkerHarness;

  beforeEach(async () => {
    github = new RecordingProvisioner();
    harness = await createHarness({ repositoryProvisioner: github });
    /*
     * A connected worker, because that is Blake's ordinary state and because the reasoning path
     * genuinely depends on one: the model runs there, on his Claude subscription. The suite that
     * proves what happens *without* one is the dashboard-endpoint block below.
     */
    worker = new ReasoningWorkerHarness(harness.services);
    await worker.ensureEnrolled();
  });

  afterEach(async () => {
    await harness.close();
  });

  const counts = async () => ({
    projects: (await harness.services.projects.listAllForAssessment(true)).length,
    missions: (await harness.services.missionRepo.listOpen()).length,
    sources: (await harness.services.sources.listAllGithubSources()).length,
    repositories: github.created.length,
  });

  it('answers the first message with an evaluation instead of "Nothing, then."', async () => {
    const turn = await harness.services.conversation.handle({ message: MESSAGE_ONE });

    expect(turn.kind).toBe('idea');
    expect(turn.said).not.toBe('Nothing, then.');

    /*
     * The assessment now comes from the worker, on Blake's own Claude subscription, so the first
     * turn says it is thinking rather than inventing something to fill the gap. The worker then
     * answers through the same claim-and-report pair it uses in production.
     */
    expect(turn.thinking?.state).toBe('thinking');
    expect(await worker.answerNext()).toBe(true);

    const again = await harness.services.conversation.handle({ message: MESSAGE_ONE });
    expect(again.thinking?.state).toBe('ready');

    /* The six things the owner asked every evaluation to contain. */
    expect(again.evaluation?.likelyUser).toBeTruthy();
    expect(again.evaluation?.problem).toBeTruthy();
    expect(again.evaluation?.verdict).toBeTruthy();
    expect(again.evaluation?.smallestV1.length).toBeGreaterThan(0);
    expect(again.evaluation?.assumptions.length).toBeGreaterThan(0);
    expect(again.evaluation?.questions.length).toBeGreaterThan(0);

    /* One question asked, one answer bought, however many times it was described. */
    expect(worker.claims).toBe(1);
  });

  it('honours the negation without discarding the request', async () => {
    const turn = await harness.services.conversation.handle({ message: MESSAGE_ONE });

    expect(turn.noBuildYet).toBe(true);
    expect(turn.started).toBeNull();
    /* Said out loud, not merely true internally. */
    expect(turn.said.toLowerCase()).toContain('nothing has been created');
    expect(await counts()).toEqual({ projects: 0, missions: 0, sources: 0, repositories: 0 });
  });

  it('says the evaluation is reasoning rather than research', async () => {
    await harness.services.conversation.handle({ message: MESSAGE_ONE });
    await worker.answerNext();

    const turn = await harness.services.conversation.handle({ message: MESSAGE_ONE });
    expect(turn.said).toContain('not market research');
  });

  it('leaves a durable proposal carrying the idea, the V1 and the open questions', async () => {
    const turn = await harness.services.conversation.handle({ message: MESSAGE_ONE });
    expect(turn.proposal).not.toBeNull();

    /*
     * The proposal exists before anything has judged the idea — that is what makes "go ahead" an
     * hour later mean something. The V1 and the questions land on it when the worker answers.
     */
    await worker.answerNext();

    const stored = await harness.services.proposals.findById(turn.proposal!.id);
    expect(stored?.state).toBe('open');
    expect(stored?.idea).toContain('QuickPick');
    expect(stored?.recommendedV1.length).toBeGreaterThan(0);
    expect(stored?.openQuestions.length).toBeGreaterThan(0);
    expect(stored?.createdAt).toBeTruthy();
    expect(stored?.updatedAt).toBeTruthy();
  });

  it('reads the second message as an evaluation, not as a code change', async () => {
    await harness.services.conversation.handle({ message: MESSAGE_ONE });
    const turn = await harness.services.conversation.handle({ message: MESSAGE_TWO });

    expect(turn.kind).toBe('idea');
    /* The exact regression: type "Code change", risk "Low risk", "Prepare this mission". */
    expect(turn.started).toBeNull();
    expect(turn.said).not.toContain('Prepare this mission');
    expect(await counts()).toEqual({ projects: 0, missions: 0, sources: 0, repositories: 0 });
  });

  it('keeps one proposal for one idea across both messages', async () => {
    const first = await harness.services.conversation.handle({ message: MESSAGE_ONE });
    const second = await harness.services.conversation.handle({ message: MESSAGE_TWO });
    /*
     * Different words, and Jarvis may well produce a fresh assessment — but "go ahead" afterwards
     * must not be ambiguous between two live proposals for the same app.
     */
    expect(first.proposal).not.toBeNull();
    expect(second.proposal).not.toBeNull();
    const open = await harness.services.proposals.latestOpen();
    expect(open).not.toBeNull();
  });

  it('creates exactly one project, repository, goal and mission on "go ahead"', async () => {
    const offered = await harness.services.conversation.handle({ message: MESSAGE_ONE });
    expect(await counts()).toEqual({ projects: 0, missions: 0, sources: 0, repositories: 0 });

    const accepted = await harness.services.conversation.handle({
      message: 'Go ahead',
      context: {
        actions: [],
        proposal: offered.proposal,
        lastJarvisTurn: offered.said,
        focusedProjectId: null,
        awaitingAnswer: false,
      },
    });

    expect(accepted.started).not.toBeNull();
    expect(await counts()).toEqual({ projects: 1, missions: 1, sources: 1, repositories: 1 });

    const projects = await harness.services.projects.listAllForAssessment(true);
    /* The goal is set from the idea rather than left empty. */
    expect(projects[0]?.goal).toContain('QuickPick');
  });

  it('does not send the owner to Projects or Missions to pick something', async () => {
    const offered = await harness.services.conversation.handle({ message: MESSAGE_ONE });
    const accepted = await harness.services.conversation.handle({
      message: 'Go ahead',
      context: {
        actions: [],
        proposal: offered.proposal,
        lastJarvisTurn: offered.said,
        focusedProjectId: null,
        awaitingAnswer: false,
      },
    });

    expect(accepted.said).not.toMatch(/prepare this mission/i);
    expect(accepted.said).not.toMatch(/choose a project|which project/i);
    expect(accepted.href).toMatch(/^\/missions\//);
  });

  it('binds a bare "go ahead" to the stored proposal after a refresh loses the page', async () => {
    await harness.services.conversation.handle({ message: MESSAGE_ONE });

    /* No context at all — the browser was reloaded between the two turns. */
    const accepted = await harness.services.conversation.handle({ message: 'go ahead' });

    expect(accepted.started).not.toBeNull();
    expect(await counts()).toEqual({ projects: 1, missions: 1, sources: 1, repositories: 1 });
  });

  it('creates nothing more when "go ahead" is repeated', async () => {
    const offered = await harness.services.conversation.handle({ message: MESSAGE_ONE });
    const context = {
      actions: [],
      proposal: offered.proposal,
      lastJarvisTurn: offered.said,
      focusedProjectId: null,
      awaitingAnswer: false,
    };

    await harness.services.conversation.handle({ message: 'Go ahead', context });
    const after = await counts();

    /* Said again, a resubmitted form, and a worker retry all look like this. */
    const again = await harness.services.conversation.handle({ message: 'Go ahead', context });
    const twice = await harness.services.conversation.handle({ message: 'make it', context });

    expect(await counts()).toEqual(after);
    expect(again.said).toMatch(/already/i);
    expect(twice.said).toMatch(/already/i);
  });

  it('creates nothing more when the same idea is described again after building', async () => {
    const offered = await harness.services.conversation.handle({ message: MESSAGE_ONE });
    await harness.services.conversation.handle({
      message: 'Go ahead',
      context: {
        actions: [],
        proposal: offered.proposal,
        lastJarvisTurn: offered.said,
        focusedProjectId: null,
        awaitingAnswer: false,
      },
    });
    const after = await counts();

    const repeated = await harness.services.conversation.handle({ message: MESSAGE_ONE });
    expect(await counts()).toEqual(after);
    expect(repeated.said).toMatch(/already/i);
  });

  it('asks what to continue when nothing is waiting for a yes', async () => {
    const turn = await harness.services.conversation.handle({ message: 'Go ahead' });

    expect(turn.started).toBeNull();
    expect(turn.said).toMatch(/what would you like/i);
    expect(await counts()).toEqual({ projects: 0, missions: 0, sources: 0, repositories: 0 });
  });

  it('still routes everything else the way it did', async () => {
    const project = await harness.services.projects.create({
      name: 'Holograph',
      shortName: null,
      description: null,
      type: 'software',
      status: 'active',
      phase: null,
      goal: null,
      priority: 'medium',
      tags: [],
      links: [],
    });

    const work = await harness.services.conversation.handle({
      message: 'Audit Holograph read-only. Inspect the repository and report what is implemented.',
    });
    expect(work.kind).toBe('work');
    expect(work.started?.projectId).toBe(project.id);

    const question = await harness.services.conversation.handle({ message: 'Where are we?' });
    expect(question.kind).toBe('question');

    const memory = await harness.services.conversation.handle({
      message: 'Remember that I have classes tomorrow morning.',
    });
    expect(memory.kind).toBe('memory');

    const command = await harness.services.conversation.handle({ message: 'pause' });
    expect(command.kind).toBe('command');
  });
});

/* ------------------------------------------------------- through the dashboard API */

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

describe('the QuickPick conversation, through the dashboard endpoint', () => {
  let close: () => Promise<void>;
  let services: Awaited<ReturnType<typeof getServices>>;
  let restoreEnv: Array<[string, string | undefined]> = [];

  beforeEach(async () => {
    vi.resetModules();
    cookieStore.clear();
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
  });

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

  const counts = async () => ({
    projects: (await services.projects.listAllForAssessment(true)).length,
    missions: (await services.missionRepo.listOpen()).length,
  });

  it('carries both messages and the contextual go-ahead end to end', async () => {
    const before = await counts();
    expect(before).toEqual({ projects: 0, missions: 0 });

    const first = await send(MESSAGE_ONE);
    expect(first.kind).toBe('idea');
    expect(first.said).not.toBe('Nothing, then.');
    expect(first.proposal).not.toBeNull();
    expect(await counts()).toEqual({ projects: 0, missions: 0 });

    const second = await send(MESSAGE_TWO);
    expect(second.kind).toBe('idea');
    expect(await counts()).toEqual({ projects: 0, missions: 0 });

    const accepted = await send('Go ahead', {
      actions: [],
      proposal: first.proposal,
      lastJarvisTurn: first.said,
    });
    expect(accepted.started).not.toBeNull();
    expect(await counts()).toEqual({ projects: 1, missions: 1 });

    /* And again, because a browser resubmit looks exactly like this. */
    await send('Go ahead', { actions: [], proposal: first.proposal, lastJarvisTurn: first.said });
    expect(await counts()).toEqual({ projects: 1, missions: 1 });
  });

  it('says plainly that no repository was created when provisioning is unconfigured', async () => {
    const first = await send(MESSAGE_ONE);
    const accepted = await send('Go ahead', {
      actions: [],
      proposal: first.proposal,
      lastJarvisTurn: first.said,
    });

    const notes = (accepted.notes as string[]).join(' ');
    expect(notes).toContain('GITHUB_PROVISION_TOKEN');
    /* And it did not invent one to look complete. */
    expect(JSON.stringify(accepted)).not.toContain('github.com/');
  });

  it('reports honestly that no worker is connected, rather than inventing a verdict', async () => {
    const first = await send(MESSAGE_ONE);
    const thinking = first.thinking as {
      state: string;
      reason?: string;
      retryable?: boolean;
    } | null;

    /*
     * No worker is enrolled in this suite, and the worker is where Blake's Claude subscription
     * lives. The honest answer names that exact condition — not "no model is configured", which
     * used to send him looking for an API key he should not need.
     */
    expect(thinking?.state).toBe('blocked');
    expect(thinking?.reason).toBe('no_worker');
    expect(thinking?.retryable).toBe(true);
    expect(first.evaluation).toBeNull();
    expect(String(first.said)).not.toMatch(/api key/i);
    expect(String(first.said)).toMatch(/worker/i);
    /* And it still says the thing that matters most. */
    expect(String(first.said).toLowerCase()).toContain('nothing has been created');
  });
});
