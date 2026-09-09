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
  const [events, notices] = await Promise.all([
    services.operating.unspoken(20),
    services.notifications.unspoken(20),
  ]);
  return json({ events: [...events, ...notices.map(asSpeakable)] });
});

/**
 * A notification, in the shape the narrator already speaks.
 *
 * ## Why reminders come through here rather than through a stream of their own
 *
 * Because the guarantee is the hard part, not the plumbing. "Said once, and never replayed after a
 * refresh" needs a server-side claim on a watermark column, and that mechanism already exists and
 * is already proven for an idea's progress. A second narration channel would be a second copy of
 * it, and the copy is where the bug would live — most likely as a briefing read out again every
 * time the dashboard loads.
 *
 * So a reminder is spoken by the same loop, from the same call, under the same claim. What the
 * page receives is one ordered list of things to say; where each came from is not its concern.
 */
function asSpeakable(notice: {
  id: string;
  title: string;
  body: string | null;
  createdAt: string;
}): {
  id: string;
  kind: 'progress';
  message: string;
  createdAt: string;
  proposalId: null;
} {
  return {
    id: notice.id,
    kind: 'progress',
    /* Title and body, joined exactly as they are shown. Spoken and seen must not drift. */
    message: notice.body ? `${notice.title}. ${notice.body}` : notice.title,
    createdAt: notice.createdAt,
    proposalId: null,
  };
}

/**
 * POST — claim the next few and speak them.
 *
 * The response contains only what this caller won. An empty array means another tab got there
 * first, which is the correct outcome and not an error.
 */
export const POST = ownerRoute(async ({ services, request }) => {
  const { limit } = await parseBody(request, claimSchema);
  const now = new Date();

  const [pending, notices] = await Promise.all([
    services.operating.unspoken(limit),
    services.notifications.unspoken(limit),
  ]);
  if (pending.length === 0 && notices.length === 0) return json({ events: [] });

  /*
   * Claimed independently, because they are two tables and a partial failure must not lose a
   * sentence. Each side hands back only what it won, and anything the other tab took is simply
   * absent — which is the correct outcome, not an error.
   */
  const [wonEvents, wonNotices] = await Promise.all([
    pending.length > 0
      ? services.operating.markSpoken(
          pending.map((event) => event.id),
          now,
        )
      : Promise.resolve([]),
    notices.length > 0
      ? services.notifications.markSpoken(
          notices.map((notice) => notice.id),
          now,
        )
      : Promise.resolve([]),
  ]);

  const claimedEvents = new Set(wonEvents);
  const claimedNotices = new Set(wonNotices);
  return json({
    events: [
      ...pending.filter((event) => claimedEvents.has(event.id)),
      ...notices.filter((notice) => claimedNotices.has(notice.id)).map(asSpeakable),
    ],
  });
});
