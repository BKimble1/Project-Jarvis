import { describe, expect, it, vi } from 'vitest';

import type { ConnectionProvider, ConnectionStatus, StoredConnection } from '@/domain/connection';
import type {
  ConnectionCredentials,
  ConnectionRepository,
} from '@/server/repositories/connection-types';
import { AesCredentialVault, type SealedCredential } from '@/server/security/credential-vault';
import {
  ACCESS_AAD,
  MicrosoftAccess,
  REFRESH_AAD,
  REFRESH_SKEW_MS,
} from '@/server/connections/microsoft-access';

/**
 * The one place a Microsoft credential is opened.
 *
 * What is worth asserting here is not that a token comes back — it is what happens when one
 * cannot: that a rotated refresh token is persisted rather than dropped, that a refusal ends the
 * connection instead of starting a retry loop against a token Microsoft has already invalidated,
 * and that none of the failure messages carry what was sent.
 */

const KEY = Buffer.alloc(32, 7).toString('base64');
const NOW = new Date('2026-09-07T07:00:00Z');

function vault() {
  return new AesCredentialVault({ active: KEY, previous: null, activeVersion: 1 });
}

/** A store that remembers what it was told, and nothing more. */
class FakeConnections implements ConnectionRepository {
  row: StoredConnection | null = null;
  creds: ConnectionCredentials | null = null;
  readonly refreshes: {
    accessToken: SealedCredential;
    refreshToken: SealedCredential | null;
    expiresAt: Date | null;
  }[] = [];
  readonly failures: { status: ConnectionStatus; message: string }[] = [];

  async list() {
    return this.row ? [this.row] : [];
  }
  async find(provider: ConnectionProvider) {
    return this.row && this.row.provider === provider ? this.row : null;
  }
  async credentials() {
    return this.creds;
  }
  async upsert(): Promise<StoredConnection> {
    throw new Error('not used');
  }
  async refreshed(input: {
    accessToken: SealedCredential;
    refreshToken: SealedCredential | null;
    expiresAt: Date | null;
  }) {
    this.refreshes.push({
      accessToken: input.accessToken,
      refreshToken: input.refreshToken,
      expiresAt: input.expiresAt,
    });
  }
  async markSynced() {}
  async markFailed(input: { status: ConnectionStatus; message: string }) {
    this.failures.push({ status: input.status, message: input.message });
  }
  async setDeltaState() {}
  async disconnect() {}
}

function connection(over: Partial<StoredConnection> = {}): StoredConnection {
  return {
    id: 'row-1',
    provider: 'microsoft',
    status: 'connected',
    accountLabel: 'blake@example.com',
    accountId: null,
    grantedScopes: ['Mail.Read', 'Calendars.Read', 'Tasks.Read'],
    expiresAt: new Date(NOW.getTime() + 60 * 60 * 1000).toISOString(),
    lastSyncAt: null,
    lastFailureAt: null,
    lastFailureMessage: null,
    deltaState: {},
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    ...over,
  };
}

const config = {
  clientId: 'client-id',
  clientSecret: 'client-secret',
  redirectUri: 'http://localhost:3000/api/connections/microsoft/callback',
};

function subject(
  connections: FakeConnections,
  fetchImpl: (url: string, init: RequestInit) => Promise<Response>,
) {
  return new MicrosoftAccess({
    connections,
    vault: vault(),
    config,
    fetchImpl,
    clock: () => NOW,
  });
}

/** A fetch that fails the test if it is ever reached. Fresh per test, so calls cannot leak. */
const refuseToCall = () =>
  vi.fn(async (_url: string, _init: RequestInit): Promise<Response> => {
    throw new Error('Microsoft should not have been called');
  });

describe('handing out an access token', () => {
  it('uses the stored token while it still has life in it', async () => {
    const connections = new FakeConnections();
    connections.row = connection();
    connections.creds = {
      accessToken: vault().seal('live-token', ACCESS_AAD),
      refreshToken: vault().seal('refresh-token', REFRESH_AAD),
    };

    const never = refuseToCall();
    await expect(subject(connections, never).accessToken()).resolves.toBe('live-token');
    expect(never).not.toHaveBeenCalled();
  });

  it('renews before expiry rather than at it', async () => {
    const connections = new FakeConnections();
    connections.row = connection({
      expiresAt: new Date(NOW.getTime() + REFRESH_SKEW_MS - 1000).toISOString(),
    });
    connections.creds = {
      accessToken: vault().seal('nearly-dead', ACCESS_AAD),
      refreshToken: vault().seal('refresh-token', REFRESH_AAD),
    };
    const fetchImpl = vi.fn(
      async (_url: string, _init: RequestInit) =>
        new Response(
          JSON.stringify({ access_token: 'fresh', refresh_token: 'rotated', expires_in: 3599 }),
          { status: 200 },
        ),
    );

    await expect(subject(connections, fetchImpl).accessToken()).resolves.toBe('fresh');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('stores the rotated refresh token, sealed, so the next renewal can work', async () => {
    const connections = new FakeConnections();
    connections.row = connection({ expiresAt: null });
    connections.creds = {
      accessToken: null,
      refreshToken: vault().seal('refresh-token', REFRESH_AAD),
    };
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ access_token: 'fresh', refresh_token: 'rotated', expires_in: 3599 }),
          { status: 200 },
        ),
    );

    await subject(connections, fetchImpl).accessToken();

    const saved = connections.refreshes[0]!;
    expect(saved.refreshToken).not.toBeNull();
    expect(vault().open(saved.refreshToken!, REFRESH_AAD)).toBe('rotated');
    expect(vault().open(saved.accessToken, ACCESS_AAD)).toBe('fresh');
    expect(JSON.stringify(saved)).not.toContain('rotated');
  });
});

describe('when the account can no longer be reached', () => {
  it('ends the connection rather than retrying a token Microsoft has invalidated', async () => {
    const connections = new FakeConnections();
    connections.row = connection({ expiresAt: null });
    connections.creds = {
      accessToken: null,
      refreshToken: vault().seal('refresh-token', REFRESH_AAD),
    };
    const fetchImpl = vi.fn(async () => new Response('{"error":"invalid_grant"}', { status: 400 }));

    await expect(subject(connections, fetchImpl).accessToken()).rejects.toThrow(/Connect/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(connections.failures[0]?.status).toBe('reauthorization_required');
  });

  it('says nothing about what was sent when it reports the failure', async () => {
    const connections = new FakeConnections();
    connections.row = connection({ expiresAt: null });
    connections.creds = {
      accessToken: null,
      refreshToken: vault().seal('super-secret-refresh', REFRESH_AAD),
    };
    const fetchImpl = vi.fn(
      async () =>
        new Response('{"error_description":"super-secret-refresh is bad"}', { status: 400 }),
    );

    await expect(subject(connections, fetchImpl).accessToken()).rejects.toThrow();
    expect(connections.failures[0]?.message).not.toContain('super-secret-refresh');
  });

  it('refuses without calling Microsoft once reauthorization is required', async () => {
    const connections = new FakeConnections();
    connections.row = connection({ status: 'reauthorization_required' });

    const never = refuseToCall();
    await expect(subject(connections, never).accessToken()).rejects.toThrow(/again/);
    expect(never).not.toHaveBeenCalled();
  });

  it('refuses when nothing has been connected at all', async () => {
    const connections = new FakeConnections();
    const never = refuseToCall();
    await expect(subject(connections, never).accessToken()).rejects.toThrow(/not connected/i);
    await expect(subject(connections, never).isReady()).resolves.toBe(false);
  });

  it('ends the connection when there is no refresh token left to use', async () => {
    const connections = new FakeConnections();
    connections.row = connection({ expiresAt: null });
    connections.creds = { accessToken: null, refreshToken: null };

    await expect(subject(connections, refuseToCall()).accessToken()).rejects.toThrow(/again/);
    expect(connections.failures[0]?.status).toBe('reauthorization_required');
  });
});
