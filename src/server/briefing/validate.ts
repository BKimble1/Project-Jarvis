import { briefingNarrativeSchema, portfolioNarrativeSchema } from '@/domain/status';
import type { BriefingNarrative, PortfolioNarrative } from '@/domain/status';
import type { NarrationPayload, PortfolioNarrationPayload } from './types';

/**
 * Guard-rails for narrated output.
 *
 * A narrator is a *writer*, not a source. These checks reject any narrative that:
 *  - fails the schema,
 *  - cites an evidence ID that was not supplied,
 *  - claims blockers, decisions or completed work where the deterministic assessment found none,
 *  - or lists more items than the assessment supports.
 *
 * Anything rejected here falls back to the deterministic narrative, so an unreliable model can
 * degrade Jarvis's prose but never its truthfulness.
 */

export interface ValidationFailure {
  readonly ok: false;
  readonly reason: string;
}
export interface ValidationSuccess<T> {
  readonly ok: true;
  readonly value: T;
}
export type ValidationResult<T> = ValidationSuccess<T> | ValidationFailure;

export function validateProjectNarrative(
  raw: unknown,
  payload: NarrationPayload,
): ValidationResult<BriefingNarrative> {
  const parsed = briefingNarrativeSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      reason: `Narrator output failed schema validation: ${firstIssue(parsed.error)}`,
    };
  }
  const narrative = parsed.data;
  const allowed = new Set(payload.evidence.map((item) => item.id));

  for (const id of narrative.citedEvidenceIds) {
    if (!allowed.has(id)) {
      return { ok: false, reason: 'Narrator cited evidence that was not supplied to it.' };
    }
  }

  const { assessment } = payload;
  if (assessment.activeBlockers.length === 0 && narrative.blockers.length > 0) {
    return { ok: false, reason: 'Narrator invented blockers that no evidence supports.' };
  }
  if (assessment.decisionsNeeded.length === 0 && narrative.decisionsNeeded.length > 0) {
    return { ok: false, reason: 'Narrator invented decisions that no evidence supports.' };
  }
  if (assessment.recentlyCompleted.length === 0 && narrative.recentlyCompleted.length > 0) {
    return { ok: false, reason: 'Narrator invented completed work that no evidence supports.' };
  }
  if (assessment.currentWork.length === 0 && narrative.inProgress.length > 0) {
    return { ok: false, reason: 'Narrator invented work in progress that no evidence supports.' };
  }
  if (narrative.blockers.length > assessment.activeBlockers.length) {
    return { ok: false, reason: 'Narrator reported more blockers than the assessment found.' };
  }
  if (narrative.recentlyCompleted.length > assessment.recentlyCompleted.length) {
    return {
      ok: false,
      reason: 'Narrator reported more completed work than the assessment found.',
    };
  }
  if (narrative.nextActions.length > Math.max(3, assessment.recommendedActions.length)) {
    return { ok: false, reason: 'Narrator produced more next actions than were recommended.' };
  }
  if (containsFabricatedProgress(narrative.currentState)) {
    return {
      ok: false,
      reason: 'Narrator produced a completion percentage, which Jarvis never reports.',
    };
  }
  return { ok: true, value: narrative };
}

export function validatePortfolioNarrative(
  raw: unknown,
  payload: PortfolioNarrationPayload,
): ValidationResult<PortfolioNarrative> {
  const parsed = portfolioNarrativeSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      reason: `Narrator output failed schema validation: ${firstIssue(parsed.error)}`,
    };
  }
  const narrative = parsed.data;
  const { assessment } = payload;

  if (assessment.decisionsNeeded.length === 0 && narrative.decisionsNeeded.length > 0) {
    return { ok: false, reason: 'Narrator invented decisions that no evidence supports.' };
  }
  if (narrative.focusOrder.length > Math.max(assessment.focusOrder.length, 1)) {
    return { ok: false, reason: 'Narrator listed more projects than exist in the portfolio.' };
  }
  if (containsFabricatedProgress(narrative.headline)) {
    return {
      ok: false,
      reason: 'Narrator produced a completion percentage, which Jarvis never reports.',
    };
  }
  return { ok: true, value: narrative };
}

/** Jarvis never reports completion percentages or health scores; neither may a narrator. */
export function containsFabricatedProgress(text: string): boolean {
  return /\b\d{1,3}\s?%\s*(complete|done|finished|progress)|\b(health|progress)\s+score\b/i.test(
    text,
  );
}

function firstIssue(error: {
  issues: readonly { path: PropertyKey[]; message: string }[];
}): string {
  const issue = error.issues[0];
  return issue ? `${issue.path.join('.') || 'root'} — ${issue.message}` : 'unknown issue';
}
