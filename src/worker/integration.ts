import { assertMissionBranchName } from '@/domain/workspace-safety';
import { changedFiles, git, headSha, isClean } from './git';

/**
 * Merging finished task branches into the mission integration branch.
 *
 * Deterministic git, run by the worker, with no model anywhere near it. That placement is the
 * point: merging is where two agents' work can silently destroy each other, and the safe
 * behaviour — stop and show both sides — is exactly the behaviour a model under pressure to
 * finish is most likely to talk itself out of.
 *
 * Three rules, none of which has an override:
 *
 *  - **Never force.** No `--force`, no `-X ours`, no `-X theirs`, no `checkout --theirs`. A
 *    strategy option that resolves conflicts by preferring one side is a way of discarding work
 *    without saying so.
 *  - **Never discard either side.** A conflict aborts the merge, leaves both branches untouched,
 *    and produces a report naming the files. Nothing is committed in a conflicted state.
 *  - **Never target the default branch.** The integration branch is a `jarvis/…` branch and
 *    `assertMissionBranchName` re-checks it immediately before it becomes a git argument.
 */

export interface MergeRequest {
  readonly repoPath: string;
  readonly integrationBranch: string;
  readonly baseBranch: string;
  /** Task branches, in dependency order. Order matters: a later task built on an earlier one. */
  readonly branches: readonly string[];
  readonly credentialToken?: string | null;
  readonly onProgress?: (message: string) => void;
}

export interface MergeConflict {
  readonly branch: string;
  /** The files git could not reconcile, so the owner can see what actually collided. */
  readonly files: readonly string[];
  readonly detail: string;
}

export interface MergeResult {
  readonly ok: boolean;
  readonly merged: readonly string[];
  readonly conflict: MergeConflict | null;
  readonly headSha: string | null;
  readonly changedFiles: readonly string[];
}

/**
 * Create the integration branch from the base, then merge each task branch into it.
 *
 * The integration branch is created fresh from the base rather than reused, so a rerun after a
 * failure starts from a known state instead of from whatever the previous attempt left. Task
 * branches themselves are never modified — they are the preserved record of what each agent did,
 * and they survive a conflict, a failure and a stop.
 */
export async function integrateBranches(request: MergeRequest): Promise<MergeResult> {
  const branch = assertMissionBranchName(request.integrationBranch);
  const options = {
    cwd: request.repoPath,
    credentialToken: request.credentialToken ?? null,
  };

  /* Start the integration branch at the base. `-B` so a rerun resets rather than fails. */
  await git(['checkout', '-B', branch, `origin/${request.baseBranch}`], options).catch(async () => {
    /* A local-only base (the sandbox repository in tests) has no `origin/` ref to start from. */
    await git(['checkout', '-B', branch, request.baseBranch], options);
  });

  const merged: string[] = [];

  for (const candidate of request.branches) {
    const taskBranch = assertMissionBranchName(candidate);
    request.onProgress?.(`Merging ${taskBranch}…`);
    try {
      /*
       * `--no-ff` keeps each task's work identifiable in the history rather than flattening it,
       * and `--no-edit` stops git opening an editor in a non-interactive process. There is
       * deliberately no `-X` strategy option: those are how conflicts get "resolved" by throwing
       * one side away.
       */
      await git(['merge', '--no-ff', '--no-edit', taskBranch], options);
      merged.push(taskBranch);
    } catch (error) {
      const conflicted = await conflictedFiles(request.repoPath, options.credentialToken);
      /* Abort so nothing is left half-merged; both branches are exactly as they were. */
      await git(['merge', '--abort'], options).catch(() => undefined);
      return {
        ok: false,
        merged,
        conflict: {
          branch: taskBranch,
          files: conflicted,
          detail:
            conflicted.length > 0
              ? `${taskBranch} and the integration branch both changed ${conflicted.slice(0, 5).join(', ')}.`
              : `${taskBranch} could not be merged: ${error instanceof Error ? error.message.slice(0, 300) : 'unknown error'}`,
        },
        headSha: null,
        changedFiles: [],
      };
    }
  }

  const head = await headSha(options);
  const changed = await filesAgainstBase(
    request.repoPath,
    request.baseBranch,
    options.credentialToken,
  );
  return { ok: true, merged, conflict: null, headSha: head, changedFiles: changed };
}

/** Files git marked as conflicted. Read from the index, not parsed out of an error message. */
async function conflictedFiles(
  repoPath: string,
  credentialToken: string | null,
): Promise<readonly string[]> {
  try {
    const result = await git(['diff', '--name-only', '--diff-filter=U'], {
      cwd: repoPath,
      credentialToken,
    });
    return result.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .slice(0, 100);
  } catch {
    return [];
  }
}

/** What the integration branch changed relative to the base. */
export async function filesAgainstBase(
  repoPath: string,
  baseBranch: string,
  credentialToken: string | null,
): Promise<readonly string[]> {
  const options = { cwd: repoPath, credentialToken };
  try {
    const result = await git(['diff', '--name-only', `${baseBranch}...HEAD`], options);
    return result.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .slice(0, 500);
  } catch {
    return changedFiles(options);
  }
}

/**
 * Commit whatever a task changed, onto its own branch.
 *
 * Returns `null` when there was nothing to commit, which is a real outcome rather than an error:
 * an agent that correctly concluded no change was needed should not produce an empty commit to
 * look busy.
 */
export async function commitTaskWork(input: {
  repoPath: string;
  branch: string;
  message: string;
  credentialToken?: string | null;
}): Promise<{ sha: string; files: readonly string[] } | null> {
  const options = { cwd: input.repoPath, credentialToken: input.credentialToken ?? null };
  assertMissionBranchName(input.branch);
  if (await isClean(options)) return null;

  const files = await changedFiles(options);
  await git(['add', '--all'], options);
  await git(
    [
      'commit',
      /* Identity is set per-command rather than in the config, so the clone stays untouched. */
      '-m',
      input.message.slice(0, 2000),
    ],
    options,
  );
  const sha = await headSha(options);
  return { sha, files };
}
