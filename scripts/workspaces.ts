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
 */
/* A plain Node process, so nothing loads `.env` for it. Real environment variables still win. */
import 'dotenv/config';
import path from 'node:path';
import { buildWorkerConfig } from '@/worker/config';
import { listWorkspaces, removeWorkspace, workspaceSummary } from '@/worker/workspace';

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

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
