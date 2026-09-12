import { describe, expect, it } from 'vitest';

import type { ConnectionProvider, StoredConnection } from '@/domain/connection';
import { PROVIDER_CATALOGUE, MICROSOFT_READ_SCOPES } from '@/domain/connection-catalogue';
import { ConnectionService } from '@/server/connections/connection-service';
import type { ConnectionRepository } from '@/server/repositories/connection-types';
import { UnconfiguredCredentialVault } from '@/server/security/credential-vault';

/**
 * The screen that has to be honest about what Jarvis cannot do.
 *
 * The assertions that matter are the ones about Apple. A table driven only by database rows shows
 * "Disconnected" for a provider that has no interface at all, which invites Blake to go looking for
 * a button — and there is no button, and there is no setting, and there is no evening's work that
 * would produce one.
 */

const row = (
  over: Partial<StoredConnection> & { provider: ConnectionProvider },
): StoredConnection => ({
  id: 'c1',
  status: 'connected',
  accountLabel: 'blake@example.com',
  accountId: null,
  grantedScopes: [...MICROSOFT_READ_SCOPES],
  expiresAt: null,
  lastSyncAt: '2026-09-07T06:00:00.000Z',
  lastFailureAt: null,
  lastFailureMessage: null,
  deltaState: {},
  createdAt: '2026-09-07T05:00:00.000Z',
  updatedAt: '2026-09-07T06:00:00.000Z',
  ...over,
});

function service(rows: readonly StoredConnection[]) {
  const connections = {
    async list() {
      return rows;
    },
    async find(provider: ConnectionProvider) {
      return rows.find((r) => r.provider === provider) ?? null;
    },
  } as unknown as ConnectionRepository;
  return new ConnectionService({ connections, vault: new UnconfiguredCredentialVault() });
}

describe('what the connections screen says', () => {
  it('lists every provider Jarvis knows about, connected or not', async () => {
    const views = await service([]).list();
    expect(views).toHaveLength(PROVIDER_CATALOGUE.length);
  });

  it('calls a provider with no official interface Unsupported, never Disconnected', async () => {
    const views = await service([]).list();
    const reminders = views.find((v) => v.provider === 'apple_reminders')!;
    const icloud = views.find((v) => v.provider === 'apple_icloud_calendar')!;

    expect(reminders.status).toBe('unsupported');
    expect(icloud.status).toBe('unsupported');
    /* And there is no button, because pressing one could not work. */
    expect(reminders.connectable).toBe(false);
    expect(icloud.connectable).toBe(false);
    /* And it says what it cannot see rather than leaving the reader to infer it. */
    expect(reminders.cannotSee.length).toBeGreaterThan(0);
  });

  it('explains why an unsupported provider is unsupported, and what would change it', () => {
    for (const provider of ['apple_reminders', 'apple_icloud_calendar'] as const) {
      const entry = PROVIDER_CATALOGUE.find((e) => e.provider === provider)!;
      expect(entry.unsupportedReason?.summary).toBeTruthy();
      expect(entry.unsupportedReason?.wouldRequire).toBeTruthy();
    }
  });

  it('a stale row can never promote an unsupported provider to connected', async () => {
    /*
     * Defence in depth. If a row for Apple Reminders ever appeared — a bad migration, a hand-edit,
     * a future bug — the screen must still say Unsupported, because the row would be wrong.
     */
    const views = await service([row({ provider: 'apple_reminders', status: 'connected' })]).list();
    expect(views.find((v) => v.provider === 'apple_reminders')?.status).toBe('unsupported');
  });

  it('distinguishes never-authorized from disconnected', async () => {
    const never = await service([]).get('microsoft');
    expect(never.status).toBe('needs_authorization');

    const gone = await service([row({ provider: 'microsoft', status: 'disconnected' })]).get(
      'microsoft',
    );
    expect(gone.status).toBe('disconnected');
    expect(gone.recovery).toMatch(/you disconnected this/i);
  });

  it('asks for reauthorization when the stored grant stopped working', async () => {
    const view = await service([
      row({ provider: 'microsoft', status: 'reauthorization_required' }),
    ]).get('microsoft');
    expect(view.status).toBe('reauthorization_required');
    expect(view.recovery).toMatch(/connect it again/i);
  });

  it('never puts a credential, or a field that could hold one, in the view', async () => {
    const views = await service([row({ provider: 'microsoft' })]).list();
    const blob = JSON.stringify(views);
    for (const forbidden of [
      'accessToken',
      'refreshToken',
      'access_token',
      'ciphertext',
      'secret',
    ]) {
      expect(blob, forbidden).not.toContain(forbidden);
    }
  });

  it('shows the account identity when connected and hides it when not', async () => {
    const connected = await service([row({ provider: 'microsoft' })]).get('microsoft');
    expect(connected.accountLabel).toBe('blake@example.com');

    const disconnected = await service([
      row({ provider: 'microsoft', status: 'disconnected' }),
    ]).get('microsoft');
    expect(disconnected.accountLabel).toBeNull();
  });

  it('separates what it can look at from what it can change', async () => {
    const view = await service([row({ provider: 'microsoft' })]).get('microsoft');
    const reads = view.capabilities.filter((c) => c.access === 'read');
    const writes = view.capabilities.filter((c) => c.access === 'write');

    expect(reads.length).toBeGreaterThan(0);
    expect(writes.length).toBeGreaterThan(0);
    /* Read scopes were granted; the action scopes were not asked for. */
    expect(reads.every((c) => c.granted)).toBe(true);
    expect(writes.every((c) => !c.granted)).toBe(true);
  });

  it('says plainly that it cannot send mail, even when fully connected', async () => {
    const view = await service([row({ provider: 'microsoft' })]).get('microsoft');
    expect(view.cannotSee.join(' ')).toMatch(/cannot send email as you/i);
  });

  it('reports the vault as the reason connecting is unavailable', () => {
    expect(service([]).vaultReady()).toBe(false);
  });
});

describe('the scopes Jarvis asks for', () => {
  it('never includes permission to send mail', () => {
    expect(MICROSOFT_READ_SCOPES).not.toContain('Mail.Send');
    const entry = PROVIDER_CATALOGUE.find((e) => e.provider === 'microsoft')!;
    expect(entry.capabilities.map((c) => c.scope)).not.toContain('Mail.Send');
  });

  it('asks for offline access, because a connection that dies daily is not a connection', () => {
    expect(MICROSOFT_READ_SCOPES).toContain('offline_access');
  });
});
