/**
 * Speech policy (acceptance requirement 3 — "speak plainly, briefly, once").
 *
 * Two separate decisions live here, deliberately kept apart:
 *
 *  - `renderSentence(event)` turns a bus event into the ONE short first-person
 *    sentence Jarvis would use for it. It is the single renderer: chat and
 *    speech both call it, so the spoken line is character-for-character the
 *    line on screen. It knows nothing about mute, quiet hours or batching.
 *  - `shouldSpeak(event, {settings, clock})` decides whether that sentence is
 *    allowed out loud right now, and how urgent it is.
 *
 * Neither function touches ambient time: quiet hours are resolved from the
 * injected clock (`clock.now()`, `clock.timezone()`).
 */

/** Events that are always worth saying out loud (subject to mute/quiet hours). */
export const SPEAK_ALWAYS = ['project.delivered', 'project.blocked', 'question.asked', 'feature.completed'];

/** Minor progress: never spoken on its own, only as one batched summary. */
export const BATCHABLE = ['task.completed', 'task.started', 'project.phase'];

/** Spoken the moment they happen — these are the ones that interrupt. */
export const HIGH_PRIORITY = ['project.delivered', 'project.blocked', 'question.asked'];

/** The only two things allowed to break quiet hours. */
export const QUIET_HOURS_EXEMPT = ['project.blocked', 'question.asked'];

/** Everything else that earns an immediate (unbatched) utterance. */
const IMMEDIATE = [...SPEAK_ALWAYS, 'project.evaluated'];

const SPEAKABLE = new Set([...IMMEDIATE, ...BATCHABLE]);
const BATCHABLE_SET = new Set(BATCHABLE);
const HIGH_SET = new Set(HIGH_PRIORITY);
const EXEMPT_SET = new Set(QUIET_HOURS_EXEMPT);

const MAX_SENTENCE = 120;
const MAX_QUESTION = 180;

// ---------------------------------------------------------------- policy

/**
 * @param {{type:string, payload?:object}} event
 * @param {{settings?:object, clock:object}} deps
 * @returns {{speak:boolean, reason:string, priority:'high'|'normal'}}
 */
export function shouldSpeak(event, { settings = {}, clock } = {}) {
  const type = typeOf(event);
  const priority = priorityFor(type);

  if (!type) return { speak: false, reason: 'unknown_event', priority };
  // Mute wins over everything, including blockers and questions.
  if (settings.muted) return { speak: false, reason: 'muted', priority };
  if (settings.voiceEnabled === false) return { speak: false, reason: 'voice_disabled', priority };
  if (!SPEAKABLE.has(type)) return { speak: false, reason: 'not_notable', priority };

  if (inQuietHours(clock, settings) && !EXEMPT_SET.has(type)) {
    return { speak: false, reason: 'quiet_hours', priority };
  }

  if (BATCHABLE_SET.has(type)) return { speak: true, reason: 'batched', priority };
  return { speak: true, reason: SPEAK_ALWAYS.includes(type) ? 'always' : 'notable', priority };
}

/** True when `eventType` is minor progress that must be collapsed into a summary. */
export function batchable(eventType) {
  return BATCHABLE_SET.has(typeof eventType === 'string' ? eventType : typeOf(eventType));
}

export function priorityFor(eventType) {
  const type = typeof eventType === 'string' ? eventType : typeOf(eventType);
  return HIGH_SET.has(type) ? 'high' : 'normal';
}

/**
 * Is `clock.now()` inside the configured quiet window?
 * Handles windows that cross midnight (22:00 -> 07:00). `start` is inclusive,
 * `end` exclusive, both read in `settings.quietHours.timezone` when given and
 * `clock.timezone()` otherwise.
 */
export function inQuietHours(clock, settings = {}) {
  const quiet = settings?.quietHours;
  if (!quiet || quiet.enabled === false) return false;

  const start = parseHhMm(quiet.start);
  const end = parseHhMm(quiet.end);
  if (start === null || end === null) return false;
  if (start === end) return false; // zero-width window is "no quiet hours"

  const zone = quiet.timezone || clock?.timezone?.() || 'UTC';
  const minutes = minutesOfDay(clock?.now?.() ?? 0, zone);
  if (minutes === null) return false;

  return start < end
    ? minutes >= start && minutes < end          // 09:00 -> 17:00
    : minutes >= start || minutes < end;         // 22:00 -> 07:00, crosses midnight
}

/** '22:00' -> 1320. Returns null for anything unparseable. */
export function parseHhMm(value) {
  const m = /^\s*(\d{1,2}):(\d{2})\s*$/.exec(String(value ?? ''));
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (!Number.isInteger(h) || !Number.isInteger(min)) return null;
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return h * 60 + min;
}

const formatters = new Map();

function formatterFor(zone) {
  if (formatters.has(zone)) return formatters.get(zone);
  let fmt;
  try {
    fmt = new Intl.DateTimeFormat('en-US', { timeZone: zone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  } catch {
    fmt = null;
  }
  formatters.set(zone, fmt);
  return fmt;
}

/** Wall-clock minutes past local midnight for an epoch ms in `zone`. */
function minutesOfDay(epochMs, zone) {
  if (!Number.isFinite(epochMs)) return null;
  const fmt = formatterFor(zone) ?? formatterFor('UTC');
  if (!fmt) return null;
  let hour = null;
  let minute = null;
  for (const part of fmt.formatToParts(new Date(epochMs))) {
    if (part.type === 'hour') hour = Number(part.value);
    if (part.type === 'minute') minute = Number(part.value);
  }
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
  return (hour % 24) * 60 + minute;
}

// ---------------------------------------------------------------- renderer

const PAST_TENSE = {
  build: 'built', rebuild: 'rebuilt', update: 'updated', verify: 'verified', review: 'reviewed',
  deliver: 'delivered', evaluate: 'evaluated', repair: 'repaired', fix: 'fixed', add: 'added',
  write: 'wrote', create: 'created', implement: 'implemented', check: 'checked', test: 'tested',
  design: 'designed', wire: 'wired', ship: 'shipped', plan: 'planned', refactor: 'refactored',
};

const GERUND = {
  build: 'building', rebuild: 'rebuilding', update: 'updating', verify: 'verifying', review: 'reviewing',
  deliver: 'delivering', evaluate: 'evaluating', repair: 'repairing', fix: 'fixing', add: 'adding',
  write: 'writing', create: 'creating', implement: 'implementing', check: 'checking', test: 'testing',
  design: 'designing', wire: 'wiring', ship: 'shipping', plan: 'planning', refactor: 'refactoring',
};

const PHASE_LABEL = {
  planning: 'planning', implementing: 'building', verifying: 'verifying',
  reviewing: 'reviewing', repairing: 'repairing', delivering: 'delivering',
};

/**
 * The single event -> sentence renderer. Chat and speech both go through it,
 * so what Jarvis says is exactly what Jarvis shows.
 *
 * @param {{type:string, payload?:object}} event  bus envelope (or a bare payload with `type`)
 * @param {{projectTitle?:string|null}} [ctx]     project title for events that only carry an id
 * @returns {string|null} one short first-person sentence, or null when the event has nothing to say
 */
export function renderSentence(event, { projectTitle = null } = {}) {
  const type = typeOf(event);
  if (!type) return null;
  const p = payloadOf(event);
  const title = p.project?.title ?? projectTitle ?? p.projectTitle ?? null;
  const name = nameOf(title);

  switch (type) {
    case 'project.created':
      return oneSentence(`I am starting on ${name}.`);
    case 'project.delivered':
      return oneSentence(`I delivered ${name}.`);
    case 'project.evaluated':
      return oneSentence(`I finished evaluating ${name}.`);
    case 'project.blocked':
      return oneSentence(p.reason ?? p.project?.blockedReason ?? `I am blocked on ${name}.`);
    case 'project.paused':
      return oneSentence(`I paused ${name}.`);
    case 'project.resumed':
      return oneSentence(`I am back on ${name}.`);
    case 'project.stopped':
      return oneSentence(`I stopped ${name}.`);
    case 'project.phase': {
      const label = PHASE_LABEL[p.phase];
      if (!label) return null;
      return oneSentence(`I am ${label} ${name}.`);
    }
    case 'question.asked': {
      const text = String(p.text ?? p.question?.text ?? '').trim();
      if (!text) return null;
      return oneSentence(`I need to know: ${text}${/[.?!]$/.test(text) ? '' : '?'}`, MAX_QUESTION);
    }
    case 'question.answered':
      return oneSentence(`Thanks, I am carrying on with ${name}.`);
    case 'task.started':
      return oneSentence(startedSentence(taskTitleOf(p)));
    case 'task.completed':
    case 'feature.completed':
      return oneSentence(finishedSentence(taskTitleOf(p)));
    case 'task.failed':
      return oneSentence(`I hit a problem on ${taskTitleOf(p)} and I am fixing it.`);
    default:
      return null;
  }
}

/** "Build the login form" -> "I built the login form." */
export function finishedSentence(taskTitle) {
  const { verb, rest } = splitVerb(taskTitle);
  const past = verb ? PAST_TENSE[verb] : null;
  if (past && rest) return `I ${past} ${rest}.`;
  return `I finished ${taskTitle}.`;
}

/** "Build the login form" -> "I am building the login form." */
export function startedSentence(taskTitle) {
  const { verb, rest } = splitVerb(taskTitle);
  const gerund = verb ? GERUND[verb] : null;
  if (gerund && rest) return `I am ${gerund} ${rest}.`;
  return `I am working on ${taskTitle}.`;
}

function splitVerb(taskTitle) {
  const clean = String(taskTitle ?? '').trim();
  const m = /^([A-Za-z]+)\s+(.*\S)\s*$/.exec(clean);
  if (!m) return { verb: null, rest: null };
  return { verb: m[1].toLowerCase(), rest: m[2] };
}

function taskTitleOf(p) {
  return String(p.title ?? p.task?.title ?? 'that step').trim() || 'that step';
}

function nameOf(title, fallback = 'your project') {
  const t = String(title ?? '').replace(/\s+/g, ' ').trim();
  return t || fallback;
}

/**
 * Reduce any text to one clean spoken sentence: no markdown, no emoji, no
 * newlines, first sentence only, hard length cap.
 */
export function oneSentence(text, max = MAX_SENTENCE) {
  const clean = sanitize(text);
  if (!clean) return '';
  const first = clean.split(/(?<=[.!?])\s/)[0] ?? clean;
  if (first.length <= max) return first;
  return `${first.slice(0, max - 1)}…`;
}

function sanitize(text) {
  return String(text ?? '')
    .replace(/[\p{Extended_Pictographic}️]/gu, '')
    .replace(/[`*#]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function typeOf(event) {
  if (!event) return null;
  const t = typeof event === 'string' ? event : event.type;
  return typeof t === 'string' && t ? t : null;
}

function payloadOf(event) {
  if (!event || typeof event !== 'object') return {};
  return (event.payload && typeof event.payload === 'object') ? event.payload : event;
}

export { typeOf as eventTypeOf, payloadOf as eventPayloadOf };
