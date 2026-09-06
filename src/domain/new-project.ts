/**
 * Does this sentence describe something that does not exist yet?
 *
 * ## Why the question is asked so narrowly
 *
 * Because the consequence of getting it wrong is a repository on somebody's GitHub account. Every
 * other mistake in interpretation costs a clarifying question; this one costs a deletion, and only
 * the owner can do that. So the test is not "does this look like work Jarvis cannot place?" — it
 * is "does this name a *thing to be made*, in a sentence that says to make it?".
 *
 * The failure being avoided is specific and easy to reach: "Fix the login bug", typed when no
 * project matched, must not become a project called "login bug" with a repository behind it. It
 * fails here because there is no created-thing noun in it. "Build me a rent tracker app" passes,
 * because there is.
 *
 * ## Why a word list rather than a model
 *
 * A model would be right more often and wrong unpredictably, and the unpredictable failures are
 * the expensive ones. A closed list is wrong in exactly one direction — it declines things it
 * should have accepted — and the cost of that is Jarvis asking "what should I call it?", which is
 * a perfectly ordinary thing for it to ask.
 *
 * ## Why the lists are arrays
 *
 * Because both patterns below are built from them, and a regular expression that is
 * reverse-engineered out of another regular expression's `source` is a regular expression that
 * throws at run time on an input nobody tested. One list, two patterns compiled from it.
 */

/** Verbs that make something that was not there. Not "fix", "update", "review". */
const CREATION_VERBS = [
  'build',
  'create',
  'make',
  'scaffold',
  'prototype',
  'start',
  'set up',
  'spin up',
  'stand up',
] as const;

/**
 * Nouns for a thing that is made.
 *
 * Deliberately about software artefacts rather than about parts of one. "Add an endpoint" is work
 * inside something that exists; "build an app" is the thing itself.
 */
const ARTEFACTS = [
  'app',
  'application',
  'tool',
  'site',
  'website',
  'web ?app',
  'service',
  'api',
  'bot',
  'script',
  'dashboard',
  'extension',
  'plugin',
  'game',
  'library',
  'package',
  'cli',
  'prototype',
  'mvp',
  'project',
  'repo',
  'repository',
] as const;

const CREATION_VERB = new RegExp(`\\b(?:${CREATION_VERBS.join('|')})\\b`);
const ARTEFACT = new RegExp(`\\b(?:${ARTEFACTS.join('|')})\\b`);

/**
 * Sentences that ask *whether* to make something rather than saying to make it.
 *
 * Belt and braces: `interpretMessage` already reads these as ideas and never asks this question
 * about them. It is repeated here because this is the guard in front of the irreversible act, and
 * a guard that only works because something upstream caught it first stops working the day the
 * thing upstream changes.
 */
const ASKING =
  /\b(?:should i|should we|is (?:it|this|that) worth|worth building|do you think|what do you think|would (?:it|this|that) (?:work|be)|is there a market|makes? sense)\b/;

/** Phrases that place the work inside something already there, whatever else the sentence says. */
const EXISTING =
  /\b(?:in|on|to|inside|within|for)\s+(?:the\s+)?(?:existing|current|this)\b|\bexisting (?:project|repo|repository|app)\b/;

/**
 * True when the sentence asks for something new to be made.
 *
 * All three must hold: a creation verb, an artefact noun, and no phrase placing it inside
 * something that already exists. Requiring all three is what keeps the answer conservative.
 */
export function describesNewProject(raw: string): boolean {
  const text = normalise(raw);
  if (ASKING.test(text) || EXISTING.test(text)) return false;
  return CREATION_VERB.test(text) && ARTEFACT.test(text);
}

/**
 * The words between the creation verb and the artefact noun — the descriptive middle of the
 * sentence, which is where the name of the thing lives.
 */
const NAME_BETWEEN = new RegExp(
  `\\b(?:${CREATION_VERBS.join('|')})\\b\\s+(?:me\\s+|us\\s+)?(?:(?:an?|the|some)\\s+)?([a-z0-9][a-z0-9 '-]{0,60}?)\\s*(?:\\b(?:${ARTEFACTS.join('|')})\\b|$)`,
);

/** "…called wrenchy", "…named Holograph" — an explicit name always wins over an inferred one. */
const NAMED =
  /\b(?:called|named)\s+([a-z0-9][a-z0-9 '-]{0,60}?)(?:\s+(?:that|which|to|for|so|and|with)\b|$)/;

/**
 * A project name from the sentence that asked for it.
 *
 * The rule is to keep the descriptive words between the verb and the artefact noun — "build me a
 * simple rent tracker app" gives "Rent Tracker" — and to fall back to something obviously
 * placeholder-ish rather than to something confidently wrong. A name is cheap to change on the
 * project screen; a name that reads as though Jarvis understood more than it did is not.
 */
export function deriveProjectName(raw: string): string {
  const text = normalise(raw);

  const explicit = NAMED.exec(text);
  const source = explicit?.[1] ?? NAME_BETWEEN.exec(text)?.[1] ?? '';

  /*
   * Cut at the first joining word. "A dashboard for CoreCredit" names a dashboard; carrying the
   * whole phrase into the name produces "Dashboard For Corecredit", which is a sentence fragment
   * wearing a project's clothes.
   */
  const untilClause: string[] = [];
  for (const word of source.split(/\s+/)) {
    if (CLAUSE_BREAK.has(word)) break;
    untilClause.push(word);
  }

  const words = untilClause.filter((word) => word.length > 0 && !FILLER.has(word)).slice(0, 4);

  if (words.length === 0) return 'New project';
  return words.map(capitalise).join(' ');
}

/** Words that begin a clause about the thing rather than continuing its name. */
const CLAUSE_BREAK = new Set([
  'for',
  'to',
  'that',
  'which',
  'so',
  'and',
  'with',
  'in',
  'on',
  'about',
  'using',
  'from',
]);

/** Adjectives that describe the *request* rather than the thing. "A simple rent tracker" is one. */
const FILLER = new Set([
  'a',
  'an',
  'the',
  'some',
  'simple',
  'small',
  'basic',
  'quick',
  'little',
  'tiny',
  'minimal',
  'rough',
  'first',
  'new',
  'my',
  'me',
  'us',
  'please',
  'just',
  'something',
  'anything',
  'version',
  'of',
]);

const capitalise = (word: string): string =>
  word.length === 0 ? word : `${word[0]?.toUpperCase() ?? ''}${word.slice(1)}`;

const normalise = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[?!.,;:"`]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
