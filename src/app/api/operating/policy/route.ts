import { z } from 'zod';
import {
  APPROVAL_CATEGORIES,
  APPROVAL_CATEGORY_INFO,
  APPROVAL_POLICY_KEY,
  parseApprovalPolicy,
} from '@/domain/approval-policy';
import { json, ownerRoute, parseBody } from '@/server/http/handler';

export const dynamic = 'force-dynamic';

/**
 * What Jarvis may do without asking, and the control that changes it.
 *
 * The catalogue travels with the policy on purpose. A screen that lists eight switches has to say
 * what each one permits at the moment of flipping it, and a copy of those sentences maintained in
 * the interface would be a second source of truth for the one thing that must not drift: what the
 * owner believed he was agreeing to.
 */

const bodySchema = z.object({
  preAuthorised: z.array(z.enum(APPROVAL_CATEGORIES)).max(APPROVAL_CATEGORIES.length),
  autoApproveRoutinePlans: z.boolean(),
});

export const GET = ownerRoute(async ({ services }) => {
  const policy = parseApprovalPolicy(await services.settings.get(APPROVAL_POLICY_KEY));
  return json({
    policy,
    categories: APPROVAL_CATEGORIES.map((category) => ({
      id: category,
      ...APPROVAL_CATEGORY_INFO[category],
      preAuthorised: policy.preAuthorised.includes(category),
    })),
  });
});

/**
 * Replace the policy.
 *
 * The whole policy, not a patch. Toggling one switch by sending one field would make the stored
 * value depend on what the browser happened to know, and the owner should be able to read back
 * exactly what he last sent.
 */
export const PUT = ownerRoute(async ({ services, request }) => {
  const input = await parseBody(request, bodySchema);
  /* Parsed on the way in as well as on the way out, so a stored policy is never wider than this. */
  const policy = parseApprovalPolicy(input);
  await services.settings.set(APPROVAL_POLICY_KEY, policy);
  return json({ policy });
});
