import { json, ownerRouteWithParams } from '@/server/http/handler';

export const dynamic = 'force-dynamic';

/** Withdraw an approval. Takes effect immediately; nothing caches it. */
export const POST = ownerRouteWithParams<{ id: string }>(async ({ services, params }) => {
  const approval = await services.ci.revokeRelease(params.id);
  await services.activity.record({
    kind: 'release_revoked',
    summary: `A TestFlight approval for ${approval.repositoryFullName} was revoked.`,
  });
  return json({ approval });
});
