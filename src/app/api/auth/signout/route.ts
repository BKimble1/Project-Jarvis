import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { getConfig } from '@/server/config/env';
import { getServices } from '@/server/container';
import { SESSION_COOKIE } from '@/server/auth/session';
import { assertSameOrigin } from '@/server/auth/guard';
import { errorResponse } from '@/server/http/handler';

export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<NextResponse> {
  try {
    await assertSameOrigin(request);
    const jar = await cookies();
    const token = jar.get(SESSION_COOKIE)?.value;
    if (token) {
      const services = await getServices();
      await services.sessions.destroy(token);
    }
    const response = NextResponse.redirect(`${getConfig().baseUrl}/signin`, { status: 303 });
    response.cookies.delete(SESSION_COOKIE);
    return response;
  } catch (error) {
    return errorResponse(error);
  }
}
