#!/usr/bin/env tsx
/** Seeds explicitly fictional demo data. Refuses to run against a non-demo configuration. */
import 'dotenv/config';
import { getConfig } from '../src/server/config/env';
import { getDatabaseHandle } from '../src/server/db/client';
import { runMigrations } from '../src/server/db/migrate';
import { buildServices } from '../src/server/container';
import { seedDemoData } from '../src/server/demo/seed';

async function main(): Promise<void> {
  const config = getConfig();
  if (!config.demoMode) {
    console.error('Refusing to seed: set JARVIS_DEMO_MODE=true first.');
    process.exitCode = 1;
    return;
  }
  const handle = await getDatabaseHandle(config);
  await runMigrations(handle.db);
  const services = buildServices(handle.db, config);
  const result = await seedDemoData(services);
  if (result.projectIds.length === 0) {
    console.log('Database already contains projects; nothing was seeded.');
  } else {
    console.log(
      `Seeded ${result.projectIds.length} demo projects and ${result.evidenceWritten} evidence records.`,
    );
  }
  await handle.close();
}

main().catch((error: unknown) => {
  console.error('Demo seed failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
