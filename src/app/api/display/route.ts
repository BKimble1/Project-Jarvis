import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { DISPLAY_COOKIE_NAME } from '@/domain/display-device';
import { toErrorResponse } from '@/domain/errors';
import { getServices } from '@/server/container';
import { buildDisplayPayload } from '@/server/display/display-payload';

export const dynamic = 'force-dynamic';

/**
 * The wallboard's data.
 *
 * Authenticated by the display's own credential, never by an owner session — a wallboard should
 * keep working when the owner signs out on their laptop, and signing out on the laptop should not
 * be what stops a screen in a kitchen showing private data. The two are separate identities with
 * separate lifetimes and separate revocation.
 *
 * `GET` only. There is no display-authenticated write anywhere in Jarvis: no approve, no pause,
 * no stop, no message, no retry, no merge, no TestFlight. The way that is guaranteed is that no
 * such route exists, not that a display route checks a flag.
 */
export async function GET(request: Request): Promise<NextResponse> {
  try {
    const header = request.headers.get('authorization');
    const bearer = header?.startsWith('Bearer ') ? header.slice(7).trim() : null;
    const cookieToken = (await cookies()).get(DISPLAY_COOKIE_NAME)?.value ?? null;

    const services = await getServices();
    const device = await services.displays.authenticate(bearer ?? cookieToken, {
      userAgent: request.headers.get('user-agent'),
    });
    const payload = await buildDisplayPayload(services, device);
    return NextResponse.json(payload, { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    const { status, body } = toErrorResponse(error);
    return NextResponse.json(body, { status, headers: { 'cache-control': 'no-store' } });
  }
}
