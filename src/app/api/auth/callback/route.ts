import { NextResponse } from 'next/server';
import { getConfig } from '@/server/config/env';
import { getServices } from '@/server/container';
import { exchangeCodeForIdentity } from '@/server/auth/github-oauth';
import { isOwner } from '@/server/auth/owner';
import { SESSION_COOKIE } from '@/server/auth/session';
import { logger } from '@/server/logging/logger';

export const dynamic = 'force-dynamic';

/**
 * Completes the GitHub sign-in flow.
 *
 * A successful GitHub authentication is not enough: the identity must match the configured
 * owner. Everyone else is redirected to a generic failure that reveals nothing about who the
 * owner is or whether the account exists.
 */
export async function GET(request: Request): Promise<NextResponse> {
  const config = getConfig();
  const url = new URL(request.url);
  const failure = (reason: string) =>
    NextResponse.redirect(`${config.baseUrl}/signin?error=${encodeURIComponent(reason)}`);

  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  if (!code || !state) return failure('missing_parameters');

  try {
    const services = await getServices();
    const consumed = await services.oauthStates.consume(state);
    if (!consumed.ok) return failure('expired');

    const identity = await exchangeCodeForIdentity(config, code);
    const decision = isOwner(identity, config);
    if (!decision.allowed) {
      logger().warn('rejected sign-in attempt', { reason: decision.reason });
      return failure('not_authorised');
    }

    const { token } = await services.sessions.create({
      githubLogin: identity.login,
      githubUserId: String(identity.id),
      displayName: identity.name ?? identity.login,
      avatarUrl: identity.avatarUrl ?? null,
      ttlHours: config.sessionTtlHours,
      userAgent: request.headers.get('user-agent'),
    });

    const destination = consumed.redirectTo ?? '/dashboard';
    const response = NextResponse.redirect(`${config.baseUrl}${destination}`);
    response.cookies.set(SESSION_COOKIE, token, {
      httpOnly: true,
      secure: config.isProduction,
      sameSite: 'lax',
      path: '/',
      maxAge: config.sessionTtlHours * 3600,
    });
    return response;
  } catch (error) {
    logger().error('sign-in failed', { error });
    return failure('sign_in_failed');
  }
}
