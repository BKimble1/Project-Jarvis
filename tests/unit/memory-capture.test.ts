import { describe, expect, it } from 'vitest';

import { interpretCapture } from '@/domain/memory-capture';
import {
  defaultSensitivity,
  isCitableAuthority,
  isOwnerOnlyCategory,
  resolveInitialStatus,
} from '@/domain/knowledge';

/**
 * What Jarvis will and will not write down.
 *
 * The failure modes here are asymmetric, and the tests are written around that. Failing to record
 * something costs a person one repetition. Recording something they never asked to be kept — a
 * medical detail mentioned in passing, a card number read aloud — is a breach of the arrangement,
 * and it surfaces months later inside an answer as though they had asked for it.
 */

const NOW = new Date('2026-04-01T09:00:00.000Z');
const owner = { now: NOW, fromOwner: true } as const;

describe('deciding whether to remember', () => {
  it('honours an explicit instruction', () => {
    const verdict = interpretCapture('Remember that we decided to use Postgres', owner);
    expect(verdict).toMatchObject({ kind: 'remember', explicit: true, category: 'decision' });
  });

  it('offers to keep something the owner said about how they work', () => {
    const verdict = interpretCapture('I always squash my commits before merging', owner);
    expect(verdict).toMatchObject({ kind: 'remember', explicit: false, category: 'preference' });
  });

  it('recognises a routine', () => {
    expect(interpretCapture('I do the accounts every month', owner)).toMatchObject({
      kind: 'remember',
      category: 'routine',
    });
  });

  it('leaves ordinary conversation alone', () => {
    for (const text of ['how is CoreCredit doing', 'that build looks slow', 'thanks, that helps']) {
      expect(interpretCapture(text, owner).kind, text).toBe('none');
    }
  });

  it('does not take a preference from something Jarvis merely read', () => {
    /* "I prefer tabs" in a document is somebody quoted, not the owner speaking. */
    expect(
      interpretCapture('I always squash my commits', { now: NOW, fromOwner: false }).kind,
    ).toBe('none');
  });
});

describe('sensitive material', () => {
  const sensitive = [
    'my password is hunter2',
    'the api key is sk-abcdefghijklmnop',
    'my card number is 4111 1111 1111 1111',
    'my sort code is on the fridge',
    'I was prescribed something for anxiety last year',
    'her salary is £95,000',
    'my passport expires next year',
  ];

  it('is never filed just because it was mentioned', () => {
    for (const text of sensitive) {
      const verdict = interpretCapture(text, owner);
      expect(verdict.kind, text).toBe('refused');
      if (verdict.kind === 'refused') expect(verdict.rule).toBe('MC-SENSITIVE');
    }
  });

  it('is kept when asked for, and kept private', () => {
    const verdict = interpretCapture('Remember that my sort code is on the fridge', owner);
    expect(verdict).toMatchObject({
      kind: 'remember',
      explicit: true,
      sensitivity: 'private',
      rule: 'MC-SENSITIVE-EXPLICIT',
    });
  });

  it('refuses before it decides whether the sentence was interesting', () => {
    /*
     * The order matters. If "is this worth remembering?" were asked first, a sensitive sentence
     * that happened not to look like a preference would return `none` — which reads as "nothing
     * happened" rather than as "Jarvis declined", and the person would never learn the rule.
     */
    const verdict = interpretCapture('the pin code is 4821', owner);
    expect(verdict.kind).toBe('refused');
  });
});

describe('deductions stay deductions', () => {
  it('marks a hedged statement as uncertain', () => {
    const verdict = interpretCapture('Remember that I probably prefer short PRs', owner);
    expect(verdict).toMatchObject({ kind: 'remember', uncertain: true });
    /* And the hedge is still in the sentence, so an answer using it has to repeat it. */
    if (verdict.kind === 'remember') expect(verdict.statement).toContain('probably');
  });

  it('does not mark a plain statement as uncertain', () => {
    const verdict = interpretCapture('Remember that I prefer short PRs', owner);
    expect(verdict).toMatchObject({ uncertain: false });
  });

  it('never activates a category the owner alone may state', () => {
    for (const category of [
      'preference',
      'decision',
      'goal',
      'routine',
      'task',
      'person',
    ] as const) {
      expect(isOwnerOnlyCategory(category), category).toBe(true);
      expect(resolveInitialStatus({ origin: 'inferred', category }).status).toBe('suggested');
      expect(defaultSensitivity(category)).toBe('private');
    }
  });
});

describe('when something starts and stops being true', () => {
  it('reads a start date out of the sentence', () => {
    const verdict = interpretCapture('Remember that from June I work Tuesdays', owner);
    expect(verdict).toMatchObject({ kind: 'remember' });
    if (verdict.kind === 'remember') {
      expect(verdict.effectiveFrom?.slice(0, 7)).toBe('2026-06');
    }
  });

  it('reads an end date out of the sentence', () => {
    const verdict = interpretCapture('Remember that I am away until 2026-04-20', owner);
    if (verdict.kind === 'remember') expect(verdict.expiresAt?.slice(0, 10)).toBe('2026-04-20');
  });

  it('invents nothing from a vague phrase', () => {
    const verdict = interpretCapture('Remember that I am away for a while', owner);
    expect(verdict).toMatchObject({ effectiveFrom: null, expiresAt: null });
  });

  it('will not cite something whose time has not come', () => {
    const item = {
      status: 'active' as const,
      origin: 'explicit' as const,
      expiresAt: null,
      effectiveFrom: '2026-06-01T00:00:00.000Z',
    };
    expect(isCitableAuthority(item, NOW.toISOString())).toBe(false);
    expect(isCitableAuthority(item, '2026-06-02T00:00:00.000Z')).toBe(true);
  });

  it('will not cite something that has expired', () => {
    expect(
      isCitableAuthority(
        {
          status: 'active',
          origin: 'explicit',
          expiresAt: '2026-03-01T00:00:00.000Z',
          effectiveFrom: null,
        },
        NOW.toISOString(),
      ),
    ).toBe(false);
  });
});

describe('forgetting', () => {
  it('is recognised, and names what to look for', () => {
    expect(interpretCapture('forget that I prefer tabs', owner)).toMatchObject({
      kind: 'forget',
      subject: 'I prefer tabs',
    });
    expect(interpretCapture('stop remembering the invoice thing', owner)).toMatchObject({
      kind: 'forget',
    });
  });

  it('is checked before remembering, so "forget that I like X" is not stored as a preference', () => {
    const verdict = interpretCapture('forget that I always squash my commits', owner);
    expect(verdict.kind).toBe('forget');
  });
});
