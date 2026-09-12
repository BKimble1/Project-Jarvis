import { describe, expect, it, vi } from 'vitest';

import type { ConnectionProvider, ConnectionStatus, StoredConnection } from '@/domain/connection';
import type { ConnectionRepository } from '@/server/repositories/connection-types';
import { GraphError } from '@/server/connections/microsoft-graph';
import type { MicrosoftGraphClient } from '@/server/connections/microsoft-graph';
import type { MicrosoftAccess } from '@/server/connections/microsoft-access';
import {
  INBOX_DELTA_KEY,
  PersonalSignalsService,
  SOURCE_SCOPES,
} from '@/server/connections/personal-signals-service';
import { describeOutcome } from '@/domain/personal-signals';

/**
 * Assembling one morning's answer out of three sources that can each fail separately.
 *
 * The property under test throughout is honesty: a scope Blake declined must read as a declined
 * scope and not as a broken connection, a source that failed must not silently contribute an empty
 * list that looks like "nothing to report", and a read where two of three worked must leave the
 * connection healthy.
 */

const NOW = new Date('2026-09-07T07:00:00Z');

class FakeConnections implements ConnectionRepository {
  row: StoredConnection | null = row();
  deltaWrites: Record<string, string>[] = [];
  synced: Date[] = [];
  failures: { status: ConnectionStatus; message: string }[] = [];

  async list() {
    return this.row ? [this.row] : [];
  }
  async find(provider: ConnectionProvider) {
    return this.row && this.row.provider === provider ? this.row : null;
  }
  async credentials() {
    return null;
  }
  async upsert(): Promise<StoredConnection> {
    throw new Error('not used');
  }
  async refreshed() {}
  async markSynced(_provider: ConnectionProvider, at: Date) {
    this.synced.push(at);
  }
  async markFailed(input: { status: ConnectionStatus; message: string }) {
    this.failures.push({ status: input.status, message: input.message });
  }
  async setDeltaState(_provider: ConnectionProvider, state: Record<string, string>) {
    this.deltaWrites.push(state);
  }
  async disconnect() {}
}

function row(over: Partial<StoredConnection> = {}): StoredConnection {
  return {
    id: 'row-1',
    provider: 'microsoft',
    status: 'connected',
    accountLabel: 'blake@example.com',
    accountId: null,
    grantedScopes: ['Mail.Read', 'Calendars.Read', 'Tasks.Read'],
    expiresAt: null,
    lastSyncAt: null,
    lastFailureAt: null,
    lastFailureMessage: null,
    deltaState: {},
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    ...over,
  };
}

/** Only the three public methods the service calls; `MicrosoftAccess` itself has private state. */
type AccessStub = Pick<MicrosoftAccess, 'isReady' | 'grantedScopes' | 'accessToken'>;

function access(over: Partial<AccessStub> = {}): MicrosoftAccess {
  const stub: AccessStub = {
    isReady: async () => true,
    grantedScopes: async () => ['Mail.Read', 'Calendars.Read', 'Tasks.Read'],
    accessToken: async () => 'token',
    ...over,
  };
  return stub as unknown as MicrosoftAccess;
}

/** A Graph client stub. Only the three methods the service calls are given behaviour. */
function client(
  over: Partial<Record<'unreadInbox' | 'inboxDelta' | 'calendarView' | 'openTasks', unknown>>,
) {
  const base = {
    unreadInbox: vi.fn(async () => ({ items: [], truncated: false, deltaLink: null })),
    inboxDelta: vi.fn(async () => ({ items: [], truncated: false, deltaLink: null })),
    calendarView: vi.fn(async () => ({ items: [], truncated: false, deltaLink: null })),
    openTasks: vi.fn(async () => ({ items: [], truncated: false, deltaLink: null })),
  };
  return { ...base, ...over } as unknown as MicrosoftGraphClient;
}

function service(
  connections: FakeConnections,
  graph: MicrosoftGraphClient,
  accessOver: Partial<AccessStub> = {},
) {
  return new PersonalSignalsService({
    access: access(accessOver),
    connections,
    clock: () => NOW,
    clientFor: () => graph,
  });
}

describe('when nothing is connected', () => {
  it('says so for every source instead of reporting an empty inbox', async () => {
    const connections = new FakeConnections();
    const signals = await service(connections, client({}), {
      isReady: async () => false,
    }).read();

    expect(signals.outcomes.mail).toEqual({ state: 'not_connected' });
    expect(signals.outcomes.calendar).toEqual({ state: 'not_connected' });
    expect(signals.outcomes.tasks).toEqual({ state: 'not_connected' });
    expect(connections.synced).toHaveLength(0);
  });
});

describe('when a permission was not granted', () => {
  it('names the missing scope and does not call Microsoft for that source', async () => {
    const graph = client({});
    const signals = await service(new FakeConnections(), graph, {
      grantedScopes: async () => ['Mail.Read'],
    }).read();

    expect(signals.outcomes.mail.state).toBe('ok');
    expect(signals.outcomes.tasks).toEqual({
      state: 'not_permitted',
      scope: SOURCE_SCOPES.tasks,
    });
    expect((graph.openTasks as unknown as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(
      0,
    );
  });

  it('treats a 403 as a missing permission rather than an outage', async () => {
    const graph = client({
      openTasks: vi.fn(async () => {
        throw new GraphError('permission', 403, 'refused');
      }),
    });
    const signals = await service(new FakeConnections(), graph).read();

    expect(signals.outcomes.tasks).toEqual({ state: 'not_permitted', scope: SOURCE_SCOPES.tasks });
  });

  it('tries anyway when Microsoft returned no scope list at all', async () => {
    const graph = client({});
    const signals = await service(new FakeConnections(), graph, {
      grantedScopes: async () => [],
    }).read();

    expect(signals.outcomes.mail.state).toBe('ok');
    expect(signals.outcomes.calendar.state).toBe('ok');
    expect(signals.outcomes.tasks.state).toBe('ok');
  });
});

describe('when one source fails', () => {
  it('keeps the others and leaves the connection healthy', async () => {
    const connections = new FakeConnections();
    const graph = client({
      calendarView: vi.fn(async () => {
        throw new GraphError('throttled', 429, 'Microsoft is rate limiting Jarvis.');
      }),
    });
    const signals = await service(connections, graph).read();

    expect(signals.outcomes.mail.state).toBe('ok');
    expect(signals.outcomes.calendar).toEqual({
      state: 'failed',
      reason: 'Microsoft is rate limiting Jarvis.',
    });
    expect(connections.synced).toHaveLength(1);
    expect(connections.failures).toHaveLength(0);
  });

  it('marks the connection degraded only when nothing at all could be read', async () => {
    const connections = new FakeConnections();
    const boom = () =>
      vi.fn(async () => {
        throw new GraphError('unavailable', 503, 'Microsoft is temporarily unavailable.');
      });
    const signals = await service(
      connections,
      client({ unreadInbox: boom(), calendarView: boom(), openTasks: boom() }),
    ).read();

    expect(signals.outcomes.mail.state).toBe('failed');
    expect(connections.synced).toHaveLength(0);
    expect(connections.failures[0]?.status).toBe('degraded');
  });

  it('does not stringify an unexpected throw into the stored reason', async () => {
    const connections = new FakeConnections();
    const graph = client({
      unreadInbox: vi.fn(async () => {
        throw new Error('https://graph.microsoft.com/?token=secret');
      }),
      calendarView: vi.fn(async () => {
        throw new Error('https://graph.microsoft.com/?token=secret');
      }),
      openTasks: vi.fn(async () => {
        throw new Error('https://graph.microsoft.com/?token=secret');
      }),
    });
    await service(connections, graph).read();

    expect(connections.failures[0]?.message).not.toContain('secret');
  });
});

describe('the delta cursor', () => {
  it('is left alone by an ordinary read of the inbox', async () => {
    const connections = new FakeConnections();
    await service(connections, client({})).read({ mailMode: 'unread' });
    expect(connections.deltaWrites).toHaveLength(0);
  });

  it('is stored when a "what is new" read completes', async () => {
    const connections = new FakeConnections();
    const graph = client({
      inboxDelta: vi.fn(async () => ({
        items: [],
        truncated: false,
        deltaLink: 'https://graph.microsoft.com/v1.0/delta?$deltatoken=abc',
      })),
    });
    await service(connections, graph).read({ mailMode: 'new-since-last' });

    expect(connections.deltaWrites[0]?.[INBOX_DELTA_KEY]).toBe(
      'https://graph.microsoft.com/v1.0/delta?$deltatoken=abc',
    );
  });

  it('is dropped rather than kept when the read was cut short', async () => {
    const connections = new FakeConnections();
    connections.row = row({ deltaState: { [INBOX_DELTA_KEY]: 'https://old' } });
    const graph = client({
      inboxDelta: vi.fn(async () => ({ items: [], truncated: true, deltaLink: null })),
    });
    await service(connections, graph).read({ mailMode: 'new-since-last' });

    expect(connections.deltaWrites[0]).toEqual({});
  });
});

describe('saying what happened', () => {
  it('has a sentence for every outcome a source can have', () => {
    expect(describeOutcome('mail', { state: 'ok', count: 0 })).toContain('nothing to report');
    expect(describeOutcome('mail', { state: 'ok', count: 3 })).toContain('3');
    expect(describeOutcome('tasks', { state: 'not_connected' })).toContain('not connected');
    expect(describeOutcome('tasks', { state: 'not_permitted', scope: 'Tasks.Read' })).toContain(
      'Tasks.Read',
    );
    expect(describeOutcome('calendar', { state: 'failed', reason: 'it broke' })).toContain(
      'it broke',
    );
  });
});
