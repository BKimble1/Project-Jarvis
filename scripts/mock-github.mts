#!/usr/bin/env tsx
/**
 * A minimal, read-only mock of the GitHub REST API for end-to-end tests.
 *
 * It serves realistic fixtures for the endpoints Jarvis actually calls and, importantly, returns
 * 405 for any non-GET request — so an accidental write would fail loudly in the E2E suite rather
 * than passing silently.
 */
import { createServer } from 'node:http';

const PORT = Number(process.env.MOCK_GITHUB_PORT ?? 3124);
const OWNER = 'test-owner';

const iso = (daysAgo: number): string => new Date(Date.now() - daysAgo * 86_400_000).toISOString();

const REPOS = [
  {
    id: 1001,
    name: 'aurora',
    full_name: `${OWNER}/aurora`,
    owner: { login: OWNER },
    description: 'Fixture repository used by the end-to-end suite.',
    private: true,
    visibility: 'private',
    archived: false,
    default_branch: 'main',
    language: 'TypeScript',
    pushed_at: iso(1),
    updated_at: iso(1),
    created_at: iso(400),
    html_url: `https://github.com/${OWNER}/aurora`,
    size: 2048,
    has_issues: true,
    open_issues_count: 2,
    stargazers_count: 3,
    forks_count: 0,
    permissions: { admin: false, push: false, pull: true },
  },
  {
    id: 1002,
    name: 'legacy-tools',
    full_name: `${OWNER}/legacy-tools`,
    owner: { login: OWNER },
    description: 'An archived fixture repository.',
    private: false,
    visibility: 'public',
    archived: true,
    default_branch: 'master',
    language: 'Python',
    pushed_at: iso(300),
    updated_at: iso(300),
    created_at: iso(900),
    html_url: `https://github.com/${OWNER}/legacy-tools`,
    size: 120,
    has_issues: false,
    open_issues_count: 0,
    stargazers_count: 0,
    forks_count: 0,
    permissions: { admin: false, push: false, pull: true },
  },
];

const COMMITS = [
  {
    sha: 'aaaaaaaabbbbbbbbccccccccddddddddeeeeeeee',
    html_url: `https://github.com/${OWNER}/aurora/commit/aaaaaaa`,
    commit: {
      message: 'Add the evidence timeline component',
      author: { name: 'Test Owner', date: iso(1) },
      committer: { date: iso(1) },
    },
    author: { login: OWNER },
    parents: [{ sha: 'x' }],
  },
  {
    sha: '11111111222222223333333344444444555555556',
    html_url: `https://github.com/${OWNER}/aurora/commit/1111111`,
    commit: {
      message: 'Merge pull request #7 from feature/timeline',
      author: { name: 'Test Owner', date: iso(2) },
      committer: { date: iso(2) },
    },
    author: { login: OWNER },
    parents: [{ sha: 'x' }, { sha: 'y' }],
  },
];

const PULLS_OPEN = [
  {
    number: 12,
    title: 'Introduce the status engine',
    state: 'open',
    draft: false,
    merged_at: null,
    closed_at: null,
    created_at: iso(3),
    updated_at: iso(1),
    html_url: `https://github.com/${OWNER}/aurora/pull/12`,
    user: { login: OWNER },
    head: { ref: 'feature/status-engine' },
    base: { ref: 'main' },
    labels: [{ name: 'enhancement' }],
    body: null,
  },
];

const PULLS_CLOSED = [
  {
    number: 7,
    title: 'Evidence timeline',
    state: 'closed',
    draft: false,
    merged_at: iso(2),
    closed_at: iso(2),
    created_at: iso(6),
    updated_at: iso(2),
    html_url: `https://github.com/${OWNER}/aurora/pull/7`,
    user: { login: OWNER },
    head: { ref: 'feature/timeline' },
    base: { ref: 'main' },
    labels: [],
    body: null,
  },
];

const ISSUES = [
  {
    number: 21,
    title: 'Dark mode contrast on the project card',
    state: 'open',
    created_at: iso(5),
    updated_at: iso(2),
    closed_at: null,
    html_url: `https://github.com/${OWNER}/aurora/issues/21`,
    user: { login: OWNER },
    comments: 1,
    labels: [{ name: 'bug' }],
    body: null,
  },
];

const WORKFLOW_RUNS = {
  total_count: 2,
  workflow_runs: [
    {
      id: 5001,
      name: 'CI',
      display_title: 'Add the evidence timeline component',
      status: 'completed',
      conclusion: 'failure',
      event: 'push',
      head_branch: 'main',
      head_sha: 'aaaaaaaabbbbbbbbccccccccddddddddeeeeeeee',
      run_number: 88,
      run_attempt: 1,
      created_at: iso(1),
      run_started_at: iso(1),
      updated_at: iso(1),
      html_url: `https://github.com/${OWNER}/aurora/actions/runs/5001`,
    },
    {
      id: 4999,
      name: 'Deploy',
      display_title: 'Deploy to preview',
      status: 'completed',
      conclusion: 'success',
      event: 'push',
      head_branch: 'main',
      head_sha: '11111111222222223333333344444444555555556',
      run_number: 40,
      run_attempt: 1,
      created_at: iso(2),
      run_started_at: iso(2),
      updated_at: iso(2),
      html_url: `https://github.com/${OWNER}/aurora/actions/runs/4999`,
    },
  ],
};

const CHECK_RUNS = {
  total_count: 1,
  check_runs: [
    {
      id: 7001,
      name: 'unit tests',
      status: 'completed',
      conclusion: 'failure',
      started_at: iso(1),
      completed_at: iso(1),
      head_sha: 'aaaaaaaabbbbbbbbccccccccddddddddeeeeeeee',
      html_url: `https://github.com/${OWNER}/aurora/runs/7001`,
      output: { title: '1 failing test' },
    },
  ],
};

const RELEASES = [
  {
    id: 9001,
    name: 'v0.3.0',
    tag_name: 'v0.3.0',
    draft: false,
    prerelease: false,
    published_at: iso(9),
    created_at: iso(9),
    html_url: `https://github.com/${OWNER}/aurora/releases/tag/v0.3.0`,
    author: { login: OWNER },
    body: 'Evidence timeline and status engine.',
  },
];

const server = createServer((request, response) => {
  const send = (status: number, body: unknown) => {
    const payload = JSON.stringify(body);
    response.writeHead(status, {
      'content-type': 'application/json',
      'x-ratelimit-limit': '5000',
      'x-ratelimit-remaining': '4987',
      'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 3600),
      'x-ratelimit-resource': 'core',
    });
    response.end(payload);
  };

  if (request.method !== 'GET') {
    /* Jarvis must never issue a write. If it did, the E2E suite fails here. */
    send(405, { message: 'The mock GitHub API is read-only.' });
    return;
  }

  const url = new URL(request.url ?? '/', `http://127.0.0.1:${PORT}`);
  const path = url.pathname.replace(/\/+$/, '');

  if (path === '/user') return send(200, { login: OWNER, id: 4242, name: 'Test Owner' });
  if (path === '/user/repos') return send(200, url.searchParams.get('page') === '2' ? [] : REPOS);

  const repoMatch = /^\/repos\/([^/]+)\/([^/]+)(.*)$/.exec(path);
  if (repoMatch) {
    const [, owner, name, rest] = repoMatch;
    const repo = REPOS.find((item) => item.owner.login === owner && item.name === name);
    if (!repo) return send(404, { message: 'Not Found' });

    if (rest === '') return send(200, repo);
    if (rest === '/commits') return send(200, repo.name === 'aurora' ? COMMITS : []);
    if (rest === '/pulls') {
      const state = url.searchParams.get('state');
      if (repo.name !== 'aurora') return send(200, []);
      return send(200, state === 'closed' ? PULLS_CLOSED : PULLS_OPEN);
    }
    if (rest === '/issues') {
      if (!repo.has_issues) return send(410, { message: 'Issues are disabled for this repo' });
      return send(200, ISSUES);
    }
    if (rest === '/actions/runs') {
      return send(
        200,
        repo.name === 'aurora' ? WORKFLOW_RUNS : { total_count: 0, workflow_runs: [] },
      );
    }
    if (/^\/commits\/[^/]+\/check-runs$/.test(rest ?? '')) {
      return send(200, repo.name === 'aurora' ? CHECK_RUNS : { total_count: 0, check_runs: [] });
    }
    if (rest === '/releases') return send(200, repo.name === 'aurora' ? RELEASES : []);
    if (rest === '/deployments') return send(200, []);
    return send(404, { message: 'Not Found' });
  }

  send(404, { message: 'Not Found' });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`mock github listening on http://127.0.0.1:${PORT}`);
});
