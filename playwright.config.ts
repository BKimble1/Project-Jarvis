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
/*
 * A second, separate mock for the worker's *write* path. The read-only mock above refuses every
 * write method with a 405, and that refusal is a property the Prompt 1 suite depends on; adding
 * pull-request endpoints to it would quietly remove the guarantee.
 */
const MOCK_WRITE_PORT = Number(process.env.E2E_MOCK_GITHUB_WRITE_PORT ?? 3125);
const BASE_URL = `http://127.0.0.1:${PORT}`;

/*
 * The generated-answer run.
 *
 * The suite runs in the state a fresh install is in — no writing model — because that is what
 * most owners meet and because the evidence-only path is the one that has to stay honest. The
 * generated path still needs browser coverage, so `npm run test:e2e:model` sets this, which swaps
 * in a deterministic stand-in and runs only the spec that exercises it. Keeping them separate
 * keeps the five-run gate on one configuration rather than two, and keeps the memory profile of
 * that gate unchanged.
 */
const scriptedProvider = process.env.JARVIS_ASK_SCRIPTED_PROVIDER === 'true';

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
  ...(scriptedProvider ? { JARVIS_ASK_SCRIPTED_PROVIDER: 'true' } : {}),
  JARVIS_MISSION_CONCURRENCY: '1',
  /* Read only by next.config.ts, to drop source maps this run never reads. See that file. */
  JARVIS_E2E: '1',
  LOG_LEVEL: 'warn',
  NEXT_TELEMETRY_DISABLED: '1',
  /*
   * A heap sized for the job.
   *
   * Next's development server restarts itself when used heap exceeds 80% of the heap limit. The
   * default limit on a 16GB machine is 8240MB, so it trips at about 6.6GB — which this
   * application reaches while serving a full suite, taking in-flight requests down with it. The
   * restart is the failure; the heap is the cause. 10240MB moves the trigger to roughly 8.2GB
   * while leaving several gigabytes for Chromium and the embedded database, and it is paired
   * with `webpackMemoryOptimizations` so the ceiling is raised *and* the usage lowered rather
   * than only the former.
   */
  NODE_OPTIONS: '--max-old-space-size=10240',
};

export default defineConfig({
  testDir: './tests/e2e',
  /*
   * One configuration per run. With the stand-in on, only the spec written for it runs; with it
   * off — the default, and the one the five-run gate uses — that spec is not collected at all, so
   * a generated-answer assertion can never quietly pass against evidence-only output.
   */
  ...(scriptedProvider
    ? { testMatch: ['**/ask-model.spec.ts'] }
    : { testIgnore: ['**/ask-model.spec.ts'] }),
  /*
   * Compile the application before any test times itself against it.
   *
   * `webServer.port` below reports ready when the port accepts a connection, which for `next dev`
   * happens long before a route can be served — routes compile on first request. Without this the
   * first test to navigate somewhere pays for compiling it inside its own timeout, which is what
   * made this suite fail once per run in a different test each time. See the file for the
   * measurements.
   */
  globalSetup: './tests/e2e/global-setup.ts',
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
    {
      name: 'iphone',
      use: {
        ...devices['iPhone 13'],
        /*
         * The iPhone descriptor selects WebKit by default. Only Chromium is provisioned here and
         * in CI, so the viewport, user agent, touch and mobile flags are emulated with Chromium
         * instead — which is what the layout assertions actually exercise.
         */
        browserName: 'chromium',
        defaultBrowserType: 'chromium',
      },
    },
  ],
  webServer: [
    {
      command: 'npx tsx scripts/mock-github.mts',
      port: MOCK_PORT,
      reuseExistingServer: false,
      env: { MOCK_GITHUB_PORT: String(MOCK_PORT) },
      stdout: 'ignore',
      stderr: 'pipe',
    },
    {
      command: 'npx tsx scripts/mock-github-write.mts',
      port: MOCK_WRITE_PORT,
      reuseExistingServer: false,
      env: { MOCK_GITHUB_WRITE_PORT: String(MOCK_WRITE_PORT) },
      stdout: 'ignore',
      stderr: 'pipe',
    },
    {
      command:
        'npx tsx scripts/e2e-prepare.mts && npx tsx scripts/e2e-sandbox.mts && npx next dev --port ' +
        PORT,
      port: PORT,
      /*
       * Never reuse a server this run did not start. The end-to-end database is file-backed and
       * only reset by `e2e-prepare`, which runs as part of this command — reusing an old server
       * would silently test yesterday's data against today's code.
       */
      reuseExistingServer: false,
      timeout: 240_000,
      env: appEnv,
      /*
       * Piped, not ignored.
       *
       * Next announces a restart — "Found a change in package.json", "approaching the used memory
       * threshold" — on stdout. Discarding it meant a restart was invisible and surfaced only as
       * an `ECONNRESET` in whichever test held a request at that moment, which is a diagnosis
       * that costs hours. It is worth the compile lines.
       */
      stdout: 'pipe',
      stderr: 'pipe',
    },
  ],
});
