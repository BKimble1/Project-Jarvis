/**
 * Turning a capacity Report into words — sparingly.
 *
 * Jarvis should not narrate its own telemetry. `summarizeForSpeech` returns null
 * unless something genuinely changed for the worse: a window crossing into a low
 * band, or the first time capacity becomes unknown.
 */

const LOW_PERCENT = 10;
const CRITICAL_PERCENT = 5;

function remainingOf(window) {
  if (!window || typeof window !== 'object') return null;
  if (Number.isFinite(window.remainingPercent)) return window.remainingPercent;
  if (Number.isFinite(window.usedPercent)) return 100 - window.usedPercent;
  return null;
}

/** Minimum remainingPercent across the report's windows; null when unknown. */
export function worstRemaining(report) {
  const windows = Array.isArray(report?.windows) ? report.windows : [];
  let worst = null;
  for (const w of windows) {
    const remaining = remainingOf(w);
    if (remaining === null) continue;
    if (worst === null || remaining < worst) worst = remaining;
  }
  return worst;
}

function tightestWindow(report) {
  const windows = Array.isArray(report?.windows) ? report.windows : [];
  let best = null;
  let bestRemaining = null;
  for (const w of windows) {
    const remaining = remainingOf(w);
    if (remaining === null) continue;
    if (bestRemaining === null || remaining < bestRemaining) { best = w; bestRemaining = remaining; }
  }
  return best;
}

/** 0 = fine, 1 = low, 2 = critical. */
function severity(remaining) {
  if (remaining === null) return 0;
  if (remaining <= CRITICAL_PERCENT) return 2;
  if (remaining <= LOW_PERCENT) return 1;
  return 0;
}

/**
 * @param {object} report current Report
 * @param {{previous?: object|null}} [opts] the previously spoken-about report, so
 *        repeated states stay silent instead of chattering.
 * @returns {string|null}
 */
export function summarizeForSpeech(report, { previous = null } = {}) {
  if (!report || typeof report !== 'object') return null;

  if (report.status === 'unavailable') {
    if (previous && previous.status === 'unavailable') return null;
    return "I can't read your Claude usage limits right now, so I'm pacing work conservatively.";
  }

  const worst = worstRemaining(report);
  const level = severity(worst);
  if (level === 0) return null;

  const previousLevel = previous && previous.status !== 'unavailable'
    ? severity(worstRemaining(previous))
    : 0;
  if (level <= previousLevel) return null;   // already said it at this level or worse

  const window = tightestWindow(report);
  const label = window?.label ?? 'usage';
  const pct = Math.round(worst);
  const resets = window?.resetsAtLocal ? `, resetting ${window.resetsAtLocal}` : '';
  const lead = level === 2 ? 'Nearly out of capacity' : 'Running low';
  return `${lead}: ${pct}% left on the ${label} limit${resets}.`;
}
