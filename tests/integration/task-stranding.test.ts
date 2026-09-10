import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { WORKER_VERSION, type TaskAssignment } from '@/domain/worker-protocol';
import { RECLAIM_GRACE } from '@/server/missions/task-worker-service';
import { ControlPlaneError } from '@/worker/client';
import type { WorkerConfig } from '@/worker/config';
import { ScriptedRuntime } from '@/worker/runtime/scripted';
import { TaskRunner } from '@/worker/task-runner';
import { createHarness, type TestHarness } from '../helpers/services';

/**
 * The two ways a claimed task used to stop for ever without ending.
 *
 * Both are the same shape of bug seen from the two ends of the protocol: the row is `claimed`, so
 * it counts against `maxActiveRuns`, `maxRunsPerMission` and `maxParallelWriters` and is invisible
 * to every queue — and nothing left in the system will ever move it. Neither is reachable by
 * `reclaimAbandoned`, which acts on tasks whose *worker* looks gone; in both of these the worker is
 * alive and heartbeating, which is precisely why nobody notices until the factory has quietly
 * stopped taking work.
 *
 *  - **The control plane claims a task and then cannot hand it out.** `orchestrator.tick` or
 *    `buildAssignment` throws after the claim has already written `state='claimed'`, an assigned
 *    worker and a run. The route answers with an error, the worker's client refuses to retry
 *    anything under 500, and nothing unwinds the claim.
 *  - **The worker cannot report its own failure.** `fail` swallowed a refused terminal report, and
 *    ran it behind an `emit` that rethrows a fatal 401/403 — so a revoked token meant the report
 *    never happened at all and the throw stopped the work loop with the task still open.
 *
 * The control-plane half runs against the real database for the same reason `lease-reclaim` does:
 * what is being asserted is what the *rows* say afterwards, and a stubbed repository would be
 * asserting the stub. The worker half drives a real `TaskRunner` against a scripted control plane,
 * because the failures it is about are the ones where the control plane will not answer.
 */

const CLAIMABLE_ROLES = ['researcher', 'investigator', 'builder', 'verifier', 'reviewer'];

describe('a task claimed and then not handed out', () => {
  let harness: TestHarness;
  let now: Date;

  beforeEach(async () => {
    now = new Date('2026-05-01T09:00:00.000Z');
    harness = await createHarness({ clock: () => now });
  });

  afterEach(async () => {
    await harness.close();
  });

  /**
   * A mission with an owner-approved task graph, built the way a person builds one.
   *
   * Deliberately through the services rather than the routes: what is under test is the claim path
   * and what it leaves behind, and a route harness would add a session, a cookie jar and a
   * `next/headers` mock without changing a single assertion.
   */
  async function missionWithApprovedGraph(): Promise<{ missionId: string; graphId: string }> {
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
    return { missionId, graphId: proposal.graph.id };
  }

  /**
   * A worker that has enrolled *and* reported in, which is what production looks like — and what
   * makes these cases unrescuable by the reclaim path. A worker that had never beaten would count
   * as gone, and `reclaimAbandoned` would tidy up after this bug and hide it.
   */
  async function enrol(name: string): Promise<string> {
    const { worker } = await harness.services.workerService.enrol(name, 2);
    await harness.services.workerService.poll(worker.id, {
      heartbeat: {
        status: 'idle',
        version: WORKER_VERSION,
        runtimeAvailable: true,
        runtimeName: 'scripted',
        workspaceHealthy: true,
        githubDeliveryConfigured: true,
        diagnostics: [],
      },
      acknowledgedCommandIds: [],
      wantsWork: true,
    });
    return worker.id;
  }

  /**
   * Break the first thing that runs after the claim has been written.
   *
   * `orchestrator.tick` is the earliest of the three post-claim steps the brief names, and the
   * cheapest to fail honestly: the claim is already committed when it runs. Restored by the caller
   * so the control case in the same suite exercises the real one.
   */
  function breakTick(message: string): () => void {
    const orchestrator = harness.services.orchestrator;
    const original = orchestrator.tick.bind(orchestrator);
    orchestrator.tick = async () => {
      throw new Error(message);
    };
    return () => {
      orchestrator.tick = original;
    };
  }

  /** The one task the unwind touched, found by the counter the unwind increments. */
  async function unwoundTask(graphId: string) {
    const tasks = await harness.services.tasks.listByGraph(graphId);
    return tasks.filter((task) => task.reclaimCount > 0);
  }

  it('puts the task back, so it is claimable again and holds no capacity', async () => {
    const { missionId, graphId } = await missionWithApprovedGraph();
    const workerId = await enrol('claims-then-breaks');

    const restore = breakTick('The orchestrator could not read this mission.');
    await expect(
      harness.services.taskWorkerService.claimTask(workerId, CLAIMABLE_ROLES),
    ).rejects.toThrow(/could not read this mission/);
    restore();

    /*
     * Nothing is active. This is the ceiling claim stated exactly: `claimed` is one of the states
     * every concurrency ceiling counts, so a row left there is a slot spent on nothing until a
     * person notices.
     */
    expect(await harness.services.tasks.listActive()).toHaveLength(0);
    expect(await harness.services.tasks.countActive()).toBe(0);

    const [released] = await unwoundTask(graphId);
    expect(released).toBeDefined();
    expect(released!.state).toBe('ready');
    expect(released!.activeRunId).toBeNull();
    expect(released!.assignedWorkerId).toBeNull();

    /* The abandoned run is closed honestly rather than left looking live for ever. */
    const runs = await harness.services.missionRuns.list(missionId);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.state).toBe('failed');
    expect(runs[0]?.failureMessage).toMatch(/could not finish handing it out/);

    /* And an owner can see it happened, from Operations, without opening the mission. */
    const visible = await harness.services.missionEvents.recent({
      limit: 10,
      actors: ['system'],
      levels: ['warning'],
    });
    expect(
      visible.some(
        (event) => event.missionId === missionId && event.summary.includes(released!.key),
      ),
    ).toBe(true);

    /*
     * Claimable *in fact*, not merely in state. The claim consumed an attempt, and every built-in
     * playbook allows exactly one — so a release that did not hand that attempt back would leave a
     * row that says `ready` and that `claimNext` will never look at again.
     */
    const second = await harness.services.taskWorkerService.claimTask(workerId, CLAIMABLE_ROLES);
    expect(second).not.toBeNull();
    expect(second!.taskId).toBe(released!.id);

    /* A fresh run, because `(task_id, attempt)` is unique — re-using the number would fail here. */
    expect(second!.runId).not.toBe(runs[0]?.id);
    const reclaimed = await harness.services.tasks.findById(released!.id);
    expect(reclaimed?.attempt).toBe(2);
    expect(reclaimed?.state).toBe('claimed');
  }, 60_000);

  it('still tells the caller what went wrong', async () => {
    const { graphId } = await missionWithApprovedGraph();
    const workerId = await enrol('wants-to-know-why');

    /*
     * The unwind is not allowed to become a way of losing the error. A claim that silently
     * returned `null` here would read to the worker as "no work available", and the failure that
     * needs fixing would never appear anywhere.
     */
    const restore = breakTick('Postgres said no.');
    await expect(
      harness.services.taskWorkerService.claimTask(workerId, CLAIMABLE_ROLES),
    ).rejects.toThrow('Postgres said no.');
    restore();

    expect(await unwoundTask(graphId)).toHaveLength(1);
  }, 60_000);

  it('leaves an ordinary claim exactly as it found it', async () => {
    const { graphId } = await missionWithApprovedGraph();
    const workerId = await enrol('ordinary');

    /* The control has to be off when it should be off, or it is just a broken claim path. */
    const assignment = await harness.services.taskWorkerService.claimTask(
      workerId,
      CLAIMABLE_ROLES,
    );
    expect(assignment).not.toBeNull();

    const task = await harness.services.tasks.findById(assignment!.taskId);
    expect(task?.state).toBe('claimed');
    expect(task?.activeRunId).toBe(assignment!.runId);
    expect(task?.assignedWorkerId).toBe(workerId);
    expect(task?.attempt).toBe(1);
    /* Untouched by the unwind: no attempt handed back, no reclaim counted, no lease released. */
    expect(task?.reclaimCount).toBe(0);
    expect(await unwoundTask(graphId)).toHaveLength(0);
    expect(await harness.services.tasks.countActive()).toBe(1);

    const run = await harness.services.missionRuns.findById(assignment!.runId);
    expect(run?.state).toBe('starting');
    expect(run?.failureCode).toBeNull();
  }, 60_000);

  it('ends a task whose hand-out keeps failing rather than looping on it for ever', async () => {
    const { graphId } = await missionWithApprovedGraph();
    const workerId = await enrol('permanently-unlucky');

    /*
     * Handing the attempt back is what makes the release real, and it is also what could make this
     * spin: a hand-out that fails for a permanent reason would otherwise be re-claimed and
     * re-failed on every poll for ever, writing rows every few seconds and telling nobody. The
     * bound is `RECLAIM_GRACE`, the same one that stops an unstable machine looping a crashed task.
     */
    const restore = breakTick('The orchestrator is still broken.');
    for (let attempt = 0; attempt <= RECLAIM_GRACE; attempt += 1) {
      await expect(
        harness.services.taskWorkerService.claimTask(workerId, CLAIMABLE_ROLES),
      ).rejects.toThrow(/still broken/);
    }
    restore();

    const [ended] = await unwoundTask(graphId);
    expect(ended?.state).toBe('failed');
    expect(ended?.reclaimCount).toBe(RECLAIM_GRACE + 1);

    /* And it is not handed out again. */
    const next = await harness.services.taskWorkerService.claimTask(workerId, CLAIMABLE_ROLES);
    expect(next?.taskId ?? null).not.toBe(ended?.id);
  }, 60_000);
});

/* ------------------------------------------------- the worker's own reporting */

const MISSION_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const RUN_ID = '12121212-3434-4565-8787-909090909090';
const TASK_ID = '56565656-7878-4989-8aaa-bbbbbbbbbbbb';

describe('a worker that cannot report its own failure', () => {
  let workspaceRoot: string;

  beforeEach(async () => {
    workspaceRoot = await mkdtemp(path.join(tmpdir(), 'jarvis-stranding-'));
  });

  afterEach(async () => {
    await rm(workspaceRoot, { recursive: true, force: true });
  });

  function config(): WorkerConfig {
    return {
      controlPlaneUrl: 'http://localhost:3000',
      token: 'jarvisw_test',
      name: 'stranding-worker',
      workspaceRoot,
      anthropicApiKey: null,
      anthropicApiKeyPresent: false,
      claudeOauthToken: null,
      operatorTickIntervalMs: null,
      authMode: 'subscription',
      model: null,
      maxTurns: 100,
      githubToken: null,
      githubApiUrl: 'https://api.github.test',
      pollIntervalMs: 1000,
      verifyTimeoutMs: 60_000,
      runTimeoutMs: 300_000,
      accepts: ['inspection', 'execution', 'research'],
      allowWebResearch: false,
      runtime: 'scripted',
      allowedRepositories: null,
      sandboxRepositories: new Map(),
      version: WORKER_VERSION,
      diagnostics: [],
    };
  }

  /**
   * A review task with nothing to review.
   *
   * Chosen because it fails on the first line of `runReview`, before a clone, a branch or a model
   * session — so what these tests drive is `fail` itself rather than everything that happens to
   * come before it.
   */
  function assignment(): TaskAssignment {
    return {
      kind: 'task',
      missionId: MISSION_ID,
      runId: RUN_ID,
      taskId: TASK_ID,
      taskKey: 't-review',
      graphVersion: 1,
      attempt: 1,
      role: 'reviewer',
      permissionProfileId: 'readonly_repo',
      taskType: 'review',
      title: 'Review the change',
      description: 'Read the diff and give a verdict.',
      acceptanceCriteria: [],
      expectedInputs: [],
      expectedOutputs: [],
      workspaceRequirement: 'none',
      declaredWriteSet: [],
      branchName: null,
      baseTaskBranch: null,
      integrationBranch: null,
      mergeBranches: [],
      mergeWriteSet: [],
      repairRound: 0,
      maxTurns: null,
      timeLimitMs: null,
      maxOutputTokens: null,
      missionTitle: 'Improve invoicing',
      rawRequest: 'Improve invoicing',
      missionType: 'investigation',
      riskLevel: 'low',
      projectId: 'project-1',
      projectName: 'Sandbox',
      projectGoal: null,
      planVersion: 1,
      plan: null,
      graphSummary: 'One review task.',
      siblingTasks: [],
      constraints: [],
      doNotTouch: [],
      repository: null,
      clarifications: [],
      projectContext: [],
      allowWebResearch: false,
      review: null,
      repairScope: null,
      verification: [],
    } as TaskAssignment;
  }

  function runnerWith(
    parts: {
      events: () => Promise<{ accepted: number }>;
      taskState: (input: Record<string, unknown>) => Promise<unknown>;
    },
    logs: string[],
  ): TaskRunner {
    return new TaskRunner(
      {
        config: config(),
        client: parts as unknown as ConstructorParameters<typeof TaskRunner>[0]['client'],
        runtime: new ScriptedRuntime({ steps: [] }),
        delivery: null,
        log: (message) => logs.push(message),
      },
      assignment(),
    );
  }

  it('reports the failure even when the control plane has revoked its token', async () => {
    /*
     * The report used to sit behind the `emit`, and `emit` rethrows a fatal 401/403 — so a revoked
     * token meant the terminal report was never attempted. The throw left `fail`, left `run`'s
     * catch, left `claimAndRunTask`'s try/finally and stopped the work loop, with the task still
     * `claimed` on the control plane and nothing else able to close it.
     */
    const reports: Record<string, unknown>[] = [];
    const logs: string[] = [];
    const runner = runnerWith(
      {
        events: () => Promise.reject(new ControlPlaneError('This worker was revoked.', 401, 'unauthorized')),
        taskState: async (input) => {
          reports.push(input);
          return { ok: true, taskState: 'failed', stopRequested: false, pauseRequested: false };
        },
      },
      logs,
    );

    /* The revoked worker still stops. That part was right, and is deliberately unchanged. */
    await expect(runner.run()).rejects.toBeInstanceOf(ControlPlaneError);

    /* But not instead of ending the task. */
    const failed = reports.filter((report) => report.taskState === 'failed');
    expect(failed.length).toBeGreaterThan(0);
    expect(failed[0]?.failureCode).toBe('agent_error');
    expect(String(failed[0]?.failureMessage)).toMatch(/nothing to review/);
  });

  it('says out loud when the terminal report itself is refused', async () => {
    /*
     * `.catch(() => undefined)` was the difference between a task that ends badly and a task that
     * never ends: a 409 — the run is no longer the task's active run — left the row non-terminal
     * with nothing else to close it, and the only trace was a worker moving on to its next poll in
     * silence. It still cannot be fixed here. It can be findable.
     */
    const logs: string[] = [];
    const runner = runnerWith(
      {
        events: async () => ({ accepted: 1 }),
        taskState: () =>
          Promise.reject(
            new ControlPlaneError('That run is no longer this task’s active run.', 409, 'conflict'),
          ),
      },
      logs,
    );

    /* A refused report is not itself a reason to stop the worker: the next task may be fine. */
    await expect(runner.run()).resolves.toBeUndefined();

    const complaint = logs.find((line) => line.includes('t-review'));
    expect(complaint).toBeDefined();
    expect(complaint).toMatch(/409/);
    expect(complaint).toMatch(/still open/);
  });
});
