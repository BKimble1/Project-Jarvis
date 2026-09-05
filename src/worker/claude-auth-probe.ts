import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type { ClaudeAuthObservation } from '@/domain/claude-auth';
import { withoutWorkerSecrets } from './child-env';

const run = promisify(execFile);

/**
 * Ask Claude Code which account is signed in.
 *
 * `claude auth status --json` is a supported command that reports the *kind* of login without
 * printing any part of it. That is the whole reason it is used rather than reading a credentials
 * file: Jarvis never needs to see the token, only to know whether one is a subscription login.
 *
 * ## Two details that are easy to get wrong
 *
 * **The probe runs with the worker's own secrets stripped.** Partly for the usual reason — a
 * subprocess has no business inheriting the delivery token — and partly for a specific one: the
 * environment's `ANTHROPIC_API_KEY` would change what this command reports, and the question being
 * asked here is "what login is *stored*", separately from "is a key set in this environment". Two
 * questions, two answers, and conflating them is how an owner ends up unable to tell why Jarvis
 * thinks it is on an API key.
 *
 * **Nothing from stdout is kept except three fields.** The command also returns a projects
 * directory, which is a filesystem path and none of Jarvis's business. Parsing narrowly rather
 * than storing the payload is what keeps that true as the command's output grows.
 */

export const CLAUDE_AUTH_COMMAND = 'claude auth status --json';

/** Short: this runs on every health refresh, and a hung CLI must not stall the worker's loop. */
const TIMEOUT_MS = 10_000;

export interface AuthProbeOptions {
  readonly binary?: string;
  readonly timeoutMs?: number;
  /** Injectable so a test can drive every branch without a Claude installation. */
  readonly exec?: (
    binary: string,
    args: readonly string[],
    options: { env: NodeJS.ProcessEnv; timeout: number },
  ) => Promise<{ stdout: string }>;
  readonly now?: () => Date;
}

/**
 * Returns the observation, or null when Claude Code could not be asked.
 *
 * Null rather than a thrown error, and null rather than a "not logged in" observation: those are
 * three different states and only one of them means the owner needs to sign in. A missing binary
 * is a setup problem; a present binary reporting `loggedIn: false` is a login problem; and the
 * remedy differs.
 */
export async function observeClaudeAuth(
  options: AuthProbeOptions = {},
): Promise<ClaudeAuthObservation | null> {
  const binary = options.binary ?? 'claude';
  const exec =
    options.exec ??
    (async (bin, args, opts) => {
      const result = await run(bin, [...args], {
        env: opts.env,
        timeout: opts.timeout,
        windowsHide: true,
        maxBuffer: 256 * 1024,
      });
      return { stdout: String(result.stdout) };
    });

  let stdout: string;
  try {
    const result = await exec(binary, ['auth', 'status', '--json'], {
      env: withoutWorkerSecrets(),
      timeout: options.timeoutMs ?? TIMEOUT_MS,
    });
    stdout = result.stdout;
  } catch {
    /*
     * Swallowed deliberately and without the error text. A failure here can carry the command
     * line, and a command line can carry an environment; the caller only needs to know that the
     * question could not be answered.
     */
    return null;
  }

  return parseClaudeAuthStatus(stdout, (options.now ?? (() => new Date()))());
}

/**
 * Parse the command's JSON into the three fields Jarvis keeps.
 *
 * Exported so a test can pin the shape against a real payload without spawning anything, and so
 * the narrowing is visible in one place rather than buried in the probe.
 */
export function parseClaudeAuthStatus(stdout: string, now: Date): ClaudeAuthObservation | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;

  const record = parsed as Record<string, unknown>;
  const loggedIn = record.loggedIn;
  if (typeof loggedIn !== 'boolean') return null;

  return {
    loggedIn,
    authMethod: typeof record.authMethod === 'string' ? record.authMethod : null,
    apiProvider: typeof record.apiProvider === 'string' ? record.apiProvider : null,
    observedAt: now.toISOString(),
    source: CLAUDE_AUTH_COMMAND,
  };
}
