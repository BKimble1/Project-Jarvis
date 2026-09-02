import { json, ownerRoute } from '@/server/http/handler';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export const POST = ownerRoute(async ({ services }) => {
  const outcomes = await services.sync.syncAll('manual');
  for (const outcome of outcomes) {
    if (outcome.skipped === 'locked') continue;
    await services.briefings.briefProject(outcome.projectId, { regenerate: true }).catch(() => {
      /* A briefing failure must not fail the whole sync run. */
    });
  }
  return json({ outcomes });
});
