import { defineConfig } from 'drizzle-kit';

/**
 * drizzle-kit only ever generates SQL from the schema here; migrations are applied by
 * `scripts/migrate.ts`, which uses whichever driver the running environment is configured for.
 */
export default defineConfig({
  schema: './src/server/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  strict: true,
  verbose: false,
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgres://localhost:5432/jarvis',
  },
});
