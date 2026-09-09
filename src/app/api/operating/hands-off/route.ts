import { z } from 'zod';
import { handsOffStatus, setHandsOff } from '@/server/ops/hands-off';
import { json, ownerRoute, parseBody } from '@/server/http/handler';

export const dynamic = 'force-dynamic';

/**
 * The Hands-off switch.
 *
 * One boolean, because that is what the owner is deciding. The two records it writes are the
 * concern of `setHandsOff`, and an interface that had to know about both would eventually set one.
 */

const bodySchema = z.object({
  on: z.boolean(),
  reason: z.string().trim().max(200).optional(),
});

export const GET = ownerRoute(async ({ services }) => json(await handsOffStatus(services)));

export const PUT = ownerRoute(async ({ services, session, request }) => {
  const input = await parseBody(request, bodySchema);
  const status = await setHandsOff(services, {
    on: input.on,
    /* The audit records a person, not a session. `owner` is the fallback for a session with no
     * GitHub login, which happens on a local install that was never connected to GitHub. */
    changedBy: session.githubLogin ?? session.displayName ?? 'owner',
    ...(input.reason ? { reason: input.reason } : {}),
  });
  return json(status);
});
