import { describe, expect, it } from 'vitest';

import { authModeFromProvider, buildCapacityReport } from '@/worker/claude-telemetry';

/**
 * Reading Claude's capacity honestly.
 *
 * Every test here is about the same failure: a number that is confidently wrong. There is no
 * published "tokens left on my subscription" figure, so the only defence against inventing one is
 * that each field either came from a named interface or stayed null the whole way through. These
 * assert that it did.
 */

const NOW = new Date('2026-03-01T12:00:00.000Z');
const OPTIONS = { configuredAuthMode: 'subscription' as const, now: NOW, source: 'test' };

describe('reading Claude capacity from the SDK', () => {
  it('maps a subscription usage response into the block a heartbeat carries', () => {
    const report = buildCapacityReport(
      {
        usage: {
          subscription_type: 'max',
          rate_limits_available: true,
          rate_limits: {
            five_hour: { utilization: 42.5, resets_at: '2026-03-01T15:00:00.000Z' },
            seven_day: { utilization: 18, resets_at: '2026-03-05T00:00:00.000Z' },
            seven_day_opus: { utilization: 61, resets_at: '2026-03-05T00:00:00.000Z' },
          },
        },
        account: { apiProvider: 'firstParty', tokenSource: 'oauth' },
      },
      OPTIONS,
    );

    expect(report).not.toBeNull();
    expect(report?.authMode).toBe('subscription');
    expect(report?.subscriptionType).toBe('max');
    expect(report?.rateLimitsApplicable).toBe(true);
    expect(report?.windows.fiveHour).toEqual({
      utilisationPercent: 42.5,
      resetsAt: '2026-03-01T15:00:00.000Z',
    });
    expect(report?.windows.sevenDayOpus?.utilisationPercent).toBe(61);
    expect(report?.observedAt).toBe(NOW.toISOString());
  });

  it('treats a window it could not read as unknown rather than as zero', () => {
    const report = buildCapacityReport(
      {
        usage: {
          rate_limits_available: true,
          rate_limits: {
            five_hour: { utilization: 30, resets_at: '2026-03-01T15:00:00.000Z' },
            /* The provider reported the weekly window as unreadable, not as empty. */
            seven_day: { utilization: null, resets_at: null },
          },
        },
      },
      OPTIONS,
    );

    expect(report?.windows.fiveHour?.utilisationPercent).toBe(30);
    /*
     * Null, and specifically not `{utilisationPercent: 0}`. A weekly window reported as 0% used is
     * an invitation to spend the rest of the week's capacity in an afternoon.
     */
    expect(report?.windows.sevenDay).toBeNull();
    expect(report?.windows.sevenDayOpus).toBeNull();
  });

  it('drops a window whose reset time is readable but whose usage is not', () => {
    /*
     * Half a window is not a measurement. Keeping the readable half would put a countdown on the
     * screen beside a blank percentage, which reads as a real reading to everyone who sees it.
     */
    const report = buildCapacityReport(
      {
        usage: {
          rate_limits_available: true,
          rate_limits: { five_hour: { utilization: null, resets_at: '2026-03-01T15:00:00.000Z' } },
        },
        context: { total_tokens: 1000, raw_max_tokens: 200_000, percentage: 1 },
      },
      OPTIONS,
    );

    expect(report?.windows.fiveHour).toBeNull();
  });

  it('refuses a percentage outside 0–100 instead of clamping it', () => {
    const report = buildCapacityReport(
      {
        usage: {
          rate_limits_available: true,
          rate_limits: {
            five_hour: { utilization: 140, resets_at: null },
            seven_day: { utilization: -5, resets_at: null },
          },
        },
      },
      OPTIONS,
    );

    /*
     * Clamping would turn 140 into a confident "you are out" and -5 into a confident "spend
     * freely". Both are decisions this mapper is not entitled to make for the provider.
     */
    expect(report?.windows.fiveHour).toBeNull();
    expect(report?.windows.sevenDay).toBeNull();
  });

  it('empties the windows when the provider says plan limits do not apply', () => {
    /*
     * An API key has no five-hour window. Keeping figures that arrived alongside
     * `rate_limits_available: false` would let an API worker be throttled against a limit that
     * does not exist for it.
     */
    const report = buildCapacityReport(
      {
        usage: {
          rate_limits_available: false,
          rate_limits: { five_hour: { utilization: 99, resets_at: null } },
        },
        account: { apiProvider: 'firstParty', apiKeySource: 'environment' },
      },
      { ...OPTIONS, configuredAuthMode: 'api_key' },
    );

    expect(report?.rateLimitsApplicable).toBe(false);
    expect(report?.windows.fiveHour).toBeNull();
    expect(report?.authMode).toBe('api_key');
  });

  it('reads a rate-limit event’s reset time as epoch seconds, not milliseconds', () => {
    /*
     * The two interfaces disagree about the unit: the usage response sends an ISO string and a
     * rate-limit event sends epoch seconds. Reading one with the other's assumption puts the reset
     * fifty-five years in the past — absurd enough to spot by eye, quiet enough to ship.
     */
    const report = buildCapacityReport(
      {
        usage: { rate_limits_available: true, rate_limits: {} },
        rateLimit: {
          status: 'allowed_warning',
          rateLimitType: 'five_hour',
          utilization: 88,
          resetsAt: Math.floor(Date.parse('2026-03-01T15:00:00.000Z') / 1000),
        },
      },
      OPTIONS,
    );

    expect(report?.windows.fiveHour).toEqual({
      utilisationPercent: 88,
      resetsAt: '2026-03-01T15:00:00.000Z',
    });
  });

  it('lets a mid-session event update one window without blanking the others', () => {
    const report = buildCapacityReport(
      {
        usage: {
          rate_limits_available: true,
          rate_limits: {
            five_hour: { utilization: 40, resets_at: '2026-03-01T15:00:00.000Z' },
            seven_day: { utilization: 12, resets_at: '2026-03-05T00:00:00.000Z' },
          },
        },
        rateLimit: { rateLimitType: 'five_hour', utilization: 91, resetsAt: 1_772_370_000 },
      },
      OPTIONS,
    );

    /* The event is newer, so it wins for its own window. */
    expect(report?.windows.fiveHour?.utilisationPercent).toBe(91);
    /* And leaves the weekly figure exactly as the snapshot reported it. */
    expect(report?.windows.sevenDay?.utilisationPercent).toBe(12);
  });

  it('keeps session context apart from account capacity', () => {
    const report = buildCapacityReport(
      {
        usage: { rate_limits_available: true, rate_limits: {} },
        context: {
          total_tokens: 180_000,
          raw_max_tokens: 200_000,
          percentage: 90,
          over_limit: { tokens_over: 0 },
        },
      },
      OPTIONS,
    );

    expect(report?.context?.percentUsed).toBe(90);
    expect(report?.context?.overLimit).toBe(true);
    /*
     * The point of the separation: a session 90% through its context window says nothing about how
     * much subscription is left, and no window may borrow that number.
     */
    expect(report?.windows.fiveHour).toBeNull();
    expect(report?.windows.sevenDay).toBeNull();
  });

  it('carries nothing from the payload except capacity', () => {
    /*
     * The real payloads carry an email address, an organisation, memory-file paths and MCP tool
     * names. None of it is capacity, and a path out of somebody's home directory has no business
     * in a Jarvis database — so the mappers name their fields one at a time rather than spreading.
     */
    const report = buildCapacityReport(
      {
        usage: { rate_limits_available: true, rate_limits: {}, subscription_type: 'pro' },
        account: {
          apiProvider: 'firstParty',
          tokenSource: 'oauth',
          subscriptionType: 'pro',
          ...({ email: 'owner@example.com', organization: 'Example Ltd' } as object),
        },
        context: {
          total_tokens: 5,
          raw_max_tokens: 10,
          percentage: 50,
          ...({
            memory_files: [{ path: '/home/owner/CLAUDE.md', type: 'User', tokens: 12 }],
          } as object),
        },
      },
      OPTIONS,
    );

    const serialised = JSON.stringify(report);
    expect(serialised).not.toContain('owner@example.com');
    expect(serialised).not.toContain('Example Ltd');
    expect(serialised).not.toContain('/home/owner');
    expect(serialised).not.toContain('CLAUDE.md');
  });

  it('returns nothing at all when nothing was readable', () => {
    /*
     * The single most important return value in this file. A worker between missions has no live
     * session to ask, so it must send no capacity block — an absent block leaves the last good
     * reading in place, where a block of nulls would erase it several times a minute.
     */
    expect(buildCapacityReport({}, OPTIONS)).toBeNull();
    expect(buildCapacityReport({ usage: null, account: null }, OPTIONS)).toBeNull();
  });

  it('reports what the provider says is in force, not what the worker was configured for', () => {
    /*
     * Configuration says what the owner asked for; the provider says what is actually billing. A
     * Bedrock session has no subscription window at all, and calling it one would invent a
     * constraint out of nothing.
     */
    expect(authModeFromProvider({ apiProvider: 'bedrock' }, 'subscription')).toBe('bedrock');
    expect(authModeFromProvider({ apiProvider: 'vertex' }, 'subscription')).toBe('vertex');
    expect(authModeFromProvider({ apiProvider: 'foundry' }, 'subscription')).toBe('foundry');
    /* Anthropic-operated, but not the personal subscription this governor protects. */
    expect(authModeFromProvider({ apiProvider: 'anthropicAws' }, 'subscription')).toBe('gateway');
    expect(
      authModeFromProvider({ apiProvider: 'firstParty', apiKeySource: 'env' }, 'subscription'),
    ).toBe('api_key');
    expect(
      authModeFromProvider({ apiProvider: 'firstParty', tokenSource: 'oauth' }, 'api_key'),
    ).toBe('subscription');
    /* And when the provider says nothing, the configured mode is a better answer than a guess. */
    expect(authModeFromProvider(null, 'subscription')).toBe('subscription');
    expect(authModeFromProvider({ apiProvider: 'firstParty' }, 'api_key')).toBe('api_key');
  });
});
