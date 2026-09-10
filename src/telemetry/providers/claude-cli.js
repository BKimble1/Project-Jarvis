/**
 * Real Claude subscription telemetry (acceptance req. 5).
 *
 * This provider performs a genuine authenticated HTTP GET against
 * `GET {baseUrl}/api/oauth/usage` using the OAuth token that `claude setup-token`
 * (or the Claude Code CLI login) leaves on the machine. It deliberately refuses to
 * fall back to `ANTHROPIC_API_KEY`: doing so would silently move the user from
 * their subscription onto metered, paid API billing.
 *
 * Nothing in this module ever returns, logs or throws the token itself.
 */
import nodeFs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createLogger } from '../../core/logger.js';

const USAGE_PATH = '/api/oauth/usage';
const OAUTH_BETA = 'oauth-2025-04-20';
const KEYCHAIN_SERVICE = 'Claude Code-credentials';
const REDACTED = '[redacted]';

const SETUP_HINT =
  'Run `claude setup-token` (or `claude login`) to create a subscription OAuth token, ' +
  'or export CLAUDE_CODE_OAUTH_TOKEN.';
const API_KEY_HINT =
  'ANTHROPIC_API_KEY is present but is deliberately NOT used for subscription usage: ' +
  'an API key bills metered API credits instead of reading your subscription limits.';

/** Default shell-out used for the macOS keychain lookup. Injected in tests. */
function defaultExec(file, args) {
  return execFileSync(file, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
}

function execToText(exec, file, args) {
  const out = exec(file, args);
  if (typeof out === 'string') return out;
  if (out && typeof out === 'object') {
    if (typeof out.stdout === 'string') return out.stdout;
    if (typeof out.toString === 'function') return out.toString('utf8');
  }
  return '';
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

/**
 * Pull an OAuth access token out of a credentials blob.
 * Accepts `{ claudeAiOauth: { accessToken } }` and a top-level `{ accessToken }`.
 * `allowRaw` permits a bare secret (the macOS keychain can hand back a naked token).
 */
function tokenFromCredentialsText(text, { allowRaw = false } = {}) {
  const trimmed = nonEmptyString(text);
  if (!trimmed) return null;
  let parsed = null;
  try { parsed = JSON.parse(trimmed); } catch { parsed = null; }
  if (parsed && typeof parsed === 'object') {
    const oauth = parsed.claudeAiOauth ?? parsed.claude_ai_oauth ?? null;
    const candidates = [
      oauth && typeof oauth === 'object' ? oauth.accessToken : null,
      oauth && typeof oauth === 'object' ? oauth.access_token : null,
      parsed.accessToken,
      parsed.access_token,
    ];
    for (const candidate of candidates) {
      const token = nonEmptyString(candidate);
      if (token) return token;
    }
    return null;
  }
  return allowRaw ? trimmed : null;
}

/**
 * Resolve a subscription OAuth token.
 *
 * Order: CLAUDE_CODE_OAUTH_TOKEN -> <home>/.claude/.credentials.json -> macOS keychain.
 * Every external dependency is injectable so tests never touch the real machine.
 *
 * @returns {{token: string, source: 'env'|'credentials-file'|'keychain'}|null}
 */
export function resolveOAuthToken({
  env = process.env,
  fs = nodeFs,
  home = os.homedir(),
  exec = defaultExec,
  platform = process.platform,
} = {}) {
  const fromEnv = nonEmptyString(env?.CLAUDE_CODE_OAUTH_TOKEN);
  if (fromEnv) return { token: fromEnv, source: 'env' };

  if (fs && typeof fs.readFileSync === 'function' && nonEmptyString(home)) {
    const file = path.join(home, '.claude', '.credentials.json');
    let raw = null;
    try { raw = fs.readFileSync(file, 'utf8'); } catch { raw = null; }
    const token = tokenFromCredentialsText(raw, { allowRaw: false });
    if (token) return { token, source: 'credentials-file' };
  }

  if (platform === 'darwin' && typeof exec === 'function') {
    let out = null;
    try {
      out = execToText(exec, 'security', ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-w']);
    } catch { out = null; }
    const token = tokenFromCredentialsText(out, { allowRaw: true });
    if (token) return { token, source: 'keychain' };
  }

  return null;
}

const WINDOW_LABELS = new Map([
  ['five_hour', '5-hour'],
  ['seven_day', '7-day'],
  ['seven_day_opus', '7-day (Opus)'],
  ['seven_day_oauth_apps', '7-day (apps)'],
]);

/** 'five_hour' -> '5-hour'; unknown keys become title-cased words. */
export function humanizeWindowKey(key) {
  const raw = typeof key === 'string' ? key.trim() : '';
  if (!raw) return 'Unknown';
  const known = WINDOW_LABELS.get(raw);
  if (known) return known;
  const words = raw
    .replace(/[-\s]+/g, '_')
    .split('_')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1));
  return words.length ? words.join(' ') : 'Unknown';
}

/** Strict numeric parse: no coercion of null/''/booleans/objects to 0. */
function finiteNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(trimmed)) return null;
    const n = Number(trimmed);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * Utilization fields, in precedence order, each with its scale.
 *
 * `utilization` is scale-ambiguous — the endpoint sends either 0..1 or 0..100 —
 * so it gets the contract's ">1 means it is already a percentage" heuristic.
 * Fields that name a percentage are NEVER rescaled: `used_percent: 0.5` is half
 * of one percent, not fifty. Running those through the fraction heuristic was a
 * silent 100x error that would have made the scheduler throttle a nearly idle
 * account (or, worse, read 0.9% as 90%).
 */
const UTILIZATION_FIELDS = [
  ['utilization', 'ambiguous'],
  ['utilization_percent', 'percent'],
  ['utilizationPercent', 'percent'],
  ['used_percent', 'percent'],
  ['usedPercent', 'percent'],
];
const UTILIZATION_FIELD_NAMES = UTILIZATION_FIELDS.map(([name]) => name);
const RESET_FIELDS = ['resets_at', 'resetsAt', 'reset_at', 'resetAt', 'resets'];

/** @returns {number|null} used percentage in 0..100, or null when the value is unusable. */
function usedPercentFrom(entry) {
  for (const [field, scale] of UTILIZATION_FIELDS) {
    if (!(field in entry)) continue;
    const n = finiteNumber(entry[field]);
    if (n === null) return null;      // present but unusable -> drop the window
    if (n < 0) return null;           // negative is aberrant -> drop, never clamp to 0
    // 0..1 fraction vs 0..100 percentage: anything above 1 is already a percentage.
    const pct = scale === 'percent' ? n : (n > 1 ? n : n * 100);
    return pct > 100 ? 100 : pct;
  }
  return null;
}

/** @returns {number|null} epoch ms */
function resetsAtFrom(entry) {
  for (const field of RESET_FIELDS) {
    if (!(field in entry)) continue;
    const value = entry[field];
    if (value === null || value === undefined) return null;
    const n = finiteNumber(value);
    if (n !== null) {
      if (n >= 1e12) return Math.round(n);        // already ms
      if (n >= 1e9) return Math.round(n * 1000);  // seconds
      return null;
    }
    if (typeof value === 'string') {
      const parsed = Date.parse(value.trim());
      return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
  }
  return null;
}

function round(value, places) {
  const f = 10 ** places;
  return Math.round(value * f) / f;
}

function collectEntries(payload) {
  const out = [];
  if (!payload || typeof payload !== 'object') return out;

  const listy = Array.isArray(payload)
    ? payload
    : Array.isArray(payload.windows) ? payload.windows
      : Array.isArray(payload.limits) ? payload.limits
        : null;

  if (listy) {
    for (const item of listy) {
      if (!item || typeof item !== 'object') continue;
      const key = nonEmptyString(item.key) ?? nonEmptyString(item.name) ?? nonEmptyString(item.window);
      if (!key) continue;
      out.push([key, item]);
    }
    return out;
  }

  const container = payload.usage && typeof payload.usage === 'object' && !Array.isArray(payload.usage)
    ? payload.usage
    : payload;
  for (const [key, value] of Object.entries(container)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    if (!UTILIZATION_FIELD_NAMES.some((f) => f in value)) continue;
    out.push([key, value]);
  }
  return out;
}

/**
 * Turn either payload shape into CapacityWindow[].
 * Windows whose utilization is missing, null, NaN, negative or otherwise not a
 * finite number are DROPPED — never coerced to 0, because "unknown" must never
 * render as "0% used". Repeated keys collapse (last entry wins), so a payload
 * that lists the same limit twice can never produce two circles for it.
 */
export function normalizeUsagePayload(payload, { clock, measuredAt, source = 'claude-subscription' } = {}) {
  const at = Number.isFinite(measuredAt) ? measuredAt : (clock ? clock.now() : null);
  const windows = new Map();
  for (const [key, entry] of collectEntries(payload)) {
    const usedPercent = usedPercentFrom(entry);
    if (usedPercent === null) continue;
    windows.set(key, {
      key,
      label: humanizeWindowKey(key),
      utilization: round(usedPercent / 100, 4),
      usedPercent: round(usedPercent, 2),
      remainingPercent: round(100 - usedPercent, 2),
      resetsAt: resetsAtFrom(entry),
      unit: 'percent',
      source,
      measuredAt: at,
    });
  }
  return [...windows.values()];
}

/** Remove a secret from any human-facing text, defensively. */
function scrub(text, token) {
  const str = typeof text === 'string' ? text : String(text ?? '');
  if (!token) return str;
  return str.split(token).join(REDACTED);
}

export class ClaudeSubscriptionProvider {
  constructor({
    clock,
    fetchImpl = globalThis.fetch,
    env = process.env,
    baseUrl = (env && env.ANTHROPIC_BASE_URL) || 'https://api.anthropic.com',
    tokenResolver = resolveOAuthToken,
    tokenOptions = {},
    logger = createLogger('telemetry:claude-cli'),
  } = {}) {
    if (!clock) throw new Error('ClaudeSubscriptionProvider requires a clock');
    this.name = 'claude-subscription';
    this.clock = clock;
    this.fetchImpl = fetchImpl;
    this.baseUrl = String(baseUrl).replace(/\/+$/, '');
    this.tokenResolver = tokenResolver;
    this.tokenOptions = { env, ...tokenOptions };
    this.env = this.tokenOptions.env ?? env;
    this.logger = logger;
  }

  get url() { return `${this.baseUrl}${USAGE_PATH}`; }

  _fail(reason, message, remedy, token) {
    return {
      ok: false,
      source: this.name,
      measuredAt: this.clock.now(),
      reason,
      message: scrub(message, token),
      remedy: scrub(remedy, token),
    };
  }

  /**
   * Never throws. Always resolves to a Measurement.
   * @returns {Promise<object>}
   */
  async measure() {
    let resolved = null;
    try {
      resolved = await this.tokenResolver(this.tokenOptions);
    } catch (err) {
      this.logger.debug('token resolution failed', { message: err?.message });
      resolved = null;
    }

    const token = nonEmptyString(resolved?.token);
    if (!token) {
      const hasApiKey = Boolean(nonEmptyString(this.env?.ANTHROPIC_API_KEY));
      const message = hasApiKey
        ? 'No Claude subscription OAuth token found; only ANTHROPIC_API_KEY is present.'
        : 'No Claude subscription OAuth token found.';
      const remedy = hasApiKey ? `${SETUP_HINT} ${API_KEY_HINT}` : SETUP_HINT;
      return this._fail('not_authenticated', message, remedy, null);
    }
    this.logger.debug('resolved subscription token', { source: resolved.source });

    if (typeof this.fetchImpl !== 'function') {
      return this._fail('unsupported', 'No fetch implementation is available.',
        'Run Jarvis on Node 22+, which provides global fetch.', token);
    }

    let res;
    try {
      res = await this.fetchImpl(this.url, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          'anthropic-beta': OAUTH_BETA,
          accept: 'application/json',
        },
      });
    } catch (err) {
      return this._fail('network', `Could not reach ${this.url}: ${err?.message ?? err}`,
        'Check network connectivity and ANTHROPIC_BASE_URL, then retry.', token);
    }

    if (!res || typeof res !== 'object') {
      return this._fail('network', `No response from ${this.url}.`,
        'Check network connectivity and ANTHROPIC_BASE_URL, then retry.', token);
    }

    const status = Number.isFinite(res.status) ? res.status : 0;
    const ok = typeof res.ok === 'boolean' ? res.ok : (status >= 200 && status < 300);

    if (!ok) {
      if (status === 401 || status === 403) {
        return this._fail('unauthorized',
          `Claude usage endpoint rejected the subscription token (HTTP ${status}).`,
          `The stored OAuth token is expired or revoked. ${SETUP_HINT}`, token);
      }
      if (status === 404 || status === 501) {
        return this._fail('unsupported',
          `Claude usage endpoint is not available at ${this.url} (HTTP ${status}).`,
          'This account or base URL does not expose subscription usage; upgrade the Claude CLI or unset ANTHROPIC_BASE_URL.',
          token);
      }
      return this._fail('network', `Claude usage endpoint returned HTTP ${status}.`,
        'Transient upstream failure — retry shortly.', token);
    }

    let payload;
    try {
      if (typeof res.json === 'function') payload = await res.json();
      else if (typeof res.text === 'function') payload = JSON.parse(await res.text());
      else payload = res.body;
    } catch (err) {
      return this._fail('malformed', `Could not parse the usage response: ${err?.message ?? err}`,
        'Upgrade the Claude CLI / retry; the usage endpoint returned non-JSON.', token);
    }

    const measuredAt = this.clock.now();
    const windows = normalizeUsagePayload(payload, { clock: this.clock, measuredAt, source: this.name });
    if (windows.length === 0) {
      return this._fail('malformed', 'The usage response contained no readable capacity windows.',
        'Upgrade the Claude CLI; the usage payload shape was not recognised.', token);
    }

    return { ok: true, source: this.name, measuredAt, windows };
  }
}
