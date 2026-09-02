import { planApprovalSchema } from '@/domain/mission-plan';
import { json, ownerRouteWithParams, parseBody } from '@/server/http/handler';

export const dynamic = 'force-dynamic';

/**
 * Approve one plan version and queue the mission.
 *
 * Owner-authenticated and same-origin checked by `ownerRouteWithParams`; the version and the
 * acknowledged risk level are re-checked against the database by the service, so a stale browser
 * tab cannot approve something the owner never read.
 */
export const POST = ownerRouteWithParams<{ id: string }>(
  async ({ services, session, request, params }) => {
    const input = await parseBody(request, planApprovalSchema);
    const mission = await services.missions.approvePlan(
      params.id,
      input,
      session.githubLogin ?? session.id,
    );
    return json({ mission });
  },
);
