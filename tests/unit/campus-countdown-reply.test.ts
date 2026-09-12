import { describe, expect, it } from 'vitest';

import { interpretMessage, type Interpretation } from '@/domain/interpretation';
import { judgeAnswer } from '@/server/conversation/conversation-service';

/**
 * The evening the definition of done was thrown away.
 *
 * Blake asked for a project and was asked one question back — "How will you know this is done and
 * right?" — then answered it, in the plainest possible English, naming the project in the first
 * four words. The answer was read as an ordinary question, handed to the status router, and came
 * back as "no matching project" over a card reading "Project: not yet chosen" with a button
 * offering to prepare the mission. The requirement he had just written was discarded and the
 * mission carried on waiting for it.
 *
 * Two separate failures, both pinned here at the level they happen:
 *
 *  1. The subject of the reply was "a live countdown and updates without a reload". Both subject
 *     patterns are anchored to the END of what they are given and capped at 61 characters, so in a
 *     two-sentence message the name in sentence one was simply out of reach of a single whole-text
 *     pass — the tail after "on " is 142 characters, and the only preposition whose tail fitted was
 *     the "with" near the end.
 *  2. Nothing downstream could tell "the definition of done is…" apart from "how is the
 *     CampusCountdown project going?", because both land on `kind: 'question'`. A name in a
 *     sentence is not consent to file it as a requirement, so the answer needs the shape of the
 *     sentence and not only its topic.
 *
 * The owner's two messages, verbatim, are the fixtures throughout.
 */

/** What Blake typed first, which created the project and asked the clarification. */
const M1 =
  'Build a new private project called CampusCountdown. Create a countdown board for campus events.';

/** What Blake typed back, after a reload, with no conversation context left on the page. */
const M2 =
  'Continue work on the existing CampusCountdown project. The definition of done is a page that ' +
  'lists each event with a live countdown and updates without a reload.';

/** The second sentence of M2 on its own — the only part the old whole-text pass could reach. */
const DEFINITION_OF_DONE =
  'The definition of done is a page that lists each event with a live countdown and updates ' +
  'without a reload.';

/**
 * The admission test the conversation service applies, restated here.
 *
 * This mirrors `readsAsAnAnswer` in `src/server/conversation/conversation-service.ts`, which is
 * private to that module and is what decides whether a message that merely *names* a project may
 * bind itself to the clarification that project is waiting on. It is restated rather than exported
 * so that a change to either half of the pair shows up as a failure here.
 *
 * The pair is what it is because each half alone lets a status question through. `recognisedQuestion`
 * catches the phrasings this codebase knows are enquiries — "how is X going", "what is the status of
 * X", "tell me about X" — and most of those would otherwise resolve to a real project row and be
 * filed as its definition of done. The trailing question mark catches the enquiries nobody wrote a
 * pattern for: "Is the CampusCountdown app finished?" is not a recognised phrasing and is obviously
 * not an answer. Handing the planner "Is the CampusCountdown app finished?" as a requirement is the
 * failure this exists to prevent.
 */
function readsAsAnAnswer(raw: string, interpretation: Interpretation): boolean {
  return !interpretation.recognisedQuestion && !raw.trim().endsWith('?');
}

/** Every way the owner might ask *about* CampusCountdown rather than answer about it. */
const ENQUIRIES = [
  'How is the CampusCountdown project going?',
  'What is the status of the CampusCountdown project?',
  'Tell me about the CampusCountdown project.',
  'Where are we on the CampusCountdown project?',
  'What needs me?',
  'Where are we?',
] as const;

describe('the reply that named the project in its first sentence', () => {
  it('reads the subject out of the sentence that names it, not the sentence that follows', () => {
    /*
     * The pre-fix reading, constructed rather than described. `subjectOf` ran once over the whole
     * normalised message with these two patterns, both anchored to `$` and both capped at 61
     * characters; the tail after "on " is far past the cap, so the earliest preposition that could
     * reach the end of the string was the "with" in the final clause.
     */
    const normalise = (value: string): string =>
      value
        .toLowerCase()
        .replace(/[?!.,;:"'`]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    const WHOLE_TEXT_ONLY = /\b(?:on|for|about|in|with|of)\s+([a-z0-9][\w' -]{1,60})$/;
    expect(WHOLE_TEXT_ONLY.exec(normalise(M2))?.[1]).toBe(
      'a live countdown and updates without a reload',
    );

    /* And what it says now: the name Blake used, from the sentence he used it in. */
    expect(interpretMessage(M2).subject).toBe('campuscountdown');
  });

  it('still reads the tail that way when the tail is all it is given', () => {
    /*
     * The cap and the anchor were not the bug and are not loosened. Offered only the second
     * sentence, the cascade returns exactly the value the whole message used to return — which is
     * why the fix had to be about *which stretch of text* is offered, not about the patterns.
     */
    expect(interpretMessage(DEFINITION_OF_DONE).subject).toBe(
      'a live countdown and updates without a reload',
    );
    expect(interpretMessage(M2).subject).toBe('campuscountdown');
  });
});

describe('one sentence at a time, first hit wins', () => {
  it('takes the first sentence that names something and leaves one-sentence messages alone', () => {
    /*
     * The single-sentence rows are the whole point of keeping the whole-text pass as a fallback:
     * splitting on sentences must change what a two-sentence message means and nothing else. They
     * are asserted alongside M2 rather than in a test of their own so that this cannot go green on
     * the strength of the unchanged half.
     */
    for (const [message, subject] of [
      [M2, 'campuscountdown'],
      ['Where are we on Holograph?', 'holograph'],
      ['focus on corecredit today', 'corecredit'],
      ['add dark mode to QuickPick', 'quickpick'],
      ['change Pomodoro to have a long break', 'pomodoro'],
      ['add a long break to the Pomodoro project', 'pomodoro'],
      ['What needs me?', null],
    ] as const) {
      expect(interpretMessage(message).subject, message).toBe(subject);
    }
  });

  it('does not change what the opening request was', () => {
    /*
     * M1 is two sentences as well, so it goes through the same new pass. It is work, it is not an
     * enquiry, and nothing about reading it a sentence at a time may turn a request to build into
     * something the answer route could claim.
     */
    const opening = interpretMessage(M1);
    expect(opening.kind).toBe('work');
    expect(opening.recognisedQuestion).toBe(false);
  });
});

describe('the subject stays lower case', () => {
  it('never hands a mission lookup something it would fail to match', () => {
    /*
     * `src/server/query/mission-answers.ts` filters with `mission.title.toLowerCase().includes(
     * subject)` and normalises the title but not the subject, so an upper-case subject matches
     * nothing and the owner is told "Jarvis could not find a mission matching …" about a mission
     * that is plainly there. Casing is load-bearing on this side of the comparison.
     */
    for (const message of [M2, ...ENQUIRIES]) {
      const { subject } = interpretMessage(message);
      if (subject === null) continue;
      expect(subject, message).toBe(subject.toLowerCase());
    }
    expect(interpretMessage(M2).subject).toBe('campuscountdown');
  });
});

describe('an enquiry and an answer are both questions, and must still be told apart', () => {
  it('marks a phrasing the interpreter actually recognises as an enquiry', () => {
    for (const enquiry of ENQUIRIES) {
      expect(interpretMessage(enquiry).recognisedQuestion, enquiry).toBe(true);
    }
  });

  it('leaves the flag false for a statement that only landed on question by fall-through', () => {
    /*
     * `kind: 'question'` is where everything the earlier readings declined ends up, so it says
     * nothing about whether somebody asked. Both of these are the owner telling Jarvis what done
     * means; neither matched a status phrasing.
     */
    expect(interpretMessage(M2).recognisedQuestion).toBe(false);
    expect(
      interpretMessage('CampusCountdown is done when the board shows every event.')
        .recognisedQuestion,
    ).toBe(false);
  });
});

describe('what may be filed as the answer to the question Jarvis asked', () => {
  it("admits the owner's definition of done", () => {
    expect(readsAsAnAnswer(M2, interpretMessage(M2))).toBe(true);
  });

  it('refuses every way of asking about the project instead of answering about it', () => {
    /*
     * Each of these names a project that resolves to a real row, which is the other half of the
     * admission rule — so this pair is the only thing standing between "What is the status of the
     * CampusCountdown project?" and a mission brief whose acceptance criteria say exactly that.
     */
    for (const enquiry of [
      ...ENQUIRIES,
      'Is the CampusCountdown app finished?',
      'Has the CampusCountdown project started?',
    ]) {
      expect(readsAsAnAnswer(enquiry, interpretMessage(enquiry)), enquiry).toBe(false);
    }
  });
});

describe('judging what came back as an answer', () => {
  const RECOMMENDATION = 'A page listing every event with a countdown that ticks without a reload.';

  it('records a real definition of done as written', () => {
    expect(judgeAnswer(DEFINITION_OF_DONE, null).kind).toBe('record');
    expect(judgeAnswer(M2, null).kind).toBe('record');
  });

  it('treats handing the decision over as an answer, when there is something to hand it to', () => {
    /*
     * "Whatever you think" means *use your judgement*, and the clarification route records the
     * recommendation as `inferred` rather than `manual` so the brief still says who decided. Read
     * as insufficient instead, the one reply that most obviously means "carry on" would re-ask the
     * same question for ever.
     */
    expect(judgeAnswer('Whatever you think is sensible is fine.', RECOMMENDATION).kind).toBe(
      'defer',
    );
  });

  it('will not defer to a recommendation that does not exist', () => {
    /* Nothing to take as the answer, so the honest reply is to ask again rather than invent one. */
    expect(judgeAnswer('Whatever you think is sensible is fine.', null).kind).toBe('insufficient');
  });

  it('leaves the question open for a reply that says nothing', () => {
    for (const said of ['ok', 'fine', '', 'not sure']) {
      expect(judgeAnswer(said, RECOMMENDATION).kind, said).toBe('insufficient');
    }
  });

  it('keeps an answer that happens to start with an acknowledgement', () => {
    /*
     * The empty replies are matched whole rather than by substring for exactly this sentence: an
     * answer with an "ok" on the front is still an answer, and dropping it would ask the owner the
     * same question twice after they had already answered it.
     */
    expect(judgeAnswer('ok, it is done when the board shows every event', null).kind).toBe(
      'record',
    );
  });
});
