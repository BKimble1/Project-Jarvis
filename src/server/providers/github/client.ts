import { Octokit } from '@octokit/rest';
import { RequestError } from '@octokit/request-error';
import { JarvisError } from '@/domain/errors';
import type { RateLimitState } from '../types';

/**
 * The read-only GitHub client.
 *
 * Two mechanisms guarantee Jarvis can never modify a connected repository:
 *
 *  1. `assertReadOnlyRequest` rejects any HTTP method other than GET/HEAD *before* the request
 *     leaves the process, so even a future coding mistake cannot issue a write.
 *  2. The documented credential is a fine-grained token with read-only repository permissions.
 *
 * Mechanism 1 is directly asserted by the test-suite, so the guarantee is verifiable rather
 * than merely documented.
 */

export type GithubErrorKind =
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'rate_limited'
  | 'empty_repository'
  | 'unavailable'
  | 'timeout'
  | 'malformed'
  | 'write_attempt';

export class GithubApiError extends JarvisError {
  readonly kind: GithubErrorKind;
  readonly rateLimit: RateLimitState | null;

  constructor(kind: GithubErrorKind, message: string, rateLimit: RateLimitState | null = null) {
    super(mapCode(kind), message, { retryable: kind === 'unavailable' || kind === 'timeout' });
    this.name = 'GithubApiError';
    this.kind = kind;
    this.rateLimit = rateLimit;
  }
}

function mapCode(kind: GithubErrorKind) {
  switch (kind) {
    case 'unauthorized':
      return 'upstream_forbidden' as const;
    case 'forbidden':
    case 'write_attempt':
      return 'upstream_forbidden' as const;
    case 'not_found':
    case 'empty_repository':
      return 'upstream_not_found' as const;
    case 'rate_limited':
      return 'rate_limited' as const;
    case 'timeout':
      return 'timeout' as const;
    case 'malformed':
      return 'upstream_unavailable' as const;
    default:
      return 'upstream_unavailable' as const;
  }
}

const READ_METHODS = new Set(['GET', 'HEAD']);

/** Throws if a non-read HTTP method is ever attempted against GitHub. */
export function assertReadOnlyRequest(method: string, url: string): void {
  if (!READ_METHODS.has(method.toUpperCase())) {
    throw new GithubApiError(
      'write_attempt',
      `Jarvis is read-only: refused a ${method.toUpperCase()} request to GitHub (${redactUrl(url)}).`,
    );
  }
}

function redactUrl(url: string): string {
  try {
    const parsed = new URL(url, 'https://api.github.com');
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return '[unparsable url]';
  }
}

export interface GithubClientOptions {
  readonly token: string;
  readonly baseUrl: string;
  readonly timeoutMs: number;
  /** Injected in tests to simulate GitHub without any network access. */
  readonly fetchImpl?: typeof fetch;
  readonly maxRetries?: number;
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface GithubClient {
  readonly octokit: Octokit;
  /** Rate-limit state observed on the most recent response. */
  readonly rateLimit: () => RateLimitState | null;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function createGithubClient(options: GithubClientOptions): GithubClient {
  let rateLimit: RateLimitState | null = null;
  const maxRetries = options.maxRetries ?? 2;
  const sleep = options.sleep ?? defaultSleep;
  const baseFetch = options.fetchImpl ?? fetch;

  const instrumentedFetch: typeof fetch = async (input, init) => {
    const method = (init?.method ?? 'GET').toUpperCase();
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    assertReadOnlyRequest(method, url);

    let lastError: unknown = null;
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), options.timeoutMs);
      try {
        const response = await baseFetch(input, { ...init, signal: controller.signal });
        rateLimit = readRateLimit(response.headers);
        /* Retry only on transient upstream faults; 4xx responses are meaningful, not flaky. */
        if (response.status >= 500 && attempt < maxRetries) {
          await sleep(backoffMs(attempt));
          continue;
        }
        return response;
      } catch (error) {
        lastError = error;
        const aborted = error instanceof Error && error.name === 'AbortError';
        if (attempt >= maxRetries) {
          if (aborted) {
            throw new GithubApiError('timeout', 'GitHub did not respond in time.', rateLimit);
          }
          throw new GithubApiError('unavailable', 'Could not reach GitHub.', rateLimit);
        }
        await sleep(backoffMs(attempt));
      } finally {
        clearTimeout(timer);
      }
    }
    throw new GithubApiError(
      'unavailable',
      lastError instanceof Error ? `Could not reach GitHub: ${lastError.name}` : 'Could not reach GitHub.',
      rateLimit,
    );
  };

  const octokit = new Octokit({
    auth: options.token,
    baseUrl: options.baseUrl,
    userAgent: 'jarvis-project-registry',
    request: { fetch: instrumentedFetch },
  });

  return { octokit, rateLimit: () => rateLimit };
}

export function backoffMs(attempt: number): number {
  return Math.min(4000, 250 * 2 ** attempt);
}

export function readRateLimit(headers: Headers | Record<string, unknown>): RateLimitState | null {
  const get = (name: string): string | null => {
    if (typeof (headers as Headers).get === 'function') return (headers as Headers).get(name);
    const record = headers as Record<string, unknown>;
    const value = record[name] ?? record[name.toLowerCase()];
    return value === undefined || value === null ? null : String(value);
  };

  const limit = numberOrNull(get('x-ratelimit-limit'));
  const remaining = numberOrNull(get('x-ratelimit-remaining'));
  const reset = numberOrNull(get('x-ratelimit-reset'));
  const resource = get('x-ratelimit-resource');
  if (limit === null && remaining === null && reset === null) return null;
  return {
    limit,
    remaining,
    resetAt: reset === null ? null : new Date(reset * 1000).toISOString(),
    resource: resource ?? null,
  };
}

function numberOrNull(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Translate an Octokit failure into Jarvis's error taxonomy.
 *
 * This is where "credential revoked", "repository renamed", "Actions disabled" and
 * "rate limited" stop being HTTP status codes and become states the product can explain.
 */
export function translateGithubError(error: unknown, rateLimit: RateLimitState | null): GithubApiError {
  if (error instanceof GithubApiError) return error;

  if (error instanceof RequestError) {
    const headerLimit = error.response?.headers ? readRateLimit(error.response.headers) : rateLimit;
    const remaining = headerLimit?.remaining ?? null;
    const message = typeof error.message === 'string' ? error.message : '';

    if (error.status === 401) {
      return new GithubApiError(
        'unauthorized',
        'GitHub rejected the credential. It may have been revoked or expired.',
        headerLimit,
      );
    }
    if (error.status === 403 || error.status === 429) {
      if (remaining === 0 || /rate limit/i.test(message)) {
        return new GithubApiError(
          'rate_limited',
          'GitHub rate limit reached. Jarvis kept the data it already had.',
          headerLimit,
        );
      }
      return new GithubApiError(
        'forbidden',
        'The credential does not have permission for this data.',
        headerLimit,
      );
    }
    if (error.status === 404) {
      return new GithubApiError(
        'not_found',
        'GitHub returned "not found". The repository may have been renamed, deleted, or is outside the credential\'s scope.',
        headerLimit,
      );
    }
    if (error.status === 409) {
      return new GithubApiError('empty_repository', 'The repository has no commits yet.', headerLimit);
    }
    if (error.status >= 500) {
      return new GithubApiError('unavailable', 'GitHub is currently unavailable.', headerLimit);
    }
    return new GithubApiError('unavailable', `GitHub request failed (status ${error.status}).`, headerLimit);
  }

  if (error instanceof Error && error.name === 'AbortError') {
    return new GithubApiError('timeout', 'GitHub did not respond in time.', rateLimit);
  }
  return new GithubApiError('unavailable', 'Could not reach GitHub.', rateLimit);
}
