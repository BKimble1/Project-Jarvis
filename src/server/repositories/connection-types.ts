import type { ConnectionProvider, ConnectionStatus, StoredConnection } from '@/domain/connection';
import type { SealedCredential } from '@/server/security/credential-vault';

export interface ConnectionCredentials {
  readonly accessToken: SealedCredential | null;
  readonly refreshToken: SealedCredential | null;
}

/**
 * The store for provider connections.
 *
 * Reads that the interface uses never return credentials; the one method that does is named so
 * that its call sites are greppable and few.
 */
export interface ConnectionRepository {
  list(): Promise<readonly StoredConnection[]>;
  find(provider: ConnectionProvider): Promise<StoredConnection | null>;

  /**
   * The sealed credentials for a provider.
   *
   * Separated from `find` on purpose: everything that renders a screen or answers a question uses
   * `find`, so a credential cannot reach a template by being on an object that was already there.
   */
  credentials(provider: ConnectionProvider): Promise<ConnectionCredentials | null>;

  /** Record a completed authorization, replacing whatever was there. */
  upsert(input: {
    readonly provider: ConnectionProvider;
    readonly status: ConnectionStatus;
    readonly accountLabel: string | null;
    readonly accountId: string | null;
    readonly grantedScopes: readonly string[];
    readonly accessToken: SealedCredential | null;
    readonly refreshToken: SealedCredential | null;
    readonly expiresAt: Date | null;
    readonly now: Date;
  }): Promise<StoredConnection>;

  /** Replace the stored tokens after a refresh, leaving identity and scopes alone. */
  refreshed(input: {
    readonly provider: ConnectionProvider;
    readonly accessToken: SealedCredential;
    readonly refreshToken: SealedCredential | null;
    readonly expiresAt: Date | null;
    readonly now: Date;
  }): Promise<void>;

  markSynced(provider: ConnectionProvider, at: Date): Promise<void>;
  markFailed(input: {
    readonly provider: ConnectionProvider;
    readonly status: ConnectionStatus;
    readonly message: string;
    readonly at: Date;
  }): Promise<void>;
  setDeltaState(provider: ConnectionProvider, state: Record<string, string>): Promise<void>;

  /**
   * Forget everything about a connection except that it existed.
   *
   * Credentials are nulled rather than the row deleted, so the screen can say "you disconnected
   * this" instead of silently reverting to "never connected" — those are different facts.
   */
  disconnect(provider: ConnectionProvider, at: Date): Promise<void>;
}

export interface OAuthAuthorizationRepository {
  /** Store the state and PKCE verifier for the round trip to the provider. */
  begin(input: {
    readonly state: string;
    readonly provider: ConnectionProvider;
    readonly codeVerifier: string;
    readonly redirectUri: string;
    readonly requestedScopes: readonly string[];
    readonly expiresAt: Date;
    readonly now: Date;
  }): Promise<void>;

  /**
   * Consume a state value exactly once.
   *
   * Returns null when the state is unknown, already used, or expired — the three cases a replayed
   * or forged callback produces, and none of which the caller should be able to tell apart.
   */
  consume(
    state: string,
    now: Date,
  ): Promise<{
    readonly provider: ConnectionProvider;
    readonly codeVerifier: string;
    readonly redirectUri: string;
    readonly requestedScopes: readonly string[];
  } | null>;

  purgeExpired(now: Date): Promise<number>;
}
