import { NextResponse } from 'next/server';
import { getConfig } from '@/server/config/env';
import { getServices } from '@/server/container';
import { buildAuthorizeUrl } from '@/server/auth/github-oauth';
import { errorResponse } from '@/server/http/handler';

export const dynamic = 'force-dynamic';

/** Begins the GitHub sign-in flow. The single-use state is stored server-side. */
export async function GET(request: Request): Promise<NextResponse> {
  try {
    const config = getConfig();
    const services = await getServices();
    const url = new URL(request.url);
    const next = url.searchParams.get('next');
    /* Only same-site paths are accepted, so the callback can never bounce to another origin. */
    const redirectTo = next && next.startsWith('/') && !next.startsWith('//') ? next : null;
    const state = await services.oauthStates.issue(redirectTo);
    return NextResponse.redirect(buildAuthorizeUrl(config, state));
  } catch (error) {
    return errorResponse(error);
  }
}
