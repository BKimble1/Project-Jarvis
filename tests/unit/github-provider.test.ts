import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { RequestError } from '@octokit/request-error';
import { describe, expect, it } from 'vitest';
import type { SourceCapability } from '@/domain/enums';
import { evidenceInputSchema, type EvidenceInput, type EvidenceMetadata } from '@/domain/evidence';
import { createLogger, type Logger } from '@/server/logging/logger';
import {
  assertReadOnlyRequest,
  backoffMs,
  createGithubClient,
  GithubApiError,
  readRateLimit,
  translateGithubError,
  type GithubClient,
} from '@/server/providers/github/client';
import {
  checkRunEvidence,
  commitEvidence,
  deploymentEvidence,
  isMeaningfulCommit,
  issueEvidence,
  normalizeRepository,
  pullRequestEvidence,
  releaseEvidence,
  repositoryEvidence,
  workflowRunEvidence,
  type NormalizeContext,
} from '@/server/providers/github/normalize';
import { GitHubSourceProvider } from '@/server/providers/github/provider';
import type { FetchLimits, SourceSnapshot } from '@/server/providers/types';
import { makeSource } from '../helpers/factories';
import { testConfig } from '../helpers/test-config';

/*
 * The whole suite runs against an injected `fetchImpl`; nothing here opens a socket. Every
 * response body below is shaped like the real GitHub REST payload it stands in for, including
 * the fields the normaliser is allowed to find missing.
 */

const NOW = new Date('2025-06-15T12:00:00.000Z');
const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const SOURCE_ID = '22222222-2222-4222-8222-222222222222';
const HEAD_SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const TOKEN = 'ghp_notarealtokenbutlongenough0123456789';
const RESET_EPOCH_SECONDS = 1_750_000_000;
const RESET_AT = new Date(RESET_EPOCH_SECONDS * 1000).toISOString();

const CONTEXT: NormalizeContext = {
  projectId: PROJECT_ID,
  sourceId: SOURCE_ID,
  fallbackObservedAt: NOW.toISOString(),
};

const LIMITS: FetchLimits = {
  commitLimit: 20,
  prLimit: 10,
  issueLimit: 20,
  workflowLimit: 10,
  releaseLimit: 5,
  deploymentLimit: 5,
  historyDays: 30,
  timeoutMs: 5_000,
};

const RATE_LIMIT_HEADERS: Readonly<Record<string, string>> = {
  'x-ratelimit-limit': '5000',
  'x-ratelimit-remaining': '4987',
  'x-ratelimit-reset': String(RESET_EPOCH_SECONDS),
  'x-ratelimit-resource': 'core',
};

const EXHAUSTED_HEADERS: Readonly<Record<string, string>> = {
  ...RATE_LIMIT_HEADERS,
  'x-ratelimit-remaining': '0',
};

/* ------------------------------------------------------------------ fake GitHub transport */

type RouteKey =
  | 'metadata'
  | 'commits'
  | 'pull_requests'
  | 'issues'
  | 'workflow_runs'
  | 'checks'
  | 'releases'
  | 'deployments'
  | 'deployment_statuses';

type RouteHandler = (url: URL) => Response;

interface FetchCall {
  readonly method: string;
  readonly url: URL;
}

interface FetchStub {
  readonly fetchImpl: typeof fetch;
  readonly calls: FetchCall[];
  readonly paths: () => string[];
}

function routeKey(pathname: string): RouteKey | 'unknown' {
  if (pathname.endsWith('/check-runs')) return 'checks';
  if (/\/deployments\/\d+\/statuses$/.test(pathname)) return 'deployment_statuses';
  if (pathname.endsWith('/deployments')) return 'deployments';
  if (pathname.endsWith('/releases')) return 'releases';
  if (pathname.endsWith('/actions/runs')) return 'workflow_runs';
  if (pathname.endsWith('/issues')) return 'issues';
  if (pathname.endsWith('/pulls')) return 'pull_requests';
  if (pathname.endsWith('/commits')) return 'commits';
  if (/^\/repos\/[^/]+\/[^/]+$/.test(pathname)) return 'metadata';
  return 'unknown';
}

function jsonResponse(
  body: unknown,
  init: { status?: number; headers?: Record<string, string> } = {},
): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: {
      'content-type': 'application/json',
      ...RATE_LIMIT_HEADERS,
      ...(init.headers ?? {}),
    },
  });
}

function errorResponse(
  status: number,
  message: string,
  headers: Record<string, string> = {},
): Response {
  return jsonResponse(
    { message, documentation_url: 'https://docs.github.com/rest' },
    { status, headers },
  );
}

function createFetchStub(overrides: Partial<Record<RouteKey, RouteHandler>> = {}): FetchStub {
  const calls: FetchCall[] = [];
  const routes = { ...healthyRoutes(), ...overrides };

  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(raw);
    calls.push({ method: (init?.method ?? 'GET').toUpperCase(), url });
    const key = routeKey(url.pathname);
    if (key === 'unknown') return errorResponse(404, `Unrouted fixture path ${url.pathname}`);
    const handler = routes[key];
    if (!handler) return errorResponse(404, `No fixture for ${key}`);
    return handler(url);
  }) as typeof fetch;

  return { fetchImpl, calls, paths: () => calls.map((call) => call.url.pathname) };
}

/* ---------------------------------------------------------------------- payload fixtures */

const repositoryPayload = (overrides: Record<string, unknown> = {}) => ({
  id: 987_654,
  name: 'aurora',
  owner: { login: 'test-owner' },
  html_url: 'https://github.com/test-owner/aurora',
  description: 'Evidence-based portfolio brain.',
  visibility: 'private',
  private: true,
  default_branch: 'main',
  archived: false,
  language: 'TypeScript',
  size: 4820,
  open_issues_count: 3,
  stargazers_count: 12,
  forks_count: 1,
  fork: false,
  is_template: false,
  has_issues: true,
  created_at: '2025-01-04T09:00:00Z',
  updated_at: '2025-06-15T09:12:00Z',
  pushed_at: '2025-06-15T10:41:00Z',
  ...overrides,
});

const commitsPayload = () => [
  {
    sha: HEAD_SHA,
    html_url: `https://github.com/test-owner/aurora/commit/${HEAD_SHA}`,
    commit: {
      message: 'Add rate-limit handling to the sync service\n\nKeeps the last-good evidence.',
      author: { name: 'Blake Kimble', date: '2025-06-15T10:40:00Z' },
      committer: { name: 'Blake Kimble', date: '2025-06-15T10:41:00Z' },
    },
    author: { login: 'test-owner' },
    parents: [{ sha: 'cafebabecafebabecafebabecafebabecafebabe' }],
  },
  /* A merge commit restates PR #41, which is already captured as pull-request evidence. */
  {
    sha: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
    html_url: 'https://github.com/test-owner/aurora/commit/deadbeef',
    commit: {
      message: 'Merge pull request #41 from test-owner/normalisation',
      author: { name: 'Blake Kimble', date: '2025-06-14T16:20:00Z' },
      committer: { name: 'GitHub', date: '2025-06-14T16:20:00Z' },
    },
    author: { login: 'test-owner' },
    parents: [{ sha: '1111' }, { sha: '2222' }],
  },
];

const openPullPayload = () => ({
  number: 42,
  title: 'Harden the GitHub provider',
  body: 'Per-category degradation so one missing permission cannot fail a sync.',
  state: 'open',
  draft: false,
  merged_at: null,
  closed_at: null,
  created_at: '2025-06-12T08:00:00Z',
  updated_at: '2025-06-15T09:30:00Z',
  user: { login: 'test-owner' },
  head: { ref: 'harden-provider' },
  base: { ref: 'main' },
  labels: [{ name: 'provider' }, { name: 'reliability' }],
  html_url: 'https://github.com/test-owner/aurora/pull/42',
});

const mergedPullPayload = () => ({
  number: 41,
  title: 'Add evidence normalisation',
  body: null,
  state: 'closed',
  draft: false,
  merged_at: '2025-06-14T16:20:00Z',
  closed_at: '2025-06-14T16:20:00Z',
  created_at: '2025-06-10T11:00:00Z',
  updated_at: '2025-06-14T16:20:00Z',
  user: { login: 'test-owner' },
  head: { ref: 'normalisation' },
  base: { ref: 'main' },
  labels: [],
  html_url: 'https://github.com/test-owner/aurora/pull/41',
});

const issuesPayload = () => [
  {
    number: 40,
    title: 'Document the read-only token scopes',
    body: 'Settings should link to the exact fine-grained permissions.',
    state: 'open',
    closed_at: null,
    created_at: '2025-06-11T14:00:00Z',
    updated_at: '2025-06-13T08:05:00Z',
    user: { login: 'test-owner' },
    comments: 2,
    labels: [{ name: 'docs' }],
    html_url: 'https://github.com/test-owner/aurora/issues/40',
  },
  /* The issues endpoint also returns pull requests; PR #42 must not be counted twice. */
  {
    number: 42,
    title: 'Harden the GitHub provider',
    pull_request: { url: 'https://api.github.com/repos/test-owner/aurora/pulls/42' },
    state: 'open',
    created_at: '2025-06-12T08:00:00Z',
    updated_at: '2025-06-15T09:30:00Z',
    html_url: 'https://github.com/test-owner/aurora/pull/42',
  },
];

const workflowRunsPayload = () => ({
  total_count: 1,
  workflow_runs: [
    {
      id: 55_501,
      name: 'CI',
      display_title: 'Add rate-limit handling to the sync service',
      status: 'completed',
      conclusion: 'success',
      event: 'push',
      head_branch: 'main',
      head_sha: HEAD_SHA,
      run_number: 218,
      run_attempt: 1,
      created_at: '2025-06-15T10:41:10Z',
      run_started_at: '2025-06-15T10:41:20Z',
      updated_at: '2025-06-15T10:47:02Z',
      html_url: 'https://github.com/test-owner/aurora/actions/runs/55501',
    },
  ],
});

const checkRunsPayload = () => ({
  total_count: 1,
  check_runs: [
    {
      id: 91_001,
      name: 'unit',
      status: 'completed',
      conclusion: 'success',
      head_sha: HEAD_SHA,
      started_at: '2025-06-15T10:41:30Z',
      completed_at: '2025-06-15T10:46:00Z',
      output: { title: '128 tests passed' },
      html_url: 'https://github.com/test-owner/aurora/runs/91001',
    },
  ],
});

const releasesPayload = () => [
  {
    id: 7001,
    name: 'v0.3.0',
    tag_name: 'v0.3.0',
    body: 'Evidence normalisation and per-category degradation.',
    draft: false,
    prerelease: false,
    author: { login: 'test-owner' },
    created_at: '2025-06-10T11:30:00Z',
    published_at: '2025-06-10T12:00:00Z',
    html_url: 'https://github.com/test-owner/aurora/releases/tag/v0.3.0',
  },
];

const deploymentsPayload = () => [
  {
    id: 3301,
    environment: 'production',
    description: 'Netlify production deploy',
    ref: 'main',
    sha: HEAD_SHA,
    creator: { login: 'test-owner' },
    created_at: '2025-06-15T10:50:00Z',
    updated_at: '2025-06-15T10:58:00Z',
    url: 'https://api.github.com/repos/test-owner/aurora/deployments/3301',
  },
];

const deploymentStatusesPayload = () => [
  {
    id: 44_001,
    state: 'success',
    target_url: 'https://aurora.example.com/deploys/3301',
    created_at: '2025-06-15T10:58:00Z',
  },
];

function healthyRoutes(): Record<RouteKey, RouteHandler> {
  return {
    metadata: () => jsonResponse(repositoryPayload()),
    commits: () => jsonResponse(commitsPayload()),
    pull_requests: (url) =>
      jsonResponse(
        url.searchParams.get('state') === 'open' ? [openPullPayload()] : [mergedPullPayload()],
      ),
    issues: () => jsonResponse(issuesPayload()),
    workflow_runs: () => jsonResponse(workflowRunsPayload()),
    checks: () => jsonResponse(checkRunsPayload()),
    releases: () => jsonResponse(releasesPayload()),
    deployments: () => jsonResponse(deploymentsPayload()),
    deployment_statuses: () => jsonResponse(deploymentStatusesPayload()),
  };
}

/* ------------------------------------------------------------------------- test helpers */

function createClient(
  fetchImpl: typeof fetch,
  options: { maxRetries?: number; timeoutMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): GithubClient {
  return createGithubClient({
    token: TOKEN,
    baseUrl: 'https://api.github.com',
    timeoutMs: options.timeoutMs ?? 5_000,
    fetchImpl,
    maxRetries: options.maxRetries ?? 0,
    sleep: options.sleep ?? (async () => {}),
  });
}

interface OctokitRequestWithDefaults {
  readonly endpoint: {
    readonly DEFAULTS: { readonly request?: { readonly fetch?: typeof fetch } };
  };
}

/** The read-only wrapper the client installs on Octokit, reached without going through Octokit. */
function readOnlyFetchOf(client: GithubClient): typeof fetch {
  const request = client.octokit.request as unknown as OctokitRequestWithDefaults;
  const injected = request.endpoint.DEFAULTS.request?.fetch;
  if (!injected) throw new Error('The client did not install its read-only fetch wrapper.');
  return injected;
}

function capturingLogger(lines: string[]): Logger {
  return createLogger({ level: 'debug', sink: (line) => lines.push(line) });
}

function makeProvider(client: GithubClient, lines: string[] = []): GitHubSourceProvider {
  return new GitHubSourceProvider({
    config: testConfig(),
    logger: capturingLogger(lines),
    clientFactory: () => client,
  });
}

async function snapshotFor(
  stub: FetchStub,
  overrides: { owner?: string; repo?: string } = {},
  lines: string[] = [],
): Promise<SourceSnapshot> {
  const provider = makeProvider(createClient(stub.fetchImpl), lines);
  const source = makeSource({
    id: SOURCE_ID,
    projectId: PROJECT_ID,
    github: {
      repoId: 987_654,
      owner: overrides.owner ?? 'test-owner',
      repo: overrides.repo ?? 'aurora',
      url: 'https://github.com/test-owner/aurora',
      visibility: 'private',
      defaultBranch: 'main',
      archived: false,
      primaryLanguage: 'TypeScript',
      lastActivityAt: '2025-06-14T10:00:00.000Z',
    },
  });
  return provider.fetchSnapshot(source, {
    projectId: PROJECT_ID,
    sourceId: SOURCE_ID,
    now: NOW,
    limits: LIMITS,
  });
}

function countByKind(evidence: readonly EvidenceInput[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of evidence) counts[item.kind] = (counts[item.kind] ?? 0) + 1;
  return counts;
}

function metadataShapes(metadata: EvidenceMetadata): string[] {
  return Object.entries(metadata).map(([key, value]) => {
    if (Array.isArray(value)) return `${key}:array`;
    if (value === null) return `${key}:null`;
    return `${key}:${typeof value}`;
  });
}

function requestErrorWith(
  status: number,
  message: string,
  headers: Record<string, string> | null = null,
): RequestError {
  const request = {
    method: 'GET' as const,
    url: 'https://api.github.com/repos/test-owner/aurora',
    headers: { authorization: `token ${TOKEN}`, 'user-agent': 'jarvis-project-registry' },
  };
  if (headers === null) return new RequestError(message, status, { request });
  return new RequestError(message, status, {
    request,
    response: { url: request.url, status, headers, data: { message } },
  });
}

/* ============================================================== read-only guarantee */

describe('read-only guarantee', () => {
  it.each(['GET', 'HEAD', 'get', 'head'])('permits the read method %s', (method) => {
    expect(() =>
      assertReadOnlyRequest(method, 'https://api.github.com/repos/test-owner/aurora'),
    ).not.toThrow();
  });

  it.each(['POST', 'PUT', 'PATCH', 'DELETE'])('refuses the write method %s', (method) => {
    let caught: unknown;
    try {
      assertReadOnlyRequest(method, 'https://api.github.com/repos/test-owner/aurora/issues');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(GithubApiError);
    const error = caught as GithubApiError;
    expect(error.kind).toBe('write_attempt');
    expect(error.code).toBe('upstream_forbidden');
    expect(error.message).toBe(
      `Jarvis is read-only: refused a ${method} request to GitHub ` +
        '(https://api.github.com/repos/test-owner/aurora/issues).',
    );
  });

  it('redacts the query string of a refused request so a credential cannot leak', () => {
    let caught: unknown;
    try {
      assertReadOnlyRequest('POST', `https://api.github.com/repos/o/r?access_token=${TOKEN}`);
    } catch (error) {
      caught = error;
    }
    expect((caught as GithubApiError).message).toContain('https://api.github.com/repos/o/r)');
    expect((caught as GithubApiError).message).not.toContain(TOKEN);
  });

  it('rejects a non-GET request before the transport is ever reached', async () => {
    const stub = createFetchStub();
    const client = createClient(stub.fetchImpl);
    const send = readOnlyFetchOf(client);

    await expect(
      send('https://api.github.com/repos/test-owner/aurora/issues', {
        method: 'POST',
        body: JSON.stringify({ title: 'nope' }),
      }),
    ).rejects.toBeInstanceOf(GithubApiError);
    expect(stub.calls).toHaveLength(0);

    /* The same wrapper must still let reads through, or the guard would be vacuous. */
    const response = await send('https://api.github.com/repos/test-owner/aurora');
    expect(response.status).toBe(200);
    expect(stub.paths()).toEqual(['/repos/test-owner/aurora']);
  });

  it('translates a refused write into the write_attempt taxonomy unchanged', () => {
    const refusal = new GithubApiError('write_attempt', 'Jarvis is read-only.');
    expect(translateGithubError(refusal, null)).toBe(refusal);
  });

  /*
   * A behavioural test cannot prove this: the fake transport would happily answer a mutating
   * call added through some future code path that bypasses `createGithubClient`. So the source
   * of the provider itself is read and every Octokit endpoint it names is checked to be a
   * `get*`/`list*` reader, with no create/update/delete/merge/dispatch call anywhere.
   */
  it('contains no mutating Octokit call in its source', () => {
    const providerPath = fileURLToPath(
      new URL('../../src/server/providers/github/provider.ts', import.meta.url),
    );
    const source = readFileSync(providerPath, 'utf8');
    const endpoints = [...source.matchAll(/octokit\.rest\.([A-Za-z0-9_]+)\.([A-Za-z0-9_]+)/g)].map(
      (match) => `${match[1]}.${match[2]}`,
    );

    expect(endpoints.length).toBeGreaterThan(0);
    expect(
      endpoints.filter((name) => /\.(create|update|delete|merge|dispatch)/i.test(name)),
    ).toEqual([]);
    expect(endpoints.filter((name) => !/\.(get|list)[A-Z]?/.test(name))).toEqual([]);
    expect([...new Set(endpoints)].sort()).toEqual([
      'actions.listWorkflowRunsForRepo',
      'checks.listForRef',
      'issues.listForRepo',
      'pulls.list',
      'repos.get',
      'repos.listCommits',
      'repos.listDeploymentStatuses',
      'repos.listDeployments',
      'repos.listForAuthenticatedUser',
      'repos.listReleases',
      'users.getAuthenticated',
    ]);
  });
});

/* ================================================================== error translation */

describe('translateGithubError', () => {
  it('maps 401 to unauthorized without echoing the credential', () => {
    const translated = translateGithubError(
      requestErrorWith(401, 'Bad credentials', RATE_LIMIT_HEADERS),
      null,
    );
    expect(translated.kind).toBe('unauthorized');
    expect(translated.code).toBe('upstream_forbidden');
    expect(translated.message).toBe(
      'GitHub rejected the credential. It may have been revoked or expired.',
    );
    expect(translated.message).not.toContain(TOKEN);
    expect(translated.retryable).toBe(false);
  });

  it('maps 403 with an exhausted quota to rate_limited and carries the reset time', () => {
    const translated = translateGithubError(
      requestErrorWith(403, 'API rate limit exceeded for user ID 4242.', EXHAUSTED_HEADERS),
      null,
    );
    expect(translated.kind).toBe('rate_limited');
    expect(translated.code).toBe('rate_limited');
    expect(translated.message).toBe(
      'GitHub rate limit reached. Jarvis kept the data it already had.',
    );
    expect(translated.rateLimit).toEqual({
      limit: 5000,
      remaining: 0,
      resetAt: RESET_AT,
      resource: 'core',
    });
  });

  it('maps 403 with quota remaining to forbidden', () => {
    const translated = translateGithubError(
      requestErrorWith(403, 'Resource not accessible by personal access token', RATE_LIMIT_HEADERS),
      null,
    );
    expect(translated.kind).toBe('forbidden');
    expect(translated.message).toBe('The credential does not have permission for this data.');
    expect(translated.rateLimit?.remaining).toBe(4987);
  });

  it('falls back to the client rate-limit state when the failure carried no headers', () => {
    const translated = translateGithubError(requestErrorWith(403, 'Forbidden', null), {
      limit: 5000,
      remaining: 0,
      resetAt: RESET_AT,
      resource: 'core',
    });
    expect(translated.kind).toBe('rate_limited');
  });

  it('maps 404 to not_found and explains the rename case', () => {
    const translated = translateGithubError(requestErrorWith(404, 'Not Found', {}), null);
    expect(translated.kind).toBe('not_found');
    expect(translated.code).toBe('upstream_not_found');
    expect(translated.message).toContain('renamed, deleted, or is outside');
  });

  it('maps 409 to empty_repository', () => {
    const translated = translateGithubError(
      requestErrorWith(409, 'Git Repository is empty.', {}),
      null,
    );
    expect(translated.kind).toBe('empty_repository');
    expect(translated.message).toBe('The repository has no commits yet.');
  });

  it('maps 5xx to a retryable unavailable', () => {
    const translated = translateGithubError(requestErrorWith(500, 'Server Error', {}), null);
    expect(translated.kind).toBe('unavailable');
    expect(translated.code).toBe('upstream_unavailable');
    expect(translated.retryable).toBe(true);
    expect(translated.message).toBe('GitHub is currently unavailable.');
  });

  it('maps an unexpected 4xx to unavailable with the status only', () => {
    const translated = translateGithubError(requestErrorWith(422, 'Unprocessable', {}), null);
    expect(translated.kind).toBe('unavailable');
    expect(translated.message).toBe('GitHub request failed (status 422).');
  });

  it('maps an AbortError to a retryable timeout', () => {
    const aborted = new Error('The operation was aborted.');
    aborted.name = 'AbortError';
    const translated = translateGithubError(aborted, null);
    expect(translated.kind).toBe('timeout');
    expect(translated.code).toBe('timeout');
    expect(translated.retryable).toBe(true);
  });

  it('maps an unrecognised throw to unavailable rather than leaking it', () => {
    const translated = translateGithubError(
      { secret: `Bearer ${TOKEN}` },
      { limit: 5000, remaining: 10, resetAt: RESET_AT, resource: 'core' },
    );
    expect(translated.kind).toBe('unavailable');
    expect(translated.message).toBe('Could not reach GitHub.');
    expect(translated.message).not.toContain(TOKEN);
    expect(translated.rateLimit?.remaining).toBe(10);
  });
});

/* ======================================================================== rate limits */

describe('readRateLimit', () => {
  it('parses a Headers instance', () => {
    expect(readRateLimit(new Headers(RATE_LIMIT_HEADERS))).toEqual({
      limit: 5000,
      remaining: 4987,
      resetAt: RESET_AT,
      resource: 'core',
    });
  });

  it('parses a plain header record, including numeric values and a zero remaining', () => {
    expect(
      readRateLimit({
        'x-ratelimit-limit': 5000,
        'x-ratelimit-remaining': 0,
        'x-ratelimit-reset': RESET_EPOCH_SECONDS,
      }),
    ).toEqual({ limit: 5000, remaining: 0, resetAt: RESET_AT, resource: null });
  });

  it('keeps the fields it can parse and nulls the ones it cannot', () => {
    expect(
      readRateLimit({ 'x-ratelimit-limit': 'unknown', 'x-ratelimit-remaining': '12' }),
    ).toEqual({
      limit: null,
      remaining: 12,
      resetAt: null,
      resource: null,
    });
  });

  it('returns null when no quota header is present', () => {
    expect(readRateLimit(new Headers())).toBeNull();
    expect(readRateLimit({})).toBeNull();
    /* The resource name alone says nothing about the quota, so there is no state to report. */
    expect(readRateLimit({ 'x-ratelimit-resource': 'search' })).toBeNull();
  });
});

describe('backoffMs', () => {
  it.each([
    [0, 250],
    [1, 500],
    [2, 1000],
    [4, 4000],
    [9, 4000],
  ])('waits %i attempts in gives %ims', (attempt, expected) => {
    expect(backoffMs(attempt)).toBe(expected);
  });
});

/* =================================================================== retries & timeout */

describe('createGithubClient transport', () => {
  it('retries a 500 once and succeeds on the second attempt', async () => {
    const sleeps: number[] = [];
    let attempts = 0;
    const fetchImpl = (async () => {
      attempts += 1;
      return attempts === 1
        ? errorResponse(500, 'Server Error')
        : jsonResponse(repositoryPayload());
    }) as typeof fetch;

    const client = createClient(fetchImpl, {
      maxRetries: 1,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    const response = await client.octokit.rest.repos.get({ owner: 'test-owner', repo: 'aurora' });

    expect(response.status).toBe(200);
    expect(response.data.name).toBe('aurora');
    expect(attempts).toBe(2);
    expect(sleeps).toEqual([backoffMs(0)]);
    expect(client.rateLimit()).toEqual({
      limit: 5000,
      remaining: 4987,
      resetAt: RESET_AT,
      resource: 'core',
    });
  });

  it('gives up after the retry budget and reports an unavailable upstream', async () => {
    let attempts = 0;
    const fetchImpl = (async () => {
      attempts += 1;
      return errorResponse(500, 'Server Error');
    }) as typeof fetch;

    const client = createClient(fetchImpl, { maxRetries: 1 });
    let caught: unknown;
    try {
      await client.octokit.rest.repos.get({ owner: 'test-owner', repo: 'aurora' });
    } catch (error) {
      caught = error;
    }

    expect(attempts).toBe(2);
    expect(caught).toBeInstanceOf(RequestError);
    const translated = translateGithubError(caught, client.rateLimit());
    expect(translated.kind).toBe('unavailable');
    expect(translated.retryable).toBe(true);
  });

  it('turns an aborted request into a timeout GithubApiError', async () => {
    const fetchImpl = ((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const aborted = new Error('This operation was aborted');
          aborted.name = 'AbortError';
          reject(aborted);
        });
      })) as typeof fetch;

    const client = createClient(fetchImpl, { maxRetries: 0, timeoutMs: 1 });
    let caught: unknown;
    try {
      await readOnlyFetchOf(client)('https://api.github.com/repos/test-owner/aurora');
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(GithubApiError);
    const error = caught as GithubApiError;
    expect(error.kind).toBe('timeout');
    expect(error.code).toBe('timeout');
    expect(error.retryable).toBe(true);
    expect(error.message).toBe('GitHub did not respond in time.');
  });
});

/* ======================================================================= normalisation */

describe('normalizeRepository', () => {
  it('returns null without an owner or a name', () => {
    expect(normalizeRepository({ name: 'aurora' })).toBeNull();
    expect(normalizeRepository({ owner: { login: 'test-owner' } })).toBeNull();
    expect(normalizeRepository(null)).toBeNull();
  });

  it('normalises a complete payload', () => {
    expect(normalizeRepository(repositoryPayload())).toEqual({
      repoId: 987_654,
      owner: 'test-owner',
      repo: 'aurora',
      url: 'https://github.com/test-owner/aurora',
      visibility: 'private',
      defaultBranch: 'main',
      archived: false,
      primaryLanguage: 'TypeScript',
      lastActivityAt: '2025-06-15T10:41:00.000Z',
    });
  });

  it.each([
    [true, 'private'],
    [false, 'public'],
  ])('derives visibility from private=%s when the field is absent', (isPrivate, expected) => {
    const state = normalizeRepository(
      repositoryPayload({ visibility: undefined, private: isPrivate }),
    );
    expect(state?.visibility).toBe(expected);
  });

  it('leaves visibility unknown when neither field is usable', () => {
    const state = normalizeRepository({ name: 'aurora', owner: { login: 'test-owner' } });
    expect(state?.visibility).toBeNull();
    /* No html_url either — the canonical URL is still derivable from the coordinates. */
    expect(state?.url).toBe('https://github.com/test-owner/aurora');
    expect(state?.archived).toBe(false);
    expect(state?.repoId).toBeNull();
  });

  it('falls back to updated_at when pushed_at is missing, then to nothing at all', () => {
    const withUpdate = normalizeRepository(repositoryPayload({ pushed_at: undefined }));
    expect(withUpdate?.lastActivityAt).toBe('2025-06-15T09:12:00.000Z');

    const withNeither = normalizeRepository(
      repositoryPayload({ pushed_at: null, updated_at: 'not-a-date' }),
    );
    expect(withNeither?.lastActivityAt).toBeNull();
  });

  it('preserves an explicit internal visibility', () => {
    const state = normalizeRepository(repositoryPayload({ visibility: 'internal' }));
    expect(state?.visibility).toBe('internal');
  });
});

describe('isMeaningfulCommit', () => {
  it.each([
    ['Merge pull request #41 from test-owner/normalisation', false],
    ["Merge branch 'main' into harden-provider", false],
    ['Merge remote-tracking branch upstream/main', false],
    ['Add rate-limit handling to the sync service', true],
    /* Only the mechanical merge subjects are noise; a commit about merging is real work. */
    ['Merge the two configuration loaders into one', true],
    ['', false],
  ])('classifies %j as meaningful=%s', (message, expected) => {
    expect(isMeaningfulCommit(message)).toBe(expected);
  });

  it('treats a missing message as not meaningful', () => {
    expect(isMeaningfulCommit(null)).toBe(false);
  });
});

describe('evidence normalisation', () => {
  it('returns null when the provider identifier is missing', () => {
    expect(commitEvidence({ commit: { message: 'no sha' } }, CONTEXT)).toBeNull();
    expect(pullRequestEvidence({ title: 'no number' }, CONTEXT)).toBeNull();
    expect(issueEvidence({ title: 'no number' }, CONTEXT)).toBeNull();
    expect(workflowRunEvidence({ name: 'CI' }, CONTEXT)).toBeNull();
    expect(checkRunEvidence({ name: 'unit' }, CONTEXT)).toBeNull();
    expect(releaseEvidence({ tag_name: 'v0.3.0' }, CONTEXT)).toBeNull();
    expect(deploymentEvidence({ environment: 'production' }, null, CONTEXT)).toBeNull();
  });

  it('produces a schema-valid commit record and splits subject from body', () => {
    const evidence = commitEvidence(commitsPayload()[0], CONTEXT);
    expect(evidence).not.toBeNull();
    const parsed = evidenceInputSchema.parse(evidence);

    expect(parsed.kind).toBe('git_commit');
    expect(parsed.sourceSystem).toBe('github');
    expect(parsed.externalId).toBe(HEAD_SHA);
    expect(parsed.title).toBe('Add rate-limit handling to the sync service');
    expect(parsed.summary).toContain('Keeps the last-good evidence.');
    expect(parsed.observedAt).toBe('2025-06-15T10:40:00.000Z');
    expect(parsed.metadata).toMatchObject({
      sha: HEAD_SHA,
      shortSha: 'a1b2c3d',
      authorName: 'Blake Kimble',
      authorLogin: 'test-owner',
      isMerge: false,
    });
  });

  it('falls back to the committer date, then to the fetch time', () => {
    const committerOnly = commitEvidence(
      { sha: HEAD_SHA, commit: { message: 'x', committer: { date: '2025-06-01T00:00:00Z' } } },
      CONTEXT,
    );
    expect(committerOnly?.observedAt).toBe('2025-06-01T00:00:00.000Z');

    const bare = commitEvidence({ sha: HEAD_SHA }, CONTEXT);
    expect(bare?.observedAt).toBe(CONTEXT.fallbackObservedAt);
    /* With no message at all the short SHA is the only honest title. */
    expect(bare?.title).toBe('a1b2c3d');
    expect(bare?.summary).toBeNull();
  });

  it('labels a merged pull request as merged and dates it by the merge', () => {
    const evidence = pullRequestEvidence(mergedPullPayload(), CONTEXT);
    const parsed = evidenceInputSchema.parse(evidence);

    expect(parsed.externalId).toBe('pr:41');
    expect(parsed.title).toBe('#41 Add evidence normalisation');
    expect(parsed.observedAt).toBe('2025-06-14T16:20:00.000Z');
    expect(parsed.metadata).toMatchObject({
      number: 41,
      state: 'merged',
      merged: true,
      draft: false,
      headRef: 'normalisation',
      baseRef: 'main',
      labels: [],
    });
  });

  it('keeps an open pull request open and collects its label names', () => {
    const evidence = pullRequestEvidence(openPullPayload(), CONTEXT);
    expect(evidence?.metadata.state).toBe('open');
    expect(evidence?.metadata.merged).toBe(false);
    expect(evidence?.metadata.labels).toEqual(['provider', 'reliability']);
  });

  it('names an untitled pull request rather than dropping it', () => {
    const evidence = pullRequestEvidence({ number: 7 }, CONTEXT);
    expect(evidence?.title).toBe('#7 Untitled pull request');
    expect(evidence?.observedAt).toBe(CONTEXT.fallbackObservedAt);
  });

  it('rejects an issues-endpoint row that is really a pull request', () => {
    const [, pullRow] = issuesPayload();
    expect(issueEvidence(pullRow, CONTEXT)).toBeNull();
  });

  it('produces a schema-valid issue record and accepts string labels', () => {
    const [issueRow] = issuesPayload();
    const parsed = evidenceInputSchema.parse(issueEvidence(issueRow, CONTEXT));
    expect(parsed.kind).toBe('issue');
    expect(parsed.externalId).toBe('issue:40');
    expect(parsed.title).toBe('#40 Document the read-only token scopes');
    expect(parsed.metadata).toMatchObject({ number: 40, state: 'open', comments: 2 });
    expect(parsed.metadata.labels).toEqual(['docs']);

    const stringLabels = issueEvidence(
      { number: 9, title: 'Legacy', labels: ['bug', { name: 'ready' }, 42, { colour: 'red' }] },
      CONTEXT,
    );
    /* Only label shapes that carry a usable name survive; the rest are dropped, not stringified. */
    expect(stringLabels?.metadata.labels).toEqual(['bug', 'ready']);
  });

  it('titles a workflow run by its conclusion and flags the default branch', () => {
    const [run] = workflowRunsPayload().workflow_runs;
    const parsed = evidenceInputSchema.parse(
      workflowRunEvidence({ ...run, repository: { default_branch: 'main' } }, CONTEXT),
    );
    expect(parsed.kind).toBe('workflow_run');
    expect(parsed.externalId).toBe('run:55501');
    expect(parsed.title).toBe('CI — success');
    expect(parsed.observedAt).toBe('2025-06-15T10:47:02.000Z');
    expect(parsed.metadata).toMatchObject({
      workflowName: 'CI',
      status: 'completed',
      conclusion: 'success',
      branch: 'main',
      headSha: HEAD_SHA,
      runNumber: 218,
      isDefaultBranch: true,
    });
  });

  it('falls back to the run status when there is no conclusion yet', () => {
    const evidence = workflowRunEvidence(
      { id: 1, name: 'CI', status: 'in_progress', conclusion: null },
      CONTEXT,
    );
    expect(evidence?.title).toBe('CI — in_progress');
    expect(evidence?.metadata.conclusion).toBeNull();
  });

  it('produces a schema-valid check record', () => {
    const [check] = checkRunsPayload().check_runs;
    const parsed = evidenceInputSchema.parse(checkRunEvidence(check, CONTEXT));
    expect(parsed.kind).toBe('check_result');
    expect(parsed.externalId).toBe('check:91001');
    expect(parsed.title).toBe('unit — success');
    expect(parsed.summary).toBe('128 tests passed');
    expect(parsed.observedAt).toBe('2025-06-15T10:46:00.000Z');
  });

  it('titles a release by name, then tag, then id', () => {
    const [release] = releasesPayload();
    const named = evidenceInputSchema.parse(releaseEvidence(release, CONTEXT));
    expect(named.title).toBe('v0.3.0');
    expect(named.externalId).toBe('release:7001');
    expect(named.observedAt).toBe('2025-06-10T12:00:00.000Z');
    expect(named.metadata).toMatchObject({ tag: 'v0.3.0', draft: false, prerelease: false });

    expect(releaseEvidence({ id: 7002, tag_name: 'v0.3.1' }, CONTEXT)?.title).toBe('v0.3.1');
    expect(releaseEvidence({ id: 7003 }, CONTEXT)?.title).toBe('Release 7003');
  });

  it('joins a deployment to its latest status', () => {
    const [deployment] = deploymentsPayload();
    const [status] = deploymentStatusesPayload();
    const parsed = evidenceInputSchema.parse(deploymentEvidence(deployment, status, CONTEXT));
    expect(parsed.kind).toBe('deployment');
    expect(parsed.externalId).toBe('deployment:3301');
    expect(parsed.title).toBe('Deployment to production — success');
    expect(parsed.url).toBe('https://aurora.example.com/deploys/3301');
    expect(parsed.observedAt).toBe('2025-06-15T10:58:00.000Z');
    expect(parsed.metadata).toMatchObject({ environment: 'production', state: 'success' });
  });

  it('records a deployment whose status could not be read', () => {
    const evidence = deploymentEvidence({ id: 3302 }, null, CONTEXT);
    expect(evidence?.title).toBe('Deployment to unknown environment');
    expect(evidence?.metadata.state).toBeNull();
    expect(evidence?.url).toBeNull();
  });

  it('drops nested objects from metadata while keeping primitives and arrays', () => {
    const evidence = pullRequestEvidence(
      {
        number: 88,
        title: 'Nested payload',
        state: 'open',
        draft: false,
        user: { login: { rendered: 'test-owner' } },
        head: { ref: { name: 'feature' } },
        base: { ref: 'main' },
        labels: [{ name: 'infra', colour: { hex: '#fff' } }],
        updated_at: '2025-06-15T09:00:00Z',
      },
      CONTEXT,
    );
    expect(evidence).not.toBeNull();
    const metadata = evidence!.metadata;

    expect(metadataShapes(metadata).filter((shape) => shape.endsWith(':object'))).toEqual([]);
    expect(metadata.authorLogin).toBeNull();
    expect(metadata.headRef).toBeNull();
    expect(metadata.baseRef).toBe('main');
    expect(metadata.labels).toEqual(['infra']);
    expect(metadata.number).toBe(88);
    expect(metadata.draft).toBe(false);
    /* The schema is the real contract: nothing survives cleaning that it would reject. */
    expect(() => evidenceInputSchema.parse(evidence)).not.toThrow();
  });

  it('refuses a javascript-scheme URL', () => {
    const evidence = pullRequestEvidence(
      { number: 13, title: 'Hostile link', html_url: 'javascript:alert(1)' },
      CONTEXT,
    );
    expect(evidence?.url).toBeNull();

    const commit = commitEvidence(
      { sha: HEAD_SHA, html_url: 'javascript:void(0)', commit: { message: 'x' } },
      CONTEXT,
    );
    expect(commit?.url).toBeNull();
  });

  it('describes the repository itself as evidence', () => {
    const state = normalizeRepository(repositoryPayload());
    expect(state).not.toBeNull();
    const parsed = evidenceInputSchema.parse(
      repositoryEvidence(state!, repositoryPayload(), CONTEXT),
    );
    expect(parsed.kind).toBe('repo_metadata');
    expect(parsed.externalId).toBe('repo:987654');
    expect(parsed.title).toBe('test-owner/aurora');
    expect(parsed.summary).toBe('Evidence-based portfolio brain.');
    expect(parsed.metadata).toMatchObject({
      visibility: 'private',
      defaultBranch: 'main',
      archived: false,
      primaryLanguage: 'TypeScript',
      openIssuesCount: 3,
      hasIssues: true,
    });
  });
});

/* ==================================================================== provider snapshot */

describe('GitHubSourceProvider.fetchSnapshot', () => {
  it('returns ok with evidence for every category of a healthy repository', async () => {
    const stub = createFetchStub();
    const snapshot = await snapshotFor(stub);

    expect(snapshot.status).toBe('ok');
    expect(snapshot.errorCode).toBeNull();
    expect(snapshot.errorMessage).toBeNull();
    expect(snapshot.unavailable).toEqual([]);
    expect([...snapshot.available].sort()).toEqual([
      'checks',
      'commits',
      'deployments',
      'issues',
      'metadata',
      'pull_requests',
      'releases',
      'workflow_runs',
    ] satisfies SourceCapability[]);

    /* One merge commit and one PR-shaped issue row are filtered, so the counts are not the
       raw payload lengths. */
    expect(countByKind(snapshot.evidence)).toEqual({
      repo_metadata: 1,
      git_commit: 1,
      pull_request: 2,
      issue: 1,
      workflow_run: 1,
      check_result: 1,
      release: 1,
      deployment: 1,
    });
    expect(snapshot.categories.commits).toEqual({ ok: true, count: 1 });
    expect(snapshot.categories.issues).toEqual({ ok: true, count: 1 });
    expect(snapshot.categories.metadata).toEqual({ ok: true, count: 1 });

    expect(snapshot.repo).toMatchObject({ owner: 'test-owner', repo: 'aurora', repoId: 987_654 });
    expect(snapshot.rateLimit).toEqual({
      limit: 5000,
      remaining: 4987,
      resetAt: RESET_AT,
      resource: 'core',
    });

    for (const item of snapshot.evidence) {
      expect(() => evidenceInputSchema.parse(item)).not.toThrow();
      expect(item.projectId).toBe(PROJECT_ID);
      expect(item.sourceId).toBe(SOURCE_ID);
    }

    /* Checks are looked up against the newest workflow run's SHA, not a branch name. */
    const checksCall = stub.calls.find((call) => call.url.pathname.endsWith('/check-runs'));
    expect(checksCall?.url.pathname).toBe(
      `/repos/test-owner/aurora/commits/${HEAD_SHA}/check-runs`,
    );
  });

  it('treats disabled issues as a healthy state with a reason, not a failure', async () => {
    const stub = createFetchStub({
      metadata: () => jsonResponse(repositoryPayload({ has_issues: false })),
    });
    const snapshot = await snapshotFor(stub);

    expect(snapshot.status).toBe('ok');
    expect(snapshot.unavailable).toEqual([]);
    expect(snapshot.categories.issues).toEqual({
      ok: true,
      count: 0,
      reason: 'Issues are disabled for this repository.',
    });
    expect(countByKind(snapshot.evidence).issue).toBeUndefined();
    /* A disabled category must not be probed at all. */
    expect(stub.paths().filter((path) => path.endsWith('/issues'))).toEqual([]);
  });

  it('degrades to partial when one category is forbidden and keeps the rest', async () => {
    const lines: string[] = [];
    const stub = createFetchStub({
      workflow_runs: () =>
        errorResponse(403, 'Resource not accessible by personal access token', RATE_LIMIT_HEADERS),
    });
    const snapshot = await snapshotFor(stub, {}, lines);

    expect(snapshot.status).toBe('partial');
    expect(snapshot.unavailable).toEqual(['workflow_runs']);
    expect(snapshot.categories.workflow_runs).toEqual({
      ok: false,
      reason: 'The credential does not have permission for this data.',
    });
    expect(snapshot.errorMessage).toBe('Some data was unavailable: workflow_runs.');

    const counts = countByKind(snapshot.evidence);
    expect(counts.git_commit).toBe(1);
    expect(counts.pull_request).toBe(2);
    expect(counts.workflow_run).toBeUndefined();
    /* With no run SHA the checks category falls back to the default branch and still runs. */
    expect(counts.check_result).toBe(1);
    expect(stub.paths()).toContain('/repos/test-owner/aurora/commits/main/check-runs');

    const warning = lines.find((line) => line.includes('github category unavailable'));
    expect(warning).toContain('"capability":"workflow_runs"');
    expect(warning).toContain('"kind":"forbidden"');
    expect(warning).not.toContain(TOKEN);
  });

  it('fails the whole snapshot when repository metadata cannot be read', async () => {
    const stub = createFetchStub({ metadata: () => errorResponse(404, 'Not Found') });
    const snapshot = await snapshotFor(stub);

    expect(snapshot.status).toBe('failed');
    expect(snapshot.errorCode).toBe('not_found');
    expect(snapshot.errorMessage).toContain('renamed, deleted, or is outside');
    expect(snapshot.evidence).toEqual([]);
    expect(snapshot.repo).toBeNull();
    expect(snapshot.categories).toEqual({});
    expect(snapshot.available).toEqual([]);
    /* Nothing beyond metadata is attempted, so the caller's previous evidence stands. */
    expect(stub.paths()).toEqual(['/repos/test-owner/aurora']);
  });

  it('aborts the remaining categories when the rate limit is exhausted', async () => {
    const stub = createFetchStub({
      commits: () =>
        errorResponse(403, 'API rate limit exceeded for user ID 4242.', EXHAUSTED_HEADERS),
    });

    let caught: unknown;
    try {
      await snapshotFor(stub);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(GithubApiError);
    const error = caught as GithubApiError;
    expect(error.kind).toBe('rate_limited');
    expect(error.code).toBe('rate_limited');
    expect(error.rateLimit).toEqual({
      limit: 5000,
      remaining: 0,
      resetAt: RESET_AT,
      resource: 'core',
    });
    /* Everything after commits is skipped rather than burning the remaining quota. */
    expect(stub.paths()).toEqual(['/repos/test-owner/aurora', '/repos/test-owner/aurora/commits']);
  });

  it('follows a renamed repository into the snapshot and the later requests', async () => {
    const stub = createFetchStub({
      metadata: () =>
        jsonResponse(
          repositoryPayload({
            name: 'aurora-next',
            owner: { login: 'test-owner-renamed' },
            html_url: 'https://github.com/test-owner-renamed/aurora-next',
          }),
        ),
    });
    const snapshot = await snapshotFor(stub);

    expect(snapshot.status).toBe('ok');
    expect(snapshot.repo).toMatchObject({
      owner: 'test-owner-renamed',
      repo: 'aurora-next',
      url: 'https://github.com/test-owner-renamed/aurora-next',
    });
    const metadataEvidence = snapshot.evidence.find((item) => item.kind === 'repo_metadata');
    expect(metadataEvidence?.title).toBe('test-owner-renamed/aurora-next');

    /* The stale coordinates are used once, to ask; every later call follows the new name. */
    expect(stub.paths()[0]).toBe('/repos/test-owner/aurora');
    expect(
      stub
        .paths()
        .slice(1)
        .every((path) => path.startsWith('/repos/test-owner-renamed/aurora-next/')),
    ).toBe(true);
  });

  it('fails cleanly for a source that is not a GitHub repository', async () => {
    const stub = createFetchStub();
    const provider = makeProvider(createClient(stub.fetchImpl));
    const snapshot = await provider.fetchSnapshot(
      makeSource({ id: SOURCE_ID, projectId: PROJECT_ID, kind: 'manual', github: null }),
      { projectId: PROJECT_ID, sourceId: SOURCE_ID, now: NOW, limits: LIMITS },
    );

    expect(snapshot.status).toBe('failed');
    expect(snapshot.errorCode).toBe('malformed');
    expect(snapshot.errorMessage).toBe('This source is not a GitHub repository.');
    expect(stub.calls).toHaveLength(0);
  });
});
