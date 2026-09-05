import { containsSecret } from '@/domain/redaction';

/**
 * What a child process of the worker is allowed to inherit.
 *
 * ## The hole this closes
 *
 * The agent session was started with `env: { ...process.env, ... }`, and the agent has Bash. The
 * tool policy blocks reading credential *files* — `.ssh/`, `id_rsa`, `.aws/credentials`, `.netrc`
 * — but nothing blocks `env`, `printenv`, or `echo $JARVIS_WORKER_GITHUB_TOKEN`. So the delivery
 * credential, whose entire purpose is to be unreachable by the model, was one shell command away.
 *
 * That mattered more than it looks. The delivery client's four methods, the push guard and the
 * CI separation are all built on the model not holding the raw token: an agent that can read the
 * PAT can call any GitHub endpoint with `curl` and every one of those controls is decoration.
 * Redaction does not help — it scrubs the token on the way *out* into events, and does nothing
 * about the agent using it.
 *
 * The verification runner already did this correctly (`src/worker/verification.ts` strips exactly
 * these four variables before running a repository's own test command). This module exists so the
 * two paths cannot drift: both call the same function, and a test asserts the agent session's
 * environment carries no credential.
 *
 * ## Two filters, because names are not enough
 *
 * **By name**, for the variables Jarvis itself defines — the only complete list, because Jarvis
 * chose those names.
 *
 * **By shape**, for everything else. An owner may well have `MY_GH_PAT`, `GH_TOKEN_WORK` or
 * `DEPLOY_KEY` in the shell they started the worker from, and the worker has no way to know those
 * names in advance. A value that looks like a GitHub token, an Anthropic key or a Jarvis worker
 * secret is not something a coding agent needs, so it does not travel.
 *
 * Both model credentials — `ANTHROPIC_API_KEY` and `CLAUDE_CODE_OAUTH_TOKEN` — are removed by
 * name and then put back deliberately by the caller, and only the one the configured
 * authentication mode actually calls for. The agent genuinely needs a model credential, and
 * passing it explicitly rather than inheriting it means the one credential that *should* be there
 * is visible at the call site.
 *
 * The subscription token has to be named here even though the shape filter would also catch it.
 * `CLAUDE_CODE_OAUTH_TOKEN` holds an `sk-ant-oat01-…` value, which `containsSecret` matches, so
 * before it was named it was deleted silently — a worker started with a perfectly good
 * subscription token would fail to authenticate with no message saying why. Naming it makes the
 * removal deliberate and the re-add visible, which is the whole point of the two-filter design.
 */

/** Variables Jarvis defines that must never reach a child process. */
export const WORKER_ONLY_SECRETS = [
  /* Delivery: pushes the mission branch and opens the draft pull request. */
  'JARVIS_WORKER_GITHUB_TOKEN',
  /* The worker's own identity with the control plane. Posts runs, events and verdicts. */
  'JARVIS_WORKER_TOKEN',
  /* The model credentials. Re-added explicitly by the agent runtime, never inherited. */
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
  /* Names a shared environment file may carry if the worker sits beside the control plane. */
  'GITHUB_TOKEN',
  'GH_TOKEN',
  'GITHUB_READ_TOKEN',
  'JARVIS_CI_GITHUB_TOKEN',
  'SESSION_SECRET',
  'CRON_SECRET',
  'DATABASE_URL',
  'JARVIS_TEST_AUTH_SECRET',
] as const;

const SECRET_BY_NAME = new Set<string>(WORKER_ONLY_SECRETS);

/**
 * A copy of the environment with every credential removed.
 *
 * Returns `string | undefined` values rather than deleting keys, because that is the shape both
 * `spawn` and the Agent SDK accept for "unset this" — assigning `undefined` is what actually
 * removes an inherited variable, where omitting the key would leave the parent's value in place
 * on some paths.
 */
export function withoutWorkerSecrets(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  /*
   * Typed as the environment it replaces, so a caller cannot accidentally hand `spawn` a plain
   * record and lose the platform's own required entries.
   */
  const safe = {} as NodeJS.ProcessEnv;

  for (const [key, value] of Object.entries(source)) {
    if (SECRET_BY_NAME.has(key)) {
      safe[key] = undefined;
      continue;
    }
    /*
     * Shape, for the names Jarvis could not know. Only string values are inspected; a variable
     * with no value cannot be a credential.
     */
    if (typeof value === 'string' && value.length >= 16 && containsSecret(value)) {
      safe[key] = undefined;
      continue;
    }
    safe[key] = value;
  }

  return safe;
}

/**
 * The names a test can assert are absent.
 *
 * Exported so the assertion and the filter cannot disagree: a variable added to the list above is
 * automatically covered by the test that iterates this.
 */
export function workerSecretNames(): readonly string[] {
  return WORKER_ONLY_SECRETS;
}
