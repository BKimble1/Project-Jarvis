import { json, ownerRouteWithParams } from '@/server/http/handler';

export const dynamic = 'force-dynamic';

/**
 * The evidence one answer was allowed to use, exactly as it was frozen.
 *
 * Owner-scoped through the service, which checks the answer belongs to this person before
 * returning anything. `revisionId` and `contentHash` are included because they are the point of a
 * snapshot: they say which version supported the answer, so a document that has since been
 * re-read does not silently change what an old answer stood on.
 */
export const GET = ownerRouteWithParams<{ id: string }>(async ({ services, params, session }) => {
  const ownerId = session.githubLogin ?? session.id;
  const items = await services.answerService.evidenceFor(params.id, ownerId);

  return json({
    evidence: items.map((item) => ({
      ref: item.ref,
      kind: item.kind,
      origin: item.origin,
      label: item.label,
      excerpt: item.excerpt,
      locator: item.locator,
      href: item.href,
      projectId: item.projectId,
      revisionId: item.revisionId,
      contentHash: item.contentHash,
      trust: item.trust,
    })),
  });
});
