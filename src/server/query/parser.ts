/**
 * Deterministic parsing for the Jarvis command bar.
 *
 * There is no model in this path. Every supported question maps to an intent by pattern, so the
 * same words always produce the same answer, and an unsupported request is reported as
 * unsupported rather than answered vaguely.
 */

export const QUERY_INTENTS = [
  'portfolio_status',
  'project_status',
  'portfolio_changes',
  'project_changes',
  'needs_attention',
  'blocked_projects',
  'stale_projects',
  'focus',
  'list_active',
  'list_waiting',
  'list_paused',
  'list_in_progress',
  'execution_request',
  'unsupported',
] as const;
export type QueryIntent = (typeof QUERY_INTENTS)[number];

export interface ParsedQuery {
  readonly intent: QueryIntent;
  /** Free text naming a project, when the question was scoped to one. */
  readonly projectQuery: string | null;
  readonly raw: string;
}

const normalise = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[?!.,;:"'`]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** Verbs that mean "do work", which Phase 1 deliberately cannot do. */
const EXECUTION_PATTERN =
  /\b(build|implement|write|create|add|fix|refactor|deploy|ship|release|open a pr|raise a pr|make a branch|run the tests|generate|code|develop|migrate|upgrade|install|publish|push)\b/;

const PROJECT_SCOPE_PATTERN =
  /\b(?:on|for|with|about|of|in)\s+(.+)$/;

interface Rule {
  readonly intent: QueryIntent;
  readonly test: RegExp;
  readonly scoped?: boolean;
}

/* Order matters: the most specific patterns are tried first. */
const RULES: readonly Rule[] = [
  { intent: 'project_changes', test: /^what(?:'s| has| is)? ?(?:changed|new|happened)\b.*\b(?:on|for|with|about|in)\s+.+/, scoped: true },
  { intent: 'portfolio_changes', test: /^what(?:'s| has| is)? ?(?:changed|new|happened)\b/ },
  { intent: 'project_status', test: /^(?:where are we|where do we stand|status|how(?:'s| is) it going|what(?:'s| is) the status)\b.*\b(?:on|for|with|about|in)\s+.+/, scoped: true },
  { intent: 'portfolio_status', test: /^(?:where are we|where do we stand|status|give me the (?:status|briefing|rundown)|brief me|what(?:'s| is) the status)\b/ },
  { intent: 'needs_attention', test: /\b(?:needs? (?:me|my attention|attention)|what should i look at|what requires me|anything for me)\b/ },
  { intent: 'blocked_projects', test: /\b(?:blocked|blockers?)\b/ },
  { intent: 'stale_projects', test: /\b(?:stale|out of date|going cold|neglected|forgotten)\b/ },
  { intent: 'focus', test: /\b(?:focus|prioriti[sz]e|work on next|what next|what should i do)\b/ },
  { intent: 'list_in_progress', test: /\b(?:in progress|currently (?:in progress|being worked on)|what(?:'s| is) happening)\b/ },
  { intent: 'list_waiting', test: /\bwaiting\b/ },
  { intent: 'list_paused', test: /\bpaused\b/ },
  { intent: 'list_active', test: /\bactive\b/ },
  { intent: 'project_status', test: /^(?:tell me about|how is|how's|catch me up on)\s+.+/, scoped: true },
];

export function parseQuery(raw: string): ParsedQuery {
  const text = normalise(raw);
  if (text.length === 0) return { intent: 'unsupported', projectQuery: null, raw };

  for (const rule of RULES) {
    if (!rule.test.test(text)) continue;
    const projectQuery = rule.scoped ? extractProjectName(text) : null;
    /* A scoped rule that yields no project name falls through to its portfolio equivalent. */
    if (rule.scoped && !projectQuery) continue;
    return { intent: rule.intent, projectQuery, raw };
  }

  if (EXECUTION_PATTERN.test(text)) {
    return { intent: 'execution_request', projectQuery: extractProjectName(text), raw };
  }

  /* A bare project name is treated as "where are we on that project?". */
  return { intent: 'project_status', projectQuery: text, raw };
}

export function extractProjectName(text: string): string | null {
  const scoped = PROJECT_SCOPE_PATTERN.exec(text);
  if (scoped?.[1]) return cleanProjectName(scoped[1]);
  const lead = /^(?:tell me about|how is|how's|catch me up on)\s+(.+)$/.exec(text);
  if (lead?.[1]) return cleanProjectName(lead[1]);
  return null;
}

function cleanProjectName(value: string): string | null {
  const cleaned = value
    .replace(/\b(?:project|the project|repo|repository)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.length > 0 ? cleaned : null;
}

/* --------------------------------------------------------- project matching */

export interface MatchCandidate {
  readonly id: string;
  readonly name: string;
  readonly shortName: string | null;
}

export interface MatchResult {
  readonly kind: 'exact' | 'close' | 'ambiguous' | 'none';
  readonly matches: readonly MatchCandidate[];
}

/**
 * Resolve a typed project name.
 *
 * Exact name / short-name matches win. Otherwise prefix and substring matches are collected, and
 * finally an edit-distance pass catches typos. When more than one candidate survives, the caller
 * is told to ask rather than guessing.
 */
export function resolveProjectName(query: string, candidates: readonly MatchCandidate[]): MatchResult {
  const needle = normalise(query);
  if (needle.length === 0 || candidates.length === 0) return { kind: 'none', matches: [] };

  const scored = candidates.map((candidate) => {
    const name = normalise(candidate.name);
    const short = candidate.shortName ? normalise(candidate.shortName) : null;
    return { candidate, name, short };
  });

  const exact = scored.filter((entry) => entry.name === needle || entry.short === needle);
  if (exact.length === 1) return { kind: 'exact', matches: exact.map((entry) => entry.candidate) };
  if (exact.length > 1) return { kind: 'ambiguous', matches: exact.map((entry) => entry.candidate) };

  const prefix = scored.filter(
    (entry) => entry.name.startsWith(needle) || (entry.short?.startsWith(needle) ?? false),
  );
  if (prefix.length === 1) return { kind: 'close', matches: prefix.map((entry) => entry.candidate) };
  if (prefix.length > 1) return { kind: 'ambiguous', matches: prefix.map((entry) => entry.candidate) };

  const substring = scored.filter(
    (entry) =>
      entry.name.includes(needle) ||
      needle.includes(entry.name) ||
      (entry.short ? entry.short.includes(needle) || needle.includes(entry.short) : false),
  );
  if (substring.length === 1) return { kind: 'close', matches: substring.map((entry) => entry.candidate) };
  if (substring.length > 1) return { kind: 'ambiguous', matches: substring.map((entry) => entry.candidate) };

  const tolerance = needle.length <= 5 ? 1 : needle.length <= 10 ? 2 : 3;
  const fuzzy = scored
    .map((entry) => ({
      candidate: entry.candidate,
      distance: Math.min(
        editDistance(needle, entry.name),
        entry.short ? editDistance(needle, entry.short) : Number.MAX_SAFE_INTEGER,
      ),
    }))
    .filter((entry) => entry.distance <= tolerance)
    .sort((a, b) => a.distance - b.distance);

  if (fuzzy.length === 0) return { kind: 'none', matches: [] };
  const best = fuzzy[0];
  if (!best) return { kind: 'none', matches: [] };
  const tied = fuzzy.filter((entry) => entry.distance === best.distance);
  if (tied.length > 1) return { kind: 'ambiguous', matches: tied.map((entry) => entry.candidate) };
  return { kind: 'close', matches: [best.candidate] };
}

/** Iterative Levenshtein distance; small inputs only, so the simple implementation is fine. */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i, ...new Array<number>(b.length).fill(0)];
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a.charAt(i - 1) === b.charAt(j - 1) ? 0 : 1;
      current[j] = Math.min(
        (current[j - 1] ?? 0) + 1,
        (previous[j] ?? 0) + 1,
        (previous[j - 1] ?? 0) + cost,
      );
    }
    previous = current;
  }
  return previous[b.length] ?? 0;
}
