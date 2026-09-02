import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { schema } from '@/server/db/schema';
import { runMigrations } from '@/server/db/migrate';
import { setDatabaseHandle, type Database, type DatabaseHandle } from '@/server/db/client';

/**
 * Creates a fresh, migrated, in-memory PostgreSQL (PGlite) database for a test file.
 * Because it runs the very same `drizzle/*.sql` migrations as production, integration tests
 * exercise the real schema rather than a hand-written approximation.
 */
export async function createTestDatabase(): Promise<{ db: Database; close: () => Promise<void> }> {
  const client = new PGlite();
  const db = drizzle(client, { schema }) as unknown as Database;
  await runMigrations(db);
  const handle: DatabaseHandle = { db, driver: 'pglite', close: async () => client.close() };
  setDatabaseHandle(handle);
  return {
    db,
    close: async () => {
      setDatabaseHandle(undefined);
      await client.close();
    },
  };
}
