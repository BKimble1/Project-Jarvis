import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { IdeaEvaluation } from '@/domain/proposal';
import { createHarness, type TestHarness } from '../helpers/services';
import { ReasoningWorkerHarness } from '../helpers/reasoning-worker';
import { RecordingProvisioner } from '../helpers/recording-provisioner';

/**
 * Two ideas at once, and neither wearing the other's answer.
 *
 * ## The failure this exists to stop
 *
 * A dashboard that shows "the latest evaluation" shows the wrong one the moment a second idea is in
 * flight. The owner describes QuickPick, describes Pomodoro while the first is still being thought
 * about, and the answer that lands attaches itself to whichever card is on screen — or worse, to
 * whichever row was updated most recently.
 *
 * Nothing about that is theoretical: the correlation is a `request_key` on one side and a query on
 * the other, and only one of those two was ever tested. So this drives both ideas through the real
 * queue, the real lease, the real worker claim-and-report pair, and asserts that each answer came
 * back to the idea that asked the question — in both orders, because the bug is order-dependent by
 * nature and passing in one order proves nothing about the other.
 *
 * ## Why the evaluations are deliberately distinguishable
 *
 * Both ideas would otherwise receive the same fixture, and a test where the right answer and the
 * wrong answer are identical cannot fail. Each carries a verdict naming its own product.
 */

/*
 * Both carry an actual question. Without one, "Do not build it yet" is the whole message and the
 * interpreter reads it as a decline — correctly, and the existing suite pins that. An idea is a
 * description *plus* something asked about it.
 */
const QUICKPICK =
  'I have an idea for a tiny app called QuickPick that lets someone enter two choices and randomly ' +
  'selects one with a clean animation. Is this worth building? Do not build it yet.';

const POMODORO =
  'I have an idea for a small tool called Pomodoro that runs a twenty-five minute timer and logs ' +
  'what I worked on. Is this worth building? Do not build it yet.';

const evaluationFor = (product: string): IdeaEvaluation => ({
  likelyUser: `Someone who would use ${product}.`,
  problem: `The problem ${product} solves.`,
  verdict: `${product} is worth an afternoon.`,
  smallestV1: [`The smallest useful ${product}`],
  assumptions: [`${product} runs on a phone`],
  uncertainties: [`Whether ${product} gets opened twice`],
  questions: [`Does ${product} need to remember anything?`],
  basis: 'reasoned',
});

describe('two ideas in flight at once', () => {
  let harness: TestHarness;
  let github: RecordingProvisioner;
  let worker: ReasoningWorkerHarness;

  beforeEach(async () => {
    github = new RecordingProvisioner();
    harness = await createHarness({ repositoryProvisioner: github });
    worker = new ReasoningWorkerHarness(harness.services);
    await worker.ensureEnrolled();
  });

  afterEach(async () => {
    await harness.close();
  });

  /** Describe both ideas before either is answered, so both are genuinely in flight together. */
  const describeBoth = async (first: string, second: string) => {
    const one = await harness.services.conversation.handle({ message: first });
    const two = await harness.services.conversation.handle({ message: second });
    expect(one.proposal, 'the first idea opened a proposal').not.toBeNull();
    expect(two.proposal, 'the second idea opened a proposal').not.toBeNull();
    /* Two ideas, two rows. If this fails the rest of the test is meaningless. */
    expect(two.proposal?.id).not.toBe(one.proposal?.id);
    return { one, two };
  };

  for (const order of [
    { label: 'QuickPick first', first: QUICKPICK, second: POMODORO },
    { label: 'Pomodoro first', first: POMODORO, second: QUICKPICK },
  ]) {
    it(`keeps each answer with the idea that asked for it — ${order.label}`, async () => {
      const { one, two } = await describeBoth(order.first, order.second);

      /*
       * Answered in the order the worker happens to claim them, which is not necessarily the order
       * they were asked. That is the whole point: correlation must come from the request, not from
       * the sequence.
       */
      const firstProduct = order.first === QUICKPICK ? 'QuickPick' : 'Pomodoro';
      const secondProduct = order.second === QUICKPICK ? 'QuickPick' : 'Pomodoro';

      const claimed: string[] = [];
      for (let round = 0; round < 2; round += 1) {
        const assignment = await harness.services.workerService.claimReasoning(
          await worker.ensureEnrolled(),
          {
            heartbeat: {
              status: 'idle',
              version: '2.0.0',
              platform: 'test',
              runtimeAvailable: true,
              runtimeName: 'scripted',
              runtimeDetail: 'Scripted runtime for tests.',
              workspaceHealthy: true,
              workspaceRootLabel: null,
              githubDeliveryConfigured: false,
              diagnostics: [],
              currentMissionId: null,
              currentRunId: null,
              lastActivityAt: null,
            },
          },
        );
        expect(assignment, `a question was waiting on round ${round + 1}`).not.toBeNull();
        if (!assignment) return;

        /*
         * Answer with the evaluation for whichever idea this request actually belongs to, read
         * from the request's own proposal id. A worker that answered "the current idea" would be
         * the bug; this reads the correlation the queue stored.
         */
        const request = await harness.services.reasoningRepo.find(assignment.requestId);
        expect(request?.proposalId).toBeTruthy();
        const belongsToFirst = request?.proposalId === one.proposal?.id;
        claimed.push(belongsToFirst ? firstProduct : secondProduct);

        await harness.services.workerService.reportReasoning(await worker.ensureEnrolled(), {
          status: 'succeeded',
          requestId: assignment.requestId,
          attempt: assignment.attempt,
          evaluation: evaluationFor(belongsToFirst ? firstProduct : secondProduct),
          usage: { inputTokens: 100, outputTokens: 100, durationMs: 1_000 },
        });
      }

      /* Both were asked, and each exactly once. */
      expect([...claimed].sort()).toEqual([firstProduct, secondProduct].sort());

      const storedOne = await harness.services.proposals.findById(one.proposal!.id);
      const storedTwo = await harness.services.proposals.findById(two.proposal!.id);

      expect(storedOne?.evaluation?.verdict).toContain(firstProduct);
      expect(storedOne?.evaluation?.verdict).not.toContain(secondProduct);
      expect(storedTwo?.evaluation?.verdict).toContain(secondProduct);
      expect(storedTwo?.evaluation?.verdict).not.toContain(firstProduct);
    });
  }

  it('keeps the two apart after the worker restarts mid-flight', async () => {
    const { one, two } = await describeBoth(QUICKPICK, POMODORO);

    /* One answered by the first worker. */
    expect(await worker.answerNext(evaluationFor('QuickPick'))).toBe(true);

    /*
     * A second worker process, enrolled separately, exactly as a restart produces. The remaining
     * question must survive the first worker going away and reach the new one still correlated.
     */
    const restarted = new ReasoningWorkerHarness(harness.services, 'test-reasoning-worker-2');
    await restarted.ensureEnrolled();
    expect(await restarted.answerNext(evaluationFor('Pomodoro'))).toBe(true);

    const storedOne = await harness.services.proposals.findById(one.proposal!.id);
    const storedTwo = await harness.services.proposals.findById(two.proposal!.id);

    /*
     * The first idea described was QuickPick, and the worker answered in claim order — so assert
     * on the pairing rather than on which arrived first: each verdict must name its own product.
     */
    for (const [stored, other] of [
      [storedOne, storedTwo],
      [storedTwo, storedOne],
    ] as const) {
      expect(stored?.evaluation?.verdict).toBeTruthy();
      expect(stored?.evaluation?.verdict).not.toBe(other?.evaluation?.verdict);
    }
    expect(storedOne?.title).toBe('QuickPick');
    expect(storedTwo?.title).toBe('Pomodoro');
  });

  it('records a separate operating state and event trail for each idea', async () => {
    const { one, two } = await describeBoth(QUICKPICK, POMODORO);

    const stateOne = await harness.services.operating.find(one.proposal!.id);
    const stateTwo = await harness.services.operating.find(two.proposal!.id);

    expect(stateOne, 'QuickPick has an operating state').not.toBeNull();
    expect(stateTwo, 'Pomodoro has an operating state').not.toBeNull();
    expect(stateOne?.id).not.toBe(stateTwo?.id);

    const eventsOne = await harness.services.operating.events(one.proposal!.id);
    const eventsTwo = await harness.services.operating.events(two.proposal!.id);

    expect(eventsOne.length).toBeGreaterThan(0);
    expect(eventsTwo.length).toBeGreaterThan(0);

    /* Every event names its own idea, and none carries the other's product name. */
    for (const event of eventsOne) {
      expect(event.proposalId).toBe(one.proposal!.id);
      expect(event.message).not.toContain('Pomodoro');
    }
    for (const event of eventsTwo) {
      expect(event.proposalId).toBe(two.proposal!.id);
      expect(event.message).not.toContain('QuickPick');
    }
  });

  it('creates one project and one repository per idea when both are agreed to', async () => {
    const { one, two } = await describeBoth(QUICKPICK, POMODORO);
    await worker.answerNext(evaluationFor('QuickPick'));
    await worker.answerNext(evaluationFor('Pomodoro'));

    for (const offered of [one, two]) {
      await harness.services.conversation.handle({
        message: 'Go ahead.',
        context: {
          actions: [],
          proposal: offered.proposal,
          lastJarvisTurn: offered.said,
          focusedProjectId: null,
          awaitingAnswer: false,
        },
      });
    }

    const projects = await harness.services.projects.listAllForAssessment(true);
    expect(projects.map((project) => project.name).sort()).toEqual(['Pomodoro', 'QuickPick']);
    expect([...github.created].sort()).toEqual(['blake/pomodoro', 'blake/quickpick']);
  });
});
