import { NOT_ASSESSED_NOTICE, type IdeaEvaluation } from '@/domain/proposal';

/**
 * Judging an idea, or admitting that nothing judged it.
 *
 * ## Why this is an interface with an honest null implementation
 *
 * Because the alternative is a template that reads like an assessment. "Who would use this" cannot
 * be answered from a keyword list, and a deterministic paragraph that *sounds* like an answer is
 * worse than no answer — it is the kind of confident filler that makes everything else Jarvis says
 * suspect. So there are exactly two states: a model reasoned about it, or nothing did and Jarvis
 * says so.
 *
 * ## Why the unconfigured path still returns something useful
 *
 * The questions. They are the half of an evaluation that does not need a model: whatever the idea
 * is, a first version cannot be scoped without knowing who it is for, what "done" looks like, and
 * where it runs. Asking those is genuinely useful and makes no claim to have assessed anything.
 *
 * ## What no implementation may do
 *
 * Claim research. Nothing here reaches the web, reads a competitor or looks at a market, and
 * `NO_RESEARCH_NOTICE` is attached to every evaluation regardless of implementation.
 */

export interface IdeaEvaluationRequest {
  /** What the owner said, verbatim. */
  readonly idea: string;
  /** A short name for the thing, when one could be derived. */
  readonly title: string;
  /** Aborted when the owner navigates away, so a stopped evaluation stops costing anything. */
  readonly signal?: AbortSignal;
}

export interface IdeaEvaluator {
  readonly name: string;
  isConfigured(): boolean;
  evaluate(request: IdeaEvaluationRequest): Promise<IdeaEvaluation>;
}

/**
 * The questions that materially change a first version, whatever the idea turns out to be.
 *
 * Kept short on purpose. The owner asked for "only questions that materially affect a simple V1",
 * and a list of ten is a way of not having decided which ones matter.
 */
export const MATERIAL_V1_QUESTIONS: readonly string[] = [
  'Who is the first person who would use this, and what do they do instead today?',
  'Where does it run — web page, phone app, or something you keep to yourself?',
  'What is the one thing it has to do well for a first version to be worth using?',
  'Does anything need to be saved between visits, or is each use self-contained?',
];

/**
 * What Jarvis returns when no model is configured to think with.
 *
 * Every field either states a fact about the request or says plainly that it was not assessed.
 * Nothing here is phrased to sound like a conclusion.
 */
export class UnconfiguredIdeaEvaluator implements IdeaEvaluator {
  readonly name = 'unconfigured';

  isConfigured(): boolean {
    return false;
  }

  async evaluate(request: IdeaEvaluationRequest): Promise<IdeaEvaluation> {
    return {
      likelyUser:
        'Not assessed — Jarvis has no model configured here to reason about who this is for.',
      problem: `Taken from what you said, in your words: ${request.idea.trim().slice(0, 400)}`,
      verdict: NOT_ASSESSED_NOTICE,
      smallestV1: [],
      assumptions: [],
      uncertainties: [
        'Whether anyone other than you would use it.',
        'Whether it is worth building at all — nothing has judged that.',
      ],
      questions: [...MATERIAL_V1_QUESTIONS],
      basis: 'not_assessed',
    };
  }
}
