import { z } from 'zod';
import { JarvisError } from '@/domain/errors';
import {
  MAIL_PREVIEW_LIMIT,
  type CalendarEntry,
  type Importance,
  type MailHeadline,
  type TaskEntry,
} from '@/domain/personal-signals';

/**
 * The read side of Microsoft Graph.
 *
 * ## What this asks for, and what it deliberately does not
 *
 * Every collection request carries an explicit `$select`. That is not a bandwidth optimisation: it
 * is the retention policy expressed as a request. `body`, `uniqueBody` and `attachments` are absent
 * from the message field list, so a full email is never in this process's memory to begin with, and
 * no later change to a storage layer can start keeping one by accident. `bodyPreview` — documented
 * as the first 255 characters of the message in plain text — is included and trimmed again here,
 * because a triage line needs to say what a message is about and needs nothing more than that.
 *
 * ## Bounded on purpose
 *
 * Each call takes a page size and stops after at most `MAX_PAGES`. Graph will happily paginate
 * through a decade of mail; a morning briefing has no use for that, and an unbounded
 * follow-of-nextLink is how a background reader turns into a throttled account. When a page limit
 * truncates a read, the caller is told rather than handed a short list that looks complete.
 *
 * ## Throttling
 *
 * `Retry-After` is the only header Microsoft documents on a Graph 429, so it is the only one read
 * here; 503 and 504 are treated the same way, and everything else in the 4xx range is final.
 * Retrying a 403 for a scope Blake did not grant only spends his quota to get the same answer.
 *
 * ## Endpoint shapes, and what has not been proved
 *
 * Paths, query options and permissions are taken from the Microsoft Graph v1.0 reference. Nothing
 * here has been exercised against a live tenant from this environment: the tests drive it with
 * fakes at the HTTP boundary, which proves the request Jarvis composes and its reading of a
 * documented response shape, and does not prove that Microsoft answers it. See
 * docs/PERSONAL_ASSISTANT_SETUP.md, which says the same thing to Blake.
 */

export const GRAPH_BASE_URL = 'https://graph.microsoft.com/v1.0';

/**
 * The fields asked of a message.
 *
 * `body`, `uniqueBody` and `attachments` are not here, and must not be added without a decision
 * about retention written down somewhere Blake can read it.
 */
export const MESSAGE_FIELDS = [
  'id',
  'subject',
  'from',
  'receivedDateTime',
  'isRead',
  'hasAttachments',
  'importance',
  'bodyPreview',
  'webLink',
] as const;

export const EVENT_FIELDS = [
  'id',
  'subject',
  'start',
  'end',
  'isAllDay',
  'location',
  'organizer',
  'isOnlineMeeting',
  'webLink',
] as const;

/** At most this many pages are followed for one logical read. */
export const MAX_PAGES = 10;
/** How many To Do lists are read before the reader stops and says it stopped. */
export const MAX_TASK_LISTS = 10;

/** At most this many attempts per HTTP request, including the first. */
export const MAX_ATTEMPTS = 3;
/** However long Microsoft asks us to wait, we wait no longer than this before giving up. */
export const MAX_RETRY_DELAY_MS = 20_000;
/**
 * How far back a first delta synchronization reaches.
 *
 * A delta call with no stored cursor returns the whole folder, and the resumption link only
 * arrives after the last page. On a mailbox with years in it, a page-bounded reader would never
 * reach that last page and would therefore resynchronize from scratch forever. `receivedDateTime
 * ge` is one of the two filters message delta documents, and it turns an unbounded first read into
 * a week of mail.
 */
export const DELTA_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;

export type GraphErrorKind =
  'auth' | 'permission' | 'throttled' | 'unavailable' | 'resync' | 'request';

/**
 * A Graph failure, carrying the status and nothing from the body.
 *
 * Graph error payloads echo request context, and the request context here includes a bearer token
 * in a header and, on a delta call, a resumption token in the URL. Keeping the body out of the
 * message is what stops either from reaching a log line written by a well-meaning error handler.
 */
export class GraphError extends JarvisError {
  readonly kind: GraphErrorKind;
  readonly status: number;

  constructor(kind: GraphErrorKind, status: number, message: string) {
    super(
      kind === 'auth'
        ? 'unauthorized'
        : kind === 'permission'
          ? 'forbidden'
          : kind === 'throttled'
            ? 'rate_limited'
            : 'upstream_unavailable',
      message,
      { retryable: kind === 'throttled' || kind === 'unavailable' || kind === 'resync' },
    );
    this.name = 'GraphError';
    this.kind = kind;
    this.status = status;
  }
}

export type GraphFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface GraphClientDeps {
  /** Produces a usable bearer token, refreshing it first if that is what it takes. */
  readonly accessToken: () => Promise<string>;
  readonly fetchImpl?: GraphFetch;
  readonly baseUrl?: string;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly clock?: () => Date;
}

export interface Page<T> {
  readonly items: readonly T[];
  /** Set when the page limit stopped the read before Graph ran out of results. */
  readonly truncated: boolean;
  /** Present only on a delta read that ran to completion. */
  readonly deltaLink: string | null;
}

const emailAddressSchema = z.object({
  name: z.string().nullish(),
  address: z.string().nullish(),
});

const recipientSchema = z.object({ emailAddress: emailAddressSchema.nullish() }).nullish();

const importanceSchema = z
  .enum(['low', 'normal', 'high'])
  .nullish()
  .transform((value): Importance => value ?? 'normal');

const messageSchema = z.object({
  id: z.string(),
  subject: z.string().nullish(),
  from: recipientSchema,
  receivedDateTime: z.string().nullish(),
  isRead: z.boolean().nullish(),
  hasAttachments: z.boolean().nullish(),
  importance: importanceSchema,
  bodyPreview: z.string().nullish(),
  webLink: z.string().nullish(),
});

/**
 * Graph's date-and-timezone pair.
 *
 * `dateTime` carries no offset — the zone is in the sibling field — so the two have to be read
 * together. Event reads leave the times in UTC, which is what Graph documents as the default when
 * no timezone preference is sent, and the parser checks rather than assumes: a response that came
 * back in another zone would otherwise shift every appointment by that offset with nothing
 * looking wrong.
 */
const dateTimeZoneSchema = z.object({
  dateTime: z.string(),
  timeZone: z.string().nullish(),
});

const eventSchema = z.object({
  id: z.string(),
  subject: z.string().nullish(),
  start: dateTimeZoneSchema,
  end: dateTimeZoneSchema,
  isAllDay: z.boolean().nullish(),
  location: z.object({ displayName: z.string().nullish() }).nullish(),
  organizer: recipientSchema,
  isOnlineMeeting: z.boolean().nullish(),
  webLink: z.string().nullish(),
});

const todoListSchema = z.object({
  id: z.string(),
  displayName: z.string().nullish(),
});

const todoTaskSchema = z.object({
  id: z.string(),
  title: z.string().nullish(),
  status: z.string().nullish(),
  importance: importanceSchema,
  dueDateTime: dateTimeZoneSchema.nullish(),
});

const collectionSchema = z.object({
  value: z.array(z.unknown()).nullish(),
  '@odata.nextLink': z.string().nullish(),
  '@odata.deltaLink': z.string().nullish(),
});

function trimPreview(value: string | null | undefined): string {
  const text = (value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > MAIL_PREVIEW_LIMIT ? `${text.slice(0, MAIL_PREVIEW_LIMIT - 1)}…` : text;
}

/**
 * Turn Graph's split date and zone into an instant.
 *
 * Only UTC is accepted, because only UTC is expected. Anything else means an assumption in this
 * file has stopped holding, and guessing an offset would be worse than saying the value cannot be
 * read: a meeting an hour out of place is a meeting missed, silently.
 */
function readDateTime(value: { dateTime: string; timeZone?: string | null | undefined }): Date {
  const zone = (value.timeZone ?? 'UTC').toUpperCase();
  if (zone !== 'UTC') {
    throw new GraphError(
      'request',
      0,
      'Microsoft returned a time in a timezone Jarvis did not expect.',
    );
  }
  const raw = value.dateTime;
  const normalised = /(?:z|[+-]\d{2}:?\d{2})$/i.test(raw) ? raw : `${raw}Z`;
  const parsed = new Date(normalised);
  if (Number.isNaN(parsed.getTime())) {
    throw new GraphError('request', 0, 'Microsoft returned a date Jarvis could not read.');
  }
  return parsed;
}

function isRemoved(item: unknown): boolean {
  return typeof item === 'object' && item !== null && '@removed' in item;
}

export class MicrosoftGraphClient {
  private readonly fetchImpl: GraphFetch;
  private readonly baseUrl: string;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly deps: GraphClientDeps) {
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.baseUrl = (deps.baseUrl ?? GRAPH_BASE_URL).replace(/\/+$/, '');
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  private now(): Date {
    return this.deps.clock?.() ?? new Date();
  }

  /* ------------------------------------------------------------------ mail */

  /**
   * Unread mail in the inbox, newest first.
   *
   * `inbox` is a well-known folder name Graph accepts in place of an identifier, so this costs one
   * request rather than a lookup and a request, and it works whatever language the mailbox is in.
   *
   * The ordering is done here rather than with `$orderby`. Graph requires that any property in
   * `$orderby` also appear in `$filter`, in the same order and before any filter-only property,
   * and rejects the rest as `InefficientFilter`. Sorting nine items locally is a better trade than
   * a briefing that fails on a mailbox whose shape happens to trip that rule.
   */
  async unreadInbox(limit: number): Promise<Page<MailHeadline>> {
    const page = await this.collect(
      '/me/mailFolders/inbox/messages',
      {
        $select: MESSAGE_FIELDS.join(','),
        $filter: 'isRead eq false',
        $top: String(clamp(limit, 1, 50)),
      },
      [],
      1,
    );
    const items = this.readMessages(page.items)
      .sort((a, b) => b.receivedAt.getTime() - a.receivedAt.getTime())
      .slice(0, limit);
    return { items, truncated: page.truncated, deltaLink: null };
  }

  /**
   * What has changed in the inbox since the last read.
   *
   * The first call has no link and Graph performs a full synchronization, bounded here to
   * `DELTA_LOOKBACK_MS`; every later call replays the link Graph handed back, verbatim and with no
   * query options appended — the token encodes them, and rebuilding the URL is how a delta loop
   * quietly starts returning the wrong thing. Removals arrive as `@removed` stubs and are dropped:
   * a briefing reports what has arrived, and a message that has gone is not news.
   *
   * A cursor Graph no longer recognises (`410 Gone`, or the documented `syncStateNotFound`) is not
   * an error to report — it is an instruction to resynchronize, which is what happens here, once.
   */
  async inboxDelta(deltaLink: string | null, pageSize: number): Promise<Page<MailHeadline>> {
    if (deltaLink) {
      try {
        return this.finishDelta(await this.collect(deltaLink, {}, [], MAX_PAGES));
      } catch (error) {
        if (!(error instanceof GraphError) || error.kind !== 'resync') throw error;
      }
    }
    return this.finishDelta(await this.freshDelta(pageSize));
  }

  private freshDelta(
    pageSize: number,
  ): Promise<{ items: unknown[]; truncated: boolean; deltaLink: string | null }> {
    const since = new Date(this.now().getTime() - DELTA_LOOKBACK_MS).toISOString();
    return this.collect(
      '/me/mailFolders/inbox/messages/delta',
      { $select: MESSAGE_FIELDS.join(','), $filter: `receivedDateTime ge ${since}` },
      [`odata.maxpagesize=${clamp(pageSize, 1, 50)}`],
      MAX_PAGES,
    );
  }

  private finishDelta(page: {
    items: unknown[];
    truncated: boolean;
    deltaLink: string | null;
  }): Page<MailHeadline> {
    const fresh = page.items.filter((item) => !isRemoved(item));
    return {
      items: this.readMessages(fresh).sort(
        (a, b) => b.receivedAt.getTime() - a.receivedAt.getTime(),
      ),
      truncated: page.truncated,
      deltaLink: page.deltaLink,
    };
  }

  /** Parse what can be parsed. One unreadable row should not cost Blake the other nine. */
  private readMessages(raw: readonly unknown[]): MailHeadline[] {
    const out: MailHeadline[] = [];
    for (const item of raw) {
      const parsed = messageSchema.safeParse(item);
      if (!parsed.success) continue;
      const message = parsed.data;
      const received = message.receivedDateTime ? new Date(message.receivedDateTime) : null;
      if (!received || Number.isNaN(received.getTime())) continue;
      out.push({
        id: message.id,
        subject: message.subject?.trim() || '(no subject)',
        from: message.from?.emailAddress?.name?.trim() || 'Unknown sender',
        fromAddress: message.from?.emailAddress?.address ?? null,
        receivedAt: received,
        isRead: message.isRead ?? false,
        hasAttachments: message.hasAttachments ?? false,
        importance: message.importance,
        preview: trimPreview(message.bodyPreview),
        webLink: message.webLink ?? null,
      });
    }
    return out;
  }

  /* -------------------------------------------------------------- calendar */

  /**
   * Appointments between two instants, recurrences already expanded.
   *
   * `calendarView` rather than `/me/events` precisely because of that expansion: Graph documents
   * `/me/events` as returning single instances and series masters, so a weekly stand-up stored as
   * one recurring event would be invisible on the morning it actually happens.
   *
   * The window bounds are sent as UTC instants — Graph reads the offset in the value itself and
   * documents that the timezone preference header does not affect them — and no `$orderby` is
   * sent, for the same reason the mail read sorts locally.
   */
  async calendarView(from: Date, to: Date, limit: number): Promise<Page<CalendarEntry>> {
    const page = await this.collect(
      '/me/calendarView',
      {
        startDateTime: from.toISOString(),
        endDateTime: to.toISOString(),
        $select: EVENT_FIELDS.join(','),
        $top: String(clamp(limit, 1, 50)),
      },
      [],
      2,
    );

    const items: CalendarEntry[] = [];
    for (const raw of page.items) {
      const parsed = eventSchema.safeParse(raw);
      if (!parsed.success) continue;
      const event = parsed.data;
      items.push({
        id: event.id,
        subject: event.subject?.trim() || '(no title)',
        startAt: readDateTime(event.start),
        endAt: readDateTime(event.end),
        isAllDay: event.isAllDay ?? false,
        location: event.location?.displayName?.trim() || null,
        organizer: event.organizer?.emailAddress?.name?.trim() || null,
        isOnline: event.isOnlineMeeting ?? false,
        webLink: event.webLink ?? null,
      });
    }
    const ordered = items.sort((a, b) => a.startAt.getTime() - b.startAt.getTime());
    return {
      items: ordered.slice(0, limit),
      truncated: page.truncated || ordered.length > limit,
      deltaLink: null,
    };
  }

  /* ------------------------------------------------------------------ tasks */

  /**
   * Open To Do tasks, across every list.
   *
   * Completion is filtered here rather than with `$filter`, and each list is read in one bounded
   * page: the query options `todoTask` supports are narrower than those on messages and Microsoft
   * publishes no support matrix for the plain list endpoint, so reading fifty rows and dropping the
   * done ones is a better trade than a briefing that 400s on an unsupported filter.
   */
  async openTasks(limit: number): Promise<Page<TaskEntry>> {
    const listPage = await this.collect('/me/todo/lists', {}, [], 2);
    const lists: { id: string; name: string }[] = [];
    for (const raw of listPage.items) {
      const parsed = todoListSchema.safeParse(raw);
      if (!parsed.success) continue;
      lists.push({ id: parsed.data.id, name: parsed.data.displayName?.trim() || 'Tasks' });
    }

    const now = this.now();
    const collected: TaskEntry[] = [];
    let truncated = listPage.truncated || lists.length > MAX_TASK_LISTS;

    for (const list of lists.slice(0, MAX_TASK_LISTS)) {
      const tasks = await this.collect(
        `/me/todo/lists/${encodeURIComponent(list.id)}/tasks`,
        { $top: '50' },
        [],
        1,
      );
      truncated = truncated || tasks.truncated;
      for (const raw of tasks.items) {
        const parsed = todoTaskSchema.safeParse(raw);
        if (!parsed.success) continue;
        const task = parsed.data;
        if ((task.status ?? '').toLowerCase() === 'completed') continue;
        const due = task.dueDateTime ? readDateTime(task.dueDateTime) : null;
        collected.push({
          id: task.id,
          title: task.title?.trim() || '(untitled task)',
          listName: list.name,
          dueAt: due,
          importance: task.importance,
          overdue: due !== null && due.getTime() < now.getTime(),
        });
      }
    }

    /* Dated first and soonest first, then everything undated in the order the lists gave. */
    const ordered = collected.sort((a, b) => {
      if (a.dueAt && b.dueAt) return a.dueAt.getTime() - b.dueAt.getTime();
      if (a.dueAt) return -1;
      if (b.dueAt) return 1;
      return 0;
    });
    return {
      items: ordered.slice(0, limit),
      truncated: truncated || ordered.length > limit,
      deltaLink: null,
    };
  }

  /* ---------------------------------------------------------------- plumbing */

  /** Follow `@odata.nextLink` up to `maxPages`, reporting whether the limit ended the read. */
  private async collect(
    pathOrUrl: string,
    query: Record<string, string>,
    prefer: readonly string[],
    maxPages: number,
  ): Promise<{ items: unknown[]; truncated: boolean; deltaLink: string | null }> {
    const pages = clamp(maxPages, 1, MAX_PAGES);
    let next: string | null = this.urlFor(pathOrUrl, query);
    const items: unknown[] = [];
    let deltaLink: string | null = null;

    for (let page = 0; page < pages && next; page += 1) {
      const body: unknown = await this.request(next, prefer);
      const parsed = collectionSchema.safeParse(body);
      if (!parsed.success) {
        throw new GraphError('request', 0, 'Microsoft returned a list Jarvis could not read.');
      }
      items.push(...(parsed.data.value ?? []));
      deltaLink = parsed.data['@odata.deltaLink'] ?? null;
      /* A page can carry one or the other, never both, so a delta link ends the walk. */
      next = deltaLink ? null : (parsed.data['@odata.nextLink'] ?? null);
    }

    return { items, truncated: next !== null, deltaLink };
  }

  private urlFor(pathOrUrl: string, query: Record<string, string>): string {
    const url = /^https?:\/\//i.test(pathOrUrl)
      ? new URL(pathOrUrl)
      : new URL(`${this.baseUrl}${pathOrUrl.startsWith('/') ? '' : '/'}${pathOrUrl}`);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    return url.toString();
  }

  /**
   * One request, retried only when Microsoft says to.
   *
   * A fresh token is taken on every attempt rather than once per call, so a refresh that happens
   * between a 429 and its retry is picked up instead of resending the token that just expired.
   */
  private async request(url: string, prefer: readonly string[] = []): Promise<unknown> {
    for (let attempt = 1; ; attempt += 1) {
      const token = await this.deps.accessToken();
      const headers: Record<string, string> = {
        authorization: `Bearer ${token}`,
        accept: 'application/json',
      };
      if (prefer.length > 0) headers['prefer'] = prefer.join(', ');

      let response: Response;
      try {
        response = await this.fetchImpl(url, { method: 'GET', headers });
      } catch {
        if (attempt >= MAX_ATTEMPTS) {
          throw new GraphError('unavailable', 0, 'Microsoft could not be reached.');
        }
        await this.sleep(backoffFor(attempt, null));
        continue;
      }

      if (response.ok) return (await response.json()) as unknown;

      const status = response.status;
      if (status === 401) {
        throw new GraphError(
          'auth',
          status,
          'Microsoft rejected the stored authorization. Connect the account again.',
        );
      }
      if (status === 403) {
        throw new GraphError(
          'permission',
          status,
          'Microsoft refused: this account has not granted Jarvis that permission.',
        );
      }
      if (status === 410) {
        throw new GraphError(
          'resync',
          status,
          'The stored synchronization point has expired; Jarvis will start again.',
        );
      }
      if (status === 429 || status === 503 || status === 504) {
        if (attempt >= MAX_ATTEMPTS) {
          throw new GraphError(
            status === 429 ? 'throttled' : 'unavailable',
            status,
            status === 429
              ? 'Microsoft is rate limiting Jarvis. It will try again later.'
              : 'Microsoft is temporarily unavailable.',
          );
        }
        await this.sleep(backoffFor(attempt, response.headers.get('retry-after')));
        continue;
      }
      throw new GraphError('request', status, `Microsoft refused the request (HTTP ${status}).`);
    }
  }
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(Math.trunc(value), low), high);
}

/** `Retry-After` when Microsoft sends one, clamped; otherwise a short exponential back-off. */
export function backoffFor(attempt: number, retryAfter: string | null): number {
  if (retryAfter) {
    const seconds = Number.parseInt(retryAfter, 10);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(seconds * 1000, MAX_RETRY_DELAY_MS);
    }
  }
  return Math.min(1000 * 2 ** (attempt - 1), MAX_RETRY_DELAY_MS);
}
