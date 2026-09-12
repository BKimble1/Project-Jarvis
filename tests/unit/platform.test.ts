import { afterEach, describe, expect, it, vi } from 'vitest';
import { classifyEvidence, evidenceInputSchema, evidenceMetadataSchema } from '@/domain/evidence';
import { ConfigurationError } from '@/domain/errors';
import {
  externalUrl,
  hexColor,
  isoDate,
  isoDateTime,
  projectInputSchema,
  projectUpdateSchema,
  tagSchema,
} from '@/domain/project';
import { buildConfig, describeConfigHealth } from '@/server/config/env';
import { splitStatements } from '@/server/db/migrate';
import { isOwner, type GithubIdentity } from '@/server/auth/owner';
import { generateSessionToken, hashToken, safeEqual } from '@/server/auth/session';
import { createLogger, redact, redactString } from '@/server/logging/logger';
import { testConfig } from '../helpers/test-config';

describe('project input validation', () => {
  const minimal = { name: 'Aurora', type: 'software' } as const;

  it('requires a name, trims it and bounds its length', () => {
    expect(projectInputSchema.parse({ ...minimal, name: '  Aurora  ' }).name).toBe('Aurora');

    const blank = projectInputSchema.safeParse({ ...minimal, name: '   ' });
    expect(blank.success).toBe(false);
    expect(blank.error?.issues[0]?.code).toBe('too_small');
    expect(blank.error?.issues[0]?.path).toEqual(['name']);

    expect(projectInputSchema.safeParse({ ...minimal, name: 'x'.repeat(120) }).success).toBe(true);
    expect(projectInputSchema.safeParse({ ...minimal, name: 'x'.repeat(121) }).success).toBe(false);
    expect(projectInputSchema.safeParse({ type: 'software' }).success).toBe(false);
  });

  /* A form posts empty inputs as ''. Storing '' rather than null would make "unset" untestable. */
  it('normalises empty optional text to null and trims the rest', () => {
    const parsed = projectInputSchema.parse({
      ...minimal,
      shortName: '   ',
      description: '',
      phase: '  Build  ',
      goal: '',
      icon: '',
    });
    expect(parsed.shortName).toBeNull();
    expect(parsed.description).toBeNull();
    expect(parsed.goal).toBeNull();
    expect(parsed.icon).toBeNull();
    expect(parsed.phase).toBe('Build');
  });

  it('lower-cases tags and rejects unsupported characters', () => {
    expect(projectInputSchema.parse({ ...minimal, tags: ['  Web App ', 'IOS'] }).tags).toEqual([
      'web app',
      'ios',
    ]);

    const bang = tagSchema.safeParse('has!bang');
    expect(bang.success).toBe(false);
    expect(bang.error?.issues[0]?.message).toBe(
      'Tags may contain letters, numbers, spaces, hyphens and underscores',
    );
    expect(tagSchema.safeParse('-leading-hyphen').success).toBe(false);
    expect(tagSchema.safeParse('x'.repeat(33)).success).toBe(false);
    expect(tagSchema.safeParse('').success).toBe(false);

    const tooMany = Array.from({ length: 21 }, (_, index) => `tag-${index}`);
    expect(projectInputSchema.safeParse({ ...minimal, tags: tooMany }).success).toBe(false);
  });

  /* Links are rendered as anchors, so the scheme allow-list is the only thing between a stored
     project and a stored XSS payload. */
  it('accepts http(s) URLs and rejects javascript, data and malformed URLs', () => {
    expect(externalUrl.parse(' https://example.com/a?b=c ')).toBe('https://example.com/a?b=c');
    expect(externalUrl.parse('http://localhost:3000/x')).toBe('http://localhost:3000/x');

    for (const hostile of [
      'javascript:alert(1)',
      'JavaScript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'file:///etc/passwd',
      'not a url',
      'example.com/no-scheme',
    ]) {
      const result = externalUrl.safeParse(hostile);
      expect(result.success, `${hostile} must be rejected`).toBe(false);
      expect(result.error?.issues[0]?.message).toBe('Must be an http(s) URL');
    }

    const project = projectInputSchema.safeParse({
      ...minimal,
      links: [{ label: 'Docs', url: 'javascript:alert(1)' }],
    });
    expect(project.success).toBe(false);
    expect(project.error?.issues[0]?.path).toEqual(['links', 0, 'url']);
  });

  it('validates hex colours', () => {
    expect(hexColor.parse(' #4f46e5 ')).toBe('#4f46e5');
    expect(hexColor.parse('#ABC')).toBe('#ABC');
    for (const invalid of ['#12345', '#gggggg', '4f46e5', 'red', '']) {
      const result = hexColor.safeParse(invalid);
      expect(result.success, `${invalid} must be rejected`).toBe(false);
      expect(result.error?.issues[0]?.message).toBe('Must be a hex colour such as #4f46e5');
    }
  });

  it('validates ISO dates and date-times', () => {
    expect(isoDate.parse('2025-06-15')).toBe('2025-06-15');
    for (const invalid of ['2025-6-15', '15/06/2025', '2025-02-30', '2025-06-15T00:00:00Z']) {
      expect(isoDate.safeParse(invalid).success, `${invalid} must be rejected`).toBe(false);
    }

    expect(isoDateTime.parse('2025-06-15T12:00:00Z')).toBe('2025-06-15T12:00:00Z');
    expect(isoDateTime.parse('2025-06-15T12:00:00.123+02:00')).toBe(
      '2025-06-15T12:00:00.123+02:00',
    );
    /* An instant without a zone is ambiguous, and every stored timestamp is UTC. */
    for (const invalid of ['2025-06-15T12:00:00', '2025-06-15 12:00:00', '2025-06-15']) {
      expect(isoDateTime.safeParse(invalid).success, `${invalid} must be rejected`).toBe(false);
    }

    expect(projectInputSchema.safeParse({ ...minimal, targetDate: '2025-13-01' }).success).toBe(
      false,
    );
    expect(projectInputSchema.parse({ ...minimal, targetDate: '2025-12-01' }).targetDate).toBe(
      '2025-12-01',
    );
  });

  it('applies defaults for status, priority, tags and links', () => {
    const parsed = projectInputSchema.parse(minimal);
    expect(parsed.status).toBe('active');
    expect(parsed.priority).toBe('medium');
    expect(parsed.tags).toEqual([]);
    expect(parsed.links).toEqual([]);
    expect(projectInputSchema.safeParse({ ...minimal, status: 'nonsense' }).success).toBe(false);
  });

  it('lets the update schema omit every field while still validating the ones present', () => {
    expect(projectUpdateSchema.parse({ priority: 'high' }).priority).toBe('high');
    expect(projectUpdateSchema.parse({ name: '  Renamed  ' }).name).toBe('Renamed');
    expect(projectUpdateSchema.safeParse({ name: '  ' }).success).toBe(false);
    expect(
      projectUpdateSchema.safeParse({ links: [{ label: 'x', url: 'javascript:1' }] }).success,
    ).toBe(false);
    expect(projectUpdateSchema.parse({ phase: 'Launch' }).description).toBeUndefined();
  });

  /* Documents current behaviour, which is wrong: `.partial()` does not disable the defaults, so a
     PATCH body that omits status/priority/tags/links still parses to concrete values and the
     repository writes them. Renaming a blocked project resets it to active. See the bug report. */
  it('still materialises defaults for a partial update body', () => {
    expect(projectUpdateSchema.parse({ name: 'Renamed' })).toEqual({
      name: 'Renamed',
      status: 'active',
      priority: 'medium',
      tags: [],
      links: [],
    });
  });
});

describe('evidence classification', () => {
  it('labels observed provider data as verified', () => {
    for (const kind of ['git_commit', 'pull_request', 'workflow_run', 'release'] as const) {
      expect(classifyEvidence({ kind, sourceSystem: 'github' })).toBe('verified');
    }
    expect(classifyEvidence({ kind: 'sync_run', sourceSystem: 'jarvis' })).toBe('verified');
  });

  it('labels owner-authored records as manual', () => {
    for (const kind of ['manual_update', 'goal', 'milestone', 'blocker', 'decision'] as const) {
      expect(classifyEvidence({ kind, sourceSystem: 'jarvis' })).toBe('manual');
    }
    expect(classifyEvidence({ kind: 'next_action', sourceSystem: 'jarvis' })).toBe('manual');
    /* A manual source system wins even for a kind a provider could also produce. */
    expect(classifyEvidence({ kind: 'git_commit', sourceSystem: 'manual' })).toBe('manual');
  });

  it('accepts JSON primitives and bounded arrays as evidence metadata', () => {
    const parsed = evidenceMetadataSchema.parse({
      sha: 'abc123',
      additions: 42,
      merged: true,
      mergedAt: null,
      files: ['a.ts', 'b.ts'],
    });
    expect(parsed).toEqual({
      sha: 'abc123',
      additions: 42,
      merged: true,
      mergedAt: null,
      files: ['a.ts', 'b.ts'],
    });
  });

  /* Metadata is provider-shaped, so the bounds are what stop a client object, a token-bearing
     Error or a whole API payload from being persisted. */
  it('rejects nested objects, over-long strings, long keys and oversized arrays', () => {
    expect(evidenceMetadataSchema.safeParse({ author: { login: 'octo' } }).success).toBe(false);
    expect(evidenceMetadataSchema.safeParse({ body: 'x'.repeat(4001) }).success).toBe(false);
    expect(evidenceMetadataSchema.safeParse({ body: 'x'.repeat(4000) }).success).toBe(true);
    expect(evidenceMetadataSchema.safeParse({ ['k'.repeat(65)]: 1 }).success).toBe(false);
    expect(
      evidenceMetadataSchema.safeParse({ files: Array.from({ length: 51 }, () => 'a') }).success,
    ).toBe(false);
    expect(evidenceMetadataSchema.safeParse({ files: [['nested']] }).success).toBe(false);
  });

  it('defaults evidence metadata to an empty record', () => {
    const parsed = evidenceInputSchema.parse({
      projectId: '11111111-1111-4111-8111-111111111111',
      kind: 'git_commit',
      sourceSystem: 'github',
      externalId: 'abc123',
      title: 'Fix the sync lock',
      observedAt: '2025-06-15T12:00:00Z',
    });
    expect(parsed.metadata).toEqual({});
    expect(parsed.sourceId).toBeUndefined();
  });
});

/* Every case builds its own environment object: buildConfig must never be exercised through the
   ambient process.env, or a developer's shell would decide whether the suite passes. */
const productionEnv = (overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv =>
  ({
    NODE_ENV: 'production',
    JARVIS_BASE_URL: 'https://jarvis.example.com',
    SESSION_SECRET: 'production-session-secret-0123456789abcdef',
    OWNER_GITHUB_LOGIN: 'Octo-Owner',
    GITHUB_OAUTH_CLIENT_ID: 'oauth-client-id',
    GITHUB_OAUTH_CLIENT_SECRET: 'oauth-client-secret-value',
    DATABASE_URL: 'postgresql://jarvis:db-password@db.example.com/jarvis',
    ...overrides,
  }) as NodeJS.ProcessEnv;

describe('buildConfig', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('accepts a complete production environment', () => {
    const config = buildConfig(productionEnv());
    expect(config.isProduction).toBe(true);
    expect(config.baseUrl).toBe('https://jarvis.example.com');
    expect(config.database.driver).toBe('pg');
    expect(config.owner.githubLogin).toBe('octo-owner');
    expect(config.githubOAuth?.clientId).toBe('oauth-client-id');
  });

  it('fails closed in production on each missing critical setting', () => {
    const cases: ReadonlyArray<[Record<string, string | undefined>, string]> = [
      [{ SESSION_SECRET: undefined }, 'SESSION_SECRET must be set to at least 32 random'],
      [{ SESSION_SECRET: 'too-short' }, 'SESSION_SECRET must be set to at least 32 random'],
      [
        { OWNER_GITHUB_LOGIN: undefined },
        'Jarvis refuses to run in production without a configured owner',
      ],
      [
        { GITHUB_OAUTH_CLIENT_SECRET: undefined },
        'GITHUB_OAUTH_CLIENT_ID and GITHUB_OAUTH_CLIENT_SECRET are required in production',
      ],
      [{ JARVIS_BASE_URL: undefined }, 'JARVIS_BASE_URL must be set in production'],
      [{ JARVIS_BASE_URL: 'http://jarvis.example.com' }, 'JARVIS_BASE_URL must use https'],
      [
        { DATABASE_URL: undefined, JARVIS_DB_DRIVER: 'pg' },
        'DATABASE_URL is required for the "pg" database driver',
      ],
    ];

    for (const [overrides, expected] of cases) {
      /* JARVIS_BASE_URL falls back to Netlify's URL/DEPLOY_PRIME_URL when unset. */
      vi.stubEnv('URL', '');
      vi.stubEnv('DEPLOY_PRIME_URL', '');
      const attempt = () => buildConfig(productionEnv(overrides));
      expect(attempt, expected).toThrow(ConfigurationError);
      expect(attempt).toThrow(expected);
    }
  });

  it('refuses PGlite in production, whether requested explicitly or inferred', () => {
    const message = 'PGlite is a local development and test database';
    expect(() => buildConfig(productionEnv({ JARVIS_DB_DRIVER: 'pglite' }))).toThrow(message);
    expect(() => buildConfig(productionEnv({ DATABASE_URL: undefined }))).toThrow(message);
  });

  it('ignores demo mode in production unless it is explicitly allowed', () => {
    const ignored = buildConfig(productionEnv({ JARVIS_DEMO_MODE: 'true' }));
    expect(ignored.demoMode).toBe(false);
    expect(ignored.warnings).toContain(
      'JARVIS_DEMO_MODE was ignored: demo data never activates in production unless JARVIS_ALLOW_DEMO_IN_PRODUCTION is also set.',
    );

    const allowed = buildConfig(
      productionEnv({ JARVIS_DEMO_MODE: 'yes', JARVIS_ALLOW_DEMO_IN_PRODUCTION: '1' }),
    );
    expect(allowed.demoMode).toBe(true);
    expect(allowed.warnings.some((warning) => warning.includes('JARVIS_DEMO_MODE'))).toBe(false);
  });

  /* The test-auth endpoint bypasses OAuth, so production must not be able to switch it on. */
  it('never honours the test-auth secret in production', () => {
    const secret = 'playwright-test-auth-secret';
    expect(
      buildConfig(productionEnv({ JARVIS_TEST_AUTH_SECRET: secret })).testAuthSecret,
    ).toBeNull();
    expect(
      buildConfig({
        NODE_ENV: 'test',
        JARVIS_BASE_URL: 'http://localhost:3000',
        SESSION_SECRET: 'test-session-secret-value-that-is-long-enough',
        OWNER_GITHUB_LOGIN: 'octo-owner',
        JARVIS_DB_DRIVER: 'pglite',
        JARVIS_TEST_AUTH_SECRET: secret,
      } as NodeJS.ProcessEnv).testAuthSecret,
    ).toBe(secret);
  });

  it('supplies safe development defaults and reports them as warnings', () => {
    vi.stubEnv('URL', '');
    vi.stubEnv('DEPLOY_PRIME_URL', '');
    const config = buildConfig({ NODE_ENV: 'development' } as NodeJS.ProcessEnv);

    expect(config.isProduction).toBe(false);
    expect(config.baseUrl).toBe('http://localhost:3000');
    expect(config.sessionSecret).toBe('development-only-session-secret-not-for-production-use');
    expect(config.database.driver).toBe('pglite');
    expect(config.sessionTtlHours).toBe(24 * 14);
    expect(config.sync.commitLimit).toBe(60);
    expect(config.ai.enabled).toBe(false);
    expect(config.logLevel).toBe('info');
    expect(config.warnings).toEqual([
      'No owner is configured. GitHub sign-in is disabled until one is set.',
      'GitHub OAuth is not configured; sign-in is unavailable.',
      'ANTHROPIC_API_KEY is not set; Jarvis uses the deterministic narrator.',
      'CRON_SECRET is not set (min 16 chars); scheduled synchronisation is disabled.',
      'Web push is not configured; notifications are delivered in-app only.',
    ]);
  });

  it('rejects a malformed numeric setting with the offending variable named', () => {
    expect(() => buildConfig(productionEnv({ SESSION_TTL_HOURS: 'lots' }))).toThrow(
      /SESSION_TTL_HOURS: Must be an integer between 1 and 8760/,
    );
  });
});

describe('describeConfigHealth', () => {
  const secrets = {
    SESSION_SECRET: 'production-session-secret-0123456789abcdef',
    GITHUB_OAUTH_CLIENT_SECRET: 'oauth-client-secret-value',
    GITHUB_READ_TOKEN: 'ghp_abcdefghijklmnopqrstuvwxyz012345',
    ANTHROPIC_API_KEY: 'sk-ant-api03-not-a-real-key-value',
    CRON_SECRET: 'cron-secret-value-0001',
    DATABASE_URL: 'postgresql://jarvis:db-password@db.example.com/jarvis',
    /* The VAPID private key is a credential and must not appear in the health report either. */
    JARVIS_PUSH_PUBLIC_KEY: 'BPushPublicKeyValue0123456789',
    JARVIS_PUSH_PRIVATE_KEY: 'push-private-key-value-0123456789',
  } as const;

  it('reports that credentials exist without ever exposing one', () => {
    const health = describeConfigHealth(buildConfig(productionEnv({ ...secrets })));
    const serialised = JSON.stringify(health);

    for (const value of Object.values(secrets)) {
      expect(serialised, `${value} leaked into the health report`).not.toContain(value);
    }
    expect(serialised).not.toContain('db-password');

    expect(health.oauthConfigured).toBe(true);
    expect(health.githubTokenConfigured).toBe(true);
    expect(health.aiConfigured).toBe(true);
    expect(health.cronConfigured).toBe(true);
    expect(health.databaseDriver).toBe('pg');
    expect(health.baseUrl).toBe('https://jarvis.example.com');
    expect(health.warnings).toEqual([]);
  });

  it('masks the owner login and reports when no owner is configured', () => {
    const configured = describeConfigHealth(buildConfig(productionEnv({ ...secrets })));
    expect(configured.ownerConfigured).toBe(true);
    expect(configured.ownerLoginMasked).toBe('oc*******r');
    expect(configured.ownerLoginMasked).not.toContain('owner');

    const unconfigured = describeConfigHealth(
      buildConfig({
        NODE_ENV: 'test',
        JARVIS_BASE_URL: 'http://localhost:3000',
      } as NodeJS.ProcessEnv),
    );
    expect(unconfigured.ownerConfigured).toBe(false);
    expect(unconfigured.ownerLoginMasked).toBeNull();
  });
});

describe('logger redaction', () => {
  it('redacts values whose key names read like credentials', () => {
    const redacted = redact({
      token: 'abcd',
      Authorization: 'Bearer abcd',
      set_cookie: 'jarvis_session=abcd',
      clientSecret: 'shh',
      sessionId: 'sess-1',
      projectId: 'p-1',
      nested: { apiKey: 'k', title: 'Fix the sync lock' },
    });
    expect(redacted).toEqual({
      token: '[redacted]',
      Authorization: '[redacted]',
      set_cookie: '[redacted]',
      clientSecret: '[redacted]',
      sessionId: '[redacted]',
      projectId: 'p-1',
      nested: { apiKey: '[redacted]', title: 'Fix the sync lock' },
    });
  });

  it('redacts credential shapes found in free text', () => {
    expect(redactString('cloned with ghp_abcdefghijklmnopqrstuvwxyz012345 ok')).toBe(
      'cloned with [redacted] ok',
    );
    expect(redactString('key sk-ant-api03-abcdefghijklmnop failed')).toBe('key [redacted] failed');
    expect(redactString('connect postgresql://jarvis:pw@db.example.com/jarvis refused')).toBe(
      'connect [redacted] refused',
    );
    expect(redactString('header Bearer abcdefghijklmnop')).toBe('header [redacted]');
    expect(redactString('nothing sensitive here')).toBe('nothing sensitive here');
  });

  it('handles circular references, Errors, Dates and excessive depth', () => {
    const circular: Record<string, unknown> = { name: 'sync' };
    circular.self = circular;
    expect(redact(circular)).toEqual({ name: 'sync', self: '[circular]' });

    const error = Object.assign(new Error('failed for postgres://u:pw@h/db'), { code: 'ECONN' });
    expect(redact(error)).toEqual({
      name: 'Error',
      message: 'failed for [redacted]',
      code: 'ECONN',
    });

    expect(redact(new Date('2025-06-15T12:00:00Z'))).toBe('2025-06-15T12:00:00.000Z');
    expect(redact({ a: { b: { c: { d: { e: { f: { g: { h: 'deep' } } } } } } } })).toEqual({
      a: { b: { c: { d: { e: { f: { g: '[truncated]' } } } } } },
    });
  });

  it('emits one line of valid JSON per entry, honouring the level threshold', () => {
    const lines: string[] = [];
    const log = createLogger({
      level: 'info',
      sink: (line) => lines.push(line),
      clock: () => new Date('2025-06-15T12:00:00Z'),
      bindings: { app: 'jarvis' },
    });

    log.debug('below the threshold');
    log.info('sync finished for ghp_abcdefghijklmnopqrstuvwxyz012345', {
      authorization: 'Bearer abcdefghijklmnop',
      projectId: 'p-1',
      count: 3,
    });
    log.child({ syncRunId: 'run-1' }).error('sync failed');

    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(line).not.toContain('\n');
    }

    const [first, second] = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(first).toEqual({
      ts: '2025-06-15T12:00:00.000Z',
      level: 'info',
      msg: 'sync finished for [redacted]',
      app: 'jarvis',
      authorization: '[redacted]',
      projectId: 'p-1',
      count: 3,
    });
    expect(second).toEqual({
      ts: '2025-06-15T12:00:00.000Z',
      level: 'error',
      msg: 'sync failed',
      app: 'jarvis',
      syncRunId: 'run-1',
    });
  });
});

describe('isOwner', () => {
  const identity = (overrides: Partial<GithubIdentity> = {}): GithubIdentity => ({
    login: 'test-owner',
    id: 4242,
    ...overrides,
  });

  it('allows the configured login regardless of case', () => {
    const config = testConfig({ OWNER_GITHUB_USER_ID: undefined });
    expect(isOwner(identity({ login: 'Test-Owner' }), config)).toEqual({
      allowed: true,
      reason: 'ok',
    });
    expect(isOwner(identity({ login: 'TEST-OWNER', id: 999 }), config)).toEqual({
      allowed: true,
      reason: 'ok',
    });
  });

  it('rejects a different login', () => {
    const config = testConfig({ OWNER_GITHUB_USER_ID: undefined });
    expect(isOwner(identity({ login: 'someone-else' }), config)).toEqual({
      allowed: false,
      reason: 'login_mismatch',
    });
  });

  /* Logins can be renamed and reclaimed by someone else; numeric ids cannot. */
  it('treats a configured id as authoritative', () => {
    const config = testConfig();
    expect(isOwner(identity({ id: '4242' }), config).allowed).toBe(true);
    expect(isOwner(identity({ id: 9999 }), config)).toEqual({
      allowed: false,
      reason: 'id_mismatch',
    });
    expect(isOwner(identity({ login: 'renamed-owner', id: 4242 }), config)).toEqual({
      allowed: false,
      reason: 'login_mismatch',
    });

    const idOnly = testConfig({ OWNER_GITHUB_LOGIN: undefined });
    expect(isOwner(identity({ login: 'renamed-owner' }), idOnly).allowed).toBe(true);
  });

  it('rejects everyone when no owner is configured', () => {
    const config = testConfig({
      OWNER_GITHUB_LOGIN: undefined,
      OWNER_GITHUB_USER_ID: undefined,
    });
    expect(isOwner(identity(), config)).toEqual({
      allowed: false,
      reason: 'no_owner_configured',
    });
  });

  it('rejects a missing or nameless identity', () => {
    const config = testConfig();
    expect(isOwner(null, config)).toEqual({ allowed: false, reason: 'missing_identity' });
    expect(isOwner(identity({ login: '' }), config)).toEqual({
      allowed: false,
      reason: 'missing_identity',
    });
  });
});

describe('session helpers', () => {
  it('hashes tokens stably and irreversibly', () => {
    const token = 'a-session-token';
    const hash = hashToken(token);
    expect(hash).toBe(hashToken(token));
    expect(hash).not.toBe(token);
    expect(hash).not.toContain(token);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken('a-session-tokes')).not.toBe(hash);
  });

  it('generates distinct high-entropy tokens', () => {
    const tokens = Array.from({ length: 200 }, () => generateSessionToken());
    expect(new Set(tokens).size).toBe(200);
    for (const token of tokens) {
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    }
  });

  it('compares shared secrets without leaking length or content mismatches', () => {
    expect(safeEqual('cron-secret-value', 'cron-secret-value')).toBe(true);
    expect(safeEqual('cron-secret-value', 'cron-secret-valuf')).toBe(false);
    expect(safeEqual('cron-secret-value', 'cron-secret-value-longer')).toBe(false);
    expect(safeEqual('', '')).toBe(true);
    expect(safeEqual('', 'x')).toBe(false);
  });
});

describe('splitStatements', () => {
  it('splits on the drizzle breakpoint and drops empty or comment-only fragments', () => {
    const sqlText = [
      'CREATE TABLE "projects" ("id" uuid PRIMARY KEY);',
      '--> statement-breakpoint',
      '   ',
      '--> statement-breakpoint',
      '-- a comment-only fragment',
      '-- spanning two lines',
      '--> statement-breakpoint',
      '-- explains the index',
      'CREATE INDEX "projects_name_idx" ON "projects" ("id");',
    ].join('\n');

    expect(splitStatements(sqlText)).toEqual([
      'CREATE TABLE "projects" ("id" uuid PRIMARY KEY);',
      '-- explains the index\nCREATE INDEX "projects_name_idx" ON "projects" ("id");',
    ]);
  });

  it('returns a single trimmed statement when there is no breakpoint', () => {
    expect(splitStatements('  ALTER TABLE "projects" ADD COLUMN "icon" text;  ')).toEqual([
      'ALTER TABLE "projects" ADD COLUMN "icon" text;',
    ]);
    expect(splitStatements('   ')).toEqual([]);
    expect(splitStatements('-- nothing to do')).toEqual([]);
  });
});
