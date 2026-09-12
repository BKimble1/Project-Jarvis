import { releaseApprovalSchema } from '@/domain/ci-dispatch';
import { json, ownerRoute, parseBody } from '@/server/http/handler';

export const dynamic = 'force-dynamic';

/**
 * Approve a TestFlight build for one exact commit.
 *
 * The schema requires the owner to type `upload to testflight`: a build that leaves the machine
 * and reaches other people's devices should not be one click away from a build that does not.
 * The approval is bound to repository + workflow + ref + commit + inputs, so a change to any of
 * them makes it stop applying rather than silently authorising something else.
 */
export const POST = ownerRoute(async ({ services, session, request }) => {
  const input = await parseBody(request, releaseApprovalSchema);
  const approval = await services.ci.approveRelease(input, session.githubLogin ?? session.id);
  return json({ approval }, { status: 201 });
});
