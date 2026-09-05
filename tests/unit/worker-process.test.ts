import { describe, expect, it } from 'vitest';

import { JarvisWorkerProcess, type WorkerRuntimeDeps } from '@/worker/main';
import { WORKER_VERSION, type WorkerPollInput } from '@/domain/worker-protocol';
import type { WorkerConfig } from '@/worker/config';

/**
 * The worker's own loop — the part that decides when to talk and when to work.
 *
 * This had no test at all, which is how it came to stop talking for the whole duration of every
 * mission. `MissionRunner` and `TaskRunner` are both thoroughly covered; the process that
 * schedules them was the gap, and the gap was load-bearing.
 *
 * These are structural: they hold the work loop inside a claim and assert what the poll loop does
 * meanwhile. A mission in flight, with a real runner and real owner commands, is exercised in
 * `tests/integration/worker-runner.test.ts`, where the runner can actually run.
 */

function config(overrides: Partial<WorkerConfig> = {}): WorkerConfig {
  return {
    controlPlaneUrl: 'http://localhost:3000',
    token: 'jarvisw_test',
    name: 'loop-worker',
    workspaceRoot: '/tmp/jarvis-loop-test',
    anthropicApiKey: null,
    anthropicApiKeyPresent: false,
    claudeOauthToken: null,
    authMode: 'subscription',
    model: null,
    maxTurns: 10,
    githubToken: null,
    githubApiUrl: 'https://api.github.test',
    pollIntervalMs: 1,
    verifyTimeoutMs: 60_000,
    runTimeoutMs: 300_000,
    accepts: ['inspection', 'execution', 'research'],
    allowWebResearch: false,
    runtime: 'scripted',
    allowedRepositories: null,
    sandboxRepositories: new Map(),
    version: WORKER_VERSION,
    diagnostics: [],
    ...overrides,
  };
}

const READY_RUNTIME: WorkerRuntimeDeps['runtime'] = {
  name: 'scripted',
  availability: async () => ({ available: true, version: null, detail: 'Ready.' }),
  start: async () => {
    throw new Error('not reached: these tests never let a run start');
  },
};

/**
 * Run a worker whose work loop is held inside `claim` until the poll loop has seen enough.
 *
 * `claim` standing in for a long mission is the honest shape of this test: the claim and the run
 * are the same blocking stretch of the work loop, and what is being asserted is that the poll loop
 * is not part of that stretch.
 */
async function pollsWhileWorkIsBlocked(options: {
  readonly pollsBeforeRelease: number;
  readonly pollsBeforeRevoke: number;
}): Promise<readonly WorkerPollInput[]> {
  const polls: WorkerPollInput[] = [];
  let released = false;
  let workLoopEntered = false;

  const worker = new JarvisWorkerProcess({
    config: config(),
    client: {
      async poll(input: WorkerPollInput) {
        polls.push(input);
        if (polls.length >= options.pollsBeforeRelease) released = true;
        return {
          workerId: 'worker-1',
          serverTime: new Date().toISOString(),
          assignment: null,
          commands: [],
          directive:
            polls.length >= options.pollsBeforeRevoke
              ? ('revoked' as const)
              : ('continue' as const),
          pollIntervalMs: 1,
        };
      },
      async claim() {
        workLoopEntered = true;
        while (!released) await new Promise((resolve) => setImmediate(resolve));
        return null;
      },
      async claimTask() {
        return null;
      },
    } as unknown as WorkerRuntimeDeps['client'],
    runtime: READY_RUNTIME,
    delivery: null,
    sleep: async () => {
      await new Promise((resolve) => setImmediate(resolve));
    },
    log: () => undefined,
  });

  await worker.run();
  expect(workLoopEntered, 'the work loop must actually have been blocked').toBe(true);
  return polls;
}

describe('the worker process loop', () => {
  it('keeps talking to the control plane while the work loop is blocked', async () => {
    /*
     * The regression. The heartbeat is written only by the poll, and the poll used to sit behind
     * the work in a single loop — so a mission longer than WORKER_DISCONNECT_SECONDS made the
     * control plane classify a healthy, working worker as disconnected. Everything that reads the
     * heartbeat then went wrong at once: the workers page, the owner's Stop, the qualification
     * ladder, and the delivery of every owner command.
     *
     * Before the split this would be exactly one poll, then silence.
     */
    const polls = await pollsWhileWorkIsBlocked({ pollsBeforeRelease: 6, pollsBeforeRevoke: 8 });
    expect(polls.length).toBeGreaterThanOrEqual(6);
  });

  it('obeys a revoke even though the work loop is busy', async () => {
    /*
     * The other side of the split: two loops that share only `stopped`, and either may set it.
     * A revoke arriving during a long stretch of work must still end the process rather than being
     * noticed some minutes later — and `run()` must resolve, not hang waiting on the other loop.
     */
    const polls = await pollsWhileWorkIsBlocked({ pollsBeforeRelease: 3, pollsBeforeRevoke: 4 });
    expect(polls.length).toBeGreaterThanOrEqual(4);
  });
});
