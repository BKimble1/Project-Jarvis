import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { MissionPlanContent } from '@/domain/mission-plan';
import type { MissionTask, TaskState } from '@/domain/mission-task';
import { AGENT_ROLES } from '@/domain/agent-role';
import { projectInputSchema } from '@/domain/project';
import { WORKER_VERSION } from '@/domain/worker-protocol';
import { PARKED_TASK_STATES } from '@/server/missions/orchestrator';
import { createHarness, type TestHarness } from '../helpers/services';

/**
 * How a mission ends, and what may not start one.
 *
 * ## The two ways a mission used to stop without ending
 *
 * `reflectMissionState` asked "is every task terminal?" and, if so, "is the mission running?".
 * Neither question is the one that matters, and each had a shape the owner actually hit:
 *
 *  - **The running sink.** A review scheduled a repair round, which parked the builder in
 *    `repair_required` and created a repair task. The repair failed, delivery became unreachable
 *    and was failed, and every other task finished. Nothing in Jarvis moves a task out of
 *    `repair_required` — so "every task is terminal" was never true, the mission stayed `running`
 *    for ever, and the owner's account of it was that Jarvis "went quiet". The same shape appears
 *    when a reviewer comes back `unavailable`: the work it was reviewing is parked in
 *    `awaiting_review` and the only thing that ever moves it, a verdict, is never coming.
 *  - **The queued sink.** Every task failed before a worker claimed one, so the mission was still
 *    `queued`. Nothing terminal in `reflectMissionState` looked at `queued` at all, and
 *    `queued → failed` sat unused in the transition table.
 *  - **The sink one edge upstream**, found while re-checking the first fix for it. Ruling on each
 *    task by itself is not enough, because a task blocked behind a parked one is neither promoted
 *    nor failed by `tick` and so is stuck too. One worker report of `running → awaiting_review`
 *    reaches it, which makes it the most reachable of the three.
 *
 * ## And the pause that did not pause
 *
 * The Pause button says "Work already running finishes or stops safely. Nothing new begins." The
 * mission claim path read no operating mode at all, so a mission already `queued` when the owner
 * pressed Pause — or Emergency stop — was handed to the next worker that asked, and a real agent
 * session started.
 *
 * These run against the real migrated database for the reason `lease-reclaim` does: what is being
 * asserted is what the *rows* say afterwards, and a stubbed repository would be asserting the stub.
 */

const PLAN: MissionPlanContent = {
  summary: 'Tidy the invoice importer',
  proposedOutcome: 'A draft pull request tidying the invoice importer.',
  assumptions: [],
  scope: ['Rename two functions in the importer'],
  outOfScope: ['Merging the pull request.'],
  affectedAreas: ['src/invoices.ts'],
  approach: 'Rename the two functions and add a regression test.',
  dataMigrations: [],
  testsToAddOrUpdate: ['Importer unit tests'],
  verification: [
    {
      command: 'npm test',
      purpose: 'Run the suite.',
      source: 'package_script',
      expectedUnavailableReason: null,
    },
  ],
  uiValidation: [],
  risks: [],
  rollback: 'Close the pull request and delete the branch.',
  acceptanceCriteria: ['The importer is tidier and the suite is green.'],
  openQuestions: [],
  estimatedComplexity: 'small',
  withinRequestedScope: true,
  scopeNotes: null,
  reviewOnlyDelivery: true,
  evidenceIds: [],
  repositoryFacts: {},
};

const HEARTBEAT = {
  status: 'idle' as const,
  version: WORKER_VERSION,
  runtimeAvailable: true,
  workspaceHealthy: true,
  githubDeliveryConfigured: true,
  diagnostics: [],
};

describe('missions that can no longer move', () => {
  let harness: TestHarness;
  let now: Date;
  let counter = 0;

  beforeEach(async () => {
    now = new Date('2026-06-01T09:00:00.000Z');
    harness = await createHarness({ clock: () => now });
  });

  afterEach(async () => {
    await harness.close();
  });

  /**
   * A queued mission with an owner-approved task graph, built the way a person builds one.
   *
   * Deliberately the deterministic decomposition rather than a playbook: it produces the five-task
   * shape both sinks were found in — builder, integration, verification, review, delivery — and the
   * review is linked to the builder it reviews, which is what makes the parked states reachable.
   */
  async function queuedMissionWithGraph(): Promise<{
    missionId: string;
    tasks: readonly MissionTask[];
  }> {
    counter += 1;
    const project = await harness.services.projects.create(
      projectInputSchema.parse({ name: `Endings ${counter}`, type: 'software' }),
    );
    await harness.services.sources.addGithubSource(project.id, {
      owner: 'test-owner',
      repo: `endings-${counter}`,
      isPrimary: true,
    });

    const mission = await harness.services.missionRepo.create({
      rawRequest: 'Tidy the invoice importer.',
      title: `Tidy the invoice importer ${counter}`,
      type: 'code_change',
      priority: 'medium',
      riskLevel: 'low',
      riskRuleIds: [],
      riskReasons: [],
      ownerLogin: 'owner',
      state: 'planning',
      constraints: [],
      doNotTouch: [],
      acceptanceCriteria: [],
      projectId: project.id,
    });
    await harness.services.missions.storePlan(
      mission,
      PLAN,
      'jarvis_deterministic',
      'verified',
      null,
    );
    await harness.services.missions.approvePlan(
      mission.id,
      { planVersion: 1, acknowledgedRiskLevel: 'low', pausedProjectOverride: false },
      'owner',
    );

    const proposal = await harness.services.orchestrator.proposeGraph(mission.id, {});
    await harness.services.orchestrator.approveGraph(
      mission.id,
      { graphVersion: proposal.graph.version, fingerprint: proposal.graph.fingerprint },
      'owner',
    );

    const tasks = await harness.services.tasks.listByMission(mission.id);
    expect((await harness.services.missionRepo.findById(mission.id))?.state).toBe('queued');
    return { missionId: mission.id, tasks };
  }

  /**
   * Put the graph into a given shape directly.
   *
   * Through the repository rather than through the services on purpose: every one of these shapes
   * is one a *real* run reaches, but reaching them through the review machinery would take a
   * worker, a runtime and a model, and would test that machinery rather than the ending rule that
   * is under test here.
   */
  async function shape(
    tasks: readonly MissionTask[],
    states: Readonly<Record<string, TaskState>>,
  ): Promise<void> {
    for (const task of tasks) {
      const to = states[task.key];
      if (!to || to === task.state) continue;
      const moved = await harness.services.tasks.transition(task.id, to, {}, task.state);
      expect(moved, `could not put ${task.key} into ${to}`).not.toBeNull();
    }
  }

  const stateOf = async (missionId: string): Promise<string | undefined> =>
    (await harness.services.missionRepo.findById(missionId))?.state;

  /**
   * The running sink, in the shape it was reproduced in.
   *
   * Five ticks used to change nothing: `repair_required` is neither terminal nor blocked nor
   * ready, so `anyRunning` stayed true, `allDone` never became true, and not one terminal branch
   * could fire. Five ticks here rather than one because that is what the reproduction did, and
   * because a rule that only works on the tick that happens to see the last task change is not a
   * rule — the sweep has to reach the same answer every time it looks.
   */
  it('ends a mission whose builder is parked in repair_required for ever', async () => {
    const { missionId, tasks } = await queuedMissionWithGraph();
    await shape(tasks, {
      t1: 'repair_required',
      t2: 'succeeded',
      t3: 'succeeded',
      t4: 'succeeded',
      t5: 'failed',
    });

    for (let round = 0; round < 5; round += 1) {
      await harness.services.orchestrator.tick(missionId);
    }

    expect(await stateOf(missionId)).toBe('failed');

    /* And it ends with a receipt, so the owner gets the same account of it as any other ending. */
    expect(await harness.services.receipts.findByMission(missionId)).not.toBeNull();
  }, 60_000);

  /**
   * The same sink from the other side: a reviewer that could not review.
   *
   * `applyVerdict` fails the review task when a verdict comes back `unavailable`, which leaves the
   * work it was reviewing in `awaiting_review` with nothing left that could ever move it.
   */
  it('ends a mission whose work is parked in awaiting_review with no reviewer left', async () => {
    const { missionId, tasks } = await queuedMissionWithGraph();
    await shape(tasks, {
      t1: 'awaiting_review',
      t2: 'succeeded',
      t3: 'succeeded',
      t4: 'failed',
      t5: 'failed',
    });

    await harness.services.orchestrator.tick(missionId);

    expect(await stateOf(missionId)).toBe('failed');
  }, 60_000);

  /**
   * The queued sink: nothing was ever claimed, so the mission never became `running`.
   *
   * `queued → failed` has always been in the transition table and was never used.
   */
  it('ends a mission every one of whose tasks failed before it started', async () => {
    const { missionId, tasks } = await queuedMissionWithGraph();
    await shape(tasks, {
      t1: 'failed',
      t2: 'failed',
      t3: 'failed',
      t4: 'failed',
      t5: 'failed',
    });

    await harness.services.orchestrator.tick(missionId);

    expect(await stateOf(missionId)).toBe('failed');
    expect(await harness.services.receipts.findByMission(missionId)).not.toBeNull();
  }, 60_000);

  /**
   * The line the ending rule must not cross.
   *
   * A task waiting on the owner looks exactly like a parked one to anything counting terminal
   * states — it is not terminal, not blocked and not ready — and ending the mission would throw
   * away the question Jarvis is waiting for an answer to. This is the assertion that keeps "no task
   * can make progress" from quietly becoming "no task is moving right now".
   */
  for (const waiting of ['waiting_for_input', 'waiting_for_permission'] as const) {
    it(`does not end a mission whose only live task is ${waiting}`, async () => {
      const { missionId, tasks } = await queuedMissionWithGraph();
      await shape(tasks, {
        t1: waiting,
        t2: 'succeeded',
        t3: 'succeeded',
        t4: 'succeeded',
        t5: 'failed',
      });

      for (let round = 0; round < 3; round += 1) {
        await harness.services.orchestrator.tick(missionId);
      }

      expect(await stateOf(missionId)).toBe('running');
    }, 60_000);
  }

  /**
   * A parked task is not on its own an ending.
   *
   * The builder sits in `repair_required` for the whole of a *successful* repair round, and in
   * `awaiting_review` for as long as its reviewer takes — so an ending rule that fired on the
   * parked task alone would end the mission in the middle of the work it just scheduled.
   *
   * Driven from `PARKED_TASK_STATES` rather than a literal list, so a state added to it inherits
   * this guard instead of quietly acquiring the power to end a mission on its own.
   */
  for (const parked of PARKED_TASK_STATES) {
    it(`does not end a mission on a ${parked} task while another task can still run`, async () => {
      const { missionId, tasks } = await queuedMissionWithGraph();
      await shape(tasks, { t1: parked, t2: 'succeeded', t3: 'running' });

      for (let round = 0; round < 3; round += 1) {
        await harness.services.orchestrator.tick(missionId);
      }

      expect(await stateOf(missionId)).toBe('running');
    }, 60_000);
  }

  /**
   * The same sink one hop upstream, which is where a rule about single tasks goes wrong.
   *
   * A task *waiting on* a parked one is exactly as stuck as the parked one: `tick` promotes a
   * `blocked` task only when every dependency is `succeeded` or `skipped`, and fails one only when a
   * dependency is `failed`, `stopped` or `cancelled`. A parked dependency is neither, so the waiter
   * is never promoted and never failed, and an ending rule that reads `blocked` as "something could
   * still happen here" keeps the mission alive on the strength of a task that cannot move either.
   *
   * The shape is one report away from the happy path. `running → awaiting_review` is a transition
   * the wire schema accepts and the table lets a *worker* make, and in the decomposed graph
   * integration, verification, review and delivery all sit downstream of the builder — so one such
   * report parks the builder and blocks the other four behind it, with the only reviewer that could
   * unpark it among them. Today's `task-runner` does not send it, which is why this is written as a
   * property of the ending rule rather than as a bug report: the rule may not depend on the worker
   * confining itself to the states it currently uses.
   *
   * Deliberately touches one task and leaves the rest where approval put them, because the point is
   * that no second event is needed: nothing here is a state a test had to contrive.
   */
  it('ends a mission whose remaining tasks are all blocked behind a parked one', async () => {
    const { missionId, tasks } = await queuedMissionWithGraph();
    await shape(tasks, { t1: 'awaiting_review' });

    for (let round = 0; round < 3; round += 1) {
      await harness.services.orchestrator.tick(missionId);
    }

    expect(await stateOf(missionId)).toBe('failed');
    expect(await harness.services.receipts.findByMission(missionId)).not.toBeNull();
  }, 60_000);

  /**
   * The ending that already worked, kept working.
   *
   * Delivery succeeding is what makes a mission `pull_request_ready`, and it has to keep winning
   * over the new rule — a builder left parked in `repair_required` by a repair round that then
   * went on to deliver must not turn a delivered mission into a failed one.
   */
  it('still reaches pull_request_ready when delivery succeeded, parked task or not', async () => {
    const { missionId, tasks } = await queuedMissionWithGraph();
    await shape(tasks, {
      t1: 'repair_required',
      t2: 'succeeded',
      t3: 'succeeded',
      t4: 'succeeded',
      t5: 'succeeded',
    });

    await harness.services.orchestrator.tick(missionId);

    expect(await stateOf(missionId)).toBe('pull_request_ready');
  }, 60_000);
});

describe('claiming a mission while Jarvis is not starting work', () => {
  let harness: TestHarness;
  let now: Date;
  let counter = 0;

  beforeEach(async () => {
    now = new Date('2026-06-02T09:00:00.000Z');
    harness = await createHarness({ clock: () => now });
  });

  afterEach(async () => {
    await harness.close();
  });

  async function queuedMission(): Promise<string> {
    counter += 1;
    const project = await harness.services.projects.create(
      projectInputSchema.parse({ name: `Paused ${counter}`, type: 'software' }),
    );
    await harness.services.sources.addGithubSource(project.id, {
      owner: 'test-owner',
      repo: `paused-${counter}`,
      isPrimary: true,
    });
    const mission = await harness.services.missionRepo.create({
      rawRequest: 'Tidy the invoice importer.',
      title: `Tidy the invoice importer ${counter}`,
      type: 'code_change',
      priority: 'medium',
      riskLevel: 'low',
      riskRuleIds: [],
      riskReasons: [],
      ownerLogin: 'owner',
      state: 'planning',
      constraints: [],
      doNotTouch: [],
      acceptanceCriteria: [],
      projectId: project.id,
    });
    await harness.services.missions.storePlan(
      mission,
      PLAN,
      'jarvis_deterministic',
      'verified',
      null,
    );
    await harness.services.missions.approvePlan(
      mission.id,
      { planVersion: 1, acknowledgedRiskLevel: 'low', pausedProjectOverride: false },
      'owner',
    );
    expect((await harness.services.missionRepo.findById(mission.id))?.state).toBe('queued');
    return mission.id;
  }

  async function enrol(name: string): Promise<string> {
    const { worker } = await harness.services.workerService.enrol(name, 2);
    return worker.id;
  }

  /**
   * Move the mode, taking a legal route.
   *
   * `off → paused` is not in the transition table — a deployment that is off is already not
   * starting anything, so pausing it is not a move anybody makes — so a test that wants a paused
   * Jarvis has to start it first, exactly as an owner would.
   */
  const setMode = async (to: 'supervised' | 'paused' | 'emergency_stop'): Promise<void> => {
    const from = (await harness.services.operatorState.get()).mode;
    if (to === 'paused' && from === 'off') {
      await harness.services.charterService.setMode({
        to: 'supervised',
        actor: 'owner',
        changedBy: 'owner',
      });
    }
    await harness.services.charterService.setMode({ to, actor: 'owner', changedBy: 'owner' });
  };

  /*
   * The reproduction. Emergency stop, then a worker asks for work, and a real agent session begins
   * on a mission the owner has just told Jarvis to stop.
   */
  it('hands out nothing while an emergency stop is in force', async () => {
    const missionId = await queuedMission();
    await setMode('emergency_stop');
    const workerId = await enrol('stopped-worker');

    const assignment = await harness.services.workerService.claim(workerId, {
      heartbeat: HEARTBEAT,
      accepts: ['execution'],
    });

    expect(assignment).toBeNull();
    expect((await harness.services.missionRepo.findById(missionId))?.state).toBe('queued');
    expect((await harness.services.missionRepo.findById(missionId))?.claimedByWorkerId).toBeNull();
  }, 60_000);

  it('hands out nothing while paused', async () => {
    const missionId = await queuedMission();
    await setMode('paused');
    const workerId = await enrol('paused-worker');

    expect(
      await harness.services.workerService.claim(workerId, {
        heartbeat: HEARTBEAT,
        accepts: ['execution'],
      }),
    ).toBeNull();
    expect((await harness.services.missionRepo.findById(missionId))?.state).toBe('queued');
  }, 60_000);

  /*
   * The other claim path, which the mission gate on its own made *worse*.
   *
   * The worker's work loop calls `claimAndRun` and, the moment that returns nothing, falls straight
   * through to `claimAndRunTask` — a different route, a different service, and originally no mode
   * gate at all. So a paused Jarvis stopped handing out missions and went on handing out task agent
   * sessions, reaching that path sooner than before the gate existed. This is the same test as the
   * one above, one protocol over.
   */
  it('hands out no task while paused either', async () => {
    const missionId = await queuedMission();
    const proposal = await harness.services.orchestrator.proposeGraph(missionId, {});
    await harness.services.orchestrator.approveGraph(
      missionId,
      { graphVersion: proposal.graph.version, fingerprint: proposal.graph.fingerprint },
      'owner',
    );
    const workerId = await enrol('paused-task-worker');

    await setMode('paused');
    expect(
      await harness.services.taskWorkerService.claimTask(workerId, [...AGENT_ROLES]),
    ).toBeNull();

    /*
     * And then the same call again once the mode is back, which is what makes the assertion above
     * about the mode rather than about an empty queue: the task was claimable the whole time.
     */
    await setMode('supervised');
    expect(
      await harness.services.taskWorkerService.claimTask(workerId, [...AGENT_ROLES]),
    ).not.toBeNull();
  }, 60_000);

  /*
   * And `off` is deliberately not one of them.
   *
   * `off` is the mode a deployment that has never been configured is in — it is the schema default
   * for `operator_state.mode`, and only the hands-off setup screen ever moves a deployment off it.
   * Refusing to claim in it would mean a fresh install where the owner asks for something in chat
   * gets a mission that is created, planned, approved, queued, and then never claimed by anybody,
   * with no message saying why. See `beginsNoNewWork` for why that costs nothing in safety: the
   * loop cannot propose in `off`, so everything queued there was queued because the owner asked.
   */
  it('still runs what the owner asked for on a deployment nobody has configured', async () => {
    const missionId = await queuedMission();
    const workerId = await enrol('off-worker');

    expect((await harness.services.operatorState.get()).mode).toBe('off');
    const assignment = await harness.services.workerService.claim(workerId, {
      heartbeat: HEARTBEAT,
      accepts: ['execution'],
    });
    expect(assignment).not.toBeNull();
    expect(assignment?.missionId).toBe(missionId);
  }, 60_000);

  /*
   * The other half of the gate, and the half that makes it a gate rather than a wall: the queue is
   * not drained, poisoned or failed by a pause. It is still there when the owner comes back.
   */
  it('hands the same mission out again once the mode is back to normal', async () => {
    const missionId = await queuedMission();
    await setMode('paused');
    const workerId = await enrol('resumed-worker');
    const service = harness.services.workerService;

    expect(
      await service.claim(workerId, { heartbeat: HEARTBEAT, accepts: ['execution'] }),
    ).toBeNull();

    await setMode('supervised');

    const assignment = await service.claim(workerId, {
      heartbeat: HEARTBEAT,
      accepts: ['execution'],
    });
    expect(assignment).not.toBeNull();
    expect(assignment?.missionId).toBe(missionId);
    expect((await harness.services.missionRepo.findById(missionId))?.state).toBe('claimed');
  }, 60_000);

  /*
   * "Work already running finishes or stops safely." A worker that already holds a run polls the
   * same endpoint to get it back, and refusing it there would strand a live agent session rather
   * than let it finish — which is the opposite of what the button promises.
   */
  it('still returns the run a worker is already holding after a pause', async () => {
    const missionId = await queuedMission();
    await setMode('supervised');
    const workerId = await enrol('mid-flight-worker');
    const service = harness.services.workerService;

    const first = await service.claim(workerId, { heartbeat: HEARTBEAT, accepts: ['execution'] });
    expect(first).not.toBeNull();

    await setMode('paused');

    const again = await service.claim(workerId, { heartbeat: HEARTBEAT, accepts: ['execution'] });
    expect(again?.runId).toBe(first?.runId);
    expect(again?.missionId).toBe(missionId);
  }, 60_000);
});
