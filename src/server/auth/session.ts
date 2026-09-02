import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { and, eq, lt } from 'drizzle-orm';
import type { Database } from '@/server/db/client';
import { sessions } from '@/server/db/schema';

/**
 * Server-side sessions.
 *
 * The browser only ever holds an opaque random token; every attribute of the session lives in
 * the database, keyed by the token's SHA-256 hash. Nothing about the owner — not the login, not
 * the GitHub id — is readable from the cookie, and revoking access is a single row delete.
 */

export const SESSION_COOKIE = 'jarvis_session';

export interface OwnerSession {
  readonly id: string;
  readonly githubLogin: string | null;
  readonly githubUserId: string | null;
  readonly displayName: string | null;
  readonly avatarUrl: string | null;
  readonly createdAt: string;
  readonly expiresAt: string;
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function generateSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

/** Constant-time comparison for shared secrets (cron, test auth). */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export interface CreateSessionInput {
  readonly githubLogin: string | null;
  readonly githubUserId: string | null;
  readonly displayName: string | null;
  readonly avatarUrl: string | null;
  readonly ttlHours: number;
  readonly userAgent?: string | null;
}

export class SessionStore {
  constructor(private readonly db: Database) {}

  async create(input: CreateSessionInput): Promise<{ token: string; session: OwnerSession }> {
    const token = generateSessionToken();
    const expiresAt = new Date(Date.now() + input.ttlHours * 3_600_000);
    const rows = await this.db
      .insert(sessions)
      .values({
        tokenHash: hashToken(token),
        githubLogin: input.githubLogin,
        githubUserId: input.githubUserId,
        displayName: input.displayName,
        avatarUrl: input.avatarUrl,
        expiresAt,
        userAgentHash: input.userAgent ? hashToken(input.userAgent).slice(0, 32) : null,
      })
      .returning();
    const row = rows[0];
    if (!row) throw new Error('Could not create a session.');
    return { token, session: toSession(row) };
  }

  async find(token: string): Promise<OwnerSession | null> {
    if (!token) return null;
    const rows = await this.db
      .select()
      .from(sessions)
      .where(eq(sessions.tokenHash, hashToken(token)))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    if (new Date(row.expiresAt).getTime() <= Date.now()) {
      await this.destroy(token);
      return null;
    }
    await this.db.update(sessions).set({ lastSeenAt: new Date() }).where(eq(sessions.id, row.id));
    return toSession(row);
  }

  async destroy(token: string): Promise<void> {
    await this.db.delete(sessions).where(eq(sessions.tokenHash, hashToken(token)));
  }

  async destroyAll(): Promise<void> {
    await this.db.delete(sessions);
  }

  async purgeExpired(now = new Date()): Promise<number> {
    const rows = await this.db
      .delete(sessions)
      .where(lt(sessions.expiresAt, now))
      .returning({ id: sessions.id });
    return rows.length;
  }
}

function toSession(row: typeof sessions.$inferSelect): OwnerSession {
  return {
    id: row.id,
    githubLogin: row.githubLogin,
    githubUserId: row.githubUserId,
    displayName: row.displayName,
    avatarUrl: row.avatarUrl,
    createdAt: new Date(row.createdAt).toISOString(),
    expiresAt: new Date(row.expiresAt).toISOString(),
  };
}

/* --------------------------------------------------------------- oauth state */

export class OAuthStateStore {
  constructor(private readonly db: Database) {}

  async issue(redirectTo: string | null, ttlSeconds = 600): Promise<string> {
    const { oauthStates } = await import('@/server/db/schema');
    const state = randomBytes(24).toString('base64url');
    await this.db.insert(oauthStates).values({
      stateHash: hashToken(state),
      redirectTo,
      expiresAt: new Date(Date.now() + ttlSeconds * 1000),
    });
    return state;
  }

  /** Single-use: the row is deleted whether or not it was still valid. */
  async consume(state: string): Promise<{ ok: boolean; redirectTo: string | null }> {
    const { oauthStates } = await import('@/server/db/schema');
    const hash = hashToken(state);
    const rows = await this.db
      .select()
      .from(oauthStates)
      .where(eq(oauthStates.stateHash, hash))
      .limit(1);
    await this.db.delete(oauthStates).where(eq(oauthStates.stateHash, hash));
    const row = rows[0];
    if (!row) return { ok: false, redirectTo: null };
    if (new Date(row.expiresAt).getTime() <= Date.now()) return { ok: false, redirectTo: null };
    return { ok: true, redirectTo: row.redirectTo };
  }

  async purgeExpired(now = new Date()): Promise<number> {
    const { oauthStates } = await import('@/server/db/schema');
    const rows = await this.db
      .delete(oauthStates)
      .where(and(lt(oauthStates.expiresAt, now)))
      .returning({ id: oauthStates.id });
    return rows.length;
  }
}
