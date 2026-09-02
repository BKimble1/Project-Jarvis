/**
 * Tunable thresholds for the deterministic status rules.
 *
 * They live in one place so the rules stay readable and every test can state the exact window
 * it is exercising rather than hard-coding magic numbers.
 */
export const STATUS_WINDOWS = {
  /** Work merged/closed inside this window counts as "recently completed". */
  recentlyCompletedDays: 14,
  /** A failed workflow older than this is history, not an alarm. */
  failedWorkflowDays: 14,
  /** An open pull request untouched for longer than this is not evidence of active work. */
  openPrActiveDays: 14,
  /** Commits inside this window support a claim of work in progress. */
  activeCommitDays: 7,
  /** How far back the portfolio "important recent changes" list looks. */
  portfolioChangeDays: 14,
} as const;

/** Workflow conclusions that mean the build is broken. */
export const FAILING_CONCLUSIONS = new Set(['failure', 'timed_out', 'startup_failure']);
/** Conclusions that are neither success nor failure and must not raise an alarm. */
export const NEUTRAL_CONCLUSIONS = new Set(['neutral', 'skipped', 'cancelled', 'action_required', 'stale']);
