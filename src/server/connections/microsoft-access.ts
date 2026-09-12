import { ConfigurationError, ForbiddenError } from '@/domain/errors';
import { MICROSOFT_READ_SCOPES } from '@/domain/connection-catalogue';
import type { ConnectionRepository } from '@/server/repositories/connection-types';
import type { CredentialVault } from '@/server/security/credential-vault';
import {
  isConfigured,
  refreshAccessToken,
  type MicrosoftOAuthConfig,
  type TokenFetch,
} from '@/server/connections/microsoft-oauth';

/**
 * Where a usable Microsoft access token comes from.
 *
 * This is the only place that opens a Microsoft credential, and it is deliberately small: it reads
 * the sealed pair, decides whether the access token still has life in it, and refreshes when it
 * does not. Nothing that renders a screen goes through here, so a token cannot reach a template by
 * riding along on an object somebody was already passing around.
 *
 * ## Why a refresh failure ends the connection instead of retrying
 *
 * Microsoft rotates refresh tokens: redeeming one invalidates it and issues another. A redemption
 * that fails therefore leaves nothing to retry with — the old token is gone whether or not the new
 * one arrived. Marking the connection `reauthorization_required` immediately is the honest state,
 * and it puts a "connect it again" line on the Connections screen instead of a background loop
 * that fails quietly every fifteen minutes.
 *
 * ## Why the token is never cached across requests
 *
 * It would have to live somewhere, and every somewhere is a place a heap dump or a log line could
 * find it. Reading two small columns and running one AES-GCM open is cheap next to an HTTP round
 * trip to Graph, so the token is fetched, used, and dropped.
 */

/** Refresh this far ahead of expiry, so a call that takes a moment does not start on a dead token. */
export const REFRESH_SKEW_MS = 5 * 60 * 1000;

export const ACCESS_AAD = 'connection:microsoft:access';
export const REFRESH_AAD = 'connection:microsoft:refresh';

export interface MicrosoftAccessDeps {
  readonly connections: ConnectionRepository;
  readonly vault: CredentialVault;
  readonly config: MicrosoftOAuthConfig;
  readonly fetchImpl?: TokenFetch;
  readonly clock?: () => Date;
}

/** Why Jarvis cannot read the account right now, in a form the caller can act on. */
export class MicrosoftNotConnectedError extends ForbiddenError {
  constructor(message: string) {
    super(message);
    this.name = 'MicrosoftNotConnectedError';
  }
}

export class MicrosoftAccess {
  constructor(private readonly deps: MicrosoftAccessDeps) {}

  private now(): Date {
    return this.deps.clock?.() ?? new Date();
  }

  /** True when there is a connected account and a key to open its credentials with. */
  async isReady(): Promise<boolean> {
    if (!this.deps.vault.isConfigured() || !isConfigured(this.deps.config)) return false;
    const row = await this.deps.connections.find('microsoft');
    return row !== null && row.status !== 'disconnected' && row.status !== 'needs_authorization';
  }

  /** The scopes Microsoft actually granted, which is not always the set that was requested. */
  async grantedScopes(): Promise<readonly string[]> {
    const row = await this.deps.connections.find('microsoft');
    return row?.grantedScopes ?? [];
  }

  /**
   * A bearer token that is good right now.
   *
   * Refuses rather than returns something unusable: every failure mode here — no row, no key, no
   * refresh token, a refusal from Microsoft — produces an error that names the next action.
   */
  async accessToken(): Promise<string> {
    if (!this.deps.vault.isConfigured()) {
      throw new ConfigurationError(
        'No credential key is configured, so stored Microsoft credentials cannot be opened. See docs/PERSONAL_ASSISTANT_SETUP.md.',
      );
    }
    const row = await this.deps.connections.find('microsoft');
    if (!row || row.status === 'disconnected' || row.status === 'needs_authorization') {
      throw new MicrosoftNotConnectedError('Outlook is not connected yet.');
    }
    if (row.status === 'reauthorization_required') {
      throw new MicrosoftNotConnectedError(
        'The stored Microsoft authorization no longer works. Connect the account again.',
      );
    }

    const credentials = await this.deps.connections.credentials('microsoft');
    if (!credentials) throw new MicrosoftNotConnectedError('Outlook is not connected yet.');

    const now = this.now();
    const expiresAt = row.expiresAt ? new Date(row.expiresAt) : null;
    const stillGood =
      credentials.accessToken !== null &&
      expiresAt !== null &&
      expiresAt.getTime() - now.getTime() > REFRESH_SKEW_MS;

    if (stillGood) {
      return this.deps.vault.open(credentials.accessToken!, ACCESS_AAD);
    }

    if (!credentials.refreshToken) {
      await this.fail('Microsoft did not leave a refresh token, so the session cannot be renewed.');
      throw new MicrosoftNotConnectedError(
        'The Microsoft session has expired and cannot be renewed. Connect the account again.',
      );
    }

    return this.refresh(this.deps.vault.open(credentials.refreshToken, REFRESH_AAD), now);
  }

  private async refresh(refreshToken: string, now: Date): Promise<string> {
    if (!isConfigured(this.deps.config)) {
      throw new ConfigurationError(
        'Microsoft is not configured. Set MICROSOFT_CLIENT_ID and MICROSOFT_CLIENT_SECRET.',
      );
    }
    let tokens;
    try {
      tokens = await refreshAccessToken(
        this.deps.config,
        refreshToken,
        MICROSOFT_READ_SCOPES,
        this.deps.fetchImpl ?? fetch,
        now,
      );
    } catch {
      /* The provider's own words are not carried through: they echo the token that was sent. */
      await this.fail('Microsoft refused to renew the session.');
      throw new MicrosoftNotConnectedError(
        'Microsoft would not renew the session. Connect the account again.',
      );
    }

    await this.deps.connections.refreshed({
      provider: 'microsoft',
      accessToken: this.deps.vault.seal(tokens.accessToken, ACCESS_AAD),
      refreshToken: tokens.refreshToken
        ? this.deps.vault.seal(tokens.refreshToken, REFRESH_AAD)
        : null,
      expiresAt: tokens.expiresAt,
      now,
    });
    return tokens.accessToken;
  }

  private async fail(message: string): Promise<void> {
    await this.deps.connections.markFailed({
      provider: 'microsoft',
      status: 'reauthorization_required',
      message,
      at: this.now(),
    });
  }
}
