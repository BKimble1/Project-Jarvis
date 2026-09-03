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
});

export interface WorkerConfig {
  readonly controlPlaneUrl: string;
  readonly token: string;
  readonly name: string;
  readonly workspaceRoot: string;
  readonly anthropicApiKey: string | null;
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

  if (!env.ANTHROPIC_API_KEY) {
    diagnostics.push(
      'ANTHROPIC_API_KEY is not set, so this worker cannot run a Claude session. It will report itself unavailable rather than claim missions it cannot do.',
    );
  }
  if (!env.JARVIS_WORKER_GITHUB_TOKEN) {
    diagnostics.push(
      'JARVIS_WORKER_GITHUB_TOKEN is not set, so this worker cannot push a branch or open a pull request. Read-only and research missions still work.',
    );
  }

  const sandboxRepositories = parseSandboxRepositories(env.JARVIS_WORKER_SANDBOX_REPOS);
  for (const [fullName, cloneUrl] of sandboxRepositories) {
    diagnostics.push(
      `Sandbox mode: ${fullName} is redirected to ${cloneUrl}. Missions for it do not touch the real repository.`,
    );
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
    anthropicApiKey: env.ANTHROPIC_API_KEY ?? null,
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
    version: WORKER_VERSION,
    diagnostics,
  };
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
