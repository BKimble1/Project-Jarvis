import { and, eq, isNull, lt, sql } from 'drizzle-orm';
import {
  sealedCredentialSchema,
  type ConnectionProvider,
  type ConnectionStatus,
  type StoredConnection,
} from '@/domain/connection';
import type { SealedCredential } from '@/server/security/credential-vault';
import type { Database } from '../db/client';
import { oauthAuthorizations, providerConnections } from '../db/schema';
import type {
  ConnectionCredentials,
  ConnectionRepository,
  OAuthAuthorizationRepository,
} from './connection-types';

type Row = typeof providerConnections.$inferSelect;

/** The view the interface gets. Deliberately drops both credential columns on the floor. */
function toStored(row: Row): StoredConnection {
  return {
    id: row.id,
    provider: row.provider,
    status: row.status,
    accountLabel: row.accountLabel,
    accountId: row.accountId,
    grantedScopes: row.grantedScopes ?? [],
    expiresAt: row.expiresAt?.toISOString() ?? null,
    lastSyncAt: row.lastSyncAt?.toISOString() ?? null,
    lastFailureAt: row.lastFailureAt?.toISOString() ?? null,
    lastFailureMessage: row.lastFailureMessage,
    deltaState: row.deltaState ?? {},
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

const sealed = (value: unknown): SealedCredential | null => {
  const parsed = sealedCredentialSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
};

export class DrizzleConnectionRepository implements ConnectionRepository {
  constructor(private readonly db: Database) {}

  async list(): Promise<readonly StoredConnection[]> {
    const rows = await this.db.select().from(providerConnections);
    return rows.map(toStored);
  }

  async find(provider: ConnectionProvider): Promise<StoredConnection | null> {
    const rows = await this.db
      .select()
      .from(providerConnections)
      .where(eq(providerConnections.provider, provider))
      .limit(1);
    const row = rows[0];
    return row ? toStored(row) : null;
  }

  async credentials(provider: ConnectionProvider): Promise<ConnectionCredentials | null> {
    const rows = await this.db
      .select({
        accessToken: providerConnections.accessToken,
        refreshToken: providerConnections.refreshToken,
      })
      .from(providerConnections)
      .where(eq(providerConnections.provider, provider))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    return { accessToken: sealed(row.accessToken), refreshToken: sealed(row.refreshToken) };
  }

  async upsert(input: {
    provider: ConnectionProvider;
    status: ConnectionStatus;
    accountLabel: string | null;
    accountId: string | null;
    grantedScopes: readonly string[];
    accessToken: SealedCredential | null;
    refreshToken: SealedCredential | null;
    expiresAt: Date | null;
    now: Date;
  }): Promise<StoredConnection> {
    const values = {
      status: input.status,
      accountLabel: input.accountLabel,
      accountId: input.accountId,
      grantedScopes: [...input.grantedScopes],
      accessToken: input.accessToken,
      refreshToken: input.refreshToken,
      expiresAt: input.expiresAt,
      lastFailureAt: null,
      lastFailureMessage: null,
      updatedAt: input.now,
    };
    const [row] = await this.db
      .insert(providerConnections)
      .values({ provider: input.provider, ...values, createdAt: input.now })
      .onConflictDoUpdate({ target: providerConnections.provider, set: values })
      .returning();
    if (!row) throw new Error('The connection could not be stored.');
    return toStored(row);
  }

  async refreshed(input: {
    provider: ConnectionProvider;
    accessToken: SealedCredential;
    refreshToken: SealedCredential | null;
    expiresAt: Date | null;
    now: Date;
  }): Promise<void> {
    /*
     * The refresh token is replaced only when the provider issued a new one. Microsoft rotates on
     * every redemption, but a provider that returns nothing means "keep using the one you have" —
     * and overwriting it with null there would silently end the connection at the next refresh.
     */
    await this.db
      .update(providerConnections)
      .set({
        accessToken: input.accessToken,
        ...(input.refreshToken ? { refreshToken: input.refreshToken } : {}),
        expiresAt: input.expiresAt,
        status: 'connected',
        lastFailureAt: null,
        lastFailureMessage: null,
        updatedAt: input.now,
      })
      .where(eq(providerConnections.provider, input.provider));
  }

  async markSynced(provider: ConnectionProvider, at: Date): Promise<void> {
    await this.db
      .update(providerConnections)
      .set({ lastSyncAt: at, status: 'connected', updatedAt: at })
      .where(eq(providerConnections.provider, provider));
  }

  async markFailed(input: {
    provider: ConnectionProvider;
    status: ConnectionStatus;
    message: string;
    at: Date;
  }): Promise<void> {
    await this.db
      .update(providerConnections)
      .set({
        status: input.status,
        lastFailureAt: input.at,
        /* Bounded and redacted by the caller; truncated here so one huge body cannot fill a row. */
        lastFailureMessage: input.message.slice(0, 500),
        updatedAt: input.at,
      })
      .where(eq(providerConnections.provider, input.provider));
  }

  async setDeltaState(provider: ConnectionProvider, state: Record<string, string>): Promise<void> {
    await this.db
      .update(providerConnections)
      .set({ deltaState: state })
      .where(eq(providerConnections.provider, provider));
  }

  async disconnect(provider: ConnectionProvider, at: Date): Promise<void> {
    /*
     * Credentials are removed; the row stays. "You disconnected this" and "you never connected it"
     * are different facts, and the screen should be able to tell them apart.
     */
    await this.db
      .update(providerConnections)
      .set({
        status: 'disconnected',
        accessToken: null,
        refreshToken: null,
        expiresAt: null,
        grantedScopes: [],
        deltaState: {},
        updatedAt: at,
      })
      .where(eq(providerConnections.provider, provider));
  }
}

export class DrizzleOAuthAuthorizationRepository implements OAuthAuthorizationRepository {
  constructor(private readonly db: Database) {}

  async begin(input: {
    state: string;
    provider: ConnectionProvider;
    codeVerifier: string;
    redirectUri: string;
    requestedScopes: readonly string[];
    expiresAt: Date;
    now: Date;
  }): Promise<void> {
    await this.db.insert(oauthAuthorizations).values({
      state: input.state,
      provider: input.provider,
      codeVerifier: input.codeVerifier,
      redirectUri: input.redirectUri,
      requestedScopes: [...input.requestedScopes],
      createdAt: input.now,
      expiresAt: input.expiresAt,
    });
  }

  async consume(state: string, now: Date) {
    /*
     * Consumed by a conditional update rather than read-then-write, so two callbacks carrying the
     * same state cannot both succeed. A replayed authorization code is one of the few things an
     * attacker can obtain from a browser history or a proxy log.
     */
    const [row] = await this.db
      .update(oauthAuthorizations)
      .set({ consumedAt: now })
      .where(
        and(
          eq(oauthAuthorizations.state, state),
          isNull(oauthAuthorizations.consumedAt),
          sql`${oauthAuthorizations.expiresAt} > ${now}`,
        ),
      )
      .returning();

    if (!row) return null;
    return {
      provider: row.provider,
      codeVerifier: row.codeVerifier,
      redirectUri: row.redirectUri,
      requestedScopes: row.requestedScopes ?? [],
    };
  }

  async purgeExpired(now: Date): Promise<number> {
    const rows = await this.db
      .delete(oauthAuthorizations)
      .where(lt(oauthAuthorizations.expiresAt, now))
      .returning({ state: oauthAuthorizations.state });
    return rows.length;
  }
}
