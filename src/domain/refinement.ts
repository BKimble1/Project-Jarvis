import type { Proposal } from './proposal';

/**
 * Turning "here are my answers" into a settled scope.
 *
 * ## The exchange this serves
 *
 * I describe an idea back to Blake with a few open questions. He answers them — in one message, as
 * statements, in the order they occurred to him:
 *
 *     "Use US dollars. Look ahead until my next known income date, with six weeks as the fallback.
 *      Treat entered income as after-tax, so no tax feature in V1. An override lasts only for the
 *      current week. Do not track rollover separately; recalculate from the current balance each
 *      week. I will re-enter my bank balance weekly, so remove expense tracking. Lock this as the
 *      final V1, but do not build it yet."
 *
 * Seven sentences. Six are decisions about the product. One — the last — is an instruction about
 * *the proposal*: settle it, and do not build it. Storing that last one as a decision would put
 * "do not build it yet" into the constraints handed to whoever eventually builds it, which is the
 * "Yet" bug wearing a different hat: an instruction about the conversation mistaken for a fact
 * about the product.
 *
 * So the meta sentences are separated out rather than dropped silently, and what remains is stored
 * verbatim. Verbatim matters: a decision that has been paraphrased is a different decision, and the
 * whole value of these is that they are the words he chose.
 */

/**
 * A sentence that talks about the proposal rather than about the thing being proposed.
 *
 * Deliberately narrow. The cost of failing to recognise one is a slightly noisy constraint list;
 * the cost of over-matching is a decision quietly discarded, which is the failure this whole change
 * exists to end. When in doubt, keep it.
 */
const ABOUT_THE_PROPOSAL =
  /^(?:(?:and|but|so|then|also|ok(?:ay)?|please)\s+)*(?:lock|final(?:i[sz]e|ise|ize)|confirm|agree|settle|refine|revise|update)\b[^.!?]*$|^(?:(?:and|but|so|then)\s+)*(?:do\s?n(?:o|')t|dont|don\s?t|no need to|hold off|not yet|never)\b[^.!?]*\b(?:build|make|start|create|implement|ship|deploy)\w*\b[^.!?]*$/i;

/** Words that mean he is settling the scope rather than merely adding to it. */
const LOCKS_SCOPE = /\b(?:lock|final(?:i[sz]e|ise|ize)|that'?s (?:it|the) final|settled|agreed)\b/i;

/**
 * A trailing clause about the proposal, hanging off the end of a sentence.
 *
 * ## Why sentence-splitting is not enough
 *
 * Because speech has no full stops. Dictated, the same message arrives as one long clause:
 *
 *     "…treat entered income as after tax so no tax feature in v1 lock this as the final v1 but do
 *      not build it yet"
 *
 * One sentence, so `ABOUT_THE_PROPOSAL` — which is anchored `^…$` — matches nothing, and the whole
 * thing is stored as a single decision. "Do not build it yet" then travels into the constraints
 * handed to whoever builds it. That is the "Yet" bug for the third time: an instruction about the
 * conversation preserved as a fact about the product, because the thing that was meant to separate
 * them only worked on text that had been typed.
 *
 * So the tail is stripped as well as classified. Applied to every answer, punctuated or not.
 */
const TRAILING_META =
  /(?:[,;]?\s*(?:and|but|so|then|also)\s+)?(?:please\s+)?(?:lock|final(?:i[sz]e|ise|ize)|confirm|settle)\b.*$|(?:[,;]?\s*(?:and|but|so|then)\s+)?(?:do\s?n(?:o|')t|dont|don\s?t|no need to|hold off|not yet|never)\b[^.!?]*\b(?:build|make|start|creat|implement|ship|deploy)\w*\b.*$/i;

/**
 * Remove a trailing instruction about the proposal from a decision about the product.
 *
 * Returns the decision and, separately, whatever was taken off — so nothing disappears without
 * being accounted for. An empty decision means the sentence was *only* about the proposal.
 */
function splitTrailingMeta(sentence: string): { decision: string; meta: string | null } {
  const match = TRAILING_META.exec(sentence);
  if (!match || match.index === 0) {
    return match ? { decision: '', meta: sentence } : { decision: sentence, meta: null };
  }
  const decision = sentence
    .slice(0, match.index)
    .replace(/[\s,;]+$/, '')
    .trim();
  const meta = sentence.slice(match.index).trim();
  return decision.length > 0 ? { decision, meta } : { decision: '', meta: sentence };
}

export interface Refinement {
  /** The decisions, verbatim, in the order he said them. */
  readonly answers: readonly string[];
  /** Sentences that were about the proposal itself. Kept so nothing is discarded invisibly. */
  readonly aboutTheProposal: readonly string[];
  /** True when he said this is the final scope, not merely another decision. */
  readonly locksScope: boolean;
}

/**
 * Read a refining message.
 *
 * Split on sentence endings only — never on a semicolon. "Do not track rollover separately;
 * recalculate from the current balance each week" is one decision expressed in two clauses, and
 * splitting it would store half a rule twice and lose the connection between them.
 */
export function readRefinement(raw: string): Refinement {
  const sentences = raw
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.replace(/[^a-z0-9]/gi, '').length > 0);

  const answers: string[] = [];
  const aboutTheProposal: string[] = [];

  for (const sentence of sentences) {
    const bare = sentence.replace(/[.!?]+$/, '');
    if (ABOUT_THE_PROPOSAL.test(bare)) {
      aboutTheProposal.push(sentence);
      continue;
    }
    /*
     * Typed, this is usually a no-op — the meta sentence was its own sentence and was caught above.
     * Dictated, it is the whole defence: one unpunctuated clause carrying six decisions and an
     * instruction not to build, which must not be stored as a seventh decision.
     *
     * Split on the sentence as written rather than on the stripped copy, so a decision keeps the
     * punctuation Blake typed. These are stored verbatim and handed to a builder verbatim; trimming
     * a full stop off them is a small enough infidelity to be worth not introducing.
     */
    const { decision, meta } = splitTrailingMeta(sentence);
    if (meta) aboutTheProposal.push(meta);
    if (decision.length > 0) answers.push(decision);
  }

  return {
    answers,
    aboutTheProposal,
    locksScope: LOCKS_SCOPE.test(raw),
  };
}

/**
 * The first version as it now stands, with his decisions applied.
 *
 * ## Why this is composed rather than re-reasoned
 *
 * Because asking the model again would cost a subscription turn and a minute of his time to restate
 * a list he has just constrained, and because the assessed V1 is not in question — what changed is
 * the boundary around it. The honest answer to "what is the V1 now?" is the list I proposed,
 * followed by what he decided about it, both quoted rather than merged.
 *
 * Merging them would be worse than it sounds. "No tax feature in V1" is not an item to add to a
 * list of features; it is a line drawn around the list. Presenting the two as one set is how a
 * boundary becomes a task.
 */
export interface FinalisedV1 {
  readonly items: readonly string[];
  readonly decisions: readonly string[];
  readonly locked: boolean;
  /** One line, safe to read aloud. */
  readonly sentence: string;
}

export function finalisedV1(proposal: Proposal): FinalisedV1 {
  const assessed =
    proposal.evaluation?.basis === 'reasoned' && proposal.evaluation.smallestV1.length > 0
      ? proposal.evaluation.smallestV1
      : proposal.recommendedV1;

  const items = [...assessed];
  const decisions = [...proposal.answers];
  const locked = proposal.scopeLockedAt !== null;

  const scope =
    items.length > 0
      ? `${items.length} thing${items.length === 1 ? '' : 's'} in the first version`
      : 'no assessed scope yet';
  const decided =
    decisions.length > 0
      ? `, and ${decisions.length} decision${decisions.length === 1 ? '' : 's'} of yours around it`
      : '';

  return {
    items,
    decisions,
    locked,
    sentence: locked
      ? `${proposal.title} is settled: ${scope}${decided}. Say go ahead when you want it built.`
      : `${proposal.title} now has ${scope}${decided}. Say go ahead when you want it built.`,
  };
}
