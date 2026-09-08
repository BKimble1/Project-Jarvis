import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createHarness, type TestHarness } from '../helpers/services';
import { RecordingProvisioner } from '../helpers/recording-provisioner';
import { ReasoningWorkerHarness, SAMPLE_EVALUATION } from '../helpers/reasoning-worker';

/**
 * From an assessment to a build, on the owner's second live test.
 *
 * ## The conversation, verbatim
 *
 * He asked for a re-evaluation — the message below, word for word — got a real assessment from
 * Claude on his own subscription, and said "Go ahead". What he got was:
 *
 * - a project called **Yet**;
 * - a private repository called **yet**;
 * - a mission whose request was "Re-evaluate my QuickPick idea… Do not build anything yet.";
 * - a question asking whether he wanted that researched or implemented;
 * - and a reply that said work had started when it had not.
 *
 * Five symptoms, two causes. The name was mined out of the sentence telling Jarvis what *not* to
 * do, and the conversational message was handed on as the mission's objective — so a sentence
 * containing both "evaluate" and "build" reopened a question the owner had already answered by
 * saying go ahead.
 *
 * ## What is real here
 *
 * The database, the container, the interpreter, the conversation service, the proposal store, the
 * reasoning queue with a real worker claiming and reporting, the provisioning sequence and the
 * mission service. Only two things are replaced: the model, which answers with a fixed evaluation
 * so the assertions are about the handoff rather than about prose; and GitHub, by
 * `RecordingProvisioner`, which adopts a repository it has already made exactly as the real one
 * does. Whether GitHub itself behaves that way is a live question and is asked in `tests/live`.
 */

const RE_EVALUATE =
  'Re-evaluate my QuickPick idea using Claude: two choices, one randomly selected with a clean ' +
  'animation. Give your assessment and the smallest useful V1. Do not build anything yet.';

describe('an assessed idea becoming a build', () => {
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
    sources: (await harness.services.sources.listAllGithubSources()).length,
    repositories: github.created.length,
  });

  /** Ask, let the worker answer, and return the turn that carries the assessed proposal. */
  async function assessed() {
    const first = await harness.services.conversation.handle({ message: RE_EVALUATE });
    expect(first.thinking?.state).toBe('thinking');
    expect(await worker.answerNext()).toBe(true);

    const ready = await harness.services.conversation.handle({ message: RE_EVALUATE });
    expect(ready.thinking?.state).toBe('ready');
    return ready;
  }

  async function goAhead(turn: Awaited<ReturnType<typeof assessed>>) {
    return harness.services.conversation.handle({
      message: 'Go ahead',
      context: {
        actions: [],
        proposal: turn.proposal,
        lastJarvisTurn: turn.said,
        focusedProjectId: null,
      },
    });
  }

  it('assesses without building, whatever the sentence is mined for', async () => {
    const ready = await assessed();

    expect(ready.evaluation?.basis).toBe('reasoned');
    /* "Do not build anything yet" was honoured, and nothing was named after it. */
    expect(await counts()).toEqual({ projects: 0, missions: 0, sources: 0, repositories: 0 });
    expect(ready.proposal).not.toBeNull();
    expect(JSON.stringify(ready)).not.toMatch(/\byet\b/i);
  });

  it('builds the product the owner named, not the last word of his sentence', async () => {
    const accepted = await goAhead(await assessed());

    const projects = await harness.services.projects.listAllForAssessment(true);
    expect(projects).toHaveLength(1);
    expect(projects[0]?.name).toBe('QuickPick');
    expect(github.created).toEqual(['blake/quickpick']);
    expect(accepted.started?.projectName).toBe('QuickPick');
  });

  it('writes an implementation objective, not a replay of the request', async () => {
    await goAhead(await assessed());

    const missions = await harness.services.missionRepo.listOpen();
    expect(missions).toHaveLength(1);
    const mission = missions[0]!;

    /* None of the conversational wording survives into the standing instruction. */
    expect(mission.rawRequest).not.toContain('Re-evaluate');
    expect(mission.rawRequest).not.toContain('Do not build');
    expect(mission.rawRequest).not.toContain('Give your assessment');

    /* What does survive is what to build, and how anyone would know it was done. */
    expect(mission.rawRequest).toContain('Build the first working version of QuickPick.');
    expect(mission.title).toContain('QuickPick');
    expect(mission.type).toBe('code_change');
    expect(mission.acceptanceCriteria.length).toBeGreaterThan(0);
    for (const item of SAMPLE_EVALUATION.smallestV1) {
      expect(mission.acceptanceCriteria).toContain(item);
    }
  });

  it('does not ask whether an agreed build is research', async () => {
    const accepted = await goAhead(await assessed());

    const missions = await harness.services.missionRepo.listOpen();
    const questions = await harness.services.clarifications.list(missions[0]!.id);
    expect(questions.map((record) => record.question).join(' ')).not.toMatch(
      /researched and reported/i,
    );
    expect(accepted.said).not.toMatch(/researched|report only/i);
  });

  it('says what actually happened, and does not claim work has started', async () => {
    const accepted = await goAhead(await assessed());

    expect(accepted.said).toContain('QuickPick');
    /*
     * The deployment in this harness has no standing authority, so nothing runs until a plan is
     * approved. Saying "Started" there was the claim the owner caught: the project existed, and
     * nothing was under way.
     */
    if (!accepted.started?.planning) {
      expect(accepted.said).not.toMatch(/^Started\b/);
      expect(accepted.said).toMatch(/nothing (?:is|will)/i);
    }
    /* And whatever it says, it points at the thing it made. */
    expect(accepted.href).toContain('/missions/');
  });

  /* ------------------------------------------------------------- idempotence */

  it('says go ahead twice and builds one of everything', async () => {
    const ready = await assessed();

    const first = await goAhead(ready);
    const before = await counts();

    const second = await goAhead(ready);
    /*
     * And a bare yes afterwards, with no page context at all — the phone case. There is no *open*
     * proposal any more, so the honest answer is that there is nothing waiting, not another
     * repository.
     */
    const third = await harness.services.conversation.handle({ message: 'yes please' });

    expect(await counts()).toEqual(before);
    expect(before).toEqual({ projects: 1, missions: 1, sources: 1, repositories: 1 });

    /* The repeats report what exists rather than making more of it. */
    expect(second.said).toMatch(/already/i);
    expect(third.said).toMatch(/do not have anything waiting/i);
    expect(third.started).toBeNull();
    expect(second.started?.missionId).toBe(first.started?.missionId);
    expect(github.requested.filter((name) => name === 'quickpick').length).toBeGreaterThan(0);
    expect(github.created).toEqual(['blake/quickpick']);
  });

  /* ------------------------------------------------------------- other names */

  it('does the same for a name it has never seen', async () => {
    const message =
      'Take a look at my LedgerLite idea: a tiny ledger for a single freelancer. ' +
      'Give me your assessment and the smallest useful V1. Do not build anything yet.';

    const first = await harness.services.conversation.handle({ message });
    expect(first.thinking?.state).toBe('thinking');
    expect(await worker.answerNext()).toBe(true);
    expect(await counts()).toEqual({ projects: 0, missions: 0, sources: 0, repositories: 0 });

    const ready = await harness.services.conversation.handle({ message });
    const accepted = await harness.services.conversation.handle({
      message: 'Go ahead',
      context: {
        actions: [],
        proposal: ready.proposal,
        lastJarvisTurn: ready.said,
        focusedProjectId: null,
      },
    });

    const projects = await harness.services.projects.listAllForAssessment(true);
    expect(projects).toHaveLength(1);
    expect(projects[0]?.name).toBe('LedgerLite');
    expect(github.created).toEqual(['blake/ledgerlite']);
    expect(accepted.started?.projectName).toBe('LedgerLite');

    const missions = await harness.services.missionRepo.listOpen();
    expect(missions[0]?.rawRequest).toContain('Build the first working version of LedgerLite.');
    expect(missions[0]?.rawRequest).not.toContain('Do not build');
  });

  it('can be approved before an assessment arrives, and says the scope is not known', async () => {
    /* Impatience is allowed. Inventing a scope to cover for it is not. */
    const first = await harness.services.conversation.handle({
      message: 'I have an idea for an app called TideChart that shows the tide where you are.',
    });

    const accepted = await goAhead(first);
    const missions = await harness.services.missionRepo.listOpen();

    expect(missions).toHaveLength(1);
    expect(missions[0]?.rawRequest).toContain('Build the first working version of TideChart.');
    expect(missions[0]?.rawRequest).toContain('No assessed scope was agreed');
    expect(missions[0]?.acceptanceCriteria).toEqual([]);
    expect(accepted.started?.projectName).toBe('TideChart');
  });
});
