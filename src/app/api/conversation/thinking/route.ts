import { NextResponse } from 'next/server';
import { json, ownerRoute } from '@/server/http/handler';

export const dynamic = 'force-dynamic';

/**
 * Where the worker has got to with a question the dashboard asked.
 *
 * A GET, because it changes nothing and the browser calls it repeatedly. The answer is read from a
 * row rather than from anything held in this process, so it survives a redeploy, a restart and a
 * refresh — which is the whole reason the question is a row in the first place.
 *
 * A 404 for an unknown id, deliberately. The browser holds an id it was given; an id it was not
 * given belongs to nobody, and returning an empty "still thinking" for it would leave a page
 * polling forever over a typo.
 */
export const GET = ownerRoute(async ({ services, request }) => {
  const requestId = new URL(request.url).searchParams.get('request') ?? '';
  const thinking = requestId ? await services.reasoningService.statusFor(requestId) : null;
  if (!thinking) {
    return NextResponse.json(
      { error: { code: 'not_found', message: 'That question is not one Jarvis is holding.' } },
      { status: 404, headers: { 'cache-control': 'no-store' } },
    );
  }
  return json({ thinking });
});
