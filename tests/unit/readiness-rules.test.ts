import { describe, expect, it } from 'vitest';

import {
  READINESS_AREAS,
  READINESS_AREA_LABELS,
  READINESS_STATES,
  READINESS_STATE_LABELS,
  isBlocked,
  summariseReadiness,
  type ReadinessCheck,
} from '@/domain/readiness';

/**
 * The four states, and the one dishonesty they exist to prevent.
 *
 * A diagnostic that reports "ANTHROPIC_API_KEY is set ✓" has told the owner something true and
 * useless, and it is why people believe a system is ready when it is not. These tests are about
 * `configured` staying separate from `verified` everywhere it could quietly merge: in the
 * summary sentence, in the blocking calculation, and in whether a next action survives.
 */

const check = (overrides: Partial<ReadinessCheck> = {}): ReadinessCheck => ({
  id: 'example',
  area: 'model',
  title: 'Something is configured',
  state: 'configured',
  detail: 'A value is present.',
  nextAction: 'Prove it by using it.',
  blocking: false,
  ...overrides,
});

const AT = '2026-03-01T09:00:00.000Z';

describe('readiness states', () => {
  it('gives every state and area a label, so nothing renders as its identifier', () => {
    for (const state of READINESS_STATES) {
      expect(READINESS_STATE_LABELS[state], state).toBeTruthy();
    }
    for (const area of READINESS_AREAS) {
      expect(READINESS_AREA_LABELS[area], area).toBeTruthy();
    }
  });

  it('never labels "configured" as though it were working', () => {
    /*
     * The label is what an owner reads. If it said "Configured ✓" the whole distinction would be
     * decorative, so this asserts the two labels are not merely different but that the weaker one
     * says what it means.
     */
    expect(READINESS_STATE_LABELS.configured).not.toBe(READINESS_STATE_LABELS.verified);
    expect(READINESS_STATE_LABELS.configured.toLowerCase()).toContain('not yet proved');
    expect(READINESS_STATE_LABELS.verified).toBe('Working');
  });
});

describe('what counts as blocked', () => {
  it('blocks on missing and failed, and on neither of the others', () => {
    expect(isBlocked(check({ blocking: true, state: 'missing' }))).toBe(true);
    expect(isBlocked(check({ blocking: true, state: 'failed' }))).toBe(true);
    /*
     * `configured` is deliberately not blocking. A key that is present and unproved is the
     * ordinary state of a deployment mid-setup: refusing to start there would make the diagnostic
     * a gate rather than a diagnostic, and the honest report is "it will probably work, nothing
     * has confirmed it".
     */
    expect(isBlocked(check({ blocking: true, state: 'configured' }))).toBe(false);
    expect(isBlocked(check({ blocking: true, state: 'verified' }))).toBe(false);
  });

  it('ignores a non-blocking check however badly it is doing', () => {
    expect(isBlocked(check({ blocking: false, state: 'failed' }))).toBe(false);
  });
});

describe('the summary sentence', () => {
  it('reports a count rather than splicing affirmative titles into a negative sentence', () => {
    /*
     * Titles are written as the thing that ought to be true — "A worker is enrolled and
     * reachable" — so "Jarvis cannot run yet: a worker is enrolled and reachable" read as the
     * opposite of what it meant. The titles are still listed by the caller, under a heading that
     * supplies the negation once.
     */
    const report = summariseReadiness(
      [
        check({ id: 'a', blocking: true, state: 'missing', title: 'A worker is enrolled' }),
        check({ id: 'b', blocking: true, state: 'failed', title: 'The database answers' }),
      ],
      AT,
    );

    expect(report.canOperate).toBe(false);
    expect(report.summary).toContain('cannot run yet');
    expect(report.summary).toContain('2 required checks');
    expect(report.summary).not.toContain('A worker is enrolled');
  });

  it('says everything required is configured without saying it works', () => {
    const report = summariseReadiness(
      [check({ id: 'a', state: 'configured' }), check({ id: 'b', state: 'verified' })],
      AT,
    );

    expect(report.canOperate).toBe(true);
    expect(report.summary).toContain('not been proved');
    expect(report.summary).not.toContain('Everything required is working');
  });

  it('reserves "everything is working" for a report with nothing unproved in it', () => {
    const report = summariseReadiness([check({ id: 'a', state: 'verified' })], AT);
    expect(report.summary).toBe('Everything required is working.');
  });

  it('counts a failing non-blocking check without claiming Jarvis cannot run', () => {
    const report = summariseReadiness(
      [check({ id: 'a', state: 'verified' }), check({ id: 'b', state: 'failed' })],
      AT,
    );
    expect(report.canOperate).toBe(true);
    expect(report.summary).toContain('1 check is failing');
  });

  it('carries the time it was taken, because a readiness report goes stale', () => {
    expect(summariseReadiness([], AT).checkedAt).toBe(AT);
  });
});
