import { z } from 'zod';
import { extractProductName } from './product-name';

/**
 * Something Jarvis offered to do, kept so that "go ahead" has something to mean.
 *
 * ## Why this is a database row and not a field on the page
 *
 * Because the owner said "go ahead" and got sent to the Projects screen. The proposal used to live
 * in the browser tab that produced it, which made it a property of a *render* rather than of the
 * conversation: refresh the page, speak from a phone, come back after the worker restarted, and
 * the thing being agreed to had quietly ceased to exist. A proposal that can evaporate between
 * being offered and being accepted is not a proposal.
 *
 * ## Why the fingerprint is unique
 *
 * It is the whole of the duplicate-suppression story. The same idea described twice — a double
 * submit, a retried request, the owner saying it again because nothing appeared to happen — lands
 * on the same row rather than making a second one, and accepting that row twice returns the
 * project and mission it already created instead of creating more. Idempotency has to live at the
 * store, because every layer above it can be retried.
 */

export const PROPOSAL_STATES = ['open', 'accepted', 'superseded'] as const;
export type ProposalState = (typeof PROPOSAL_STATES)[number];

/** How the assessment was arrived at. Shown to the owner, never softened. */
export const EVALUATION_BASES = [
  /** A model reasoned about it from the description alone. No sources were consulted. */
  'reasoned',
  /** Nothing assessed the merits, because no model is configured here. */
  'not_assessed',
] as const;
export type EvaluationBasis = (typeof EVALUATION_BASES)[number];

export const ideaEvaluationSchema = z.object({
  /** Who would plausibly use it. */
  likelyUser: z.string().trim().max(600),
  /** The problem it solves, stated as a problem rather than as a feature. */
  problem: z.string().trim().max(600),
  /** Whether it looks worth building, and why — in that order. */
  verdict: z.string().trim().max(1200),
  /** The smallest thing that would be worth using. */
  smallestV1: z.array(z.string().trim().max(300)).max(12),
  /** What is being taken on trust. */
  assumptions: z.array(z.string().trim().max(300)).max(12),
  /** What genuinely is not known. */
  uncertainties: z.array(z.string().trim().max(300)).max(12),
  /** Only the questions whose answers would change the V1 above. */
  questions: z.array(z.string().trim().max(300)).max(8),
  basis: z.enum(EVALUATION_BASES),
});
export type IdeaEvaluation = z.infer<typeof ideaEvaluationSchema>;

/**
 * The sentence attached to every evaluation, verbatim and non-negotiable.
 *
 * Nothing in Jarvis searches the web, reads a competitor, or looks at a market. An assessment that
 * did not say so would be read as research, because that is what "is this worth building" usually
 * gets answered with. Saying it every time costs a line and keeps the answer honest.
 */
export const NO_RESEARCH_NOTICE =
  'This is reasoning about what you described, not market research — nothing external was consulted.';

/**
 * What older rows say, kept only so they still render.
 *
 * This was the fallback when the control plane held the model and no key was set. It is no longer
 * produced: judging an idea is a Claude turn on the owner's subscription, run by the worker, and
 * when that cannot happen the conversation names the actual condition — no worker, no runtime, no
 * capacity — rather than blaming a configuration that is not the problem.
 *
 * Rows written before that change still carry `basis: 'not_assessed'`, and the reasoning service
 * treats them as *unanswered* rather than as answers, so they are replaced the next time the idea
 * comes up instead of being shown for ever.
 */
export const NOT_ASSESSED_NOTICE =
  'Nothing has judged whether this is worth building yet. ' +
  'The questions below are the ones that would change the shape of a first version either way.';

export interface Proposal {
  readonly id: string;
  /** Stable over re-submissions of the same idea. See the note above. */
  readonly fingerprint: string;
  /** A short name for the thing — "QuickPick". */
  readonly title: string;
  /** What the owner actually said, kept verbatim. */
  readonly idea: string;
  /** One line describing what accepting this does. */
  readonly summary: string;
  readonly evaluation: IdeaEvaluation | null;
  readonly openQuestions: readonly string[];
  readonly recommendedV1: readonly string[];
  readonly assumptions: readonly string[];
  readonly state: ProposalState;
  /** Set once accepted, so accepting again returns rather than repeats. */
  readonly projectId: string | null;
  readonly missionId: string | null;
  readonly repositoryFullName: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly acceptedAt: string | null;
}

/**
 * What a mission created from an accepted proposal is actually for.
 *
 * ## Why this is not just the owner's sentence
 *
 * Because the sentence that opened the proposal was about *judging* the idea, and the mission that
 * comes out of accepting it is about *building* it. Those are different pieces of work, and reusing
 * the first as the objective of the second produced the failure this exists to fix: the owner said
 * "Re-evaluate my QuickPick idea … Do not build anything yet", said "Go ahead" once the assessment
 * came back, and got a mission whose stated request was the evaluation — which then asked him
 * whether he wanted it "researched and reported, or actually implemented".
 *
 * That question is `R-CL5`, and it fires when one text contains both a researching word and a
 * building word. The evaluation request contains "Re-evaluate" and "build" in the same breath, so
 * it always would. An objective written for the build says only what the build is.
 *
 * The owner's words are not discarded — they stay on the proposal row, verbatim, which is where
 * "what did I originally ask for?" is answered from.
 */
export interface ImplementationObjective {
  readonly title: string;
  readonly rawRequest: string;
  readonly description: string | null;
  readonly deliverable: string;
  /** The agreed V1, carried across as the definition of done. Empty when nothing judged it. */
  readonly acceptanceCriteria: readonly string[];
}

const cap = (text: string, limit: number): string =>
  text.length > limit ? `${text.slice(0, limit - 1).trimEnd()}…` : text;

/**
 * Turn an agreed proposal into the objective of the work it authorises.
 *
 * Deliberately deterministic. Nothing here asks a model what the owner meant: the name came from
 * the message, the scope came from the assessment he read before agreeing, and inventing a third
 * thing at the moment of commitment is how an approval stops meaning what it looked like.
 */
export function implementationObjective(proposal: Proposal): ImplementationObjective {
  const name = proposal.title.trim().length > 0 ? proposal.title.trim() : 'the idea';
  const scope = proposal.recommendedV1.filter((line) => line.trim().length > 0);

  const title = cap(`Build the first version of ${name}`, 160);

  /*
   * The scope is restated in the request itself rather than only in the description, because this
   * is the text the planner reads and the owner scans. When nothing assessed the idea there is no
   * agreed scope to restate, and saying so is better than implying one existed.
   */
  const rawRequest = cap(
    scope.length > 0
      ? `Build the first version of ${name}, limited to the scope agreed after assessment:\n${scope
          .map((line) => `- ${line}`)
          .join('\n')}`
      : `Build the first version of ${name}. No assessment recorded a scope for it, so the smallest useful version needs agreeing before the work is planned.`,
    4000,
  );

  const description =
    scope.length > 0
      ? cap(
          `Agreed with the owner after an assessment of ${name}. The scope above is the whole of what was agreed; anything beyond it is a separate decision.`,
          4000,
        )
      : null;

  return {
    title,
    rawRequest,
    description,
    deliverable: cap(`A working first version of ${name} in its repository.`, 600),
    /* Bounded to what a mission accepts: twenty criteria of four hundred characters. */
    acceptanceCriteria: scope.slice(0, 20).map((line) => cap(line, 400)),
  };
}

/**
 * A stable identity for an idea, from the words it was made of.
 *
 * Deliberately not a hash of the exact string: trailing punctuation and casing change constantly
 * between a typed and a spoken version of the same sentence, and two proposals for one idea is the
 * failure this exists to prevent. Word-normalised, then hashed.
 */
export function proposalFingerprint(idea: string): string {
  const normalised = idea
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return `idea-${hashed(normalised)}`;
}

/**
 * The identity an idea is stored under.
 *
 * ## Why a word fingerprint is not enough
 *
 * Because word-normalisation only survives punctuation and casing, and the owner does not repeat
 * himself verbatim. "Re-evaluate my QuickPick idea …" and "Can you look at QuickPick again — two
 * choices, one picked at random?" are one idea described twice, and a fingerprint over the words
 * makes them two rows. Two rows are two things "go ahead" could mean and, once both are accepted,
 * two missions against one project.
 *
 * So when the idea names a product, the *product* is the identity. Everything the owner has ever
 * said about QuickPick as an idea lands on the QuickPick row, and accepting it twice — in any
 * words, from any device, a day apart — accepts the same thing.
 *
 * When no product is named there is nothing better to key on and the word fingerprint stands, which
 * is exactly the behaviour that was there before.
 */
export function proposalSubjectKey(idea: string): string {
  const product = extractProductName(idea);
  return product ? `idea-of-${hashed(product.toLowerCase())}` : proposalFingerprint(idea);
}

/** FNV-1a over the given text. Stable across processes, which a runtime hash seed is not. */
function hashed(text: string): string {
  let hash = 0n;
  const prime = 1099511628211n;
  const mask = (1n << 64n) - 1n;
  for (const char of text) {
    hash = ((hash ^ BigInt(char.codePointAt(0) ?? 0)) * prime) & mask;
  }
  return hash.toString(36);
}
