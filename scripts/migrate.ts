#!/usr/bin/env tsx
/**
 * Applies every pending SQL migration using the driver the current environment is configured for.
 * Run locally with `npm run db:migrate`; Netlify runs it as part of the build command.
 */
import { loadEnvFiles } from './workspaces';
import { getDatabaseHandle } from '../src/server/db/client';
import { runMigrations } from '../src/server/db/migrate';
import { getConfig } from '../src/server/config/env';

/*
 * Before anything reads the environment: `.env.local`, then `.env`.
 *
 * This script is the reason the loader exists. It used to read `.env` only, so an owner who
 * followed the setup documents and put `DATABASE_URL` in `.env.local` migrated the local PGlite
 * database instead — and this printed "up to date" and exited 0 about a database nobody asked it
 * to touch.
 */
loadEnvFiles();

async function main(): Promise<void> {
  const config = getConfig();
  const handle = await getDatabaseHandle(config);
  console.log(`Applying migrations using the "${handle.driver}" driver…`);
  const result = await runMigrations(handle.db);
  if (result.applied.length === 0) {
    console.log(`Database is up to date (${result.skipped.length} migration(s) already applied).`);
  } else {
    for (const name of result.applied) console.log(`  applied ${name}`);
  }
  await handle.close();
}

main().catch((error: unknown) => {
  console.error('Migration failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
