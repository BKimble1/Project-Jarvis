import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end configuration.
 *
 * The suite runs against the real application with two fakes and nothing else:
 *  - a local mock GitHub API, so importing and synchronising are exercised without the network;
 *  - the signed test-auth endpoint, which `buildConfig` refuses to enable in production.
 *
 * The database is a file-backed PGlite instance under `.jarvis-data/e2e`, migrated on boot,
 * so a run leaves no external state behind.
 */
const PORT = Number(process.env.E2E_PORT ?? 3123);
const MOCK_PORT = Number(process.env.E2E_MOCK_GITHUB_PORT ?? 3124);
const BASE_URL = `http://127.0.0.1:${PORT}`;

const appEnv = {
  NODE_ENV: 'development',
  JARVIS_BASE_URL: BASE_URL,
  SESSION_SECRET: 'e2e-session-secret-value-that-is-long-enough-000',
  OWNER_GITHUB_LOGIN: 'test-owner',
  OWNER_GITHUB_USER_ID: '4242',
  GITHUB_OAUTH_CLIENT_ID: 'e2e-client-id',
  GITHUB_OAUTH_CLIENT_SECRET: 'e2e-client-secret',
  GITHUB_READ_TOKEN: 'e2e-read-token',
  GITHUB_API_BASE_URL: `http://127.0.0.1:${MOCK_PORT}`,
  JARVIS_DB_DRIVER: 'pglite',
  PGLITE_DATA_DIR: '.jarvis-data/e2e',
  JARVIS_TEST_AUTH_SECRET: 'e2e-test-auth-secret-value-0001',
  CRON_SECRET: 'e2e-cron-secret-value-0001',
  JARVIS_AI_ENABLED: 'false',
  LOG_LEVEL: 'warn',
  NEXT_TELEMETRY_DISABLED: '1',
};

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  timeout: 90_000,
  expect: { timeout: 15_000 },
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    actionTimeout: 20_000,
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    { name: 'iphone', use: { ...devices['iPhone 13'] } },
  ],
  webServer: [
    {
      command: 'npx tsx scripts/mock-github.mts',
      port: MOCK_PORT,
      reuseExistingServer: !process.env.CI,
      env: { MOCK_GITHUB_PORT: String(MOCK_PORT) },
      stdout: 'ignore',
      stderr: 'pipe',
    },
    {
      command: 'npx tsx scripts/e2e-prepare.mts && npx next dev --port ' + PORT,
      port: PORT,
      reuseExistingServer: !process.env.CI,
      timeout: 240_000,
      env: appEnv,
      stdout: 'ignore',
      stderr: 'pipe',
    },
  ],
});
