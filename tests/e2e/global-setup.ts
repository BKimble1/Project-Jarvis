import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import type { FullConfig } from '@playwright/test';

/**
 * Compile the application before any test is allowed to time itself against it.
 *
 * ## The defect this exists to fix
 *
 * Playwright's `webServer.port` probe considers the server ready as soon as the port accepts a TCP
 * connection. For `next dev` that is true long before the application can actually serve anything:
 * routes are compiled **lazily, on first request**. So the first test to navigate somewhere pays
 * for compiling it, inside its own timeout, and the bill is large — measured on this repository:
 *
 * | route      | first request | subsequent | ratio |
 * |------------|---------------|------------|-------|
 * | `/signin`  | 24 s          | —          | —     |
 * | `/knowledge` | 12.8 s      | 160 ms     | 80×   |
 * | `/missions`  | 6.9 s       | 155 ms     | 45×   |
 *
 * That produced a suite which failed once per full run, in a *different* test each time, while
 * every one of those tests passed comfortably in isolation — because in isolation there are far
 * fewer routes to compile and the victim is whoever happens to touch an uncompiled one first. It
 * looked like resource contention and was misdiagnosed as such; it is on-demand compilation being
 * charged to whichever test triggers it.
 *
 * ## Why warming rather than a production build
 *
 * `next build && next start` would compile everything ahead of time, but it forces
 * `NODE_ENV=production`, and this application deliberately refuses to honour the signed test-auth
 * endpoint or a plain-`http` base URL in production. Those refusals are load-bearing security
 * behaviour, so the fix is not to weaken them for the convenience of the test runner.
 *
 * Instead this replaces the readiness condition. Every *page* is requested once here, under this
 * file's own budget, so that when the first test starts, "ready" means the pages are compiled
 * rather than merely listening.
 *
 * ## Why pages and not every route
 *
 * Warming all ninety routes — pages and API handlers together — fixed the compile problem and
 * created a second one. Next's dev server holds every compiled route in memory, and with all
 * ninety loaded it approached its heap limit mid-run and did what it does then:
 *
 *     ⚠ Server is approaching the used memory threshold, restarting...
 *
 * An in-flight request during that restart fails with `ECONNRESET`, and the restart discards
 * every compiled route so the run pays the whole bill again — one observed run took 573s instead
 * of 353s and failed. So warming everything traded a compile problem for a memory one.
 *
 * Pages are the right subset, and not as a compromise. They are what a navigation blocks on and
 * they are where the cost actually is: measured, `/knowledge` took 12.8s and `/missions` 6.9s,
 * while API handlers were mostly one to two seconds — comfortably inside a test's budget, and
 * only paid for the handful of endpoints a test actually calls. Roughly forty-five of those
 * ninety routes are never touched by any test, so warming them bought nothing and cost heap.
 *
 * Pages are still enumerated from the filesystem, so a page added later is covered automatically
 * — which is the property that matters, because a missing page is the expensive case. A short,
 * explicit list of API endpoints is warmed alongside them: not because they are slow, but because
 * the ones the fixtures call compile inside *setup or teardown*, where a timeout is reported
 * against an unrelated test.
 */

/** A fixed id for dynamic segments. Next compiles per route *pattern*, so any value warms it. */
const PLACEHOLDER_ID = '00000000-0000-4000-8000-000000000000';

/**
 * The handful of API routes worth warming too.
 *
 * Pages are where the seconds are, but a few endpoints are called by the fixtures rather than by
 * a test body — creating and deleting the scenario's projects — and a compile charged to a
 * fixture surfaces as a *teardown* timeout, which reads like an unrelated failure in whatever
 * test happened to be last. That is exactly how the original instability disguised itself, so the
 * endpoints the fixtures use are warmed here rather than left to be discovered again.
 *
 * Deliberately a short explicit list. Warming all forty-five API routes is what previously drove
 * the dev server into its memory guard.
 */
const WARM_API = [
  '/api/projects',
  `/api/projects/${'00000000-0000-4000-8000-000000000000'}`,
  '/api/knowledge/sources',
  '/api/knowledge/memories',
  '/api/missions',
  '/api/ask',
  '/api/ask/conversations',
];

/** Routes that must not be warmed: they change state or belong to another auth surface. */
const SKIP = new Set([
  /* Ends the owner session that warming just created. */
  '/api/auth/signout',
  /* Begins an OAuth redirect to GitHub. */
  '/api/auth/start',
  '/api/auth/callback',
]);

function routesUnder(root: string, filename: 'page.tsx' | 'route.ts'): string[] {
  const found: string[] = [];

  const walk = (dir: string, urlPath: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }

    for (const entry of entries) {
      const full = path.join(dir, entry);
      if (entry === filename) {
        found.push(urlPath === '' ? '/' : urlPath);
        continue;
      }
      if (!statSync(full).isDirectory()) continue;

      /* `(app)` and friends are route groups: they organise files without adding a URL segment. */
      const segment = entry.startsWith('(') && entry.endsWith(')') ? '' : entry;
      const next = segment.startsWith('[')
        ? `${urlPath}/${PLACEHOLDER_ID}`
        : `${urlPath}/${segment}`;
      walk(full, segment === '' ? urlPath : next);
    }
  };

  walk(root, '');
  return found;
}

async function globalSetup(config: FullConfig): Promise<void> {
  const baseURL =
    config.projects[0]?.use?.baseURL ?? `http://127.0.0.1:${process.env.E2E_PORT ?? 3123}`;
  const verbose = process.env.E2E_TRACE_WARMUP === '1';
  const started = Date.now();

  const appRoot = path.resolve(process.cwd(), 'src/app');
  const pages = routesUnder(appRoot, 'page.tsx');

  /*
   * Warm as the owner. An unauthenticated request to a private page redirects, and although the
   * page module still compiles, the authenticated render path pulls in the component tree that
   * actually costs the seconds — so warming signed out would leave most of the bill unpaid.
   */
  let cookie = '';
  try {
    const secret = process.env.JARVIS_TEST_AUTH_SECRET ?? 'e2e-test-auth-secret-value-0001';
    const response = await fetch(`${baseURL}/api/auth/test`, {
      method: 'POST',
      headers: { 'x-jarvis-test-secret': secret },
    });
    cookie = response.headers.getSetCookie().find((c) => c.startsWith('jarvis_session=')) ?? '';
    cookie = cookie.split(';')[0] ?? '';
  } catch {
    /* Warming signed out is worse than warming signed in, and better than not warming. */
  }

  const timings: { route: string; ms: number }[] = [];

  const warm = async (route: string): Promise<void> => {
    if (SKIP.has(route)) return;
    const at = Date.now();
    try {
      /*
       * A GET against a POST-only handler answers 405 and compiles the module all the same, which
       * is the only thing being bought here. Every response status is acceptable; only a hang is
       * not, and the per-request signal is bounded so one wedged route cannot consume the budget.
       */
      await fetch(`${baseURL}${route}`, {
        headers: cookie ? { cookie } : {},
        signal: AbortSignal.timeout(60_000),
      });
    } catch {
      /* A refused or timed-out warm request is not a test failure; the test itself will say so. */
    }
    timings.push({ route, ms: Date.now() - at });
  };

  /*
   * A small pool rather than one-at-a-time or all-at-once. All at once starves the compiler and
   * makes every request slower; four keeps its workers busy without queueing every page behind
   * the others.
   *
   * The per-route timings below become approximate under concurrency, and that is an acceptable
   * trade: they are diagnostics for spotting a page that has become pathological, not a
   * measurement anything depends on. The number that matters — total time to readiness — stays
   * exact.
   */
  const queue = [...pages, ...WARM_API];
  const workers = Array.from({ length: 4 }, async () => {
    for (;;) {
      const route = queue.shift();
      if (route === undefined) return;
      await warm(route);
    }
  });
  await Promise.all(workers);

  const total = Date.now() - started;
  const slow = timings.filter((entry) => entry.ms >= 1000).sort((a, b) => b.ms - a.ms);

  if (verbose) {
    for (const entry of [...timings].sort((a, b) => b.ms - a.ms)) {
      console.log(`  ${String(entry.ms).padStart(6)}ms  ${entry.route}`);
    }
  }

  /*
   * One line in an ordinary run. It carries the two numbers worth watching — how long readiness
   * actually took, and how many routes were slow enough to have broken a test had they been
   * compiled inside one. `E2E_TRACE_WARMUP=1` prints the full table.
   */
  console.log(
    `[e2e] warmed ${timings.length} routes in ${(total / 1000).toFixed(1)}s ` +
      `(${slow.length} took over 1s; slowest ${slow[0]?.route ?? 'none'} at ${slow[0]?.ms ?? 0}ms)`,
  );
}

export default globalSetup;
