import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ConflictError } from '@/domain/errors';
import { WORKER_VERSION } from '@/domain/worker-protocol';
import { ABANDONED_AFTER_MS } from '@/server/missions/task-worker-service';
import { createHarness, type TestHarness } from '../helpers/services';

/**
 * Taking work back from a worker that stopped reporting — and refusing it when it comes back.
 *
 * ## The hole this closes
 *
 * There was no reclaim path for a task. A worker that crashed after claiming held its task, its
 * run and its write lease for ever: the task never left `claimed`, so it counted against every
 * concurrency ceiling, and the lease blocked every later writer on the same files. One crash and
 * that part of the factory was shut until a person noticed and intervened by hand.
 *
 * ## Why these run against the real database
 *
 * Every claim in this area is a claim about *simultaneity* — two workers reaching for one row, a
 * reclaim racing a report, a stale run id arriving after a new one was issued. None of that can be
 * demonstrated with a stubbed repository, because the thing under test is the exclusion the
 * database provides. So these use the real schema, the real `claimNext` (a `FOR UPDATE SKIP
 * LOCKED` claim), the real state machine, and real concurrency: `Promise.all`, not a loop.
 */

const CLAIMABLE_ROLES = ['researcher', 'investigator', 'builder', 'verifier', 'reviewer'];

describe('reclaiming a crashed worker’s task', () => {
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

  /**
   * A mission with an owner-approved task graph, built the way a person builds one.
   *
   * Deliberately through the services rather than the routes: what is under test is the claim and
   * reclaim path, and a route harness would add a session, a cookie jar and a `next/headers` mock
   * without changing a single assertion.
   */
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

  /**
   * A worker that has enrolled *and* reported in, which is what production looks like.
   *
   * A real worker heartbeats before it ever asks for work, so a test whose workers never beat
   * would be proving reclaim against the "never seen" case only — the easiest one — and would say
   * nothing about the case that actually happens.
   */
  async function enrol(name: string): Promise<string> {
    const { worker } = await harness.services.workerService.enrol(name, 2);
    await beat(worker.id);
    return worker.id;
  }

  async function beat(workerId: string): Promise<void> {
    await harness.services.workerService.poll(workerId, {
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
  }

  it('never hands the same task to two workers reaching for it at the same instant', async () => {
    await missionWithApprovedGraph();

    const workers = await Promise.all(
      ['racer-a', 'racer-b', 'racer-c', 'racer-d'].map((name) => enrol(name)),
    );

    /*
     * Actual concurrency. Four claims issued together against a graph with fewer ready tasks than
     * claimants, so at least one of them must come back empty — and none of them may come back
     * with a task another already holds.
     */
    const assignments = await Promise.all(
      workers.map((workerId) =>
        harness.services.taskWorkerService.claimTask(workerId, CLAIMABLE_ROLES),
      ),
    );

    const granted = assignments.filter((assignment) => assignment !== null);
    expect(granted.length).toBeGreaterThan(0);
    const taskIds = granted.map((assignment) => assignment!.taskId);
    expect(new Set(taskIds).size).toBe(taskIds.length);
    const runIds = granted.map((assignment) => assignment!.runId);
    expect(new Set(runIds).size).toBe(runIds.length);

    /* And the rows agree: one active run per claimed task, each on a different worker. */
    const active = await harness.services.tasks.listActive();
    expect(active).toHaveLength(granted.length);
    expect(new Set(active.map((task) => task.activeRunId)).size).toBe(granted.length);
    expect(new Set(active.map((task) => task.assignedWorkerId)).size).toBe(granted.length);
  }, 60_000);

  it('leaves a worker that is merely slow alone', async () => {
    await missionWithApprovedGraph();
    const workerId = await enrol('steady');
    const assignment = await harness.services.taskWorkerService.claimTask(
      workerId,
      CLAIMABLE_ROLES,
    );
    expect(assignment).not.toBeNull();

    /*
     * Past the point where Jarvis stops calling a worker connected, and nowhere near the point
     * where it takes its work away. This gap is the whole safety margin: a restart, a closed lid
     * or a flaky home connection crosses the first line routinely, and a reclaim that fired there
     * would run the same task twice.
     */
    advance(ABANDONED_AFTER_MS / 2);
    expect(await harness.services.taskWorkerService.reclaimAbandoned()).toEqual({
      reclaimed: 0,
      failed: 0,
      leasesReleased: 0,
    });

    const task = await harness.services.tasks.findById(assignment!.taskId);
    expect(task?.activeRunId).toBe(assignment!.runId);
    expect(task?.assignedWorkerId).toBe(workerId);
  }, 60_000);

  it('takes the task back, hands it to another worker, and refuses the first worker’s late report', async () => {
    const missionId = await missionWithApprovedGraph();

    const crashed = await enrol('crashes-after-claiming');
    const rescuer = await enrol('picks-it-up');

    const first = await harness.services.taskWorkerService.claimTask(crashed, CLAIMABLE_ROLES);
    expect(first).not.toBeNull();

    /* It got as far as saying it had started, and then said nothing ever again. */
    for (const taskState of ['preparing', 'running']) {
      await harness.services.taskWorkerService.reportTaskState(crashed, {
        runId: first!.runId,
        taskId: first!.taskId,
        taskState,
        currentAction: 'Reading the repository',
      });
    }

    advance(ABANDONED_AFTER_MS + 60_000);
    /* The rescuer is alive and reporting; only the crashed worker has gone quiet. */
    await beat(rescuer);

    const summary = await harness.services.taskWorkerService.reclaimAbandoned();
    expect(summary.reclaimed).toBe(1);
    expect(summary.failed).toBe(0);

    /* The task is claimable again, holding nothing. */
    const reclaimedTask = await harness.services.tasks.findById(first!.taskId);
    expect(reclaimedTask?.state).toBe('ready');
    expect(reclaimedTask?.activeRunId).toBeNull();
    expect(reclaimedTask?.assignedWorkerId).toBeNull();

    /* The abandoned run is closed honestly rather than left looking live for ever. */
    const oldRun = await harness.services.missionRuns.findById(first!.runId);
    expect(oldRun?.state).toBe('failed');
    expect(oldRun?.failureCode).toBe('worker_lost');

    /* And an owner can see it happened, from Operations, without opening the mission. */
    const visible = await harness.services.missionEvents.recent({
      limit: 10,
      actors: ['system'],
      levels: ['warning'],
    });
    expect(
      visible.some(
        (event) => event.missionId === missionId && event.summary.includes(first!.taskKey),
      ),
    ).toBe(true);

    /* A second worker picks it up, on a run of its own. */
    const second = await harness.services.taskWorkerService.claimTask(rescuer, CLAIMABLE_ROLES);
    expect(second).not.toBeNull();
    expect(second!.taskId).toBe(first!.taskId);
    expect(second!.runId).not.toBe(first!.runId);

    /*
     * The fence. The first worker wakes up and reports its results against the run it was given,
     * which is no longer the task's active run — so it is refused rather than allowed to write
     * over the worker that now holds the task.
     */
    await expect(
      harness.services.taskWorkerService.reportTaskState(crashed, {
        runId: first!.runId,
        taskId: first!.taskId,
        taskState: 'succeeded',
        completionSummary: 'All done — from a worker nobody is listening to any more.',
      }),
    ).rejects.toBeInstanceOf(ConflictError);

    /* Nothing it said landed: the task is still the second worker's. */
    const afterLateReport = await harness.services.tasks.findById(first!.taskId);
    expect(afterLateReport?.activeRunId).toBe(second!.runId);
    expect(afterLateReport?.assignedWorkerId).toBe(rescuer);
  }, 60_000);

  it('ends a task that has no attempts left rather than looping on it', async () => {
    await missionWithApprovedGraph();
    const workerId = await enrol('serial-crasher');

    /*
     * Crash, reclaim, crash again. The grace is one, so the second crash on the same task must end
     * it rather than hand it out a third time — an unstable machine cannot make Jarvis spend the
     * night starting the same work over and over.
     */
    const first = await harness.services.taskWorkerService.claimTask(workerId, CLAIMABLE_ROLES);
    expect(first).not.toBeNull();
    advance(ABANDONED_AFTER_MS + 60_000);
    expect((await harness.services.taskWorkerService.reclaimAbandoned()).reclaimed).toBe(1);

    const second = await harness.services.taskWorkerService.claimTask(workerId, CLAIMABLE_ROLES);
    expect(second?.taskId).toBe(first!.taskId);
    advance(ABANDONED_AFTER_MS + 60_000);
    expect((await harness.services.taskWorkerService.reclaimAbandoned()).failed).toBe(1);

    const ended = await harness.services.tasks.findById(first!.taskId);
    expect(ended?.state).toBe('failed');
    expect(ended?.failureCode).toBe('worker_lost');
    expect(ended?.reclaimCount).toBe(2);

    /* And it is not handed out again. */
    const third = await harness.services.taskWorkerService.claimTask(workerId, CLAIMABLE_ROLES);
    expect(third?.taskId ?? null).not.toBe(first!.taskId);
  }, 60_000);
});
