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
   * Instruction sentences are removed first, for the same reason `deriveProjectName` removes them.
   *
   * "Do not build an app yet" carries a creation verb and an artefact noun and means the opposite
   * of both. Naming was fixed by dropping those sentences before reading a name out of them; this
   * is the same sentence, read by the guard that stands in front of the irreversible act, and it
   * has to answer the same way. A guard that reads a refusal as a request is the one place in this
   * module where being wrong costs a repository on somebody's account.
   */
  const asking = normalise(describingSentences(raw));
  return CREATION_VERB.test(asking) && ARTEFACT.test(asking);
}

/**
 * The words between the creation verb and the artefact noun — the descriptive middle of the
 * sentence, which is where the name of the thing lives.
 */
const NAME_BETWEEN = new RegExp(
  `\\b(?:${CREATION_VERBS.join('|')})\\b\\s+(?:me\\s+|us\\s+)?(?:(?:an?|the|some)\\s+)?([a-z0-9][a-z0-9 '-]{0,60}?)\\s*(?:\\b(?:${ARTEFACTS.join('|')})\\b|$)`,
  'i',
);

/** "…called wrenchy", "…named Holograph" — an explicit name always wins over an inferred one. */
const NAMED =
  /\b(?:called|named)\s+([a-z0-9][a-z0-9 '-]{0,60}?)(?:\s+(?:that|which|to|for|so|and|with)\b|$)/i;

/**
 * "my QuickPick idea", "the rent tracker app", "our invoicing tool".
 *
 * A possessive or article, one to three words, then a noun for the *kind* of thing. This is how
 * people refer to something they have already named, which is exactly what a follow-up message
 * does — and the previous rules could not see it, because they only looked between a creation verb
 * and an artefact noun and a follow-up has neither.
 */
const NAME_FRAME =
  /\b(?:my|our|your|the|this|that|an?)\s+((?:[\w'-]+\s+){0,2}[\w'-]+)\s+(?:idea|concept|app|application|project|tool|site|website|service|product|prototype|bot|game|dashboard|extension|plugin|thing)\b/i;

/**
 * A word with a capital inside it — QuickPick, CoreCredit, TestFlight.
 *
 * Nobody writes a word that way by accident, so it is nearly always a product name. Restricted to
 * an *internal* capital on purpose: an ordinary capitalised word is just a word at the start of a
 * sentence, or a person, or a tool the owner mentioned in passing.
 */
const CAMEL_CASE = /(\S+\s+)?\b([A-Za-z][a-z0-9]*[A-Z][A-Za-z0-9]*)\b/g;

/**
 * Sentences that instruct Jarvis rather than describe the thing.
 *
 * "Do not build anything yet." is a constraint on what to do with an idea. Read as a description of
 * the idea it produced a project called "Yet", a private repository called `yet`, and a mission to
 * re-evaluate something — which is what happens when a sentence about the *request* is mined for
 * the name of the *product*. Sentence-scoped, like the interpreter's own negation test, so a
 * refusal in the last sentence cannot reach back over the whole message.
 */
const INSTRUCTION_SENTENCE =
  /\b(?:do ?n(?:o|')t|dont|never|no need to|hold off|rather not|no rush to)\b[^.!?]*\b(?:build\w*|make|making|start\w*|creat\w*|implement\w*|writ\w*|cod\w*|ship\w*|deploy\w*|do it|anything)\b|\b(?:build|make|start|create|implement)\w*\b[^.!?]*\bnot yet\b/i;

/** What is left of a message once the sentences telling Jarvis what *not* to do are removed. */
function describingSentences(raw: string): string {
  const sentences = raw.split(/(?<=[.!?])\s+/).filter((sentence) => sentence.trim().length > 0);
  const kept = sentences.filter((sentence) => !INSTRUCTION_SENTENCE.test(sentence));
  /* If every sentence was an instruction there is nothing to describe, so use what there is. */
  return (kept.length > 0 ? kept : sentences).join(' ');
}

/**
 * A project name from the sentence that asked for it.
 *
 * Four readings, in descending order of how sure they are, and a placeholder rather than a
 * confident guess when none of them fires:
 *
 * 1. A name the owner stated — "called wrenchy", "named Holograph".
 * 2. A name in a possessive frame — "my QuickPick idea", "a simple rent tracker app".
 * 3. A word with a capital inside it, unless it follows a joining word: "for CoreCredit" names the
 *    client of a dashboard, not the dashboard.
 * 4. The descriptive middle between a creation verb and an artefact noun.
 *
 * All four run on the message with its instruction sentences removed, and all four are
 * case-insensitive against the original text so the owner's own casing survives: QuickPick stays
 * QuickPick rather than becoming Quickpick and quietly renaming somebody's app.
 */
export function deriveProjectName(raw: string): string {
  const described = describingSentences(raw);

  const stated = NAMED.exec(described)?.[1];
  if (stated) {
    const name = tidy(stated);
    if (name) return name;
  }

  const framed = NAME_FRAME.exec(described)?.[1];
  if (framed) {
    const name = tidy(framed);
    if (name) return name;
  }

  const camel = distinctiveWord(described);
  if (camel) return camel;

  const between = NAME_BETWEEN.exec(described)?.[1];
  if (between) {
    const name = tidy(between);
    if (name) return name;
  }

  return UNNAMED;
}

/**
 * What a project is called when the owner did not name it and nothing in the words suggests one.
 *
 * A real answer, not a placeholder: "New project" is what the projects list should say, and
 * `describesNewProject` is what decides whether a project is created at all, so an idea that
 * reaches here is one worth listing. Exported so prose can *recognise* it and say something
 * else — "I have not judged whether New project is worth building" is a sentence about a project
 * with a name, and there isn't one.
 */
export const UNNAMED = 'New project';

/**
 * A name the owner actually wrote, or null when they did not write one.
 *
 * ## Why this exists beside `deriveProjectName`
 *
 * They answer different questions. `deriveProjectName` answers "what should this be called?" and
 * must always answer something, so it ends at the placeholder `New project`. This answers "did the
 * owner name a product?", and `null` is a real answer — which is what makes it usable as an
 * *identity*.
 *
 * `proposalSubjectKey` keys an idea on the product it names, so that the same idea described twice
 * in different words lands on one proposal row rather than two things "go ahead" could mean. Keyed
 * on `deriveProjectName` instead, every unnamed idea would collide on the single key "New project"
 * — every stray thought the owner ever had, filed as one proposal.
 *
 * The three readings below are exactly the ones that indicate a name was written down. The fourth
 * reading `deriveProjectName` uses — the descriptive middle between a creation verb and an artefact
 * noun — is deliberately absent: "build me a rent tracker app" describes a thing without naming it,
 * and inferring an identity from a description is how two different ideas become one row.
 */
export function statedProductName(raw: string): string | null {
  const described = describingSentences(raw);

  const stated = NAMED.exec(described)?.[1];
  if (stated) {
    const name = tidy(stated);
    if (name) return name;
  }

  const framed = NAME_FRAME.exec(described)?.[1];
  if (framed) {
    const name = tidy(framed);
    if (name) return name;
  }

  return distinctiveWord(described);
}

/**
 * The first word with an internal capital that is not introduced by a joining word.
 *
 * "A dashboard for CoreCredit" is a dashboard; "my QuickPick idea" is QuickPick. The difference is
 * entirely the word in front, which is why the preceding token is part of the match.
 */
function distinctiveWord(text: string): string | null {
  CAMEL_CASE.lastIndex = 0;
  for (let found = CAMEL_CASE.exec(text); found; found = CAMEL_CASE.exec(text)) {
    const before =
      found[1]
        ?.trim()
        .toLowerCase()
        .replace(/[^a-z]/g, '') ?? '';
    const word = found[2];
    if (!word || CLAUSE_BREAK.has(before)) continue;
    return word;
  }
  return null;
}

/**
 * A captured phrase reduced to the words that are actually a name.
 *
 * Cut at the first joining word, drop the fillers, keep at most four. Returns null when nothing
 * survives — "the best idea" and "build something" are not names, and a placeholder is a better
 * answer than "Best" or "Something".
 */
function tidy(phrase: string): string | null {
  const untilClause: string[] = [];
  for (const word of normalise(phrase).split(/\s+/)) {
    if (CLAUSE_BREAK.has(word)) break;
    untilClause.push(word);
  }

  const words = untilClause.filter((word) => word.length > 0 && !FILLER.has(word)).slice(0, 4);
  if (words.length === 0) return null;
  return words.map((word) => capitalise(asWritten(word, phrase))).join(' ');
}

/**
 * The word as the owner wrote it.
 *
 * Matching happens on lower-cased text, but the casing the owner chose is the one that should
 * survive. Recovering it from the source beats title-casing a lower-cased word.
 */
function asWritten(word: string, source: string): string {
  const found = new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').exec(
    source,
  );
  return found?.[0] ?? word;
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
  /*
   * Evaluative words. "The best idea" and "my next project" are ways of referring to a thing, not
   * names for it, and a project called "Best" is worse than one called "New project".
   */
  'best',
  'better',
  'good',
  'great',
  'next',
  'last',
  'other',
  'same',
  'whole',
  'main',
  'real',
  'only',
  'original',
  'current',
  'previous',
  'idea',
  'yet',
]);

/**
 * A leading capital, without flattening one the owner already chose.
 *
 * `QuickPick` keeps its inner capital; `wrenchy` becomes `Wrenchy`. Upper-casing the first letter
 * of a word that already has capitals is safe; lower-casing the rest of it is not.
 */
const capitalise = (word: string): string =>
  word.length === 0 ? word : `${word[0]?.toUpperCase() ?? ''}${word.slice(1)}`;

const normalise = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[?!.,;:"`]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
