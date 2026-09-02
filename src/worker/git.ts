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
]);

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
