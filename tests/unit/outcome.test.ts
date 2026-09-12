import { describe, expect, it } from 'vitest';

import {
  assertBenefitPermitted,
  deriveVerdict,
  MAX_SELF_STARTED_CONCURRENT,
  OBSERVATION_DELAY_MS,
  revenueClaimable,
  summariseOutcomes,
} from '@/domain/outcome';

/**
 * Whether the work Jarvis chose for itself helped, and the ways that question goes wrong.
 *
 * The failure mode this guards against is not modesty. It is a run of unverifiable successes: a
 * system that reports "this improved things" repeatedly, in language nobody can check, converting
 * uncertainty into confidence while spending real money. So the tests are almost all about the
 * verdicts it refuses to reach.
 */

const NOW = new Date('2026-04-10T12:00:00.000Z');
const hypothesis = {
  benefitKind: 'reliability' as const,
  successSignal: 'Whether the build still fails',
};

describe('reading the result', () => {
  it('says too early before a day has passed, however good the signal looks', () => {
    const decision = deriveVerdict({
      hypothesis,
      finishedAt: new Date(NOW.getTime() - OBSERVATION_DELAY_MS + 60_000).toISOString(),
      now: NOW,
      before: 'failing',
      after: 'passing',
      improved: true,
      financialSourceConnected: false,
    });
    expect(decision.verdict).toBe('too_early');
  });

  it('says supported only when something was captured on both sides and moved', () => {
    const decision = deriveVerdict({
      hypothesis,
      finishedAt: new Date(NOW.getTime() - 2 * OBSERVATION_DELAY_MS).toISOString(),
      now: NOW,
      before: 'still raised',
      after: 'no longer raised',
      improved: true,
      financialSourceConnected: false,
    });
    expect(decision.verdict).toBe('supported');
    expect(decision.note).toContain('still raised → no longer raised');
  });

  it('cannot conclude anything without a before', () => {
    const decision = deriveVerdict({
      hypothesis,
      finishedAt: new Date(NOW.getTime() - 2 * OBSERVATION_DELAY_MS).toISOString(),
      now: NOW,
      before: null,
      after: 'no longer raised',
      improved: true,
      financialSourceConnected: false,
    });
    expect(decision.verdict).toBe('inconclusive');
  });

  it('says it did not help rather than staying quiet about it', () => {
    const decision = deriveVerdict({
      hypothesis,
      finishedAt: new Date(NOW.getTime() - 2 * OBSERVATION_DELAY_MS).toISOString(),
      now: NOW,
      before: 'still raised',
      after: 'still raised',
      improved: false,
      financialSourceConnected: false,
    });
    expect(decision.verdict).toBe('not_supported');
  });

  it('will not claim revenue without a financial source, whatever the signal did', () => {
    const decision = deriveVerdict({
      hypothesis: { benefitKind: 'revenue', successSignal: 'Monthly recurring revenue' },
      finishedAt: new Date(NOW.getTime() - 30 * OBSERVATION_DELAY_MS).toISOString(),
      now: NOW,
      before: '£1,000',
      after: '£4,000',
      improved: true,
      financialSourceConnected: false,
    });
    expect(decision.verdict).toBe('inconclusive');
    expect(decision.note).toContain('will not guess');
    expect(revenueClaimable({ financialSourceConnected: false })).toBe(false);
  });

  it('is too early while the work is still running', () => {
    expect(
      deriveVerdict({
        hypothesis,
        finishedAt: null,
        now: NOW,
        before: 'still raised',
        after: 'still raised',
        improved: false,
        financialSourceConnected: false,
      }).verdict,
    ).toBe('too_early');
  });
});

describe('what Jarvis will not plan to do', () => {
  const forbidden = [
    'Buy a bigger plan so the builds stop queueing',
    'Pay the outstanding invoice so the account is not suspended',
    'Sign the renewal so the tool keeps working',
    'Email the client to unblock the release',
    'Publish a post announcing the new feature',
  ];

  it('refuses at the point the goal is written down', () => {
    for (const expectedBenefit of forbidden) {
      expect(() => assertBenefitPermitted({ expectedBenefit }), expectedBenefit).toThrow(
        /will not plan work whose point is/i,
      );
    }
  });

  it('allows ordinary engineering goals', () => {
    for (const expectedBenefit of [
      'Stop this recurring: the nightly build fails.',
      'Reduce the chance of: a dependency with a known vulnerability.',
      'Make this legible: the deployment runbook is out of date.',
    ]) {
      expect(() => assertBenefitPermitted({ expectedBenefit })).not.toThrow();
    }
  });
});

describe('reporting the record', () => {
  it('counts rather than computing a rate', () => {
    const summary = summariseOutcomes([
      'supported',
      'supported',
      'not_supported',
      'too_early',
      'inconclusive',
    ]);
    expect(summary).toContain('2 helped');
    expect(summary).toContain('1 did not');
    expect(summary).not.toMatch(/%/);
  });

  it('says nothing has been started rather than reporting a perfect record of nothing', () => {
    expect(summariseOutcomes([])).toBe('Jarvis has not started anything on its own yet.');
  });
});

describe('how much Jarvis may take on for itself', () => {
  it('is a small number, and smaller than any general concurrency limit', () => {
    /*
     * The general ceiling protects the machine; this protects the owner from opening Jarvis to
     * find every slot taken by work it chose, with the thing they asked for queued behind it.
     */
    expect(MAX_SELF_STARTED_CONCURRENT).toBeLessThanOrEqual(3);
    expect(MAX_SELF_STARTED_CONCURRENT).toBeGreaterThan(0);
  });
});
