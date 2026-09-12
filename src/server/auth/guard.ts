import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { ForbiddenError, UnauthorizedError } from '@/domain/errors';
import { getConfig } from '@/server/config/env';
import { getServices } from '@/server/container';
import { SESSION_COOKIE, safeEqual, type OwnerSession } from './session';

/**
 * Server-side authorisation.
 *
 * Every private page and every private route handler calls one of these. Access is never decided
 * in the browser: a client-side guard would be a suggestion, whereas these run before any data
 * is loaded and before any HTML is produced.
 */

export async function readSession(): Promise<OwnerSession | null> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const services = await getServices();
  return services.sessions.find(token);
}

/** For server components: redirects to the sign-in screen instead of throwing. */
export async function requireOwnerPage(returnTo?: string): Promise<OwnerSession> {
  const session = await readSession();
  if (!session) {
    const target = returnTo ? `/signin?next=${encodeURIComponent(returnTo)}` : '/signin';
    redirect(target);
  }
  return session;
}

/** For route handlers and server actions: throws, so the caller returns a 401. */
export async function requireOwnerApi(): Promise<OwnerSession> {
  const session = await readSession();
  if (!session) throw new UnauthorizedError();
  return session;
}

/**
 * Protects the scheduled-synchronisation endpoint.
 *
 * Accepts a bearer token or `x-jarvis-cron-secret`, compared in constant time. When no secret is
 * configured the endpoint is closed rather than open.
 */
export function assertCronAuthorised(request: Request): void {
  const config = getConfig();
  if (!config.cronSecret) {
    throw new ForbiddenError(
      'Scheduled synchronisation is disabled because CRON_SECRET is not set.',
    );
  }
  const header =
    request.headers.get('x-jarvis-cron-secret') ??
    request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ??
    '';
  if (!header || !safeEqual(header, config.cronSecret)) {
    throw new ForbiddenError('Invalid scheduled-synchronisation credential.');
  }
}

/**
 * Rejects cross-site state-changing requests.
 *
 * The session cookie is already `SameSite=Lax`, which blocks cross-site form posts; this is the
 * second layer, so a browser quirk alone is not the only thing standing between Jarvis and CSRF.
 */
export async function assertSameOrigin(request: Request): Promise<void> {
  const config = getConfig();
  const origin = request.headers.get('origin');
  if (!origin) return;
  const allowed = new Set([config.baseUrl]);
  const forwardedHost = (await headers()).get('x-forwarded-host');
  if (forwardedHost) {
    allowed.add(`https://${forwardedHost}`);
    if (!config.isProduction) allowed.add(`http://${forwardedHost}`);
  }
  if (!allowed.has(new URL(origin).origin)) {
    throw new ForbiddenError('Cross-origin request rejected.');
  }
}
