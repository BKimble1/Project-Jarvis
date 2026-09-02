import Anthropic from '@anthropic-ai/sdk';
import type { BriefingNarrative, PortfolioNarrative } from '@/domain/status';
import { logger as rootLogger, type Logger } from '@/server/logging/logger';
import { buildPortfolioNarrative, buildProjectNarrative } from './deterministic';
import type {
  BriefingNarrator,
  NarrationPayload,
  NarrationResult,
  PortfolioNarrationPayload,
} from './types';
import { validatePortfolioNarrative, validateProjectNarrative } from './validate';

/**
 * The optional AI narrator.
 *
 * Guarantees encoded here:
 *  - Only normalised, already-public project evidence is sent. No credentials, no environment
 *    variables, no raw provider payloads, no repository contents.
 *  - The model is given **no tools** — it cannot call anything, only write.
 *  - Output must be JSON matching the briefing schema, and is additionally checked against the
 *    deterministic assessment before it is accepted.
 *  - Any failure — network, timeout, malformed JSON, invented content — falls back to the
 *    deterministic narrative and is recorded as `ai_failed_fallback`.
 */

const SYSTEM_PROMPT = `You are the writing layer of a private project status tool called Jarvis.

You will receive a JSON object containing a deterministic assessment of one project (or a
portfolio) plus the evidence records that produced it.

Your job is ONLY to improve wording, ordering and concision.

Hard rules:
- Never invent work, dates, blockers, decisions, releases or completion. If it is not in the
  assessment, it does not exist.
- Never state or imply a completion percentage, health score or progress bar.
- Never contradict the assessment's status, phase or freshness.
- Only cite evidence IDs that appear in the supplied evidence array.
- If evidence is thin, say plainly that it is unknown rather than guessing.
- Write in calm, direct British-neutral English. No marketing tone, no emoji, no exclamation marks.

Respond with a single JSON object and nothing else — no prose, no markdown fences.`;

const PROJECT_SHAPE = `{
  "currentState": string,            // one sentence
  "recentlyCompleted": string[],     // at most as many items as the assessment lists
  "inProgress": string[],
  "blockers": string[],
  "decisionsNeeded": string[],
  "nextActions": string[],           // at most 3, drawn from the recommended actions
  "unknowns": string[],
  "citedEvidenceIds": string[]
}`;

const PORTFOLIO_SHAPE = `{
  "headline": string,
  "importantChanges": string[],
  "decisionsNeeded": string[],
  "focusOrder": string[],
  "unknowns": string[],
  "citedEvidenceIds": string[]
}`;

export interface AnthropicNarratorOptions {
  readonly apiKey: string;
  readonly model: string;
  readonly logger?: Logger;
  readonly timeoutMs?: number;
  /** Injected in tests so no network call is ever made. */
  readonly client?: Pick<Anthropic, 'messages'>;
}

export class AnthropicNarrator implements BriefingNarrator {
  readonly name = 'anthropic';

  private readonly client: Pick<Anthropic, 'messages'>;
  private readonly model: string;
  private readonly log: Logger;
  private readonly timeoutMs: number;

  constructor(options: AnthropicNarratorOptions) {
    this.model = options.model;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.log = (options.logger ?? rootLogger()).child({ narrator: 'anthropic' });
    this.client =
      options.client ??
      new Anthropic({ apiKey: options.apiKey, timeout: this.timeoutMs, maxRetries: 1 });
  }

  isAvailable(): boolean {
    return true;
  }

  async narrateProject(payload: NarrationPayload): Promise<NarrationResult<BriefingNarrative>> {
    const fallback = buildProjectNarrative(payload);
    try {
      const raw = await this.ask(
        `Rewrite this project briefing.\n\nRequired JSON shape:\n${PROJECT_SHAPE}\n\nAssessment:\n${JSON.stringify(payload)}`,
      );
      const validated = validateProjectNarrative(raw, payload);
      if (!validated.ok) {
        this.log.warn('ai narration rejected', { reason: validated.reason });
        return { narrative: fallback, method: 'ai_failed_fallback', error: validated.reason };
      }
      return { narrative: validated.value, method: 'ai_narrated', error: null };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'The AI narrator was unavailable.';
      this.log.warn('ai narration failed', { error: message });
      return { narrative: fallback, method: 'ai_failed_fallback', error: message };
    }
  }

  async narratePortfolio(
    payload: PortfolioNarrationPayload,
  ): Promise<NarrationResult<PortfolioNarrative>> {
    const fallback = buildPortfolioNarrative(payload);
    try {
      const raw = await this.ask(
        `Rewrite this portfolio briefing.\n\nRequired JSON shape:\n${PORTFOLIO_SHAPE}\n\nAssessment:\n${JSON.stringify(payload)}`,
      );
      const validated = validatePortfolioNarrative(raw, payload);
      if (!validated.ok) {
        this.log.warn('ai narration rejected', { reason: validated.reason });
        return { narrative: fallback, method: 'ai_failed_fallback', error: validated.reason };
      }
      return { narrative: validated.value, method: 'ai_narrated', error: null };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'The AI narrator was unavailable.';
      this.log.warn('ai narration failed', { error: message });
      return { narrative: fallback, method: 'ai_failed_fallback', error: message };
    }
  }

  private async ask(prompt: string): Promise<unknown> {
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 1500,
      temperature: 0,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: prompt }],
      /* Deliberately no `tools`: the narrator can write, and nothing else. */
    });

    const text = extractText(response);
    if (!text) throw new Error('The AI narrator returned an empty response.');
    return JSON.parse(stripFences(text));
  }
}

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
