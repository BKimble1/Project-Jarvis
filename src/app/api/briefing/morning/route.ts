import { buildMorningBriefing } from '@/server/ops/morning-briefing';
import { json, ownerRoute } from '@/server/http/handler';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * "What happened, and what needs me?" — the whole answer, in one read.
 *
 * GET rather than POST because it changes nothing: it reads the operating picture, the mission
 * rows and the status engine, and returns sentences. Nothing here starts work, and nothing here
 * records that a briefing was read — a briefing whose act of being read had side effects would be
 * a briefing people learned to avoid opening.
 */
export const GET = ownerRoute(async ({ services, request }) => {
  const since = new URL(request.url).searchParams.get('since');
  return json({
    briefing: await buildMorningBriefing(services, { lastBriefingAt: since }),
  });
});
