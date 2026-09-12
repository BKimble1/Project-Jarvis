import { z } from 'zod';
import { json, ownerRouteWithParams, parseBody } from '@/server/http/handler';

export const dynamic = 'force-dynamic';

const resolveSchema = z.object({
  /* The exact token the answer cited. Not a source id, not a chunk id — the reference itself. */
  ref: z.string().trim().min(3).max(200),
});

/**
 * Resolve one citation.
 *
 * ## Why this cannot be used to enumerate
 *
 * A reference is meaningful only inside the answer that produced it, and the lookup joins to that
 * answer and requires it to have been asked by this owner. There is deliberately **no route that
 * resolves a reference on its own**: without the answer, a reference is not a key to anything, so
 * guessing identifiers reveals nothing about what exists in another scope. A reference that is
 * real but belongs to somebody else's answer returns the same 404 as one that is invented.
 *
 * ## Why it is a POST
 *
 * The reference goes in the body rather than the URL so it never reaches an access log, a browser
 * history entry or a `Referer` header. A citation token names a document a person chose to keep
 * private; the resolution is a read, but the identifier is not something to scatter.
 *
 * ## What comes back
 *
 * The frozen row — the excerpt as it was when the answer was built, and the revision it came
 * from. If the underlying source has since been deleted, this still resolves to what the answer
 * actually stood on, and `available` says the live source is gone rather than quietly
 * substituting a different one.
 */
export const POST = ownerRouteWithParams<{ id: string }>(
  async ({ services, params, request, session }) => {
    const body = await parseBody(request, resolveSchema);
    const ownerId = session.githubLogin ?? session.id;

    const item = await services.answerService.resolveCitation({
      answerId: params.id,
      ref: body.ref,
      ownerId,
    });

    /*
     * Whether the thing it points at still exists. Reported rather than hidden: a citation whose
     * source was deleted should say so, because silently showing a different source — or nothing
     * — is how an answer stops being checkable without anyone noticing.
     */
    let available = true;
    if (item.revisionId) {
      const revision = await services.revisions.findById(item.revisionId);
      available = revision !== null;
    }

    return json({
      citation: {
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
      },
      available,
      note: available
        ? null
        : 'The source this cited has since been deleted. What is shown is what the answer was built on.',
    });
  },
);
