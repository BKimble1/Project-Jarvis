import { defineConfig } from 'vitest/config';
import path from 'node:path';

/**
 * Three projects:
 *  - `unit`        — pure logic (status rules, parsing, validation, normalisation). No I/O.
 *  - `integration` — the real services against a migrated in-memory PostgreSQL (PGlite).
 *  - `live`        — a real Claude session on the owner's own subscription. Opt-in.
 *
 * The third one is different in kind and is kept apart for that reason. It needs a Claude Code
 * login on this machine and it spends a small amount of the owner's subscription capacity, so a
 * suite that included it would sometimes cost money and sometimes fail because a login expired —
 * and a suite like that is one people stop running, taking the cheap deterministic tests with it.
 *
 * Its `include` is empty unless `JARVIS_LIVE_TESTS=true`, so `vitest run` cannot pick it up by
 * accident. `npm run test:live` sets it. Nothing in there falls back to a stub when the login is
 * missing: a green "live" tick that never reached Anthropic is worse than a red one.
 */
const LIVE_ENABLED = process.env.JARVIS_LIVE_TESTS === 'true';
export default defineConfig({
  resolve: {
    alias: { '@': path.resolve(import.meta.dirname, './src') },
  },
  test: {
    globals: false,
    environment: 'node',
    pool: 'forks',
    projects: [
      {
        resolve: { alias: { '@': path.resolve(import.meta.dirname, './src') } },
        test: {
          name: 'unit',
          include: ['tests/unit/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        resolve: { alias: { '@': path.resolve(import.meta.dirname, './src') } },
        test: {
          name: 'live',
          include: LIVE_ENABLED ? ['tests/live/**/*.live.test.ts'] : [],
          environment: 'node',
          /* A real model session, on somebody's home connection. */
          testTimeout: 180_000,
          hookTimeout: 180_000,
          fileParallelism: false,
        },
      },
      {
        resolve: { alias: { '@': path.resolve(import.meta.dirname, './src') } },
        test: {
          name: 'integration',
          include: ['tests/integration/**/*.test.ts'],
          environment: 'node',
          testTimeout: 60_000,
          hookTimeout: 60_000,
          /* PGlite instances are heavy; one file at a time keeps memory predictable. */
          fileParallelism: false,
        },
      },
    ],
    coverage: {
      provider: 'v8',
      reportsDirectory: 'coverage',
      include: ['src/domain/**', 'src/server/**'],
      exclude: ['src/server/db/schema.ts', '**/*.d.ts'],
    },
  },
});
