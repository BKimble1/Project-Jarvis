import { z } from 'zod';
import { json, ownerRoute, parseBody } from '@/server/http/handler';

export const dynamic = 'force-dynamic';

/**
 * What Jarvis has to say that it has not said yet.
 *
 * ## Why claiming happens on the server
 *
 * Because "speak each event once" cannot be decided in a browser. Two tabs are two browsers as far
 * as this is concerned, and a refresh is a third with no memory of the first two. Anything the page
 * remembers — a set of spoken ids, a high-water mark in local storage — is per-tab and is lost by
 * exactly the event the requirement is about: the reload.
 *
 * So the page does not decide. It asks for what is unspoken, and the server hands back only the
 * rows whose `spoken_at` this request actually won. A second tab asking a moment later is handed
 * nothing, because the update is conditional on the column still being null. The page speaks what
 * it was given and never has to ask whether it already did.
 *
 * ## Why reading and claiming are one call
 *
 * A read followed by a separate claim is a race with a refresh in the middle: the tab reads three
 * sentences, the owner reloads, and either they are spoken twice or not at all depending on which
 * half ran. One call that returns only what it claimed cannot lose or repeat a sentence that way.
 */

const claimSchema = z.object({
  /**
   * How many to take. Bounded, because a machine that has been running unattended overnight may
   * have a great deal to say and a browser that starts by reciting forty sentences is not a
   * briefing — it is an obstacle.
   */
  limit: z.number().int().min(1).max(10).default(5),
});

/**
 * GET — what is waiting, without claiming any of it.
 *
 * For a screen that wants to show the words whether or not it is going to speak them: read-aloud
 * off, muted, or a transcript being caught up after a reload. Nothing here changes `spoken_at`.
 */
export const GET = ownerRoute(async ({ services }) => {
  const pending = await services.operating.unspoken(20);
  return json({ events: pending });
});

/**
 * POST — claim the next few and speak them.
 *
 * The response contains only what this caller won. An empty array means another tab got there
 * first, which is the correct outcome and not an error.
 */
export const POST = ownerRoute(async ({ services, request }) => {
  const { limit } = await parseBody(request, claimSchema);
  const pending = await services.operating.unspoken(limit);
  if (pending.length === 0) return json({ events: [] });

  const won = await services.operating.markSpoken(
    pending.map((event) => event.id),
    new Date(),
  );
  const claimed = new Set(won);
  return json({ events: pending.filter((event) => claimed.has(event.id)) });
});
