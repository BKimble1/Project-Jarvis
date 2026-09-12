import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getDatabaseHandle, setDatabaseHandle } from '@/server/db/client';
import { buildConfig } from '@/server/config/env';

/**
 * A file-backed database opens in a directory that does not exist yet.
 *
 * ## The failure this exists to stop
 *
 * PGlite's Node filesystem calls `mkdirSync(dataDir)` without `recursive`, so it can only create
 * the last segment of the path. Both of this repository's file-backed defaults are two segments
 * deep — `.jarvis-data/dev` for `npm run dev`, `.jarvis-data/e2e` for the end-to-end suite — and
 * `.jarvis-data` is gitignored. On a clone nobody has worked in yet, neither command could start:
 *
 *     Error: ENOENT: no such file or directory, mkdir '.../.jarvis-data/dev'
 *
 * Reproduced against the untouched branch tip before it was fixed, in a worktree checked out fresh,
 * for both the dev path and the end-to-end prepare step.
 *
 * It hid for as long as it did because any machine that has ever run either command already has the
 * parent directory, so the bug is invisible to everyone except somebody starting from scratch —
 * which is the first thing a new contributor does, and the only thing a fresh CI runner does.
 *
 * ## Why the test uses a two-deep path
 *
 * Because a one-deep path is exactly the case that always worked. The depth *is* the bug.
 */
describe('opening a file-backed database', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'jarvis-db-'));
  });

  afterEach(async () => {
    setDatabaseHandle(undefined);
    await rm(root, { recursive: true, force: true });
  });

  const configFor = (dataDir: string) =>
    buildConfig({
      NODE_ENV: 'development',
      JARVIS_BASE_URL: 'http://localhost:3000',
      SESSION_SECRET: 'a-test-session-secret-that-is-long-enough-000000',
      OWNER_GITHUB_LOGIN: 'test-owner',
      OWNER_GITHUB_USER_ID: '4242',
      PGLITE_DATA_DIR: dataDir,
    });

  it('creates the parent directory it was never given', async () => {
    /* Two segments below a directory that does not exist — the shape both defaults use. */
    const dataDir = path.join(root, 'absent-parent', 'dev');

    const handle = await getDatabaseHandle(configFor(dataDir));
    try {
      expect(handle.driver).toBe('pglite');
      const made = await stat(dataDir);
      expect(made.isDirectory(), 'the data directory exists after opening').toBe(true);
    } finally {
      await handle.close();
      setDatabaseHandle(undefined);
    }
  });
});
