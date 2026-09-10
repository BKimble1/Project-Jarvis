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

const TRANSIENT_CODES = new Set([
  'ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'ECONNREFUSED', 'EPIPE', 'ENETUNREACH', 'ENETRESET',
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT',
]);
const TRANSIENT_STATUS = new Set([502, 503, 504]);
const TRANSIENT_TEXT = ['timeout', 'timed out', 'socket hang up', 'econnreset', 'etimedout', 'eai_again'];

const CAPACITY_STATUS = new Set([429, 529]);
const CAPACITY_TEXT = ['rate limit', 'rate-limit', 'ratelimit', 'capacity', 'overloaded', 'too many requests', 'quota'];

const PERMISSION_STATUS = new Set([401, 403]);
const PERMISSION_TEXT = ['unauthorized', 'forbidden', 'permission'];

const CREDENTIAL_TEXT = ['credential', 'not authenticated', 'api key', 'api-key', 'token expired', 'expired token', 'setup-token'];

function statusOf(err) {
  const raw = err?.status ?? err?.statusCode ?? err?.response?.status ?? err?.res?.statusCode;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function textOf(err) {
  const parts = [err?.message, err?.error?.message, err?.reason, typeof err === 'string' ? err : ''];
  return parts.filter(Boolean).map(String).join(' ').toLowerCase();
}

function includesAny(haystack, needles) {
  return needles.some((n) => haystack.includes(n));
}

/**
 * Classify a thrown value so callers know whether to retry, block on a
 * credential, or give up.
 * @returns {'transient'|'capacity'|'permission'|'credential'|'fatal'}
 */
export function classifyError(err, depth = 0) {
  if (err === null || err === undefined) return 'fatal';

  const code = String(err.code ?? err.errno ?? '').toUpperCase();
  const status = statusOf(err);
  const text = textOf(err);

  if (TRANSIENT_CODES.has(code)) return 'transient';
  if (status !== null && TRANSIENT_STATUS.has(status)) return 'transient';
  if (includesAny(text, TRANSIENT_TEXT)) return 'transient';

  if (status !== null && CAPACITY_STATUS.has(status)) return 'capacity';
  if (includesAny(text, CAPACITY_TEXT)) return 'capacity';

  if (status !== null && PERMISSION_STATUS.has(status)) return 'permission';
  if (includesAny(text, PERMISSION_TEXT)) return 'permission';

  if (includesAny(text, CREDENTIAL_TEXT)) return 'credential';

  // Wrapped errors (fetch/undici style) carry the real cause underneath.
  if (depth < 3 && err.cause !== undefined && err.cause !== null) {
    const inner = classifyError(err.cause, depth + 1);
    if (inner !== 'fatal') return inner;
  }
  return 'fatal';
}

/** Default retry predicate: transient and capacity failures only. */
export function defaultIsRetryable(err, classification = classifyError(err)) {
  return classification === 'transient' || classification === 'capacity';
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
