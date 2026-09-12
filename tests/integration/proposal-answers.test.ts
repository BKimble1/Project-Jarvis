import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildBrief } from '@/domain/build-brief';
import { createHarness, type TestHarness } from '../helpers/services';
import { RecordingProvisioner } from '../helpers/recording-provisioner';

/**
 * The decisions Blake makes about a proposal, and whether they survive to the thing that gets built.
 *
 * ## What was being lost
 *
 * He describes an idea, I ask a few questions, and he answers them — the currency, the horizon,
 * whether tax is in scope, how long an override lasts. Those answers *are* the scope. The mission
 * created by "Go ahead" was passing `constraints: []`, so every one of them was dropped at the
 * exact moment it started to matter, and what got built was what I had guessed rather than what he
 * had decided. That is the "it forgot what we agreed" failure, arriving one step later than the
 * last time it was fixed.
 *
 * These tests are about the whole path: recorded, kept apart from what I assumed, surviving a
 * reload, and reaching the mission.
 */
describe('the decisions Blake makes about a proposal', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await createHarness({ repositoryProvisioner: new RecordingProvisioner() });
  });

  afterEach(async () => {
    await harness.close();
  });

  const openProposal = async () =>
    harness.services.proposals.open({
      fingerprint: `budget-${Math.random().toString(36).slice(2, 8)}`,
      title: 'StudentBudget',
      idea: 'A simple student budget app.',
      summary: 'Start StudentBudget and build the smallest useful version.',
      evaluation: null,
      openQuestions: ['Which currency?', 'How far ahead should it look?'],
      recommendedV1: ['A weekly total'],
      assumptions: ['It runs on a phone'],
      now: new Date(),
    });

  it('keeps what he decided apart from what I assumed', async () => {
    const proposal = await openProposal();
    const updated = await harness.services.proposals.recordAnswers(proposal.id, {
      answers: ['Use US dollars.', 'Treat entered income as after-tax, so no tax feature in V1.'],
      lockScope: false,
      now: new Date(),
    });

    expect(updated?.answers).toEqual([
      'Use US dollars.',
      'Treat entered income as after-tax, so no tax feature in V1.',
    ]);
    /*
     * Untouched. `assumptions` is what I took on trust when nobody had said, and folding his
     * answers into it would lose the distinction exactly where it matters — at "Go ahead", when
     * one of them is a decision and the other is a guess.
     */
    expect(updated?.assumptions).toEqual(['It runs on a phone']);
  });

  it('appends across turns rather than replacing, because he answers a few at a time', async () => {
    const proposal = await openProposal();
    await harness.services.proposals.recordAnswers(proposal.id, {
      answers: ['Use US dollars.'],
      lockScope: false,
      now: new Date(),
    });
    const after = await harness.services.proposals.recordAnswers(proposal.id, {
      answers: ['An override lasts only for the current week.'],
      lockScope: true,
      now: new Date(),
    });

    expect(after?.answers).toHaveLength(2);
    expect(after?.scopeLockedAt).not.toBeNull();
  });

  it('does not record the same decision twice when he says it again', async () => {
    const proposal = await openProposal();
    await harness.services.proposals.recordAnswers(proposal.id, {
      answers: ['Use US dollars.'],
      lockScope: false,
      now: new Date(),
    });
    /* Said again because nothing appeared to happen — which is a thing people do. */
    const after = await harness.services.proposals.recordAnswers(proposal.id, {
      answers: ['use us dollars.', 'Six weeks as the fallback.'],
      lockScope: false,
      now: new Date(),
    });

    expect(after?.answers).toEqual(['Use US dollars.', 'Six weeks as the fallback.']);
  });

  it('survives re-describing the idea, which used to empty everything it touched', async () => {
    const proposal = await openProposal();
    await harness.services.proposals.recordAnswers(proposal.id, {
      answers: ['Use US dollars.'],
      lockScope: false,
      now: new Date(),
    });

    /* The same fingerprint: describing the idea again updates the row rather than making a second. */
    await harness.services.proposals.open({
      fingerprint: proposal.fingerprint,
      title: 'StudentBudget',
      idea: 'A simple student budget app, described again.',
      summary: 'Start StudentBudget and build the smallest useful version.',
      evaluation: null,
      openQuestions: [],
      recommendedV1: [],
      assumptions: [],
      now: new Date(),
    });

    const reloaded = await harness.services.proposals.findById(proposal.id);
    expect(reloaded?.answers, 'a re-describe must not forget what he decided').toEqual([
      'Use US dollars.',
    ]);
  });

  it('reads the decisions back after a reload, from the row alone', async () => {
    const proposal = await openProposal();
    await harness.services.proposals.recordAnswers(proposal.id, {
      answers: ['Use US dollars.', 'Six weeks as the fallback.'],
      lockScope: true,
      now: new Date(),
    });

    /* No client state, no cache: the id, and what the table says about it. */
    const reloaded = await harness.services.proposals.findById(proposal.id);
    expect(reloaded?.answers).toHaveLength(2);
    expect(reloaded?.scopeLockedAt).not.toBeNull();
  });

  it('refuses a decision that arrives after go-ahead', async () => {
    const proposal = await openProposal();
    const project = await harness.services.projects.create({
      name: 'StudentBudget',
      shortName: null,
      description: null,
      type: 'software',
      status: 'active',
      phase: 'Starting',
      goal: 'Build it.',
      priority: 'medium',
      tags: [],
      links: [],
    });
    await harness.services.proposals.accept(proposal.id, {
      projectId: project.id,
      missionId: null,
      repositoryFullName: null,
      now: new Date(),
    });

    /*
     * Late to a decision already taken. Rewriting the proposal now would change the record of what
     * was agreed to after the fact — the same rule `recordEvaluation` follows.
     */
    const refused = await harness.services.proposals.recordAnswers(proposal.id, {
      answers: ['Actually, use euros.'],
      lockScope: false,
      now: new Date(),
    });
    expect(refused).toBeNull();
  });

  it('carries the decisions into what actually gets built', async () => {
    const proposal = await openProposal();
    const updated = await harness.services.proposals.recordAnswers(proposal.id, {
      answers: [
        'Use US dollars.',
        'Treat entered income as after-tax, so no tax feature in V1.',
        'Do not track rollover separately; recalculate from the current balance each week.',
      ],
      lockScope: true,
      now: new Date(),
    });

    const brief = buildBrief(updated!);

    expect(brief.constraints).toHaveLength(3);
    /*
     * In the objective, labelled as decisions and placed after the criteria — so a builder reads
     * "no tax feature in V1" as a boundary rather than as something to go and build.
     */
    expect(brief.objective).toContain('already decided');
    expect(brief.objective).toContain('no tax feature in V1');
    /* And never the conversational message itself. That mistake produced a project called "Yet". */
    expect(brief.objective).not.toContain('described again');
  });
});
