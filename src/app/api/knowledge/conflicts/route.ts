import { CONFLICT_KIND_LABELS } from '@/domain/knowledge';
import { json, ownerRoute } from '@/server/http/handler';

export const dynamic = 'force-dynamic';

/** Open questions about statements that disagree. Neither side has been altered by detection. */
export const GET = ownerRoute(async ({ services }) => {
  const conflicts = await services.conflicts.list('open');

  const withSides = await Promise.all(
    conflicts.map(async (conflict) => {
      const [left, right] = await Promise.all([
        services.knowledge.findById(conflict.leftId),
        conflict.rightId ? services.knowledge.findById(conflict.rightId) : Promise.resolve(null),
      ]);
      return {
        id: conflict.id,
        kind: conflict.kind,
        kindLabel: CONFLICT_KIND_LABELS[conflict.kind],
        summary: conflict.summary,
        detectedRule: conflict.detectedRule,
        projectId: conflict.projectId,
        createdAt: conflict.createdAt,
        left: left
          ? { id: left.id, statement: left.statement, origin: left.origin, status: left.status }
          : null,
        right: right
          ? { id: right.id, statement: right.statement, origin: right.origin, status: right.status }
          : null,
      };
    }),
  );

  return json({ conflicts: withSides });
});
