#!/usr/bin/env tsx
/**
 * Worker entry point.
 *
 * `npm run worker`. Reads its configuration from the environment (see `.env.example`), connects
 * to the control plane and starts polling. Nothing here is Next.js: it is a plain Node process.
 */
/*
 * Load `.env` before anything reads the environment.
 *
 * The worker is a plain Node process, so nothing loads `.env` for it the way Next.js does for
 * the application. Without this, `npm run worker` in a checkout that has a perfectly good `.env`
 * starts a worker with no token, no model key and no GitHub credential — and the failure looks
 * like "the credential is wrong" rather than "the file was never read". Real environment
 * variables still win: `dotenv` does not overwrite what is already set, which is what keeps a
 * systemd `EnvironmentFile` or a Docker `--env-file` authoritative.
 */
import 'dotenv/config';
import { main } from '@/worker/main';

void main().catch((error: unknown) => {
  console.error(`[jarvis-worker] fatal: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
