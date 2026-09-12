import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readsLikeAConversation } from '@/domain/build-brief';
import { createHarness, type TestHarness } from '../helpers/services';
import { ReasoningWorkerHarness } from '../helpers/reasoning-worker';
import { RecordingProvisioner } from '../helpers/recording-provisioner';

/**
 * The second QuickPick failure: the one that produced a project called "Yet".
 *
 * The conversation, verbatim from the session:
 *
 *   Blake — "Re-evaluate my QuickPick idea using Claude: two choices, one randomly selected with a
 *            clean animation. Give your assessment and the smallest useful V1. Do not build
 *            anything yet."
 *   Jarvis — evaluated it.
 *   Blake — "Go ahead."
 *   Jarvis — created a project called **Yet**, reported the private repository **BKimble1/yet**,
 *            reused the evaluation request as the mission objective, and asked whether he wanted
 *            it researched or implemented.
 *
 * Four separate defects in one turn, each pinned below:
 *
 *  1. `deriveProjectName` read the prohibition "Do not build anything yet" as the naming clause —
 *     the only creation verb in the message was the `build` he was forbidding.
 *  2. The agreed V1 was wiped from the proposal every time the idea was re-described, so the
 *     mission was created with no acceptance criteria.
 *  3. Acceptance passed the *evaluation request* as the mission's objective.
 *  4. That objective contained "Re-evaluate" and "build", which is exactly the pair `R-CL5` reads
 *     as ambiguous — hence "researched and reported, or actually implemented?".
 *
 * The message is kept word-for-word. Tidying it would test a sentence nobody typed, which is how
 * the existing QuickPick suite passed while this failed: its fixture says "called QuickPick", and
 * the literal phrase "called" takes a different branch entirely.
 */
const EVALUATION_REQUEST =
  'Re-evaluate my QuickPick idea using Claude: two choices, one randomly selected with a clean ' +
  'animation. Give your assessment and the smallest useful V1. Do not build anything yet.';

/** The same idea, said differently. One idea must not become two proposals. */
const SAME_IDEA_RESAID =
  'What do you think of my QuickPick idea? Two choices, one picked at random, with a clean ' +
  'animation. Do not build it yet.';

describe('the evaluation-to-build handoff, through the real service', () => {
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

  const counts = async () => ({
    projects: (await harness.services.projects.listAllForAssessment(true)).length,
    missions: (await harness.services.missionRepo.listOpen()).length,
    repositories: github.created.length,
  });

  /** Evaluate, let the worker answer, then agree — the sequence that produced "Yet". */
  const evaluateThenAccept = async (message: string = EVALUATION_REQUEST) => {
    const offered = await harness.services.conversation.handle({ message });
    await worker.answerNext();
    return harness.services.conversation.handle({
      message: 'Go ahead.',
      context: {
        actions: [],
        proposal: offered.proposal,
        lastJarvisTurn: offered.said,
        focusedProjectId: null,
        awaitingAnswer: false,
      },
    });
  };

  it('evaluates without creating anything, and honours "do not build anything yet"', async () => {
    const turn = await harness.services.conversation.handle({ message: EVALUATION_REQUEST });

    expect(turn.kind).toBe('idea');
    expect(turn.noBuildYet).toBe(true);
    expect(turn.started).toBeNull();
    expect(await counts()).toEqual({ projects: 0, missions: 0, repositories: 0 });
  });

  it('keeps the name the owner wrote, and never names anything after the prohibition', async () => {
    const turn = await harness.services.conversation.handle({ message: EVALUATION_REQUEST });
    const stored = await harness.services.proposals.findById(turn.proposal!.id);

    expect(stored?.title).toBe('QuickPick');
    /* The exact regression. "Yet" is the last word of the sentence forbidding the build. */
    expect(stored?.title).not.toBe('Yet');
  });

  it('creates the project as QuickPick and the repository as quickpick', async () => {
    const accepted = await evaluateThenAccept();

    expect(accepted.started).not.toBeNull();
    expect(accepted.started?.projectName).toBe('QuickPick');

    const projects = await harness.services.projects.listAllForAssessment(true);
    expect(projects.map((project) => project.name)).toEqual(['QuickPick']);

    /* Reported to the owner as BKimble1/yet. Here the owner is `blake`. */
    expect(github.created).toEqual(['blake/quickpick']);
    expect(github.created).not.toContain('blake/yet');
  });

  it('gives the mission an implementation objective, not the evaluation request', async () => {
    const accepted = await evaluateThenAccept();
    const mission = await harness.services.missionRepo.findById(accepted.started!.missionId);

    expect(mission).not.toBeNull();
    expect(mission?.title).toContain('QuickPick');
    /*
     * The objective must be about building it, not about judging it.
     *
     * Asserted through `readsLikeAConversation` rather than against a phrase, because the exact
     * opening sentence belongs to whoever composes the brief and this test is not the place to
     * pin their prose. What it does pin is that the request stopped being a replay of the message:
     * no "Re-evaluate", no "Do not build", and it names the product it is meant to produce.
     */
    expect(readsLikeAConversation(mission?.rawRequest ?? '')).toBe(false);
    expect(mission?.rawRequest).not.toContain('Re-evaluate');
    expect(mission?.rawRequest).not.toContain('Do not build');
    expect(mission?.rawRequest).toContain('QuickPick');
    expect(mission?.type).toBe('code_change');
    /* Written on this path now, because the dashboard's result card reads it. */
    expect(mission?.deliverable).toBeTruthy();
  });

  it('carries the agreed V1 across as the definition of done', async () => {
    const offered = await harness.services.conversation.handle({ message: EVALUATION_REQUEST });
    await worker.answerNext();

    const assessed = await harness.services.proposals.findById(offered.proposal!.id);
    expect(assessed?.recommendedV1.length).toBeGreaterThan(0);

    const accepted = await harness.services.conversation.handle({
      message: 'Go ahead.',
      context: {
        actions: [],
        proposal: offered.proposal,
        lastJarvisTurn: offered.said,
        focusedProjectId: null,
        awaitingAnswer: false,
      },
    });
    const mission = await harness.services.missionRepo.findById(accepted.started!.missionId);

    expect(mission?.acceptanceCriteria.length).toBeGreaterThan(0);
    /*
     * Every criterion came from the agreed V1 — not compared as an exact list, because the brief
     * de-duplicates and caps the scope it carries, and that trimming is its business rather than
     * this test's. What matters is that nothing was invented on the way through.
     */
    for (const criterion of mission?.acceptanceCriteria ?? []) {
      expect(assessed?.recommendedV1).toContain(criterion);
    }
  });

  it('does not wipe the agreed V1 when the idea is described again', async () => {
    const offered = await harness.services.conversation.handle({ message: EVALUATION_REQUEST });
    await worker.answerNext();
    const assessed = await harness.services.proposals.findById(offered.proposal!.id);
    expect(assessed?.recommendedV1.length).toBeGreaterThan(0);

    /* Saying it again used to overwrite the assessment's lists with the empty ones. */
    await harness.services.conversation.handle({ message: EVALUATION_REQUEST });

    const after = await harness.services.proposals.findById(offered.proposal!.id);
    expect(after?.recommendedV1).toEqual(assessed?.recommendedV1);
  });

  it('does not ask whether the agreed build should be researched instead', async () => {
    const accepted = await evaluateThenAccept();
    const detail = await harness.services.missions.detail(accepted.started!.missionId);

    const asked = detail.clarifications
      .map((clarification) => `${clarification.question}`.toLowerCase())
      .join(' | ');
    expect(asked).not.toContain('researched and reported');
  });

  it('creates nothing more when "go ahead" is said twice', async () => {
    const offered = await harness.services.conversation.handle({ message: EVALUATION_REQUEST });
    await worker.answerNext();
    const context = {
      actions: [],
      proposal: offered.proposal,
      lastJarvisTurn: offered.said,
      focusedProjectId: null,
      awaitingAnswer: false,
    };

    const first = await harness.services.conversation.handle({ message: 'Go ahead.', context });
    const after = await counts();

    const again = await harness.services.conversation.handle({ message: 'Go ahead.', context });

    expect(await counts()).toEqual(after);
    expect(again.started?.missionId).toBe(first.started?.missionId);
  });

  it('treats the same idea said differently as one proposal, not two', async () => {
    const first = await harness.services.conversation.handle({ message: EVALUATION_REQUEST });
    const second = await harness.services.conversation.handle({ message: SAME_IDEA_RESAID });

    /*
     * Both name QuickPick, so both are about QuickPick. Two open rows would make "go ahead"
     * ambiguous, and accepting each in turn would put two missions on one project.
     */
    expect(second.proposal?.id).toBe(first.proposal?.id);
  });

  it('still creates one project when the idea is re-said and then agreed to', async () => {
    await harness.services.conversation.handle({ message: EVALUATION_REQUEST });
    await worker.answerNext();
    await evaluateThenAccept(SAME_IDEA_RESAID);

    const projects = await harness.services.projects.listAllForAssessment(true);
    expect(projects.map((project) => project.name)).toEqual(['QuickPick']);
    expect(github.created).toEqual(['blake/quickpick']);
  });
});
