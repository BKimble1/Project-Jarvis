import { z } from 'zod';
import { ConfigurationError } from '@/domain/errors';

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
  readonly retention: { readonly snapshotDays: number; readonly activityDays: number };
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
      pgliteDataDir: env.PGLITE_DATA_DIR ?? null,
    },
    ai: { enabled: aiEnabled, apiKey: aiKey, model: env.JARVIS_AI_MODEL },
    cronSecret,
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
