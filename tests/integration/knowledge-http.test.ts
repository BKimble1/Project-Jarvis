import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { getServices } from '@/server/container';

/**
 * The knowledge endpoints, driven through the real shipping handlers.
 *
 * Calling the services directly cannot prove what matters most about this surface: that an
 * unauthenticated request is refused *before* anything is read or written, that a cross-origin
 * write is refused even with a valid session, and that the destructive endpoint refuses without
 * its typed confirmation. Those are properties of the handler, so the handler is what runs here.
 *
 * `next/headers` is the only thing replaced — it needs Next's per-request storage, which does not
 * exist outside a server. Every other line of the route is the deployed one.
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

function post(path: string, init: { origin?: string | null; json?: unknown } = {}): Request {
  const headers = new Headers({ 'content-type': 'application/json' });
  if (init.origin !== null) headers.set('origin', init.origin ?? BASE);
  return new Request(`${BASE}${path}`, {
    method: 'POST',
    headers,
    body: init.json === undefined ? undefined : JSON.stringify(init.json),
  });
}

function upload(
  file: File,
  fields: Record<string, string> = {},
  origin: string | null = BASE,
): Request {
  const form = new FormData();
  form.set('file', file);
  for (const [key, value] of Object.entries(fields)) form.set(key, value);
  const headers = new Headers();
  if (origin !== null) headers.set('origin', origin);
  return new Request(`${BASE}/api/knowledge/upload`, { method: 'POST', headers, body: form });
}

const CANARY = 'quixotic-vellum-canary-4471';

describe('knowledge HTTP handlers', () => {
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

  /* ---------------------------------------------------------- authentication */

  it('refuses every knowledge endpoint without a session', async () => {
    const [sources, memories, search, conflicts, uploadRoute] = await Promise.all([
      import('@/app/api/knowledge/sources/route'),
      import('@/app/api/knowledge/memories/route'),
      import('@/app/api/knowledge/search/route'),
      import('@/app/api/knowledge/conflicts/route'),
      import('@/app/api/knowledge/upload/route'),
    ]);

    const responses = await Promise.all([
      sources.GET(new Request(`${BASE}/api/knowledge/sources`)),
      sources.POST(
        post('/api/knowledge/sources', {
          json: { kind: 'note', title: 'Sneaky', scope: 'global', text: CANARY },
        }),
      ),
      memories.GET(new Request(`${BASE}/api/knowledge/memories`)),
      memories.POST(
        post('/api/knowledge/memories', {
          json: { scope: 'global', category: 'fact', statement: CANARY },
        }),
      ),
      search.POST(post('/api/knowledge/search', { json: { query: 'anything' } })),
      conflicts.GET(new Request(`${BASE}/api/knowledge/conflicts`)),
      uploadRoute.POST(upload(new File(['hello'], 'a.md', { type: 'text/markdown' }))),
    ]);

    for (const response of responses) {
      expect(response.status).toBe(401);
      expect((await body(response)).error.code).toBe('unauthorized');
    }

    /* Refused before anything was written, not after. */
    expect(await services.knowledgeSources.list()).toHaveLength(0);
    expect(await services.knowledge.list()).toHaveLength(0);
  });

  it('refuses a cross-origin write even with a valid session', async () => {
    await signIn();
    const sources = await import('@/app/api/knowledge/sources/route');

    const response = await sources.POST(
      post('/api/knowledge/sources', {
        origin: 'https://attacker.example',
        json: { kind: 'note', title: 'Cross site', scope: 'global', text: CANARY },
      }),
    );

    expect(response.status).toBe(403);
    expect(await services.knowledgeSources.list()).toHaveLength(0);
  });

  it('refuses a cross-origin upload', async () => {
    await signIn();
    const uploadRoute = await import('@/app/api/knowledge/upload/route');

    const response = await uploadRoute.POST(
      upload(
        new File([CANARY], 'notes.md', { type: 'text/markdown' }),
        { title: 'Notes', scope: 'global' },
        'https://attacker.example',
      ),
    );

    expect(response.status).toBe(403);
    expect(await services.knowledgeSources.list()).toHaveLength(0);
  });

  /* ---------------------------------------------------------------- sources */

  it('adds a note and lists it with its ingestion state', async () => {
    await signIn();
    const sources = await import('@/app/api/knowledge/sources/route');

    const created = await sources.POST(
      post('/api/knowledge/sources', {
        json: {
          kind: 'note',
          title: 'Deployment runbook',
          scope: 'global',
          sensitivity: 'internal',
          text: `# Deploy\n\nThe rollback step mentions ${CANARY}.`,
        },
      }),
    );
    expect(created.status).toBe(201);
    const outcome = await body(created);
    expect(outcome.chunkCount).toBeGreaterThan(0);

    const listed = await body(await sources.GET(new Request(`${BASE}/api/knowledge/sources`)));
    expect(listed.sources).toHaveLength(1);
    expect(listed.sources[0].state).toBe('ready');
    expect(listed.sources[0].activeRevision.number).toBe(1);
    expect(listed.sources[0].refreshable).toBe(false);

    /* A listing must never carry the document's text — only counts and classification. */
    expect(JSON.stringify(listed)).not.toContain(CANARY);
  });

  it('never returns a source body through the ordinary read path', async () => {
    await signIn();
    const sources = await import('@/app/api/knowledge/sources/route');
    const detail = await import('@/app/api/knowledge/sources/[id]/route');

    const created = await body(
      await sources.POST(
        post('/api/knowledge/sources', {
          json: {
            kind: 'note',
            title: 'Private notes',
            scope: 'global',
            sensitivity: 'private',
            text: `Secret material: ${CANARY}`,
          },
        }),
      ),
    );

    const response = await detail.GET(
      new Request(`${BASE}/api/knowledge/sources/${created.sourceId}`),
      { params: Promise.resolve({ id: created.sourceId }) },
    );
    const payload = await body(response);

    expect(response.status).toBe(200);
    expect(payload.revisions).toHaveLength(1);
    expect(payload.revisions[0].isActive).toBe(true);
    /* The revision's hash and counts are here. Its text is not, and there is no field for it. */
    expect(JSON.stringify(payload)).not.toContain(CANARY);
  });

  it('refuses a repository source that names no project', async () => {
    await signIn();
    const sources = await import('@/app/api/knowledge/sources/route');

    const response = await sources.POST(
      post('/api/knowledge/sources', {
        json: {
          kind: 'repository_doc',
          title: 'Docs',
          scope: 'project',
          path: 'docs/deploy.md',
        },
      }),
    );

    /*
     * A repository source without a project has no repository to resolve, and the only way to
     * answer "which repository?" would be to take one from the request — which is the escalation
     * the schema refuses.
     */
    expect(response.status).toBe(422);
  });

  it('accepts no repository owner or name from the request body', async () => {
    await signIn();
    const { addSourceSchema } = await import('@/domain/knowledge-source');

    const parsed = addSourceSchema.safeParse({
      kind: 'repository_doc',
      title: 'Docs',
      scope: 'project',
      projectId: '00000000-0000-4000-8000-000000000001',
      path: 'docs/deploy.md',
      owner: 'attacker',
      repo: 'private-repo',
    });

    expect(parsed.success).toBe(true);
    /* Stripped by the schema rather than merely ignored downstream. */
    expect(parsed.success && 'owner' in parsed.data).toBe(false);
    expect(parsed.success && 'repo' in parsed.data).toBe(false);
  });

  it('refuses to refresh something that has no origin to re-read', async () => {
    await signIn();
    const sources = await import('@/app/api/knowledge/sources/route');
    const refresh = await import('@/app/api/knowledge/sources/[id]/refresh/route');

    const created = await body(
      await sources.POST(
        post('/api/knowledge/sources', {
          json: { kind: 'note', title: 'A note', scope: 'global', text: 'Typed in by hand.' },
        }),
      ),
    );

    const response = await refresh.POST(
      post(`/api/knowledge/sources/${created.sourceId}/refresh`),
      { params: Promise.resolve({ id: created.sourceId }) },
    );

    expect(response.status).toBe(422);
  });

  it('deletes a source, removing it from search and leaving a receipt', async () => {
    await signIn();
    const sources = await import('@/app/api/knowledge/sources/route');
    const detail = await import('@/app/api/knowledge/sources/[id]/route');
    const search = await import('@/app/api/knowledge/search/route');

    const created = await body(
      await sources.POST(
        post('/api/knowledge/sources', {
          json: {
            kind: 'note',
            title: 'Temporary',
            scope: 'global',
            text: `This mentions ${CANARY}.`,
          },
        }),
      ),
    );

    const before = await body(
      await search.POST(post('/api/knowledge/search', { json: { query: CANARY } })),
    );
    expect(before.evidence.length).toBeGreaterThan(0);

    const deleted = await detail.DELETE(
      new Request(`${BASE}/api/knowledge/sources/${created.sourceId}`, {
        method: 'DELETE',
        headers: { origin: BASE },
      }),
      { params: Promise.resolve({ id: created.sourceId }) },
    );
    expect(deleted.status).toBe(200);

    const after = await body(
      await search.POST(post('/api/knowledge/search', { json: { query: CANARY } })),
    );
    expect(after.evidence).toHaveLength(0);

    const receipts = await services.deletionReceipts.list(10);
    expect(receipts.some((receipt) => receipt.subjectId === created.sourceId)).toBe(true);
  });

  /* ---------------------------------------------------------------- uploads */

  it('reads an uploaded Markdown file', async () => {
    await signIn();
    const uploadRoute = await import('@/app/api/knowledge/upload/route');

    const response = await uploadRoute.POST(
      upload(
        new File([`# Runbook\n\nThe step mentions ${CANARY}.`], 'runbook.md', {
          type: 'text/markdown',
        }),
        { title: 'Runbook', scope: 'global', sensitivity: 'internal' },
      ),
    );

    expect(response.status).toBe(201);
    expect((await body(response)).chunkCount).toBeGreaterThan(0);
  });

  it('refuses an executable and an archive rather than guessing at them', async () => {
    await signIn();
    const uploadRoute = await import('@/app/api/knowledge/upload/route');

    for (const [name, type] of [
      ['payload.sh', 'application/x-sh'],
      ['payload.zip', 'application/zip'],
      ['payload.exe', 'application/x-msdownload'],
      ['payload.html', 'text/html'],
    ] as const) {
      const response = await uploadRoute.POST(
        upload(new File(['whatever'], name, { type }), { title: name, scope: 'global' }),
      );
      expect(response.status).toBe(422);
    }

    expect(await services.knowledgeSources.list()).toHaveLength(0);
  });

  it('does not trust a filename extension as proof of type', async () => {
    await signIn();
    const uploadRoute = await import('@/app/api/knowledge/upload/route');

    /*
     * Binary content wearing a text name, with the declared type agreeing with the name. Both
     * claims are consistent, so nothing but reading the bytes can catch this — which is the whole
     * point. A PDF, a zip and an ELF binary all arrive as `.md` and all have to be refused.
     */
    const disguises: readonly [string, number[]][] = [
      ['a PDF', [0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x0a]],
      ['a ZIP', [0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00]],
      ['an ELF binary', [0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00]],
      ['a PNG', [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]],
    ];

    for (const [label, bytes] of disguises) {
      const response = await uploadRoute.POST(
        upload(
          new File([new Uint8Array(bytes)], 'notes.md', { type: 'text/markdown' }),
          { title: `Disguised ${label}`, scope: 'global' },
        ),
      );
      expect(response.status, `${label} named .md`).toBe(422);
    }

    /*
     * A refused upload leaves a row in `failed` state, deliberately: an upload that vanishes with
     * no trace is worse than one that says why it was rejected. What it must not leave is
     * content — no chunks, no text, and nothing a search can reach.
     */
    const stored = await services.knowledgeSources.list({ includeDeleted: true });
    expect(stored).toHaveLength(disguises.length);
    for (const source of stored) {
      expect(source.state).toBe('failed');
      expect(source.failureCode).toBe('unsupported_type');
      expect(source.chunkCount).toBe(0);
      expect(await services.knowledgeSources.readBody(source.id)).toBeNull();
    }

    const search = await import('@/app/api/knowledge/search/route');
    const found = await body(
      await search.POST(post('/api/knowledge/search', { json: { query: 'PDF ELF PNG' } })),
    );
    expect(found.evidence).toHaveLength(0);
  });

  it('refuses a file whose declared type and extension disagree', async () => {
    await signIn();
    const uploadRoute = await import('@/app/api/knowledge/upload/route');

    /* A .pdf claiming to be plain text: either a mistake or an attempt, and refused either way. */
    const response = await uploadRoute.POST(
      upload(
        new File(['not really a pdf'], 'report.pdf', { type: 'text/plain' }),
        { title: 'Mismatched', scope: 'global' },
      ),
    );

    expect(response.status).toBe(422);
    /* Refused before a source row was even created: the name and type disagree on their face. */
    expect(await services.knowledgeSources.list({ includeDeleted: true })).toHaveLength(0);
  });

  it('records an upload under the kind its bytes and name agree on, not one the caller chose', async () => {
    await signIn();
    const uploadRoute = await import('@/app/api/knowledge/upload/route');

    await uploadRoute.POST(
      upload(
        new File(['# Real markdown\n\nWith a paragraph.'], 'notes.md', { type: 'text/markdown' }),
        { title: 'Notes', scope: 'global' },
      ),
    );

    const sources = await services.knowledgeSources.list();
    /* The route sends a placeholder kind; the service derives the real one and wins. */
    expect(sources[0]?.kind).toBe('markdown');
  });

  it('sanitises a traversal attempt in a filename', async () => {
    await signIn();
    const uploadRoute = await import('@/app/api/knowledge/upload/route');

    const response = await uploadRoute.POST(
      upload(
        new File(['# Notes\n\nOrdinary content.'], '../../../etc/passwd.md', {
          type: 'text/markdown',
        }),
        { title: 'Traversal', scope: 'global' },
      ),
    );

    expect(response.status).toBe(201);
    const sources = await services.knowledgeSources.list();
    expect(sources[0]?.origin).not.toContain('..');
    expect(sources[0]?.origin).not.toContain('/');
  });

  /* --------------------------------------------------------------- memories */

  it('records an owner memory as explicit and active, with no way to claim another origin', async () => {
    await signIn();
    const memories = await import('@/app/api/knowledge/memories/route');

    const response = await memories.POST(
      post('/api/knowledge/memories', {
        json: {
          scope: 'global',
          category: 'fact',
          statement: `The alarm code note mentions ${CANARY}.`,
          /* Ignored: the schema has no origin field and this route always writes `explicit`. */
          origin: 'system',
          status: 'active',
        },
      }),
    );

    expect(response.status).toBe(201);
    const created = await body(response);
    expect(created.memory.origin).toBe('explicit');
    expect(created.memory.status).toBe('active');
    expect(created.rule).toBe('R-KN1');
  });

  it('refuses to forget without the exact typed confirmation', async () => {
    await signIn();
    const memories = await import('@/app/api/knowledge/memories/route');
    const decision = await import('@/app/api/knowledge/memories/[id]/route');

    const created = await body(
      await memories.POST(
        post('/api/knowledge/memories', {
          json: { scope: 'global', category: 'fact', statement: `Remember ${CANARY}.` },
        }),
      ),
    );
    const id = created.memory.id as string;

    for (const attempt of [{}, { confirmation: '' }, { confirmation: 'yes' }, { confirmation: 'Forget this permanently' }]) {
      const response = await decision.POST(
        post(`/api/knowledge/memories/${id}`, { json: { decision: 'forget', ...attempt } }),
        { params: Promise.resolve({ id }) },
      );
      expect(response.status).toBeGreaterThanOrEqual(400);
    }

    const still = await services.knowledge.findById(id);
    expect(still?.statement).toContain(CANARY);
  });

  it('forgets with the confirmation, and the text is gone from search and export', async () => {
    await signIn();
    const memories = await import('@/app/api/knowledge/memories/route');
    const decision = await import('@/app/api/knowledge/memories/[id]/route');
    const search = await import('@/app/api/knowledge/search/route');
    const exportRoute = await import('@/app/api/export/route');
    const { FORGET_CONFIRMATION } = await import('@/domain/knowledge');

    const created = await body(
      await memories.POST(
        post('/api/knowledge/memories', {
          json: { scope: 'global', category: 'fact', statement: `Remember ${CANARY}.` },
        }),
      ),
    );
    const id = created.memory.id as string;

    const beforeExport = await (await exportRoute.GET(new Request(`${BASE}/api/export`))).text();
    expect(beforeExport).toContain(CANARY);

    const forgotten = await decision.POST(
      post(`/api/knowledge/memories/${id}`, {
        json: { decision: 'forget', confirmation: FORGET_CONFIRMATION },
      }),
      { params: Promise.resolve({ id }) },
    );
    expect(forgotten.status).toBe(200);

    const found = await body(
      await search.POST(post('/api/knowledge/search', { json: { query: CANARY } })),
    );
    expect(found.evidence).toHaveLength(0);

    /* The whole export, as a string. Nothing is allowed to carry it — not even a tombstone. */
    const afterExport = await (await exportRoute.GET(new Request(`${BASE}/api/export`))).text();
    expect(afterExport).not.toContain(CANARY);
    expect(JSON.parse(afterExport).knowledge.forgottenCount).toBe(1);
  });

  it('explains why a memory is remembered, from the record rather than from a model', async () => {
    await signIn();
    const memories = await import('@/app/api/knowledge/memories/route');
    const explain = await import('@/app/api/knowledge/memories/[id]/explain/route');

    const created = await body(
      await memories.POST(
        post('/api/knowledge/memories', {
          json: { scope: 'global', category: 'decision', statement: 'We ship on Tuesdays.' },
        }),
      ),
    );
    const id = created.memory.id as string;

    const payload = await body(
      await explain.GET(new Request(`${BASE}/api/knowledge/memories/${id}/explain`), {
        params: Promise.resolve({ id }),
      }),
    );

    expect(payload.origin.value).toBe('explicit');
    expect(payload.decision.rule).toBe('R-KN1');
    expect(payload.decision.by).toBe('test-owner');
    expect(payload.authority.authoritative).toBe(true);
  });

  /* ----------------------------------------------------------------- search */

  it('reports the retrieval mode honestly rather than calling text search hybrid', async () => {
    await signIn();
    const sources = await import('@/app/api/knowledge/sources/route');
    const search = await import('@/app/api/knowledge/search/route');

    await sources.POST(
      post('/api/knowledge/sources', {
        json: {
          kind: 'note',
          title: 'Runbook',
          scope: 'global',
          text: `The rollback mentions ${CANARY}.`,
        },
      }),
    );

    const payload = await body(
      await search.POST(post('/api/knowledge/search', { json: { query: CANARY } })),
    );

    /* No embedding provider is configured in this environment, and the answer says so. */
    expect(payload.diagnostics.mode).toBe('lexical_only');
    expect(payload.diagnostics.modeLabel).toBe('Full-text only');
    expect(payload.diagnostics.semanticIndex).toBeNull();
    expect(payload.diagnostics.semanticCandidates).toBe(0);
    expect(payload.evidence.length).toBeGreaterThan(0);
  });

  it('gives every result a citation that opens inside Jarvis', async () => {
    await signIn();
    const sources = await import('@/app/api/knowledge/sources/route');
    const search = await import('@/app/api/knowledge/search/route');

    const created = await body(
      await sources.POST(
        post('/api/knowledge/sources', {
          json: {
            kind: 'note',
            title: 'Runbook',
            scope: 'global',
            text: `The rollback mentions ${CANARY}.`,
          },
        }),
      ),
    );

    const payload = await body(
      await search.POST(post('/api/knowledge/search', { json: { query: CANARY } })),
    );

    for (const item of payload.evidence) {
      expect(item.citation.href).toMatch(/^\/knowledge\//);
      /* Never an outbound link: a hostile document cannot get a click routed anywhere it chose. */
      expect(item.citation.href).not.toMatch(/^https?:/);
    }
    expect(payload.evidence[0].citation.sourceId).toBe(created.sourceId);
    expect(payload.evidence[0].citation.revisionId).toBe(created.revisionId);
  });

  it('cannot be widened by the request into a project it did not ask for', async () => {
    await signIn();
    const sources = await import('@/app/api/knowledge/sources/route');
    const search = await import('@/app/api/knowledge/search/route');
    const { projectInputSchema } = await import('@/domain/project');

    const project = await services.projects.create(
      projectInputSchema.parse({ name: 'Client work', type: 'software' }),
    );

    await sources.POST(
      post('/api/knowledge/sources', {
        json: {
          kind: 'note',
          title: 'Client secret',
          scope: 'project',
          projectId: project.id,
          sensitivity: 'private',
          text: `The client's rate is ${CANARY}.`,
        },
      }),
    );

    /*
     * The request tries every field that might widen it: a different audience, a raised ceiling,
     * an extra scope, and a scopes array asking for project material without naming a project.
     * None of them is a field this route reads — the audience comes from the session and the
     * project list is the only thing a caller may narrow with.
     */
    const widened = await body(
      await search.POST(
        post('/api/knowledge/search', {
          json: {
            query: CANARY,
            audience: 'system',
            sensitivityCeiling: 'private',
            scopes: ['global', 'project', 'mission'],
            projectIds: [],
          },
        }),
      ),
    );

    expect(widened.evidence).toHaveLength(0);
    expect(JSON.stringify(widened)).not.toContain(CANARY);

    /* Naming the project is the supported way, and it works — so the check is not blocking all. */
    const narrowed = await body(
      await search.POST(
        post('/api/knowledge/search', { json: { query: CANARY, projectIds: [project.id] } }),
      ),
    );
    expect(narrowed.evidence.length).toBeGreaterThan(0);
  });
});
