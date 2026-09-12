import { KNOWLEDGE_ORIGIN_LABELS } from '@/domain/knowledge';
import { json, ownerRouteWithParams } from '@/server/http/handler';

export const dynamic = 'force-dynamic';

/**
 * Why Jarvis remembers this.
 *
 * Assembled from the record — the rule that decided the status, who confirmed it, what it
 * replaced, what it disagrees with, whether it is indexed — rather than narrated by a model. An
 * explanation a model wrote about its own memory would be the least trustworthy sentence on the
 * screen.
 */
export const GET = ownerRouteWithParams<{ id: string }>(async ({ services, params }) => {
  const explanation = await services.memoryService.explain(params.id);

  return json({
    memory: explanation.item,
    origin: {
      value: explanation.item.origin,
      label: KNOWLEDGE_ORIGIN_LABELS[explanation.item.origin],
      provenance: explanation.provenance,
    },
    authority: {
      authoritative: explanation.authoritative,
      reason: explanation.authorityReason,
    },
    decision: {
      rule: explanation.statusRule,
      by: explanation.decidedBy,
      at: explanation.decidedAt,
    },
    citation: explanation.citation,
    history: {
      supersedes: explanation.supersedes
        ? { id: explanation.supersedes.id, statement: explanation.supersedes.statement }
        : null,
      supersededBy: explanation.supersededBy
        ? { id: explanation.supersededBy.id, statement: explanation.supersededBy.statement }
        : null,
    },
    conflicts: explanation.openConflicts,
    usage: { count: explanation.useCount, lastUsedAt: explanation.lastUsedAt },
    index: { embedded: explanation.embedded },
  });
});
