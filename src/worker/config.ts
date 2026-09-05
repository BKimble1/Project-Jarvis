import path from 'node:path';
import { z } from 'zod';
import { ConfigurationError } from '@/domain/errors';
import { WORKER_VERSION } from '@/domain/worker-protocol';

/**
 * Worker configuration.
 *
 * The only place the worker process reads `process.env`. Note what is *not* here: nothing the
 * control plane sends. The worker holds its own Anthropic credential and its own GitHub write
 * credential, so a compromised control plane cannot hand a worker a credential, and a mission
 * payload can never contain one.
 */

const positiveInt = (fallback: number, max: number) =>
  z
    .string()
    .optional()
    .transform((value, ctx) => {
      if (!value || value.trim() === '') return fallback;
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed <= 0 || parsed > max) {
        ctx.addIssue({ code: 'custom', message: `Must be an integer between 1 and ${max}` });
        return z.NEVER;
      }
      return parsed;
    });

/**
 * Like `positiveInt`, but zero is a meaningful answer rather than a mistake.
 *
 * Kept separate rather than folded in with a flag, because for every other interval in this file
 * zero is a typo that would spin a loop as fast as the machine allows, and a single helper that
 * sometimes accepts it is a helper that will eventually accept it in the wrong place.
 */
const positiveIntOrZero = (fallback: number, max: number) =>
  z
    .string()
    .optional()
    .transform((value, ctx) => {
      if (!value || value.trim() === '') return fallback;
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < 0 || parsed > max) {
        ctx.addIssue({ code: 'custom', message: `Must be an integer between 0 and ${max}` });
        return z.NEVER;
      }
      return parsed;
    });

const bool = (fallback: boolean) =>
  z
    .string()
    .optional()
    .transform((value) =>
      value === undefined || value.trim() === ''
        ? fallback
        : ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase()),
    );

const schema = z.object({
  JARVIS_CONTROL_PLANE_URL: z.string().trim().optional(),
  JARVIS_WORKER_TOKEN: z.string().trim().optional(),
  JARVIS_WORKER_NAME: z.string().trim().optional(),
  JARVIS_WORKER_WORKSPACE_ROOT: z.string().trim().optional(),

  ANTHROPIC_API_KEY: z.string().trim().optional(),
  /**
   * A long-lived subscription token, for a worker that cannot use an interactive login.
   *
   * Optional and usually absent. On a machine where the owner has run `claude` and signed in, the
   * login already lives in the Claude Code credential store and the worker needs nothing here —
   * that is the path this V1 expects. This variable exists for the headless case, where the
   * process runs under a service account that has no interactive session to sign in from.
   *
   * Only read in subscription mode, and never logged: like the API key, what travels downstream
   * is whether it is present, not what it says.
   */
  CLAUDE_CODE_OAUTH_TOKEN: z.string().trim().optional(),
  /**
   * Which Claude credential this worker is meant to use.
   *
   * Defaults to `subscription`, which is V1's answer: draw on the owner's Claude subscription and,
   * when its capacity runs out, checkpoint and wait for the reset rather than spending money
   * nobody agreed to. `api_key` is the deliberate opt-in to per-token billing.
   *
   * The default matters. If this defaulted to "whatever is available", a stray ANTHROPIC_API_KEY
   * left in a shell profile would silently move an owner from a subscription they have already
   * paid for onto an invoice they have not seen.
   */
  JARVIS_WORKER_AUTH_MODE: z.enum(['subscription', 'api_key']).default('subscription'),
  /**
   * How often this worker asks the control plane to take a pass of the operating loop.
   *
   * The control plane runs on Netlify, where nothing holds a loop open, so the operating loop
   * needs a caller that keeps existing — and the worker is the only thing in this system that
   * does. Without it the loop has no production caller at all and Jarvis never raises its own
   * work: it waits to be asked, for ever.
   *
   * A minute rather than a few seconds. A pass reads every project and rewrites the backlog, and
   * doing that continuously would spend far more on watching than on working. Set to 0 to turn it
   * off on a worker that should only run missions — the schedule remains as a slower backstop.
   */
  JARVIS_WORKER_OPERATOR_TICK_SECONDS: positiveIntOrZero(60, 3600),
  JARVIS_WORKER_MODEL: z.string().trim().optional(),
  JARVIS_WORKER_MAX_TURNS: positiveInt(60, 500),

  /** Separate from `GITHUB_READ_TOKEN`: this one can write, and only the worker holds it. */
  JARVIS_WORKER_GITHUB_TOKEN: z.string().trim().optional(),
  JARVIS_WORKER_GITHUB_API_URL: z.string().trim().default('https://api.github.com'),

  JARVIS_WORKER_POLL_MS: positiveInt(3000, 60_000),
  JARVIS_WORKER_VERIFY_TIMEOUT_MS: positiveInt(600_000, 3_600_000),
  JARVIS_WORKER_RUN_TIMEOUT_MS: positiveInt(3_600_000, 21_600_000),
  JARVIS_WORKER_ACCEPT_INSPECTION: bool(true),
  JARVIS_WORKER_ACCEPT_EXECUTION: bool(true),
  JARVIS_WORKER_ALLOW_WEB_RESEARCH: bool(false),
  /** Test-only: drives missions with the scripted runtime instead of the Agent SDK. */
  JARVIS_WORKER_RUNTIME: z.enum(['claude', 'scripted']).default('claude'),
  /**
   * Sandbox redirection, as `owner/repo=<clone url>` pairs separated by commas.
   *
   * Points a named repository at somewhere else to clone from — a local bare repository, or a
   * throwaway fork — so a mission can be rehearsed end to end without touching the real thing.
   * Deliberately worker-side and loudly reported in the heartbeat: a redirected worker says so on
   * the workers page, so nobody mistakes a rehearsal for the real delivery.
   */
  JARVIS_WORKER_SANDBOX_REPOS: z.string().trim().optional(),
  /**
   * Repositories this worker may deliver to, as `owner/repo` names separated by commas.
   *
   * Defence in depth behind the credential rather than a replacement for it: the fine-grained
   * token should already be scoped, and this is the second lock, held by the machine that does
   * the pushing rather than by GitHub's settings page. It is worker-side for the same reason the
   * sandbox map is — the control plane cannot widen it by sending a different assignment.
   *
   * Unset means "whatever the token allows", which is the honest description of the state a
   * deployment starts in and is reported as such in the heartbeat. Set it, and a delivery to
   * anything else is refused before a request is made.
   */
  JARVIS_WORKER_ALLOWED_REPOS: z.string().trim().optional(),
});

export interface WorkerConfig {
  readonly controlPlaneUrl: string;
  readonly token: string;
  readonly name: string;
  readonly workspaceRoot: string;
  /**
   * The API key, when this worker is deliberately on `api_key` mode.
   *
   * Null in subscription mode *even when the variable is set*, so that nothing downstream can
   * accidentally pass a key the owner did not ask to use. Whether the variable exists at all is a
   * separate field, because that is what makes the mode ambiguous and it has to be reportable.
   */
  readonly anthropicApiKey: string | null;
  /** Whether ANTHROPIC_API_KEY exists in this worker's environment. Never its value. */
  readonly anthropicApiKeyPresent: boolean;
  /**
   * The subscription token to hand the agent session, or null.
   *
   * Null both when the owner has not set one — the ordinary case, where the Claude Code login on
   * this machine is the credential — and whenever key billing was chosen, so that the two model
   * credentials can never both be in the child environment at once.
   */
  readonly claudeOauthToken: string | null;
  readonly authMode: 'subscription' | 'api_key';
  /** Milliseconds between passes of the operating loop, or null when this worker does not drive it. */
  readonly operatorTickIntervalMs: number | null;
  readonly model: string | null;
  readonly maxTurns: number;
  readonly githubToken: string | null;
  readonly githubApiUrl: string;
  readonly pollIntervalMs: number;
  readonly verifyTimeoutMs: number;
  readonly runTimeoutMs: number;
  readonly accepts: readonly ('inspection' | 'execution' | 'research')[];
  readonly allowWebResearch: boolean;
  readonly runtime: 'claude' | 'scripted';
  /** `owner/repo` → clone URL. Empty in an ordinary deployment. */
  readonly sandboxRepositories: ReadonlyMap<string, string>;
  /**
   * Lower-cased `owner/repo` names this worker may deliver to.
   *
   * Null — not an empty set — when unset, because the two mean opposite things: null is "the
   * token decides", an empty set would be "nothing at all". Conflating them is how an allow-list
   * accidentally becomes a deny-everything.
   */
  readonly allowedRepositories: ReadonlySet<string> | null;
  readonly version: string;
  /** Non-fatal problems, reported in the heartbeat and shown on the workers page. */
  readonly diagnostics: readonly string[];
}

/*
 * Re-exported from `@/domain` so the worker and the control plane cannot disagree about which
 * build is current. The constant is defined there; this line only keeps the existing import
 * sites working.
 */
export { WORKER_VERSION };

export function buildWorkerConfig(source: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    throw new ConfigurationError(
      `Invalid worker configuration:\n - ${parsed.error.issues
        .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
        .join('\n - ')}`,
    );
  }
  const env = parsed.data;
  const diagnostics: string[] = [];

  /* These three are fatal: without them the worker has nothing to talk to and nowhere to work. */
  if (!env.JARVIS_CONTROL_PLANE_URL) {
    throw new ConfigurationError(
      'JARVIS_CONTROL_PLANE_URL must be set to the Jarvis deployment this worker reports to.',
    );
  }
  if (!env.JARVIS_WORKER_TOKEN) {
    throw new ConfigurationError(
      'JARVIS_WORKER_TOKEN must be set. Enrol a worker in Jarvis under Settings → Workers to get one.',
    );
  }
  let controlPlaneUrl: string;
  try {
    controlPlaneUrl = new URL(env.JARVIS_CONTROL_PLANE_URL).origin;
  } catch {
    throw new ConfigurationError(
      `JARVIS_CONTROL_PLANE_URL is not a valid absolute URL: ${env.JARVIS_CONTROL_PLANE_URL}`,
    );
  }

  const workspaceRoot = path.resolve(
    env.JARVIS_WORKER_WORKSPACE_ROOT ?? path.join(process.cwd(), '.jarvis-workspaces'),
  );

  /*
   * The billing ambiguity, caught at configuration time.
   *
   * A key present in subscription mode is not a warning: the SDK would use it in preference to the
   * subscription login, so the worker would run — and invoice — while the owner believed otherwise.
   * The variable is left exactly where it is; only the remedy is stated.
   */
  const apiKeyPresent = Boolean(env.ANTHROPIC_API_KEY);
  if (env.JARVIS_WORKER_AUTH_MODE === 'subscription' && apiKeyPresent) {
    diagnostics.push(
      'ANTHROPIC_API_KEY is set but this worker is configured for your Claude subscription. That key would take precedence and bill the API account, so Jarvis will not run model work until the ambiguity is resolved. Start the worker without the variable, or set JARVIS_WORKER_AUTH_MODE=api_key to use it deliberately.',
    );
  }
  if (env.JARVIS_WORKER_AUTH_MODE === 'api_key' && !apiKeyPresent) {
    diagnostics.push(
      'JARVIS_WORKER_AUTH_MODE is api_key but ANTHROPIC_API_KEY is not set, so this worker cannot run a Claude session.',
    );
  }
  if (env.JARVIS_WORKER_AUTH_MODE === 'subscription') {
    diagnostics.push(
      'Model work draws on your Claude subscription. When its capacity runs out this worker checkpoints and waits for the reset rather than spending anything.',
    );
  }
  if (env.JARVIS_WORKER_AUTH_MODE === 'api_key' && env.CLAUDE_CODE_OAUTH_TOKEN) {
    /*
     * The mirror of the ambiguity above, and worth saying out loud even though it is the safer
     * direction: the owner has a subscription token sitting in the environment and has asked for
     * key billing anyway. Jarvis does what it was told and uses the key, but an owner who set that
     * token expecting it to be used deserves to be told it is being ignored.
     */
    diagnostics.push(
      'CLAUDE_CODE_OAUTH_TOKEN is set but this worker is configured for api_key billing, so the token is ignored and model work is invoiced per token. Set JARVIS_WORKER_AUTH_MODE=subscription to use the token instead.',
    );
  }
  if (!env.JARVIS_WORKER_GITHUB_TOKEN) {
    diagnostics.push(
      'JARVIS_WORKER_GITHUB_TOKEN is not set, so this worker cannot push a branch or open a pull request. Read-only and research missions still work.',
    );
  }

  const allowedRepositories = parseRepositoryList(env.JARVIS_WORKER_ALLOWED_REPOS);
  if (allowedRepositories) {
    diagnostics.push(
      `Delivery is restricted to ${[...allowedRepositories].join(', ')}. Anything else is refused here, whatever the token allows.`,
    );
  } else if (env.JARVIS_WORKER_GITHUB_TOKEN) {
    diagnostics.push(
      'JARVIS_WORKER_ALLOWED_REPOS is not set, so delivery is limited only by what the GitHub token itself can reach.',
    );
  }

  const sandboxRepositories = parseSandboxRepositories(env.JARVIS_WORKER_SANDBOX_REPOS);
  for (const [fullName, cloneUrl] of sandboxRepositories) {
    diagnostics.push(
      `Sandbox mode: ${fullName} is cloned from ${cloneUrl} instead. No code is read from the real repository and nothing is pushed to it.`,
    );
    /*
     * The half a redirect does not cover, said where an owner will see it.
     *
     * Redirection changes the clone and nothing else: the pull request would still be opened
     * against the repository the control plane named. Someone rehearsing a mission for a
     * repository they care about needs to know that, and the honest place to say it is beside
     * the reassurance, not in a document.
     */
    if (!allowedRepositories && env.JARVIS_WORKER_GITHUB_TOKEN) {
      diagnostics.push(
        `${fullName} is redirected for cloning but delivery is not restricted: a pull request would still be opened against it. Set JARVIS_WORKER_ALLOWED_REPOS, or use a token that cannot reach it.`,
      );
    }
  }

  const accepts: ('inspection' | 'execution' | 'research')[] = [];
  if (env.JARVIS_WORKER_ACCEPT_INSPECTION) accepts.push('inspection');
  if (env.JARVIS_WORKER_ACCEPT_EXECUTION) accepts.push('execution', 'research');
  if (accepts.length === 0) {
    throw new ConfigurationError(
      'This worker accepts no kind of work. Enable JARVIS_WORKER_ACCEPT_INSPECTION or JARVIS_WORKER_ACCEPT_EXECUTION.',
    );
  }

  return {
    controlPlaneUrl,
    token: env.JARVIS_WORKER_TOKEN,
    name: env.JARVIS_WORKER_NAME ?? 'jarvis-worker',
    workspaceRoot,
    /*
     * Null unless the owner asked for key billing. A key present in subscription mode is reported
     * through `anthropicApiKeyPresent` and refused by `resolveClaudeAuth`, never quietly used.
     */
    anthropicApiKey:
      env.JARVIS_WORKER_AUTH_MODE === 'api_key' ? (env.ANTHROPIC_API_KEY ?? null) : null,
    anthropicApiKeyPresent: apiKeyPresent,
    /* Symmetrically null in the other mode: only one model credential ever travels. */
    claudeOauthToken:
      env.JARVIS_WORKER_AUTH_MODE === 'subscription' ? (env.CLAUDE_CODE_OAUTH_TOKEN ?? null) : null,
    authMode: env.JARVIS_WORKER_AUTH_MODE,
    operatorTickIntervalMs:
      env.JARVIS_WORKER_OPERATOR_TICK_SECONDS > 0
        ? env.JARVIS_WORKER_OPERATOR_TICK_SECONDS * 1000
        : null,
    model: env.JARVIS_WORKER_MODEL ?? null,
    maxTurns: env.JARVIS_WORKER_MAX_TURNS,
    githubToken: env.JARVIS_WORKER_GITHUB_TOKEN ?? null,
    githubApiUrl: env.JARVIS_WORKER_GITHUB_API_URL.replace(/\/+$/, ''),
    pollIntervalMs: env.JARVIS_WORKER_POLL_MS,
    verifyTimeoutMs: env.JARVIS_WORKER_VERIFY_TIMEOUT_MS,
    runTimeoutMs: env.JARVIS_WORKER_RUN_TIMEOUT_MS,
    accepts,
    allowWebResearch: env.JARVIS_WORKER_ALLOW_WEB_RESEARCH,
    runtime: env.JARVIS_WORKER_RUNTIME,
    sandboxRepositories,
    allowedRepositories,
    version: WORKER_VERSION,
    diagnostics,
  };
}

/**
 * `owner/repo,owner/other` — or null when the variable is absent.
 *
 * Null and empty are different answers and are kept different: an unset variable means the token
 * decides, while a variable set to nothing usable is a configuration mistake that must not read
 * as "allow everything". A value that parses to no valid name yields an empty set, and delivery
 * to anything is then refused — loudly, and in the direction that is safe to be wrong in.
 */
export function parseRepositoryList(value: string | undefined): ReadonlySet<string> | null {
  if (value === undefined) return null;
  const names = new Set<string>();
  for (const entry of value.split(',')) {
    const name = entry.trim().toLowerCase();
    if (/^[^/\s]+\/[^/\s]+$/.test(name)) names.add(name);
  }
  return names;
}

/** `owner/repo=<clone url>,owner/other=<clone url>`. Malformed entries are ignored, not guessed. */
export function parseSandboxRepositories(value: string | undefined): ReadonlyMap<string, string> {
  const map = new Map<string, string>();
  if (!value) return map;
  for (const entry of value.split(',')) {
    const separator = entry.indexOf('=');
    if (separator <= 0) continue;
    const fullName = entry.slice(0, separator).trim().toLowerCase();
    const cloneUrl = entry.slice(separator + 1).trim();
    if (!/^[^/\s]+\/[^/\s]+$/.test(fullName) || cloneUrl.length === 0) continue;
    map.set(fullName, cloneUrl);
  }
  return map;
}

/**
 * A redacted view of the worker's configuration.
 *
 * What the worker is allowed to say about itself in a heartbeat. Every credential is reported as
 * a boolean, and the workspace root as its basename rather than a full host path.
 */
export function describeWorkerConfig(config: WorkerConfig): {
  readonly runtimeAvailable: boolean;
  readonly githubDeliveryConfigured: boolean;
  readonly workspaceRootLabel: string;
} {
  return {
    runtimeAvailable: config.anthropicApiKey !== null || config.runtime === 'scripted',
    githubDeliveryConfigured: config.githubToken !== null,
    workspaceRootLabel: path.basename(config.workspaceRoot),
  };
}
