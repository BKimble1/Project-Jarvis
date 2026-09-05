import { describe, expect, it } from 'vitest';

import { interpretReply } from '@/domain/reply-intent';
import {
  MAX_NEXT_ACTIONS,
  nextActions,
  summariseNextActions,
  type NextActionInput,
} from '@/domain/next-actions';
import { routeQuestion } from '@/domain/question-routing';
import { renderEvidenceForAnswer, type AnswerEvidenceItem } from '@/domain/answer-run';

/**
 * The three pieces that make a one-line reply safe.
 *
 * A conversational surface is only as trustworthy as its worst misunderstanding. Everything here
 * is about the misunderstandings: "no" heard as "yes", "do it" against four things, a document
 * outranking the system's own state. None of them need a model to get wrong, so none of them are
 * left to one.
 */

function input(overrides: Partial<NextActionInput> = {}): NextActionInput {
  return {
    mode: 'operator',
    standingAuthority: true,
    workerReady: true,
    clarifications: [],
    plansAwaitingApproval: [],
    graphsAwaitingApproval: [],
    permissionRequests: [],
    pullRequests: [],
    opportunities: [],
    ...overrides,
  };
}

describe('understanding a short reply', () => {
  it('selects by ordinal and by number', () => {
    for (const text of ['do the first one', 'the first', '1', 'number one please']) {
      expect(interpretReply(text, 3)).toMatchObject({ kind: 'select', index: 0 });
    }
    expect(interpretReply('the second', 3)).toMatchObject({ kind: 'select', index: 1 });
    expect(interpretReply('the last one', 3)).toMatchObject({ kind: 'select', index: 2 });
  });

  it('never hears a negation as a confirmation', () => {
    for (const text of [
      'not tonight',
      'no',
      'no, not the first one',
      "don't",
      'later',
      'skip it',
      'nothing tonight thanks',
    ]) {
      expect(interpretReply(text, 3).kind, text).toBe('decline');
    }
  });

  it('treats "continue" as carrying on, whatever is on the list', () => {
    expect(interpretReply('continue', 0).kind).toBe('continue');
    expect(interpretReply('continue', 4).kind).toBe('continue');
    expect(interpretReply('carry on', 4).kind).toBe('continue');
    expect(interpretReply('keep going', 2).kind).toBe('continue');
  });

  it('refuses to pick for you when "yes" could mean several things', () => {
    expect(interpretReply('do it', 4).kind).toBe('ambiguous');
    expect(interpretReply('yes', 3).kind).toBe('ambiguous');
    /* With exactly one thing on offer there is nothing to be ambiguous about. */
    expect(interpretReply('yes', 1)).toMatchObject({ kind: 'select', index: 0 });
    expect(interpretReply('go ahead', 0).kind).toBe('continue');
  });

  it('refuses a number that is not on the list rather than clamping it', () => {
    expect(interpretReply('the fourth', 2).kind).toBe('ambiguous');
    expect(interpretReply('9', 3).kind).toBe('ambiguous');
  });

  it('refuses when two numbers are named', () => {
    expect(interpretReply('the first and the third', 3).kind).toBe('ambiguous');
  });

  it('treats anything longer than a reply as a new question', () => {
    expect(
      interpretReply('what did we decide about the authentication approach last month', 3).kind,
    ).toBe('question');
    expect(interpretReply('how is CoreCredit doing', 3).kind).toBe('question');
  });
});

describe('what to do next', () => {
  it('puts "nothing can run" above everything interesting', () => {
    const actions = nextActions(
      input({
        workerReady: false,
        pullRequests: [{ missionId: 'm1', missionTitle: 'Invoice scanning' }],
      }),
    );
    expect(actions[0]?.kind).toBe('start_worker');
    expect(actions[1]?.kind).toBe('review_pull_request');
  });

  it('puts what is waiting on the owner above what Jarvis would start', () => {
    const actions = nextActions(
      input({
        clarifications: [
          {
            missionId: 'm1',
            missionTitle: 'Invoice scanning',
            questionId: 'q1',
            question: 'Which currency?',
          },
        ],
        opportunities: [
          { key: 'o1', title: 'Fix the failing build', projectName: 'Sandbox', reason: 'Red.' },
        ],
      }),
    );
    expect(actions.map((action) => action.kind)).toEqual([
      'answer_clarification',
      'start_opportunity',
    ]);
  });

  it('does not ask for an approval the charter already granted', () => {
    const opportunities = [
      { key: 'o1', title: 'Fix the failing build', projectName: null, reason: 'Red.' },
    ];
    const granted = nextActions(input({ standingAuthority: true, opportunities }));
    expect(granted[0]?.requiresOwner).toBe(false);

    const supervised = nextActions(
      input({ mode: 'supervised', standingAuthority: false, opportunities }),
    );
    /* Same work, different authority: now it is the owner's call. */
    expect(supervised.find((action) => action.kind === 'start_opportunity')?.requiresOwner).toBe(
      true,
    );
  });

  it('caps the list rather than handing back a backlog', () => {
    const actions = nextActions(
      input({
        pullRequests: Array.from({ length: 12 }, (_, index) => ({
          missionId: `m${index}`,
          missionTitle: `Mission ${index}`,
        })),
      }),
    );
    expect(actions).toHaveLength(MAX_NEXT_ACTIONS);
  });

  it('says nothing needs you rather than saying nothing', () => {
    expect(summariseNextActions([])).toBe('Nothing needs you right now.');
  });

  it('offers to resume when Jarvis is the thing that is stopped', () => {
    expect(nextActions(input({ mode: 'paused' }))[0]?.kind).toBe('resume_jarvis');
    expect(nextActions(input({ mode: 'off' }))[0]?.kind).toBe('resume_jarvis');
  });
});

describe('questions about Jarvis itself', () => {
  it('reaches for the operating state when asked about Jarvis', () => {
    for (const question of [
      'are you running?',
      'what are you working on?',
      'what have you been up to?',
      'how much capacity is left?',
      'when was the last tick?',
    ]) {
      expect(routeQuestion(question).needsOperating, question).toBe(true);
    }
  });

  it('does not reach for it when asked about a project', () => {
    expect(routeQuestion('what did we decide about authentication?').needsOperating).toBe(false);
    expect(routeQuestion('where does CoreCredit stand?').needsOperating).toBe(false);
  });

  it('reaches for it when asked what needs deciding, which is a question about both', () => {
    expect(routeQuestion('what needs my approval?').needsOperating).toBe(true);
  });
});

describe('what a document may not override', () => {
  const item = (
    ref: string,
    origin: AnswerEvidenceItem['origin'],
    excerpt: string,
  ): AnswerEvidenceItem => ({
    ref,
    kind: origin === 'operating_state' ? 'operating' : 'knowledge',
    origin,
    subjectId: ref,
    label: ref,
    excerpt,
    projectId: null,
    locator: null,
    revisionId: null,
    contentHash: null,
    href: null,
    staleSince: null,
    trust: origin,
  });

  it('states the precedence rule to the model in words', () => {
    const rendered = renderEvidenceForAnswer({
      items: [item('operating:mode', 'operating_state', 'Mode: Paused.')],
      allowedCitations: new Set(['operating:mode']),
      allowedProjectIds: new Set(),
      retrievalMode: 'lexical',
      retrievalApiVersion: '1',
      rankingVersion: '1',
      charCount: 20,
      truncated: false,
      gaps: [],
    });
    expect(rendered).toContain('PRECEDENCE');
    expect(rendered).toContain('does');
    expect(rendered).toContain('not make it running');
  });

  it('renders deterministic truth before documents, so truncation cannot drop it', () => {
    const rendered = renderEvidenceForAnswer({
      items: [
        item('knowledge:doc', 'knowledge_source', 'Jarvis runs continuously in operator mode.'),
        item('operating:mode', 'operating_state', 'Mode: Paused.'),
      ],
      allowedCitations: new Set(['knowledge:doc', 'operating:mode']),
      allowedProjectIds: new Set(),
      retrievalMode: 'lexical',
      retrievalApiVersion: '1',
      rankingVersion: '1',
      charCount: 100,
      truncated: false,
      gaps: [],
    });
    expect(rendered.indexOf('operating:mode')).toBeLessThan(rendered.indexOf('knowledge:doc'));
  });
});
