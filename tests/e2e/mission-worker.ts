import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { APIRequestContext } from '@playwright/test';
import { expect } from '@playwright/test';

/**
 * A real Jarvis worker process, for the end-to-end mission tests.
 *
 * This is not a stub: it is `scripts/worker.ts`, the same entry point a real deployment runs,
 * with two things replaced — the model (a scripted runtime that appends one line to a README) and
 * the repository (redirected to a local bare repo through `JARVIS_WORKER_SANDBOX_REPOS`).
 *
 * Everything else is real: the bearer authentication, the polling, the atomic claim, the isolated
 * clone, the branch, the verification, the commit, the push and the draft pull request.
 */

export const SANDBOX_REPO_PATH = path.resolve(process.cwd(), '.jarvis-data/e2e-sandbox/remote.git');

export const MOCK_GITHUB_WRITE_URL =
  process.env.E2E_MOCK_GITHUB_WRITE_URL ?? 'http://127.0.0.1:3125';

export interface WorkerHandle {
  readonly process: ChildProcess;
  readonly workspaceRoot: string;
  readonly logs: string[];
  stop(): Promise<void>;
}

/** Enrols a worker through the real API and returns its one-time token. */
export async function enrolWorker(
  request: APIRequestContext,
  name: string,
): Promise<{ id: string; token: string }> {
  const response = await request.post('/api/workers', {
    data: { name, maxConcurrency: 1 },
  });
  expect(response.status(), `enrolling worker ${name}`).toBe(201);
  const body = (await response.json()) as { worker: { id: string }; token: string };
  return { id: body.worker.id, token: body.token };
}

/** Starts the worker and waits until the control plane has seen its first heartbeat. */
export async function startWorker(
  request: APIRequestContext,
  token: string,
  options: { sandboxFullName: string; baseUrl: string; name: string },
): Promise<WorkerHandle> {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), 'jarvis-e2e-workspaces-'));
  const logs: string[] = [];

  const child = spawn('npx', ['tsx', 'scripts/worker.ts'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      JARVIS_CONTROL_PLANE_URL: options.baseUrl,
      JARVIS_WORKER_TOKEN: token,
      JARVIS_WORKER_NAME: options.name,
      JARVIS_WORKER_WORKSPACE_ROOT: workspaceRoot,
      JARVIS_WORKER_RUNTIME: 'scripted',
      JARVIS_WORKER_POLL_MS: '1000',
      JARVIS_WORKER_VERIFY_TIMEOUT_MS: '60000',
      /* A fake credential, used only against the local mock write API. */
      JARVIS_WORKER_GITHUB_TOKEN: 'e2e-worker-write-token',
      JARVIS_WORKER_GITHUB_API_URL: MOCK_GITHUB_WRITE_URL,
      JARVIS_WORKER_SANDBOX_REPOS: `${options.sandboxFullName}=${SANDBOX_REPO_PATH}`,
      NODE_ENV: 'development',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    /*
     * Its own process group. `npx tsx` is a wrapper: killing it leaves the real worker running
     * with the stdio pipes still open, so `stop()` would wait forever for a `close` that never
     * comes. A group kill takes the whole tree.
     */
    detached: true,
  });

  const record = (chunk: Buffer) => logs.push(chunk.toString('utf8'));
  child.stdout?.on('data', record);
  child.stderr?.on('data', record);

  /* Wait for the control plane to see it, so a test never races the worker's first poll. */
  await expect
    .poll(
      async () => {
        const response = await request.get('/api/workers');
        if (response.status() !== 200) return 'unavailable';
        const body = (await response.json()) as {
          workers: { effectiveStatus: string; worker: { name: string } }[];
        };
        return body.workers.find((entry) => entry.worker.name === options.name)?.effectiveStatus;
      },
      { timeout: 40_000, message: 'the worker should connect and report itself idle' },
    )
    .toBe('idle');

  return {
    process: child,
    workspaceRoot,
    logs,
    async stop() {
      if (child.pid !== undefined) {
        /* Negative pid = the whole group, which is where `npx`'s grandchild actually lives. */
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          /* Already gone. */
        }
      }
      child.kill('SIGKILL');
      /* `exit` rather than `close`: a stray inherited pipe must not hold the suite open. */
      await Promise.race([
        new Promise((resolve) => child.once('exit', resolve)),
        new Promise((resolve) => setTimeout(resolve, 5_000)),
      ]);
      await rm(workspaceRoot, { recursive: true, force: true });
    },
  };
}

/**
 * Removes an enrolled worker.
 *
 * A test that leaves one behind poisons every later test: Jarvis queues an inspection run for a
 * worker it believes is briefly unhealthy, and nothing ever claims it. Cleaning up is what an
 * owner would do anyway.
 */
export async function removeWorker(request: APIRequestContext, id: string): Promise<void> {
  await request.delete(`/api/workers/${id}`);
}

/** What the mock GitHub write API was asked to do. */
export async function pullRequests(request: APIRequestContext): Promise<{
  pulls: {
    number: number;
    title: string;
    head: string;
    base: string;
    draft: boolean;
    body: string;
  }[];
  requests: { method: string; path: string }[];
}> {
  const response = await request.get(`${MOCK_GITHUB_WRITE_URL}/__pulls`);
  expect(response.status()).toBe(200);
  return (await response.json()) as Awaited<ReturnType<typeof pullRequests>>;
}

export async function resetPullRequests(request: APIRequestContext): Promise<void> {
  const response = await request.get(`${MOCK_GITHUB_WRITE_URL}/__reset`);
  expect(response.status()).toBe(200);
}
