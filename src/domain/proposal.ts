import { z } from 'zod';

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
  let hash = 0n;
  const prime = 1099511628211n;
  const mask = (1n << 64n) - 1n;
  for (const char of normalised) {
    hash = ((hash ^ BigInt(char.codePointAt(0) ?? 0)) * prime) & mask;
  }
  return `idea-${hash.toString(36)}`;
}
