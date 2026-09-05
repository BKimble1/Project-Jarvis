import type { ModelAnswer } from '@/domain/answer';
import type {
  AnswerGenerationRequest,
  AnswerGenerationResult,
  AnswerProvider,
} from '@/server/ask/answer-provider';

/**
 * A scripted answer provider.
 *
 * Exists so the model paths are testable without a network and without pretending a model is
 * configured when none is. It can be told to succeed, to fail, to hang until cancelled, or to
 * invent a citation — that last one being the case the whole validation layer exists for, and one
 * a real provider cannot be relied upon to produce on demand.
 *
 * It also records the prompt it was given, which is how a test asserts what did *not* reach the
 * model: another project's canary, a forgotten memory, a credential.
 */
export class FakeAnswerProvider implements AnswerProvider {
  readonly name = 'fake';
  readonly model = 'fake-answer-model';

  /** Every prompt this provider was handed, in order. */
  readonly prompts: string[] = [];
  /** How many times generate() was actually entered. Proves idempotency and cancellation. */
  calls = 0;

  private script: ModelAnswer | null = null;
  private failure: Error | null = null;
  private hangMs = 0;
  private configured = true;
  private usage = {
    inputTokens: 1200 as number | null,
    outputTokens: 340 as number | null,
    cachedInputTokens: null as number | null,
    reportedCostUsd: 0.0042 as number | null,
  };

  setAnswer(answer: ModelAnswer): this {
    this.script = answer;
    this.failure = null;
    return this;
  }

  setFailure(error: Error): this {
    this.failure = error;
    return this;
  }

  /** Hangs until the request's signal aborts, so a cancellation test has something to cancel. */
  setHang(ms: number): this {
    this.hangMs = ms;
    return this;
  }

  setConfigured(value: boolean): this {
    this.configured = value;
    return this;
  }

  /** Including nulls, so a test can prove a missing token count is not written as zero. */
  setUsage(usage: {
    inputTokens: number | null;
    outputTokens: number | null;
    cachedInputTokens: number | null;
    reportedCostUsd: number | null;
  }): this {
    this.usage = usage;
    return this;
  }

  isConfigured(): boolean {
    return this.configured;
  }

  async generate(request: AnswerGenerationRequest): Promise<AnswerGenerationResult> {
    this.calls += 1;
    const { buildAnswerPrompt } = await import('@/server/ask/answer-provider');
    this.prompts.push(buildAnswerPrompt(request));

    if (this.hangMs > 0) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, this.hangMs);
        request.signal.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(new Error('aborted'));
        });
      });
    }

    if (this.failure) throw this.failure;
    if (!this.script) throw new Error('No answer was scripted for this provider.');

    return {
      answer: this.script,
      usage: this.usage,
      provider: this.name,
      model: this.model,
      latencyMs: 12,
    };
  }
}

/** A minimal valid answer citing whatever reference the caller supplies. */
export function scriptedAnswer(input: {
  readonly headline?: string;
  readonly citations: readonly string[];
  readonly projectId?: string | null;
  readonly missionSuggestion?: { rawRequest: string; projectId: string | null; rationale: string };
}): ModelAnswer {
  return {
    headline: input.headline ?? 'A scripted answer.',
    claims: [
      {
        kind: 'recorded_fact',
        text: 'Something the records say.',
        citations: [...input.citations],
        projectId: input.projectId ?? null,
      },
    ],
    ...(input.missionSuggestion ? { missionSuggestion: input.missionSuggestion } : {}),
  } as ModelAnswer;
}
