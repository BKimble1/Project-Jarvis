#!/usr/bin/env tsx
/**
 * Start the whole of Jarvis with one command.
 *
 * ## Why this exists
 *
 * Jarvis has always needed two long-lived processes — the control plane and the worker — and there
 * has never been anything that started both. Every documented start was a separate hand-typed
 * command in a separate terminal, which is fine while you are building it and quietly fatal once
 * you are relying on it: the failure mode is not an error, it is an owner who started the web app,
 * did not start the worker, and spent a morning wondering why nothing was happening.
 *
 * So this is a launcher and a preflight, not new runtime. Everything it starts is a command that
 * already existed and can still be run by hand.
 *
 * ## What it refuses to do
 *
 * It does not open the database. The local driver is an embedded PGlite opened *inside* whichever
 * process asks for it, so a launcher that connected would be a second writer to a single-writer
 * store — and the symptom would not be an error but two processes disagreeing about what is in
 * there. Migrations run only for a hosted database, and only as the separate command that already
 * does it.
 *
 * It does not bind anything to the public internet, and it does not configure a tunnel. The
 * control plane listens where Next listens; making that reachable from a phone on the same network
 * is a matter of the host's firewall, and making it reachable from outside is a decision with
 * consequences that nobody should arrive at by running a start script.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import path from 'node:path';
import { config as loadEnv } from 'dotenv';

/*
 * Both env files, in the order that makes the more specific one win.
 *
 * This is the first thing the launcher has to fix. Next.js reads `.env.local` and the setup docs
 * tell an owner to create it; every plain-Node script in this repository does `import
 * 'dotenv/config'`, which reads `.env` and nothing else. So an owner who followed the instructions
 * had a control plane that could see its configuration and a worker that could not, and the worker
 * failed with a message about a missing control-plane URL that was sitting right there in a file
 * it never read. `dotenv` does not overwrite what is already set, so a real environment variable
 * still beats both.
 */
for (const file of ['.env.local', '.env']) {
  const resolved = path.resolve(process.cwd(), file);
  if (existsSync(resolved)) loadEnv({ path: resolved });
}

const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.JARVIS_LIVE_HOST ?? '0.0.0.0';
const LOCAL = `http://127.0.0.1:${PORT}`;

const children: { readonly name: string; readonly child: ChildProcess }[] = [];
let shuttingDown = false;

/**
 * Start a child in its own process group, so stopping it stops everything it started.
 *
 * `npx next dev` is not one process. It is `npm exec` which spawns `sh -c` which spawns node which
 * spawns the Next server, and a signal sent to the child at the top of that chain kills the shim
 * and leaves the server running — which was exactly what happened the first time this launcher was
 * tested: Ctrl-C returned the prompt and left a control plane and a worker running behind it.
 * That is worse than not stopping at all, because the terminal says it stopped.
 *
 * `detached` makes each child a group leader, and `process.kill(-pid)` signals the whole group.
 */
function start(name: string, command: string, args: string[]): ChildProcess {
  const child = spawn(command, args, { env: process.env, stdio: 'inherit', detached: true });
  children.push({ name, child });
  child.on('exit', (code, signal) => {
    if (shuttingDown) return;
    /*
     * One process dying takes the other down with it, on purpose. A control plane with no worker
     * accepts missions nothing will ever run; a worker with no control plane logs a poll failure
     * every few seconds for ever. Both halves silently half-working is the state this launcher
     * exists to prevent, so it is not a state it is allowed to leave behind.
     */
    console.error(`\n[jarvis] ${name} exited (${signal ?? code}). Stopping the rest.`);
    void shutdown(typeof code === 'number' && code !== 0 ? code : 1);
  });
  return child;
}

/**
 * How long a child may take to stop before it is killed outright.
 *
 * Generous, because the thing being waited for is a worker finishing a real mission: a checkpoint,
 * a commit, a final report. Fifteen seconds is long enough for all three and short enough that an
 * owner pressing Ctrl-C does not conclude it has hung.
 */
const DRAIN_TIMEOUT_MS = 15_000;

async function waitForExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && child.exitCode === null && child.signalCode === null) {
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
}

/** Signal a child and everything it started. See `start` for why the group matters. */
function signalGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined || child.exitCode !== null) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    /* The group is already gone, or the platform refused; fall back to the child itself. */
    try {
      child.kill(signal);
    } catch {
      /* Nothing left to signal. */
    }
  }
}

function runOnce(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env: process.env, stdio: 'inherit' });
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`${command} ${args.join(' ')} exited ${code}`)),
    );
  });
}

async function waitForHealth(timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      /*
       * The unauthenticated health endpoint, which answers exactly one question: the process is up
       * and the database answered. That is the right gate for starting the worker — a worker that
       * starts against a control plane whose database is not ready spends its first minute logging
       * failures at an owner who is watching the terminal for the first time.
       */
      const response = await fetch(`${LOCAL}/api/health`, { signal: AbortSignal.timeout(3000) });
      if (response.ok) return;
    } catch {
      /* Not up yet. */
    }
    await new Promise((resolve) => setTimeout(resolve, 700));
  }
  throw new Error(
    `The control plane did not answer ${LOCAL}/api/health within ${Math.round(timeoutMs / 1000)}s. ` +
      'Its output is above; `npm run doctor` explains most configuration failures.',
  );
}

async function shutdown(code: number): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  /*
   * The worker first, and with time to finish.
   *
   * SIGTERM tells it to drain: it finishes the mission in its hands and exits, rather than
   * abandoning a half-written branch and a workspace the control plane still thinks is claimed.
   * Killing the control plane first would take away the endpoint it needs to report that it
   * finished, which is the one thing that turns a clean stop into a lost mission.
   */
  for (const entry of [...children].reverse()) {
    signalGroup(entry.child, 'SIGTERM');
    /*
     * Wait for this one before signalling the next, rather than signalling them all at once.
     *
     * Signalling together looked equivalent and is not: the worker drains, and draining means
     * reporting to the control plane that the mission finished — so a control plane killed in the
     * same instant takes away the endpoint the worker needs, and a clean stop becomes a mission the
     * control plane still believes is claimed. The first test of this printed the drain message and
     * "Poll failed: fetch failed" one line apart.
     */
    await waitForExit(entry.child, DRAIN_TIMEOUT_MS);
  }

  for (const entry of children) {
    if (entry.child.exitCode === null) signalGroup(entry.child, 'SIGKILL');
  }

  process.exit(code);
}

/** Every address a phone or a wallboard on the same network could use. */
function lanUrls(): readonly string[] {
  const found: string[] = [];
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family !== 'IPv4' || address.internal) continue;
      found.push(`http://${address.address}:${PORT}`);
    }
  }
  return found;
}

/**
 * Everything that would fail later, checked now — split by whether it actually stops anything.
 *
 * The distinction matters more than the checks do. A launcher that refuses to start over something
 * survivable is a launcher an owner learns to work around, and the workaround is always to go back
 * to starting the two processes by hand — which is the situation this exists to end. So only a
 * missing credential blocks: without one of those, a process cannot start at all and would fail a
 * few seconds later with a worse message.
 *
 * Everything else is said out loud and then started anyway.
 */
function preflight(): {
  readonly blocking: readonly string[];
  readonly notices: readonly string[];
} {
  const problems: string[] = [];
  const notices: string[] = [];

  if (!process.env.SESSION_SECRET) {
    problems.push(
      'SESSION_SECRET is not set. Copy .env.example to .env.local and fill it in; `npm run doctor` lists the rest.',
    );
  }

  if (!process.env.JARVIS_WORKER_TOKEN) {
    problems.push(
      'JARVIS_WORKER_TOKEN is not set, so no worker can start. Enrol one in Jarvis (Operations → Workers), then put the token in .env.local as JARVIS_WORKER_TOKEN.',
    );
  }

  /*
   * The same-origin guard compares the request's origin against JARVIS_BASE_URL, so a base URL of
   * localhost refuses every write from a phone on the same network — and refuses it with a
   * security error, which reads like a bug rather than like configuration. Worth saying out loud
   * rather than leaving to be discovered from a tablet in another room.
   */
  const base = process.env.JARVIS_BASE_URL;
  if (base && /^https?:\/\/(localhost|127\.0\.0\.1)/.test(base) && lanUrls().length > 0) {
    notices.push(
      `JARVIS_BASE_URL is ${base}. That is right for one machine, but a phone or a wallboard opening Jarvis will be able to read it and not change it — the same-origin check refuses a write whose origin is not the base URL, and it refuses it with a security error that reads like a bug. To use it from another device set JARVIS_BASE_URL to one of: ${lanUrls().join(', ')}`,
    );
  }

  return { blocking: problems, notices };
}

async function main(): Promise<void> {
  const { blocking, notices } = preflight();
  if (blocking.length > 0) {
    console.error('[jarvis] Cannot start:\n');
    for (const problem of blocking) console.error(`  · ${problem}\n`);
    process.exit(1);
  }
  for (const notice of notices) console.log(`[jarvis] Note: ${notice}\n`);

  /*
   * Only for a hosted database. The local PGlite driver runs its own migrations when the control
   * plane opens it, in that process — running them here would open a second connection to a store
   * that expects one.
   */
  const driver = process.env.JARVIS_DB_DRIVER ?? (process.env.DATABASE_URL ? 'neon' : 'pglite');
  if (driver !== 'pglite') {
    console.log('[jarvis] Applying migrations…');
    await runOnce('npx', ['tsx', 'scripts/migrate.ts']);
  }

  console.log('[jarvis] Starting the control plane…');
  start('control plane', 'npx', ['next', 'dev', '--hostname', HOST, '--port', String(PORT)]);

  await waitForHealth(180_000);

  console.log('[jarvis] Control plane is answering. Starting the worker…');
  start('worker', 'npx', ['tsx', 'scripts/worker.ts']);

  const lan = lanUrls();
  console.log(
    [
      '',
      '  Jarvis is running.',
      '',
      `    Dashboard   ${LOCAL}`,
      ...lan.map(
        (url, index) => `    ${index === 0 ? 'On your network' : '               '} ${url}`,
      ),
      `    Wallboard   ${lan[0] ?? LOCAL}/display   (needs a display device token — Operations → Displays)`,
      '',
      '    Health      npm run doctor',
      '    Worker      npm run worker:health',
      '    Stop        Ctrl-C, or send SIGTERM to this process',
      '',
    ].join('\n'),
  );
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    console.log('\n[jarvis] Stopping. The worker will finish what it is doing first.');
    void shutdown(0);
  });
}

main().catch((error: unknown) => {
  console.error(`[jarvis] ${error instanceof Error ? error.message : String(error)}`);
  void shutdown(1);
});
