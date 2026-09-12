import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { DISPLAY_COOKIE_NAME, DISPLAY_TOKEN_PATTERN } from '@/domain/display-device';
import { toErrorResponse } from '@/domain/errors';
import { getServices } from '@/server/container';

export const dynamic = 'force-dynamic';

const pairSchema = z.object({ token: z.string().trim().regex(DISPLAY_TOKEN_PATTERN) });

/**
 * Store a display token in this browser.
 *
 * A wallboard is set up once by someone standing in front of it, and after that nobody types
 * anything again. The token is exchanged for an `httpOnly` cookie so it is not readable from the
 * page's own JavaScript — a screen in a shared room is exactly the place where "the token is in
 * localStorage" turns into "anyone who opens devtools has the token".
 *
 * The token is verified here before the cookie is set: a display that says "paired" and then
 * fails on every refresh is worse than one that refuses immediately.
 */
export async function POST(request: Request): Promise<NextResponse> {
  try {
    const parsed = pairSchema.parse(await request.json());
    const services = await getServices();
    const device = await services.displays.authenticate(parsed.token, {
      userAgent: request.headers.get('user-agent'),
    });

    const store = await cookies();
    store.set(DISPLAY_COOKIE_NAME, parsed.token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      path: '/',
      /* A year: a wallboard is not something anyone wants to re-pair. Revocation is the control. */
      maxAge: 365 * 24 * 60 * 60,
    });
    return NextResponse.json(
      { device: { name: device.name, scopes: device.scopes } },
      { headers: { 'cache-control': 'no-store' } },
    );
  } catch (error) {
    const { status, body } = toErrorResponse(error);
    return NextResponse.json(body, { status, headers: { 'cache-control': 'no-store' } });
  }
}

/** Unpair this browser. Deliberately available without the token — it only ever removes access. */
export async function DELETE(): Promise<NextResponse> {
  (await cookies()).delete(DISPLAY_COOKIE_NAME);
  return NextResponse.json({ ok: true }, { headers: { 'cache-control': 'no-store' } });
}
