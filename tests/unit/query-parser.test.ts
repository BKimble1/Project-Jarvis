import { describe, expect, it } from 'vitest';
import { QUERY_INTENTS } from '@/domain/query';
import {
  editDistance,
  extractProjectName,
  parseQuery,
  resolveProjectName,
  type MatchCandidate,
} from '@/server/query/parser';

describe('parseQuery — the phrasings promised in the product brief', () => {
  it.each([
    ['Where are we?', 'portfolio_status'],
    ['What changed?', 'portfolio_changes'],
    ['What needs me?', 'needs_attention'],
    ['What needs my attention?', 'needs_attention'],
    ['Which projects are blocked?', 'blocked_projects'],
    ['Which projects are stale?', 'stale_projects'],
    ['What should I focus on?', 'focus'],
    ['Show active projects.', 'list_active'],
    ['Show waiting projects.', 'list_waiting'],
    ['Show paused projects.', 'list_paused'],
    ['Show me everything currently in progress.', 'list_in_progress'],
  ])('routes %j to %s across the whole portfolio', (question, intent) => {
    const parsed = parseQuery(question);
    expect(parsed.intent).toBe(intent);
    expect(parsed.projectQuery).toBeNull();
    expect(parsed.raw).toBe(question);
  });

  it.each([
    ['Where are we on CoreCredit?', 'project_status'],
    ['What changed on CoreCredit?', 'project_changes'],
  ])('scopes %j to the named project as %s', (question, intent) => {
    const parsed = parseQuery(question);
    expect(parsed.intent).toBe(intent);
    expect(parsed.projectQuery).toBe('corecredit');
    expect(parsed.raw).toBe(question);
  });

  it('never invents an intent outside the domain list', () => {
    const questions = [
      'Where are we?',
      'Where are we on CoreCredit?',
      'What changed?',
      'What changed on CoreCredit?',
      'What needs me?',
      'Which projects are blocked?',
      'What should I focus on?',
      'deploy the site',
      '',
      'CoreCredit',
    ];
    for (const question of questions) {
      expect(QUERY_INTENTS).toContain(parseQuery(question).intent);
    }
  });

  /* "on" here is part of the phrase, not a project scope, so it must not become a project name. */
  it('does not read the trailing "on" of "focus on" as a project scope', () => {
    expect(parseQuery('What should I focus on?')).toEqual({
      intent: 'focus',
      projectQuery: null,
      raw: 'What should I focus on?',
    });
  });

  it('falls back to the portfolio answer when a scoped phrase names no real project', () => {
    /* "the project" is stripped as a filler word, leaving nothing to resolve. */
    const parsed = parseQuery('Where are we on the project?');
    expect(parsed.intent).toBe('portfolio_status');
    expect(parsed.projectQuery).toBeNull();
  });
});

describe('parseQuery — input tolerance', () => {
  it.each([
    'WHERE ARE WE ON CORECREDIT?',
    'where are we on corecredit',
    'Where Are We On CoreCredit',
  ])('is case-insensitive for %j', (question) => {
    const parsed = parseQuery(question);
    expect(parsed.intent).toBe('project_status');
    expect(parsed.projectQuery).toBe('corecredit');
  });

  it.each([
    ['What changed???', 'portfolio_changes'],
    ['What changed!!!', 'portfolio_changes'],
    ['Where are we...', 'portfolio_status'],
    ['Which projects are blocked;', 'blocked_projects'],
  ])('ignores trailing punctuation on %j', (question, intent) => {
    expect(parseQuery(question).intent).toBe(intent);
  });

  it('collapses stray whitespace without changing the answer or the raw text', () => {
    const raw = '   What    changed   on    CoreCredit ?   ';
    const parsed = parseQuery(raw);
    expect(parsed.intent).toBe('project_changes');
    expect(parsed.projectQuery).toBe('corecredit');
    /* The raw text is preserved verbatim so it can be logged as the owner typed it. */
    expect(parsed.raw).toBe(raw);
  });

  it.each(['', '   ', '???', '  .. ,, '])(
    'reports %j as unsupported rather than guessing',
    (raw) => {
      expect(parseQuery(raw)).toEqual({ intent: 'unsupported', projectQuery: null, raw });
    },
  );
});

describe('parseQuery — execution requests', () => {
  it.each([
    ['build a new feature', null],
    ['open a PR', null],
    ['deploy the site', null],
    ['fix the failing test', null],
    ['implement dark mode on CoreCredit', 'corecredit'],
  ])('answers %j as an execution request scoped to %j', (question, projectQuery) => {
    const parsed = parseQuery(question);
    expect(parsed.intent).toBe('execution_request');
    expect(parsed.projectQuery).toBe(projectQuery);
  });

  it('extracts the project scope from an execution request phrased with "for"', () => {
    const parsed = parseQuery('Write the migration for CoreCredit');
    expect(parsed.intent).toBe('execution_request');
    expect(parsed.projectQuery).toBe('corecredit');
  });
});

describe('parseQuery — bare project names', () => {
  it.each(['CoreCredit', 'Aurora', 'Thesis chapter 3'])(
    'treats the bare name %j as a request for the status of that project',
    (name) => {
      const parsed = parseQuery(name);
      expect(parsed.intent).toBe('project_status');
      expect(parsed.projectQuery).toBe(name.toLowerCase());
      expect(parsed.raw).toBe(name);
    },
  );
});

describe('extractProjectName', () => {
  it.each([
    ['where are we on corecredit', 'corecredit'],
    ['what changed for aurora', 'aurora'],
    ['tell me about corecredit', 'corecredit'],
    ['catch me up on aurora', 'aurora'],
  ])('pulls the project name out of %j', (text, expected) => {
    expect(extractProjectName(text)).toBe(expected);
  });

  it('returns null when the phrase carries no project scope', () => {
    expect(extractProjectName('where are we')).toBeNull();
  });

  it('returns null when the scope is only a filler word', () => {
    expect(extractProjectName('where are we on the project')).toBeNull();
  });

  /*
   * Recorded as actual behaviour, not as the desired behaviour: only the exact phrase
   * "the project" is stripped as a pair, so "the repository" leaves a bare article behind and
   * resolveProjectName is then asked to resolve "the".
   */
  it('leaves a bare article behind when the filler word is "repository"', () => {
    expect(extractProjectName('where are we on the repository')).toBe('the');
  });
});

/* --------------------------------------------------------------- resolution */

const CORECREDIT: MatchCandidate = { id: 'p-core', name: 'CoreCredit', shortName: 'core' };
const AURORA: MatchCandidate = { id: 'p-aurora', name: 'Aurora', shortName: null };
const CANDIDATES: readonly MatchCandidate[] = [CORECREDIT, AURORA];

describe('resolveProjectName', () => {
  it('matches an exact name', () => {
    const result = resolveProjectName('CoreCredit', CANDIDATES);
    expect(result.kind).toBe('exact');
    expect(result.matches.map((match) => match.id)).toEqual(['p-core']);
  });

  it('matches an exact short name', () => {
    const result = resolveProjectName('core', CANDIDATES);
    expect(result.kind).toBe('exact');
    expect(result.matches.map((match) => match.id)).toEqual(['p-core']);
  });

  it('normalises case and punctuation before matching', () => {
    const result = resolveProjectName('  CORECREDIT?  ', CANDIDATES);
    expect(result.kind).toBe('exact');
    expect(result.matches.map((match) => match.id)).toEqual(['p-core']);
  });

  it('matches a unique prefix as a close match', () => {
    const result = resolveProjectName('corec', CANDIDATES);
    expect(result.kind).toBe('close');
    expect(result.matches.map((match) => match.id)).toEqual(['p-core']);
  });

  it('matches a unique substring as a close match', () => {
    const result = resolveProjectName('credit', CANDIDATES);
    expect(result.kind).toBe('close');
    expect(result.matches.map((match) => match.id)).toEqual(['p-core']);
  });

  it('forgives a typo within the edit-distance tolerance', () => {
    /* 'aurroa' is two transposition edits from 'Aurora' and shares no substring with it. */
    expect(editDistance('aurroa', 'aurora')).toBe(2);
    const result = resolveProjectName('aurroa', CANDIDATES);
    expect(result.kind).toBe('close');
    expect(result.matches.map((match) => match.id)).toEqual(['p-aurora']);
  });

  it('rejects a typo beyond the tolerance rather than guessing', () => {
    /* Four characters allow a single edit; 'zzzz' is far further from 'Aurora' than that. */
    const result = resolveProjectName('zzzz', [AURORA]);
    expect(result.kind).toBe('none');
    expect(result.matches).toEqual([]);
  });

  it('reports ambiguity instead of picking the first of two prefix matches', () => {
    const ledger: MatchCandidate = { id: 'p-ledger', name: 'CoreLedger', shortName: null };
    const credit: MatchCandidate = { id: 'p-credit', name: 'CoreCredit', shortName: null };
    const result = resolveProjectName('core', [credit, ledger]);
    expect(result.kind).toBe('ambiguous');
    expect(result.matches.map((match) => match.name)).toEqual(['CoreCredit', 'CoreLedger']);
  });

  it('reports ambiguity when two projects share the same name', () => {
    const first: MatchCandidate = { id: 'p-1', name: 'Atlas', shortName: null };
    const second: MatchCandidate = { id: 'p-2', name: 'atlas', shortName: null };
    const result = resolveProjectName('Atlas', [first, second]);
    expect(result.kind).toBe('ambiguous');
    expect(result.matches.map((match) => match.id)).toEqual(['p-1', 'p-2']);
  });

  it('reports ambiguity when two typo candidates are equally close', () => {
    const nova: MatchCandidate = { id: 'p-nova', name: 'Nova', shortName: null };
    const lava: MatchCandidate = { id: 'p-lava', name: 'Lava', shortName: null };
    expect(editDistance('nava', 'nova')).toBe(1);
    expect(editDistance('nava', 'lava')).toBe(1);
    const result = resolveProjectName('nava', [nova, lava]);
    expect(result.kind).toBe('ambiguous');
    expect(result.matches.map((match) => match.id)).toEqual(['p-nova', 'p-lava']);
  });

  it('reports no match for a name nothing resembles', () => {
    const result = resolveProjectName('quantum', CANDIDATES);
    expect(result.kind).toBe('none');
    expect(result.matches).toEqual([]);
  });

  it('reports no match for an empty query', () => {
    expect(resolveProjectName('', CANDIDATES)).toEqual({ kind: 'none', matches: [] });
    expect(resolveProjectName('   ?  ', CANDIDATES)).toEqual({ kind: 'none', matches: [] });
  });

  it('reports no match when there are no projects yet', () => {
    expect(resolveProjectName('CoreCredit', [])).toEqual({ kind: 'none', matches: [] });
  });
});

describe('editDistance', () => {
  it.each([
    ['', '', 0],
    ['abc', 'abc', 0],
    ['', 'abc', 3],
    ['abc', '', 3],
    ['kitten', 'sitting', 3],
    ['saturday', 'sunday', 3],
    ['flaw', 'lawn', 2],
    ['corecredit', 'corecreidt', 2],
    ['core', 'corecredit', 6],
  ])('reports the distance from %j to %j as %i', (a, b, expected) => {
    expect(editDistance(a, b)).toBe(expected);
  });

  it('is symmetric', () => {
    expect(editDistance('kitten', 'sitting')).toBe(editDistance('sitting', 'kitten'));
    expect(editDistance('core', 'corecredit')).toBe(editDistance('corecredit', 'core'));
  });
});
