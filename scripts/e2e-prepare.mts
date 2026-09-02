#!/usr/bin/env tsx
/** Resets and migrates the end-to-end PGlite database before the app server starts. */
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { getConfig } from '../src/server/config/env';
import { getDatabaseHandle } from '../src/server/db/client';
import { runMigrations } from '../src/server/db/migrate';

const dataDir = process.env.PGLITE_DATA_DIR ?? '.jarvis-data/e2e';
await rm(path.resolve(process.cwd(), dataDir), { recursive: true, force: true });

const handle = await getDatabaseHandle(getConfig());
const result = await runMigrations(handle.db);
console.log(`e2e database ready (${result.applied.length} migration(s) applied).`);
await handle.close();
