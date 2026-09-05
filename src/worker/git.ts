import { spawn } from 'node:child_process';
import { ValidationError } from '@/domain/errors';
import { assertPushAllowed, evaluatePush } from '@/domain/workspace-safety';
import { redactSecrets } from '@/domain/redaction';

/**
 * The worker's git.
 *
 * An allow-list, not a filter. Only the subcommands below can be run, always as an argument
 * array (never a shell string, so there is no word-splitting and no `;` to smuggle), and every
 * push goes through `assertPushAllowed` before `spawn` is even called.
 *
 * The agent has no access to this module. It is the worker that pushes, after verification, onto
 * the branch the control plane named — which is what makes "cannot push to the default branch"
 * a property of the system rather than a request made of a model.
 */

const ALLOWED_SUBCOMMANDS = new Set([
  'clone',
  'fetch',
  'checkout',
  'switch',
  'branch',
  'status',
  'add',
  'commit',
  'diff',
  'log',
  'rev-parse',
  'remote',
  'push',
  'config',
  'ls-files',
  'symbolic-ref',
  'show',
  /*
   * Prompt 3: the worker merges finished task branches into the mission integration branch.
   *
   * This is the same shape as pushing. The *agent* still cannot merge — `P-CMD03` in
   * `policy.ts` denies `git merge` in any command an agent runs, and that list is unchanged —
   * while the *worker* performs the merge itself, deterministically, only ever into a `jarvis/`
   * branch that `assertMissionBranchName` re-checks immediately beforehand. Two lists, two
   * audiences; widening the worker's does not widen the agent's.
   */
  'merge',
]);

/**
 * Merge strategy options that resolve a conflict by discarding one side.
 *
 * Refused outright rather than left to the caller's discretion: `-X ours` turns "these two agents
 * disagreed" into "one of them silently lost", which is the exact outcome integration exists to
 * prevent.
 */
const FORBIDDEN_MERGE_FLAGS = [
  '-X',
  '--strategy-option',
  '-s',
  '--strategy',
  '--allow-unrelated-histories',
  '--squash',
];

export interface GitResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface GitOptions {
  readonly cwd: string;
  readonly timeoutMs?: number;
  /** Injected only for the push, and only into the environment — never into the argv. */
  readonly credentialToken?: string | null;
  readonly maxOutputBytes?: number;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_OUTPUT = 200_000;

export class GitError extends Error {
  constructor(
    message: string,
    readonly result: GitResult,
  ) {
    super(message);
    this.name = 'GitError';
  }
}

/** Run one git command. Throws `GitError` on a non-zero exit. */
export async function git(args: readonly string[], options: GitOptions): Promise<GitResult> {
  const subcommand = args.find((arg) => !arg.startsWith('-'));
  if (!subcommand || !ALLOWED_SUBCOMMANDS.has(subcommand)) {
    throw new ValidationError(`git ${subcommand ?? '(none)'} is not available to the worker.`);
  }
  if (subcommand === 'merge') {
    for (const arg of args) {
      const flag = arg.split('=')[0] ?? arg;
      /* `-Xours` attaches its value, so a prefix test is needed as well as an exact one. */
      const forbidden =
        FORBIDDEN_MERGE_FLAGS.includes(flag) ||
        arg.startsWith('-X') ||
        (arg.startsWith('-s') && arg !== '-s' && !arg.startsWith('--'));
      if (forbidden) {
        throw new ValidationError(
          `git merge ${arg.slice(0, 20)} resolves conflicts by discarding work, so Jarvis never uses it.`,
        );
      }
    }
  }
  const result = await run('git', args, options);
  if (result.code !== 0) {
    throw new GitError(
      `git ${subcommand} failed (exit ${result.code}): ${result.stderr.slice(0, 500)}`,
      result,
    );
  }
  return result;
}

export interface PushOptions extends GitOptions {
  readonly branch: string;
  readonly defaultBranch: string;
  readonly remote?: string;
}

/**
 * Push the mission branch, and nothing else.
 *
 * The verdict is computed first and, if it refuses, no process is started at all. Note the
 * argument vector: an explicit `refs/heads/<branch>:refs/heads/<branch>` refspec, so there is no
 * ambiguity about what is being updated and no reliance on `push.default`.
 */
export async function pushMissionBranch(options: PushOptions): Promise<GitResult> {
  const remote = options.remote ?? 'origin';
  const refspec = `refs/heads/${options.branch}:refs/heads/${options.branch}`;
  const args = ['push', '--set-upstream', remote, refspec];

  assertPushAllowed({
    remote,
    branch: options.branch,
    defaultBranch: options.defaultBranch,
    args: args.slice(1),
  });

  return git(args, options);
}

/** The verdict without performing anything, for tests and for reporting a refusal. */
export { evaluatePush };

export async function currentBranch(options: GitOptions): Promise<string> {
  const result = await git(['rev-parse', '--abbrev-ref', 'HEAD'], options);
  return result.stdout.trim();
}

export async function headSha(options: GitOptions): Promise<string> {
  const result = await git(['rev-parse', 'HEAD'], options);
  return result.stdout.trim();
}

export async function isClean(options: GitOptions): Promise<boolean> {
  const result = await git(['status', '--porcelain'], options);
  return result.stdout.trim().length === 0;
}

export async function changedFiles(options: GitOptions): Promise<readonly string[]> {
  const result = await git(['status', '--porcelain'], options);
  return result.stdout
    .split('\n')
    .map((line) => line.slice(3).trim())
    .filter((line) => line.length > 0)
    .slice(0, 500);
}

/**
 * Every path the working tree touched, for comparing against a write set.
 *
 * Separate from `changedFiles`, which exists to *describe* a run to a person and is allowed to be
 * approximate. This one decides whether work is allowed to proceed, so the three places where the
 * friendly version is approximate are exactly the three places this cannot be.
 *
 * **Renames report both sides.** `git status --porcelain` renders a rename as `old -> new` on one
 * line, and `line.slice(3).trim()` turns that into the single string `"old -> new"` — which passes
 * a containment check whenever the *old* path is inside the write set. So a task could move a file
 * out of its scope into anywhere it liked and the check would agree. Here both paths are reported
 * separately, because a rename writes in two places.
 *
 * **No quoting.** Without `-z`, git C-quotes any path containing a space or a non-ASCII character,
 * so `my file.ts` arrives as `"my file.ts"` and fails containment against a set that legitimately
 * covers it. `-z` is NUL-separated and never quotes.
 *
 * **No truncation.** The friendly version stops at 500 entries, which is fine for a summary and
 * wrong for a boundary: a task that changed 600 files would have the last 100 unchecked.
 */
export async function changedFilesForScope(options: GitOptions): Promise<readonly string[]> {
  const result = await git(['status', '--porcelain', '-z'], options);
  const fields = result.stdout.split('\0');
  const paths: string[] = [];

  for (let index = 0; index < fields.length; index += 1) {
    const entry = fields[index];
    if (entry === undefined || entry.length === 0) continue;
    /* `XY path`, where XY is the two-character status and a single space follows it. */
    const status = entry.slice(0, 2);
    const path = entry.slice(3);
    if (path.length === 0) continue;
    paths.push(path);
    /*
     * A rename or copy is followed by its source as a separate NUL-terminated field. Consuming it
     * here is what keeps the loop aligned — and reporting it is what makes the check honest, since
     * the source is a path the task also wrote to by emptying it.
     */
    if (status.startsWith('R') || status.startsWith('C')) {
      index += 1;
      const from = fields[index];
      if (from !== undefined && from.length > 0) paths.push(from);
    }
  }

  return paths;
}

export async function remoteUrl(options: GitOptions): Promise<string | null> {
  try {
    const result = await git(['remote', 'get-url', 'origin'], options);
    return redactSecrets(result.stdout.trim());
  } catch {
    return null;
  }
}

export async function diffAgainst(base: string, options: GitOptions): Promise<string> {
  const result = await git(['diff', `${base}...HEAD`], { ...options, maxOutputBytes: 150_000 });
  return result.stdout;
}

/* --------------------------------------------------------------- process */

function run(command: string, args: readonly string[], options: GitOptions): Promise<GitResult> {
  return new Promise((resolve) => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      /* Never let git open an interactive prompt on a headless worker. */
      GIT_TERMINAL_PROMPT: '0',
      GIT_ASKPASS: 'echo',
      GCM_INTERACTIVE: 'never',
      /* Identity for mission commits. Not the owner's; the commit says who made it. */
      GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME ?? 'Jarvis Worker',
      GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL ?? 'jarvis-worker@localhost',
      GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME ?? 'Jarvis Worker',
      GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL ?? 'jarvis-worker@localhost',
    };

    if (options.credentialToken) {
      /*
       * The token reaches git through a credential helper on stdin, not through the remote URL.
       * A URL-embedded credential ends up in `.git/config`, in `git remote -v` output, and in
       * any error message that quotes the URL — all of which the agent can read.
       */
      env.GIT_CONFIG_COUNT = '1';
      env.GIT_CONFIG_KEY_0 = 'credential.helper';
      env.GIT_CONFIG_VALUE_0 = `!f() { echo "username=x-access-token"; echo "password=${options.credentialToken}"; }; f`;
    }

    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env,
      /* Never a shell: the argument array is passed to execve as-is. */
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const limit = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT;
    let stdout = '';
    let stderr = '';
    let settled = false;

    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr: redactSecrets(stderr) });
    };

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      stderr += '\nThe command exceeded its time limit and was stopped.';
      finish(124);
    }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

    child.stdout.on('data', (chunk: Buffer) => {
      if (stdout.length < limit) stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < limit) stderr += chunk.toString('utf8');
    });
    child.on('error', (error) => {
      stderr += `\n${error.message}`;
      finish(127);
    });
    child.on('close', (code) => finish(code ?? 1));
  });
}
