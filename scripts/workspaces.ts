#!/usr/bin/env tsx
/**
 * Mission workspaces on this worker's disk.
 *
 * `npm run worker:workspaces` — what is preserved, and how to reclaim it.
 *
 * Every ending that is not a clean completion leaves its workspace behind on purpose: a stopped
 * mission, a failed one, a worker that was killed. That is the right default — the changes in
 * there are the only copy of work nobody has reviewed yet — but it means a long-lived worker
 * accumulates clones, and until now there was no supported way to remove one. `removeWorkspace`
 * existed, refused to delete anything outside the configured root, refused to delete uncommitted
 * work, and had no caller. This is the caller.
 *
 *   npm run worker:workspaces                      list what is on disk
 *   npm run worker:workspaces -- remove <missionId>       remove one, if it is clean
 *   npm run worker:workspaces -- remove <missionId> --force  remove it anyway
 *
 * `--force` is the only way to discard uncommitted changes, and it is deliberately a thing the
 * owner types rather than a thing a schedule decides. Nothing here runs automatically.
 *
 * It also holds `loadEnvFiles`, which every other `scripts/*.ts` entry point calls. That is not
 * where such a thing belongs. It is here because the loader needs `dotenv`, a devDependency, so it
 * cannot live in `src/server/config/env.ts` — that module ships in the production server bundle —
 * and because `scripts/worker.ts` and `scripts/worker-health.ts` import it too: the worker is a
 * separate process and may not reach into `@/server`.
 *
 * The price is paid the other way instead. `doctor`, `migrate` and `seed-demo` are control-plane
 * commands and now load this module's `@/worker` imports to get a dotenv wrapper. That is two
 * cheap modules and no side effects, but it is the wrong direction, and the honest fix is a
 * loader module of its own that imports nothing from either side.
 */
import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadEnv } from 'dotenv';
import { buildWorkerConfig } from '@/worker/config';
import { listWorkspaces, removeWorkspace, workspaceSummary } from '@/worker/workspace';

/**
 * The environment files a script reads, in the order that makes the more specific one win.
 *
 * `.env.local` is first because it is the file the setup documents tell an owner to create, and
 * because `dotenv` never overwrites a variable that is already set — so whatever the first file
 * defines, the second cannot change. That same property is what keeps a real environment variable
 * (a systemd `EnvironmentFile`, a Docker `--env-file`, `PGLITE_DATA_DIR=… npm run doctor`)
 * authoritative over both files.
 */
export const ENV_FILES = ['.env.local', '.env'] as const;

/**
 * Load `.env.local`, then `.env`, into `process.env`. The first thing every script does.
 *
 * A plain Node process gets nothing loaded for it the way Next.js does for the application, and
 * until now each script said `import 'dotenv/config'`, which reads `.env` and nothing else. Since
 * the documented file to create is `.env.local`, the two halves of one installation were reading
 * different configurations: `npm run doctor` reported no owner, no OAuth and no GitHub token while
 * the application ran fine beside it, and — the expensive one — `npm run db:migrate` with
 * `DATABASE_URL` in `.env.local` migrated the local PGlite instead and exited 0 reporting success.
 * A migration that reports success against the wrong database is worse than one that fails.
 *
 * Call it as the first statement of a script, after the imports. Nothing this repository imports
 * reads `process.env` while its module body is evaluating, so that is early enough; a module that
 * did would have to be loaded after this instead.
 */
export function loadEnvFiles(cwd: string = process.cwd()): void {
  for (const file of ENV_FILES) {
    const resolved = path.resolve(cwd, file);
    /*
     * `quiet` because dotenv v17 otherwise prints a banner and a rotating third-party
     * advertisement on every load. `npm run doctor` offers itself as a readiness probe, and its
     * docstring promises it prints only what the checks return.
     */
    if (existsSync(resolved)) loadEnv({ path: resolved, quiet: true });
  }
}

async function main(): Promise<void> {
  const config = buildWorkerConfig();
  const [command, missionId] = process.argv.slice(2);
  const force = process.argv.includes('--force');

  if (command === 'remove') {
    if (!missionId) {
      console.error('Usage: npm run worker:workspaces -- remove <missionId> [--force]');
      process.exitCode = 1;
      return;
    }
    const result = await removeWorkspace(config.workspaceRoot, missionId, { force });
    console.log(result.reason);
    process.exitCode = result.removed ? 0 : 1;
    return;
  }

  const names = await listWorkspaces(config.workspaceRoot);
  if (names.length === 0) {
    console.log(`No preserved workspaces under ${config.workspaceRoot}.`);
    return;
  }

  console.log(`${names.length} preserved workspace(s) under ${config.workspaceRoot}:\n`);
  for (const name of names) {
    /*
     * Read the state rather than assert it. A workspace whose clone is half-written, or whose
     * slot is `inspect` rather than `repo`, simply reports what could be read.
     */
    const repoPath = path.join(config.workspaceRoot, name, 'repo');
    const summary = await workspaceSummary({
      missionRoot: path.join(config.workspaceRoot, name),
      repoPath,
      branch: null,
      baseBranch: '',
      baseSha: '',
      repositoryFullName: '',
    }).catch(() => null);

    if (!summary) {
      console.log(`  ${name}  (no readable git checkout)`);
      continue;
    }
    console.log(
      `  ${name}  ${summary.clean ? 'clean' : `${summary.files.length} uncommitted change(s)`}  head ${summary.head.slice(0, 7) || 'unknown'}`,
    );
  }
  console.log(
    '\nRemove one with:  npm run worker:workspaces -- remove <missionId>' +
      '\nA workspace with uncommitted changes needs --force, which discards them.',
  );
}

/**
 * Whether this file is what was run, rather than a module something else imported.
 *
 * Every other script imports `loadEnvFiles` from here, and importing a module evaluates it. Left
 * unguarded, `npm run doctor` would print a list of mission workspaces before printing anything of
 * its own, and would inherit whatever exit code the listing set.
 *
 * The two paths are compared twice, once as given and once through `realpath`, because they are
 * produced differently: Node resolves a module specifier through the real path, so
 * `import.meta.url` is already de-symlinked, while `process.argv[1]` is whatever the shell was
 * handed. A checkout reached through a symlinked parent — `~/work` → `/mnt/data/work`, a bind
 * mount, macOS `/tmp` — made them disagree, and a guard that answers "no" is silent: the command
 * printed nothing and exited 0, which reads as "no preserved workspaces" rather than as a command
 * that never ran. The unresolved comparison is kept for `--preserve-symlinks-main`, which leaves
 * `import.meta.url` pointing at the link instead.
 */
function isEntryPoint(): boolean {
  const invoked = process.argv[1];
  if (invoked === undefined) return false;
  const here = fileURLToPath(import.meta.url);
  const asGiven = path.resolve(invoked);
  if (asGiven === here) return true;
  try {
    return realpathSync(asGiven) === realpathSync(here);
  } catch {
    /* An `argv[1]` that is not a file on disk cannot be this module. */
    return false;
  }
}

if (isEntryPoint()) {
  loadEnvFiles();
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
