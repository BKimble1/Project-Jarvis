import type { ModelAnswer } from '@/domain/answer';
import { modelAnswerSchema } from '@/domain/answer';
import type { AnswerEvidenceSnapshot } from '@/domain/answer-run';
import { renderEvidenceForAnswer } from '@/domain/answer-run';
import { renderHistoryForPrompt, type HistoryTurn } from '@/domain/conversation';
import type { RoutingDecision } from '@/domain/question-routing';

/**
 * The narrow surface an answer generator is allowed to have.
 *
 * ## What is deliberately absent
 *
 * There is no tool loop here, and no `tools` parameter to pass one. The generator receives a
 * bounded packet of text and returns a validated object, and that is the entire interaction. It
 * cannot read a repository, write one, dispatch CI, reach TestFlight, start a mission, approve a
 * memory, enable a connector, or widen its own scope — not because each of those is blocked by a
 * check, but because there is no channel through which any of them could be requested.
 *
 * That distinction matters under prompt injection. A guard that inspects requests can be argued
 * with by a sufficiently creative document; an interface with no request channel cannot. The
 * strongest thing a hostile source can achieve here is to make the *text* of an answer wrong,
 * and `validateAnswer` then rejects it for citing something it was not given.
 *
 * ## Why the provider is an interface
 *
 * So that "no provider is configured" is a first-class, testable state rather than a null check
 * scattered through the service, and so a test can supply a scripted provider that fails, hangs
 * or returns garbage without any network. The activation lock stays authoritative: when nothing
 * real is configured, Jarvis does not invent a narrator.
 */

export interface AnswerGenerationRequest {
  readonly question: string;
  readonly snapshot: AnswerEvidenceSnapshot;
  readonly history: readonly HistoryTurn[];
  readonly routing: RoutingDecision;
  readonly scopeReason: string;
  /** Aborted when the owner cancels, so a stopped answer stops costing money where it can. */
  readonly signal: AbortSignal;
}

export interface AnswerUsage {
  /** Null means the provider did not report it. Never coerced to zero. */
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly cachedInputTokens: number | null;
  readonly reportedCostUsd: number | null;
}

export interface AnswerGenerationResult {
  readonly answer: ModelAnswer;
  readonly usage: AnswerUsage;
  readonly provider: string;
  readonly model: string;
  readonly latencyMs: number;
}

export interface AnswerProvider {
  readonly name: string;
  readonly model: string;
  isConfigured(): boolean;
  generate(request: AnswerGenerationRequest): Promise<AnswerGenerationResult>;
}

/* ----------------------------------------------------------------- prompts */

/**
 * The instruction half of the prompt.
 *
 * Written as constraints rather than as encouragement, because the failure this system is built
 * against is a confident answer rather than an unhelpful one. In particular the model is told
 * that `unknown` is a real and expected answer — a model under pressure to be useful stops
 * emitting unknowns first, and that is exactly when its answers stop being checkable.
 */
export function buildAnswerInstructions(input: {
  readonly scopeReason: string;
  readonly routing: RoutingDecision;
}): string {
  const lines = [
    "You are answering a question about the owner's own projects and documents.",
    '',
    `What you may look at: ${input.scopeReason}`,
    `Why this evidence was gathered: ${input.routing.reason}`,
    '',
    'Return claims, not prose. Each claim declares what kind of thing it is:',
    '',
    '- recorded_fact — something the records state. Must cite.',
    '- repository_evidence — something a commit, check or pull request shows. Must cite.',
    '- model_interpretation — your reading of the evidence. Say so; never dress it as a record.',
    '- recommendation — what you suggest doing. Never write it as though it has happened.',
    '- unknown — the records do not say. This is a real answer and often the correct one.',
    '',
    'Rules that will cause your answer to be rejected in full:',
    '',
    '1. Citing a reference you were not given. Every citation must be one of the exact bracketed',
    '   references in the evidence. Inventing a project, commit, mission, document or id is the',
    '   single worst failure here.',
    '2. Labelling something recorded_fact or repository_evidence without citing anything.',
    '3. Making a claim about a project outside what you were told you may look at.',
    '4. Inventing a completion percentage or a health score. Jarvis does not compute those.',
    '5. Writing a recommendation as an accomplished fact.',
    '6. Answering entirely in interpretation, with nothing recorded or unknown to stand on.',
    '',
    'If the evidence does not answer the question, say so with an unknown claim. Do not fill the',
    'gap from general knowledge — you have no way to check it and neither does the reader.',
  ];

  if (input.routing.requiresCurrentExternal) {
    lines.push(
      '',
      'This question needs current information from outside Jarvis. You do not have it and cannot',
      'get it. Say that plainly, describe what the stored records do show, and leave it there —',
      'presenting stored material as current research would be the dishonest answer.',
    );
  }

  if (input.routing.proposesAction) {
    lines.push(
      '',
      'This asks for work to be done. You cannot do work. Describe what you would propose and',
      'set missionSuggestion; a person approves it before anything happens.',
    );
  }

  return lines.join('\n');
}

/** The whole packet, in the order the model reads it. */
export function buildAnswerPrompt(request: AnswerGenerationRequest): string {
  const history = renderHistoryForPrompt(request.history);
  return [
    buildAnswerInstructions({ scopeReason: request.scopeReason, routing: request.routing }),
    '',
    history,
    history ? '' : '',
    renderEvidenceForAnswer(request.snapshot),
    '',
    'QUESTION',
    '',
    request.question,
  ]
    .filter((part) => part !== '')
    .join('\n');
}

/**
 * Parse whatever a provider returned into the strict shape, or fail.
 *
 * Exported so a real provider and a test provider share one parser — a provider that parsed
 * leniently would be a provider whose output the validator never really checked.
 */
export function parseModelAnswer(raw: unknown): ModelAnswer {
  return modelAnswerSchema.parse(raw);
}

/**
 * A provider that is not there.
 *
 * Used when no model is configured, so the service has an object to talk to rather than a null to
 * branch on everywhere. `isConfigured` returns false and `generate` refuses, which keeps the
 * activation lock honest: with nothing configured, Jarvis produces evidence and says so rather
 * than producing a narrative from nowhere.
 */
export class UnconfiguredAnswerProvider implements AnswerProvider {
  readonly name = 'none';
  readonly model = 'none';

  isConfigured(): boolean {
    return false;
  }

  async generate(): Promise<AnswerGenerationResult> {
    throw new Error('No answer provider is configured.');
  }
}
