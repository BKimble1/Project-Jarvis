import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';

import { ideaEvaluationSchema, type IdeaEvaluation } from '@/domain/proposal';
import { logger as rootLogger, type Logger } from '@/server/logging/logger';
import type { IdeaEvaluationRequest, IdeaEvaluator } from './idea-evaluator';

/**
 * Thinking about an idea, with a model, and saying so.
 *
 * ## What it is allowed to do
 *
 * One `messages.create` with **no `tools` array** — the same shape as the answer provider, for the
 * same reason. The idea text comes from the owner, but a request to evaluate something is exactly
 * where a pasted document could arrive, and an interface with no tool channel cannot be talked into
 * using one. The worst a hostile paragraph achieves is a wrong opinion, which is visible.
 *
 * ## Why it never claims research
 *
 * It has no way to do any. There is no web search tool here and no retrieval; `basis` is fixed to
 * `reasoned` on the way out rather than taken from the model, so a model that decided to describe
 * itself as having checked the market cannot make that claim through this path.
 *
 * ## Cost, stated plainly
 *
 * This runs on `ANTHROPIC_API_KEY`, which is the paid API and not the owner's Claude subscription.
 * It is constructed only when that key is configured, which is a deliberate act — the container
 * falls back to `UnconfiguredIdeaEvaluator` otherwise rather than quietly starting to bill.
 */

/**
 * The wire schema, written for conversion rather than validation.
 *
 * No `.trim()`, no defaults, every field required — those refinements do not survive JSON Schema,
 * and a half-converted schema is worse than a plain one. `ideaEvaluationSchema` applies the real
 * rules to whatever comes back.
 */
const WIRE_EVALUATION = z.object({
  likelyUser: z.string(),
  problem: z.string(),
  verdict: z.string(),
  smallestV1: z.array(z.string()),
  assumptions: z.array(z.string()),
  uncertainties: z.array(z.string()),
  questions: z.array(z.string()),
});

const INSTRUCTIONS = [
  'You are helping the owner decide whether a small software idea is worth building.',
  'Answer from the description alone. You have no search, no browsing and no sources.',
  'Never imply you checked a market, a competitor, or any external fact.',
  'Say plainly when something is unknown; "I do not know who else would want this" is a real answer.',
  'The smallest V1 is the least that would be worth using once — not a roadmap.',
  'Ask only questions whose answers would change that V1. If a question would not change it, leave it out.',
  'Prefer four short questions to eight thorough ones.',
  'Be concise. This is read on a dashboard, not in a document.',
].join(' ');

const MAX_TOKENS = 4000;
const DEFAULT_TIMEOUT_MS = 60_000;

export interface AnthropicIdeaEvaluatorOptions {
  readonly apiKey: string;
  readonly model: string;
  readonly timeoutMs?: number;
  readonly logger?: Logger;
  readonly client?: Pick<Anthropic, 'messages'>;
}

export class AnthropicIdeaEvaluator implements IdeaEvaluator {
  readonly name = 'anthropic';
  private readonly model: string;
  private readonly client: Pick<Anthropic, 'messages'>;
  private readonly log: Logger;

  constructor(options: AnthropicIdeaEvaluatorOptions) {
    this.model = options.model;
    this.log = (options.logger ?? rootLogger()).child({ ideaEvaluator: 'anthropic' });
    this.client =
      options.client ??
      new Anthropic({
        apiKey: options.apiKey,
        timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        maxRetries: 1,
      });
  }

  isConfigured(): boolean {
    return true;
  }

  async evaluate(request: IdeaEvaluationRequest): Promise<IdeaEvaluation> {
    const response = await this.client.messages.create(
      {
        model: this.model,
        max_tokens: MAX_TOKENS,
        system: INSTRUCTIONS,
        messages: [
          {
            role: 'user',
            content: `Idea${request.title ? ` (${request.title})` : ''}:\n\n${request.idea}`,
          },
        ],
        output_config: { format: zodOutputFormat(WIRE_EVALUATION), effort: 'medium' },
      },
      request.signal ? { signal: request.signal } : {},
    );

    const payload = extractPayload(response);

    this.log.debug('idea evaluated', {
      model: this.model,
      /* Counts only. The idea text and the evaluation are never logged. */
      questions: payload.questions.length,
      v1Items: payload.smallestV1.length,
    });

    /*
     * `basis` is stamped here, not read from the model. A model cannot promote its own reasoning to
     * research by saying it did some.
     */
    return ideaEvaluationSchema.parse({ ...payload, basis: 'reasoned' });
  }
}

function extractPayload(response: Anthropic.Message): z.infer<typeof WIRE_EVALUATION> {
  for (const block of response.content) {
    if (block.type !== 'text') continue;
    try {
      return WIRE_EVALUATION.parse(JSON.parse(block.text));
    } catch {
      continue;
    }
  }
  throw new Error('The model did not return an evaluation in the requested shape.');
}
