#!/usr/bin/env tsx
/**
 * Resets the end-to-end database before the application server starts.
 *
 * Opening the embedded database migrates it, so this only has to guarantee a clean directory —
 * every run therefore starts from an empty, freshly migrated schema.
 */
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { getConfig } from '../src/server/config/env';
import { getDatabaseHandle } from '../src/server/db/client';

const dataDir = process.env.PGLITE_DATA_DIR ?? '.jarvis-data/e2e';
await rm(path.resolve(process.cwd(), dataDir), { recursive: true, force: true });

const handle = await getDatabaseHandle(getConfig());
await handle.close();
console.log(`e2e database ready at ${dataDir}.`);
