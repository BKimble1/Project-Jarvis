import { CLAIM_KIND_LABELS, CLAIM_PROVENANCE, type AnswerClaim } from '@/domain/answer';
import {
  ANSWER_MODE_LABELS,
  ANSWER_MODE_MEANING,
  ANSWER_STATE_LABELS,
  isPresentableAnswer,
} from '@/domain/answer-run';
import type { AskResult } from './answer-service';

/**
 * The wire shape of an answer.
 *
 * One function so every surface — the page, the poll, the conversation history — describes an
 * answer identically. The labels are resolved here rather than in the browser because they are
 * part of the honesty contract: whether something was written by a model or assembled from
 * records has to read the same everywhere, and duplicating that mapping in a component is how the
 * two eventually disagree.
 */
export function presentAnswer(result: AskResult) {
  const { run } = result;
  return {
    id: run.id,
    conversationId: run.conversationId,
    question: run.question,
    state: run.state,
    stateLabel: ANSWER_STATE_LABELS[run.state],
    /* False until validation has run, so a caller cannot render a draft as grounded. */
    presentable: isPresentableAnswer(run.state),
    mode: run.mode,
    modeLabel: ANSWER_MODE_LABELS[run.mode],
    modeMeaning: ANSWER_MODE_MEANING[run.mode],
    method: run.method,
    headline: result.headline,
    claims: result.claims.map(presentClaim),
    coverage: result.coverage,
    limitations: run.limitations,
    retrievalMode: run.retrievalMode,
    rejectionRule: run.rejectionRule,
    rejectionReason: run.rejectionReason,
    missionSuggestion: result.missionSuggestion,
    evidenceCount: result.snapshot.items.length,
    truncated: result.snapshot.truncated,
    gaps: result.snapshot.gaps,
    scope: run.scope,
    projectIds: run.projectIds,
    /* Numbers, and null where the provider reported nothing. Never coerced to zero. */
    usage: {
      inputTokens: run.inputTokens,
      outputTokens: run.outputTokens,
      cachedInputTokens: run.cachedInputTokens,
      costUsd: run.costUsd,
      latencyMs: run.latencyMs,
    },
    provider: run.provider,
    model: run.model,
    createdAt: run.createdAt,
    finishedAt: run.finishedAt,
    cancelledAt: run.cancelledAt,
  };
}

function presentClaim(claim: AnswerClaim) {
  return {
    kind: claim.kind,
    kindLabel: CLAIM_KIND_LABELS[claim.kind],
    provenance: CLAIM_PROVENANCE[claim.kind],
    text: claim.text,
    projectId: claim.projectId,
    /* Citations as the server built them: the model chose which, never how they are shown. */
    citations: claim.citations.map((citation) => ({
      kind: citation.kind,
      id: citation.id,
      label: citation.label,
      href: citation.href,
      locator: citation.locator,
    })),
  };
}
