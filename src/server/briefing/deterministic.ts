import { formatAge } from '@/domain/freshness';
import type { BriefingNarrative, PortfolioNarrative } from '@/domain/status';
import type {
  BriefingNarrator,
  NarrationPayload,
  NarrationResult,
  PortfolioNarrationPayload,
} from './types';

/**
 * The deterministic narrator.
 *
 * This is the default and the fallback: Jarvis is fully useful with no AI key configured.
 * It restates the assessment in plain English and never adds a fact of its own.
 */
export class DeterministicNarrator implements BriefingNarrator {
  readonly name = 'deterministic';

  isAvailable(): boolean {
    return true;
  }

  async narrateProject(payload: NarrationPayload): Promise<NarrationResult<BriefingNarrative>> {
    return { narrative: buildProjectNarrative(payload), method: 'deterministic', error: null };
  }

  async narratePortfolio(
    payload: PortfolioNarrationPayload,
  ): Promise<NarrationResult<PortfolioNarrative>> {
    return { narrative: buildPortfolioNarrative(payload), method: 'deterministic', error: null };
  }
}

export function buildProjectNarrative(payload: NarrationPayload): BriefingNarrative {
  const { assessment } = payload;
  const freshnessNote = (() => {
    switch (assessment.freshness.state) {
      case 'failing':
        return 'Synchronisation is currently failing; this is the last verified information.';
      case 'stale':
        return `The newest evidence is ${formatAge(assessment.freshness.ageHours)} old.`;
      case 'never':
        return 'No evidence has been observed for this project yet.';
      default:
        return `Evidence observed ${formatAge(assessment.freshness.ageHours)} ago.`;
    }
  })();

  return {
    currentState: assessment.headline.text,
    recentlyCompleted: assessment.recentlyCompleted.map((item) => item.text).slice(0, 8),
    inProgress: assessment.currentWork.map((item) => item.text).slice(0, 8),
    blockers: assessment.activeBlockers.map((item) => item.text).slice(0, 8),
    decisionsNeeded: assessment.decisionsNeeded.map((item) => item.text).slice(0, 8),
    nextActions: assessment.recommendedActions.slice(0, 3).map((item) => item.action),
    unknowns: [freshnessNote, ...assessment.unknowns].slice(0, 8),
    citedEvidenceIds: assessment.keyEvidenceIds.slice(0, 40),
  };
}

export function buildPortfolioNarrative(payload: PortfolioNarrationPayload): PortfolioNarrative {
  const { counts } = payload.assessment;
  const parts: string[] = [`${counts.active} active project${counts.active === 1 ? '' : 's'}`];
  if (counts.needsAttention > 0) parts.push(`${counts.needsAttention} needing your attention`);
  if (counts.blocked > 0) parts.push(`${counts.blocked} blocked`);
  if (counts.waiting > 0) parts.push(`${counts.waiting} waiting`);
  if (counts.paused > 0) parts.push(`${counts.paused} paused`);
  if (counts.stale > 0) parts.push(`${counts.stale} with stale data`);

  const headline =
    counts.total === 0
      ? 'No projects yet. Add one to give Jarvis something to watch.'
      : `${parts.join(', ')}.`;

  return {
    headline,
    importantChanges: payload.assessment.recentChanges
      .slice(0, 8)
      .map((change) => `${change.projectName}: ${change.summary}`),
    decisionsNeeded: payload.assessment.decisionsNeeded.slice(0, 8).map((reason) => reason.summary),
    focusOrder: payload.assessment.focusOrder
      .slice(0, 6)
      .map((entry) => `${entry.projectName} — ${entry.reason}`),
    unknowns: payload.assessment.unknowns.slice(0, 8),
    citedEvidenceIds: payload.assessment.recentChanges
      .flatMap((change) => change.evidenceIds)
      .slice(0, 60),
  };
}
