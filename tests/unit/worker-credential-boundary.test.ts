import { describe, expect, it } from 'vitest';

import { WORKER_ONLY_SECRETS, withoutWorkerSecrets } from '@/worker/child-env';
import { ClaudeAgentRuntime } from '@/worker/runtime/claude-agent-sdk';

/**
 * What the model can read out of its own environment.
 *
 * The delivery client has four methods and the push guard inspects argv before git starts — but
 * both of those controls assume the agent does not hold the raw GitHub token. It has Bash, and
 * nothing in the tool policy blocks `env` or `printenv`, so until this boundary existed the token
 * was one shell command away and every control built on top of it was decoration.
 *
 * These tests walk the environment that is actually handed to the SDK, rather than asserting that
 * a comment says the right thing.
 */

const REAL_LOOKING = {
  githubPat: 'github_pat_11ABCDEFG0aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789abcdef',
  classic: 'ghp_0123456789abcdefghijklmnopqrstuvwxyz',
  anthropic: 'sk-ant-api03-0123456789abcdefghijklmnop',
  worker: 'jarvisw_0123456789abcdef.0123456789abcdefghij',
  oauth: 'sk-ant-oat01-0123456789abcdefghijklmnop',
};

/**
 * Start a session against a stub SDK and return the environment the runtime actually built.
 *
 * The environment is the whole subject of these tests, so the stub yields nothing and exists only
 * to capture `options.env`.
 */
async function environmentHandedToTheAgent(
  credentials: Pick<
    ConstructorParameters<typeof ClaudeAgentRuntime>[0],
    'apiKey' | 'oauthToken' | 'authMode' | 'apiKeyPresent'
  >,
): Promise<Record<string, string | undefined>> {
  let captured: Record<string, string | undefined> | null = null;

  const runtime = new ClaudeAgentRuntime({
    ...credentials,
    model: 'claude-opus-5',
    /* The subscription branch probes for a login; answer it here rather than spawning Claude. */
    observeAuth: async () => ({
      loggedIn: true,
      authMethod: 'oauth_token',
      apiProvider: 'firstParty',
      observedAt: new Date('2026-01-01T00:00:00.000Z').toISOString(),
      source: 'claude auth status --json',
    }),
    load: async () => ({
      query: (params: { options?: { env?: Record<string, string | undefined> } }) => {
        captured = params.options?.env ?? {};
        return {
          async *[Symbol.asyncIterator]() {
            /* Nothing to yield: the environment is the whole subject of this test. */
          },
          interrupt: async () => undefined,
        };
      },
    }),
  });

  const session = await runtime.start({
    prompt: 'anything',
    systemPrompt: 'anything',
    workspaceRoot: '/tmp',
    maxTurns: 1,
    model: null,
    readOnly: true,
    resumeSessionId: null,
    signal: new AbortController().signal,
    decide: async () => ({ verdict: 'allow' as const, reason: 'allowed' }),
  });
  await session.close().catch(() => undefined);

  expect(captured, 'the runtime must have started a session').not.toBeNull();
  return captured as unknown as Record<string, string | undefined>;
}

describe('the environment a worker hands to a child process', () => {
  it('removes every credential Jarvis defines, by name', () => {
    const source = Object.fromEntries(
      WORKER_ONLY_SECRETS.map((name) => [name, 'a-value-that-should-not-travel']),
    ) as NodeJS.ProcessEnv;
    source.PATH = '/usr/bin';

    const filtered = withoutWorkerSecrets(source);

    for (const name of WORKER_ONLY_SECRETS) {
      expect(filtered[name], `${name} must not reach a child process`).toBeUndefined();
    }
    /* And it is a filter, not a wipe: the child still needs to be able to run anything. */
    expect(filtered.PATH).toBe('/usr/bin');
  });

  it('removes a credential the owner named something Jarvis could not know', () => {
    /*
     * The realistic case. An owner's shell carries MY_GH_PAT or DEPLOY_TOKEN, the worker inherits
     * it, and a name list would never have caught it — so the value's shape is checked too.
     */
    const filtered = withoutWorkerSecrets({
      MY_GH_PAT: REAL_LOOKING.githubPat,
      OLD_TOKEN: REAL_LOOKING.classic,
      SOME_MODEL_KEY: REAL_LOOKING.anthropic,
      A_WORKER_SECRET: REAL_LOOKING.worker,
      HOME: '/home/jarvis',
      LANG: 'en_GB.UTF-8',
    } as unknown as NodeJS.ProcessEnv);

    expect(filtered.MY_GH_PAT).toBeUndefined();
    expect(filtered.OLD_TOKEN).toBeUndefined();
    expect(filtered.SOME_MODEL_KEY).toBeUndefined();
    expect(filtered.A_WORKER_SECRET).toBeUndefined();
    expect(filtered.HOME).toBe('/home/jarvis');
    expect(filtered.LANG).toBe('en_GB.UTF-8');
  });

  it('hands the agent session no credential except the model key', async () => {
    /*
     * The property that matters, asserted against the real runtime rather than against the filter
     * in isolation: this drives `ClaudeAgentRuntime.start` with a stub SDK and reads the options
     * it was actually given.
     */
    const previous = { ...process.env };
    process.env.JARVIS_WORKER_GITHUB_TOKEN = REAL_LOOKING.githubPat;
    process.env.JARVIS_WORKER_TOKEN = REAL_LOOKING.worker;
    process.env.SOMEONES_OWN_TOKEN = REAL_LOOKING.classic;

    let captured: Record<string, string | undefined> | null = null;

    const runtime = new ClaudeAgentRuntime({
      apiKey: REAL_LOOKING.anthropic,
      oauthToken: null,
      authMode: 'api_key',
      apiKeyPresent: true,
      model: 'claude-opus-5',
      load: async () => ({
        query: (params: { options?: { env?: Record<string, string | undefined> } }) => {
          captured = params.options?.env ?? {};
          return {
            async *[Symbol.asyncIterator]() {
              /* Nothing to yield: the environment is the whole subject of this test. */
            },
            interrupt: async () => undefined,
          };
        },
      }),
    });

    try {
      const session = await runtime.start({
        prompt: 'anything',
        systemPrompt: 'anything',
        workspaceRoot: '/tmp',
        maxTurns: 1,
        model: null,
        readOnly: true,
        resumeSessionId: null,
        signal: new AbortController().signal,
        decide: async () => ({ verdict: 'allow' as const, reason: 'allowed' }),
      });
      await session.close().catch(() => undefined);
    } finally {
      for (const key of ['JARVIS_WORKER_GITHUB_TOKEN', 'JARVIS_WORKER_TOKEN', 'SOMEONES_OWN_TOKEN'])
        delete process.env[key];
      Object.assign(process.env, previous);
    }

    expect(captured, 'the runtime must have started a session').not.toBeNull();
    const env = captured as unknown as Record<string, string | undefined>;

    /* The delivery credential, by name. */
    expect(env.JARVIS_WORKER_GITHUB_TOKEN).toBeUndefined();
    /* The control-plane credential: an agent holding it could post fabricated results. */
    expect(env.JARVIS_WORKER_TOKEN).toBeUndefined();
    /* And one the owner named themselves, caught by shape. */
    expect(env.SOMEONES_OWN_TOKEN).toBeUndefined();

    /* Exactly one credential survives, and it is the one the agent cannot work without. */
    expect(env.ANTHROPIC_API_KEY).toBe(REAL_LOOKING.anthropic);

    const remaining = Object.entries(env)
      .filter(([key, value]) => key !== 'ANTHROPIC_API_KEY' && typeof value === 'string')
      .filter(([, value]) => /gh[pousr]_|github_pat_|sk-ant-|jarvisw_/.test(String(value)));
    expect(remaining, 'no other credential-shaped value may reach the agent').toEqual([]);
  });

  it('passes a configured subscription token, and no key alongside it', async () => {
    /*
     * The headless subscription case. There is no interactive login to read on this machine, so
     * the owner supplied a token — it has to arrive, or the session authenticates as nobody.
     */
    const env = await environmentHandedToTheAgent({
      apiKey: null,
      oauthToken: REAL_LOOKING.oauth,
      authMode: 'subscription',
      apiKeyPresent: false,
    });

    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe(REAL_LOOKING.oauth);
    /*
     * And not both. A key in the environment silently outranks a subscription login, so a session
     * carrying both would bill per token while the owner believed they were inside a subscription
     * they had already paid for.
     */
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it('does not leak an inherited subscription token into an api_key session', async () => {
    /*
     * The regression this test exists for: `CLAUDE_CODE_OAUTH_TOKEN` holds an `sk-ant-oat01-…`
     * value, so before it was named in WORKER_ONLY_SECRETS the shape filter deleted it silently —
     * and a worker started with a good token failed to authenticate with nothing said about why.
     * Naming it makes the removal deliberate, and this asserts the re-add is deliberate too:
     * inheriting it is never enough, the configured mode has to ask for it.
     */
    const previous = { ...process.env };
    process.env.CLAUDE_CODE_OAUTH_TOKEN = REAL_LOOKING.oauth;

    try {
      const env = await environmentHandedToTheAgent({
        apiKey: REAL_LOOKING.anthropic,
        oauthToken: null,
        authMode: 'api_key',
        apiKeyPresent: true,
      });

      expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
      expect(env.ANTHROPIC_API_KEY).toBe(REAL_LOOKING.anthropic);
    } finally {
      delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
      Object.assign(process.env, previous);
    }
  });

  it('names the subscription token, so the filter cannot be relied on to guess it', () => {
    /*
     * Shape would catch today's `sk-ant-oat01-…` prefix. A credential format is not a promise, and
     * the boundary should not depend on one: the name list is what makes this deterministic.
     */
    expect(WORKER_ONLY_SECRETS).toContain('CLAUDE_CODE_OAUTH_TOKEN');
  });
});
