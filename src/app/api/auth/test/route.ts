import { NextResponse } from 'next/server';
import { ForbiddenError } from '@/domain/errors';
import { getConfig } from '@/server/config/env';
import { getServices } from '@/server/container';
import { SESSION_COOKIE, safeEqual } from '@/server/auth/session';
import { errorResponse } from '@/server/http/handler';

export const dynamic = 'force-dynamic';

/**
 * Secure test-authentication endpoint for end-to-end tests.
 *
 * It exists only when `JARVIS_TEST_AUTH_SECRET` is set, and `buildConfig` refuses to populate
 * that value in production — so this route is inert in a real deployment, not merely guarded.
 */
export async function POST(request: Request): Promise<NextResponse> {
  try {
    const config = getConfig();
    if (config.isProduction || !config.testAuthSecret) {
      throw new ForbiddenError('Test authentication is not available.');
    }
    const provided =
      request.headers.get('x-jarvis-test-secret') ??
      new URL(request.url).searchParams.get('secret') ??
      '';
    if (!provided || !safeEqual(provided, config.testAuthSecret)) {
      throw new ForbiddenError('Invalid test credential.');
    }

    const services = await getServices();
    const { token } = await services.sessions.create({
      githubLogin: config.owner.githubLogin ?? 'test-owner',
      githubUserId: config.owner.githubUserId ?? 'test-owner-id',
      displayName: 'Test owner',
      avatarUrl: null,
      ttlHours: 2,
      userAgent: request.headers.get('user-agent'),
    });

    const response = NextResponse.json({ ok: true });
    response.cookies.set(SESSION_COOKIE, token, {
      httpOnly: true,
      secure: false,
      sameSite: 'lax',
      path: '/',
      maxAge: 7200,
    });
    return response;
  } catch (error) {
    return errorResponse(error);
  }
}
