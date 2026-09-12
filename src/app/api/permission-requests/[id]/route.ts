import { permissionDecisionSchema } from '@/domain/mission-run';
import { json, ownerRouteWithParams, parseBody } from '@/server/http/handler';

export const dynamic = 'force-dynamic';

/**
 * Decide one permission request.
 *
 * The decision is bound to this request's id, and through it to the run's `requestKey`. There is
 * deliberately no "always allow" endpoint: approving once approves once.
 */
export const POST = ownerRouteWithParams<{ id: string }>(
  async ({ services, session, request, params }) => {
    const input = await parseBody(request, permissionDecisionSchema);
    const decided = await services.missions.decidePermission(
      params.id,
      input,
      session.githubLogin ?? session.id,
    );
    return json({ request: decided });
  },
);
