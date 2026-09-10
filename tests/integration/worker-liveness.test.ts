import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { WORKER_VERSION, type WorkerPollInput } from '@/domain/worker-protocol';
import { ABANDONED_AFTER_MS } from '@/server/missions/task-worker-service';
import type { WorkerConfig } from '@/worker/config';
import {
  HEALTH_REPROBE_INTERVAL_MS,
  JarvisWorkerProcess,
  type WorkerRuntimeDeps,
} from '@/worker/main';
import { createHarness, type TestHarness } from '../helpers/services';

/**
 * Two ways a worker that is perfectly alive stops being believed.
 *
 * ## What these are about
 *
 * A long agent session is *silent*. It thinks for minutes at a time without emitting an event, and
 * the two things that watch it were both reading that silence as death. The reclaim sweep spent
 * its whole ten-minute margin on the task's own last activity — which a thinking session exhausts
 * as a matter of course — leaving only the two-minute disconnect line between a running agent and
 * having its work taken away and re-queued under another worker. And the worker's two health
 * facts, "can I reach Claude" and "can I write to my workspace", were read once at boot and never
 * again, so a login that expired at lunchtime left a worker heartbeating "healthy" and claiming
 * nothing, for ever, with no explanation anywhere.
 *
 * ## Why the second half is not a database test
 *
 * The re-probe is a property of the worker process, not of the control plane: nothing in the
 * schema, the routes or the services changes. Driving it through a real worker with a fake clock
 * and a scripted runtime is the honest test — a database in the middle would prove nothing extra
 * and would hide the timing, which is the whole point. It lives here beside the reclaim cases
 * because the two defects are one story: what a worker says about itself, and what Jarvis does
 * when it stops hearing it.
 */

const CLAIMABLE_ROLES = ['researcher', 'investigator', 'builder', 'verifier', 'reviewer'];

describe('taking a task back from a worker that is still there', () => {
  let harness: TestHarness;
  let now: Date;

  beforeEach(async () => {
    now = new Date('2026-04-01T09:00:00.000Z');
    harness = await createHarness({ clock: () => now });
  });

  afterEach(async () => {
    await harness.close();
  });

  const advance = (ms: number): void => {
    now = new Date(now.getTime() + ms);
  };

  /** A mission with an owner-approved task graph, built the way `lease-reclaim` builds one. */
  async function missionWithApprovedGraph(): Promise<string> {
    const project = await harness.services.projects.create({
      name: 'Sandbox',
      type: 'software',
      status: 'active',
      priority: 'medium',
      tags: [],
      links: [],
    });
    await harness.services.sources.addGithubSource(project.id, {
      owner: 'test-owner',
      repo: 'sandbox',
    });

    const created = await harness.services.missions.create(
      {
        rawRequest: 'Audit the repository and report what you find',
        projectId: project.id,
        priority: 'medium',
        constraints: [],
        doNotTouch: [],
        acceptanceCriteria: [],
      },
      'test-owner',
    );
    const missionId = created.mission.id;

    for (let round = 0; round < 5; round += 1) {
      const open = (await harness.services.clarifications.list(missionId)).filter(
        (question) => question.answeredAt === null,
      );
      if (open.length === 0) break;
      for (const question of open) {
        await harness.services.missions.answerClarification(missionId, question.id, {
          answer: 'Whatever the plan says is fine.',
          acceptRecommendation: true,
        });
      }
    }

    await harness.services.missions.requestPlan(missionId);
    const planned = await harness.services.missionRepo.findById(missionId);
    await harness.services.missions.approvePlan(
      missionId,
      {
        planVersion: planned?.currentPlanVersion ?? 1,
        acknowledgedRiskLevel: planned?.riskLevel ?? 'moderate',
        pausedProjectOverride: false,
      },
      'test-owner',
    );

    await harness.services.playbookService.seedBuiltIns();
    const proposal = await harness.services.orchestrator.proposeGraph(missionId, {
      playbookKey: 'repository_audit',
    });
    await harness.services.orchestrator.approveGraph(
      missionId,
      { graphVersion: proposal.graph.version, fingerprint: proposal.graph.fingerprint },
      'test-owner',
    );
    return missionId;
  }

  /** A worker that has enrolled *and* reported in, which is what production looks like. */
  async function enrol(name: string): Promise<string> {
    const { worker } = await harness.services.workerService.enrol(name, 2);
    await beat(worker.id);
    return worker.id;
  }

  /**
   * One heartbeat, as the worker's poll loop sends it.
   *
   * `holding` makes it the heartbeat of a worker with a session in flight — `busy`, naming the run
   * — because that is the case under test: the poll loop keeps beating for the whole length of a
   * session, whatever the agent inside it is doing.
   */
  async function beat(
    workerId: string,
    holding: { missionId: string; runId: string } | null = null,
  ): Promise<void> {
    await harness.services.workerService.poll(workerId, {
      heartbeat: {
        status: holding ? 'busy' : 'idle',
        version: WORKER_VERSION,
        runtimeAvailable: true,
        runtimeName: 'scripted',
        workspaceHealthy: true,
        githubDeliveryConfigured: true,
        diagnostics: [],
        ...(holding ? { currentMissionId: holding.missionId, currentRunId: holding.runId } : {}),
      },
      acknowledgedCommandIds: [],
      wantsWork: holding === null,
    });
  }

  /** Claim the next task and get it as far as `running`, which is where a session starts. */
  async function claimAndStart(
    workerId: string,
  ): Promise<{ taskId: string; runId: string; taskKey: string }> {
    const assignment = await harness.services.taskWorkerService.claimTask(
      workerId,
      CLAIMABLE_ROLES,
    );
    expect(assignment).not.toBeNull();
    for (const taskState of ['preparing', 'running']) {
      await harness.services.taskWorkerService.reportTaskState(workerId, {
        runId: assignment!.runId,
        taskId: assignment!.taskId,
        taskState,
        currentAction: 'Reading the repository',
      });
    }
    return { taskId: assignment!.taskId, runId: assignment!.runId, taskKey: assignment!.taskKey };
  }

  it('leaves a task alone while its worker is beating, however long the agent has been quiet', async () => {
    const missionId = await missionWithApprovedGraph();
    const workerId = await enrol('deep-thinker');
    const held = await claimAndStart(workerId);

    /*
     * Half an hour of a session that says nothing — three times the reclaim window — with the
     * worker beating throughout. This is an ordinary Claude session reading a repository, not a
     * failure of any kind, and the sweep must not touch it: a task taken back here is handed to a
     * second worker while the first is still running, and every owner command from that moment on
     * is delivered to a run nobody is executing.
     */
    for (let minute = 0; minute < 30; minute += 1) {
      advance(60_000);
      await beat(workerId, { missionId, runId: held.runId });
    }

    expect(await harness.services.taskWorkerService.reclaimAbandoned()).toEqual({
      reclaimed: 0,
      failed: 0,
      leasesReleased: 0,
    });

    const task = await harness.services.tasks.findById(held.taskId);
    expect(task?.state).toBe('running');
    expect(task?.activeRunId).toBe(held.runId);
    expect(task?.assignedWorkerId).toBe(workerId);
  }, 60_000);

  it('does not take a task away over a gap in heartbeats shorter than the window', async () => {
    const missionId = await missionWithApprovedGraph();
    const workerId = await enrol('blips-once');
    const held = await claimAndStart(workerId);

    /* Nine minutes of thinking, beating every ten seconds: alive, and saying so. */
    for (let tick = 0; tick < 54; tick += 1) {
      advance(10_000);
      await beat(workerId, { missionId, runId: held.runId });
    }

    /*
     * Then three minutes with no heartbeat — a home connection dropping, a laptop lid, a control
     * plane redeploying. The session is still running; only the beats were lost.
     *
     * This is the exact reproduction. The old condition was "worker looks disconnected AND the
     * task has been quiet for ten minutes", and by this point the second half has been true for
     * three minutes purely because the agent is thinking — so all that stood between this run and
     * being re-queued was the two-minute disconnect line, which this blip crosses.
     */
    advance(3 * 60_000);

    expect((await harness.services.taskWorkerService.reclaimAbandoned()).reclaimed).toBe(0);
    const stillRunning = await harness.services.tasks.findById(held.taskId);
    expect(stillRunning?.activeRunId).toBe(held.runId);
    expect(stillRunning?.assignedWorkerId).toBe(workerId);

    /* And the margin has not been given away: silence past the window still loses the task. */
    advance(ABANDONED_AFTER_MS);
    expect((await harness.services.taskWorkerService.reclaimAbandoned()).reclaimed).toBe(1);
    const takenBack = await harness.services.tasks.findById(held.taskId);
    expect(takenBack?.state).toBe('ready');
    expect(takenBack?.assignedWorkerId).toBeNull();
  }, 60_000);

  it('keeps the task of a worker whose polls are failing but whose task still reports', async () => {
    await missionWithApprovedGraph();
    const workerId = await enrol('polls-failing');
    const held = await claimAndStart(workerId);

    /*
     * The one place the fix can still be wrong.
     *
     * Everything now rests on one signal: the heartbeat. That is the right signal — it is the only
     * one here that does not depend on what an agent is doing — but it arrives on a single route,
     * and a route can fail on its own. `/poll` does far more than record a beat: it reads the
     * mission list, the pending commands and the qualification rung, so a defect in any of those
     * answers a worker with a 500 while its task reports, which go elsewhere and carry almost
     * nothing, keep landing. That worker is demonstrably alive and demonstrably working, and the
     * heartbeat alone says it has been dead for twenty minutes.
     *
     * `taskQuiet` is the whole of what stands between that worker and losing its task to a second
     * one. It decides nothing on its own, which is exactly why it is easy to read as decorative and
     * delete — and deleting it passed every reclaim test in this repository, which is why this case
     * is written down.
     */
    for (let tick = 0; tick < 40; tick += 1) {
      advance(30_000);
      await harness.services.taskWorkerService.reportTaskState(workerId, {
        runId: held.runId,
        taskId: held.taskId,
        currentAction: 'Still reading the repository',
      });
    }

    expect((await harness.services.taskWorkerService.reclaimAbandoned()).reclaimed).toBe(0);
    const stillRunning = await harness.services.tasks.findById(held.taskId);
    expect(stillRunning?.state).toBe('running');
    expect(stillRunning?.activeRunId).toBe(held.runId);
    expect(stillRunning?.assignedWorkerId).toBe(workerId);

    /*
     * And it is the reports that are holding it, not some accident of the fixture. Nothing else
     * changes: the same worker stays silent, and the moment its task stops speaking too — both
     * halves true at last — the sweep takes the task exactly as it should.
     */
    advance(ABANDONED_AFTER_MS);
    expect((await harness.services.taskWorkerService.reclaimAbandoned()).reclaimed).toBe(1);
    const takenBack = await harness.services.tasks.findById(held.taskId);
    expect(takenBack?.state).toBe('ready');
    expect(takenBack?.assignedWorkerId).toBeNull();
  }, 60_000);

  it('still takes a task back from a worker that has really gone', async () => {
    await missionWithApprovedGraph();
    const workerId = await enrol('crashes-after-claiming');
    const held = await claimAndStart(workerId);

    /* Nothing at all — no heartbeat, no report — for longer than the window. */
    advance(ABANDONED_AFTER_MS + 60_000);

    const summary = await harness.services.taskWorkerService.reclaimAbandoned();
    expect(summary.reclaimed).toBe(1);
    expect(summary.failed).toBe(0);

    const task = await harness.services.tasks.findById(held.taskId);
    expect(task?.state).toBe('ready');
    expect(task?.activeRunId).toBeNull();
    expect(task?.assignedWorkerId).toBeNull();

    const run = await harness.services.missionRuns.findById(held.runId);
    expect(run?.state).toBe('failed');
    expect(run?.failureCode).toBe('worker_lost');
  }, 60_000);
});

/* ------------------------------------------------- the worker's own health */

/** Polls are cheap and this is fake time; nothing here waits on a real clock. */
const POLL_MS = 3000;

/** A ceiling so a worker that never re-probes fails an assertion instead of hanging the suite. */
const MAX_POLLS = 2000;

function workerConfig(overrides: Partial<WorkerConfig> = {}): WorkerConfig {
  return {
    controlPlaneUrl: 'http://localhost:3000',
    token: 'jarvisw_test',
    name: 'liveness-worker',
    workspaceRoot: '/tmp/jarvis-liveness-unused',
    anthropicApiKey: null,
    anthropicApiKeyPresent: false,
    claudeOauthToken: null,
    operatorTickIntervalMs: null,
    authMode: 'subscription',
    model: null,
    maxTurns: 10,
    githubToken: null,
    githubApiUrl: 'https://api.github.test',
    pollIntervalMs: POLL_MS,
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

interface ProbeRecord {
  /** Fake-clock time of the probe, which is what proves the interval is respected. */
  readonly atMs: number;
  readonly available: boolean;
}

/**
 * Run a real worker against a scripted runtime and a fake clock, until it has probed enough.
 *
 * Time advances only through `sleep`, so the run is deterministic and instant: every loop that
 * sleeps moves the same clock forward, and the poll loop's re-probe becomes due in fake minutes
 * that cost no real ones. The run ends with a `revoked` directive — the same way the process ends
 * in production — once the requested number of probes has been taken.
 */
async function runWorker(options: {
  readonly workspaceRoot: string;
  /** Whether the Nth probe (1-based) finds a usable runtime. */
  readonly available: (probe: number) => boolean;
  readonly probesWanted: number;
  /** A hook to change the world between polls, e.g. to repair a broken workspace root. */
  readonly onPoll?: (poll: number) => Promise<void>;
}): Promise<{ polls: readonly WorkerPollInput[]; probes: readonly ProbeRecord[] }> {
  let clockMs = Date.parse('2026-04-01T09:00:00.000Z');
  const polls: WorkerPollInput[] = [];
  const probes: ProbeRecord[] = [];

  const worker = new JarvisWorkerProcess({
    config: workerConfig({ workspaceRoot: options.workspaceRoot }),
    client: {
      async poll(input: WorkerPollInput) {
        polls.push(input);
        await options.onPoll?.(polls.length);
        return {
          workerId: 'worker-1',
          serverTime: new Date(clockMs).toISOString(),
          assignment: null,
          commands: [],
          directive:
            probes.length >= options.probesWanted || polls.length >= MAX_POLLS
              ? ('revoked' as const)
              : ('continue' as const),
          pollIntervalMs: POLL_MS,
        };
      },
      async claim() {
        return null;
      },
      async claimTask() {
        return null;
      },
      async claimReasoning() {
        return null;
      },
    } as unknown as WorkerRuntimeDeps['client'],
    runtime: {
      name: 'scripted',
      availability: async () => {
        const available = options.available(probes.length + 1);
        probes.push({ atMs: clockMs, available });
        return {
          available,
          version: null,
          detail: available
            ? 'Signed in with a Claude subscription.'
            : 'Not signed in. Run `claude login` on this machine.',
        };
      },
      start: async () => {
        throw new Error('not reached: these tests never let a session start');
      },
    },
    delivery: null,
    now: () => new Date(clockMs),
    sleep: async (ms: number) => {
      clockMs += ms;
      await new Promise((resolve) => setImmediate(resolve));
    },
    log: () => undefined,
  });

  await worker.run();
  expect(polls.length, 'the worker gave up polling before it had probed enough').toBeLessThan(
    MAX_POLLS,
  );
  return { polls, probes };
}

describe('a worker re-checking whether it can work at all', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'jarvis-liveness-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('notices a Claude login that expires mid-session, and says so in the heartbeat', async () => {
    /*
     * Signed in at boot, signed out by the second probe, signed back in by the fourth — an owner
     * running `claude login` again. Before the re-probe existed the first answer was the only one
     * ever taken: the worker heartbeated `runtimeAvailable: true` for the rest of its life while
     * its work loop skipped every claim, and the dashboard showed a connected, idle worker with
     * nothing to explain it.
     */
    const { polls, probes } = await runWorker({
      workspaceRoot: root,
      available: (probe) => probe === 1 || probe >= 4,
      probesWanted: 4,
    });

    expect(probes.length).toBeGreaterThanOrEqual(4);

    /* Bounded, not constant: `availability()` spawns a process, and the poll runs every 3s. */
    for (let i = 1; i < probes.length; i += 1) {
      expect(probes[i]!.atMs - probes[i - 1]!.atMs).toBeGreaterThanOrEqual(
        HEALTH_REPROBE_INTERVAL_MS,
      );
    }

    /* The heartbeat tells the whole story: healthy, then not, then healthy again. */
    expect(polls[0]!.heartbeat.runtimeAvailable).toBe(true);
    const died = polls.findIndex((poll) => !poll.heartbeat.runtimeAvailable);
    expect(died).toBeGreaterThan(0);
    const recovered = polls.findIndex(
      (poll, index) => index > died && poll.heartbeat.runtimeAvailable,
    );
    expect(recovered).toBeGreaterThan(died);

    /*
     * And why, in both directions. A worker that is refusing work has to be able to say what
     * changed and when — `runtimeAvailable: false` on a worker that has been that way since it
     * started is a setup problem the owner already knows about.
     */
    expect(polls[died]!.heartbeat.status).toBe('unhealthy');
    expect(polls[died]!.wantsWork).toBe(false);
    expect(polls[died]!.heartbeat.diagnostics.join(' | ')).toContain(
      'Claude runtime stopped being available at',
    );
    expect(polls[died]!.heartbeat.diagnostics.join(' | ')).toContain('Run `claude login`');
    expect(polls[recovered]!.heartbeat.diagnostics.join(' | ')).toContain(
      'Claude runtime became available again at',
    );
    expect(polls[recovered]!.wantsWork).toBe(true);
  }, 60_000);

  it('notices a workspace root that becomes usable again, without being restarted', async () => {
    /*
     * The other half, against the real `checkWorkspaceRoot` rather than a stub: the root cannot be
     * created because a *file* sits where its parent directory belongs, which is what a disk that
     * filled or a mount that vanished looks like from here. Removing the file is the owner fixing
     * it, and the worker has to come back on its own — the failure this closes is a worker that
     * kept reporting the boot-time verdict until somebody thought to restart it.
     */
    const blocker = path.join(root, 'blocked');
    await writeFile(blocker, 'not a directory', 'utf8');

    const { polls, probes } = await runWorker({
      workspaceRoot: path.join(blocker, 'workspaces'),
      available: () => true,
      probesWanted: 2,
      onPoll: async (poll) => {
        if (poll === 1) await rm(blocker, { force: true });
      },
    });

    expect(probes.length).toBeGreaterThanOrEqual(2);
    expect(polls[0]!.heartbeat.workspaceHealthy).toBe(false);
    expect(polls[0]!.heartbeat.status).toBe('unhealthy');

    const repaired = polls.findIndex((poll) => poll.heartbeat.workspaceHealthy);
    expect(repaired).toBeGreaterThan(0);
    expect(polls[repaired]!.heartbeat.status).toBe('idle');
    expect(polls[repaired]!.heartbeat.diagnostics.join(' | ')).toContain(
      'Workspace root became writable again at',
    );
  }, 60_000);
});
