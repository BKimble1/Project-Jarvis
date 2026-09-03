import { access, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ConflictError, ValidationError } from '@/domain/errors';
import {
  assertInsideWorkspace,
  assertMissionBranchName,
  missionWorkspaceDirectory,
} from '@/domain/workspace-safety';
import type { AssignmentRepository } from '@/domain/worker-protocol';
import { changedFiles, currentBranch, git, headSha, isClean, remoteUrl } from './git';

/**
 * Isolated mission workspaces.
 *
 * One fresh clone per mission at `<root>/<missionId>/repo`, never a worktree of the owner's real
 * checkout. A worktree shares `.git` with the original, so a mistake inside it is a mistake in
 * the repository the owner actually works in. A clone is slower and completely separable, and it
 * avoids the worktree/symlink differences that make Windows behave unlike Linux.
 *
 * Read-only inspection gets its own clone at `<root>/<missionId>/inspect`, deliberately not the
 * one execution uses. A mission is normally inspected and then executed, so sharing the directory
 * would make every execution run trip over the planning clone; and keeping them apart means the
 * work in `repo` is never confused with a throwaway read of the repository.
 *
 * Cleanup is always explicit. Nothing here deletes a workspace on failure, on a stop, or on a
 * restart — the whole point of preserving it is that it survives the thing that went wrong.
 */

/**
 * Which clone a run uses.
 *
 * Prompt 2 had two: `repo` for execution and `inspect` for read-only planning. Prompt 3 adds one
 * per task, because several agents work on one mission at once and no two may ever share a
 * writable checkout. A slot name is built by `taskSlot` from the task key and validated by
 * `assertSlot` immediately before it becomes a path segment — the same construct-then-revalidate
 * discipline branch names get, because this is the other place mission text turns into a path.
 */
export type WorkspaceSlot = string;

const SLOT_PATTERN = /^[a-z][a-z0-9-]{0,40}$/;

export function assertSlot(slot: string): string {
  if (!SLOT_PATTERN.test(slot)) {
    throw new ValidationError('That is not a workspace slot name.', { slot: slot.slice(0, 60) });
  }
  return slot;
}

/** The slot a task owns: `task-t1`, `read-t2`, `integration`. */
export function taskSlot(kind: 'task' | 'read', taskKey: string): string {
  return assertSlot(`${kind}-${taskKey.toLowerCase()}`);
}

export const INTEGRATION_SLOT = 'integration';

export interface WorkspaceHandle {
  /** `<root>/<missionId>` — everything the mission owns. */
  readonly missionRoot: string;
  /** `<root>/<missionId>/<slot>` — the clone the agent is confined to. */
  readonly repoPath: string;
  readonly branch: string | null;
  readonly baseBranch: string;
  readonly baseSha: string;
  readonly repositoryFullName: string;
}

export interface PrepareOptions {
  readonly workspaceRoot: string;
  readonly missionId: string;
  readonly repository: AssignmentRepository;
  readonly branchName: string | null;
  readonly credentialToken: string | null;
  readonly readOnly: boolean;
  /** Reuse an existing clone (a resume) instead of starting again. */
  readonly reuseExisting: boolean;
  /** Defaults to `repo`. Inspection runs pass `inspect` so the two never share a directory. */
  readonly slot?: WorkspaceSlot;
  readonly onProgress?: (message: string) => void;
}

export class WorkspaceError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'dirty_workspace'
      | 'identity_mismatch'
      | 'branch_exists'
      | 'default_branch_changed'
      | 'clone_failed'
      | 'path_error',
  ) {
    super(message);
    this.name = 'WorkspaceError';
  }
}

/** Is the configured root usable? Reported in the heartbeat as `workspaceHealthy`. */
export async function checkWorkspaceRoot(root: string): Promise<{ ok: boolean; detail: string }> {
  try {
    await mkdir(root, { recursive: true });
    const probe = path.join(root, '.jarvis-write-probe');
    await writeFile(probe, 'ok', 'utf8');
    await rm(probe, { force: true });
    return { ok: true, detail: `Workspace root ${root} is writable.` };
  } catch (error) {
    return {
      ok: false,
      detail: `Workspace root ${root} is not writable: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export async function prepareWorkspace(options: PrepareOptions): Promise<WorkspaceHandle> {
  const missionRoot = missionWorkspaceDirectory(options.workspaceRoot, options.missionId);
  /* Belt and braces: the derived path is re-checked against the root before anything is created. */
  assertInsideWorkspace(options.workspaceRoot, missionRoot);

  const slot: WorkspaceSlot = assertSlot(options.slot ?? 'repo');
  const repoPath = path.join(missionRoot, slot);
  assertInsideWorkspace(options.workspaceRoot, repoPath);

  let exists = await pathExists(repoPath);

  if (exists && !options.reuseExisting) {
    /*
     * A leftover clone from an unrelated attempt is never silently reused or deleted. Both would
     * be wrong: reusing it risks mixing two missions' work, deleting it risks throwing away work
     * the owner has not seen.
     *
     * The one exception is a *clean* inspection clone. Re-planning a mission is an ordinary owner
     * action, and an inspection that changed nothing has nothing in it to lose — which is checked
     * against the working tree rather than assumed from the permission mode.
     */
    if ((slot === 'inspect' || slot.startsWith('read-')) && (await isCleanCheckout(repoPath))) {
      options.onProgress?.(
        'Replacing the previous read-only inspection clone; it changed nothing.',
      );
      await rm(repoPath, { recursive: true, force: true });
      exists = false;
    } else {
      throw new WorkspaceError(
        `A workspace already exists at ${repoPath} from an earlier attempt. Review it, then remove it deliberately before retrying.`,
        'dirty_workspace',
      );
    }
  }

  if (exists) return reuseWorkspace(repoPath, options);

  /*
   * Check the assignment agrees with itself *before* cloning: a control plane whose source record
   * and clone URL disagree is a mismatch worth catching, and catching it here costs nothing.
   */
  assertConsistentRepository(options.repository);

  options.onProgress?.(`Cloning ${options.repository.fullName}…`);
  await mkdir(missionRoot, { recursive: true });

  try {
    await git(
      [
        'clone',
        '--no-tags',
        /* A single branch and a shallow-ish history: enough to branch and diff, no more. */
        '--single-branch',
        '--branch',
        options.repository.defaultBranch,
        options.repository.cloneUrl,
        repoPath,
      ],
      {
        cwd: missionRoot,
        credentialToken: options.credentialToken ?? null,
        timeoutMs: 300_000,
      },
    );
  } catch (error) {
    throw new WorkspaceError(
      `Could not clone ${options.repository.fullName}: ${error instanceof Error ? error.message : String(error)}`,
      'clone_failed',
    );
  }

  const gitOptions = { cwd: repoPath, credentialToken: options.credentialToken ?? null };

  /*
   * The clone's own remote must be the URL Jarvis asked for.
   *
   * Comparing against `fullName` instead would only work for github.com URLs, and would reject
   * every other remote — including the local sandbox repositories the tests use. What actually
   * needs proving is that this directory is a clone of the repository the mission named, and the
   * remote URL is exactly that.
   */
  const url = await remoteUrl(gitOptions);
  if (url && !sameRepository(url, options.repository.cloneUrl)) {
    throw new WorkspaceError(
      `The clone at ${repoPath} points at a different repository than ${options.repository.fullName}. Refusing to continue.`,
      'identity_mismatch',
    );
  }

  const base = await currentBranch(gitOptions);
  if (base !== options.repository.defaultBranch) {
    throw new WorkspaceError(
      `Expected to be on ${options.repository.defaultBranch} but the clone is on ${base}. The default branch may have changed since the plan was approved.`,
      'default_branch_changed',
    );
  }

  const sha = await headSha(gitOptions);

  if (options.readOnly || !options.branchName) {
    return {
      missionRoot,
      repoPath,
      branch: null,
      baseBranch: base,
      baseSha: sha,
      repositoryFullName: options.repository.fullName,
    };
  }

  const branch = assertMissionBranchName(options.branchName);

  /* An existing branch of the same name means someone else's work; stop and ask rather than reuse. */
  const branches = await git(['branch', '--list', '--all', branch], gitOptions);
  if (branches.stdout.trim().length > 0) {
    throw new WorkspaceError(
      `The branch ${branch} already exists. Jarvis will not overwrite it — decide what to do with it first.`,
      'branch_exists',
    );
  }

  options.onProgress?.(`Creating ${branch} from ${base}@${sha.slice(0, 7)}…`);
  await git(['checkout', '-b', branch], gitOptions);

  return {
    missionRoot,
    repoPath,
    branch,
    baseBranch: base,
    baseSha: sha,
    repositoryFullName: options.repository.fullName,
  };
}

/**
 * Is this directory a git checkout with nothing uncommitted in it?
 *
 * Anything that cannot be proven clean — not a repository, a broken clone, git refusing to answer
 * — counts as not clean, so the caller preserves it rather than deleting it.
 */
async function isCleanCheckout(repoPath: string): Promise<boolean> {
  try {
    return await isClean({ cwd: repoPath, credentialToken: null });
  } catch {
    return false;
  }
}

/** Continue in a workspace a previous run left behind. */
async function reuseWorkspace(repoPath: string, options: PrepareOptions): Promise<WorkspaceHandle> {
  const gitOptions = { cwd: repoPath, credentialToken: options.credentialToken ?? null };
  const branch = await currentBranch(gitOptions);
  const sha = await headSha(gitOptions);

  if (options.branchName && branch !== options.branchName) {
    throw new WorkspaceError(
      `The preserved workspace is on ${branch}, not ${options.branchName}. Jarvis will not switch branches in a workspace it did not just create.`,
      'branch_exists',
    );
  }

  options.onProgress?.(`Resuming in the preserved workspace on ${branch}.`);
  return {
    missionRoot: path.dirname(repoPath),
    repoPath,
    branch: options.branchName ? branch : null,
    baseBranch: options.repository.defaultBranch,
    baseSha: sha,
    repositoryFullName: options.repository.fullName,
  };
}

/** A read-only workspace for a research mission with no repository at all. */
export async function prepareScratchWorkspace(
  workspaceRoot: string,
  missionId: string,
): Promise<WorkspaceHandle> {
  const missionRoot = missionWorkspaceDirectory(workspaceRoot, missionId);
  assertInsideWorkspace(workspaceRoot, missionRoot);
  const repoPath = path.join(missionRoot, 'notes');
  await mkdir(repoPath, { recursive: true });
  return {
    missionRoot,
    repoPath,
    branch: null,
    baseBranch: '',
    baseSha: '',
    repositoryFullName: '',
  };
}

export async function workspaceSummary(
  handle: WorkspaceHandle,
): Promise<{ clean: boolean; files: readonly string[]; head: string }> {
  const gitOptions = { cwd: handle.repoPath };
  return {
    clean: await isClean(gitOptions),
    files: await changedFiles(gitOptions),
    head: await headSha(gitOptions),
  };
}

/**
 * Remove a mission workspace.
 *
 * Never called automatically. It refuses to delete anything that is not directly under the
 * configured root, and it refuses while a branch still has uncommitted or unpushed work unless
 * the caller explicitly says the work is finished with.
 */
export async function removeWorkspace(
  workspaceRoot: string,
  missionId: string,
  options: { force: boolean },
): Promise<{ removed: boolean; reason: string }> {
  const missionRoot = missionWorkspaceDirectory(workspaceRoot, missionId);
  assertInsideWorkspace(workspaceRoot, missionRoot);

  if (path.dirname(missionRoot) !== path.resolve(workspaceRoot)) {
    throw new ValidationError('That workspace is not directly inside the configured root.');
  }
  if (!(await pathExists(missionRoot))) {
    return { removed: false, reason: 'There is no workspace for that mission.' };
  }

  if (!options.force) {
    const repoPath = path.join(missionRoot, 'repo');
    if (await pathExists(repoPath)) {
      const clean = await isClean({ cwd: repoPath });
      if (!clean) {
        throw new ConflictError(
          'That workspace has uncommitted changes. Review them before removing it.',
        );
      }
    }
  }

  await rm(missionRoot, { recursive: true, force: true });
  return { removed: true, reason: `Removed ${missionRoot}.` };
}

/** Every mission workspace currently on disk, for the worker's diagnostics. */
export async function listWorkspaces(workspaceRoot: string): Promise<readonly string[]> {
  try {
    const entries = await readdir(workspaceRoot, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return [];
  }
}

/**
 * Does the assignment describe one repository, or two?
 *
 * Only meaningful for an http(s) clone URL, where the path carries the owner and name. Any other
 * scheme — ssh, a local path, a test sandbox — has no such structure to check.
 */
function assertConsistentRepository(repository: AssignmentRepository): void {
  let parsed: URL;
  try {
    parsed = new URL(repository.cloneUrl);
  } catch {
    return;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return;

  const expected = `/${repository.fullName.toLowerCase()}`;
  const actual = parsed.pathname
    .toLowerCase()
    .replace(/\.git$/, '')
    .replace(/\/+$/, '');
  if (actual !== expected) {
    throw new WorkspaceError(
      `This mission names ${repository.fullName} but its clone URL points at ${actual.slice(1)}. Refusing to continue.`,
      'identity_mismatch',
    );
  }
}

/** Two remote URLs referring to the same repository, ignoring credentials and a `.git` suffix. */
export function sameRepository(a: string, b: string): boolean {
  return normaliseRemote(a) === normaliseRemote(b);
}

function normaliseRemote(value: string): string {
  return value
    .trim()
    .replace(/^[a-z][a-z0-9+.-]*:\/\/[^@/]+@/i, (match) => match.replace(/[^@/]+@/, ''))
    .replace(/\.git$/, '')
    .replace(/\/+$/, '')
    .toLowerCase();
}

async function pathExists(candidate: string): Promise<boolean> {
  try {
    await access(candidate);
    const info = await stat(candidate);
    return info.isDirectory();
  } catch {
    return false;
  }
}
