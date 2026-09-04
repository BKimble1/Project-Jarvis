/**
 * Whether Jarvis can actually do the thing it is for.
 *
 * ## Four states, and why three would not do
 *
 * The temptation is a boolean, or a traffic light. Both collapse a distinction this system spent
 * five phases building:
 *
 *  - **missing** — nothing is configured. Not an error; a fresh install lives here.
 *  - **configured** — a setting exists. That is *all* it means. It has not been used, and nothing
 *    has confirmed it works. This is the state most likely to be mistaken for readiness, so it is
 *    named separately and never counted as one.
 *  - **verified** — something actually happened. A query returned, a credential authenticated, a
 *    worker sent a heartbeat, a mission produced a receipt.
 *  - **failed** — it was tried and it did not work.
 *
 * A diagnostic that reports "ANTHROPIC_API_KEY is set ✓" is reporting `configured` and calling it
 * `verified`, which is the specific dishonesty this type exists to prevent.
 *
 * ## Blocking
 *
 * `blocking` marks the checks V1 cannot operate without. It is a property of the check, not of the
 * result, so the set of things that must work is readable in one place rather than inferred from
 * whichever ones happened to fail today.
 */

export const READINESS_STATES = ['missing', 'configured', 'verified', 'failed'] as const;
export type ReadinessState = (typeof READINESS_STATES)[number];

export const READINESS_STATE_LABELS: Record<ReadinessState, string> = {
  missing: 'Not configured',
  configured: 'Configured, not yet proved',
  verified: 'Working',
  failed: 'Failing',
};

/** Ordered as an owner works through them, which is also the order the diagnostic prints. */
export const READINESS_AREAS = [
  'runtime',
  'database',
  'access',
  'worker',
  'model',
  'github',
  'sandbox',
  'display',
  'qualification',
] as const;
export type ReadinessArea = (typeof READINESS_AREAS)[number];

export const READINESS_AREA_LABELS: Record<ReadinessArea, string> = {
  runtime: 'Runtime',
  database: 'Database',
  access: 'Access',
  worker: 'Worker',
  model: 'Model provider',
  github: 'GitHub',
  sandbox: 'Sandbox repository',
  display: 'Wallboard',
  qualification: 'Qualification',
};

export interface ReadinessCheck {
  readonly id: string;
  readonly area: ReadinessArea;
  readonly title: string;
  readonly state: ReadinessState;
  /**
   * One sentence about what was found.
   *
   * Never a credential, never a raw environment value, never a connection string. The closest it
   * comes is naming an identity a credential authenticated as, which is what makes it useful
   * without making it dangerous.
   */
  readonly detail: string;
  /** Exactly what to do next, when this is not `verified`. Null when nothing is needed. */
  readonly nextAction: string | null;
  /** True when V1 cannot operate while this is unresolved. */
  readonly blocking: boolean;
}

export interface ReadinessReport {
  readonly checks: readonly ReadinessCheck[];
  /** False when any blocking check is `missing` or `failed`. */
  readonly canOperate: boolean;
  /** One line for a badge or a log. Says what is wrong, or that nothing is. */
  readonly summary: string;
  readonly checkedAt: string;
}

export function isBlocked(check: ReadinessCheck): boolean {
  return check.blocking && (check.state === 'missing' || check.state === 'failed');
}

/**
 * Assemble the report from finished checks.
 *
 * Kept in the domain and pure, so the same summary sentence is produced by the CLI, the HTTP
 * route and the interface. Three implementations of "is Jarvis ready" would eventually be three
 * different answers.
 */
export function summariseReadiness(
  checks: readonly ReadinessCheck[],
  checkedAtIso: string,
): ReadinessReport {
  const blocked = checks.filter(isBlocked);
  const failing = checks.filter((check) => check.state === 'failed' && !check.blocking);
  const unproved = checks.filter((check) => check.state === 'configured');

  const summary =
    blocked.length > 0
      ? `Jarvis cannot run yet: ${blocked.map((check) => check.title.toLowerCase()).join('; ')}.`
      : failing.length > 0
        ? `Jarvis can run, but ${failing.length} check${failing.length === 1 ? ' is' : 's are'} failing.`
        : unproved.length > 0
          ? `Everything required is configured; ${unproved.length} thing${unproved.length === 1 ? ' has' : 's have'} not been proved yet.`
          : 'Everything required is working.';

  return {
    checks,
    canOperate: blocked.length === 0,
    summary,
    checkedAt: checkedAtIso,
  };
}
