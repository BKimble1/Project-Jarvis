#!/usr/bin/env tsx
/**
 * Worker entry point.
 *
 * `npm run worker`. Reads its configuration from the environment (see `.env.example`), connects
 * to the control plane and starts polling. Nothing here is Next.js: it is a plain Node process.
 */
import { loadEnvFiles } from './workspaces';
import { main } from '@/worker/main';

/*
 * Load the environment files before anything reads the environment.
 *
 * The worker is a plain Node process, so nothing loads them for it the way Next.js does for the
 * application. Without this, `npm run worker` in a checkout that has perfectly good configuration
 * starts a worker with no token, no model key and no GitHub credential — and the failure looks
 * like "the credential is wrong" rather than "the file was never read". It reads `.env.local` as
 * well as `.env`, because the setup documents tell the owner to create the first one and this
 * script used to read only the second.
 */
loadEnvFiles();

void main().catch((error: unknown) => {
  console.error(`[jarvis-worker] fatal: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
