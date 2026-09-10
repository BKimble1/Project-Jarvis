/**
 * Error classification + bounded retry with injected-clock backoff.
 *
 * Nothing here touches wall-clock time: every wait goes through `clock.sleep`
 * so a FakeClock test can assert the exact delay sequence.
 */

/** Every class `classifyError` can return. */
export const ERROR_CLASSES = Object.freeze(['transient', 'capacity', 'permission', 'credential', 'fatal']);

/** Only these classes are worth trying again. */
export const RETRYABLE_CLASSES = Object.freeze(['transient', 'capacity']);

const RETRYABLE = new Set(RETRYABLE_CLASSES);

/** How many `err.cause` links to follow before giving up (also breaks cycles). */
const MAX_CAUSE_DEPTH = 3;

/**
 * `err.code` / `err.errno` values that name their class outright. In-repo
 * producers tag errors this way on purpose (see `src/workers/claude-executor.js`)
 * so the class survives any rewording of the human-readable message.
 */
const CODE_CLASS = new Map([
  ['ECONNRESET', 'transient'], ['ETIMEDOUT', 'transient'], ['EAI_AGAIN', 'transient'],
  ['ECONNREFUSED', 'transient'], ['EPIPE', 'transient'], ['ENETUNREACH', 'transient'],
  ['ENETRESET', 'transient'], ['ECONNABORTED', 'transient'], ['EHOSTUNREACH', 'transient'],
  ['UND_ERR_CONNECT_TIMEOUT', 'transient'], ['UND_ERR_SOCKET', 'transient'],
  ['UND_ERR_HEADERS_TIMEOUT', 'transient'], ['UND_ERR_BODY_TIMEOUT', 'transient'],
  ['ECREDENTIAL', 'credential'],
  ['EFATAL', 'fatal'],
]);

/** HTTP statuses that name their class outright. */
const STATUS_CLASS = new Map([
  [502, 'transient'], [503, 'transient'], [504, 'transient'],
  [429, 'capacity'], [529, 'capacity'],
  [401, 'permission'], [403, 'permission'],
]);

/**
 * Message substrings, in the contract's class order. These are a fallback only:
 * a keyword that happens to appear in prose must never override a structured
 * signal (see `classifyOne`).
 */
const TEXT_CLASSES = Object.freeze([
  ['transient', ['timeout', 'timed out', 'socket hang up', 'econnreset', 'etimedout', 'eai_again']],
  ['capacity', ['rate limit', 'rate-limit', 'ratelimit', 'capacity', 'overloaded', 'too many requests', 'quota']],
  ['permission', ['unauthorized', 'forbidden', 'permission']],
  ['credential', ['credential', 'not authenticated', 'api key', 'api-key', 'token expired', 'expired token', 'setup-token']],
]);

function statusOf(err) {
  const raw = err?.status ?? err?.statusCode ?? err?.response?.status ?? err?.res?.statusCode;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function textOf(err) {
  const parts = [err?.message, err?.error?.message, err?.reason, typeof err === 'string' ? err : ''];
  return parts.filter(Boolean).map(String).join(' ').toLowerCase();
}

/**
 * Classify one error object without following `err.cause`.
 * @returns {string|null} null when this error carries no usable signal.
 */
function classifyOne(err) {
  // Structured signals win. An explicit code or HTTP status is what the
  // producer *meant*; a message is just prose that may mention anything. A 403
  // whose body happens to say "timed out" is still a permission failure, and
  // retrying it would burn the budget and skip the "I need permission" block.
  const code = String(err?.code ?? err?.errno ?? '').toUpperCase();
  if (CODE_CLASS.has(code)) return CODE_CLASS.get(code);

  const status = statusOf(err);
  if (status !== null && STATUS_CLASS.has(status)) return STATUS_CLASS.get(status);

  const text = textOf(err);
  if (text) {
    for (const [klass, needles] of TEXT_CLASSES) {
      if (needles.some((n) => text.includes(n))) return klass;
    }
  }
  return null;
}

function classifyDeep(err, depth) {
  if (err === null || err === undefined) return 'fatal';
  const direct = classifyOne(err);
  if (direct !== null) return direct;
  // Wrapped errors (fetch/undici style) carry the real cause underneath.
  if (depth < MAX_CAUSE_DEPTH && err.cause !== undefined && err.cause !== null) {
    return classifyDeep(err.cause, depth + 1);
  }
  return 'fatal';
}

/**
 * Classify a thrown value so callers know whether to retry, block on a
 * credential, or give up.
 *
 * Takes exactly one argument on purpose: the recursion depth is private, so
 * `errors.map(classifyError)` cannot smuggle an array index in as state.
 *
 * @returns {'transient'|'capacity'|'permission'|'credential'|'fatal'}
 */
export function classifyError(err) {
  return classifyDeep(err, 0);
}

/** Default retry predicate: transient and capacity failures only. */
export function defaultIsRetryable(err, classification = classifyError(err)) {
  return RETRYABLE.has(classification);
}

/**
 * Exponential backoff for a given (1-based) attempt number.
 * `jitter` is a maximum number of extra milliseconds, never a subtraction, so
 * `jitter: 0` (the default) yields an exactly reproducible sequence.
 */
export function delayFor(attempt, { baseDelayMs = 200, factor = 2, jitter = 0, maxDelayMs = Infinity, random = Math.random } = {}) {
  const n = Math.max(1, Math.floor(attempt));
  const raw = baseDelayMs * Math.pow(factor, n - 1);
  const extra = jitter > 0 ? random() * jitter : 0;
  const capped = Math.min(raw + extra, maxDelayMs);
  return Math.max(0, Math.round(capped));
}

/**
 * Run `fn`, retrying only retryable classes with exponential backoff.
 * Sleeps through the injected clock; rethrows the last error when the bounded
 * attempts are spent. Permission / credential / fatal errors are rethrown on
 * the first attempt without any sleep.
 *
 * @param {(attempt:number)=>Promise<any>} fn
 */
export async function withRetry(fn, {
  clock,
  attempts = 3,
  baseDelayMs = 200,
  factor = 2,
  jitter = 0,
  maxDelayMs = Infinity,
  onRetry,
  isRetryable = defaultIsRetryable,
  random = Math.random,
} = {}) {
  if (typeof fn !== 'function') throw new TypeError('withRetry: fn must be a function');
  if (!clock || typeof clock.sleep !== 'function') throw new TypeError('withRetry: a clock with sleep() is required');

  const maxAttempts = Math.max(1, Math.floor(Number(attempts) || 1));
  let attempt = 0;

  for (;;) {
    attempt += 1;
    try {
      return await fn(attempt);
    } catch (err) {
      const classification = classifyError(err);
      const retryable = Boolean(isRetryable(err, classification));
      if (!retryable || attempt >= maxAttempts) throw err;

      const delayMs = delayFor(attempt, { baseDelayMs, factor, jitter, maxDelayMs, random });
      if (typeof onRetry === 'function') {
        onRetry({ error: err, attempt, nextAttempt: attempt + 1, attempts: maxAttempts, delayMs, classification });
      }
      await clock.sleep(delayMs);
    }
  }
}

/**
 * Per-key bounded attempt budget. Keeps a runaway task from consuming the
 * whole loop: once a key is exhausted `consume` returns false forever (until
 * it is explicitly reset).
 */
export class RetryBudget {
  constructor({ maxAttempts = 3 } = {}) {
    this.maxAttempts = Math.max(0, Math.floor(Number(maxAttempts) || 0));
    this._used = new Map();
  }

  /** @returns {boolean} true when an attempt was granted. */
  consume(key) {
    const k = String(key);
    const used = this._used.get(k) ?? 0;
    if (used >= this.maxAttempts) return false;
    this._used.set(k, used + 1);
    return true;
  }

  attemptsFor(key) { return this._used.get(String(key)) ?? 0; }

  remaining(key) { return Math.max(0, this.maxAttempts - this.attemptsFor(key)); }

  exhausted(key) { return this.remaining(key) === 0; }

  /** Reset one key, or every key when called with no argument. */
  reset(key) {
    if (key === undefined) this._used.clear();
    else this._used.delete(String(key));
  }

  keys() { return [...this._used.keys()]; }
}
