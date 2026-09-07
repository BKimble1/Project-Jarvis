import {
  CONNECTION_PROVIDER_LABELS,
  CONNECTION_STATUS_LABELS,
  type ConnectionProvider,
  type ConnectionStatus,
  type ConnectionView,
  type StoredConnection,
} from '@/domain/connection';
import { PROVIDER_CATALOGUE } from '@/domain/connection-catalogue';
import type { ConnectionRepository } from '@/server/repositories/connection-types';
import type { CredentialVault } from '@/server/security/credential-vault';

/**
 * The one place that says what Jarvis is connected to.
 *
 * ## Why the catalogue decides the status, not the row
 *
 * A provider Jarvis has no implementation for has no row, and a row's absence used to mean
 * "disconnected" — which reads as "click connect". For Apple Reminders that would send Blake
 * looking for a button that cannot exist, because Apple publishes no server interface a Windows
 * application may use. The catalogue is the authority on what is *possible*; the row is only the
 * authority on what has been *done*. Merging them in that order is what keeps the screen honest.
 *
 * ## Why no method here returns a credential
 *
 * Because everything here feeds a screen or an answer. Credentials are fetched by the connector
 * that is about to use one, from `ConnectionRepository.credentials`, which is deliberately a
 * different method with few call sites.
 */
export interface ConnectionServiceDeps {
  readonly connections: ConnectionRepository;
  readonly vault: CredentialVault;
  readonly clock?: () => Date;
}

export class ConnectionService {
  constructor(private readonly deps: ConnectionServiceDeps) {}

  /** Every provider Jarvis knows about, whether or not it has ever been connected. */
  async list(): Promise<readonly ConnectionView[]> {
    const stored = await this.deps.connections.list();
    const byProvider = new Map(stored.map((row) => [row.provider, row]));
    const now = this.deps.clock?.() ?? new Date();
    return PROVIDER_CATALOGUE.map((entry) =>
      this.view(entry.provider, byProvider.get(entry.provider) ?? null, now),
    );
  }

  async get(provider: ConnectionProvider): Promise<ConnectionView> {
    const row = await this.deps.connections.find(provider);
    return this.view(provider, row, this.deps.clock?.() ?? new Date());
  }

  private view(
    provider: ConnectionProvider,
    row: StoredConnection | null,
    now: Date,
  ): ConnectionView {
    const entry = PROVIDER_CATALOGUE.find((item) => item.provider === provider);
    if (!entry) throw new Error(`No catalogue entry for ${provider}.`);

    const status = this.statusFor(entry.supported, row, now);
    const granted = new Set(row?.grantedScopes ?? []);

    return {
      provider,
      providerLabel: CONNECTION_PROVIDER_LABELS[provider],
      status,
      statusLabel: CONNECTION_STATUS_LABELS[status],
      accountLabel:
        status === 'connected' || status === 'degraded' ? (row?.accountLabel ?? null) : null,
      capabilities: entry.capabilities.map((capability) => ({
        ...capability,
        granted: capability.scope === null ? status === 'connected' : granted.has(capability.scope),
      })),
      lastSyncAt: row?.lastSyncAt ?? null,
      lastFailureAt: row?.lastFailureAt ?? null,
      lastFailureMessage: row?.lastFailureMessage ?? null,
      recovery: this.recoveryFor(status, entry.supported),
      expiresAt: row?.expiresAt ?? null,
      canSee: status === 'connected' || status === 'degraded' ? entry.canSee : [],
      /*
       * An unsupported provider always says what it cannot see. A supported one that is not yet
       * connected says so too — "nothing yet" is a more useful answer than an empty list.
       */
      cannotSee:
        status === 'connected'
          ? entry.cannotSeeWhenConnected
          : [entry.notConnectedMeaning, ...entry.cannotSeeWhenConnected],
      connectable: entry.supported,
    };
  }

  /**
   * The status, decided in a fixed order.
   *
   * Unsupported first and unconditionally: a provider with no official interface cannot become
   * connected by any amount of configuration, and letting a stale row override that would put a
   * "Connected" badge on something that does not work.
   */
  private statusFor(supported: boolean, row: StoredConnection | null, now: Date): ConnectionStatus {
    if (!supported) return 'unsupported';
    if (!row) return 'needs_authorization';
    if (row.status === 'disconnected') return 'disconnected';
    if (row.status === 'reauthorization_required') return 'reauthorization_required';
    /*
     * An expired access token is not by itself a reason to ask Blake for anything — that is what
     * the refresh token is for. Only a refresh that has actually failed sets
     * `reauthorization_required`, and it does so explicitly.
     */
    if (row.status === 'degraded') return 'degraded';
    if (row.lastFailureAt && !row.lastSyncAt) return 'degraded';
    if (row.status === 'needs_authorization') return 'needs_authorization';
    void now;
    return 'connected';
  }

  private recoveryFor(status: ConnectionStatus, supported: boolean): string | null {
    if (!supported) return null;
    switch (status) {
      case 'needs_authorization':
        return 'Connect it from this screen. You will be sent to the provider to sign in.';
      case 'reauthorization_required':
        return 'The stored authorization no longer works. Connect it again to grant a fresh one.';
      case 'degraded':
        return 'The last synchronization failed. Jarvis will retry; if it keeps failing, reconnect.';
      case 'disconnected':
        return 'You disconnected this. Connect it again whenever you want it back.';
      default:
        return null;
    }
  }

  /** Whether credentials can be stored at all. Shown once at the top of the screen, not per row. */
  vaultReady(): boolean {
    return this.deps.vault.isConfigured();
  }
}
