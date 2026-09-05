import { taskGraphApprovalSchema } from '@/domain/task-graph';
import { json, ownerRouteWithParams, parseBody } from '@/server/http/handler';

export const dynamic = 'force-dynamic';

/**
 * Approve a task-graph version.
 *
 * The fingerprint the owner was shown is echoed back and compared, so a graph that changed
 * between being rendered and being approved cannot inherit the approval — the same rule plan
 * approval already has.
 */
export const POST = ownerRouteWithParams<{ id: string }>(
  async ({ services, session, request, params }) => {
    const input = await parseBody(request, taskGraphApprovalSchema);
    const view = await services.orchestrator.approveGraph(
      params.id,
      input,
      session.githubLogin ?? session.id,
    );
    return json({ graph: view });
  },
);
