import { describe, expect, it } from 'vitest';

import {
  interpretMessage,
  onlyForbidsBuilding,
  standaloneCancellation,
  type ConversationContext,
} from '@/domain/interpretation';
import { classifyTranscript } from '@/domain/voice';
import { readRefinement } from '@/domain/refinement';

/**
 * What was asked for, and what was forbidden, as two answers to two questions.
 *
 * ## The message that made this necessary
 *
 * Blake typed:
 *
 *     "Use US dollars. Look ahead until my next known income date, with six weeks as the fallback.
 *      Treat entered income as after-tax, so no tax feature in V1. An override lasts only for the
 *      current week. Do not track rollover separately; recalculate from the current balance each
 *      week. I will re-enter my bank balance weekly, so remove expense tracking. Lock this as the
 *      final V1, but do not build it yet."
 *
 * and read back "Nothing, then. Understood. Nothing has been started…" — six decisions and a request
 * to settle the scope, discarded.
 *
 * The gate was `noBuildYet && !ASKS_FOR_SOMETHING`. Its intent was "a refusal and nothing else"; its
 * implementation was "he forbade building, and I found no question word". Those are the same test
 * only if people ask for things by asking questions, and he answers questions with statements. One
 * field was carrying both what he wanted and what he forbade, and when they disagreed the
 * prohibition silently won.
 *
 * So: `action` says what was asked for, `noBuildYet` says what was forbidden, and neither may
 * overwrite the other. Every case below is one Blake named.
 */

const STANDING: ConversationContext = {
  actions: [],
  proposal: { id: 'prop-1', summary: 'Start StudentBudget and build the smallest useful version.' },
  lastJarvisTurn: null,
  focusedProjectId: null,
};

const COMPOUND =
  'Use US dollars. Look ahead until my next known income date, with six weeks as the fallback. ' +
  'Treat entered income as after-tax, so no tax feature in V1. An override lasts only for the ' +
  'current week. Do not track rollover separately; recalculate from the current balance each week. ' +
  'I will re-enter my bank balance weekly, so remove expense tracking. Lock this as the final V1, ' +
  'but do not build it yet.';

describe('the message that came back as "Nothing, then"', () => {
  it('is read as settling the scope, with building forbidden', () => {
    const result = interpretMessage(COMPOUND, STANDING);

    expect(result.kind).toBe('refine');
    expect(result.action).toBe('refine');
    /* Both halves, both true, neither having eaten the other. */
    expect(result.noBuildYet).toBe(true);
    expect(result.understanding.toLowerCase()).not.toContain('nothing, then');
  });

  it('carries every decision he made, and leaves out the one about the proposal', () => {
    const refinement = readRefinement(COMPOUND);

    /*
     * Six decisions about the product. The seventh sentence — "Lock this as the final V1, but do
     * not build it yet" — is an instruction about the *proposal*, and storing it as a decision
     * would put "do not build it yet" into the constraints handed to whoever builds it. That is the
     * "Yet" bug in a new place: a sentence about the conversation mistaken for a fact about the
     * product.
     */
    expect(refinement.answers).toHaveLength(6);
    expect(refinement.answers[0]).toBe('Use US dollars.');
    expect(refinement.answers.join(' ')).toContain('no tax feature in V1');
    expect(refinement.aboutTheProposal.join(' ')).toContain('Lock this as the final V1');
    expect(refinement.answers.join(' ')).not.toContain('Lock this as the final V1');

    /* And he said it was final. */
    expect(refinement.locksScope).toBe(true);
  });

  it('keeps a decision expressed in two clauses as one decision', () => {
    const refinement = readRefinement(COMPOUND);
    /*
     * "Do not track rollover separately; recalculate from the current balance each week" is one
     * rule with a semicolon in it. Splitting there would store half a rule twice and lose the
     * reason the second half exists.
     */
    const rollover = refinement.answers.find((answer) => answer.includes('rollover'));
    expect(rollover).toContain('recalculate from the current balance');
  });
});

describe('the four sentences that must each land somewhere different', () => {
  const cases = [
    {
      message: 'Refine this, but do not build it.',
      kind: 'refine',
      action: 'refine',
      noBuildYet: true,
    },
    {
      message: 'Lock this as the final V1, but do not build it yet.',
      kind: 'refine',
      action: 'refine',
      noBuildYet: true,
    },
    {
      message: "Don't build anything; just evaluate it.",
      kind: 'idea',
      action: 'evaluate',
      noBuildYet: true,
    },
    {
      message: 'Never mind, dismiss it.',
      kind: 'decline',
      action: 'cancel',
      noBuildYet: false,
    },
  ] as const;

  for (const entry of cases) {
    it(`reads "${entry.message}" as ${entry.action}`, () => {
      const result = interpretMessage(entry.message, STANDING);
      expect(result.kind).toBe(entry.kind);
      expect(result.action).toBe(entry.action);
      expect(result.noBuildYet).toBe(entry.noBuildYet);
    });

    it(`reads "${entry.message}" the same way when it is spoken`, () => {
      /*
       * Speaking and typing are one act. Before this change the spoken half was quietly different:
       * `classifyTranscript` was context-free, so a refinement had nothing to refine and landed on
       * the query router, which reaches no proposal. It looked identical from the outside and did
       * less.
       */
      const spoken = classifyTranscript(entry.message, STANDING);
      /* All four are conversational: none of them starts work, including the dismissal. */
      expect(spoken.intent).toBe('conversation');
      /*
       * And the read-back tells the truth about it. `mission_draft` promises "I will start this",
       * which is the opposite of what happens to a message that says not to build.
       */
      expect(spoken.consequence.toLowerCase()).toContain('nothing will be created');
    });
  }
});

describe('only a real dismissal cancels anything', () => {
  it('recognises a message that is nothing but a dismissal', () => {
    for (const message of [
      'Never mind, dismiss it.',
      'no',
      'not tonight',
      'No thanks, forget it for now.',
      'Cancel that.',
    ]) {
      expect(standaloneCancellation(message), message).toBe(true);
    }
  });

  it('does not cancel a decision that merely opens with "no"', () => {
    /*
     * The old test was "does it start with a dismissal word", which is a test for the first word
     * rather than for the message.
     */
    for (const message of [
      'No, use dollars instead.',
      'Do not build it yet.',
      'No tax feature in V1, please.',
      COMPOUND,
    ]) {
      expect(standaloneCancellation(message), message).toBe(false);
    }
  });

  it('tells a bare constraint apart from a message that also asks for something', () => {
    expect(onlyForbidsBuilding("Don't build it yet.")).toBe(true);
    expect(onlyForbidsBuilding('No need to build anything.')).toBe(true);
    expect(onlyForbidsBuilding('Lock this as the final V1, but do not build it yet.')).toBe(false);
    expect(onlyForbidsBuilding(COMPOUND)).toBe(false);
  });
});

/**
 * Four bugs an adversarial pass found in this change *after* the six cases passed.
 *
 * Worth keeping as a group, because they share a shape: each one is the same old mistake — a rule
 * reading words out of a sentence that was about something else — reappearing at a layer nobody was
 * looking at. Six green tests is not the same as a correct change.
 */
describe('what the six cases did not catch', () => {
  it('does not read an instruction to do work as an answer about scope', () => {
    /*
     * A proposal standing does not make every sentence about it. "Audit Holograph read-only." is
     * work on a different project, and recording it as a decision about the standing idea would be
     * this module's founding bug wearing a new hat.
     */
    for (const message of [
      'Audit Holograph read-only.',
      'Add a settings screen to CoreCredit.',
      'Fix the failing check on QuickPick.',
    ]) {
      expect(interpretMessage(message, STANDING).kind, message).toBe('work');
    }
  });

  it('does not let a dictated message put "do not build it yet" into the build constraints', () => {
    /*
     * Speech has no full stops. The same message dictated arrives as one clause, so splitting on
     * sentences finds nothing to separate and the whole thing — instruction and all — is stored as
     * a decision. It then travels into the constraints handed to whoever builds it.
     *
     * That is the "Yet" bug for the third time. The first named a project after "Do not build
     * anything yet"; the second read a plan's promise not to merge as intent to merge.
     */
    const spoken =
      'use us dollars look ahead until my next known income date with six weeks as the fallback ' +
      'treat entered income as after tax so no tax feature in v1 lock this as the final v1 but do ' +
      'not build it yet';

    const refinement = readRefinement(spoken);
    expect(refinement.answers.join(' ')).not.toMatch(/do not build|don'?t build/i);
    /* And it is separated rather than silently dropped. */
    expect(refinement.aboutTheProposal.join(' ')).toMatch(/do not build/i);
    expect(refinement.locksScope).toBe(true);
  });

  it('keeps a typed decision exactly as it was written, full stop and all', () => {
    /* Verbatim is the point: these are handed to a builder unchanged. */
    expect(readRefinement(COMPOUND).answers[0]).toBe('Use US dollars.');
  });

  it('says a message forbids building only when it actually does', () => {
    /*
     * `onlyForbidsBuilding` subtracts prohibitions and filler and asks what is left — which
     * answered true for "ok", "please" and "thanks", every word of which is filler. It was safe
     * only because its one call site happened to guard it with `noBuildYet &&`. A predicate that is
     * correct only because of its caller is one the next caller gets wrong.
     */
    for (const message of ['ok', 'please', 'thanks', 'sure']) {
      expect(onlyForbidsBuilding(message), message).toBe(false);
    }
    for (const message of ["Don't build it yet.", 'No need to build anything.']) {
      expect(onlyForbidsBuilding(message), message).toBe(true);
    }
  });
});

describe('a refinement needs something to refine', () => {
  it('does not invent a subject when nothing is standing', () => {
    /*
     * "Use US dollars" refines something, and with nothing on the table it is a fragment. Guessing
     * which project he meant would edit the scope of one he was not talking about; asking costs a
     * sentence. This is the safe direction.
     */
    const result = interpretMessage(COMPOUND);
    expect(result.kind).not.toBe('refine');
    /* The constraint still travels, whatever it lands on. */
    expect(result.noBuildYet).toBe(true);
  });

  it('leaves a question about a change as a question', () => {
    /*
     * "What do you think of doing it in euros instead?" is weighing a change up, not making it.
     * Editing the scope on the strength of it would act on something he was still deciding.
     */
    const result = interpretMessage('What do you think of doing it in euros instead?', STANDING);
    expect(result.kind).not.toBe('refine');
  });

  it('still lets an ordinary follow-up through untouched', () => {
    expect(interpretMessage('go ahead', STANDING).kind).toBe('follow_up');
    expect(interpretMessage('Where are we?', STANDING).kind).toBe('question');
    expect(interpretMessage('pause', STANDING).command).toBe('pause');
  });
});
