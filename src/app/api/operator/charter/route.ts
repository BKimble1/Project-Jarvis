import { z } from 'zod';
import { charterContentSchema } from '@/domain/charter';
import { json, ownerRoute, parseBody } from '@/server/http/handler';

export const dynamic = 'force-dynamic';

const draftSchema = z.object({
  content: charterContentSchema,
  note: z.string().trim().max(600).nullish(),
});

/**
 * Write a new charter version.
 *
 * A draft, always. There is deliberately no "write and activate" shape: activation is a second,
 * separate owner action, so that reviewing what a charter says and putting it in force are two
 * decisions rather than one accidental one.
 *
 * This is an owner route and there is no other kind. Nothing a model produces reaches this
 * handler — the model cannot edit the charter, expand it, or grant itself anything, and the
 * enforcement of that is the absence of a code path rather than a check inside one.
 */
export const POST = ownerRoute(async ({ services, session, request }) => {
  const input = await parseBody(request, draftSchema);
  const charter = await services.charterService.draft({
    content: input.content,
    authoredBy: session.githubLogin ?? 'owner',
    note: input.note ?? null,
  });
  return json(
    {
      charter: {
        id: charter.id,
        version: charter.version,
        digest: charter.digest,
        createdAt: charter.createdAt,
      },
      /* Said plainly, because the difference between drafted and in force is the whole point. */
      inForce: false,
      message: `Charter version ${charter.version} is saved. It authorises nothing until you activate it.`,
    },
    { status: 201 },
  );
});
