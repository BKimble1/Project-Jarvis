/**
 * Project phase machine and run gating.
 *
 * planning → implementing → verifying → reviewing → (repairing → verifying)*
 *          → delivering → done
 */

export const PHASES = Object.freeze(['planning', 'implementing', 'verifying', 'reviewing', 'repairing', 'delivering']);

/** Statuses from which a project never resumes on its own. */
export const TERMINAL_STATUSES = Object.freeze(['delivered', 'evaluated', 'stopped']);

/** Statuses that stop the loop from picking the project up right now. */
export const NON_RUNNABLE_STATUSES = Object.freeze(['paused', 'stopped', 'blocked', 'delivered', 'evaluated']);

const NON_RUNNABLE = new Set(NON_RUNNABLE_STATUSES);
const TERMINAL = new Set(TERMINAL_STATUSES);

/**
 * The phase that follows `current`.
 * `reviewing` is the only branch point: it goes to `repairing` when repairs are
 * needed and to `delivering` otherwise. `repairing` always re-verifies, which
 * is what makes the repair loop a loop.
 *
 * A missing, null or non-object second argument means "no repairs needed"
 * rather than a destructuring crash — callers forward whatever they were given.
 *
 * @param {string|null|undefined} current
 * @param {{repairsNeeded?: boolean}} [opts]
 * @returns {'planning'|'implementing'|'verifying'|'reviewing'|'repairing'|'delivering'|'done'}
 */
export function nextPhase(current, opts) {
  const repairsNeeded = Boolean(opts?.repairsNeeded);
  switch (current) {
    case 'planning': return 'implementing';
    case 'implementing': return 'verifying';
    case 'verifying': return 'reviewing';
    case 'reviewing': return repairsNeeded ? 'repairing' : 'delivering';
    case 'repairing': return 'verifying';
    case 'delivering': return 'done';
    case 'done': return 'done';
    case 'idle':
    case null:
    case undefined:
    case '':
      return 'planning';
    default:
      throw new TypeError(`nextPhase: unknown phase ${JSON.stringify(current)}`);
  }
}

/** True for statuses that end the project's life. */
export function isTerminal(status) {
  return TERMINAL.has(status);
}

/** False for paused / stopped / blocked / delivered / evaluated (and for nothing at all). */
export function canRun(project) {
  if (!project || typeof project !== 'object') return false;
  return !NON_RUNNABLE.has(project.status);
}

/** True once the phase machine has run out of phases. */
export function isFinalPhase(phase) {
  return phase === 'done';
}
