import { describe, expect, it } from 'vitest';

import { briefingWindow, greetingFor, quietLine } from '@/domain/briefing-shape';

/**
 * The window a briefing covers, and how it reads when nothing happened.
 *
 * Small rules with disproportionate consequences. A first briefing that recited three weeks would
 * not be read; a briefing after a fortnight away that recited a fortnight would not be read either;
 * and an empty overnight section reads identically as "quiet night" and "the briefing is broken".
 */

const NOW = new Date('2026-04-01T08:00:00.000Z');

describe('the window a briefing covers', () => {
  it('starts twelve hours back the first time, not at the beginning of time', () => {
    const window = briefingWindow({ now: NOW, lastBriefingAt: null });
    expect(window.firstEver).toBe(true);
    expect(NOW.getTime() - window.since.getTime()).toBe(12 * 3_600_000);
  });

  it('covers the gap since the last one, so a skipped morning is not lost', () => {
    const last = new Date(NOW.getTime() - 30 * 3_600_000).toISOString();
    const window = briefingWindow({ now: NOW, lastBriefingAt: last });
    expect(window.firstEver).toBe(false);
    expect(window.since.toISOString()).toBe(last);
  });

  it('will not recite a fortnight to somebody who came back from holiday', () => {
    const last = new Date(NOW.getTime() - 14 * 24 * 3_600_000).toISOString();
    const window = briefingWindow({ now: NOW, lastBriefingAt: last, maxHours: 72 });
    expect(NOW.getTime() - window.since.getTime()).toBe(72 * 3_600_000);
  });

  it('treats an unreadable timestamp as no timestamp rather than throwing', () => {
    const window = briefingWindow({ now: NOW, lastBriefingAt: 'not a date' });
    expect(window.firstEver).toBe(true);
  });
});

describe('reading the time and the silence', () => {
  it('greets by the hour', () => {
    expect(greetingFor(2)).toBe('Late');
    expect(greetingFor(8)).toBe('Morning');
    expect(greetingFor(14)).toBe('Afternoon');
    expect(greetingFor(21)).toBe('Evening');
  });

  it('names the window when nothing happened, so silence is not ambiguous', () => {
    const since = new Date(NOW.getTime() - 12 * 3_600_000);
    expect(quietLine(since, NOW)).toBe('Nothing finished in the last 12 hours.');
    expect(quietLine(new Date(NOW.getTime() - 3_600_000), NOW)).toBe(
      'Nothing finished in the last 1 hour.',
    );
  });
});
