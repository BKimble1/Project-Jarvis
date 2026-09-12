import {
  noSignals,
  type CalendarEntry,
  type MailHeadline,
  type PersonalSignals,
  type SignalSource,
  type SourceOutcome,
  type TaskEntry,
} from '@/domain/personal-signals';
import type { ConnectionRepository } from '@/server/repositories/connection-types';
import { GraphError, MicrosoftGraphClient } from '@/server/connections/microsoft-graph';
import type { MicrosoftAccess } from '@/server/connections/microsoft-access';

/**
 * One read of Blake's day, assembled from whichever sources answer.
 *
 * ## Why each source fails on its own
 *
 * Consent is per scope. Blake can grant mail and decline tasks on the same screen, and a tenant
 * policy can block one resource and not another. A reader that treats the account as a single
 * success or failure would report "Outlook unavailable" when in fact two of three worked — so each
 * source carries its own outcome, and the screen says which switch to flip.
 *
 * ## Why nothing here is written down
 *
 * The only thing this service persists is the delta cursor, and only in the mode that uses one. No
 * subject, sender, preview, appointment or task reaches the database: they are assembled for one
 * answer and dropped. That is not a policy note, it is the absence of a table.
 */

/** Which scope each source needs, so a missing grant is named rather than guessed at. */
export const SOURCE_SCOPES: Readonly<Record<SignalSource, string>> = {
  mail: 'Mail.Read',
  calendar: 'Calendars.Read',
  tasks: 'Tasks.Read',
};

/** Where the inbox delta cursor lives inside `provider_connections.delta_state`. */
export const INBOX_DELTA_KEY = 'inboxMessages';

export interface PersonalSignalsOptions {
  /** How many mail headlines to keep. */
  readonly mailLimit?: number;
  /** How far ahead to look on the calendar. */
  readonly calendarHours?: number;
  readonly taskLimit?: number;
  /**
   * `unread` answers "what is sitting in the inbox". `new-since-last` answers "what arrived since
   * you last asked" and advances the stored cursor, so it is the one a briefing uses.
   */
  readonly mailMode?: 'unread' | 'new-since-last';
}

export interface PersonalSignalsDeps {
  readonly access: MicrosoftAccess;
  readonly connections: ConnectionRepository;
  readonly clock?: () => Date;
  /** Overridden in tests to put a fake at the HTTP boundary rather than inside the client. */
  readonly clientFor?: (accessToken: () => Promise<string>) => MicrosoftGraphClient;
}

export class PersonalSignalsService {
  constructor(private readonly deps: PersonalSignalsDeps) {}

  private now(): Date {
    return this.deps.clock?.() ?? new Date();
  }

  async read(options: PersonalSignalsOptions = {}): Promise<PersonalSignals> {
    const now = this.now();
    if (!(await this.deps.access.isReady())) {
      return noSignals(now, { state: 'not_connected' });
    }

    const granted = new Set(await this.deps.access.grantedScopes());
    /*
     * An empty scope list means Microsoft did not tell us what it granted, not that it granted
     * nothing. Refusing to try in that case would turn a missing response field into a broken
     * connection, so the read goes ahead and a real 403 provides the answer instead.
     */
    const permits = (source: SignalSource): boolean =>
      granted.size === 0 || granted.has(SOURCE_SCOPES[source]);

    const client =
      this.deps.clientFor?.(() => this.deps.access.accessToken()) ??
      new MicrosoftGraphClient({
        accessToken: () => this.deps.access.accessToken(),
        ...(this.deps.clock ? { clock: this.deps.clock } : {}),
      });

    const outcomes: Record<SignalSource, SourceOutcome> = {
      mail: { state: 'not_permitted', scope: SOURCE_SCOPES.mail },
      calendar: { state: 'not_permitted', scope: SOURCE_SCOPES.calendar },
      tasks: { state: 'not_permitted', scope: SOURCE_SCOPES.tasks },
    };
    let mail: readonly MailHeadline[] = [];
    let calendar: readonly CalendarEntry[] = [];
    let tasks: readonly TaskEntry[] = [];

    /* Sequential rather than concurrent: three requests at once is three times the throttling. */
    if (permits('mail')) {
      const result = await this.attempt('mail', async () => {
        const limit = options.mailLimit ?? 10;
        if ((options.mailMode ?? 'unread') === 'unread') {
          return (await client.unreadInbox(limit)).items;
        }
        const stored = await this.deps.connections.find('microsoft');
        const cursor = stored?.deltaState[INBOX_DELTA_KEY] ?? null;
        const page = await client.inboxDelta(cursor, limit);
        /*
         * A read that ran to completion leaves a new cursor; one that hit the page limit leaves
         * none, and the old cursor is then dropped rather than kept. Keeping it would replay a
         * synchronization point Graph may already have expired, and the first thing that would do
         * is fail — a full read next time is slower and correct.
         */
        const deltaState = { ...(stored?.deltaState ?? {}) };
        if (page.deltaLink) deltaState[INBOX_DELTA_KEY] = page.deltaLink;
        else delete deltaState[INBOX_DELTA_KEY];
        await this.deps.connections.setDeltaState('microsoft', deltaState);
        return page.items.slice(0, limit);
      });
      outcomes.mail = result.outcome;
      mail = result.items ?? [];
    }

    if (permits('calendar')) {
      const result = await this.attempt('calendar', async () => {
        const hours = options.calendarHours ?? 24;
        const until = new Date(now.getTime() + hours * 60 * 60 * 1000);
        return (await client.calendarView(now, until, 20)).items;
      });
      outcomes.calendar = result.outcome;
      calendar = result.items ?? [];
    }

    if (permits('tasks')) {
      const result = await this.attempt('tasks', async () => {
        return (await client.openTasks(options.taskLimit ?? 15)).items;
      });
      outcomes.tasks = result.outcome;
      tasks = result.items ?? [];
    }

    await this.recordOutcome(outcomes, now);
    return { collectedAt: now, mail, calendar, tasks, outcomes };
  }

  /** Run one source's read, turning any failure into an outcome instead of an exception. */
  private async attempt<T>(
    source: SignalSource,
    run: () => Promise<readonly T[]>,
  ): Promise<{ outcome: SourceOutcome; items: readonly T[] | null }> {
    try {
      const items = await run();
      return { outcome: { state: 'ok', count: items.length }, items };
    } catch (error) {
      if (error instanceof GraphError && error.kind === 'permission') {
        return {
          outcome: { state: 'not_permitted', scope: SOURCE_SCOPES[source] },
          items: null,
        };
      }
      return { outcome: { state: 'failed', reason: reasonFor(error) }, items: null };
    }
  }

  /**
   * Move the connection's own status to match what just happened.
   *
   * A read where nothing succeeded is the definition of degraded; a read where anything succeeded
   * is a working connection, even if one scope is missing — a permission Blake chose not to grant
   * is not a fault, and marking it as one would put a red badge on a deliberate decision.
   */
  private async recordOutcome(
    outcomes: Readonly<Record<SignalSource, SourceOutcome>>,
    now: Date,
  ): Promise<void> {
    const values = Object.values(outcomes);
    const anyOk = values.some((outcome) => outcome.state === 'ok');
    const failures = values.filter(
      (outcome): outcome is { state: 'failed'; reason: string } => outcome.state === 'failed',
    );

    if (anyOk) {
      await this.deps.connections.markSynced('microsoft', now);
      return;
    }
    const first = failures[0];
    if (first) {
      await this.deps.connections.markFailed({
        provider: 'microsoft',
        status: 'degraded',
        message: first.reason,
        at: now,
      });
    }
  }
}

/**
 * A failure reason safe to store and show.
 *
 * `GraphError` messages are written without provider payloads for exactly this; anything else is
 * replaced rather than stringified, because an arbitrary thrown value is the one that might carry
 * a URL with a token in it.
 */
function reasonFor(error: unknown): string {
  if (error instanceof GraphError) return error.message;
  return 'Jarvis could not complete the request.';
}
