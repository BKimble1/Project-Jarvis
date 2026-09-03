import { z } from 'zod';
import { ConfigurationError } from '@/domain/errors';
import { clampCapacityLimits, type CapacityLimits } from '@/domain/capacity';

/**
 * Environment configuration.
 *
 * This module is the only place that reads `process.env`. It is server-only: nothing here is
 * ever imported from a client component, and no value is exposed through `NEXT_PUBLIC_*`.
 *
 * The guiding rule is **fail closed**: in production, a missing owner identity, session secret
 * or database URL is a hard configuration error rather than a permissive default.
 */

const bool = (defaultValue: boolean) =>
  z
    .string()
    .optional()
    .transform((value) => {
      if (value === undefined || value.trim() === '') return defaultValue;
      return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
    });

/** A comma- or space-separated allow-list from an environment variable. Empty means empty. */
const splitList = (value: string | undefined): readonly string[] =>
  (value ?? '')
    .split(/[,\s]+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

const positiveInt = (defaultValue: number, max = 1_000_000) =>
  z
    .string()
    .optional()
    .transform((value, ctx) => {
      if (value === undefined || value.trim() === '') return defaultValue;
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed <= 0 || parsed > max) {
        ctx.addIssue({ code: 'custom', message: `Must be an integer between 1 and ${max}` });
        return z.NEVER;
      }
      return parsed;
    });

const rawSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  JARVIS_BASE_URL: z.string().trim().optional(),
  SESSION_SECRET: z.string().trim().optional(),
  SESSION_TTL_HOURS: positiveInt(24 * 14, 24 * 365),

  OWNER_GITHUB_LOGIN: z.string().trim().optional(),
  OWNER_GITHUB_USER_ID: z.string().trim().optional(),

  GITHUB_OAUTH_CLIENT_ID: z.string().trim().optional(),
  GITHUB_OAUTH_CLIENT_SECRET: z.string().trim().optional(),
  GITHUB_READ_TOKEN: z.string().trim().optional(),
  GITHUB_API_BASE_URL: z.string().trim().default('https://api.github.com'),

  DATABASE_URL: z.string().trim().optional(),
  JARVIS_DB_DRIVER: z.enum(['neon', 'pg', 'pglite']).optional(),
  PGLITE_DATA_DIR: z.string().trim().optional(),

  ANTHROPIC_API_KEY: z.string().trim().optional(),
  JARVIS_AI_MODEL: z.string().trim().default('claude-opus-5'),
  JARVIS_AI_ENABLED: bool(true),

  CRON_SECRET: z.string().trim().optional(),

  /* ------------------------------------------------------- Mission Control */
  /**
   * How many missions may run at once. Prompt 2 ships one on purpose: everything below is built
   * for concurrency, but the product has not yet earned the right to use it.
   */
  JARVIS_MISSION_CONCURRENCY: positiveInt(1, 4),
  /** Web research for read-only missions. Off unless deliberately enabled. */
  JARVIS_ALLOW_WEB_RESEARCH: bool(false),
  JARVIS_MISSION_EVENT_RETENTION_DAYS: positiveInt(180, 3650),

  /* ------------------------------------------- Prompt 3: the agent factory */
  /**
   * Capacity.
   *
   * Every one of these is clamped again by `clampCapacityLimits` against an absolute ceiling in
   * `@/domain/capacity`, so a mistaken value here cannot produce a Jarvis running twenty agents.
   * The defaults are deliberately small; raising them is a decision, not a slider.
   */
  JARVIS_MAX_ACTIVE_MISSIONS: positiveInt(2, 6),
  JARVIS_MAX_ACTIVE_AGENT_RUNS: positiveInt(4, 12),
  JARVIS_MAX_RUNS_PER_MISSION: positiveInt(3, 6),
  JARVIS_MAX_PARALLEL_READONLY: positiveInt(3, 6),
  JARVIS_MAX_PARALLEL_WRITERS: positiveInt(1, 3),
  JARVIS_MAX_REPAIR_ROUNDS: z
    .string()
    .optional()
    .transform((value, ctx) => {
      if (value === undefined || value.trim() === '') return 2;
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < 0 || parsed > 3) {
        ctx.addIssue({ code: 'custom', message: 'Must be 0, 1, 2 or 3' });
        return z.NEVER;
      }
      return parsed;
    }),
  JARVIS_MAX_TASK_RUNTIME_MINUTES: positiveInt(45, 240),
  JARVIS_MAX_MISSION_RUNTIME_MINUTES: positiveInt(240, 720),
  JARVIS_MAX_MISSION_OUTPUT_TOKENS: positiveInt(3_000_000, 20_000_000),
  JARVIS_MAX_TASK_OUTPUT_TOKENS: positiveInt(600_000, 4_000_000),

  /**
   * The CI controller.
   *
   * Off unless explicitly enabled *and* given a credential of its own. It never borrows the
   * worker's delivery token, and the worker's GitHub client has no method it could use anyway.
   */
  JARVIS_CI_ENABLED: bool(false),
  JARVIS_CI_GITHUB_TOKEN: z.string().trim().optional(),
  JARVIS_CI_API_URL: z.string().trim().optional(),
  JARVIS_CI_REPOSITORIES: z.string().trim().optional(),
  JARVIS_CI_WORKFLOWS: z.string().trim().optional(),
  JARVIS_CI_REFS: z.string().trim().optional(),
  JARVIS_CI_MAX_DISPATCHES_PER_HOUR: positiveInt(4, 60),

  /* ------------------------------------------- Prompt 4: completion */

  /**
   * Where live qualification is allowed to happen.
   *
   * An allow-list, not a permission. Jarvis may have read access to fifty repositories; exactly
   * none of them become a place to rehearse a real write until they are named here.
   */
  JARVIS_QUALIFICATION_REPOS: z.string().trim().optional(),

  /**
   * Backups.
   *
   * `JARVIS_BACKUP_TARGET` is a *label* — "neon-pitr", "nightly-s3" — never a connection string.
   * Jarvis has no reason to hold backup credentials and therefore no field for them.
   */
  JARVIS_BACKUP_CONFIGURED: bool(false),
  JARVIS_BACKUP_TARGET: z.string().trim().optional(),
  JARVIS_BACKUP_RESTORE_TESTED_AT: z.string().trim().optional(),

  /** The commit this build came from, so a qualification can name what it qualified. */
  JARVIS_BUILD_REF: z.string().trim().optional(),

  /* ------------------------------------------------------------ knowledge */
  /**
   * Hosts a URL may be fetched from.
   *
   * Empty means URL ingestion is off. Fetching arbitrary URLs on my behalf is a request-forgery
   * primitive, and the SSRF guard in `domain/knowledge-source.ts` is the second line rather than
   * the first.
   */
  JARVIS_KNOWLEDGE_URL_ALLOWLIST: z.string().trim().optional(),
  JARVIS_KNOWLEDGE_MAX_SOURCES: positiveInt(2_000, 100_000),
  /**
   * The semantic retrieval provider.
   *
   * `none` is the default and is a valid, honestly-reported configuration: full-text search works
   * and nothing claims to be semantic. `deterministic` enables a local hashed-trigram index — a
   * genuine second channel that finds near-spellings, costing nothing and reaching no network.
   */
  JARVIS_KNOWLEDGE_EMBEDDINGS: z.enum(['none', 'deterministic']).default('none'),
  JARVIS_KNOWLEDGE_EMBEDDING_DIMENSIONS: positiveInt(256, 4_096),

  /* ----------------------------------------------------------- scheduling */
  JARVIS_SCHEDULER_ENABLED: bool(true),
  /** The zone a new schedule defaults to. Always an IANA name; never an offset. */
  JARVIS_DEFAULT_TIME_ZONE: z.string().trim().default('UTC'),

  /* -------------------------------------------------------- notifications */
  /**
   * Web push (VAPID).
   *
   * The public key is meant to reach the browser — that is what it is for. The private key is a
   * credential and is never sent anywhere, never logged and never included in an export.
   */
  JARVIS_PUSH_PUBLIC_KEY: z.string().trim().optional(),
  JARVIS_PUSH_PRIVATE_KEY: z.string().trim().optional(),
  JARVIS_PUSH_SUBJECT: z.string().trim().optional(),

  /* --------------------------------------------------------------- limits */
  JARVIS_RATE_LIMIT_ENABLED: bool(true),
  JARVIS_RATE_LIMIT_PER_MINUTE: positiveInt(240, 20_000),
  JARVIS_ASK_RATE_LIMIT_PER_HOUR: positiveInt(120, 5_000),
  JARVIS_MAX_REQUEST_BYTES: positiveInt(1_000_000, 20_000_000),
  JARVIS_MAX_UPLOAD_BYTES: positiveInt(12_000_000, 64_000_000),

  /* ------------------------------------------------------------ retention */
  JARVIS_RETENTION_USAGE_DAYS: positiveInt(730, 3650),
  JARVIS_RETENTION_NOTIFICATION_DAYS: positiveInt(120, 3650),
  JARVIS_RETENTION_ANSWER_DAYS: positiveInt(365, 3650),
  JARVIS_RETENTION_VOICE_DAYS: positiveInt(90, 3650),
  /** Audit records are kept longest, and the sweeper refuses to go below this floor. */
  JARVIS_RETENTION_AUDIT_DAYS: positiveInt(1095, 3650),

  JARVIS_DEMO_MODE: bool(false),
  JARVIS_ALLOW_DEMO_IN_PRODUCTION: bool(false),

  /** Enables a signed test-auth endpoint used by Playwright. Never honoured in production. */
  JARVIS_TEST_AUTH_SECRET: z.string().trim().optional(),

  JARVIS_SYNC_COMMIT_LIMIT: positiveInt(60, 300),
  JARVIS_SYNC_PR_LIMIT: positiveInt(40, 200),
  JARVIS_SYNC_ISSUE_LIMIT: positiveInt(40, 200),
  JARVIS_SYNC_WORKFLOW_LIMIT: positiveInt(30, 150),
  JARVIS_SYNC_RELEASE_LIMIT: positiveInt(10, 50),
  JARVIS_SYNC_DEPLOYMENT_LIMIT: positiveInt(10, 50),
  JARVIS_SYNC_HISTORY_DAYS: positiveInt(90, 730),
  JARVIS_SYNC_TIMEOUT_MS: positiveInt(20_000, 120_000),
  JARVIS_SYNC_LOCK_TTL_SECONDS: positiveInt(300, 3600),
  JARVIS_RETENTION_SNAPSHOT_DAYS: positiveInt(365, 3650),
  JARVIS_RETENTION_ACTIVITY_DAYS: positiveInt(365, 3650),

  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});

export type RawEnv = z.infer<typeof rawSchema>;

export interface AppConfig {
  readonly nodeEnv: 'development' | 'test' | 'production';
  readonly isProduction: boolean;
  readonly baseUrl: string;
  readonly sessionSecret: string;
  readonly sessionTtlHours: number;
  readonly owner: { readonly githubLogin: string | null; readonly githubUserId: string | null };
  readonly githubOAuth: { readonly clientId: string; readonly clientSecret: string } | null;
  readonly githubReadToken: string | null;
  readonly githubApiBaseUrl: string;
  readonly database: {
    readonly driver: 'neon' | 'pg' | 'pglite';
    readonly url: string | null;
    readonly pgliteDataDir: string | null;
  };
  readonly ai: {
    readonly enabled: boolean;
    readonly apiKey: string | null;
    readonly model: string;
  };
  readonly cronSecret: string | null;
  readonly missions: {
    readonly concurrencyLimit: number;
    readonly allowWebResearch: boolean;
    readonly eventRetentionDays: number;
    readonly capacity: CapacityLimits;
  };
  /**
   * The CI controller's own configuration.
   *
   * `enabled` is true only when the owner switched it on *and* supplied a separate credential:
   * an enabled controller with no token of its own would be a controller looking for one to
   * borrow, and there is nothing here for it to borrow from.
   */
  readonly ci: {
    readonly enabled: boolean;
    readonly credentialConfigured: boolean;
    readonly token: string | null;
    readonly apiUrl: string;
    readonly repositories: readonly string[];
    readonly workflows: readonly string[];
    readonly refs: readonly string[];
    readonly maxDispatchesPerHour: number;
  };
  readonly demoMode: boolean;
  readonly testAuthSecret: string | null;
  readonly sync: {
    readonly commitLimit: number;
    readonly prLimit: number;
    readonly issueLimit: number;
    readonly workflowLimit: number;
    readonly releaseLimit: number;
    readonly deploymentLimit: number;
    readonly historyDays: number;
    readonly timeoutMs: number;
    readonly lockTtlSeconds: number;
  };
  readonly retention: {
    readonly snapshotDays: number;
    readonly activityDays: number;
    readonly usageDays: number;
    readonly notificationDays: number;
    readonly answerDays: number;
    readonly voiceDays: number;
    readonly auditDays: number;
  };
  readonly qualification: {
    readonly sandboxRepositories: readonly string[];
    readonly buildRef: string | null;
    readonly backupConfigured: boolean;
    readonly backupTarget: string | null;
    readonly backupRestoreTestedAt: string | null;
  };
  readonly knowledge: {
    readonly urlAllowList: readonly string[];
    readonly maxSources: number;
    readonly embeddingProvider: 'none' | 'deterministic';
    readonly embeddingDimensions: number;
  };
  readonly scheduling: {
    readonly enabled: boolean;
    readonly defaultTimeZone: string;
  };
  readonly push: {
    /** Meant for the browser. The private key below is not, and never leaves this process. */
    readonly publicKey: string | null;
    readonly privateKey: string | null;
    readonly subject: string;
    readonly configured: boolean;
  };
  readonly limits: {
    readonly rateLimitEnabled: boolean;
    readonly requestsPerMinute: number;
    readonly asksPerHour: number;
    readonly maxRequestBytes: number;
    readonly maxUploadBytes: number;
  };
  readonly logLevel: 'debug' | 'info' | 'warn' | 'error';
  /** Non-fatal configuration problems surfaced on the Settings screen. */
  readonly warnings: readonly string[];
}

function normaliseBaseUrl(value: string | undefined, isProduction: boolean): string {
  const fallback = 'http://localhost:3000';
  const candidate =
    value?.trim() || process.env.URL?.trim() || process.env.DEPLOY_PRIME_URL?.trim();
  if (!candidate) {
    if (isProduction) {
      throw new ConfigurationError(
        'JARVIS_BASE_URL must be set in production so OAuth redirects resolve to this deployment.',
      );
    }
    return fallback;
  }
  try {
    const url = new URL(candidate);
    if (isProduction && url.protocol !== 'https:') {
      throw new ConfigurationError('JARVIS_BASE_URL must use https in production.');
    }
    return url.origin;
  } catch (error) {
    if (error instanceof ConfigurationError) throw error;
    throw new ConfigurationError(`JARVIS_BASE_URL is not a valid absolute URL: ${candidate}`);
  }
}

export function buildConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = rawSchema.safeParse(source);
  if (!parsed.success) {
    const problems = parsed.error.issues.map(
      (issue) => `${issue.path.join('.')}: ${issue.message}`,
    );
    throw new ConfigurationError(
      `Invalid environment configuration:\n - ${problems.join('\n - ')}`,
    );
  }
  const env = parsed.data;
  const isProduction = env.NODE_ENV === 'production';
  const warnings: string[] = [];

  const baseUrl = normaliseBaseUrl(env.JARVIS_BASE_URL, isProduction);

  /* ------------------------------------------------------------ session */
  let sessionSecret = env.SESSION_SECRET ?? '';
  if (sessionSecret.length < 32) {
    if (isProduction) {
      throw new ConfigurationError(
        'SESSION_SECRET must be set to at least 32 random characters in production.',
      );
    }
    sessionSecret = 'development-only-session-secret-not-for-production-use';
    if (env.SESSION_SECRET) warnings.push('SESSION_SECRET is shorter than 32 characters.');
  }

  /* -------------------------------------------------------------- owner */
  const ownerLogin = env.OWNER_GITHUB_LOGIN?.toLowerCase() ?? null;
  const ownerUserId = env.OWNER_GITHUB_USER_ID ?? null;
  if (isProduction && !ownerLogin && !ownerUserId) {
    throw new ConfigurationError(
      'Set OWNER_GITHUB_LOGIN or OWNER_GITHUB_USER_ID. Jarvis refuses to run in production without a configured owner.',
    );
  }
  if (!ownerLogin && !ownerUserId) {
    warnings.push('No owner is configured. GitHub sign-in is disabled until one is set.');
  }

  /* ------------------------------------------------------------- oauth */
  const hasOAuth = Boolean(env.GITHUB_OAUTH_CLIENT_ID && env.GITHUB_OAUTH_CLIENT_SECRET);
  if (isProduction && !hasOAuth) {
    throw new ConfigurationError(
      'GITHUB_OAUTH_CLIENT_ID and GITHUB_OAUTH_CLIENT_SECRET are required in production.',
    );
  }
  if (!hasOAuth) warnings.push('GitHub OAuth is not configured; sign-in is unavailable.');

  /* ---------------------------------------------------------- database */
  const explicitDriver = env.JARVIS_DB_DRIVER;
  let driver: 'neon' | 'pg' | 'pglite';
  if (explicitDriver) {
    driver = explicitDriver;
  } else if (env.DATABASE_URL) {
    driver = /neon\.tech|neon\.build/i.test(env.DATABASE_URL) ? 'neon' : 'pg';
  } else {
    driver = 'pglite';
  }
  if (isProduction && driver === 'pglite') {
    throw new ConfigurationError(
      'PGlite is a local development and test database. Configure DATABASE_URL with a hosted PostgreSQL database for production.',
    );
  }
  if (driver !== 'pglite' && !env.DATABASE_URL) {
    throw new ConfigurationError(`DATABASE_URL is required for the "${driver}" database driver.`);
  }

  /* ---------------------------------------------------------------- ai */
  const aiKey =
    env.ANTHROPIC_API_KEY && env.ANTHROPIC_API_KEY.length > 0 ? env.ANTHROPIC_API_KEY : null;
  const aiEnabled = env.JARVIS_AI_ENABLED && aiKey !== null;
  if (!aiKey) {
    warnings.push('ANTHROPIC_API_KEY is not set; Jarvis uses the deterministic narrator.');
  }

  /* ------------------------------------------------------------- cron */
  const cronSecret = env.CRON_SECRET && env.CRON_SECRET.length >= 16 ? env.CRON_SECRET : null;
  if (!cronSecret) {
    warnings.push('CRON_SECRET is not set (min 16 chars); scheduled synchronisation is disabled.');
  }

  /* ------------------------------------------------------------- demo */
  let demoMode = env.JARVIS_DEMO_MODE;
  if (demoMode && isProduction && !env.JARVIS_ALLOW_DEMO_IN_PRODUCTION) {
    demoMode = false;
    warnings.push(
      'JARVIS_DEMO_MODE was ignored: demo data never activates in production unless JARVIS_ALLOW_DEMO_IN_PRODUCTION is also set.',
    );
  }

  /* --------------------------------------------------------- test auth */
  const testAuthSecret =
    !isProduction && env.JARVIS_TEST_AUTH_SECRET && env.JARVIS_TEST_AUTH_SECRET.length >= 16
      ? env.JARVIS_TEST_AUTH_SECRET
      : null;

  /* ------------------------------------------------------- qualification */
  const qualificationRepos = splitList(env.JARVIS_QUALIFICATION_REPOS).map((entry) =>
    entry.toLowerCase(),
  );
  const buildRef =
    env.JARVIS_BUILD_REF?.trim() ||
    process.env.COMMIT_REF?.trim() ||
    process.env.VERCEL_GIT_COMMIT_SHA?.trim() ||
    null;

  /*
   * A restore date that is not a date is worse than no date: it reads as evidence of a drill
   * that may never have happened. An unparseable value is dropped and warned about.
   */
  let restoreTestedAt: string | null = null;
  if (env.JARVIS_BACKUP_RESTORE_TESTED_AT) {
    const parsedDate = new Date(env.JARVIS_BACKUP_RESTORE_TESTED_AT);
    if (Number.isNaN(parsedDate.getTime())) {
      warnings.push('JARVIS_BACKUP_RESTORE_TESTED_AT is not a valid date and has been ignored.');
    } else {
      restoreTestedAt = parsedDate.toISOString();
    }
  }
  if (env.JARVIS_BACKUP_CONFIGURED && !restoreTestedAt) {
    warnings.push(
      'Backups are configured but no restore has been recorded. An untested backup is a belief, not a control.',
    );
  }

  /* ------------------------------------------------------------ knowledge */
  const knowledgeHosts = splitList(env.JARVIS_KNOWLEDGE_URL_ALLOWLIST).map((entry) =>
    entry
      .toLowerCase()
      .replace(/^https?:\/\//, '')
      .replace(/\/.*$/, ''),
  );

  /* ----------------------------------------------------------- scheduling */
  let defaultTimeZone = env.JARVIS_DEFAULT_TIME_ZONE;
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: defaultTimeZone });
  } catch {
    warnings.push(
      `JARVIS_DEFAULT_TIME_ZONE "${defaultTimeZone}" is not a zone this platform knows; using UTC.`,
    );
    defaultTimeZone = 'UTC';
  }

  /* -------------------------------------------------------------- push */
  const pushConfigured = Boolean(env.JARVIS_PUSH_PUBLIC_KEY && env.JARVIS_PUSH_PRIVATE_KEY);
  if (!pushConfigured) {
    warnings.push('Web push is not configured; notifications are delivered in-app only.');
  }

  return {
    nodeEnv: env.NODE_ENV,
    isProduction,
    baseUrl,
    sessionSecret,
    sessionTtlHours: env.SESSION_TTL_HOURS,
    owner: { githubLogin: ownerLogin, githubUserId: ownerUserId },
    githubOAuth: hasOAuth
      ? {
          clientId: env.GITHUB_OAUTH_CLIENT_ID as string,
          clientSecret: env.GITHUB_OAUTH_CLIENT_SECRET as string,
        }
      : null,
    githubReadToken: env.GITHUB_READ_TOKEN ?? null,
    githubApiBaseUrl: env.GITHUB_API_BASE_URL.replace(/\/+$/, ''),
    database: {
      driver,
      url: env.DATABASE_URL ?? null,
      /*
       * PGlite is in-memory unless given a directory. Development defaults to one so a restart
       * does not silently discard everything the owner entered; tests keep the in-memory default
       * so each run starts clean.
       */
      pgliteDataDir:
        env.PGLITE_DATA_DIR ??
        (driver === 'pglite' && env.NODE_ENV === 'development' ? '.jarvis-data/dev' : null),
    },
    ai: { enabled: aiEnabled, apiKey: aiKey, model: env.JARVIS_AI_MODEL },
    cronSecret,
    missions: {
      concurrencyLimit: env.JARVIS_MISSION_CONCURRENCY,
      allowWebResearch: env.JARVIS_ALLOW_WEB_RESEARCH,
      eventRetentionDays: env.JARVIS_MISSION_EVENT_RETENTION_DAYS,
      capacity: clampCapacityLimits({
        maxActiveMissions: env.JARVIS_MAX_ACTIVE_MISSIONS,
        maxActiveRuns: env.JARVIS_MAX_ACTIVE_AGENT_RUNS,
        maxRunsPerMission: env.JARVIS_MAX_RUNS_PER_MISSION,
        maxParallelReadOnly: env.JARVIS_MAX_PARALLEL_READONLY,
        maxParallelWriters: env.JARVIS_MAX_PARALLEL_WRITERS,
        maxRepairRounds: env.JARVIS_MAX_REPAIR_ROUNDS,
        maxTaskRuntimeMs: env.JARVIS_MAX_TASK_RUNTIME_MINUTES * 60_000,
        maxMissionRuntimeMs: env.JARVIS_MAX_MISSION_RUNTIME_MINUTES * 60_000,
        maxMissionOutputTokens: env.JARVIS_MAX_MISSION_OUTPUT_TOKENS,
        maxTaskOutputTokens: env.JARVIS_MAX_TASK_OUTPUT_TOKENS,
      }),
    },
    ci: {
      enabled: env.JARVIS_CI_ENABLED && Boolean(env.JARVIS_CI_GITHUB_TOKEN),
      credentialConfigured: Boolean(env.JARVIS_CI_GITHUB_TOKEN),
      token: env.JARVIS_CI_GITHUB_TOKEN ?? null,
      apiUrl: env.JARVIS_CI_API_URL ?? 'https://api.github.com',
      repositories: splitList(env.JARVIS_CI_REPOSITORIES),
      workflows: splitList(env.JARVIS_CI_WORKFLOWS),
      refs: splitList(env.JARVIS_CI_REFS),
      maxDispatchesPerHour: env.JARVIS_CI_MAX_DISPATCHES_PER_HOUR,
    },
    demoMode,
    testAuthSecret,
    sync: {
      commitLimit: env.JARVIS_SYNC_COMMIT_LIMIT,
      prLimit: env.JARVIS_SYNC_PR_LIMIT,
      issueLimit: env.JARVIS_SYNC_ISSUE_LIMIT,
      workflowLimit: env.JARVIS_SYNC_WORKFLOW_LIMIT,
      releaseLimit: env.JARVIS_SYNC_RELEASE_LIMIT,
      deploymentLimit: env.JARVIS_SYNC_DEPLOYMENT_LIMIT,
      historyDays: env.JARVIS_SYNC_HISTORY_DAYS,
      timeoutMs: env.JARVIS_SYNC_TIMEOUT_MS,
      lockTtlSeconds: env.JARVIS_SYNC_LOCK_TTL_SECONDS,
    },
    retention: {
      snapshotDays: env.JARVIS_RETENTION_SNAPSHOT_DAYS,
      activityDays: env.JARVIS_RETENTION_ACTIVITY_DAYS,
      usageDays: env.JARVIS_RETENTION_USAGE_DAYS,
      notificationDays: env.JARVIS_RETENTION_NOTIFICATION_DAYS,
      answerDays: env.JARVIS_RETENTION_ANSWER_DAYS,
      voiceDays: env.JARVIS_RETENTION_VOICE_DAYS,
      auditDays: env.JARVIS_RETENTION_AUDIT_DAYS,
    },
    qualification: {
      sandboxRepositories: qualificationRepos,
      buildRef,
      backupConfigured: env.JARVIS_BACKUP_CONFIGURED,
      backupTarget: env.JARVIS_BACKUP_TARGET ?? null,
      backupRestoreTestedAt: restoreTestedAt,
    },
    knowledge: {
      urlAllowList: knowledgeHosts,
      maxSources: env.JARVIS_KNOWLEDGE_MAX_SOURCES,
      embeddingProvider: env.JARVIS_KNOWLEDGE_EMBEDDINGS,
      embeddingDimensions: env.JARVIS_KNOWLEDGE_EMBEDDING_DIMENSIONS,
    },
    scheduling: {
      enabled: env.JARVIS_SCHEDULER_ENABLED,
      defaultTimeZone,
    },
    push: {
      publicKey: pushConfigured ? (env.JARVIS_PUSH_PUBLIC_KEY as string) : null,
      privateKey: pushConfigured ? (env.JARVIS_PUSH_PRIVATE_KEY as string) : null,
      subject: env.JARVIS_PUSH_SUBJECT ?? `${baseUrl}`,
      configured: pushConfigured,
    },
    limits: {
      rateLimitEnabled: env.JARVIS_RATE_LIMIT_ENABLED,
      requestsPerMinute: env.JARVIS_RATE_LIMIT_PER_MINUTE,
      asksPerHour: env.JARVIS_ASK_RATE_LIMIT_PER_HOUR,
      maxRequestBytes: env.JARVIS_MAX_REQUEST_BYTES,
      maxUploadBytes: env.JARVIS_MAX_UPLOAD_BYTES,
    },
    logLevel: env.LOG_LEVEL,
    warnings,
  };
}

let cached: AppConfig | null = null;

/** Memoised accessor. Throws a `ConfigurationError` if the environment is unusable. */
export function getConfig(): AppConfig {
  if (!cached) cached = buildConfig();
  return cached;
}

/** Test-only: forget the memoised config so a new environment can be applied. */
export function resetConfigCache(): void {
  cached = null;
}

/**
 * A redacted, browser-safe view of configuration health for the Settings screen.
 * It reports whether a credential exists — never any part of its value.
 */
export interface ConfigHealth {
  readonly ownerConfigured: boolean;
  readonly ownerLoginMasked: string | null;
  readonly oauthConfigured: boolean;
  readonly githubTokenConfigured: boolean;
  readonly databaseDriver: 'neon' | 'pg' | 'pglite';
  readonly aiConfigured: boolean;
  readonly aiModel: string;
  readonly cronConfigured: boolean;
  readonly missionConcurrency: number;
  readonly webResearchEnabled: boolean;
  readonly demoMode: boolean;
  readonly baseUrl: string;
  readonly warnings: readonly string[];
  readonly syncLimits: AppConfig['sync'];
  readonly retention: AppConfig['retention'];
}

export function describeConfigHealth(config: AppConfig = getConfig()): ConfigHealth {
  const login = config.owner.githubLogin;
  return {
    ownerConfigured: Boolean(config.owner.githubLogin || config.owner.githubUserId),
    ownerLoginMasked: login ? maskLogin(login) : null,
    oauthConfigured: config.githubOAuth !== null,
    githubTokenConfigured: config.githubReadToken !== null,
    databaseDriver: config.database.driver,
    aiConfigured: config.ai.enabled,
    aiModel: config.ai.model,
    cronConfigured: config.cronSecret !== null,
    missionConcurrency: config.missions.concurrencyLimit,
    webResearchEnabled: config.missions.allowWebResearch,
    demoMode: config.demoMode,
    baseUrl: config.baseUrl,
    warnings: config.warnings,
    syncLimits: config.sync,
    retention: config.retention,
  };
}

function maskLogin(login: string): string {
  if (login.length <= 2) return `${login.charAt(0)}*`;
  return `${login.slice(0, 2)}${'*'.repeat(Math.max(1, login.length - 3))}${login.slice(-1)}`;
}
