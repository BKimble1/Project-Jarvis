import { describe, expect, it } from 'vitest';
import { assessFreshness, formatAge, isUntrustworthy } from '@/domain/freshness';

const NOW = new Date('2025-06-15T12:00:00.000Z');
const hoursAgo = (hours: number) => new Date(NOW.getTime() - hours * 3_600_000).toISOString();

describe('assessFreshness', () => {
  it('reports live data inside the type-specific window', () => {
    const result = assessFreshness({
      type: 'software',
      lastObservedAt: hoursAgo(2),
      lastSyncFailedAt: null,
      lastSyncError: null,
      hasSources: true,
      now: NOW,
    });
    expect(result.state).toBe('live');
    expect(result.ageHours).toBeCloseTo(2, 5);
  });

  it('applies a longer window to slow-moving project types', () => {
    const observedAt = hoursAgo(24 * 20);
    const software = assessFreshness({
      type: 'software',
      lastObservedAt: observedAt,
      lastSyncFailedAt: null,
      lastSyncError: null,
      hasSources: true,
      now: NOW,
    });
    const career = assessFreshness({
      type: 'career',
      lastObservedAt: observedAt,
      lastSyncFailedAt: null,
      lastSyncError: null,
      hasSources: false,
      now: NOW,
    });
    expect(software.state).toBe('stale');
    expect(career.state).toBe('recent');
  });

  it('marks data as failing — never as absent — when the latest sync failed', () => {
    const result = assessFreshness({
      type: 'software',
      lastObservedAt: hoursAgo(30),
      lastSyncFailedAt: hoursAgo(1),
      lastSyncError: 'GitHub rejected the credential.',
      hasSources: true,
      now: NOW,
    });
    expect(result.state).toBe('failing');
    expect(result.lastError).toBe('GitHub rejected the credential.');
    /* The last good observation is preserved so the UI can still show it. */
    expect(result.observedAt).toBe(hoursAgo(30));
    expect(result.explanation).toContain('last data that synchronised successfully');
  });

  it('does not report failing when a later sync succeeded', () => {
    const result = assessFreshness({
      type: 'software',
      lastObservedAt: hoursAgo(1),
      lastSyncFailedAt: hoursAgo(5),
      lastSyncError: 'transient',
      hasSources: true,
      now: NOW,
    });
    expect(result.state).toBe('live');
  });

  it('reports "never" when nothing has ever been observed', () => {
    const result = assessFreshness({
      type: 'research',
      lastObservedAt: null,
      lastSyncFailedAt: null,
      lastSyncError: null,
      hasSources: false,
      now: NOW,
    });
    expect(result.state).toBe('never');
    expect(result.ageHours).toBeNull();
  });

  it('treats an unparsable timestamp as no observation rather than throwing', () => {
    const result = assessFreshness({
      type: 'software',
      lastObservedAt: 'not-a-date',
      lastSyncFailedAt: null,
      lastSyncError: null,
      hasSources: true,
      now: NOW,
    });
    expect(result.state).toBe('never');
  });
});

describe('formatAge', () => {
  it.each([
    [null, 'an unknown time'],
    [0.5, 'less than an hour'],
    [1, '1 hour'],
    [5, '5 hours'],
    [72, '3 days'],
    [24 * 90, '3 months'],
  ])('formats %s as %s', (hours, expected) => {
    expect(formatAge(hours)).toBe(expected);
  });
});

describe('isUntrustworthy', () => {
  it('treats stale, failing and never as unable to support an up-to-date claim', () => {
    expect(isUntrustworthy('stale')).toBe(true);
    expect(isUntrustworthy('failing')).toBe(true);
    expect(isUntrustworthy('never')).toBe(true);
    expect(isUntrustworthy('live')).toBe(false);
    expect(isUntrustworthy('recent')).toBe(false);
  });
});
