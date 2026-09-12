import { conflictResolutionSchema } from '@/domain/knowledge';
import { json, ownerRouteWithParams, parseBody } from '@/server/http/handler';

export const dynamic = 'force-dynamic';

/**
 * Answer a conflict.
 *
 * `keep_both` is a first-class answer rather than a way of postponing: two statements can be true
 * in different circumstances, and forcing a winner would lose that distinction. Nothing is
 * deleted by any resolution — the losing side is retired, and its words remain readable.
 */
export const POST = ownerRouteWithParams<{ id: string }>(
  async ({ services, params, request, session }) => {
    const body = await parseBody(request, conflictResolutionSchema);
    const conflict = await services.memoryService.resolveConflict(params.id, body, {
      actor: session.githubLogin ?? session.id,
      actorKind: 'owner',
    });
    return json({ conflict });
  },
);
