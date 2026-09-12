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
 * Build the integration branch, then merge each task branch into it.
 *
 * Where it starts matters, and the answer is "from whatever is already published":
 *
 *  - **No published integration branch** — start from the base. First round.
 *  - **A published one** — continue it. A repair round integrates a second time, and resetting to
 *    the base would make the result a *different* history from the one already on the remote, so
 *    the push would be a non-fast-forward. The only ways out of that are to force-push, which is
 *    forbidden and would discard whatever a reviewer had already read, or to continue — which is
 *    also what an owner reading the branch would expect.
 *
 * Nothing is lost by continuing: a task branch already merged merges again as a no-op, and a
 * failed attempt pushes nothing, so the published branch is always a state that integrated
 * cleanly.
 *
 * Task branches themselves are never modified — they are the preserved record of what each agent
 * did, and they survive a conflict, a failure and a stop.
 */
export async function integrateBranches(request: MergeRequest): Promise<MergeResult> {
  const branch = assertMissionBranchName(request.integrationBranch);
  const options = {
    cwd: request.repoPath,
    credentialToken: request.credentialToken ?? null,
  };

  /*
   * Fetch each task branch by name, with an explicit refspec.
   *
   * A plain `git fetch origin` would not do: the worker clones with `--single-branch`, so the
   * clone's configured refspec covers only the default branch and every task branch would look
   * as though it did not exist. Naming them is also narrower — the integration workspace pulls
   * down exactly the branches it was asked to merge and nothing else.
   */
  for (const candidate of request.branches) {
    const taskBranch = assertMissionBranchName(candidate);
    await git(
      ['fetch', 'origin', `refs/heads/${taskBranch}:refs/remotes/origin/${taskBranch}`],
      options,
    ).catch(() => undefined);
  }

  /* Continue the published integration branch when there is one; otherwise start at the base. */
  await git(
    ['fetch', 'origin', `refs/heads/${branch}:refs/remotes/origin/${branch}`],
    options,
  ).catch(() => undefined);
  const published = await git(
    ['rev-parse', '--verify', '--quiet', `origin/${branch}^{commit}`],
    options,
  ).then(
    (result) => result.stdout.trim().length > 0,
    () => false,
  );

  /* `-B` so a rerun resets rather than fails. */
  if (published) {
    await git(['checkout', '-B', branch, `origin/${branch}`], options);
  } else {
    await git(['checkout', '-B', branch, `origin/${request.baseBranch}`], options).catch(
      async () => {
        /* A local-only base (the sandbox repository in tests) has no `origin/` ref. */
        await git(['checkout', '-B', branch, request.baseBranch], options);
      },
    );
  }

  const merged: string[] = [];

  for (const candidate of request.branches) {
    const taskBranch = assertMissionBranchName(candidate);

    /*
     * Make sure the branch is actually here before asking git to merge it.
     *
     * Without this, a branch the builder committed but never published produces
     * `merge: <branch> - not something we can merge`, which reads like a git problem and is
     * really an "another worker's work never left its machine" problem. Naming that is the
     * difference between an owner knowing what to do and an owner reading a stack trace.
     */
    if (!(await branchExists(request.repoPath, taskBranch, options.credentialToken))) {
      return {
        ok: false,
        merged,
        conflict: {
          branch: taskBranch,
          files: [],
          detail: `${taskBranch} is not in this repository. The task that built it committed its work but never published the branch — usually because that worker has no GitHub write credential — so nothing here can reach it.`,
        },
        headSha: null,
        changedFiles: [],
      };
    }

    request.onProgress?.(`Merging ${taskBranch}…`);
    try {
      /*
       * `--no-ff` keeps each task's work identifiable in the history rather than flattening it,
       * and `--no-edit` stops git opening an editor in a non-interactive process. There is
       * deliberately no `-X` strategy option: those are how conflicts get "resolved" by throwing
       * one side away.
       */
      const local = await git(
        ['rev-parse', '--verify', '--quiet', `${taskBranch}^{commit}`],
        options,
      ).then(
        (result) => result.stdout.trim().length > 0,
        () => false,
      );
      await git(
        ['merge', '--no-ff', '--no-edit', local ? taskBranch : `origin/${taskBranch}`],
        options,
      );
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

/** Is this branch reachable from this clone — locally, or on the remote? */
async function branchExists(
  repoPath: string,
  branch: string,
  credentialToken: string | null,
): Promise<boolean> {
  const options = { cwd: repoPath, credentialToken };
  for (const ref of [branch, `origin/${branch}`]) {
    const found = await git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], options).then(
      (result) => result.stdout.trim().length > 0,
      () => false,
    );
    if (found) return true;
  }
  return false;
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

/**
 * Fetch a mission branch into a read-only clone and produce the diff a reviewer must read.
 *
 * The control plane deliberately does not ship the patch — storing a copy of the repository in
 * the database is not a thing to do — so the reviewer's own clone is where the diff comes from.
 * But a task clone is made with `--single-branch` on the default branch, so it does not contain
 * the integration branch until it is asked for by name.
 *
 * Truncation is reported rather than hidden. A reviewer that has silently been shown two thirds
 * of a change is worse than one that knows it is looking at part of it, because only the second
 * one can say so in its verdict.
 */
export async function readBranchDiff(input: {
  repoPath: string;
  branch: string;
  baseBranch: string;
  credentialToken?: string | null;
  maxBytes?: number;
}): Promise<{
  diff: string;
  files: readonly string[];
  headSha: string | null;
  truncated: boolean;
}> {
  const branch = assertMissionBranchName(input.branch);
  const options = { cwd: input.repoPath, credentialToken: input.credentialToken ?? null };
  const maxBytes = input.maxBytes ?? 200_000;

  await git(
    ['fetch', 'origin', `refs/heads/${branch}:refs/remotes/origin/${branch}`],
    options,
  ).catch(() => undefined);

  const ref = await git(['rev-parse', '--verify', '--quiet', `origin/${branch}^{commit}`], options)
    .then((result) => (result.stdout.trim() ? `origin/${branch}` : null))
    .catch(() => null);
  if (!ref) return { diff: '', files: [], headSha: null, truncated: false };

  const head = await git(['rev-parse', ref], options)
    .then((result) => result.stdout.trim())
    .catch(() => null);

  const files = await git(['diff', '--name-only', `${input.baseBranch}...${ref}`], options)
    .then((result) =>
      result.stdout
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean),
    )
    .catch(() => []);

  const patch = await git(
    ['diff', '--unified=3', `${input.baseBranch}...${ref}`],
    /* A large diff is bounded below; the read only has to be big enough to see the overflow. */
    { ...options, maxOutputBytes: maxBytes + 4096 },
  )
    .then((result) => result.stdout)
    .catch(() => '');

  const truncated = patch.length > maxBytes;
  return {
    diff: truncated
      ? `${patch.slice(0, maxBytes)}\n\n[This diff was truncated at ${maxBytes} characters. You are looking at part of the change; say so in your verdict rather than approving what you could not read.]`
      : patch,
    files,
    headSha: head,
    truncated,
  };
}
