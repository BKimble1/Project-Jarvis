import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  CLAUDE_AUTH_MODES,
  describeClaudeAuth,
  resolveClaudeAuth,
  type ClaudeAuthObservation,
} from '@/domain/claude-auth';
import {
  CLAUDE_AUTH_COMMAND,
  observeClaudeAuth,
  parseClaudeAuthStatus,
} from '@/worker/claude-auth-probe';

/**
 * Which Claude account Jarvis works through, and who pays for it.
 *
 * The failure this guards against is not a crash. It is an owner who believes they are inside a
 * subscription they have already paid for, while a stray environment variable quietly moves every
 * mission onto a per-token invoice they have not seen. Most of what follows constructs exactly
 * that situation and checks that Jarvis stops.
 */

const NOW = new Date('2026-09-05T04:00:00.000Z');

/** The real payload, captured from `claude auth status --json` on Claude Code 2.1.260. */
const REAL_PAYLOAD = readFileSync(
  fileURLToPath(new URL('../fixtures/claude-auth-status.json', import.meta.url)),
  'utf8',
);

function observation(overrides: Partial<ClaudeAuthObservation> = {}): ClaudeAuthObservation {
  return {
    loggedIn: true,
    authMethod: 'oauth_token',
    apiProvider: 'firstParty',
    observedAt: NOW.toISOString(),
    source: CLAUDE_AUTH_COMMAND,
    ...overrides,
  };
}

describe('reading what Claude Code reports', () => {
  it('parses the real payload and keeps only what it needs', () => {
    const parsed = parseClaudeAuthStatus(REAL_PAYLOAD, NOW);
    expect(parsed).not.toBeNull();
    expect(parsed?.loggedIn).toBe(true);
    expect(parsed?.authMethod).toBe('oauth_token');
    expect(parsed?.apiProvider).toBe('firstParty');
  });

  /*
   * The payload carries a filesystem path. A path is not needed to answer "which kind of login is
   * this", and carrying one would be the first step towards carrying transcripts.
   */
  it('drops the projects directory and everything else it was not asked for', () => {
    const parsed = parseClaudeAuthStatus(REAL_PAYLOAD, NOW);
    const serialised = JSON.stringify(parsed);
    expect(serialised).not.toContain('projectsDirectory');
    expect(serialised).not.toContain('/home/owner');
    expect(serialised).not.toContain('analyticsDisabled');
    expect(Object.keys(parsed ?? {}).sort()).toEqual([
      'apiProvider',
      'authMethod',
      'loggedIn',
      'observedAt',
      'source',
    ]);
  });

  it('returns null rather than guessing when the output is not what it expected', () => {
    expect(parseClaudeAuthStatus('not json at all', NOW)).toBeNull();
    expect(parseClaudeAuthStatus('null', NOW)).toBeNull();
    expect(parseClaudeAuthStatus('{"authMethod":"oauth_token"}', NOW)).toBeNull();
  });

  it('returns null when Claude Code cannot be asked at all', async () => {
    const result = await observeClaudeAuth({
      exec: async () => {
        throw new Error('spawn claude ENOENT');
      },
    });
    expect(result).toBeNull();
  });

  /*
   * The probe answers "what login is *stored*". An ANTHROPIC_API_KEY in the environment would
   * change what the command reports, and that is a different question — asked separately, from the
   * raw environment, so an owner can see both answers rather than one confusing blend.
   */
  it('asks with the worker’s own secrets stripped', async () => {
    let seen: NodeJS.ProcessEnv | null = null;
    await observeClaudeAuth({
      now: () => NOW,
      exec: async (_binary, _args, options) => {
        seen = options.env;
        return { stdout: REAL_PAYLOAD };
      },
    });
    expect(seen).not.toBeNull();
    expect(seen!.ANTHROPIC_API_KEY).toBeUndefined();
    expect(seen!.JARVIS_WORKER_GITHUB_TOKEN).toBeUndefined();
    expect(seen!.JARVIS_WORKER_TOKEN).toBeUndefined();
  });

  it('runs the supported command rather than reading a credentials file', async () => {
    let command: string | null = null;
    let args: readonly string[] = [];
    await observeClaudeAuth({
      exec: async (binary, received) => {
        command = binary;
        args = received;
        return { stdout: REAL_PAYLOAD };
      },
    });
    expect(command).toBe('claude');
    expect([...args]).toEqual(['auth', 'status', '--json']);
  });
});

describe('deciding which credential is in force', () => {
  it('accepts a subscription login as a subscription', () => {
    const verdict = resolveClaudeAuth({
      configured: 'subscription',
      apiKeyPresent: false,
      observation: observation(),
    });
    expect(verdict.mode).toBe('subscription');
    expect(verdict.usable).toBe(true);
    expect(verdict.bills).toBe('subscription');
    expect(verdict.remedy).toBeNull();
  });

  /*
   * The case this module exists for. The worker *could* run — there is a working subscription
   * login and a working key — and it is refused precisely because it would run on the key.
   */
  it('refuses to run when a stray key would silently bill the API instead', () => {
    const verdict = resolveClaudeAuth({
      configured: 'subscription',
      apiKeyPresent: true,
      observation: observation(),
    });
    expect(verdict.usable).toBe(false);
    expect(verdict.mode).toBe('unknown');
    expect(verdict.bills).toBe('unknown');
    expect(verdict.reason).toMatch(/would take precedence and bill/);
    expect(verdict.remedy).toMatch(/env -u ANTHROPIC_API_KEY/);
    /* And it never proposes doing it for them. */
    expect(verdict.remedy).toMatch(/will not unset it for you/);
  });

  it('checks the ambiguity before it checks whether anything works', () => {
    /* No login stored at all, plus a key: still reported as the billing ambiguity. */
    const verdict = resolveClaudeAuth({
      configured: 'subscription',
      apiKeyPresent: true,
      observation: null,
    });
    expect(verdict.reason).toMatch(/bill the API account/);
  });

  it('asks the owner to sign in when Claude Code is installed but nobody is', () => {
    const verdict = resolveClaudeAuth({
      configured: 'subscription',
      apiKeyPresent: false,
      observation: observation({ loggedIn: false }),
    });
    expect(verdict.usable).toBe(false);
    expect(verdict.remedy).toMatch(/claude auth login/);
    expect(verdict.remedy).toMatch(/same operating-system user/);
  });

  it('says so plainly when Claude Code could not be asked', () => {
    const verdict = resolveClaudeAuth({
      configured: 'subscription',
      apiKeyPresent: false,
      observation: null,
    });
    expect(verdict.usable).toBe(false);
    expect(verdict.mode).toBe('unknown');
    expect(verdict.reason).toMatch(/could not ask Claude Code/);
  });

  it('refuses a key-based login when the owner asked for a subscription', () => {
    const verdict = resolveClaudeAuth({
      configured: 'subscription',
      apiKeyPresent: false,
      observation: observation({ authMethod: 'api_key' }),
    });
    expect(verdict.usable).toBe(false);
    expect(verdict.mode).toBe('api_key');
    expect(verdict.bills).toBe('api');
  });

  /* An unfamiliar value is unknown, never optimistically read as a subscription. */
  it('refuses an authentication method it does not recognise', () => {
    const verdict = resolveClaudeAuth({
      configured: 'subscription',
      apiKeyPresent: false,
      observation: observation({ authMethod: 'something_new' }),
    });
    expect(verdict.usable).toBe(false);
    expect(verdict.mode).toBe('unknown');
    expect(verdict.bills).toBe('unknown');
    expect(verdict.reason).toContain('something_new');
  });

  it('accepts a key when the owner deliberately chose key billing, and says who pays', () => {
    const verdict = resolveClaudeAuth({
      configured: 'api_key',
      apiKeyPresent: true,
      observation: null,
    });
    expect(verdict.usable).toBe(true);
    expect(verdict.mode).toBe('api_key');
    expect(verdict.bills).toBe('api');
    expect(verdict.reason).toMatch(/billed to that API account/);
  });

  it('refuses key mode with no key', () => {
    const verdict = resolveClaudeAuth({
      configured: 'api_key',
      apiKeyPresent: false,
      observation: null,
    });
    expect(verdict.usable).toBe(false);
    expect(verdict.remedy).toMatch(/JARVIS_WORKER_AUTH_MODE=subscription/);
  });

  it('never reports an unusable credential as free', () => {
    for (const configured of ['subscription', 'api_key'] as const) {
      for (const apiKeyPresent of [true, false]) {
        for (const obs of [null, observation({ loggedIn: false }), observation()]) {
          const verdict = resolveClaudeAuth({ configured, apiKeyPresent, observation: obs });
          expect(CLAUDE_AUTH_MODES).toContain(verdict.mode);
          if (!verdict.usable) expect(verdict.remedy).not.toBeNull();
          if (verdict.mode === 'unknown') expect(verdict.bills).toBe('unknown');
        }
      }
    }
  });

  it('describes itself in one sentence that carries the remedy when there is one', () => {
    const blocked = resolveClaudeAuth({
      configured: 'subscription',
      apiKeyPresent: true,
      observation: observation(),
    });
    expect(describeClaudeAuth(blocked)).toContain('env -u ANTHROPIC_API_KEY');

    const fine = resolveClaudeAuth({
      configured: 'subscription',
      apiKeyPresent: false,
      observation: observation(),
    });
    expect(describeClaudeAuth(fine)).toMatch(/Claude subscription/);
  });
});
