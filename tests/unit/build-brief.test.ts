import { describe, expect, it } from 'vitest';

import { buildBrief } from '@/domain/build-brief';
import type { IdeaEvaluation, Proposal } from '@/domain/proposal';

/**
 * The difference between what somebody said and what gets built.
 *
 * The owner wrote "Re-evaluate my QuickPick idea … Give your assessment and the smallest useful V1.
 * Do not build anything yet.", got an assessment, and said "Go ahead". That produced a mission
 * whose request was the same sentence — so an agent was handed an instruction to re-evaluate
 * something and not build it, under a heading that said to build it.
 *
 * Everything here is about that boundary: the message is evidence of what was asked for, the brief
 * is the instruction, and no wording travels from one to the other.
 */

const EVALUATION: IdeaEvaluation = {
  likelyUser: 'Someone stuck between two options.',
  problem: 'Choosing between two things when neither is obviously better.',
  verdict: 'Worth an afternoon. It is small enough that building it settles the question.',
  smallestV1: ['Two text inputs', 'A pick button', 'One animation on the result'],
  assumptions: ['Used on a phone'],
  uncertainties: ['Whether anyone opens it twice'],
  questions: ['Does it need to remember past picks?'],
  basis: 'reasoned',
};

const RAW_MESSAGE =
  'Re-evaluate my QuickPick idea using Claude: two choices, one randomly selected with a clean ' +
  'animation. Give your assessment and the smallest useful V1. Do not build anything yet.';

function proposal(over: Partial<Proposal> = {}): Proposal {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    fingerprint: 'idea-abc',
    title: 'QuickPick',
    idea: RAW_MESSAGE,
    summary: 'Start QuickPick and build the smallest useful version.',
    evaluation: EVALUATION,
    openQuestions: EVALUATION.questions,
    recommendedV1: EVALUATION.smallestV1,
    assumptions: EVALUATION.assumptions,
    state: 'open',
    projectId: null,
    missionId: null,
    repositoryFullName: null,
    createdAt: '2026-09-08T09:00:00.000Z',
    updatedAt: '2026-09-08T09:00:00.000Z',
    acceptedAt: null,
    ...over,
  };
}

describe('turning an agreed proposal into something buildable', () => {
  it('never carries the conversational message into the objective', () => {
    const brief = buildBrief(proposal());

    expect(brief.objective).not.toContain('Re-evaluate');
    expect(brief.objective).not.toContain('Do not build');
    expect(brief.objective).not.toContain('assessment');
    expect(brief.objective).not.toContain(RAW_MESSAGE);
  });

  it('asks for an implementation, in the words that mean one', () => {
    const brief = buildBrief(proposal());

    expect(brief.objective).toContain('Build the first working version of QuickPick.');
    expect(brief.objective).toContain('implementation, not a report');
    /*
     * The words Jarvis reads as "this might be research". An objective built from a decision the
     * owner has already made must not contain the vocabulary that reopens it.
     */
    expect(brief.objective).not.toMatch(
      /\b(?:research|investigate|explore|look into|find out|see whether|evaluate|compare)\b/i,
    );
  });

  it('carries the agreed V1 as the definition of done', () => {
    const brief = buildBrief(proposal());

    expect(brief.acceptanceCriteria).toEqual([
      'Two text inputs',
      'A pick button',
      'One animation on the result',
    ]);
    for (const item of brief.acceptanceCriteria) expect(brief.objective).toContain(item);
    expect(brief.assessed).toBe(true);
  });

  it('keeps the product name, and never invents one', () => {
    expect(buildBrief(proposal()).name).toBe('QuickPick');
    expect(buildBrief(proposal({ title: 'LedgerLite' })).name).toBe('LedgerLite');
    expect(buildBrief(proposal({ title: '  ' })).name).toBe('New project');
  });

  it('separates context from instruction', () => {
    const brief = buildBrief(proposal());

    /* Who it is for belongs beside the work, not inside the order. */
    expect(brief.description).toContain('Someone stuck between two options.');
    expect(brief.objective).not.toContain('Someone stuck between two options.');
    expect(brief.goal).toContain('QuickPick');
  });

  it('says the scope is not known rather than inventing one', () => {
    const brief = buildBrief(
      proposal({ evaluation: null, recommendedV1: [], openQuestions: [], assumptions: [] }),
    );

    expect(brief.assessed).toBe(false);
    expect(brief.acceptanceCriteria).toEqual([]);
    expect(brief.objective).toContain('No assessed scope was agreed');
    expect(brief.objective).toContain('Build the first working version of QuickPick.');
    expect(brief.description).toBeNull();
  });

  it('will not take a V1 from an evaluation no model produced', () => {
    /*
     * A `not_assessed` row is the old "nothing judged this" placeholder. Its empty lists are not a
     * scope, and treating them as one would put a confident, agreed-looking definition of done on a
     * mission that nobody ever agreed to.
     */
    const placeholder = buildBrief(
      proposal({
        evaluation: { ...EVALUATION, basis: 'not_assessed', smallestV1: ['Not assessed.'] },
        recommendedV1: [],
      }),
    );

    expect(placeholder.assessed).toBe(false);
    expect(placeholder.acceptanceCriteria).toEqual([]);
    expect(placeholder.objective).not.toContain('Not assessed.');
  });

  it('bounds and de-duplicates the criteria, so a brief stays a brief', () => {
    const brief = buildBrief(
      proposal({
        evaluation: {
          ...EVALUATION,
          smallestV1: [
            'A pick button',
            'a pick button ',
            ...Array.from({ length: 12 }, (_, i) => `Item ${i}`),
          ],
        },
      }),
    );

    expect(brief.acceptanceCriteria.length).toBeLessThanOrEqual(10);
    expect(brief.acceptanceCriteria.filter((item) => /pick button/i.test(item))).toHaveLength(1);
  });
});
