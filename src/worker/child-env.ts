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
  /*
   * The one credential that can create a repository. A coding agent has no business holding it:
   * everything it does happens inside a repository that already exists, and a repository created
   * by mistake is the only outward-visible thing here that reverting a commit cannot undo.
   */
  'GITHUB_PROVISION_TOKEN',
  'JARVIS_CI_GITHUB_TOKEN',
  'SESSION_SECRET',
  'CRON_SECRET',
  'DATABASE_URL',
  'JARVIS_TEST_AUTH_SECRET',
  /*
   * The key the credential vault exists to protect.
   *
   * `src/server/security/credential-vault.ts` encrypts the Microsoft refresh token at rest with
   * this; handing it to a coding agent hands over everything it was protecting. The previous key is
   * listed for the same reason — it decrypts anything not yet rotated.
   */
  'JARVIS_CREDENTIAL_KEY',
  'JARVIS_CREDENTIAL_KEY_PREVIOUS',
  /*
   * The OAuth client secrets. Neither is a token, so neither is caught by shape: a hex string and a
   * tilde-bearing Azure secret look like ordinary configuration. With the client secret and a
   * redirect an attacker completes the flow as Jarvis.
   */
  'GITHUB_OAUTH_CLIENT_SECRET',
  'MICROSOFT_CLIENT_SECRET',
  /* Signs push notifications. A private key by name and by nature. */
  'JARVIS_PUSH_PRIVATE_KEY',
] as const;

const SECRET_BY_NAME = new Set<string>(WORKER_ONLY_SECRETS);

/**
 * Jarvis's own variables that name themselves as credentials.
 *
 * Deliberately narrow: only the `JARVIS_` prefix, and only the five words that mean "this is a
 * secret". `JARVIS_WORKSPACE_ROOT` and `JARVIS_CONTROL_PLANE_URL` are configuration the agent's
 * environment legitimately carries, and neither matches.
 *
 * It over-matches in three harmless places — `JARVIS_MAX_MISSION_OUTPUT_TOKENS`,
 * `JARVIS_MAX_TASK_OUTPUT_TOKENS` and `JARVIS_CREDENTIAL_KEY_VERSION` are numbers, not secrets.
 * All three are read by `src/server/config/env.ts` in the control plane, and every one of them has
 * a default; no child spawned from here loads that config, so removing them changes nothing. That
 * is the trade this rule is making on purpose: a false positive costs a default, a false negative
 * costs a credential.
 */
const JARVIS_SECRET_NAME = /^JARVIS_.*(?:SECRET|TOKEN|KEY|PASSWORD|CREDENTIAL)/;

function looksLikeJarvisSecretName(key: string): boolean {
  return JARVIS_SECRET_NAME.test(key);
}

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
     * Name, for Jarvis's own variables — so the next secret is stripped by default rather than by
     * somebody remembering to add it to the list above.
     *
     * The list is what caught this: five credentials reached the agent, including the vault key,
     * because they were added after the list was written and none of them matches a token shape.
     * A rule scoped to the `JARVIS_` prefix cannot collide with the repository's own variables —
     * the verification runner executes the project's test commands, and a project's `MY_API_KEY`
     * has to survive or its tests fail for a reason nobody can see.
     */
    if (looksLikeJarvisSecretName(key)) {
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
