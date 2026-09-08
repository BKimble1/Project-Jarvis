/**
 * The name the owner already gave the thing.
 *
 * ## Why this exists
 *
 * Because Jarvis created a project called "Yet".
 *
 * The message was "Re-evaluate my QuickPick idea using Claude: two choices, one randomly selected
 * with a clean animation. Give your assessment and the smallest useful V1. Do not build anything
 * yet." The product is named twice over — once as `QuickPick`, once as "my … idea" — and the
 * project that came out of it was named after the last word of the sentence forbidding the build.
 *
 * `deriveProjectName` infers a name from the shape of a request: "build me a rent tracker app"
 * gives "Rent Tracker". That inference is right for a sentence that describes a thing without
 * naming it, and it is beside the point for a sentence that names it outright. This module is the
 * outright case, and it runs first, because a name the owner wrote is not a thing to be guessed at.
 *
 * ## Why the rules are narrow
 *
 * The cost of a false positive here is somebody's GitHub account acquiring a repository named
 * after a word in a sentence — which is precisely the failure being fixed, so a fix that could
 * cause it differently is not a fix. Every rule below therefore requires a positive signal that
 * the token is a name, and the answer is `null` whenever there is not one. `null` is a good
 * answer: it means "fall back to inference", which is the behaviour that was already there.
 */

/**
 * Words that are capitalised in ordinary prose and are never the name of the owner's product.
 *
 * Tools and vendors are on it because "using Claude" and "push it to GitHub" are how the owner
 * talks about the machinery, not about the thing being made. Naming a project after the assistant
 * that was asked to assess it would be a more embarrassing version of the same bug.
 */
const NOT_A_PRODUCT = new Set([
  /* The machinery. */
  'claude',
  'jarvis',
  'anthropic',
  'openai',
  'chatgpt',
  'gpt',
  'copilot',
  'github',
  'gitlab',
  'git',
  'google',
  'apple',
  'microsoft',
  'slack',
  'notion',
  'linear',
  'figma',
  'netlify',
  'vercel',
  'supabase',
  'postgres',
  'postgresql',
  'sqlite',
  'docker',
  'node',
  'nodejs',
  'next',
  'nextjs',
  'react',
  'typescript',
  'javascript',
  'python',
  'tailwind',
  'playwright',
  'vitest',
  'macos',
  'windows',
  'linux',
  'ubuntu',
  'wsl',
  'ios',
  'android',
  'chrome',
  'safari',
  'firefox',
  /* Version and size markers. The brief's own sentence contains "V1". */
  'v1',
  'v2',
  'v3',
  'mvp',
  'poc',
  'beta',
  'alpha',
  /* Days and months, which start sentences about scheduling. */
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
  'today',
  'tomorrow',
  'tonight',
  'yesterday',
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
  /* Pronouns and openers that are capitalised by position rather than by nature. */
  'i',
  'it',
  'this',
  'that',
  'the',
  'a',
  'an',
  'my',
  'we',
  'you',
  'please',
  'ok',
  'okay',
  'yes',
  'no',
  'go',
  'give',
  'build',
  'make',
  'create',
  'start',
  'do',
  'don',
  'let',
  'can',
  'could',
  'would',
  'should',
  'what',
  'when',
  'where',
  'why',
  'how',
  'and',
  'but',
  'so',
  'then',
  'also',
  'first',
  'next',
  'now',
  're',
]);

/**
 * A token carrying a capital letter after a lower-case one: `QuickPick`, `CoreCredit`, `iPhone`.
 *
 * This is the strongest signal available in plain text, because English does not produce it by
 * accident. Sentence position is irrelevant to it — `QuickPick` is a name whether it opens the
 * sentence or not — which is what makes it worth testing before anything positional.
 */
const INTERNAL_CAPITAL = /[a-z][A-Z]/;

/**
 * Frames that introduce a name: "my QuickPick idea", "the Holograph app", "QuickPick's".
 *
 * Used only for tokens that are merely capitalised, where position alone would be far too weak.
 * The noun after the name is what makes the frame a frame — "my QuickPick idea" names a thing;
 * "my Tuesday" does not.
 */
const REFERRING_NOUNS =
  '(?:idea|app|application|project|tool|site|website|service|prototype|thing|product|game|bot|script|dashboard|extension|plugin|repo|repository)';

const FRAMES: readonly RegExp[] = [
  /*
   * "my QuickPick idea", "the Holograph app", "a Holograph audit tool" — determiner, name, then
   * the noun that makes it a frame. Up to two lower-case words may sit between the name and the
   * noun ("audit tool"), because a describing word before the noun is ordinary English. They must
   * be lower-case: that is what stops the window from sliding onto a second capitalised token.
   */
  new RegExp(
    `\\b(?:my|the|our|that|this|an?)\\s+([A-Za-z][A-Za-z0-9]{1,40})\\s+(?:[a-z][a-z0-9-]*\\s+){0,2}${REFERRING_NOUNS}\\b`,
  ),
  /* "QuickPick's animation" — a possessive is a name being spoken about. */
  /\b([A-Z][A-Za-z0-9]{1,40})'s\b/,
  /* "the app QuickPick", "a project called Holograph" is handled by new-project's NAMED rule. */
  new RegExp(
    `\\b${REFERRING_NOUNS}\\s+(?:is\\s+)?(?:called\\s+|named\\s+)([A-Z][A-Za-z0-9]{1,40})\\b`,
  ),
];

/** Rejects tokens that cannot be a product name whatever frame they appeared in. */
function plausible(token: string): boolean {
  if (token.length < 2 || token.length > 40) return false;
  if (NOT_A_PRODUCT.has(token.toLowerCase())) return false;
  /* Pure numbers, and version markers of the "v1"/"V2" shape, are never names. */
  if (/^[0-9]+$/.test(token)) return false;
  if (/^v[0-9]+$/i.test(token)) return false;
  /* Must contain a letter. */
  return /[A-Za-z]/.test(token);
}

/**
 * The product name the owner wrote, or null when they did not write one.
 *
 * Returns the token exactly as it was written — `QuickPick`, not `Quickpick`. Casing is part of a
 * name, and title-casing a lower-cased copy is how an app quietly gets renamed.
 */
export function extractProductName(raw: string): string | null {
  const text = raw.trim();
  if (text.length === 0) return null;

  /*
   * Rule 1: an internal capital. Scanned across the whole message because a name is a name
   * wherever it sits, and no other rule is as reliable as this one.
   */
  for (const token of text.match(/\b[A-Za-z][A-Za-z0-9]{1,40}\b/g) ?? []) {
    if (INTERNAL_CAPITAL.test(token) && plausible(token)) return token;
  }

  /*
   * Rule 2: a capitalised token inside a frame that introduces a name. Weaker, so it demands both
   * the capital and the frame — "my QuickPick idea" qualifies, "my Tuesday plan" does not, and a
   * lower-cased "my rent tracker idea" is left to `deriveProjectName` to infer as it always did.
   */
  for (const frame of FRAMES) {
    const token = frame.exec(text)?.[1];
    if (token && /^[A-Z]/.test(token) && plausible(token)) return token;
  }

  return null;
}
