#!/usr/bin/env tsx
/**
 * Visual verification.
 *
 * Boots the app against a seeded demo database, signs in through the test-auth endpoint, and
 * captures every major screen at a desktop and an iPhone viewport. It also reports any page whose
 * document scrolls horizontally, which is the failure mode that matters most on a phone.
 *
 * Screenshots are written to .jarvis-data/screenshots and are not committed.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { chromium, devices } from '@playwright/test';

const PORT = Number(process.env.VISUAL_PORT ?? 3200);
const MOCK_PORT = Number(process.env.VISUAL_MOCK_PORT ?? 3201);
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = '.jarvis-data/visual';
const OUT = path.resolve(process.cwd(), '.jarvis-data/screenshots');
const TEST_SECRET = 'visual-check-secret-value-00001';

const env: NodeJS.ProcessEnv = {
  ...process.env,
  NODE_ENV: 'development',
  JARVIS_BASE_URL: BASE,
  SESSION_SECRET: 'visual-check-session-secret-value-that-is-long',
  OWNER_GITHUB_LOGIN: 'test-owner',
  OWNER_GITHUB_USER_ID: '4242',
  GITHUB_OAUTH_CLIENT_ID: 'visual-client-id',
  GITHUB_OAUTH_CLIENT_SECRET: 'visual-client-secret',
  GITHUB_READ_TOKEN: 'visual-read-token',
  GITHUB_API_BASE_URL: `http://127.0.0.1:${MOCK_PORT}`,
  JARVIS_DB_DRIVER: 'pglite',
  PGLITE_DATA_DIR: DATA_DIR,
  JARVIS_TEST_AUTH_SECRET: TEST_SECRET,
  JARVIS_DEMO_MODE: 'true',
  JARVIS_AI_ENABLED: 'false',
  CRON_SECRET: 'visual-cron-secret-00001',
  LOG_LEVEL: 'error',
  NEXT_TELEMETRY_DISABLED: '1',
};

const children: ChildProcess[] = [];

function start(command: string, args: string[], extra: NodeJS.ProcessEnv = {}): ChildProcess {
  const child = spawn(command, args, {
    env: { ...env, ...extra },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    const text = chunk.toString();
    if (/error|Error/.test(text) && !/DeprecationWarning/.test(text)) process.stderr.write(text);
  });
  children.push(child);
  return child;
}

async function waitFor(url: string, timeoutMs = 240_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.status < 500) return;
    } catch {
      /* not up yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 700));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

function runOnce(command: string, args: string[], extra: NodeJS.ProcessEnv = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env: { ...env, ...extra }, stdio: 'inherit' });
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`)),
    );
  });
}

/**
 * Refuses to run against a server this script did not start.
 *
 * A stale server from an earlier run would serve older code against a freshly seeded database,
 * producing screenshots that quietly disagree with the source — the worst possible failure mode
 * for a visual check.
 */
async function assertPortsFree(): Promise<void> {
  for (const port of [PORT, MOCK_PORT]) {
    try {
      await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1500) });
    } catch {
      continue;
    }
    throw new Error(
      `Port ${port} is already serving. Stop the stale process first, e.g.\n` +
        `  ps aux | grep -E "next dev --port ${PORT}|scripts/mock-github" | grep -v grep | awk '{print $2}' | xargs -r kill -9`,
    );
  }
}

async function main(): Promise<void> {
  await assertPortsFree();
  await rm(path.resolve(process.cwd(), DATA_DIR), { recursive: true, force: true });
  await rm(OUT, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });

  await runOnce('npx', ['tsx', 'scripts/migrate.ts']);
  await runOnce('npx', ['tsx', 'scripts/seed-demo.ts']);

  start('npx', ['tsx', 'scripts/mock-github.mts'], { MOCK_GITHUB_PORT: String(MOCK_PORT) });
  start('npx', ['next', 'dev', '--port', String(PORT)]);

  await waitFor(`${BASE}/signin`);

  const browser = await chromium.launch();
  const problems: string[] = [];

  const pages = [
    { name: 'signin', url: '/signin', auth: false },
    { name: 'dashboard', url: '/dashboard', auth: true },
    { name: 'projects', url: '/projects', auth: true },
    { name: 'project-detail', url: 'FIRST_PROJECT', auth: true },
    { name: 'project-new', url: '/projects/new', auth: true },
    { name: 'project-import', url: '/projects/import', auth: true },
    { name: 'attention', url: '/attention', auth: true },
    { name: 'changes', url: '/changes', auth: true },
    { name: 'settings', url: '/settings', auth: true },
  ];

  for (const [label, viewport] of [
    ['desktop', { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } }],
    ['iphone', devices['iPhone 13']],
  ] as const) {
    const contextOptions = {
      ...viewport,
      colorScheme: label === 'desktop' ? 'light' : 'dark',
    } as const;

    /* A separate, deliberately unauthenticated context so the sign-in screen is captured
       as a signed-out visitor actually sees it. */
    const anonContext = await browser.newContext(contextOptions);
    const anonPage = await anonContext.newPage();

    const context = await browser.newContext(contextOptions);
    await context.request.post(`${BASE}/api/auth/test`, {
      headers: { 'x-jarvis-test-secret': TEST_SECRET },
    });

    const page = await context.newPage();
    for (const watched of [page, anonPage]) {
      watched.on('pageerror', (error) => problems.push(`[${label}] page error: ${error.message}`));
      watched.on('console', (message) => {
        if (message.type() === 'error') problems.push(`[${label}] console: ${message.text()}`);
      });
    }

    let firstProjectUrl: string | null = null;

    for (const entry of pages) {
      let target = entry.url;
      if (target === 'FIRST_PROJECT') {
        if (!firstProjectUrl) {
          await page.goto(`${BASE}/projects`, { waitUntil: 'networkidle' });
          const hrefs = await page
            .locator('a[href^="/projects/"]')
            .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('href') ?? ''));
          firstProjectUrl =
            hrefs.find((href) => /^\/projects\/[0-9a-f-]{36}$/.test(href)) ?? '/projects';
          if (firstProjectUrl === '/projects') {
            problems.push(`[${label}] could not find a project link on /projects`);
          }
        }
        target = firstProjectUrl;
      }

      const active = entry.auth ? page : anonPage;
      await active.goto(`${BASE}${target}`, { waitUntil: 'networkidle', timeout: 120_000 });
      await active.waitForTimeout(600);

      const overflow = await active.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
      }));
      if (overflow.scrollWidth > overflow.clientWidth + 1) {
        problems.push(
          `[${label}] ${entry.name} scrolls horizontally (${overflow.scrollWidth} > ${overflow.clientWidth})`,
        );
      }

      await active.screenshot({
        path: path.join(OUT, `${label}-${entry.name}.png`),
        fullPage: true,
      });
      console.log(`captured ${label}-${entry.name}`);
    }

    await context.close();
    await anonContext.close();
  }

  await browser.close();

  if (problems.length > 0) {
    console.error('\nProblems found:');
    for (const problem of problems) console.error(` - ${problem}`);
  } else {
    console.log('\nNo layout overflow or page errors detected.');
  }
  console.log(`Screenshots in ${OUT}`);
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => {
    for (const child of children) child.kill('SIGTERM');
    setTimeout(() => process.exit(process.exitCode ?? 0), 500);
  });
