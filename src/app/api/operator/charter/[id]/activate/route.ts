import { json, ownerRouteWithParams } from '@/server/http/handler';

export const dynamic = 'force-dynamic';

/**
 * Put a charter version in force.
 *
 * Activation does not change the mode. Writing a document must not switch Jarvis on, so the owner
 * activates and then chooses a mode, and both are separate entries in the audit trail.
 */
export const POST = ownerRouteWithParams<{ id: string }>(async ({ services, session, params }) => {
  const charter = await services.charterService.activate(params.id, session.githubLogin ?? 'owner');
  return json({
    charter: {
      id: charter.id,
      version: charter.version,
      digest: charter.digest,
      activatedAt: charter.activatedAt,
      activatedBy: charter.activatedBy,
    },
    inForce: true,
    message: `Charter version ${charter.version} is now in force.`,
  });
});
