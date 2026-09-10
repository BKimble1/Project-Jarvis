/**
 * Usage circles — the honest capacity meter (acceptance req. 4 + 5).
 *
 * `usageViewModel(report)` is a PURE function over the server `Report` shape
 * produced by `src/telemetry/usage.js`. It touches no DOM, so it imports and
 * unit-tests cleanly under `node --test`. `renderUsage()` is the only thing in
 * this module that knows what a document is.
 *
 * The invariant this file exists to protect: **unknown is not zero**. When the
 * report says `unavailable` there are no circles at all — instead a dashed grey
 * placeholder that reads "Unavailable", an expandable explanation, and a
 * recovery action. A 0%-used reading, by contrast, is a solid ring with a real
 * number on it. The two can never be mistaken for one another.
 */

export const RING_RADIUS = 26;
export const RING_BOX = 64;
export const UNAVAILABLE_LABEL = 'Unavailable';

const DEFAULT_EXPLANATION =
  'Jarvis has never obtained a subscription usage reading, so remaining capacity is unknown — not zero.';
const DEFAULT_RECOVERY =
  'Run `claude setup-token` (or `claude login`) so Jarvis can read your subscription limits, then retry.';

const RECOVERY_ACTION = Object.freeze({
  label: 'Retry usage check',
  method: 'POST',
  endpoint: '/api/capacity/refresh',
});

/** Compact, human age: `12s`, `42m`, `3h 5m`, `2d 4h`. Null for a non-age. */
export function formatAge(ms) {
  if (!Number.isFinite(ms) || ms < 0) return null;
  const seconds = Math.round(ms / 1000);
  if (seconds < 45) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  if (hours < 24) return restMinutes ? `${hours}h ${restMinutes}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  return restHours ? `${days}d ${restHours}h` : `${days}d`;
}

/** Stroke maths for a used-fraction arc drawn on a circle of `radius`. */
export function ringGeometry(usedPercent, radius = RING_RADIUS) {
  const circumference = 2 * Math.PI * radius;
  const pct = Math.min(100, Math.max(0, Number(usedPercent) || 0));
  return {
    radius,
    circumference,
    dashArray: circumference,
    dashOffset: circumference * (1 - pct / 100),
  };
}

/** A reading is an actual finite number. Strings, null and NaN are not. */
function isReading(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function toneFor(usedPercent) {
  if (usedPercent >= 85) return 'critical';
  if (usedPercent >= 60) return 'warn';
  return 'ok';
}

function roundPercent(value) {
  return Math.round(value * 10) / 10;
}

function displayPercent(value) {
  const rounded = Math.round(value);
  return `${rounded}`;
}

function circleModel(window, { freshness, staleNote, timezone }) {
  if (!window || typeof window !== 'object') return null;
  // Never coerce an unusable value into a ring: `null` is not 0%, and
  // `Number(null)` is. Only an actual finite number counts as a reading.
  if (!isReading(window.usedPercent)) return null;

  const usedClamped = Math.min(100, Math.max(0, window.usedPercent));
  const remaining = isReading(window.remainingPercent)
    ? Math.min(100, Math.max(0, window.remainingPercent))
    : 100 - usedClamped;

  const key = String(window.key ?? 'window');
  const label = String(window.label ?? key);
  const resetsAtLocal = typeof window.resetsAtLocal === 'string' && window.resetsAtLocal
    ? window.resetsAtLocal
    : null;
  const geometry = ringGeometry(usedClamped);
  const usedText = `${displayPercent(usedClamped)}% used`;
  const remainingText = `${displayPercent(remaining)}% left`;
  const resetLabel = resetsAtLocal ? `Resets ${resetsAtLocal}` : null;

  const ariaParts = [`${label} window`, usedText, remainingText];
  if (resetsAtLocal) ariaParts.push(`resets ${resetsAtLocal} (${timezone})`);
  ariaParts.push(freshness === 'stale' ? (staleNote ?? 'last known reading') : 'live reading');

  return {
    key,
    label,
    usedPercent: roundPercent(usedClamped),
    remainingPercent: roundPercent(remaining),
    usedText,
    remainingText,
    percentText: `${displayPercent(usedClamped)}%`,
    resetsAtLocal,
    resetLabel,
    freshness,
    note: freshness === 'stale' ? staleNote : null,
    ringStyle: 'solid',
    tone: toneFor(usedClamped),
    geometry,
    ariaLabel: `${ariaParts.join(', ')}.`,
  };
}

function unavailableModel({ explanation, recovery, timezone, lastError }) {
  return {
    state: 'unavailable',
    status: 'unavailable',
    headline: `Usage ${UNAVAILABLE_LABEL.toLowerCase()}`,
    freshnessLine: null,
    ageMs: null,
    ageLabel: null,
    stale: false,
    timezone,
    circles: [],
    placeholder: {
      ringStyle: 'dashed',
      tone: 'grey',
      label: UNAVAILABLE_LABEL,
      // Deliberately no number of any kind: unknown must not read as 0%.
      percentText: null,
      detail: 'No reading — capacity is unknown, not zero.',
    },
    explanation: explanation || DEFAULT_EXPLANATION,
    explanationExpandable: true,
    recovery: recovery || DEFAULT_RECOVERY,
    recoveryAction: { ...RECOVERY_ACTION },
    lastErrorReason: lastError?.reason ?? null,
  };
}

/**
 * @param {object|null} report the `/api/state` `capacity` block (a `Report`)
 * @returns {{state:'live'|'stale'|'unavailable', headline:string, circles:object[],
 *            placeholder:object|null, explanation:string|null, recovery:string|null}}
 */
export function usageViewModel(report) {
  const src = report && typeof report === 'object' ? report : {};
  const timezone = typeof src.timezone === 'string' && src.timezone ? src.timezone : 'UTC';
  const status = src.status === 'live' || src.status === 'stale' ? src.status : 'unavailable';
  const lastError = src.lastError && typeof src.lastError === 'object' ? src.lastError : null;

  if (status === 'unavailable') {
    return unavailableModel({
      explanation: src.explanation,
      recovery: src.recovery,
      timezone,
      lastError,
    });
  }

  const ageMs = Number.isFinite(src.ageMs) ? Math.max(0, src.ageMs) : null;
  const ageLabel = ageMs === null ? null : formatAge(ageMs);
  const stale = status === 'stale';
  const staleNote = stale
    ? (ageLabel ? `last known, ${ageLabel} ago` : 'last known reading')
    : null;

  const windows = Array.isArray(src.windows) ? src.windows : [];
  const circles = windows
    .map((w) => circleModel(w, { freshness: stale ? 'stale' : 'live', staleNote, timezone }))
    .filter(Boolean);

  // A "live" report with nothing usable in it is still unknown. Fall through to
  // the unavailable presentation rather than inventing an empty or zeroed ring.
  if (circles.length === 0) {
    return unavailableModel({
      explanation: src.explanation
        || 'The last usage measurement arrived without any usable capacity window.',
      recovery: src.recovery,
      timezone,
      lastError,
    });
  }

  const headline = stale
    ? `Usage · ${staleNote}`
    : 'Usage · live';

  const freshnessLine = stale
    ? `Last known reading${ageLabel ? `, ${ageLabel} old` : ''} · times in ${timezone}`
    : `Live reading${ageLabel ? `, measured ${ageLabel} ago` : ''} · times in ${timezone}`;

  return {
    state: status,
    status,
    headline,
    freshnessLine,
    ageMs,
    ageLabel,
    stale,
    staleNote,
    timezone,
    circles,
    placeholder: null,
    explanation: typeof src.explanation === 'string' ? src.explanation : null,
    explanationExpandable: Boolean(src.explanation),
    recovery: typeof src.recovery === 'string' ? src.recovery : null,
    recoveryAction: stale ? { ...RECOVERY_ACTION } : null,
    lastErrorReason: lastError?.reason ?? null,
  };
}

// --------------------------------------------------------------------- render

const SVG_NS = 'http://www.w3.org/2000/svg';

function svg(name, attrs) {
  const node = document.createElementNS(SVG_NS, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  return node;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}

function ringSvg({ dashed, geometry, tone }) {
  const center = RING_BOX / 2;
  const root = svg('svg', {
    class: `ring ring-${tone}`,
    viewBox: `0 0 ${RING_BOX} ${RING_BOX}`,
    'aria-hidden': 'true',
    focusable: 'false',
  });
  root.appendChild(svg('circle', {
    class: 'ring-track', cx: center, cy: center, r: RING_RADIUS,
  }));
  if (dashed) {
    root.appendChild(svg('circle', {
      class: 'ring-unknown', cx: center, cy: center, r: RING_RADIUS,
      'stroke-dasharray': '5 7',
    }));
  } else {
    root.appendChild(svg('circle', {
      class: 'ring-value', cx: center, cy: center, r: RING_RADIUS,
      'stroke-dasharray': geometry.dashArray,
      'stroke-dashoffset': geometry.dashOffset,
      transform: `rotate(-90 ${center} ${center})`,
    }));
  }
  return root;
}

/**
 * Paint the usage section. Pure-function in, DOM out; safe to call on every
 * capacity event because it rebuilds only this subtree.
 *
 * @param {HTMLElement} root
 * @param {object} report
 * @param {{onRecover?: () => void}} [handlers]
 * @returns {object} the view model that was rendered
 */
export function renderUsage(root, report, { onRecover } = {}) {
  const vm = usageViewModel(report);
  if (!root) return vm;
  root.replaceChildren();
  root.dataset.state = vm.state;

  const head = el('p', 'usage-headline', vm.headline);
  root.appendChild(head);

  if (vm.state === 'unavailable') {
    const figure = el('div', 'circle circle-unknown');
    const ring = ringSvg({ dashed: true, tone: 'grey' });
    const wrap = el('div', 'circle-ring');
    wrap.appendChild(ring);
    wrap.appendChild(el('span', 'circle-centre circle-centre-unknown', vm.placeholder.label));
    figure.appendChild(wrap);
    figure.appendChild(el('p', 'circle-label', vm.placeholder.detail));
    figure.setAttribute('role', 'img');
    figure.setAttribute('aria-label', `Subscription usage ${vm.placeholder.label}. ${vm.placeholder.detail}`);
    root.appendChild(figure);

    const details = el('details', 'usage-explain');
    const summary = el('summary', null, 'Why is this unavailable?');
    details.appendChild(summary);
    details.appendChild(el('p', null, vm.explanation));
    details.appendChild(el('p', 'usage-remedy', vm.recovery));
    root.appendChild(details);

    const button = el('button', 'action-button', vm.recoveryAction.label);
    button.type = 'button';
    button.addEventListener('click', () => onRecover?.());
    root.appendChild(button);
    return vm;
  }

  const grid = el('div', 'usage-grid');
  for (const circle of vm.circles) {
    const figure = el('div', `circle circle-${circle.tone}${circle.freshness === 'stale' ? ' circle-stale' : ''}`);
    figure.setAttribute('role', 'img');
    figure.setAttribute('aria-label', circle.ariaLabel);

    const wrap = el('div', 'circle-ring');
    wrap.appendChild(ringSvg({ dashed: false, geometry: circle.geometry, tone: circle.tone }));
    wrap.appendChild(el('span', 'circle-centre', circle.percentText));
    figure.appendChild(wrap);

    figure.appendChild(el('p', 'circle-label', circle.label));
    figure.appendChild(el('p', 'circle-detail', `${circle.usedText} · ${circle.remainingText}`));
    if (circle.resetLabel) figure.appendChild(el('p', 'circle-reset', circle.resetLabel));
    if (circle.note) figure.appendChild(el('p', 'circle-note', circle.note));
    grid.appendChild(figure);
  }
  root.appendChild(grid);
  root.appendChild(el('p', 'usage-freshness', vm.freshnessLine));

  if (vm.stale && vm.explanation) {
    const details = el('details', 'usage-explain');
    details.appendChild(el('summary', null, 'Why is this not live?'));
    details.appendChild(el('p', null, vm.explanation));
    if (vm.recovery) details.appendChild(el('p', 'usage-remedy', vm.recovery));
    root.appendChild(details);
  }
  if (vm.recoveryAction) {
    const button = el('button', 'action-button', vm.recoveryAction.label);
    button.type = 'button';
    button.addEventListener('click', () => onRecover?.());
    root.appendChild(button);
  }
  return vm;
}
