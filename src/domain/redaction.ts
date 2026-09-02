/**
 * Secret redaction.
 *
 * Every string that comes back from a worker — event summaries, tool arguments, verification
 * output, artifact bodies — passes through here before it is stored. The worker redacts on the
 * way out and the control plane redacts again on the way in, because one of them will eventually
 * be the version with the bug.
 *
 * This is defence in depth, not a licence to be careless: the real protection is that credentials
 * are never given to the agent in the first place.
 */

export const REDACTED = '[redacted]';

interface Pattern {
  readonly id: string;
  readonly regex: RegExp;
  /** Replacement, `$1` etc. available for keeping the key while dropping the value. */
  readonly replace: string;
}

/*
 * Ordered most specific first. Every regex is created fresh per call (see `redactSecrets`) so a
 * `g` flag's `lastIndex` can never leak between invocations.
 */
const PATTERNS: readonly Pattern[] = [
  /* GitHub tokens: classic, fine-grained, OAuth, app and refresh. */
  { id: 'github_token', regex: /\bgh[pousr]_[A-Za-z0-9]{16,255}\b/g, replace: REDACTED },
  { id: 'github_pat', regex: /\bgithub_pat_[A-Za-z0-9_]{20,255}\b/g, replace: REDACTED },
  /* Anthropic keys. */
  { id: 'anthropic_key', regex: /\bsk-ant-[A-Za-z0-9_-]{16,}\b/g, replace: REDACTED },
  /* Jarvis's own worker enrolment secrets. */
  { id: 'jarvis_worker', regex: /\bjarvisw_[A-Za-z0-9._-]{16,}\b/g, replace: REDACTED },
  /* Generic bearer credentials in a header or a curl line. */
  {
    id: 'bearer',
    regex: /\b(authorization\s*[:=]\s*)(bearer\s+)?[A-Za-z0-9._~+/=-]{12,}/gi,
    replace: `$1${REDACTED}`,
  },
  {
    id: 'bearer_bare',
    regex: /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/g,
    replace: `Bearer ${REDACTED}`,
  },
  /* KEY=value / "key": "value" assignments for anything that sounds like a credential. */
  {
    id: 'assignment',
    regex:
      /\b([A-Za-z0-9_.-]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API[_-]?KEY|ACCESS[_-]?KEY|PRIVATE[_-]?KEY|CREDENTIAL)[A-Za-z0-9_.-]*)(\s*[:=]\s*)("?)[^\s"',;]{4,}\3/gi,
    replace: `$1$2$3${REDACTED}$3`,
  },
  /* A URL with inline credentials — how a token most often reaches a git remote. */
  {
    id: 'url_credentials',
    regex: /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+:[^\s/@]+@/gi,
    replace: `$1${REDACTED}@`,
  },
  /* PEM blocks. */
  {
    id: 'private_key_block',
    regex: /-----BEGIN[A-Z ]*PRIVATE KEY-----[\s\S]*?-----END[A-Z ]*PRIVATE KEY-----/g,
    replace: REDACTED,
  },
  /* AWS access key ids, which occasionally end up in CI output. */
  { id: 'aws_key_id', regex: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, replace: REDACTED },
];

/** Redact a single string. Returns the input unchanged when nothing matched. */
export function redactSecrets(value: string): string {
  let result = value;
  for (const pattern of PATTERNS) {
    result = result.replace(new RegExp(pattern.regex.source, pattern.regex.flags), pattern.replace);
  }
  return result;
}

/** True when the text still contains something that looks like a credential. */
export function containsSecret(value: string): boolean {
  return redactSecrets(value) !== value;
}

/**
 * Redact recursively through a JSON-shaped value.
 *
 * Also bounds the structure: deeply nested or very large details from a worker are truncated
 * rather than stored, so an event row can never become a denial-of-service vector.
 */
export function redactDeep(value: unknown, depth = 0): unknown {
  if (depth > 8) return '[truncated]';
  if (typeof value === 'string') return redactSecrets(value.slice(0, 8000));
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value;
  if (Array.isArray(value)) {
    return value.slice(0, 200).map((item) => redactDeep(item, depth + 1));
  }
  if (typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>).slice(0, 100)) {
      /* A key whose *name* says "secret" has its value dropped whatever the value looks like. */
      if (/(secret|token|password|api[_-]?key|credential|private[_-]?key)/i.test(key)) {
        result[key] = REDACTED;
        continue;
      }
      result[key] = redactDeep(item, depth + 1);
    }
    return result;
  }
  return undefined;
}

/** Truncate to a byte budget on a character boundary, marking that it happened. */
export function boundText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - 15))}\n… [truncated]`;
}
