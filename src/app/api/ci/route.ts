import { json, ownerRoute } from '@/server/http/handler';

export const dynamic = 'force-dynamic';

/**
 * The CI controller's configuration and recent history.
 *
 * `describe()` returns the allow-lists and whether a credential is configured. It never returns
 * the credential, and there is no field on the response through which one could travel.
 */
export const GET = ownerRoute(async ({ services }) => {
  const dispatches = await services.ciDispatches.listRecent(30);
  return json({ controller: services.ci.describe(), dispatches });
});
