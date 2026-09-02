#!/usr/bin/env tsx
/**
 * Worker entry point.
 *
 * `npm run worker`. Reads its configuration from the environment (see `.env.example`), connects
 * to the control plane and starts polling. Nothing here is Next.js: it is a plain Node process.
 */
import { main } from '@/worker/main';

void main().catch((error: unknown) => {
  console.error(`[jarvis-worker] fatal: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
