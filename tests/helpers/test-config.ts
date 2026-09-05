import { buildConfig, type AppConfig } from '@/server/config/env';

/** A complete, valid non-production configuration for tests. */
export function testConfig(overrides: Record<string, string | undefined> = {}): AppConfig {
  return buildConfig({
    NODE_ENV: 'test',
    JARVIS_BASE_URL: 'http://localhost:3000',
    SESSION_SECRET: 'test-session-secret-value-that-is-long-enough',
    OWNER_GITHUB_LOGIN: 'test-owner',
    OWNER_GITHUB_USER_ID: '4242',
    GITHUB_OAUTH_CLIENT_ID: 'client-id',
    GITHUB_OAUTH_CLIENT_SECRET: 'client-secret',
    GITHUB_READ_TOKEN: 'read-token',
    JARVIS_DB_DRIVER: 'pglite',
    CRON_SECRET: 'cron-secret-value-0001',
    JARVIS_AI_ENABLED: 'false',
    LOG_LEVEL: 'error',
    ...overrides,
  } as NodeJS.ProcessEnv);
}
