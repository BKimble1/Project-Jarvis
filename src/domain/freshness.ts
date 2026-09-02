import type { FreshnessAssessment } from './status';
import type { FreshnessState, ProjectType } from './enums';

/**
 * Staleness thresholds, in hours, per project type.
 *
 * A GitHub-backed software project is expected to produce evidence often; a career or research
 * project is not. Using one global threshold would either spam attention for slow-moving
 * projects or hide genuinely abandoned fast-moving ones.
 */
export const FRESHNESS_THRESHOLDS: Readonly<Record<ProjectType, { live: number; recent: number }>> = {
  software: { live: 6, recent: 24 * 7 },
  ios_app: { live: 6, recent: 24 * 7 },
  website: { live: 6, recent: 24 * 7 },
  business: { live: 24, recent: 24 * 21 },
  product_idea: { live: 24, recent: 24 * 30 },
  research: { live: 24, recent: 24 * 21 },
  school: { live: 24, recent: 24 * 14 },
  career: { live: 24, recent: 24 * 30 },
  engineering: { live: 12, recent: 24 * 14 },
  document: { live: 24, recent: 24 * 14 },
  personal: { live: 24, recent: 24 * 30 },
  other: { live: 24, recent: 24 * 21 },
};

export interface FreshnessInput {
  readonly type: ProjectType;
  /** Most recent successful observation of any kind (sync success or manual update). */
  readonly lastObservedAt: string | null;
  /** Set when the most recent synchronisation attempt failed. */
  readonly lastSyncFailedAt: string | null;
  readonly lastSyncError: string | null;
  readonly hasSources: boolean;
  readonly now: Date;
}

const HOUR_MS = 3_600_000;

export function hoursBetween(from: Date, to: Date): number {
  return (to.getTime() - from.getTime()) / HOUR_MS;
}

/**
 * Decide how much the displayed data can be trusted.
 *
 * The important product rule lives here: **a failed synchronisation never means "no activity"**.
 * It means the last-known-good data is being shown and is explicitly marked as failing.
 */
export function assessFreshness(input: FreshnessInput): FreshnessAssessment {
  const { type, lastObservedAt, lastSyncFailedAt, lastSyncError, now } = input;
  const thresholds = FRESHNESS_THRESHOLDS[type];

  const observed = lastObservedAt ? new Date(lastObservedAt) : null;
  const observedValid = observed && !Number.isNaN(observed.getTime()) ? observed : null;
  const ageHours = observedValid ? Math.max(0, hoursBetween(observedValid, now)) : null;

  const failed = lastSyncFailedAt ? new Date(lastSyncFailedAt) : null;
  const failedValid = failed && !Number.isNaN(failed.getTime()) ? failed : null;
  const syncIsFailing =
    failedValid !== null && (observedValid === null || failedValid.getTime() > observedValid.getTime());

  if (syncIsFailing) {
    return {
      state: 'failing',
      observedAt: observedValid ? observedValid.toISOString() : null,
      ageHours,
      explanation: observedValid
        ? `Showing the last data that synchronised successfully ${formatAge(ageHours)} ago; the most recent attempt failed.`
        : 'No synchronisation has ever succeeded for this project.',
      lastError: lastSyncError ?? null,
    };
  }

  if (!observedValid || ageHours === null) {
    return {
      state: 'never',
      observedAt: null,
      ageHours: null,
      explanation: input.hasSources
        ? 'This project has a source but has never been synchronised.'
        : 'Nothing has been recorded for this project yet.',
      lastError: null,
    };
  }

  let state: FreshnessState;
  if (ageHours <= thresholds.live) state = 'live';
  else if (ageHours <= thresholds.recent) state = 'recent';
  else state = 'stale';

  return {
    state,
    observedAt: observedValid.toISOString(),
    ageHours,
    explanation:
      state === 'stale'
        ? `No new evidence for ${formatAge(ageHours)}. Treat the status below as out of date.`
        : `Last evidence observed ${formatAge(ageHours)} ago.`,
    lastError: null,
  };
}

export function formatAge(hours: number | null): string {
  if (hours === null) return 'an unknown time';
  if (hours < 1) return 'less than an hour';
  if (hours < 48) return `${Math.round(hours)} hour${Math.round(hours) === 1 ? '' : 's'}`;
  const days = Math.round(hours / 24);
  if (days < 60) return `${days} day${days === 1 ? '' : 's'}`;
  const months = Math.round(days / 30);
  return `${months} month${months === 1 ? '' : 's'}`;
}

/** Freshness states that must never be presented as an up-to-date status. */
export function isUntrustworthy(state: FreshnessState): boolean {
  return state === 'stale' || state === 'failing' || state === 'never';
}
