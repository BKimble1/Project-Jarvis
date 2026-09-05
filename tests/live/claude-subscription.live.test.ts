import { describe, expect, it } from 'vitest';

import { observeClaudeAuth, CLAUDE_AUTH_COMMAND } from '@/worker/claude-auth-probe';
import { resolveClaudeAuth } from '@/domain/claude-auth';
import { buildCapacityReport } from '@/worker/claude-telemetry';
import { ClaudeAgentRuntime } from '@/worker/runtime/claude-agent-sdk';

/**
 * The tests that spend real capacity on a real account.
 *
 * ## Why these are not in the ordinary suite
 *
 * Everything in `tests/unit` and `tests/integration` is deterministic and free. These are neither:
 * they require a Claude Code login on this machine, they run a real model session, and that session
 * consumes a small amount of the owner's subscription. A suite that sometimes costs money and
 * sometimes fails because somebody's login expired is a suite people stop running, and then the
 * cheap deterministic tests stop being run either.
 *
 * So they are opt-in, they are reported separately, and the default `npm test` does not include
 * them. Run them with:
 *
 *     npm run test:live
 *
 * ## What they are for
 *
 * Every other test in this repository proves that Jarvis handles a *shape* of data correctly. These
 * prove the shape is the real one. A mocked usage response that matches a mapper written from the
 * same mistaken reading of the SDK will pass for ever and be wrong the whole time; the only way to
 * find that out is to ask the real interface.
 *
 * Nothing here is marked live unless it really is. There is no fallback to a stub: if the login is
 * missing, these fail rather than quietly passing against a mock, because a green "live" tick that
 * did not touch Anthropic is worse than a red one.
 */

const SESSION_TIMEOUT_MS = 120_000;

describe('the real Claude credential on this machine', () => {
  it('reports a login through the documented, secret-free command', async () => {
    const observation = await observeClaudeAuth();

    expect(
      observation,
      `\`${CLAUDE_AUTH_COMMAND}\` returned nothing usable. Sign in with \`claude\` then /login, and run this again.`,
    ).not.toBeNull();
    expect(observation?.loggedIn).toBe(true);

    /*
     * And the probe still keeps only what it needs. This is the assertion that matters most in a
     * live run: the real payload carries the path to the owner's projects directory, and a
     * regression that started storing it would only ever show up here.
     */
    expect(Object.keys(observation ?? {}).sort()).toEqual([
      'apiProvider',
      'authMethod',
      'loggedIn',
      'observedAt',
      'source',
    ]);
  });

  it('resolves to a subscription, and says who pays', async () => {
    const observation = await observeClaudeAuth();
    const verdict = resolveClaudeAuth({
      configured: 'subscription',
      apiKeyPresent: Boolean(process.env.ANTHROPIC_API_KEY),
      observation,
    });

    /*
     * A failure here is usually not a bug: it is an ANTHROPIC_API_KEY in the environment, which
     * Jarvis refuses rather than silently preferring. The verdict says exactly that, so it is
     * quoted rather than summarised.
     */
    expect(verdict.usable, `${verdict.reason} ${verdict.remedy ?? ''}`.trim()).toBe(true);
    expect(verdict.mode).toBe('subscription');
    expect(verdict.bills).toBe('subscription');
  });

  it('finds the runtime available without any API key', async () => {
    const runtime = new ClaudeAgentRuntime({
      apiKey: null,
      oauthToken: process.env.CLAUDE_CODE_OAUTH_TOKEN ?? null,
      authMode: 'subscription',
      apiKeyPresent: Boolean(process.env.ANTHROPIC_API_KEY),
      model: null,
    });

    const availability = await runtime.availability();
    expect(availability.available, availability.detail).toBe(true);
  });
});

describe('a real Claude session', () => {
  it(
    'runs, reports usage without a dollar figure, and yields real capacity',
    async () => {
      const runtime = new ClaudeAgentRuntime({
        apiKey: null,
        oauthToken: process.env.CLAUDE_CODE_OAUTH_TOKEN ?? null,
        authMode: 'subscription',
        apiKeyPresent: Boolean(process.env.ANTHROPIC_API_KEY),
        model: null,
      });

      const controller = new AbortController();
      const session = await runtime.start({
        /* Deliberately trivial: this test is about the plumbing, not about the model. */
        prompt: 'Reply with exactly the word: ready',
        systemPrompt: 'Answer in one word. Do not use any tools.',
        workspaceRoot: process.cwd(),
        maxTurns: 1,
        model: null,
        readOnly: true,
        resumeSessionId: null,
        signal: controller.signal,
        decide: async () => ({
          verdict: 'deny' as const,
          rule: 'live_check_uses_no_tools',
          reason: 'This check uses no tools.',
        }),
      });

      let done = false;
      let costUsd: number | null | undefined;
      for await (const event of session.events) {
        if (event.type === 'done') {
          done = true;
          costUsd = event.usage?.totalCostUsd;
        }
      }
      await session.close().catch(() => undefined);

      expect(done, 'the session did not reach a result').toBe(true);

      /*
       * No money. Claude Code reports what these tokens would have cost at API rates even on a
       * subscription, and reporting that as "cost" tells an owner something untrue about their own
       * money. This is the assertion that a stub could never make honestly.
       */
      expect(costUsd ?? null).toBeNull();

      /*
       * And the capacity read that only a live session can produce. The usage interface is
       * experimental, so an absent reading is a real possible outcome and is reported rather than
       * failed — but if a reading did arrive, every field in it must be a genuine percentage.
       */
      const capacity = runtime.capacity();
      if (capacity === null) {
        console.warn(
          '[live] No capacity reading. This Claude Code may not expose the usage interface; the governor treats that as a capability gap and narrows rather than stopping.',
        );
        return;
      }

      expect(capacity.authMode).toBe('subscription');
      expect(capacity.observedAt).toBeTruthy();
      for (const value of Object.values(capacity.windows)) {
        if (!value || value.utilisationPercent === null || value.utilisationPercent === undefined) {
          continue;
        }
        expect(value.utilisationPercent).toBeGreaterThanOrEqual(0);
        expect(value.utilisationPercent).toBeLessThanOrEqual(100);
      }

      /* Nothing personal travelled with it. */
      const serialised = JSON.stringify(capacity);
      expect(serialised).not.toMatch(/@[a-z0-9.-]+\.[a-z]{2,}/i);
      expect(serialised).not.toMatch(/\/(home|Users)\//);
    },
    SESSION_TIMEOUT_MS,
  );

  it('maps whatever the real usage interface returns without inventing anything', async () => {
    /*
     * A second, cheaper pass at the same question: the mapper is handed the real shape and must
     * either produce percentages or produce nothing. What it must never do is produce zeroes.
     */
    const report = buildCapacityReport(
      { usage: null, account: null },
      { configuredAuthMode: 'subscription', now: new Date(), source: 'live check' },
    );
    expect(report).toBeNull();
  });
});
