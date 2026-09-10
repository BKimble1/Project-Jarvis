import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createHarness, type TestHarness } from '../helpers/services';

/**
 * The promotion nobody was going to make.
 *
 * ## What was missing
 *
 * `MissionOrchestrator.tick` is the only thing that moves a task graph on: it releases the next
 * wave, materialises a repair round, and decides when a mission is finished. Every caller of it is
 * an event — a worker claiming a task, a worker reporting one finished, a reviewer's verdict, an
 * owner pressing something in the interface. Grepping the tree for callers found no timer.
 *
 * That is sufficient exactly as long as every unit of work ends by reporting itself. The cases
 * where it does not are the ones worth worrying about, and they are not exotic: a terminal report
 * refused by the control plane, a process killed between finishing and reporting, a task released
 * by a ceiling sweep with nothing behind it. In each the graph is left one promotion short. The
 * mission still looks active, no error is recorded anywhere, and nothing in the system was ever
 * going to supply the missing tick. From the outside Jarvis has gone quiet.
 *
 * ## What this test does
 *
 * It makes exactly that state, deliberately, by finishing a task through the repository rather than
 * through the report route — because the report route ticks, and going through it would prove
 * nothing. Then it asserts the successor is still waiting, runs the sweep, and asserts the graph
 * moved.
 *
 * The last case is the one that keeps the sweep honest: on a healthy graph it must change nothing.
 */
describe('a mission left one promotion short', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await createHarness();
  });

  afterEach(async () => {
    await harness.close();
  });

  /** A mission with an owner-approved task graph, built through the services a person uses. */
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

  const tasksOf = async (missionId: string) => {
    const mission = await harness.services.missionRepo.findById(missionId);
    const graph = await harness.services.graphs.byVersion(
      missionId,
      mission?.approvedGraphVersion ?? 1,
    );
    if (!graph) throw new Error('the graph should exist by now');
    return harness.services.tasks.listByGraph(graph.id);
  };

  it('moves on when the sweep runs, having been stuck without it', async () => {
    const missionId = await missionWithApprovedGraph();

    const before = await tasksOf(missionId);
    const wave = before.filter((task) => task.state === 'ready');
    expect(wave.length, 'the approved graph released a first wave').toBeGreaterThan(0);

    /*
     * Finish the whole wave the way a lost report leaves it: the rows say succeeded, and nothing
     * ticked. Going through `reportTaskState` would tick, and prove nothing at all. It has to be
     * the whole wave, because a graph with a task still ready is not yet waiting on a promotion.
     */
    for (const task of wave) {
      await harness.services.tasks.transition(task.id, 'running', {}, 'ready');
      await harness.services.tasks.transition(task.id, 'succeeded', {}, 'running');
    }

    const stuck = await tasksOf(missionId);
    expect(
      stuck.filter((task) => task.state === 'ready' || task.state === 'running'),
      'nothing is runnable, and nothing promoted the next wave',
    ).toEqual([]);
    expect(
      stuck.some((task) => task.state === 'blocked' || task.state === 'draft'),
      'there is more of the graph waiting behind it',
    ).toBe(true);

    const sweep = await harness.services.orchestrator.sweepActive();
    expect(sweep.failed, 'the sweep completed cleanly').toBe(0);
    expect(sweep.swept, 'and it looked at the mission').toBeGreaterThan(0);

    const after = await tasksOf(missionId);
    const movedOn =
      after.some((task) => task.state === 'ready') ||
      after.filter((task) => task.state === 'succeeded').length >
        stuck.filter((task) => task.state === 'succeeded').length;
    expect(movedOn, 'the sweep supplied the promotion nobody else was going to').toBe(true);
  });

  it('changes nothing on a graph that is already moving', async () => {
    const missionId = await missionWithApprovedGraph();
    const before = await tasksOf(missionId);

    const sweep = await harness.services.orchestrator.sweepActive();
    expect(sweep.failed).toBe(0);

    const after = await tasksOf(missionId);
    expect(
      after.map((task) => `${task.key}:${task.state}`).sort(),
      'a healthy graph is left exactly as it was',
    ).toEqual(before.map((task) => `${task.key}:${task.state}`).sort());
  });

  it('reports nothing to sweep when no mission is active', async () => {
    const sweep = await harness.services.orchestrator.sweepActive();
    expect(sweep).toEqual({ swept: 0, failed: 0 });
  });
});
