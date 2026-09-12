import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { reasoningRequestKey } from '@/domain/reasoning';
import { createHarness, type TestHarness } from '../helpers/services';
import { ReasoningWorkerHarness } from '../helpers/reasoning-worker';
import { RecordingProvisioner } from '../helpers/recording-provisioner';

/**
 * The answer on screen is the answer to the message that was sent.
 *
 * ## The morning this comes from
 *
 * Blake typed, on the dashboard:
 *
 *     "Evaluate this idea: a simple student budget app that tracks recurring bills, weekly
 *      spending, and how much income I need each month. Give me your assessment and the smallest
 *      useful V1. Do not build anything yet."
 *
 * and read back a paragraph about running fewer missions in parallel. It looked exactly like stale
 * context — an old operator message answering a new turn — and it was not. `\bbudget\b` was a word
 * in the pattern that recognises "conserve my Claude allowance", so a *budgeting app* was read as
 * an instruction to slow down, and the pace answer it produced was correct for the message the
 * interpreter thought it had.
 *
 * That is the third time one bug has appeared: a rule reading a single word out of a sentence that
 * was about something else. It named a project "Yet" from "Do not build anything yet", it read a
 * plan's promise *not* to merge as an intention to merge, and here it heard a request for advice as
 * an order. So the first test below pins the sentence itself, and the ones after it pin the
 * property that would have contained the damage: an answer belongs to one turn and cannot be shown
 * for another.
 */

const BUDGET_IDEA =
  'Evaluate this idea: a simple student budget app that tracks recurring bills, weekly spending, ' +
  'and how much income I need each month. Give me your assessment and the smallest useful V1. ' +
  'Do not build anything yet.';

const HABIT_IDEA =
  'Evaluate this idea: a tiny habit tracker that shows a single streak number and nothing else. ' +
  'Give me your assessment and the smallest useful V1. Do not build anything yet.';

describe('an answer and the turn that asked for it', () => {
  let harness: TestHarness;
  let worker: ReasoningWorkerHarness;

  beforeEach(async () => {
    harness = await createHarness({ repositoryProvisioner: new RecordingProvisioner() });
    worker = new ReasoningWorkerHarness(harness.services);
    await worker.ensureEnrolled();
  });

  afterEach(async () => {
    await harness.close();
  });

  it('sends the worker the exact words that were submitted', async () => {
    const turn = await harness.services.conversation.handle({ message: BUDGET_IDEA });
    expect(turn.proposal, 'the idea opened a proposal').not.toBeNull();

    const request = await harness.services.reasoningRepo.findByKey(
      reasoningRequestKey('idea_evaluation', turn.proposal!.id),
    );

    /*
     * The prompt is built from this row and nothing else — no conversation history, no operator
     * status, no capacity message. If the submitted words are here, they are what the model reads.
     */
    expect(request?.input.kind).toBe('idea_evaluation');
    const asked = JSON.stringify(request?.input ?? {});
    expect(asked).toContain('recurring bills');
    expect(asked).toContain('weekly spending');
    /* And nothing from anywhere else. */
    expect(asked).not.toContain('missions running in parallel');
  });

  it('replaces the prompt of a question nobody has picked up yet', async () => {
    /*
     * Said once, then said again more fully because nothing appeared to happen. The proposal keeps
     * the newer description — and the *question the worker is asked* has to keep it too. It did
     * not: the row kept whichever text arrived first, so the assessment answered the earlier one.
     */
    const first = await harness.services.conversation.handle({
      message:
        'Evaluate this idea: a student budget app. Give me your assessment. Do not build anything yet.',
    });
    const second = await harness.services.conversation.handle({
      message: BUDGET_IDEA,
    });
    expect(second.proposal?.id, 'the same subject, so the same proposal').toBe(first.proposal?.id);

    const request = await harness.services.reasoningRepo.findByKey(
      reasoningRequestKey('idea_evaluation', second.proposal!.id),
    );
    expect(JSON.stringify(request?.input ?? {})).toContain('recurring bills');
  });

  it('leaves the prompt alone once a worker is reading it', async () => {
    await harness.services.conversation.handle({
      message:
        'Evaluate this idea: a student budget app. Give me your assessment. Do not build anything yet.',
    });

    /* Claimed: the words are on another machine now. */
    const assignment = await harness.services.workerService.claimReasoning(
      await worker.ensureEnrolled(),
      { heartbeat: HEARTBEAT },
    );
    expect(assignment).not.toBeNull();

    await harness.services.conversation.handle({ message: BUDGET_IDEA });

    const request = await harness.services.reasoningRepo.find(assignment!.requestId);
    /*
     * Unchanged, deliberately. Rewriting a claimed prompt would store an answer against text that
     * was never sent — the same dishonesty, better hidden.
     */
    expect(JSON.stringify(request?.input ?? {})).not.toContain('recurring bills');
  });

  it('keeps two answers apart and does not let either wear the other', async () => {
    const budget = await harness.services.conversation.handle({ message: BUDGET_IDEA });
    const habit = await harness.services.conversation.handle({ message: HABIT_IDEA });
    expect(habit.proposal?.id).not.toBe(budget.proposal?.id);

    for (const round of [0, 1]) {
      const assignment = await harness.services.workerService.claimReasoning(
        await worker.ensureEnrolled(),
        { heartbeat: HEARTBEAT },
      );
      expect(assignment, `a question was waiting on round ${round + 1}`).not.toBeNull();

      const request = await harness.services.reasoningRepo.find(assignment!.requestId);
      const isBudget = request?.proposalId === budget.proposal!.id;
      await harness.services.workerService.reportReasoning(await worker.ensureEnrolled(), {
        status: 'succeeded',
        requestId: assignment!.requestId,
        attempt: assignment!.attempt,
        evaluation: {
          likelyUser: isBudget ? 'A student with bills.' : 'Someone building a habit.',
          problem: isBudget ? 'Money runs out before the month does.' : 'Streaks are motivating.',
          verdict: isBudget
            ? 'The budget app is worth a weekend.'
            : 'The habit tracker is worth an evening.',
          smallestV1: [isBudget ? 'Recurring bills' : 'One streak number'],
          assumptions: [],
          uncertainties: [],
          questions: [],
          basis: 'reasoned',
        },
        usage: { inputTokens: 10, outputTokens: 10, durationMs: 5 },
      });
    }

    const storedBudget = await harness.services.proposals.findById(budget.proposal!.id);
    const storedHabit = await harness.services.proposals.findById(habit.proposal!.id);

    expect(storedBudget?.evaluation?.verdict).toContain('budget');
    expect(storedBudget?.evaluation?.verdict).not.toContain('habit');
    expect(storedHabit?.evaluation?.verdict).toContain('habit');
    expect(storedHabit?.evaluation?.verdict).not.toContain('budget');
  });

  it('finds the same answer again after a reload, by proposal', async () => {
    const turn = await harness.services.conversation.handle({ message: BUDGET_IDEA });
    expect(
      await worker.answerNext({
        likelyUser: 'A student with bills.',
        problem: 'Money runs out before the month does.',
        verdict: 'The budget app is worth a weekend.',
        smallestV1: ['Recurring bills'],
        assumptions: [],
        uncertainties: [],
        questions: [],
        basis: 'reasoned',
      }),
    ).toBe(true);

    /*
     * What a page load does: no client state, only the proposal id, read back through the same key
     * the request was written under.
     */
    const after = await harness.services.reasoningService.statusForProposal(turn.proposal!.id);
    expect(after?.state).toBe('ready');
    if (after?.state === 'ready') {
      expect(after.evaluation.verdict).toContain('budget');
    }
  });

  it('creates no project, repository or mission while the message says not to build', async () => {
    await harness.services.conversation.handle({ message: BUDGET_IDEA });
    await harness.services.conversation.handle({ message: HABIT_IDEA });

    const projects = await harness.services.projects.listAllForAssessment(false);
    const missions = await harness.services.missionRepo.listOpen();
    expect(projects, 'nothing was created from an idea that forbade building').toEqual([]);
    expect(missions).toEqual([]);
  });
});

const HEARTBEAT = {
  status: 'idle' as const,
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
};
