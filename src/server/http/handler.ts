import { NextResponse } from 'next/server';
import type { z } from 'zod';
import { toErrorResponse, ValidationError } from '@/domain/errors';
import { logger as rootLogger } from '@/server/logging/logger';
import { assertSameOrigin, requireOwnerApi } from '@/server/auth/guard';
import { getServices, type Services } from '@/server/container';
import type { OwnerSession } from '@/server/auth/session';

/**
 * Route-handler plumbing.
 *
 * Every private endpoint goes through `ownerRoute`, which enforces authentication on the server,
 * rejects cross-origin writes, validates the body, and converts any thrown error into a safe
 * JSON response. No route handler is allowed to do its own ad-hoc auth check.
 */

export interface RouteContext {
  readonly session: OwnerSession;
  readonly services: Services;
  readonly request: Request;
}

export function json(data: unknown, init?: ResponseInit): NextResponse {
  return NextResponse.json(data as Record<string, unknown>, {
    ...init,
    headers: { 'cache-control': 'no-store', ...(init?.headers ?? {}) },
  });
}

export function errorResponse(error: unknown): NextResponse {
  const { status, body } = toErrorResponse(error);
  if (status >= 500) {
    rootLogger().error('request failed', { status, error });
  }
  return NextResponse.json(body, { status, headers: { 'cache-control': 'no-store' } });
}

export function ownerRoute(
  handler: (context: RouteContext) => Promise<NextResponse>,
): (request: Request) => Promise<NextResponse> {
  return async (request: Request) => {
    try {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        await assertSameOrigin(request);
      }
      const session = await requireOwnerApi();
      const services = await getServices();
      return await handler({ session, services, request });
    } catch (error) {
      return errorResponse(error);
    }
  };
}

/** Same as `ownerRoute`, for handlers that also receive dynamic route params. */
export function ownerRouteWithParams<P extends Record<string, string>>(
  handler: (context: RouteContext & { params: P }) => Promise<NextResponse>,
): (request: Request, segment: { params: Promise<P> }) => Promise<NextResponse> {
  return async (request: Request, segment: { params: Promise<P> }) => {
    try {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        await assertSameOrigin(request);
      }
      const session = await requireOwnerApi();
      const services = await getServices();
      const params = await segment.params;
      return await handler({ session, services, request, params });
    } catch (error) {
      return errorResponse(error);
    }
  };
}

/** Parse and validate a JSON body, converting schema failures into a 422 with field messages. */
export async function parseBody<S extends z.ZodType>(
  request: Request,
  schema: S,
): Promise<z.infer<S>> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    throw new ValidationError('The request body must be valid JSON.');
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new ValidationError('Some fields need attention.', {
      fields: parsed.error.issues.map((issue) => ({
        path: issue.path.join('.') || 'root',
        message: issue.message,
      })),
    });
  }
  return parsed.data;
}
