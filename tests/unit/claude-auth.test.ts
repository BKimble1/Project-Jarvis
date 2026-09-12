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

/**
 * The payload a current Claude Code reports for a subscription login, sanitised.
 *
 * This is the shape that broke the worker: the same login, reporting the *account* it was made
 * against (`claude.ai`) rather than the mechanism (`oauth_token`), and Jarvis called it
 * unrecognised and stopped. The captured payload also carried an email address, an organisation id
 * and an organisation name; those are replaced with placeholders here, because a fixture that
 * carries an owner's identity into the repository is its own kind of leak — and because the
 * assertions below need to prove those fields are dropped, which only works if they are present.
 */
const CLAUDE_AI_PAYLOAD = readFileSync(
  fileURLToPath(new URL('../fixtures/claude-auth-status-claude-ai.json', import.meta.url)),
  'utf8',
);

function observation(overrides: Partial<ClaudeAuthObservation> = {}): ClaudeAuthObservation {
  return {
    loggedIn: true,
    authMethod: 'oauth_token',
    apiProvider: 'firstParty',
    subscriptionType: null,
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
      'subscriptionType',
    ]);
  });

  /*
   * The regression. A current Claude Code reports the account a login was made against rather than
   * the mechanism behind it, and the parse must carry that word through verbatim — the decision
   * about what it means belongs one layer up, where it can be read.
   */
  it('parses a claude.ai subscription login and keeps the plan name', () => {
    const parsed = parseClaudeAuthStatus(CLAUDE_AI_PAYLOAD, NOW);
    expect(parsed?.loggedIn).toBe(true);
    expect(parsed?.authMethod).toBe('claude.ai');
    expect(parsed?.apiProvider).toBe('firstParty');
    expect(parsed?.subscriptionType).toBe('max');
  });

  /*
   * The newer payload carries more than the old one did: an email address, an organisation id and
   * an organisation name. A plan name is a bare word and says nothing about who the owner is; the
   * rest identify them, and none of it is needed to answer "which kind of login is this".
   */
  it('drops the identity the newer payload carries', () => {
    const parsed = parseClaudeAuthStatus(CLAUDE_AI_PAYLOAD, NOW);
    const serialised = JSON.stringify(parsed);
    expect(serialised).not.toMatch(/@[a-z0-9.-]+\.[a-z]{2,}/i);
    expect(serialised).not.toContain('orgId');
    expect(serialised).not.toContain('00000000-0000');
    expect(serialised).not.toContain('Organization');
    expect(serialised).not.toMatch(/\/(home|Users)\//);
    expect(Object.keys(parsed ?? {}).sort()).toEqual([
      'apiProvider',
      'authMethod',
      'loggedIn',
      'observedAt',
      'source',
      'subscriptionType',
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
   * The bug, at the level where it was visible: an enrolled worker heartbeating "Claude Code
   * reports an authentication method Jarvis does not recognise ("claude.ai")" while sitting on a
   * perfectly good Max subscription. `claude.ai` is the account the login was made against, not a
   * different kind of credential.
   */
  it('accepts a claude.ai login as the subscription it is', () => {
    const verdict = resolveClaudeAuth({
      configured: 'subscription',
      apiKeyPresent: false,
      observation: observation({ authMethod: 'claude.ai', subscriptionType: 'max' }),
    });
    expect(verdict.mode).toBe('subscription');
    expect(verdict.usable).toBe(true);
    expect(verdict.bills).toBe('subscription');
    expect(verdict.remedy).toBeNull();
    /* And it names the plan, so an owner can see which subscription is paying. */
    expect(verdict.reason).toContain('max');
  });

  it('accepts a claude.ai login that reports no plan at all', () => {
    const verdict = resolveClaudeAuth({
      configured: 'subscription',
      apiKeyPresent: false,
      observation: observation({ authMethod: 'claude.ai', subscriptionType: null }),
    });
    expect(verdict.usable).toBe(true);
    expect(verdict.mode).toBe('subscription');
  });

  /* The older mechanism-shaped value still means the same thing, and must keep working. */
  it('still accepts the oauth_token form the older Claude Code reported', () => {
    const verdict = resolveClaudeAuth({
      configured: 'subscription',
      apiKeyPresent: false,
      observation: observation({ authMethod: 'oauth_token' }),
    });
    expect(verdict.mode).toBe('subscription');
    expect(verdict.usable).toBe(true);
  });

  /*
   * The trap in widening the check. `console.anthropic.com` is also an OAuth login, and reading it
   * as a subscription would put per-token invoices on exactly the worker whose owner asked not to
   * have any.
   */
  it('treats an API-console login as a key, not as a subscription', () => {
    const verdict = resolveClaudeAuth({
      configured: 'subscription',
      apiKeyPresent: false,
      observation: observation({ authMethod: 'console.anthropic.com' }),
    });
    expect(verdict.mode).toBe('api_key');
    expect(verdict.usable).toBe(false);
    expect(verdict.bills).toBe('api');
  });

  /* Widening the recognised set does not widen it to everything. */
  it('still refuses a claude.ai login when a stray key would bill the API instead', () => {
    const verdict = resolveClaudeAuth({
      configured: 'subscription',
      apiKeyPresent: true,
      observation: observation({ authMethod: 'claude.ai', subscriptionType: 'max' }),
    });
    expect(verdict.usable).toBe(false);
    expect(verdict.mode).toBe('unknown');
    expect(verdict.reason).toMatch(/would take precedence and bill/);
  });

  it('does not read a plan name as evidence of a login it cannot identify', () => {
    const verdict = resolveClaudeAuth({
      configured: 'subscription',
      apiKeyPresent: false,
      observation: observation({ authMethod: 'something_new', subscriptionType: 'max' }),
    });
    expect(verdict.usable).toBe(false);
    expect(verdict.mode).toBe('unknown');
    expect(verdict.bills).toBe('unknown');
  });

  /* The end-to-end shape: the real command's output, through the parser, into a verdict. */
  it('takes the real claude.ai payload all the way to a usable subscription verdict', () => {
    const parsed = parseClaudeAuthStatus(CLAUDE_AI_PAYLOAD, NOW);
    const verdict = resolveClaudeAuth({
      configured: 'subscription',
      apiKeyPresent: false,
      observation: parsed,
    });
    expect(verdict.usable).toBe(true);
    expect(verdict.mode).toBe('subscription');
    expect(verdict.bills).toBe('subscription');
    expect(describeClaudeAuth(verdict)).not.toMatch(/does not recognise/);
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
