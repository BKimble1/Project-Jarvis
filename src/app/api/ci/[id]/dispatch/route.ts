import { json, ownerRouteWithParams } from '@/server/http/handler';

export const dynamic = 'force-dynamic';

/**
 * Approve and send one workflow dispatch.
 *
 * Policy is re-evaluated here, immediately before the call to GitHub, rather than trusted from
 * when the request was recorded: an allow-list edited in between has to take effect, and
 * trusting the stored state would mean a repository removed from the list could still be built.
 */
export const POST = ownerRouteWithParams<{ id: string }>(async ({ services, session, params }) => {
  const dispatch = await services.ci.dispatch(params.id, session.githubLogin ?? session.id);
  return json({ dispatch });
});
