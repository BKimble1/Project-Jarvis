import { NextResponse } from 'next/server';
import type { z } from 'zod';
import { ValidationError } from '@/domain/errors';
import { WORKER_REQUEST_MAX_BYTES } from '@/domain/worker-protocol';
import { getServices, type Services } from '@/server/container';
import {
  IDEMPOTENCY_TTL_HOURS,
  authenticateWorker,
  hashRequestBody,
  requireIdempotencyKey,
} from '@/server/workers/auth';
import { errorResponse, json } from './handler';

/**
 * Route plumbing for the worker API.
 *
 * Deliberately a *separate* wrapper from `ownerRoute` rather than a flag on it, because the two
 * have opposite requirements:
 *
 *  - An owner request must come from a browser, so it carries a session cookie and is checked for
 *    same-origin. A worker sends neither and must not be judged by them.
 *  - A worker request must carry a bearer token and, when it changes state, an idempotency key.
 *    A browser request must never be able to satisfy those.
 *
 * Keeping them apart means neither check can be accidentally weakened to accommodate the other.
 */

export interface WorkerRouteContext<T> {
  readonly workerId: string;
  readonly services: Services;
  readonly request: Request;
  readonly body: T;
}

export interface WorkerRouteOptions {
  /**
   * Require an `Idempotency-Key` and replay the stored response for a repeat.
   *
   * On for anything that changes state. Off for `poll`, which is a read plus a heartbeat and is
   * safe (indeed expected) to repeat.
   */
  readonly idempotent?: boolean;
  /** Used as the idempotency namespace and in logs. */
  readonly name: string;
}

/** Bounded body read. A worker is authenticated, not trusted with an unlimited request. */
async function readBoundedJson(request: Request): Promise<unknown> {
  const declared = request.headers.get('content-length');
  if (declared && Number(declared) > WORKER_REQUEST_MAX_BYTES) {
    throw new ValidationError('That request body is too large.');
  }
  const text = await request.text();
  if (text.length > WORKER_REQUEST_MAX_BYTES) {
    throw new ValidationError('That request body is too large.');
  }
  if (text.trim().length === 0) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ValidationError('The request body must be valid JSON.');
  }
}

export function workerRoute<S extends z.ZodType>(
  schema: S,
  options: WorkerRouteOptions,
  handler: (context: WorkerRouteContext<z.infer<S>>) => Promise<NextResponse>,
): (request: Request) => Promise<NextResponse> {
  return async (request: Request) => {
    try {
      const services = await getServices();
      const { workerId } = await authenticateWorker(request, services.workerRepo);

      const raw = await readBoundedJson(request);
      const parsed = schema.safeParse(raw);
      if (!parsed.success) {
        throw new ValidationError('That worker request did not validate.', {
          fields: parsed.error.issues.map((issue) => ({
            path: issue.path.join('.') || 'root',
            message: issue.message,
          })),
        });
      }

      if (!options.idempotent) {
        return await handler({ workerId, services, request, body: parsed.data });
      }

      const key = requireIdempotencyKey(request);
      const requestHash = hashRequestBody({ endpoint: options.name, body: raw });

      const existing = await services.idempotency.find(workerId, key);
      if (existing) {
        /*
         * The same key with a different body is a bug on the worker's side, not a retry. Replaying
         * the old response would hide it; applying the new one would break the guarantee.
         */
        if (existing.requestHash !== requestHash) {
          return NextResponse.json(
            {
              error: {
                code: 'conflict',
                message: 'That idempotency key was already used with a different request body.',
              },
            },
            { status: 409, headers: { 'cache-control': 'no-store' } },
          );
        }
        return NextResponse.json(existing.body, {
          status: existing.status,
          headers: { 'cache-control': 'no-store', 'idempotent-replay': 'true' },
        });
      }

      const response = await handler({ workerId, services, request, body: parsed.data });
      const body = (await response.clone().json()) as Record<string, unknown>;
      await services.idempotency.save({
        workerId,
        key,
        endpoint: options.name,
        requestHash,
        status: response.status,
        body,
        expiresAt: new Date(Date.now() + IDEMPOTENCY_TTL_HOURS * 3600_000),
      });
      return response;
    } catch (error) {
      return errorResponse(error);
    }
  };
}

/** Same, for the two worker routes that carry a dynamic id segment. */
export function workerRouteWithParams<S extends z.ZodType, P extends Record<string, string>>(
  schema: S,
  options: WorkerRouteOptions,
  handler: (context: WorkerRouteContext<z.infer<S>> & { params: P }) => Promise<NextResponse>,
): (request: Request, segment: { params: Promise<P> }) => Promise<NextResponse> {
  return async (request: Request, segment: { params: Promise<P> }) => {
    const params = await segment.params;
    const inner = workerRoute(schema, options, (context) => handler({ ...context, params }));
    return inner(request);
  };
}

export { json };
