import { NextResponse } from 'next/server';
import { ownerRoute } from '@/server/http/handler';

export const dynamic = 'force-dynamic';

/**
 * What Jarvis can see of Blake's day right now.
 *
 * Owner-only, like everything under `/api`. The response is assembled from the provider on each
 * request and stored nowhere: there is no cache to go stale and no table holding yesterday's
 * inbox. `mode=new` advances the delta cursor and is what a briefing calls; the default `unread`
 * leaves it alone, so opening the screen twice does not consume the "since you last asked" answer.
 */
export const GET = ownerRoute(async ({ services, request }) => {
  const url = new URL(request.url);
  const mode = url.searchParams.get('mode') === 'new' ? 'new-since-last' : 'unread';
  const signals = await services.personalSignals.read({ mailMode: mode });
  return NextResponse.json({ signals });
});
