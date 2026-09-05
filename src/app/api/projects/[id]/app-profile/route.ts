import { appProfileSchema } from '@/domain/app-profile';
import { json, ownerRouteWithParams, parseBody } from '@/server/http/handler';

export const dynamic = 'force-dynamic';

export const GET = ownerRouteWithParams<{ id: string }>(async ({ services, params }) => {
  const profile = await services.appProfiles.findByProject(params.id);
  return json({ profile });
});

/**
 * Record what an app *is*.
 *
 * The schema refuses anything that looks like a credential — a PEM block, a token, a base64 blob
 * — because the one mistake this table must never absorb is a pasted signing key. What it stores
 * instead is the *name* of the GitHub Actions secret where the real thing lives.
 */
export const PUT = ownerRouteWithParams<{ id: string }>(async ({ services, request, params }) => {
  const input = await parseBody(request, appProfileSchema);
  const profile = await services.appProfiles.upsert(params.id, input);
  return json({ profile });
});
