/**
 * What a morning briefing is allowed to contain, and in what order.
 *
 * ## Why the shape is a domain concern
 *
 * Because the temptation a briefing creates is enormous. A person opening one wants to be told
 * what is going on, and the most satisfying thing a system can do is tell them — whether or not it
 * knows. Every field here is therefore tied to a source that either exists or does not, and the
 * absence of a source produces a sentence rather than a gap, so nothing can be quietly filled in
 * by a fluent paragraph.
 *
 * ## The order
 *
 * What happened, then what needs you, then where things stand, then what Jarvis will do next. A
 * briefing that opens with a plan is a briefing that has not yet earned the reader's attention;
 * one that opens with what changed while they were asleep has.
 *
 * ## What is deliberately not here
 *
 * A "good morning, here is your day" section. Jarvis has no calendar, no mail and no analytics,
 * and until it does, saying anything about a day would be invention dressed as service.
 * `notConnected` is the sentence that says so, once, in one line.
 */

export interface BriefingLine {
  /** One sentence. Already redacted and bounded by whoever assembled it. */
  readonly text: string;
  /** Where a reader goes to check it. Always internal, never external. */
  readonly href: string | null;
}

export interface MorningBriefing {
  /** "Morning" / "Afternoon" / "Evening", from the hour it was assembled. */
  readonly greeting: string;
  /** The one sentence to read if nothing else is read. From the operating picture. */
  readonly headline: string;
  /** What happened while nobody was looking. Empty means nothing did, and says so. */
  readonly overnight: readonly BriefingLine[];
  /** What is waiting for the owner, in the order it is worth doing. */
  readonly needsYou: readonly BriefingLine[];
  /** Where each project stands, from the deterministic engine. */
  readonly projects: readonly BriefingLine[];
  /** What Jarvis will do next if left alone. */
  readonly next: string;
  /**
   * One line naming what Jarvis cannot see.
   *
   * Null only when everything is connected, which today is never. This is the sentence that keeps
   * a briefing from becoming a plausible account of a day it knows nothing about.
   */
  readonly notConnected: string | null;
  readonly at: string;
}

/** Time of day, in the words a person would use. Local hour, from the caller. */
export function greetingFor(hourLocal: number): string {
  if (hourLocal < 5) return 'Late';
  if (hourLocal < 12) return 'Morning';
  if (hourLocal < 18) return 'Afternoon';
  return 'Evening';
}

/**
 * The window a briefing covers.
 *
 * From the last briefing when there was one, and otherwise from twelve hours ago rather than from
 * the beginning of time. A first briefing that recited three weeks of history would be unreadable,
 * and a reader who skipped one should get the gap covered rather than a fresh twelve hours — which
 * is why this takes the previous briefing's time rather than always subtracting.
 */
export function briefingWindow(input: {
  readonly now: Date;
  readonly lastBriefingAt: string | null;
  readonly maxHours?: number;
}): { readonly since: Date; readonly firstEver: boolean } {
  const maxHours = input.maxHours ?? 72;
  const floor = new Date(input.now.getTime() - maxHours * 3_600_000);
  if (!input.lastBriefingAt) {
    return { since: new Date(input.now.getTime() - 12 * 3_600_000), firstEver: true };
  }
  const last = new Date(input.lastBriefingAt);
  if (Number.isNaN(last.getTime())) {
    return { since: new Date(input.now.getTime() - 12 * 3_600_000), firstEver: true };
  }
  /* Never further back than the ceiling: a fortnight away should not produce a fortnight's log. */
  return { since: last < floor ? floor : last, firstEver: false };
}

/**
 * How the overnight section reads when nothing happened.
 *
 * A sentence rather than an empty list, because emptiness is ambiguous — it reads equally as "we
 * had a quiet night" and as "the briefing is broken". Naming the window is what makes it the
 * first.
 */
export function quietLine(since: Date, now: Date): string {
  const hours = Math.max(1, Math.round((now.getTime() - since.getTime()) / 3_600_000));
  return `Nothing finished in the last ${hours} hour${hours === 1 ? '' : 's'}.`;
}
