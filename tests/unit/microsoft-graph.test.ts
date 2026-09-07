import { describe, expect, it, vi } from 'vitest';

import { GraphError, MicrosoftGraphClient, backoffFor } from '@/server/connections/microsoft-graph';
import { MAIL_PREVIEW_LIMIT } from '@/domain/personal-signals';

/**
 * The reader that decides what Jarvis knows about Blake's morning.
 *
 * The fakes sit at the HTTP boundary, so what is proved here is the request Jarvis composes and
 * its reading of a documented response shape. Nothing in this file proves that Microsoft answers —
 * that needs Blake's own account, and `docs/PERSONAL_ASSISTANT_SETUP.md` says so.
 *
 * The assertions worth having are the ones about restraint: that the field list never asks for a
 * message body, that a page limit ends a walk, that a 401 is not retried, and that a delta link is
 * replayed rather than rebuilt.
 */

interface Call {
  readonly url: string;
  readonly init: RequestInit;
}

/** A fetch that answers with queued responses and remembers what it was asked. */
function fakeFetch(responses: readonly (() => Response)[]) {
  const calls: Call[] = [];
  let index = 0;
  const impl = async (url: string, init: RequestInit): Promise<Response> => {
    calls.push({ url, init });
    const next = responses[Math.min(index, responses.length - 1)];
    index += 1;
    if (!next) throw new Error('no response queued');
    return next();
  };
  return { impl, calls };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers });

const message = (over: Record<string, unknown> = {}) => ({
  id: 'AAMk-1',
  subject: 'Invoice for August',
  from: { emailAddress: { name: 'Dana Reed', address: 'dana@example.com' } },
  receivedDateTime: '2026-09-07T06:40:00Z',
  isRead: false,
  hasAttachments: true,
  importance: 'high',
  bodyPreview: 'Attached is the invoice for last month.',
  webLink: 'https://outlook.office365.com/mail/id/AAMk-1',
  ...over,
});

function clientFor(
  responses: readonly (() => Response)[],
  clock = () => new Date('2026-09-07T07:00:00Z'),
) {
  const fetcher = fakeFetch(responses);
  const sleep = vi.fn(async () => {});
  const accessToken = vi.fn(async () => 'token-value');
  const client = new MicrosoftGraphClient({
    accessToken,
    fetchImpl: fetcher.impl,
    sleep,
    clock,
  });
  return { client, calls: fetcher.calls, sleep, accessToken };
}

const query = (call: Call) => new URL(call.url).searchParams;

describe('reading unread mail', () => {
  it('never asks Microsoft for a message body or its attachments', async () => {
    const { client, calls } = clientFor([() => json({ value: [message()] })]);
    await client.unreadInbox(10);

    const select = query(calls[0]!).get('$select') ?? '';
    expect(select).toContain('bodyPreview');
    expect(select.split(',')).not.toContain('body');
    expect(select).not.toContain('uniqueBody');
    expect(select).not.toContain('attachments');
  });

  it('asks the inbox for unread messages and carries the bearer token', async () => {
    const { client, calls } = clientFor([() => json({ value: [message()] })]);
    await client.unreadInbox(10);

    const call = calls[0]!;
    expect(new URL(call.url).pathname).toBe('/v1.0/me/mailFolders/inbox/messages');
    expect(query(call).get('$filter')).toBe('isRead eq false');
    expect((call.init.headers as Record<string, string>).authorization).toBe('Bearer token-value');
  });

  it('does not send $orderby, which Graph rejects alongside an unrelated $filter', async () => {
    const { client, calls } = clientFor([() => json({ value: [message()] })]);
    await client.unreadInbox(10);
    expect(query(calls[0]!).get('$orderby')).toBeNull();
  });

  it('reads a documented message into a headline', async () => {
    const { client } = clientFor([() => json({ value: [message()] })]);
    const page = await client.unreadInbox(10);

    expect(page.items).toHaveLength(1);
    const first = page.items[0]!;
    expect(first.subject).toBe('Invoice for August');
    expect(first.from).toBe('Dana Reed');
    expect(first.fromAddress).toBe('dana@example.com');
    expect(first.hasAttachments).toBe(true);
    expect(first.importance).toBe('high');
    expect(first.receivedAt.toISOString()).toBe('2026-09-07T06:40:00.000Z');
  });

  it('trims the preview and never returns more of it than the limit', async () => {
    const long = 'x'.repeat(400);
    const { client } = clientFor([() => json({ value: [message({ bodyPreview: long })] })]);
    const page = await client.unreadInbox(10);
    expect(page.items[0]!.preview.length).toBeLessThanOrEqual(MAIL_PREVIEW_LIMIT);
  });

  it('sorts newest first and stops at the limit', async () => {
    const { client } = clientFor([
      () =>
        json({
          value: [
            message({ id: 'old', receivedDateTime: '2026-09-06T06:00:00Z' }),
            message({ id: 'new', receivedDateTime: '2026-09-07T06:00:00Z' }),
            message({ id: 'middle', receivedDateTime: '2026-09-06T18:00:00Z' }),
          ],
        }),
    ]);
    const page = await client.unreadInbox(2);
    expect(page.items.map((item) => item.id)).toEqual(['new', 'middle']);
  });

  it('keeps the rows it can read when one is malformed', async () => {
    const { client } = clientFor([
      () => json({ value: [{ id: 'broken' }, message({ id: 'fine' })] }),
    ]);
    const page = await client.unreadInbox(10);
    expect(page.items.map((item) => item.id)).toEqual(['fine']);
  });
});

describe('when Microsoft pushes back', () => {
  it('waits exactly as long as Retry-After asks, then succeeds', async () => {
    const { client, sleep, calls } = clientFor([
      () => json({ error: 'TooManyRequests' }, 429, { 'retry-after': '3' }),
      () => json({ value: [message()] }),
    ]);
    const page = await client.unreadInbox(10);

    expect(sleep).toHaveBeenCalledWith(3000);
    expect(calls).toHaveLength(2);
    expect(page.items).toHaveLength(1);
  });

  it('takes a fresh token for the retry rather than replaying the expired one', async () => {
    const { client, accessToken } = clientFor([
      () => json({}, 429, { 'retry-after': '1' }),
      () => json({ value: [] }),
    ]);
    await client.unreadInbox(10);
    expect(accessToken).toHaveBeenCalledTimes(2);
  });

  it('gives up after the attempt ceiling instead of hammering the account', async () => {
    const { client, calls } = clientFor([() => json({}, 429, { 'retry-after': '1' })]);
    await expect(client.unreadInbox(10)).rejects.toMatchObject({ kind: 'throttled' });
    expect(calls).toHaveLength(3);
  });

  it('does not retry a rejected authorization', async () => {
    const { client, calls } = clientFor([() => json({}, 401)]);
    await expect(client.unreadInbox(10)).rejects.toMatchObject({ kind: 'auth' });
    expect(calls).toHaveLength(1);
  });

  it('does not retry a permission Blake did not grant', async () => {
    const { client, calls } = clientFor([() => json({}, 403)]);
    await expect(client.unreadInbox(10)).rejects.toMatchObject({ kind: 'permission' });
    expect(calls).toHaveLength(1);
  });

  it('keeps the provider body out of the error it raises', async () => {
    const secret = 'eyJ0eXAiOiJKV1QiLCJhbGciOiJSUzI1NiJ9.leaked';
    const { client } = clientFor([() => json({ error: { message: secret } }, 400)]);

    let caught: unknown;
    try {
      await client.unreadInbox(10);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(GraphError);
    expect((caught as GraphError).message).not.toContain(secret);
    expect((caught as GraphError).status).toBe(400);
  });
});

describe('delta synchronization', () => {
  const deltaLink =
    'https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$deltatoken=abc';

  it('bounds the first synchronization instead of walking the whole mailbox', async () => {
    const { client, calls } = clientFor([() => json({ value: [], '@odata.deltaLink': deltaLink })]);
    await client.inboxDelta(null, 25);

    const params = query(calls[0]!);
    expect(new URL(calls[0]!.url).pathname).toBe('/v1.0/me/mailFolders/inbox/messages/delta');
    expect(params.get('$filter')).toBe('receivedDateTime ge 2026-08-31T07:00:00.000Z');
    expect((calls[0]!.init.headers as Record<string, string>).prefer).toBe('odata.maxpagesize=25');
  });

  it('replays a stored link verbatim, adding nothing to it', async () => {
    const { client, calls } = clientFor([() => json({ value: [], '@odata.deltaLink': deltaLink })]);
    await client.inboxDelta(deltaLink, 25);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(deltaLink);
  });

  it('follows nextLink to the end and returns the link to resume from', async () => {
    const next =
      'https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$skiptoken=1';
    const { client, calls } = clientFor([
      () => json({ value: [message({ id: 'a' })], '@odata.nextLink': next }),
      () => json({ value: [message({ id: 'b' })], '@odata.deltaLink': deltaLink }),
    ]);
    const page = await client.inboxDelta(null, 25);

    expect(calls).toHaveLength(2);
    expect(calls[1]!.url).toBe(next);
    expect(page.deltaLink).toBe(deltaLink);
    expect(page.items.map((item) => item.id).sort()).toEqual(['a', 'b']);
    expect(page.truncated).toBe(false);
  });

  it('drops the stubs that only say something was deleted', async () => {
    const { client } = clientFor([
      () =>
        json({
          value: [{ id: 'gone', '@removed': { reason: 'deleted' } }, message({ id: 'here' })],
          '@odata.deltaLink': deltaLink,
        }),
    ]);
    const page = await client.inboxDelta(null, 25);
    expect(page.items.map((item) => item.id)).toEqual(['here']);
  });

  it('starts again when Microsoft says the synchronization point has expired', async () => {
    const { client, calls } = clientFor([
      () => json({}, 410),
      () => json({ value: [message()], '@odata.deltaLink': deltaLink }),
    ]);
    const page = await client.inboxDelta(deltaLink, 25);

    expect(calls).toHaveLength(2);
    expect(new URL(calls[1]!.url).searchParams.get('$filter')).toContain('receivedDateTime ge');
    expect(page.deltaLink).toBe(deltaLink);
  });

  it('stops at the page ceiling and says the read was cut short', async () => {
    const next = 'https://graph.microsoft.com/v1.0/next';
    const { client, calls } = clientFor([() => json({ value: [], '@odata.nextLink': next })]);
    const page = await client.inboxDelta(null, 25);

    expect(page.truncated).toBe(true);
    expect(page.deltaLink).toBeNull();
    expect(calls.length).toBeLessThanOrEqual(10);
  });
});

describe('reading the calendar', () => {
  const event = (over: Record<string, unknown> = {}) => ({
    id: 'evt-1',
    subject: 'Design review',
    start: { dateTime: '2026-09-07T09:00:00.0000000', timeZone: 'UTC' },
    end: { dateTime: '2026-09-07T09:30:00.0000000', timeZone: 'UTC' },
    isAllDay: false,
    location: { displayName: 'Teams' },
    organizer: { emailAddress: { name: 'Dana Reed', address: 'dana@example.com' } },
    isOnlineMeeting: true,
    webLink: 'https://outlook.office365.com/calendar/item/evt-1',
    ...over,
  });

  it('asks calendarView for a window, so recurring meetings actually appear', async () => {
    const { client, calls } = clientFor([() => json({ value: [event()] })]);
    await client.calendarView(
      new Date('2026-09-07T07:00:00Z'),
      new Date('2026-09-08T07:00:00Z'),
      20,
    );

    const params = query(calls[0]!);
    expect(new URL(calls[0]!.url).pathname).toBe('/v1.0/me/calendarView');
    expect(params.get('startDateTime')).toBe('2026-09-07T07:00:00.000Z');
    expect(params.get('endDateTime')).toBe('2026-09-08T07:00:00.000Z');
  });

  it('reads the split date and zone into one instant', async () => {
    const { client } = clientFor([() => json({ value: [event()] })]);
    const page = await client.calendarView(new Date(0), new Date(1), 20);

    expect(page.items[0]!.startAt.toISOString()).toBe('2026-09-07T09:00:00.000Z');
    expect(page.items[0]!.isOnline).toBe(true);
    expect(page.items[0]!.location).toBe('Teams');
  });

  it('refuses a time in an unexpected zone rather than moving the meeting', async () => {
    const { client } = clientFor([
      () =>
        json({
          value: [
            event({
              start: { dateTime: '2026-09-07T09:00:00', timeZone: 'Pacific Standard Time' },
            }),
          ],
        }),
    ]);
    await expect(client.calendarView(new Date(0), new Date(1), 20)).rejects.toBeInstanceOf(
      GraphError,
    );
  });
});

describe('reading tasks', () => {
  it('drops completed work, names the list and marks what is overdue', async () => {
    const { client } = clientFor([
      () => json({ value: [{ id: 'list-1', displayName: 'Jarvis' }] }),
      () =>
        json({
          value: [
            {
              id: 'done',
              title: 'Ship it',
              status: 'completed',
              dueDateTime: { dateTime: '2026-09-01T09:00:00.0000000', timeZone: 'UTC' },
            },
            {
              id: 'late',
              title: 'Renew the certificate',
              status: 'notStarted',
              importance: 'high',
              dueDateTime: { dateTime: '2026-09-01T09:00:00.0000000', timeZone: 'UTC' },
            },
            { id: 'someday', title: 'Read the spec', status: 'notStarted' },
          ],
        }),
    ]);
    const page = await client.openTasks(10);

    expect(page.items.map((item) => item.id)).toEqual(['late', 'someday']);
    expect(page.items[0]!.overdue).toBe(true);
    expect(page.items[0]!.listName).toBe('Jarvis');
    expect(page.items[1]!.overdue).toBe(false);
  });
});

describe('backoff', () => {
  it('honours Retry-After but will not wait forever', () => {
    expect(backoffFor(1, '5')).toBe(5000);
    expect(backoffFor(1, '9999')).toBe(20_000);
  });

  it('falls back to exponential when Microsoft sends no header', () => {
    expect(backoffFor(1, null)).toBe(1000);
    expect(backoffFor(2, null)).toBe(2000);
    expect(backoffFor(1, 'soon')).toBe(1000);
  });
});
