/**
 * What Jarvis can see of Blake's day once Outlook is connected.
 *
 * ## Why there is no body here
 *
 * A mail headline carries a subject, a sender, a time and a bounded preview. It does not carry the
 * message body and it does not carry attachments, because Jarvis never asks Microsoft for them —
 * the field list sent to Graph omits both, so there is no code path that could decide to keep one.
 * The preview is what Graph itself returns as `bodyPreview`, trimmed again here; it exists so a
 * morning summary can say what a message is about without opening it.
 *
 * ## Why none of this is stored
 *
 * These objects are built for one answer and then discarded. Nothing in this file is written to
 * the database: what persists is the delta link, which is an opaque resumption token that is
 * useless without a valid access token. That is the whole retention policy, and it is enforced by
 * there being no table to write to rather than by a rule somebody has to remember.
 */

/** How much of Graph's own preview is kept. Graph returns roughly 255 characters; this trims it. */
export const MAIL_PREVIEW_LIMIT = 200;

export type Importance = 'low' | 'normal' | 'high';

export interface MailHeadline {
  readonly id: string;
  readonly subject: string;
  readonly from: string;
  readonly fromAddress: string | null;
  readonly receivedAt: Date;
  readonly isRead: boolean;
  readonly hasAttachments: boolean;
  readonly importance: Importance;
  /** Bounded. Never the full body — see the note at the top of this file. */
  readonly preview: string;
  readonly webLink: string | null;
}

export interface CalendarEntry {
  readonly id: string;
  readonly subject: string;
  readonly startAt: Date;
  readonly endAt: Date;
  readonly isAllDay: boolean;
  readonly location: string | null;
  readonly organizer: string | null;
  readonly isOnline: boolean;
  readonly webLink: string | null;
}

export interface TaskEntry {
  readonly id: string;
  readonly title: string;
  readonly listName: string;
  readonly dueAt: Date | null;
  readonly importance: Importance;
  readonly overdue: boolean;
}

export const SIGNAL_SOURCES = ['mail', 'calendar', 'tasks'] as const;
export type SignalSource = (typeof SIGNAL_SOURCES)[number];

export const SIGNAL_SOURCE_LABELS: Readonly<Record<SignalSource, string>> = {
  mail: 'Outlook mail',
  calendar: 'Outlook calendar',
  tasks: 'Microsoft To Do',
};

/** What a count of each source is a count *of*, so the line reads as a sentence. */
const SIGNAL_SOURCE_NOUNS: Readonly<Record<SignalSource, string>> = {
  mail: 'unread',
  calendar: 'in the next day',
  tasks: 'still open',
};

/**
 * How one source turned out.
 *
 * Kept per source rather than for the whole read, because a calendar that answers and a task list
 * that does not is the ordinary case — a scope Blake declined on the consent screen fails exactly
 * one of these. Collapsing them into a single success flag would throw away the only information
 * that tells him which switch to flip.
 */
export type SourceOutcome =
  | { readonly state: 'ok'; readonly count: number }
  | { readonly state: 'not_connected' }
  | { readonly state: 'not_permitted'; readonly scope: string }
  | { readonly state: 'failed'; readonly reason: string };

export interface PersonalSignals {
  readonly collectedAt: Date;
  readonly mail: readonly MailHeadline[];
  readonly calendar: readonly CalendarEntry[];
  readonly tasks: readonly TaskEntry[];
  readonly outcomes: Readonly<Record<SignalSource, SourceOutcome>>;
}

/** An empty read, with every source explaining itself the same way. */
export function noSignals(collectedAt: Date, outcome: SourceOutcome): PersonalSignals {
  return {
    collectedAt,
    mail: [],
    calendar: [],
    tasks: [],
    outcomes: { mail: outcome, calendar: outcome, tasks: outcome },
  };
}

/** One line per source, in the words the screen and a spoken briefing both use. */
export function describeOutcome(source: SignalSource, outcome: SourceOutcome): string {
  const label = SIGNAL_SOURCE_LABELS[source];
  switch (outcome.state) {
    case 'ok':
      return outcome.count === 0
        ? `${label}: nothing to report.`
        : `${label}: ${outcome.count} ${SIGNAL_SOURCE_NOUNS[source]}.`;
    case 'not_connected':
      return `${label}: not connected yet.`;
    case 'not_permitted':
      return `${label}: the ${outcome.scope} permission was not granted, so Jarvis cannot read it.`;
    case 'failed':
      return `${label}: could not be read — ${outcome.reason}`;
  }
}
