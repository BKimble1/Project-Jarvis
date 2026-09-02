/**
 * Structured logging with mandatory secret redaction.
 *
 * Every log line is JSON on one line. Values are walked before serialisation and anything that
 * looks like a credential — by key name or by shape — is replaced with `[redacted]`. This is a
 * belt-and-braces measure: the code is also written not to pass secrets in, but a single careless
 * `logger.error('sync failed', { error })` must never leak a token from a request header.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_WEIGHT: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const SENSITIVE_KEY_PATTERN =
  /(token|secret|password|passwd|authorization|auth|apikey|api_key|client_secret|cookie|session|credential|private_key|bearer|signature)/i;

/** Values that look like credentials even when the key is innocuous. */
const SENSITIVE_VALUE_PATTERNS: readonly RegExp[] = [
  /\bgh[pousr]_[A-Za-z0-9]{16,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bsk-ant-[A-Za-z0-9_-]{10,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/-]{10,}=*/gi,
  /\bpostgres(?:ql)?:\/\/[^\s"']+/gi,
];

export const REDACTED = '[redacted]';

export function redactString(value: string): string {
  let output = value;
  for (const pattern of SENSITIVE_VALUE_PATTERNS) {
    output = output.replace(pattern, REDACTED);
  }
  return output;
}

export function redact(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (depth > 6) return '[truncated]';
  if (value === null || value === undefined) return value ?? null;
  if (typeof value === 'string') return redactString(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'function') return '[function]';
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactString(value.message),
      ...(typeof (value as unknown as { code?: unknown }).code === 'string'
        ? { code: String((value as unknown as { code: unknown }).code) }
        : {}),
    };
  }
  if (Array.isArray(value)) {
    return value.slice(0, 50).map((item) => redact(item, depth + 1, seen));
  }
  if (typeof value === 'object') {
    const object = value as Record<string, unknown>;
    if (seen.has(object)) return '[circular]';
    seen.add(object);
    const output: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(object)) {
      output[key] = SENSITIVE_KEY_PATTERN.test(key) ? REDACTED : redact(entry, depth + 1, seen);
    }
    return output;
  }
  return String(value);
}

export interface Logger {
  debug(message: string, context?: Record<string, unknown>): void;
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
  child(bindings: Record<string, unknown>): Logger;
}

export interface LoggerOptions {
  readonly level?: LogLevel;
  readonly bindings?: Record<string, unknown>;
  readonly sink?: (line: string) => void;
  readonly clock?: () => Date;
}

function defaultSink(line: string): void {
  // eslint-disable-next-line no-console
  console.error(line);
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const level = options.level ?? 'info';
  const bindings = options.bindings ?? {};
  const sink = options.sink ?? defaultSink;
  const clock = options.clock ?? (() => new Date());

  const emit = (entryLevel: LogLevel, message: string, context?: Record<string, unknown>) => {
    if (LEVEL_WEIGHT[entryLevel] < LEVEL_WEIGHT[level]) return;
    const payload = {
      ts: clock().toISOString(),
      level: entryLevel,
      msg: redactString(message),
      ...(redact(bindings) as Record<string, unknown>),
      ...(context ? (redact(context) as Record<string, unknown>) : {}),
    };
    try {
      sink(JSON.stringify(payload));
    } catch {
      sink(JSON.stringify({ ts: payload.ts, level: entryLevel, msg: payload.msg }));
    }
  };

  return {
    debug: (message, context) => emit('debug', message, context),
    info: (message, context) => emit('info', message, context),
    warn: (message, context) => emit('warn', message, context),
    error: (message, context) => emit('error', message, context),
    child: (extra) =>
      createLogger({
        ...options,
        level,
        bindings: { ...bindings, ...extra },
        ...(options.sink ? { sink: options.sink } : {}),
      }),
  };
}

let rootLogger: Logger | null = null;

export function logger(): Logger {
  if (!rootLogger) {
    const level = (process.env.LOG_LEVEL as LogLevel | undefined) ?? 'info';
    rootLogger = createLogger({ level: LEVEL_WEIGHT[level] ? level : 'info' });
  }
  return rootLogger;
}

export function setRootLogger(next: Logger | null): void {
  rootLogger = next;
}
