import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createHarness, type TestHarness } from '../helpers/services';
import { ReasoningWorkerHarness } from '../helpers/reasoning-worker';
import { RecordingProvisioner } from '../helpers/recording-provisioner';

/**
 * Blake's exact exchange, through the real conversation service.
 *
 * ## What happened before
 *
 * He described a student budget app, I assessed it and asked questions, and he answered all of them
 * in one message ending "Lock this as the final V1, but do not build it yet." The reply was
 * "Nothing, then. Understood. Nothing has been started…" — every decision discarded, because one
 * field was carrying both what he asked for and what he forbade, and the prohibition won.
 *
 * These tests follow the whole path: the answers are recorded against the standing proposal, the
 * settled V1 comes back, nothing is created, the decisions survive a reload with no client state,
 * and a later "Go ahead" builds what he decided rather than what I had guessed.
 */

const IDEA =
  'I have an idea for a student budget app that tracks recurring bills and weekly spending. ' +
  'Is this worth building? Do not build it yet.';

const ANSWERS =
  'Use US dollars. Look ahead until my next known income date, with six weeks as the fallback. ' +
  'Treat entered income as after-tax, so no tax feature in V1. An override lasts only for the ' +
  'current week. Do not track rollover separately; recalculate from the current balance each week. ' +
  'I will re-enter my bank balance weekly, so remove expense tracking. Lock this as the final V1, ' +
  'but do not build it yet.';

describe('answering every question in one message', () => {
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

  /** Describe the idea, and let the scripted worker return an assessment with a V1. */
  const proposeAndAssess = async () => {
    const first = await harness.services.conversation.handle({ message: IDEA });
    expect(first.proposal, 'the idea opened a proposal').not.toBeNull();

    await worker.answerNext({
      likelyUser: 'A student whose money runs out before the month does.',
      problem: 'Not knowing how much is left to spend this week.',
      verdict: 'Worth a weekend.',
      smallestV1: ['A weekly spendable number', 'A list of recurring bills'],
      assumptions: ['It runs on a phone'],
      uncertainties: ['Whether bills change often'],
      questions: ['Which currency?', 'How far ahead should it look?'],
      basis: 'reasoned',
    });

    return first.proposal!;
  };

  it('records the answers instead of throwing the message away', async () => {
    const proposal = await proposeAndAssess();

    const turn = await harness.services.conversation.handle({
      message: ANSWERS,
      context: {
        actions: [],
        proposal: { id: proposal.id, summary: proposal.summary },
        lastJarvisTurn: null,
        focusedProjectId: null,
        awaitingAnswer: false,
      },
    });

    expect(turn.kind).toBe('refine');
    /* The sentence that used to come back, and must never come back again. */
    expect(turn.said.toLowerCase()).not.toContain('nothing, then');
    expect(turn.noBuildYet).toBe(true);

    const stored = await harness.services.proposals.findById(proposal.id);
    expect(stored?.answers).toHaveLength(6);
    expect(stored?.answers.join(' ')).toContain('no tax feature in V1');
    /* The instruction about the proposal is not stored as a fact about the product. */
    expect(stored?.answers.join(' ')).not.toContain('Lock this as the final V1');
    expect(stored?.scopeLockedAt).not.toBeNull();
  });

  it('says what the first version now is, and keeps it standing', async () => {
    const proposal = await proposeAndAssess();
    const turn = await harness.services.conversation.handle({
      message: ANSWERS,
      context: {
        actions: [],
        proposal: { id: proposal.id, summary: proposal.summary },
        lastJarvisTurn: null,
        focusedProjectId: null,
        awaitingAnswer: false,
      },
    });

    /* The settled scope, said back. */
    expect(turn.said).toContain('settled');
    expect(turn.said.toLowerCase()).toContain('go ahead');
    /* Still on the table, so the next "go ahead" has something to accept. */
    expect(turn.proposal?.id).toBe(proposal.id);
  });

  it('creates nothing at all', async () => {
    const proposal = await proposeAndAssess();
    await harness.services.conversation.handle({
      message: ANSWERS,
      context: {
        actions: [],
        proposal: { id: proposal.id, summary: proposal.summary },
        lastJarvisTurn: null,
        focusedProjectId: null,
        awaitingAnswer: false,
      },
    });

    expect(await harness.services.projects.listAllForAssessment(true)).toHaveLength(0);
    expect(await harness.services.missionRepo.listOpen()).toHaveLength(0);
    expect(github.created, 'no repository was created').toHaveLength(0);
  });

  it('remembers the decisions after a reload, with no client state at all', async () => {
    const proposal = await proposeAndAssess();
    await harness.services.conversation.handle({
      message: ANSWERS,
      context: {
        actions: [],
        proposal: { id: proposal.id, summary: proposal.summary },
        lastJarvisTurn: null,
        focusedProjectId: null,
        awaitingAnswer: false,
      },
    });

    /*
     * What a page load does: no context, no cached proposal, only what the table says. The browser
     * snapshot is a cache; the row is the truth.
     */
    const reloaded = await harness.services.proposals.latestOpen();
    expect(reloaded?.id).toBe(proposal.id);
    expect(reloaded?.answers).toHaveLength(6);
  });

  it('builds what he decided when he finally says go ahead', async () => {
    const proposal = await proposeAndAssess();
    await harness.services.conversation.handle({
      message: ANSWERS,
      context: {
        actions: [],
        proposal: { id: proposal.id, summary: proposal.summary },
        lastJarvisTurn: null,
        focusedProjectId: null,
        awaitingAnswer: false,
      },
    });

    const go = await harness.services.conversation.handle({
      message: 'Go ahead',
      context: {
        actions: [],
        proposal: { id: proposal.id, summary: proposal.summary },
        lastJarvisTurn: null,
        focusedProjectId: null,
        awaitingAnswer: false,
      },
      ownerLogin: 'test-owner',
    });

    expect(go.started, 'the mission was created').not.toBeNull();

    const mission = await harness.services.missionRepo.findById(go.started!.missionId);
    /*
     * The whole point. Every decision he made is a constraint on the mission — this field was `[]`,
     * so the answers were dropped at exactly the moment they started to matter, and what got built
     * was what I had guessed.
     */
    expect(mission?.constraints.join(' ')).toContain('US dollars');
    expect(mission?.constraints.join(' ')).toContain('no tax feature in V1');
    /* And the standing instruction says they override the assessed list. */
    expect(mission?.rawRequest).toContain('already decided');
  });

  it('answers a spoken refinement the same way it answers a typed one', async () => {
    const proposal = await proposeAndAssess();

    /*
     * Through the voice gate, which is where speaking and typing used to diverge: a refinement was
     * classified without context, found nothing to refine, and was answered by the query router —
     * which touches no proposal. It looked the same from the outside and did less.
     */
    const submitted = await harness.services.voiceService.submit({
      transcript: ANSWERS,
    });
    expect(submitted.intent).toBe('conversation');
    /* The read-back promises what actually happens, rather than "I will start this". */
    expect(submitted.consequence.toLowerCase()).toContain('nothing will be created');

    await harness.services.voiceService.confirm(
      submitted.capture.id,
      { text: ANSWERS, shownIntent: submitted.intent },
      { actor: 'test-owner', actorKind: 'owner' },
    );

    const stored = await harness.services.proposals.findById(proposal.id);
    expect(stored?.answers, 'speaking recorded the same decisions').toHaveLength(6);
    expect(await harness.services.missionRepo.listOpen()).toHaveLength(0);
  });

  it('still throws the idea away when he really does dismiss it', async () => {
    const proposal = await proposeAndAssess();
    const turn = await harness.services.conversation.handle({
      message: 'Never mind, dismiss it.',
      context: {
        actions: [],
        proposal: { id: proposal.id, summary: proposal.summary },
        lastJarvisTurn: null,
        focusedProjectId: null,
        awaitingAnswer: false,
      },
    });

    expect(turn.kind).toBe('decline');
    expect(turn.said.toLowerCase()).toContain('nothing');
    expect(await harness.services.missionRepo.listOpen()).toHaveLength(0);
  });
});
