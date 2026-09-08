import { extractProductName } from './product-name';

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
  /*
   * Prohibitions are removed first. "Do not build an app yet" carries a creation verb and an
   * artefact noun and means the opposite of both, and this is the guard standing in front of the
   * one act that only the owner can undo.
   */
  const asking = normalise(withoutProhibitions(raw));
  return CREATION_VERB.test(asking) && ARTEFACT.test(asking);
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
 * A creation verb that is being forbidden rather than asked for.
 *
 * ## The bug this exists for
 *
 * "Re-evaluate my QuickPick idea … Do not build anything yet." created a project called **Yet**.
 * `NAME_BETWEEN` anchors on the end of the string when no artefact noun follows the verb, so the
 * only creation verb in the message — the `build` inside the prohibition — captured "anything
 * yet", `FILLER` dropped "anything", and the word the owner used to say *stop* became the name of
 * the thing that was started.
 *
 * The sentence is not a weaker instruction to build. It is an instruction not to. Reading a name
 * out of it is reading it backwards, so the clause is removed before any name is inferred.
 *
 * Bounded to 40 characters between the negation and the verb so it stays inside one clause: "do
 * not touch the database" followed much later by "build a dashboard" are two separate statements
 * and only the first is a prohibition.
 */
const NEGATED_CREATION = new RegExp(
  `\\b(?:do not|don't|dont|does not|doesn't|did not|didn't|never|not|no need to|avoid|hold off|refrain from|stop|without)\\b[^.!?;:]{0,40}?\\b(?:${CREATION_VERBS.join('|')})\\b`,
  'i',
);

/**
 * The message with its prohibitions removed.
 *
 * Split on sentence enders before punctuation is normalised away, because `normalise` flattens
 * `.`, `;` and `:` into spaces and a clause boundary cannot be recovered afterwards.
 *
 * Returns an empty string when every sentence was a prohibition — which is the honest answer. A
 * message that only says what not to do does not name anything, and `deriveProjectName` falls
 * through to its placeholder rather than to a word lifted out of the refusal.
 */
function withoutProhibitions(raw: string): string {
  const sentences = raw.split(/(?<=[.!?;:])\s+/);
  return sentences.filter((sentence) => !NEGATED_CREATION.test(sentence)).join(' ');
}

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
  /*
   * Matching is done on lower-cased text, but the name the owner wrote is the one that should
   * survive: "QuickPick" becomes the project name and, slugged, the repository name. Recovering
   * the original casing from the source beats title-casing a lower-cased word, which turns
   * QuickPick into Quickpick and quietly renames somebody's app.
   */
  const asWritten = (word: string): string => {
    const found = new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').exec(raw);
    return found?.[0] ?? word;
  };

  /*
   * `NAMED` reads the whole message: "the app called Foo" is authoritative wherever it appears,
   * including inside a sentence that also forbids building it. `NAME_BETWEEN` infers, so it is
   * only ever shown the sentences that actually ask for something.
   */
  const explicit = NAMED.exec(text);
  const source = explicit?.[1] ?? NAME_BETWEEN.exec(normalise(withoutProhibitions(raw)))?.[1] ?? '';

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
  if (words.length > 0) return words.map((word) => capitalise(asWritten(word))).join(' ');

  /*
   * Nothing asked for anything, so nothing could be inferred — which is the shape of every message
   * that discusses an idea instead of commissioning it. "Re-evaluate my QuickPick idea … Do not
   * build anything yet." reaches here, and the name is sitting in it already.
   *
   * This runs *after* inference rather than before it on purpose. "Create a dashboard for
   * CoreCredit" commissions a dashboard for a client; reading the client's name as the project's
   * would be the same class of mistake as reading "yet" as one, in the opposite direction.
   */
  return extractProductName(raw) ?? 'New project';
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
  /* "…anything yet" is how the owner said stop. It is not the name of a project. */
  'yet',
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
