/**
 * A single, consistent error taxonomy.
 *
 * Every layer throws `JarvisError` (or a subclass). Route handlers convert it into an HTTP
 * response through `toErrorResponse`, so no stack traces, provider payloads or secrets ever
 * reach the browser.
 */

export type JarvisErrorCode =
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'validation_failed'
  | 'rate_limited'
  | 'upstream_unavailable'
  | 'upstream_forbidden'
  | 'upstream_not_found'
  | 'timeout'
  | 'configuration_error'
  | 'locked'
  | 'internal';

const STATUS_BY_CODE: Record<JarvisErrorCode, number> = {
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  validation_failed: 422,
  rate_limited: 429,
  upstream_unavailable: 502,
  upstream_forbidden: 502,
  upstream_not_found: 404,
  timeout: 504,
  configuration_error: 500,
  locked: 423,
  internal: 500,
};

export interface JarvisErrorOptions {
  /** Machine-readable details safe to show to the owner (never provider payloads). */
  readonly details?: Readonly<Record<string, unknown>>;
  readonly cause?: unknown;
  /** True when retrying the same operation later could reasonably succeed. */
  readonly retryable?: boolean;
}

/**
 * A brand, checked instead of `instanceof`.
 *
 * Next.js can compile the same module more than once — the server bundle and the route-handler
 * runtime are separate compilations — which gives `JarvisError` two class identities and makes
 * `instanceof` quietly false. The symptom is the worst possible one: a correct 409 rendered as an
 * opaque 500. A brand travels with the object, so identity survives.
 */
const JARVIS_ERROR_BRAND = '__jarvisError';

export class JarvisError extends Error {
  /** @internal */
  readonly [JARVIS_ERROR_BRAND] = true as const;
  readonly code: JarvisErrorCode;
  readonly httpStatus: number;
  readonly details: Readonly<Record<string, unknown>>;
  readonly retryable: boolean;

  constructor(code: JarvisErrorCode, message: string, options: JarvisErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'JarvisError';
    this.code = code;
    this.httpStatus = STATUS_BY_CODE[code];
    this.details = options.details ?? {};
    this.retryable = options.retryable ?? (code === 'timeout' || code === 'upstream_unavailable');
  }
}

export class UnauthorizedError extends JarvisError {
  constructor(message = 'Authentication required.') {
    super('unauthorized', message);
    this.name = 'UnauthorizedError';
  }
}

/**
 * The request is well-formed, the caller is who they say they are, and the answer is still no.
 *
 * `details` is optional and matches `ValidationError` and `ConflictError` rather than inventing a
 * third convention. Phase 4 refusals — an unqualified capability, an exhausted budget, a connector
 * that may not be invoked by a model — all want to say *which* limit stopped them, and a refusal
 * that cannot say why is a refusal somebody has to read the source to understand.
 */
export class ForbiddenError extends JarvisError {
  constructor(
    message = 'This Jarvis instance is private.',
    details?: Readonly<Record<string, unknown>>,
  ) {
    super('forbidden', message, details ? { details } : {});
    this.name = 'ForbiddenError';
  }
}

export class NotFoundError extends JarvisError {
  constructor(what = 'Resource') {
    super('not_found', `${what} was not found.`);
    this.name = 'NotFoundError';
  }
}

export class ValidationError extends JarvisError {
  constructor(message: string, details?: Readonly<Record<string, unknown>>) {
    super('validation_failed', message, details ? { details } : {});
    this.name = 'ValidationError';
  }
}

export class ConfigurationError extends JarvisError {
  constructor(message: string) {
    super('configuration_error', message);
    this.name = 'ConfigurationError';
  }
}

export class ConflictError extends JarvisError {
  constructor(message: string, details?: Readonly<Record<string, unknown>>) {
    super('conflict', message, details ? { details } : {});
    this.name = 'ConflictError';
  }
}

export class LockedError extends JarvisError {
  constructor(message = 'This project is already synchronising.') {
    super('locked', message);
    this.name = 'LockedError';
  }
}

export function isJarvisError(value: unknown): value is JarvisError {
  if (value instanceof JarvisError) return true;
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as Record<string, unknown>)[JARVIS_ERROR_BRAND] === true &&
    typeof (value as Record<string, unknown>).code === 'string' &&
    typeof (value as Record<string, unknown>).httpStatus === 'number'
  );
}

export interface ErrorResponseBody {
  readonly error: {
    readonly code: JarvisErrorCode;
    readonly message: string;
    readonly details?: Readonly<Record<string, unknown>>;
  };
}

/** Convert any thrown value into a safe, structured response body plus a status code. */
export function toErrorResponse(error: unknown): { status: number; body: ErrorResponseBody } {
  if (isJarvisError(error)) {
    return {
      status: error.httpStatus,
      body: {
        error: {
          code: error.code,
          message: error.message,
          ...(Object.keys(error.details).length > 0 ? { details: error.details } : {}),
        },
      },
    };
  }
  return {
    status: 500,
    body: { error: { code: 'internal', message: 'An unexpected error occurred.' } },
  };
}
