import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { ConfigurationError } from '@/domain/errors';
import { getConfig, type AppConfig } from '@/server/config/env';
import { schema } from './schema';

/**
 * Database access.
 *
 * Three interchangeable PostgreSQL drivers sit behind one `Database` type:
 *  - `neon`   — Neon serverless (WebSocket pool); the recommended Netlify production driver.
 *  - `pg`     — node-postgres; any hosted PostgreSQL (Supabase, RDS, Neon pooled endpoint).
 *  - `pglite` — embedded PostgreSQL for local development and tests only. `buildConfig`
 *               refuses to select it in production.
 *
 * Everything above this module talks to the repository interfaces, so swapping the provider is a
 * change in this file alone.
 */
export type Database = PgDatabase<PgQueryResultHKT, typeof schema>;

interface DatabaseHandle {
  readonly db: Database;
  readonly driver: 'neon' | 'pg' | 'pglite';
  readonly close: () => Promise<void>;
}

const globalRef = globalThis as unknown as { __jarvisDb?: DatabaseHandle | undefined };

async function createHandle(config: AppConfig): Promise<DatabaseHandle> {
  const { driver, url, pgliteDataDir } = config.database;

  if (driver === 'pglite') {
    const { PGlite } = await import('@electric-sql/pglite');
    const { drizzle } = await import('drizzle-orm/pglite');
    const client = pgliteDataDir ? new PGlite(pgliteDataDir) : new PGlite();
    const db = drizzle(client, { schema }) as unknown as Database;
    return { db, driver, close: async () => client.close() };
  }

  if (!url) throw new ConfigurationError('DATABASE_URL is required for hosted PostgreSQL drivers.');

  if (driver === 'neon') {
    const { Pool, neonConfig } = await import('@neondatabase/serverless');
    const { drizzle } = await import('drizzle-orm/neon-serverless');
    if (typeof WebSocket !== 'undefined' && !neonConfig.webSocketConstructor) {
      neonConfig.webSocketConstructor =
        WebSocket as unknown as typeof neonConfig.webSocketConstructor;
    }
    const pool = new Pool({ connectionString: url, max: 1 });
    const db = drizzle(pool, { schema }) as unknown as Database;
    return { db, driver, close: async () => pool.end() };
  }

  const { Pool } = await import('pg');
  const { drizzle } = await import('drizzle-orm/node-postgres');
  const pool = new Pool({
    connectionString: url,
    max: 3,
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 30_000,
  });
  const db = drizzle(pool, { schema }) as unknown as Database;
  return { db, driver, close: async () => pool.end() };
}

let pending: Promise<DatabaseHandle> | null = null;

export async function getDatabaseHandle(config: AppConfig = getConfig()): Promise<DatabaseHandle> {
  if (globalRef.__jarvisDb) return globalRef.__jarvisDb;
  if (!pending) {
    pending = createHandle(config).then((handle) => {
      globalRef.__jarvisDb = handle;
      return handle;
    });
    pending.catch(() => {
      pending = null;
    });
  }
  return pending;
}

export async function getDb(): Promise<Database> {
  return (await getDatabaseHandle()).db;
}

/** Test/CLI helper: install an externally created handle (for example a PGlite test instance). */
export function setDatabaseHandle(handle: DatabaseHandle | undefined): void {
  globalRef.__jarvisDb = handle;
  pending = null;
}

export async function closeDatabase(): Promise<void> {
  const handle = globalRef.__jarvisDb;
  globalRef.__jarvisDb = undefined;
  pending = null;
  if (handle) await handle.close();
}

export type { DatabaseHandle };
