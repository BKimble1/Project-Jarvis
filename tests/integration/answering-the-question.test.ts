import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createHarness, type TestHarness } from '../helpers/services';
import { RecordingProvisioner } from '../helpers/recording-provisioner';

/**
 * The question Jarvis asks, answered where it was asked.
 *
 * ## What was measured before this
 *
 * A first message describing something to build creates the project and the mission and then asks
 * one question — "Before I start: How will you know this is done and right?" — in the
 * conversation, which is the only place the owner is looking. Typing the answer back did nothing
 * useful: `interpretMessage` reads an ordinary sentence as a question, the status router looked
 * for a project by that name, and the reply was "No matching project. Projects you have:
 * Lanterns." The one question Jarvis had just asked was the one sentence it could not hear, and
 * the only way to answer it was to leave the conversation for the mission screen.
 *
 * Driven through the real `ConversationService`, the real `MissionService` and a real database.
 * Nothing is stubbed but the repository provisioner, which would otherwise reach GitHub.
 */
describe('answering the question Jarvis asked', () => {
  let harness: TestHarness;
  let github: RecordingProvisioner;

  beforeEach(async () => {
    github = new RecordingProvisioner();
    harness = await createHarness({ repositoryProvisioner: github });
  });

  afterEach(async () => {
    await harness.close();
  });

  /** The context the screen sends once Jarvis's last line was a question. */
  const answering = {
    actions: [],
    proposal: null,
    lastJarvisTurn: null,
    focusedProjectId: null,
    awaitingAnswer: true,
  } as const;

  const askedSomething = async () => {
    const turn = await harness.services.conversation.handle({
      message: 'Build a tiny app called Lanterns that shows one quotation a day.',
      ownerLogin: 'test-owner',
    });
    expect(turn.said, 'the fixture needs Jarvis to have asked something').toMatch(/\?$/);
    expect(turn.started).not.toBeNull();
    return turn.started!.missionId;
  };

  it('records the reply against the question and moves on to planning', async () => {
    const missionId = await askedSomething();

    const answered = await harness.services.conversation.handle({
      message: 'It is done when a quotation shows on load and changes each day.',
      ownerLogin: 'test-owner',
      context: answering,
    });

    expect(answered.said, answered.said).toMatch(/planning/i);
    expect(answered.href).toBe(`/missions/${missionId}`);

    const detail = await harness.services.missions.detail(missionId);
    expect(detail.clarifications.filter((record) => record.answeredAt === null)).toHaveLength(0);
    expect(detail.clarifications[0]?.answer).toContain('changes each day');
    /* Answered by the owner, in the owner's words — never recorded as an assumption Jarvis made. */
    expect(detail.clarifications[0]?.answerProvenance).toBe('manual');
    expect(detail.mission.state, 'the mission is being planned, not still waiting').not.toBe(
      'needs_clarification',
    );
  }, 60_000);

  /*
   * The half that keeps it honest. Without the flag the same sentence is a fresh question, because
   * that is what it looks like — and a person who types one while a mission happens to be waiting
   * must still get an answer to what they asked rather than have their words filed as a
   * requirement.
   */
  it('does not file an ordinary question as an answer', async () => {
    const missionId = await askedSomething();

    await harness.services.conversation.handle({
      message: 'What needs me?',
      ownerLogin: 'test-owner',
    });

    const detail = await harness.services.missions.detail(missionId);
    expect(detail.clarifications.filter((record) => record.answeredAt === null)).toHaveLength(1);
  }, 60_000);

  /*
   * And a flag with nothing behind it. The snapshot comes from the browser, so the database is
   * what decides whether there is a question at all — a stale or tampered flag falls through to
   * the ordinary answer rather than inventing something to answer.
   */
  it('falls through when nothing is actually waiting', async () => {
    const turn = await harness.services.conversation.handle({
      message: 'It is done when a quotation shows on load.',
      ownerLogin: 'test-owner',
      context: answering,
    });

    expect(turn.said).not.toMatch(/planning/i);
    expect(turn.answer, 'it is answered as the question it looks like').not.toBeNull();
  }, 60_000);

  /*
   * Two missions waiting is the case where guessing would put the owner's words against the wrong
   * one, where whatever plans it would read them as a requirement. It says which two instead.
   */
  it('asks which one when more than one question is open', async () => {
    await askedSomething();
    await harness.services.conversation.handle({
      message: 'Build a tiny app called Beacons that shows one photograph a day.',
      ownerLogin: 'test-owner',
    });

    const turn = await harness.services.conversation.handle({
      message: 'It is done when it shows something new each day.',
      ownerLogin: 'test-owner',
      context: answering,
    });

    expect(turn.said).toMatch(/more than one/i);
    expect(turn.said).toContain('Lanterns');
    expect(turn.said).toContain('Beacons');
  }, 60_000);
});
