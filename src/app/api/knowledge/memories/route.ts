import { z } from 'zod';
import {
  KNOWLEDGE_CATEGORY_LABELS,
  KNOWLEDGE_ORIGIN_LABELS,
  KNOWLEDGE_STATUSES,
  KNOWLEDGE_STATUS_LABELS,
  ORIGIN_PROVENANCE,
  knowledgeCreateSchema,
} from '@/domain/knowledge';
import { json, ownerRoute, parseBody } from '@/server/http/handler';

export const dynamic = 'force-dynamic';

const listQuery = z.object({
  status: z.enum(KNOWLEDGE_STATUSES).optional(),
  projectId: z.string().uuid().optional(),
});

/**
 * What Jarvis remembers, and what it has merely suggested.
 *
 * Suggestions are returned alongside memories rather than on a separate screen, because the whole
 * point of the distinction is that it should be visible in one glance — a review queue nobody
 * opens is a review queue that eventually gets approved in bulk.
 *
 * A forgotten item appears with its placeholder and its date. The row is the record that a
 * deletion happened; the sentence is gone.
 */
export const GET = ownerRoute(async ({ services, request }) => {
  const url = new URL(request.url);
  const parsed = listQuery.safeParse({
    ...(url.searchParams.get('status') ? { status: url.searchParams.get('status') } : {}),
    ...(url.searchParams.get('projectId') ? { projectId: url.searchParams.get('projectId') } : {}),
  });

  const items = await services.knowledge.list({
    ...(parsed.success && parsed.data.status ? { statuses: [parsed.data.status] } : {}),
    ...(parsed.success && parsed.data.projectId ? { projectId: parsed.data.projectId } : {}),
    limit: 200,
  });

  const counts = await services.knowledge.countsByStatus();

  return json({
    counts,
    memories: items.map((item) => ({
      id: item.id,
      scope: item.scope,
      category: item.category,
      categoryLabel: KNOWLEDGE_CATEGORY_LABELS[item.category],
      origin: item.origin,
      originLabel: KNOWLEDGE_ORIGIN_LABELS[item.origin],
      provenance: ORIGIN_PROVENANCE[item.origin],
      status: item.status,
      statusLabel: KNOWLEDGE_STATUS_LABELS[item.status],
      statusRule: item.statusRule,
      sensitivity: item.sensitivity,
      statement: item.statement,
      detail: item.detail,
      projectId: item.projectId,
      missionId: item.missionId,
      sourceId: item.sourceId,
      sourceRef: item.sourceRef,
      tags: item.tags,
      confidence: item.confidence,
      createdBy: item.createdBy,
      createdAt: item.createdAt,
      confirmedAt: item.confirmedAt,
      confirmedBy: item.confirmedBy,
      reviewAt: item.reviewAt,
      expiresAt: item.expiresAt,
      forgottenAt: item.forgottenAt,
      supersedesId: item.supersedesId,
      supersededById: item.supersededById,
      useCount: item.useCount,
      lastUsedAt: item.lastUsedAt,
    })),
  });
});

/**
 * Record something.
 *
 * There is no `origin` field in the schema and no way to supply one. This route always produces
 * an `explicit` memory attributed to the signed-in owner, so nothing can use it to write a note
 * that later reads as though I had typed it.
 */
export const POST = ownerRoute(async ({ services, request, session }) => {
  const body = await parseBody(request, knowledgeCreateSchema);
  const actor = session.githubLogin ?? session.id;

  const outcome = await services.memoryService.remember(body, {
    actor,
    actorKind: 'owner',
  });

  return json(
    {
      memory: outcome.item,
      rule: outcome.rule,
      reason: outcome.reason,
      conflicts: outcome.conflicts,
    },
    { status: 201 },
  );
});
