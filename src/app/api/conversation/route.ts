import { z } from 'zod';
import { json, ownerRoute, parseBody } from '@/server/http/handler';

export const dynamic = 'force-dynamic';

/**
 * One message, whatever it turns out to be.
 *
 * ## Why this is not `/api/query`
 *
 * Because `/api/query` answers questions and creates nothing, and that is a property worth being
 * able to state without qualification. This endpoint can create a project, a repository and a
 * mission, so it is a different door with a different name. The alternative — a `create: true`
 * flag on the query endpoint — would make "answering a question never creates anything" a claim
 * about a parameter rather than about a route.
 *
 * ## The context, and why the browser sends it
 *
 * `context` is the snapshot the person was looking at when they started composing: the numbered
 * actions, and the proposal awaiting a yes. It comes from the browser because that is the only
 * place that knows what was actually on screen — a poll can change the server's answer between
 * the list being read and the reply being sent, and "the second one" has to mean the second thing
 * they read.
 *
 * That makes it owner-supplied input, and it is treated as such: it supplies the *subject* of a
 * follow-up, never the permission. Accepting a proposal re-interprets its own text through the
 * risk classifier, the mission service and the charter, exactly as though it had been typed. A
 * tampered context can therefore ask for nothing the owner could not have asked for directly.
 */
const contextSchema = z.object({
  actions: z
    .array(z.object({ id: z.string().min(1).max(200), label: z.string().min(1).max(400) }))
    .max(20)
    .default([]),
  proposal: z
    .object({ id: z.string().min(1).max(200), summary: z.string().min(1).max(600) })
    .nullish(),
  lastJarvisTurn: z.string().max(2000).nullish(),
  focusedProjectId: z.string().uuid().nullish(),
  awaitingAnswer: z.boolean().default(false),
});

const bodySchema = z.object({
  message: z.string().trim().min(1).max(4000),
  context: contextSchema.optional(),
});

export const POST = ownerRoute(async ({ services, session, request }) => {
  const body = await parseBody(request, bodySchema);
  const turn = await services.conversation.handle({
    message: body.message,
    ownerLogin: session.githubLogin ?? null,
    ...(body.context
      ? {
          context: {
            actions: body.context.actions,
            proposal: body.context.proposal ?? null,
            lastJarvisTurn: body.context.lastJarvisTurn ?? null,
            focusedProjectId: body.context.focusedProjectId ?? null,
            awaitingAnswer: body.context.awaitingAnswer,
          },
        }
      : {}),
  });
  return json(turn);
});
