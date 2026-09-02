import { defineConfig } from 'vitest/config';
import path from 'node:path';

/**
 * Two projects:
 *  - `unit`        — pure logic (status rules, parsing, validation, normalisation). No I/O.
 *  - `integration` — the real services against a migrated in-memory PostgreSQL (PGlite).
 */
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
