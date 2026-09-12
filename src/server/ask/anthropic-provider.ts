import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';

import { CLAIM_KINDS } from '@/domain/answer';
import { logger as rootLogger, type Logger } from '@/server/logging/logger';
import type {
  AnswerGenerationRequest,
  AnswerGenerationResult,
  AnswerProvider,
} from './answer-provider';
import { buildAnswerInstructions, buildAnswerPrompt, parseModelAnswer } from './answer-provider';

/**
 * The real writing model behind Ask.
 *
 * ## What it is allowed to do
 *
 * One `messages.create` call with **no `tools` array**. Not "tools it is told not to use" — no
 * tool channel at all, so there is nothing for a hostile document inside the evidence packet to
 * ask for. The strongest thing retrieved text can achieve here is to make the *words* of an
 * answer wrong, and `validateAnswer` then rejects the answer for citing something it was never
 * given.
 *
 * ## Why the output is schema-constrained rather than parsed hopefully
 *
 * The answer contract is strict — claims carrying a kind, citations drawn from a fixed set, an
 * optional mission suggestion — and until this class existed it had only ever been exercised
 * against fakes. A model that returns *nearly* the right shape would land in the retry path and
 * then fall through to evidence-only, which looks exactly like "the model is working but never
 * generates". So the shape is constrained at the API with `output_config.format`, and the result
 * is still parsed through `parseModelAnswer` afterwards: the wire schema makes conformance likely,
 * the domain schema makes it certain, and the two are deliberately not the same object.
 *
 * The wire schema below is written for conversion rather than for validation — no `.trim()`, no
 * `.nullish()`, no defaults, every field required and explicitly nullable — because those
 * refinements do not survive JSON Schema and a half-converted schema is worse than a simple one.
 * `parseModelAnswer` applies the real rules to whatever comes back.
 *
 * ## Sampling parameters
 *
 * There are none, deliberately. `temperature`, `top_p` and `top_k` are rejected outright by the
 * current Opus family, and this class defaults to that family. Reasoning depth is asked for with
 * `output_config.effort` instead.
 */

const WIRE_CLAIM = z.object({
  kind: z.enum(CLAIM_KINDS),
  text: z.string(),
  /** `kind:id` tokens, drawn only from the evidence packet. Containment is checked afterwards. */
  citations: z.array(z.string()),
  projectId: z.string().nullable(),
});

const WIRE_ANSWER = z.object({
  headline: z.string(),
  claims: z.array(WIRE_CLAIM),
  missionSuggestion: z
    .object({
      rawRequest: z.string(),
      projectId: z.string().nullable(),
      rationale: z.string(),
    })
    .nullable(),
});

/**
 * Room to answer without room to ramble.
 *
 * An answer is at most twenty claims of six hundred characters, so this is several times what a
 * conforming answer needs — sized against the schema rather than guessed, and generous enough
 * that thinking tokens cannot truncate the JSON before it closes.
 */
const MAX_TOKENS = 8_000;

/** Long enough for a real answer over a full evidence packet; short enough to fail visibly. */
const DEFAULT_TIMEOUT_MS = 120_000;

export interface AnthropicAnswerProviderOptions {
  readonly apiKey: string;
  readonly model: string;
  readonly logger?: Logger;
  readonly timeoutMs?: number;
  /** Injected in tests, so no test can reach the network by forgetting to pass one. */
  readonly client?: Pick<Anthropic, 'messages'>;
}

export class AnthropicAnswerProvider implements AnswerProvider {
  readonly name = 'anthropic';
  readonly model: string;

  private readonly client: Pick<Anthropic, 'messages'>;
  private readonly log: Logger;
  private readonly timeoutMs: number;

  constructor(options: AnthropicAnswerProviderOptions) {
    this.model = options.model;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.log = (options.logger ?? rootLogger()).child({ answerProvider: 'anthropic' });
    this.client =
      options.client ??
      new Anthropic({ apiKey: options.apiKey, timeout: this.timeoutMs, maxRetries: 1 });
  }

  isConfigured(): boolean {
    return true;
  }

  async generate(request: AnswerGenerationRequest): Promise<AnswerGenerationResult> {
    const started = Date.now();
    const prompt = buildAnswerPrompt(request);
    const system = buildAnswerInstructions({
      scopeReason: request.scopeReason,
      routing: request.routing,
    });

    /*
     * The owner's cancel reaches the network. `signal` is the same one the answer service aborts,
     * so stopping an answer stops the request rather than merely ignoring its result.
     */
    const response = await this.client.messages.create(
      {
        model: this.model,
        max_tokens: MAX_TOKENS,
        system,
        messages: [{ role: 'user', content: prompt }],
        output_config: { format: zodOutputFormat(WIRE_ANSWER), effort: 'medium' },
      },
      { signal: request.signal },
    );

    const answer = parseModelAnswer(extractAnswerPayload(response));
    const usage = readUsage(response);

    this.log.debug('answer generated', {
      model: this.model,
      claims: answer.claims.length,
      /* Counts only. The question, the evidence and the answer text are never logged here. */
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
    });

    return {
      answer,
      usage,
      provider: this.name,
      model: this.model,
      latencyMs: Date.now() - started,
    };
  }
}

/* --------------------------------------------------------------- extraction */

/**
 * Get the answer object out of the response.
 *
 * `parsed_output` is what a schema-constrained response carries and is preferred. The text path
 * is the fallback for a response that arrived without it — an older model, a provider proxy, a
 * future SDK that moves the field — and it is a fallback rather than the primary because a model
 * free to write prose around its JSON eventually will.
 */
function extractAnswerPayload(response: unknown): unknown {
  const parsed = (response as { parsed_output?: unknown }).parsed_output;
  if (parsed !== null && parsed !== undefined) return parsed;

  const text = extractText(response);
  if (!text) throw new Error('The answer model returned an empty response.');
  return JSON.parse(stripFences(text));
}

/** Tolerates a model that fenced its JSON or wrapped it in a sentence. */
export function stripFences(text: string): string {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  const body = fenced?.[1] ?? trimmed;
  const firstBrace = body.indexOf('{');
  const lastBrace = body.lastIndexOf('}');
  if (firstBrace === -1 || lastBrace <= firstBrace) return body;
  return body.slice(firstBrace, lastBrace + 1);
}

function extractText(response: unknown): string | null {
  const content = (response as { content?: unknown }).content;
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const block of content) {
    if (block && typeof block === 'object' && (block as { type?: unknown }).type === 'text') {
      const value = (block as { text?: unknown }).text;
      if (typeof value === 'string') parts.push(value);
    }
  }
  const joined = parts.join('\n').trim();
  return joined.length > 0 ? joined : null;
}

/**
 * Read the usage the provider reported, and nothing else.
 *
 * Absent stays absent. A missing token count written as zero would understate a bill, and the
 * cost is null because this API reports tokens rather than money — `costBasis` downstream then
 * says `unknown` rather than claiming the answer was free.
 */
function readUsage(response: unknown): AnswerGenerationResult['usage'] {
  const usage = (response as { usage?: Record<string, unknown> }).usage ?? {};
  const number = (value: unknown): number | null =>
    typeof value === 'number' && Number.isFinite(value) ? value : null;

  return {
    inputTokens: number(usage.input_tokens),
    outputTokens: number(usage.output_tokens),
    cachedInputTokens: number(usage.cache_read_input_tokens),
    reportedCostUsd: null,
  };
}
