import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createHarness, type TestHarness } from '../helpers/services';
import { RecordingProvisioner } from '../helpers/recording-provisioner';

/**
 * The evening CampusCountdown became a repository called `private` and then lost its scope.
 *
 * ## What was measured before the fix
 *
 * Blake typed two sentences and both of them went wrong, in two different places, on one journey:
 *
 *  1. `deriveProjectName` read the first message as "a new private project" and returned
 *     **Private**, so `repositorySlug` produced `private` and that is the repository that would
 *     have been created on his account. The `NAMED` reading could end only at a joining word or at
 *     the end of the whole message, and the full stop after "CampusCountdown" is neither — so the
 *     pattern failed outright and the descriptive frame won. Naming is the one reading whose
 *     mistakes are not free: only the owner can delete a repository.
 *  2. Jarvis then asked "How will you know this is done and right?", and his answer — which names
 *     the project in its first four words — was read as an ordinary question, handed to the
 *     status router and answered "no matching project", under a card reading "Project: not yet
 *     chosen" with a button offering to prepare the mission. The definition of done was discarded
 *     and the mission went on waiting for it.
 *
 * The second failure survived a reload in the worst possible way. `awaitingAnswer` is computed in
 * the browser from `turns`, which is React state that starts empty, so after F5 the flag is false
 * and the only thing left pointing at the mission is the name inside the sentence.
 *
 * Driven through the real `ConversationService`, the real `MissionService` and a real database.
 * Nothing is stubbed but the repository provisioner, which would otherwise reach GitHub.
 */

/** What the owner typed first, verbatim. It creates the project and asks the one question. */
const M1 =
  'Build a new private project called CampusCountdown. Create a countdown board for campus events.';

/** What he typed back, verbatim. The first sentence names the project; the second answers. */
const M2 =
  'Continue work on the existing CampusCountdown project. The definition of done is a page that ' +
  'lists each event with a live countdown and updates without a reload.';

describe('the CampusCountdown journey', () => {
  let harness: TestHarness;
  let github: RecordingProvisioner;

  beforeEach(async () => {
    github = new RecordingProvisioner();
    harness = await createHarness({ repositoryProvisioner: github });
  });

  afterEach(async () => {
    await harness.close();
  });

  /** The context the screen sends while the page is open and Jarvis's last line was a question. */
  const answering = {
    actions: [],
    proposal: null,
    lastJarvisTurn: null,
    focusedProjectId: null,
    awaitingAnswer: true,
  } as const;

  /** Send the first message and hand back the mission it left waiting on a question. */
  const askedAboutCampusCountdown = async () => {
    const turn = await harness.services.conversation.handle({
      message: M1,
      ownerLogin: 'test-owner',
    });
    expect(turn.started, 'the first message provisions the project and the mission').not.toBeNull();
    /* Nothing is being planned yet: the mission is waiting on the question Jarvis just asked. */
    expect(turn.started!.planning).toBe(false);
    return turn.started!.missionId;
  };

  const openQuestions = async (missionId: string) => {
    const detail = await harness.services.missions.detail(missionId);
    return detail.clarifications.filter((record) => record.answeredAt === null);
  };

  /**
   * The whole journey, with the page never reloaded.
   *
   * The naming half is asserted here rather than in its own test because the repository is a
   * consequence of the first message and of nothing else: if `deriveProjectName` regresses, the
   * project is called Private and this is where it shows.
   */
  it('names the project the owner named and records the definition of done', async () => {
    const missionId = await askedAboutCampusCountdown();

    const projects = await harness.services.projects.list();
    expect(projects.items.length).toBe(1);
    expect(projects.items[0]?.name, 'the name the owner wrote, not the frame around it').toBe(
      'CampusCountdown',
    );
    /* The repository cannot be taken back once made, so it is asserted on the provisioner. */
    expect(github.requested, 'a repository called `private` is the failure this pins').toEqual([
      'campuscountdown',
    ]);
    expect(github.created).toEqual(['blake/campuscountdown']);

    const answered = await harness.services.conversation.handle({
      message: M2,
      ownerLogin: 'test-owner',
      context: answering,
    });

    /*
     * Not a question any more. `answer` is the status router's panel, and its presence is exactly
     * what the owner saw instead of his answer being recorded.
     */
    expect(answered.answer, 'the reply is filed, not answered as an enquiry').toBeNull();
    expect(answered.said, answered.said).toMatch(/planning/i);
    expect(answered.href).toBe(`/missions/${missionId}`);
    /* The same mission, not a second one started by a sentence beginning "Continue work on…". */
    expect(answered.started?.missionId).toBe(missionId);
    expect(answered.started?.planning, 'the screen refreshes on this and shows it planning').toBe(
      true,
    );

    expect(await openQuestions(missionId)).toHaveLength(0);
    const detail = await harness.services.missions.detail(missionId);
    expect(detail.mission.acceptanceCriteria).toContain(M2);
    expect(detail.clarifications[0]?.answerProvenance, 'the owner decided this, not Jarvis').toBe(
      'manual',
    );
    expect(detail.mission.state, 'being planned, not still waiting').not.toBe(
      'needs_clarification',
    );
  }, 60_000);

  /**
   * The same journey with the page reloaded between the two messages. This is the heart of the fix.
   *
   * There is no `context` argument at all here, and that is not a shortcut: it is exactly what the
   * browser posts after F5. `turns` is React state that starts empty and is restored from nowhere,
   * so `awaitingAnswer` is false, and the old gate — `kind === 'question'` **and**
   * `context.awaitingAnswer` — never reached the code that could have filed the answer. The
   * message went to the status router, came back "no matching project", and the definition of
   * done was gone.
   *
   * The only thing that survives a reload is the name the owner wrote in the sentence, so that is
   * what now binds the reply to the mission.
   */
  it('files the answer after a reload, with no conversation context at all', async () => {
    const missionId = await askedAboutCampusCountdown();

    const answered = await harness.services.conversation.handle({
      message: M2,
      ownerLogin: 'test-owner',
    });

    expect(answered.answer, 'this was "I could not find a project matching that name"').toBeNull();
    expect(answered.said, answered.said).toMatch(/planning/i);
    expect(answered.href).toBe(`/missions/${missionId}`);
    expect(answered.started?.missionId).toBe(missionId);
    expect(answered.started?.planning).toBe(true);

    expect(await openQuestions(missionId)).toHaveLength(0);
    const detail = await harness.services.missions.detail(missionId);
    expect(detail.mission.acceptanceCriteria).toContain(M2);
    expect(detail.mission.state).not.toBe('needs_clarification');
  }, 60_000);

  /**
   * Answering is answering and nothing else.
   *
   * "Continue work on the existing CampusCountdown project" reads like a request to build
   * something, and a reply routed to `startWork` would provision a second project beside the first
   * — two repositories for one intention, which is the failure `mid-project-change` pins from the
   * other direction. Counting is the honest assertion: one of everything, and nothing standing.
   */
  it('creates nothing at all on the second message', async () => {
    await askedAboutCampusCountdown();

    await harness.services.conversation.handle({ message: M2, ownerLogin: 'test-owner' });

    const projects = await harness.services.projects.list();
    expect(projects.total, 'no second project called "Continue Work"').toBe(1);
    const missions = await harness.services.missions.list();
    expect(missions.total, 'the answer joins the mission, it does not start one').toBe(1);
    expect(missions.items[0]?.mission.state, 'and it is the mission that got the answer').not.toBe(
      'needs_clarification',
    );
    /* Exactly once, and for the name the owner wrote. `blake/private` is the other failure. */
    expect(github.created).toEqual(['blake/campuscountdown']);
    expect(await harness.services.proposals.latestOpen(), 'nothing was proposed either').toBeNull();
  }, 60_000);

  /**
   * Two things waiting, and the reply names one of them.
   *
   * Before the fix the name in the sentence played no part in choosing the mission at all.
   * Selection was "the only mission waiting": with one waiting the reply was written into it
   * whatever it named, and with two waiting Jarvis asked which — so the owner's own words either
   * landed on the mission that happened to be first in the listing, where whatever plans it reads
   * them as its requirements, or landed nowhere. Here the reply arrives with no context, so the
   * name is the only evidence there is, and it has to be enough.
   */
  it('lands a named reply on the named project and leaves the other question open', async () => {
    const campusMissionId = await askedAboutCampusCountdown();

    const libraryHours =
      'Build a new private project called LibraryHours. Create a rota board for the reading room.';
    const other = await harness.services.conversation.handle({
      message: libraryHours,
      ownerLogin: 'test-owner',
    });
    const otherMissionId = other.started!.missionId;
    expect(await openQuestions(otherMissionId)).toHaveLength(1);

    const answered = await harness.services.conversation.handle({
      message: M2,
      ownerLogin: 'test-owner',
    });

    expect(answered.started?.missionId, 'the project the sentence named').toBe(campusMissionId);
    expect(await openQuestions(campusMissionId)).toHaveLength(0);
    const campus = await harness.services.missions.detail(campusMissionId);
    expect(campus.mission.acceptanceCriteria).toContain(M2);
    /* The other mission was never mentioned, so nothing about it may have changed. */
    expect(await openQuestions(otherMissionId), 'LibraryHours is still waiting').toHaveLength(1);
    const untouched = await harness.services.missions.detail(otherMissionId);
    expect(untouched.mission.acceptanceCriteria).not.toContain(M2);
  }, 60_000);

  /**
   * A name in a sentence is not consent to file it.
   *
   * The sentences that name a project most often are the ones asking about it, and the named route
   * would otherwise admit every one of them. Filed as an answer, "How is the CampusCountdown
   * project going?" becomes the definition of done and the planner reads it back as a
   * specification — worse than the bug it replaced, because it is silent.
   */
  it('answers a status question about the project instead of filing it', async () => {
    const missionId = await askedAboutCampusCountdown();

    const turn = await harness.services.conversation.handle({
      message: 'How is the CampusCountdown project going?',
      ownerLogin: 'test-owner',
    });

    expect(turn.answer, 'it is answered as the question it plainly is').not.toBeNull();
    /* About the project the owner named — which, called Private, is a project nobody can find. */
    expect(turn.answer?.title).toBe('CampusCountdown');
    expect(await openQuestions(missionId), 'and the question is still waiting').toHaveLength(1);
  }, 60_000);

  /**
   * A reply that says nothing leaves the question open, which is the only way to ask it twice.
   *
   * The clarification row is unique on (mission, question) and `buildClarificationQuestions`
   * filters out every id already asked, so recording "not sure" as the answer closes the question
   * for ever and hands the planner "not sure" as the acceptance criterion for the whole mission.
   * That is what happened before: every reply that reached this path was written down as written.
   *
   * "not sure" rather than "ok" because a bare "ok" is read as a `follow_up` and never arrives
   * here at all — it is an agreement to something, not a reply to a question.
   */
  it('asks again rather than filing an acknowledgement as the definition of done', async () => {
    const missionId = await askedAboutCampusCountdown();
    const [question] = await openQuestions(missionId);

    const turn = await harness.services.conversation.handle({
      message: 'not sure',
      ownerLogin: 'test-owner',
      context: answering,
    });

    expect(turn.said, turn.said).toContain(question!.question);
    expect(await openQuestions(missionId), 'still open, so it can be asked again').toHaveLength(1);
    const detail = await harness.services.missions.detail(missionId);
    expect(detail.mission.acceptanceCriteria).not.toContain('not sure');
  }, 60_000);

  /**
   * Handing the decision over is an answer, and the one reply that would otherwise loop for ever.
   *
   * "Whatever you think" says *use your judgement*, so the question closes on Jarvis's own
   * recommendation — recorded as `inferred`, because it is an assumption Jarvis made and not a
   * decision the owner took. Treating it as insufficient would ask the same question until the
   * owner gave up.
   */
  it('accepts a deferral as an answer and records it as inferred, not manual', async () => {
    const missionId = await askedAboutCampusCountdown();

    const turn = await harness.services.conversation.handle({
      message: 'Whatever you think is sensible is fine.',
      ownerLogin: 'test-owner',
      context: answering,
    });

    expect(turn.said, turn.said).toMatch(/planning/i);
    expect(await openQuestions(missionId), 'answered, not asked again').toHaveLength(0);
    const detail = await harness.services.missions.detail(missionId);
    expect(
      detail.clarifications[0]?.answerProvenance,
      'Jarvis assumed this; the owner did not decide it',
    ).toBe('inferred');
  }, 60_000);
});
