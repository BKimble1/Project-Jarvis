/**
 * Works out *what* a chat message is talking about: which project, which open
 * question, which offered option (acceptance requirement 2).
 *
 * The important behaviour is the refusal. When a reference genuinely could mean
 * two things — two recent projects match the words equally well, a pronoun with
 * nothing active, an option number outside the list we offered — this returns
 * `kind: 'ambiguous'` with no id, so the caller asks a one-line question.
 * It never falls back to "the most recently touched project", because silently
 * changing the wrong project is worse than one extra question.
 */

/** Words that carry no identifying power when matching a project title. */
const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'for', 'of', 'to', 'in', 'on', 'at', 'with', 'from',
  'my', 'our', 'your', 'that', 'this', 'it', 'its', 'is', 'are', 'be', 'was', 'were',
  'app', 'apps', 'application', 'project', 'projects', 'thing', 'stuff', 'one', 'ones',
  'build', 'building', 'make', 'making', 'new', 'please', 'change', 'update', 'add',
  'use', 'using', 'instead', 'also', 'option', 'continue', 'resume', 'pause', 'stop',
  'cancel', 'status', 'me', 'you', 'i', 'we', 'can', 'could', 'would', 'should',
  'tool', 'tools', 'thingy', 'work', 'again', 'now', 'back', 'about', 'what', 'how',
]);

const ORDINALS = new Map([
  ['first', 1], ['1st', 1], ['one', 1],
  ['second', 2], ['2nd', 2], ['two', 2],
  ['third', 3], ['3rd', 3], ['three', 3],
  ['fourth', 4], ['4th', 4], ['four', 4],
  ['fifth', 5], ['5th', 5], ['five', 5],
  ['sixth', 6], ['6th', 6], ['six', 6],
  ['seventh', 7], ['7th', 7], ['seven', 7],
  ['eighth', 8], ['8th', 8], ['eight', 8],
  ['ninth', 9], ['9th', 9], ['nine', 9],
  ['tenth', 10], ['10th', 10], ['ten', 10],
]);

const ORDINAL_WORDS = [...ORDINALS.keys()].join('|');

/** Explicit — "option 2", "choice three". Valid even before we know the list. */
const EXPLICIT_OPTION_RES = [
  new RegExp(`\\b(?:option|choice|item|answer|number|no\\.?|#)\\s*(\\d+)\\b`, 'i'),
  new RegExp(`\\b(?:option|choice|item|answer|number)\\s+(${ORDINAL_WORDS})\\b`, 'i'),
];

/** Loose — "the second one", "the third", "2". Only meaningful with a list. */
const LOOSE_OPTION_RES = [
  new RegExp(`\\bthe\\s+(${ORDINAL_WORDS}|last)\\b`, 'i'),
  new RegExp(`\\b(${ORDINAL_WORDS})\\s+(?:option|one|choice|item)\\b`, 'i'),
  new RegExp(`\\bgo\\s+with\\s+(?:the\\s+)?(${ORDINAL_WORDS}|last)\\b`, 'i'),
  new RegExp(`^\\s*#?(\\d+)\\s*[.!]?$`, 'i'),
];

/** Referential pronouns — deliberately narrow so "a CLI that renames files" is not a reference. */
const PRONOUN_RES = [
  /\b(?:change|update|revise|modify|tweak|adjust|redo|fix|pause|stop|cancel|abort|resume|continue|kill|scrap|drop|check|show|finish|ship)\s+(?:that|it|this|the project|the build)\b/i,
  /^(?:that|it|this)\b/i,
  /\bthe\s+(?:project|build|current (?:one|project|build)|same (?:one|project|thing))\b/i,
  /\b(?:it|that|this)\s*[?!.]?$/i,
  /\b(?:make|switch|turn|set|keep)\s+(?:it|that|this)\b/i,
  /\bon\s+(?:it|that|this)\b/i,
];

const CONTINUE_RE = /\b(?:continue|keep going|carry on|resume|unpause|proceed|pick (?:it |that )?back up|pick up where|back to it)\b/i;

function result(kind, { projectId = null, questionId = null, optionIndex = null } = {}) {
  return { projectId, questionId, optionIndex, kind };
}

function tokenize(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map(stem);
}

/** Crude singular form so "scrapers" matches "scraper". */
function stem(token) {
  return token.length > 4 && token.endsWith('s') && !token.endsWith('ss') ? token.slice(0, -1) : token;
}

function readOptionNumber(text) {
  for (const re of EXPLICIT_OPTION_RES) {
    const m = text.match(re);
    if (m) return { n: numberFrom(m[1]), explicit: true };
  }
  for (const re of LOOSE_OPTION_RES) {
    const m = text.match(re);
    if (m) return { n: numberFrom(m[1]), explicit: false };
  }
  return null;
}

function numberFrom(token) {
  const raw = String(token ?? '').toLowerCase();
  if (raw === 'last') return 'last';
  if (ORDINALS.has(raw)) return ORDINALS.get(raw);
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : null;
}

/**
 * Score how strongly a project's title is named by the text. 0 means "not
 * mentioned"; higher means more of the title's distinctive words appear.
 */
function titleScore(project, textTokens, lowerText) {
  const title = String(project?.title ?? '');
  if (!title.trim()) return 0;
  const normalizedTitle = title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const distinct = tokenize(title).filter((t) => t.length >= 3 && !STOPWORDS.has(t));
  if (!distinct.length) return 0;
  const hits = distinct.filter((t) => textTokens.has(t)).length;
  if (!hits) return 0;
  // Naming the whole title verbatim is a much stronger signal than one word.
  const verbatim = normalizedTitle.length >= 3 && lowerText.includes(normalizedTitle);
  return hits + (verbatim ? distinct.length : 0);
}

/**
 * @param {string} text
 * @param {{conversationId?:string, activeProjectId?:string|null,
 *          recentProjects?:Array<{id:string,title:string,updatedAt:number}>,
 *          openQuestion?:object|null, lastOptions?:string[]}} [ctx]
 * @returns {{projectId:string|null, questionId:string|null, optionIndex:number|null, kind:string}}
 */
export function resolveReference(text, ctx = {}) {
  const clean = (typeof text === 'string' ? text : text == null ? '' : String(text)).replace(/\s+/g, ' ').trim();
  const context = ctx && typeof ctx === 'object' ? ctx : {};
  const active = context.activeProjectId ?? null;
  const openQuestion = context.openQuestion ?? null;
  const questionId = openQuestion?.id ?? null;
  const options = Array.isArray(context.lastOptions) ? context.lastOptions : [];
  const recents = Array.isArray(context.recentProjects) ? context.recentProjects.filter((p) => p && p.id) : [];

  if (!clean) {
    return openQuestion ? result('question', { projectId: openQuestion.projectId ?? active, questionId }) : result('none');
  }

  const lower = clean.toLowerCase();

  // 1. An option pick, resolved against the list we actually offered.
  const pick = readOptionNumber(lower);
  if (pick && (pick.explicit || options.length)) {
    if (!options.length) return result('ambiguous', { questionId });
    const n = pick.n === 'last' ? options.length : pick.n;
    if (!Number.isFinite(n) || n < 1 || n > options.length) return result('ambiguous', { questionId });
    return result('option', {
      projectId: openQuestion?.projectId ?? active,
      questionId,
      optionIndex: n - 1,
    });
  }

  // 2. A project named by a fragment of its title.
  const textTokens = new Set(tokenize(clean));
  const scored = recents
    .map((p) => ({ id: p.id, score: titleScore(p, textTokens, lower) }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);
  if (scored.length === 1) return result('title', { projectId: scored[0].id, questionId });
  if (scored.length > 1) {
    // Only commit when one title is a strictly better match than every other.
    if (scored[0].score > scored[1].score) return result('title', { projectId: scored[0].id, questionId });
    return result('ambiguous', { questionId });
  }

  // 3. A pronoun or a "carry on" — both mean whatever is active right now.
  if (PRONOUN_RES.some((re) => re.test(lower)) || CONTINUE_RE.test(lower)) {
    if (active) return result('active', { projectId: active, questionId });
    return result('ambiguous', { questionId });
  }

  // 4. Nothing named, but something is waiting on an answer.
  if (openQuestion) return result('question', { projectId: openQuestion.projectId ?? active, questionId });

  return result('none');
}
