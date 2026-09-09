import { describe, expect, it } from 'vitest';

import { EMPTY_CONTEXT, interpretMessage, type ConversationContext } from '@/domain/interpretation';

/**
 * What Blake meant.
 *
 * The first test in this file is the sentence that caused the whole change: it was answered as a
 * question about blocked projects because an unanchored `blockers?` pattern matched three-quarters
 * of the way through a sentence that opens with two imperative verbs. The workaround was to learn a
 * magic phrasing — "Generate a read-only audit report" — which is exactly the kind of thing a
 * person should never have to know.
 *
 * The rest are the other side of the same coin. Interpretation that is eager to find work is as bad
 * as interpretation that cannot: "is this worth building?" must not create a repository, and
 * "don't build it yet" must not build.
 */

const context = (over: Partial<ConversationContext> = {}): ConversationContext => ({
  ...EMPTY_CONTEXT,
  ...over,
});

describe('the request that was misread', () => {
  const HOLOGRAPH =
    'Audit Holograph read-only. Inspect the repository and report what is implemented, ' +
    'the main visible blockers, and the three most useful next actions.';

  it('is work, not a question about blocked projects', () => {
    const result = interpretMessage(HOLOGRAPH);
    expect(result.kind).toBe('work');
  });

  it('is understood as read-only, so it asks for no branch and no write scope', () => {
    const result = interpretMessage(HOLOGRAPH);
    expect(result.readOnly).toBe(true);
    expect(result.riskLevel).toBe('read_only');
  });

  it('finds the project without being told where to look', () => {
    expect(interpretMessage(HOLOGRAPH).subject).toBe('holograph');
  });

  it('no longer needs the magic phrasing that was invented to get around it', () => {
    /*
     * The workaround must keep working — but the point is that both now reach the same place, so
     * nobody has to know which one to use.
     */
    const workaround = interpretMessage(
      'Generate a read-only audit report for Holograph covering blockers and next actions.',
    );
    expect(workaround.kind).toBe('work');
    expect(workaround.readOnly).toBe(true);
  });

  it('still answers an actual question about blocked projects as a question', () => {
    /* The pattern was not wrong, only greedy. Its real job has to survive the fix. */
    expect(interpretMessage('which projects are blocked?').kind).toBe('question');
    expect(interpretMessage('what is blocked right now').kind).toBe('question');
  });
});

describe('an idea is not an instruction', () => {
  it('treats describing an idea as something to think about', () => {
    expect(interpretMessage('I have an idea for an app.').kind).toBe('idea');
    expect(interpretMessage('I was thinking about a tool for tracking rent.').kind).toBe('idea');
  });

  it('does not build when asked whether something is worth building', () => {
    for (const asking of [
      'Is this worth building?',
      'Does this idea make sense?',
      'Should I build this?',
      'What do you think about a small invoicing app?',
    ]) {
      expect(interpretMessage(asking).kind, asking).toBe('idea');
    }
  });

  it('does build when the sentence actually gives the instruction', () => {
    /*
     * The distinction that matters: musing and instruction can share a sentence, and the verb
     * aimed at an object is what separates them.
     */
    expect(interpretMessage('I have an idea for an app — build a simple version.').kind).toBe(
      'work',
    );
    expect(interpretMessage('Make a simple version.').kind).toBe('work');
  });
});

describe('negation constrains the verb it negates, and nothing else', () => {
  it('never starts a build from a sentence declining one', () => {
    /*
     * The property that matters is that nothing is built. Which *kind* a refusal lands on is a
     * presentational detail; starting a mission from a sentence that forbids one is not.
     */
    for (const refusal of [
      "Don't build it yet.",
      'Do not build this yet.',
      "Don't make it yet — let's talk about it first.",
      'No need to build anything.',
      'Hold off on building that.',
    ]) {
      expect(interpretMessage(refusal).kind, refusal).not.toBe('work');
      expect(
        interpretMessage(refusal).noBuildYet || interpretMessage(refusal).kind === 'decline',
      ).toBe(true);
    }
  });

  it('treats a bare refusal as a refusal', () => {
    for (const refusal of ["Don't build it yet.", 'No need to build anything.']) {
      expect(interpretMessage(refusal).kind, refusal).toBe('decline');
    }
  });

  /**
   * A judgement asked for in an inflected word.
   *
   * The test for "did this message also ask for something?" matched `assess` and not `assessment`,
   * so "Give me your assessment and the smallest useful V1. Do not build anything yet." was read as
   * asking for nothing at all and answered with "Understood — not building anything yet." The
   * negation was doing its job; the word next to it was too literal to see the request.
   */
  it('hears a request for a judgement however the owner inflects the word', () => {
    for (const message of [
      'Take a look at my LedgerLite idea. Give me your assessment and the smallest useful V1. Do not build anything yet.',
      'Re-evaluate my QuickPick idea using Claude. Give your assessment. Do not build anything yet.',
      "Your thoughts on the rent tracker app? Don't build it yet.",
      'I would value your opinion on StudySprint. Do not build anything yet.',
      'Have a look at the invoicing tool. Do not build anything yet.',
    ]) {
      const result = interpretMessage(message);
      expect(result.kind, message).not.toBe('decline');
      /* The constraint still travels — it is a request *and* a refusal to build. */
      expect(result.noBuildYet, message).toBe(true);
    }
  });

  it('keeps the rest of the message when the refusal is only part of it', () => {
    /*
     * This is the regression Blake hit. "Don't make it yet — let's talk about it first." is a
     * request to talk, carrying a constraint. Answering it with "Nothing, then." discards the
     * request and honours only the constraint, which is exactly backwards.
     */
    const result = interpretMessage("Don't make it yet — let's talk about it first.");
    expect(result.kind).not.toBe('decline');
    expect(result.kind).not.toBe('work');
  });

  it('treats a flat no as nothing at all', () => {
    expect(interpretMessage('no').kind).toBe('decline');
    expect(interpretMessage('not tonight').kind).toBe('decline');
  });
});

describe('follow-ups mean what was on screen', () => {
  const actions = [
    { id: 'a1', label: 'Review the pull request on CoreCredit' },
    { id: 'a2', label: 'Answer the clarification on Holograph' },
  ];

  it('binds an ordinal to the action it was shown against, by id', () => {
    const result = interpretMessage('the second one', context({ actions }));
    expect(result.kind).toBe('follow_up');
    expect(result.followUp).toEqual({ kind: 'select', index: 1, actionId: 'a2' });
  });

  it('accepts a proposal by its id rather than by position', () => {
    const result = interpretMessage(
      'go ahead',
      context({ proposal: { id: 'p7', summary: 'Build a rent tracker' } }),
    );
    expect(result.followUp).toEqual({ kind: 'accept', proposalId: 'p7' });
  });

  it('refuses to act when the thing referred to is gone', () => {
    /*
     * The failure this exists to prevent: a poll lands between reading a list and replying to it,
     * and "the second one" silently means a different second one. Saying so is the only safe
     * answer — acting on the new second item would act on something never read.
     */
    const result = interpretMessage('the second one', context({ actions: [actions[0]!] }));
    expect(result.followUp?.kind).toBe('stale');
  });

  it('refuses a bare yes with nothing to say yes to', () => {
    expect(interpretMessage('yes', EMPTY_CONTEXT).followUp?.kind).toBe('stale');
  });

  it('does not mistake a work request that happens to contain a number', () => {
    const result = interpretMessage('fix the second import in three files across the repo');
    expect(result.kind).toBe('work');
  });

  it('reads continue as carrying on', () => {
    expect(interpretMessage('continue').followUp).toEqual({ kind: 'continue' });
  });
});

describe('commands about work already running', () => {
  it('recognises pausing and stopping', () => {
    expect(interpretMessage('pause jarvis').command).toBe('pause');
    expect(interpretMessage('stop').command).toBe('stop');
  });

  it('reads pace as a scheduling preference', () => {
    /*
     * "Slow down until my Claude allowance resets" is an instruction about how much to attempt,
     * not a request to make a model generate tokens more slowly. Nothing downstream pretends
     * otherwise.
     */
    const conserve = interpretMessage('Slow down until my Claude allowance resets.');
    expect(conserve.kind).toBe('command');
    expect(conserve.command).toBe('pace');
    expect(conserve.pace).toBe('conserve');
    expect(interpretMessage('speed up').pace).toBe('fast');
  });
});

describe('the rest of the everyday sentences', () => {
  it('keeps deliberate memory deliberate', () => {
    expect(interpretMessage('Remember that I have classes tomorrow morning.').kind).toBe('memory');
    expect(interpretMessage('forget what I said about the deadline').kind).toBe('memory');
  });

  it('answers questions as questions', () => {
    for (const question of [
      'How is Holograph coming?',
      'What have you been working on?',
      'Where are we?',
      'What needs me?',
      'Show me what you finished.',
    ]) {
      expect(interpretMessage(question).kind, question).toBe('question');
    }
  });

  it('takes focus as work on a named project', () => {
    const result = interpretMessage('Focus on CoreCredit today.');
    /*
     * Deliberately a question rather than work: "focus on X" says what to prioritise, and the
     * honest response is to show where X stands and what it needs — not to invent a change to it.
     */
    expect(result.kind).toBe('question');
    expect(result.subject).toContain('corecredit');
  });

  it('refuses what the charter refuses, however it is phrased', () => {
    const result = interpretMessage('force push to main');
    expect(result.kind).toBe('prohibited');
    expect(result.refusal).toBeTruthy();
  });

  it('never returns an empty understanding', () => {
    for (const message of [
      'Audit Holograph read-only.',
      'I have an idea.',
      "Don't build it yet.",
      'pause',
      'Remember that I prefer small pull requests.',
      'Where are we?',
    ]) {
      expect(interpretMessage(message).understanding.length, message).toBeGreaterThan(0);
    }
  });
});

/**
 * The morning a budgeting app was read as an instruction to slow down.
 *
 * Blake typed, on the dashboard:
 *
 *     "Evaluate this idea: a simple student budget app that tracks recurring bills, weekly
 *      spending, and how much income I need each month. Give me your assessment and the smallest
 *      useful V1. Do not build anything yet."
 *
 * and read back a paragraph about running fewer missions in parallel. It looked exactly like stale
 * context — an old operator message answering a new turn — and it was not: `\bbudget\b` was a word
 * in the pattern that recognises "conserve my Claude allowance", so a *budgeting app* matched, and
 * everything after that was correct for the message the interpreter thought it had.
 *
 * That is the third appearance of one bug. A rule read a single word out of a sentence that was
 * about something else: it named a project "Yet" from "Do not build anything yet", it read a plan's
 * promise *not* to merge as an intention to merge, and here it heard a request for advice as an
 * order. Two things were changed — the word now needs its object, and a message that carries a
 * subject beats a bare command — and both are pinned below, along with the commands that must
 * still work.
 */
describe('a subject is not a command', () => {
  const BUDGET_IDEA =
    'Evaluate this idea: a simple student budget app that tracks recurring bills, weekly ' +
    'spending, and how much income I need each month. Give me your assessment and the smallest ' +
    'useful V1. Do not build anything yet.';

  it('reads a budgeting app as an idea rather than as an instruction to slow down', () => {
    const read = interpretMessage(BUDGET_IDEA);

    expect(read.kind).toBe('idea');
    expect(read.command).toBeNull();
    expect(read.pace).toBeNull();
    /* And the constraint survives the reading: judgement was asked for, building was forbidden. */
    expect(read.noBuildYet).toBe(true);
  });

  it('is not fooled by any of the ordinary ways to name a budget', () => {
    for (const said of [
      'What do you think of a budget tracker for freelancers?',
      'Is a household budget planner worth building?',
      'I have an idea for an app that helps students budget their term.',
    ]) {
      const read = interpretMessage(said);
      expect(read.pace, said).toBeNull();
      expect(read.kind, said).toBe('idea');
    }
  });

  it('still reads a genuine pace instruction as one', () => {
    for (const said of [
      'Slow down until my Claude allowance resets.',
      'Take it easy for the rest of the day.',
      'Ease off — budget my capacity until Friday.',
      'Go easy today.',
    ]) {
      const read = interpretMessage(said);
      expect(read.kind, said).toBe('command');
      expect(read.command, said).toBe('pace');
      expect(read.pace, said).toBe('conserve');
    }
  });

  it('lets a subject beat a bare command word', () => {
    /*
     * "Pause" is a whole command, and also a word somebody's app is about. A message that carries
     * a subject and asks for a judgement is not mission control — and the failure mode of getting
     * this the other way round is answering a question nobody asked.
     */
    const read = interpretMessage(
      'What do you think of an app that lets you pause and resume a shared shopping list?',
    );
    expect(read.kind).toBe('idea');
    expect(read.command).toBeNull();
  });

  it('leaves the bare commands exactly as they were', () => {
    for (const [said, command] of [
      ['pause', 'pause'],
      ['stop', 'stop'],
      ['cancel', 'cancel'],
      ['retry', 'retry'],
    ] as const) {
      expect(interpretMessage(said).command, said).toBe(command);
    }
  });
});
