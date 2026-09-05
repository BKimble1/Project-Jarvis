/**
 * Understanding a short reply, without asking a model.
 *
 * ## Why this is not a model's job
 *
 * "Do the first one" has to select the right thing every single time. A model that gets it right
 * ninety-nine times in a hundred is a model that will one day approve a plan the owner was
 * declining, and no amount of prompt care makes that acceptable for a phrase whose whole purpose
 * is to be typed without thinking. So the handful of phrases people actually use are recognised
 * deterministically, and everything else is treated as a new question and answered normally.
 *
 * ## Why it refuses rather than guesses
 *
 * `ambiguous` exists so that "the other one" against a list of four is a clarifying question
 * rather than a coin toss. The failure mode this avoids is the expensive one: a reply that half
 * matched, acted on the wrong row, and looked like it understood.
 *
 * ## The bias
 *
 * Declines are matched before confirmations, and a reply containing any negation is never read as
 * a confirmation. "Not tonight", "no, continue with the other one" and "don't" all stop. The cost
 * of hearing "no" as "yes" is unbounded; the cost of the reverse is being asked again.
 */

export type ReplyIntent =
  | { readonly kind: 'select'; readonly index: number; readonly rule: string }
  | { readonly kind: 'continue'; readonly rule: string }
  | { readonly kind: 'decline'; readonly rule: string }
  | { readonly kind: 'ambiguous'; readonly reason: string; readonly rule: string }
  | { readonly kind: 'question'; readonly rule: string };

/** Longer than this and it is prose, whatever words it happens to contain. */
const SHORT_REPLY_MAX_WORDS = 8;

/**
 * Words that can only be a position. `-1` means "the last one, whatever that is".
 */
const ORDINALS: Record<string, number> = {
  first: 0,
  '1st': 0,
  second: 1,
  '2nd': 1,
  third: 2,
  '3rd': 2,
  fourth: 3,
  '4th': 3,
  fifth: 4,
  '5th': 4,
  last: -1,
};

/**
 * Words that are *usually* a position and are sometimes just English.
 *
 * "The last one" contains both `last` and `one`, and reading them as two different selections made
 * a perfectly ordinary sentence ambiguous. So these count only when nothing stronger was said —
 * "number one" still selects, and "the first one" is unambiguously the first.
 */
const CARDINALS: Record<string, number> = {
  one: 0,
  two: 1,
  three: 2,
  four: 3,
  five: 4,
};

const DECLINE =
  /\b(no|nope|not|don'?t|never|later|tonight|tomorrow|skip|stop|cancel|leave it|nothing)\b/;
/**
 * "Carry on with what you were doing." Never a selection, whatever is on offer.
 *
 * Separate from the affirmations below because they mean different things. "Continue" is about the
 * work already in flight; "yes" is about the thing just proposed. Collapsing them would make
 * "continue" ambiguous whenever a list happened to be showing, which is most of the time.
 */
const CONTINUE = /\b(continue|carry on|carry on with it|keep going|go on|proceed|resume)\b/;

/** "Yes, that one." Meaningful only against something specific. */
const AFFIRM = /\b(yes|yep|yeah|please do|do it|do that|go ahead|sure|ok|okay|fine)\b/;

export function interpretReply(text: string, offered: number): ReplyIntent {
  const normalised = text
    .trim()
    .toLowerCase()
    .replace(/[.!?]+$/g, '');
  if (normalised.length === 0) return { kind: 'question', rule: 'RI-EMPTY' };

  const words = normalised.split(/\s+/);
  if (words.length > SHORT_REPLY_MAX_WORDS) return { kind: 'question', rule: 'RI-LONG' };

  /*
   * Declines first, and unconditionally. "No, not that one" contains an ordinal and a negation,
   * and reading it as a selection would act on something the person was ruling out.
   */
  if (DECLINE.test(normalised)) return { kind: 'decline', rule: 'RI-NO' };

  if (offered > 0) {
    const selected = selectIndex(normalised, words, offered);
    if (selected !== null) {
      return selected === 'ambiguous'
        ? {
            kind: 'ambiguous',
            reason: 'More than one of those could be meant.',
            rule: 'RI-AMBIGUOUS',
          }
        : { kind: 'select', index: selected, rule: 'RI-ORDINAL' };
    }
  }

  if (CONTINUE.test(normalised)) return { kind: 'continue', rule: 'RI-CONTINUE' };

  if (AFFIRM.test(normalised)) {
    /*
     * "Do it" against a list of several is not a selection, and pretending otherwise would pick
     * the top one on the person's behalf. It says which only when there is only one.
     */
    if (offered === 1) return { kind: 'select', index: 0, rule: 'RI-YES-ONE' };
    if (offered > 1) {
      return {
        kind: 'ambiguous',
        reason: 'There is more than one thing it could mean.',
        rule: 'RI-AMBIGUOUS',
      };
    }
    return { kind: 'continue', rule: 'RI-AFFIRM-NOTHING' };
  }

  return { kind: 'question', rule: 'RI-FALLTHROUGH' };
}

function selectIndex(
  normalised: string,
  words: readonly string[],
  offered: number,
): number | 'ambiguous' | null {
  const strong = new Set<number>();

  for (const word of words) {
    const ordinal = ORDINALS[word];
    if (ordinal === undefined) continue;
    strong.add(ordinal === -1 ? offered - 1 : ordinal);
  }

  /* A bare number, which is how most people answer a numbered list. */
  for (const digit of normalised.match(/\b([1-9])\b/g) ?? []) strong.add(Number(digit) - 1);

  const found = strong.size > 0 ? strong : cardinals(words);

  if (found.size === 0) return null;
  if (found.size > 1) return 'ambiguous';

  const [index] = [...found];
  if (index === undefined || index < 0 || index >= offered) return 'ambiguous';
  return index;
}

function cardinals(words: readonly string[]): Set<number> {
  const found = new Set<number>();
  for (const word of words) {
    const value = CARDINALS[word];
    if (value !== undefined) found.add(value);
  }
  return found;
}
