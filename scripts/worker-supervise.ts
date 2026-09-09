#!/usr/bin/env tsx
/**
 * Keep workers running, and take back what dead ones were holding.
 *
 * ## What this is for
 *
 * `npm run worker` runs one worker in one terminal. Close the terminal and it stops; crash it and
 * nothing notices. That is fine while somebody is watching and useless overnight, which is when
 * unattended work actually happens.
 *
 * This runs the workers as children, restarts one that dies with the same bounded backoff the
 * launcher uses, and asks the control plane on a timer to reclaim missions whose worker stopped
 * reporting. It is a process manager and deliberately nothing more: it holds no database
 * connection and makes no decision about which missions are safe to hand on, because those rules
 * are subtle and belong in one place — see `POST /api/maintenance/reclaim`.
 *
 * ## What it will never do
 *
 * - Create a credential. It reads `JARVIS_WORKER_TOKEN` and passes it to its children; if there
 *   is none it says so and stops, rather than enrolling anything.
 * - Set `ANTHROPIC_API_KEY`. The workers use the Claude subscription login on this machine, and a
 *   supervisor that quietly switched to a billed key would be spending money to fix a login.
 * - Run more than `MAX_WORKER_POOL` processes, whatever the configuration says. Every worker is a
 *   separate session on one subscription.
 * - Restart forever. Five failures inside ten minutes is a fault restarting will not fix, and the
 *   useful thing then is to stop and leave the error readable.
 *
 * ## Running it after the terminal closes, on WSL
 *
 * WSL2 supports systemd on recent builds. With it:
 *
 *     # /etc/systemd/system/jarvis-worker.service
 *     [Unit]
 *     Description=Jarvis worker supervisor
 *     After=network-online.target
 *
 *     [Service]
 *     Type=simple
 *     User=%i
 *     WorkingDirectory=/home/you/Project-Jarvis
 *     ExecStart=/usr/bin/npm run worker:supervise
 *     Restart=always
 *     RestartSec=10
 *
 *     [Install]
 *     WantedBy=multi-user.target
 *
 *     sudo systemctl enable --now jarvis-worker
 *
 * Without systemd (`/etc/wsl.conf` lacking `systemd=true`), the supported alternative is a Windows
 * Scheduled Task that starts the distribution and this command at logon:
 *
 *     schtasks /create /tn "Jarvis worker" /sc onlogon /rl highest ^
 *       /tr "wsl.exe -d Ubuntu -- bash -lc 'cd ~/Project-Jarvis && npm run worker:supervise'"
 *
 * Note that WSL shuts a distribution down when its last process exits, so a supervisor started
 * from a terminal you then close will be killed with it unless one of the two arrangements above
 * is keeping the distribution alive.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { config as loadEnv } from 'dotenv';
import { decideRestart, resolveWorkerPool } from '@/domain/process-supervision';
import { redactSecrets } from '@/domain/redaction';

/* Both env files, more specific first, exactly as the launcher does. */
for (const file of ['.env.local', '.env']) {
  const resolved = path.resolve(process.cwd(), file);
  if (existsSync(resolved)) loadEnv({ path: resolved });
}

const CONTROL_PLANE = process.env.JARVIS_BASE_URL ?? 'http://localhost:3000';
const CRON_SECRET = process.env.CRON_SECRET ?? null;
const RECLAIM_INTERVAL_MS = Number(process.env.JARVIS_RECLAIM_INTERVAL_MS ?? 60_000);

const pool = resolveWorkerPool(
  process.env.JARVIS_WORKER_POOL ? Number(process.env.JARVIS_WORKER_POOL) : null,
);

interface Child {
  readonly name: string;
  child: ChildProcess | null;
  /** Epoch milliseconds of every restart, so the backoff window can forget old ones. */
  restarts: number[];
  stopped: boolean;
}

const children: Child[] = [];
let shuttingDown = false;

const say = (line: string): void => {
  /* Redacted on the way out: a supervisor log is the most likely thing to be pasted somewhere. */
  process.stdout.write(`${redactSecrets(line)}\n`);
};

function start(entry: Child): void {
  if (shuttingDown) return;

  /*
   * The child gets this process's environment unchanged.
   *
   * Unchanged is the point. `ANTHROPIC_API_KEY` is not set here and must not be invented here; the
   * worker resolves its own runtime and will say `subscription` because that is what this machine
   * is signed in to.
   */
  const child = spawn('npx', ['tsx', 'scripts/worker.ts'], {
    env: { ...process.env, JARVIS_WORKER_NAME: entry.name },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  entry.child = child;
  say(`[supervisor] started ${entry.name} (pid ${child.pid ?? 'unknown'})`);

  child.on('exit', (code, signal) => {
    entry.child = null;
    if (shuttingDown || entry.stopped) return;

    const now = Date.now();
    say(`[supervisor] ${entry.name} exited (${signal ?? code}).`);

    const decision = decideRestart({
      restarts: entry.restarts,
      now,
      cleanExit: code === 0,
      shuttingDown,
      name: entry.name,
    });
    say(`[supervisor] ${decision.reason}`);

    if (!decision.restart) {
      entry.stopped = true;
      void report(entry, false, decision.reason);
      /* Every worker given up on means no unattended work at all, so say it plainly and stop. */
      if (children.every((other) => other.stopped)) {
        say('[supervisor] no workers left running. Fix the error above and start it again.');
        process.exitCode = 1;
        clearInterval(reclaimTimer);
      }
      return;
    }

    entry.restarts.push(now);
    void report(entry, true, decision.reason);
    setTimeout(() => start(entry), decision.delayMs);
  });
}

/**
 * Tell the control plane that a child was restarted, or given up on.
 *
 * A restart is invisible from the database — a crashed worker that comes back looks exactly like
 * one that was quiet for a minute — so the only place "it has crashed four times tonight" can come
 * from is here, said at the time. Best-effort on purpose: a supervisor that failed to restart a
 * worker because it could not file a report would be worse than one that stayed quiet.
 */
async function report(entry: Child, restarting: boolean, reason: string): Promise<void> {
  if (!CRON_SECRET) return;
  try {
    await fetch(`${CONTROL_PLANE}/api/maintenance/supervisor`, {
      method: 'POST',
      headers: { authorization: `Bearer ${CRON_SECRET}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        worker: entry.name,
        restarts: entry.restarts.length,
        restarting,
        reason: redactSecrets(reason),
      }),
    });
  } catch {
    /* The control plane may be down; that is often *why* the worker died. Keep going. */
  }
}

/**
 * Ask the control plane to take back what departed workers were holding.
 *
 * A missed sweep is not news: the next one does the same thing, and the sweep itself is safe to
 * repeat because it only acts on leases that have already expired.
 */
async function reclaim(): Promise<void> {
  if (!CRON_SECRET) return;
  try {
    const response = await fetch(`${CONTROL_PLANE}/api/maintenance/reclaim`, {
      method: 'POST',
      headers: { authorization: `Bearer ${CRON_SECRET}` },
    });
    if (!response.ok) return;
    const body = (await response.json()) as {
      reclaimed: { requeued: number; released: number };
    };
    if (body.reclaimed.requeued > 0 || body.reclaimed.released > 0) {
      say(
        `[supervisor] reclaimed ${body.reclaimed.requeued} queued and released ` +
          `${body.reclaimed.released} in-flight mission(s) from workers that stopped reporting.`,
      );
    }
  } catch {
    /* The control plane may be restarting. The next sweep says the same thing. */
  }
}

const reclaimTimer = setInterval(() => void reclaim(), RECLAIM_INTERVAL_MS);

function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  say(`\n[supervisor] ${signal}: stopping ${children.length} worker(s).`);
  clearInterval(reclaimTimer);
  for (const entry of children) entry.child?.kill('SIGTERM');
  /* Give them a moment to report their last state before the process ends. */
  setTimeout(() => process.exit(process.exitCode ?? 0), 2_000);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

function main(): void {
  if (!process.env.JARVIS_WORKER_TOKEN) {
    say('[supervisor] JARVIS_WORKER_TOKEN is not set. Enrol a worker in Operations → Workers');
    say('[supervisor] and export its token. This supervisor never creates one.');
    process.exitCode = 1;
    clearInterval(reclaimTimer);
    return;
  }

  if (process.env.ANTHROPIC_API_KEY) {
    /*
     * Not fatal, but said out loud. The owner's arrangement is a subscription login; a key in the
     * environment changes what the worker bills without changing anything it says it is doing.
     */
    say('[supervisor] ANTHROPIC_API_KEY is set. The workers will bill it rather than the');
    say('[supervisor] subscription. Unset it if that was not deliberate.');
  }

  if (pool.reason) say(`[supervisor] ${pool.reason}`);
  say(
    `[supervisor] control plane ${CONTROL_PLANE}, ${pool.size} worker(s), reclaim every ` +
      `${Math.round(RECLAIM_INTERVAL_MS / 1000)}s.`,
  );

  for (let index = 0; index < pool.size; index += 1) {
    const entry: Child = {
      name: pool.size === 1 ? 'worker' : `worker-${index + 1}`,
      child: null,
      restarts: [],
      stopped: false,
    };
    children.push(entry);
    start(entry);
  }

  void reclaim();
}

main();
