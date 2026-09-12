import type { ModelAnswer } from '@/domain/answer';
import type { AnswerEvidenceItem } from '@/domain/answer-run';
import type {
  AnswerGenerationRequest,
  AnswerGenerationResult,
  AnswerProvider,
} from './answer-provider';
import { buildAnswerPrompt } from './answer-provider';

/**
 * A deterministic stand-in for a writing model.
 *
 * ## Why this exists rather than a mocked HTTP response
 *
 * The generated path has behaviour a browser test should see: an answer whose claims carry
 * different kinds, citations the server resolved rather than the model wrote, a draft the
 * validator rejects, and a generation slow enough to cancel. Faking those at the network edge
 * would test the fixture. This runs the real pipeline — real scope resolution, real retrieval,
 * real freezing, real validation, real persistence — and replaces only the part that would
 * otherwise cost money and vary between runs.
 *
 * ## Why it cannot reach production
 *
 * It is constructed only when `config.ask.scriptedProvider` is true, and `buildConfig` refuses to
 * set that outside a non-production environment that has already been given a test-auth secret.
 * The same gate that keeps the signed test-login endpoint inert in a real deployment keeps this
 * inert too, so there is one thing to get right rather than two.
 *
 * ## What it will not do
 *
 * It writes only from the evidence it was handed, and cites only references present in the
 * snapshot — except when asked to misbehave. The markers below exist so a test can produce the
 * failures that matter on demand, because a provider that only ever behaves correctly cannot
 * prove that the validator, the state machine or the cancellation path work.
 */

/** Markers a test puts in the question to select behaviour. Nothing else changes. */
export const SCRIPTED_MARKERS = Object.freeze({
  /** Hang until the request is aborted, so a cancel has something to cancel. */
  slow: '[slow]',
  /** Cite something that was never in the evidence, so the validator has to catch it. */
  invent: '[invent]',
  /** Fail outright, so the evidence-preserving failure path is visible. */
  fail: '[fail]',
});

export class ScriptedAnswerProvider implements AnswerProvider {
  readonly name = 'scripted';
  readonly model = 'scripted-answer-model';

  isConfigured(): boolean {
    return true;
  }

  async generate(request: AnswerGenerationRequest): Promise<AnswerGenerationResult> {
    const prompt = buildAnswerPrompt(request);
    const question = request.question;

    if (question.includes(SCRIPTED_MARKERS.slow)) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, 60_000);
        request.signal.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(new Error('The answer was cancelled.'));
        });
      });
    }

    if (question.includes(SCRIPTED_MARKERS.fail)) {
      throw new Error('The scripted provider was asked to fail.');
    }

    const items = request.snapshot.items;
    const answer = question.includes(SCRIPTED_MARKERS.invent)
      ? inventedAnswer()
      : groundedAnswer(question, items, request.snapshot.gaps, request.routing.proposesAction);

    return {
      answer,
      usage: {
        /* An estimate this provider is honest about being an estimate: nothing reported it. */
        inputTokens: Math.ceil(prompt.length / 4),
        outputTokens: null,
        cachedInputTokens: null,
        /* Locally generated text costs nothing, and nothing reported a cost. Not zero — absent. */
        reportedCostUsd: null,
      },
      provider: this.name,
      model: this.model,
      latencyMs: 5,
    };
  }
}

/**
 * An answer built from the evidence, with one claim of each kind that matters.
 *
 * The interpretation claim is labelled as interpretation and the recommendation is written as a
 * suggestion, because the point of exercising this path in a browser is to see that those two are
 * visibly different from a recorded fact.
 */
function groundedAnswer(
  question: string,
  items: readonly AnswerEvidenceItem[],
  gaps: readonly string[],
  proposesAction: boolean,
): ModelAnswer {
  const cited = items.slice(0, 3);
  const refs = cited.map((item) => item.ref);
  const projectId = cited.find((item) => item.projectId !== null)?.projectId ?? null;

  const claims: ModelAnswer['claims'] = cited.map((item) => ({
    kind: 'recorded_fact' as const,
    text: `The records say: ${item.excerpt.slice(0, 200)}`,
    citations: [item.ref],
    projectId: item.projectId,
  }));

  if (refs.length > 0) {
    claims.push({
      kind: 'model_interpretation',
      text: `Reading those together, the answer to “${question.slice(0, 120)}” rests on ${refs.length} record${refs.length === 1 ? '' : 's'}.`,
      citations: [...refs],
      projectId,
    });
  }

  for (const gap of gaps.slice(0, 2)) {
    claims.push({ kind: 'unknown', text: gap, citations: [], projectId: null });
  }

  if (claims.length === 0) {
    claims.push({
      kind: 'unknown',
      text: 'Nothing in the evidence answers this.',
      citations: [],
      projectId: null,
    });
  }

  if (proposesAction) {
    claims.push({
      kind: 'recommendation',
      text: 'Jarvis suggests turning this into a mission draft for you to approve. Nothing has been done.',
      citations: [],
      projectId,
    });
  }

  return {
    headline: `Here is what the records say about “${question.slice(0, 80)}”.`,
    claims,
    ...(proposesAction
      ? {
          missionSuggestion: {
            rawRequest: question.slice(0, 2000),
            projectId,
            rationale: 'The question asked for work, so this is a draft rather than an answer.',
          },
        }
      : {}),
  } as ModelAnswer;
}

/** A draft that cites something it was never given. The validator must reject it in full. */
function inventedAnswer(): ModelAnswer {
  return {
    headline: 'Everything is on track and the release shipped this morning.',
    claims: [
      {
        kind: 'recorded_fact',
        text: 'The release was signed off in the deployment document.',
        citations: ['source:11111111-1111-4111-8111-111111111111'],
        projectId: null,
      },
    ],
  } as ModelAnswer;
}
