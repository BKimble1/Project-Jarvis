import { MAX_PROPOSAL_ANSWERS, type IdeaEvaluation, type Proposal } from './proposal';

/**
 * What "go ahead" actually asks for.
 *
 * ## The failure this exists to stop
 *
 * The owner wrote: "Re-evaluate my QuickPick idea using Claude: two choices, one randomly selected
 * with a clean animation. Give your assessment and the smallest useful V1. Do not build anything
 * yet." He got a real assessment, said "Go ahead", and Jarvis created a project called *Yet*, a
 * private repository called `yet`, and a mission whose request was that same sentence — which then
 * asked him whether he wanted it researched or implemented, because the sentence says both
 * "evaluate" and "build".
 *
 * Every part of that came from one mistake: the conversational message was used as the objective.
 * A message is a thing somebody said at a moment. An objective is a standing instruction that
 * outlives the conversation, gets handed to an agent hours later, and has to still mean the same
 * thing. They are not the same artefact and this module is the difference between them.
 *
 * ## Why the wording is composed rather than quoted
 *
 * Because the message that produced a proposal is full of things that are true of the *request*
 * and false of the *work*: "re-evaluate", "give your assessment", "do not build anything yet". Fed
 * to a builder those are at best noise and at worst contradictory orders. What survives is what
 * describes the product — its name, the smallest version worth having, and what it is for.
 *
 * ## Why the verbs are chosen carefully
 *
 * "Research", "investigate", "evaluate" and "compare" are how Jarvis decides a request is ambiguous
 * about mode. An objective built here is not ambiguous — the owner already decided, by saying go
 * ahead to a build proposal — so the objective must not contain the words that say otherwise. That
 * is belt; the braces are the acceptance criteria, which settle the question on their own.
 */

export interface BuildBrief {
  /** The product's name. Used for the project, the repository slug and the mission title. */
  readonly name: string;
  /** The standing instruction handed to the mission. Never the conversational message. */
  readonly objective: string;
  /** One sentence for the project's goal. */
  readonly goal: string;
  /** What the first version has to do. The definition of done, not a wish list. */
  readonly acceptanceCriteria: readonly string[];
  /** The description column: context an agent benefits from, kept apart from the instruction. */
  readonly description: string | null;
  /**
   * What Blake decided, carried through to the mission as constraints.
   *
   * ## Why these are not folded into the acceptance criteria
   *
   * Because they are different kinds of statement and a builder needs both. An acceptance criterion
   * says what the thing must *do* — "shows a weekly total". A constraint says what it must *not* do
   * or must assume — "treat entered income as after-tax, so no tax feature in V1", "do not track
   * rollover separately". Fold the second into the first and a builder reads "no tax feature" as a
   * feature to build.
   *
   * They are also the answers to questions I asked, which makes them the most expensive thing in
   * the exchange: Blake spent a turn on each. Losing them at the moment the mission is written is
   * exactly the "it forgot what we agreed" failure, arriving one step later than last time.
   */
  readonly constraints: readonly string[];
  /**
   * Whether a model actually judged this.
   *
   * False means the owner said go ahead before an assessment arrived, which is allowed — it just
   * means the smallest V1 is not known yet, and the objective says so rather than inventing one.
   */
  readonly assessed: boolean;
}

/** The most acceptance criteria a brief carries. Beyond this it is a specification, not a V1. */
const MAX_CRITERIA = 10;

/**
 * The most decisions a brief carries into a mission.
 *
 * Must not be lower than the number a proposal will *store* — `MAX_PROPOSAL_ANSWERS`. It was (12
 * against 20), which meant a long enough conversation could record decisions that were silently
 * never handed to the builder: recorded, visible on the proposal, and absent from the work. That is
 * "it forgot what we agreed" again, one layer deeper and harder to see than the last two times.
 *
 * Tied to the same constant so the two cannot drift apart again.
 */
const MAX_CONSTRAINTS = MAX_PROPOSAL_ANSWERS;

/** How every composed objective starts. Named once, so the repair path can recognise its own work. */
const OBJECTIVE_OPENING = 'Build the first working version of';

/**
 * Turn an agreed proposal into something buildable.
 *
 * Reads only the structured parts — the name, the evaluation, the recommended V1 — and never the
 * raw message. `idea` is still kept on the proposal, verbatim, because an audit needs to be able to
 * say what the owner actually typed. It is simply not what gets built.
 */
export function buildBrief(proposal: Proposal): BuildBrief {
  const name = proposal.title.trim() || 'New project';
  const criteria = acceptanceCriteriaFor(proposal);
  const evaluation = proposal.evaluation?.basis === 'reasoned' ? proposal.evaluation : null;

  const constraints = constraintsFor(proposal);

  return {
    name,
    objective: objectiveFor(name, criteria, evaluation, constraints),
    goal: goalFor(name, evaluation),
    acceptanceCriteria: criteria,
    description: descriptionFor(name, evaluation),
    constraints,
    assessed: evaluation !== null,
  };
}

/**
 * The decisions Blake made, bounded and de-duplicated.
 *
 * Verbatim. A constraint that has been paraphrased is a different constraint, and the whole value
 * of these is that they are the words he chose when he settled the scope.
 */
function constraintsFor(proposal: Proposal): readonly string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const answer of proposal.answers) {
    const trimmed = answer.trim();
    const key = trimmed.toLowerCase();
    if (trimmed.length === 0 || seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
    if (out.length === MAX_CONSTRAINTS) break;
  }
  return out;
}

/**
 * The definition of done.
 *
 * The assessment's smallest V1 when there is one, because that is the list the owner agreed to when
 * he said go ahead. `recommendedV1` is the same list on the proposal row, written there when the
 * assessment landed, so either source is the owner's agreed scope rather than a guess.
 */
function acceptanceCriteriaFor(proposal: Proposal): readonly string[] {
  const fromEvaluation =
    proposal.evaluation?.basis === 'reasoned' ? proposal.evaluation.smallestV1 : [];
  const source = fromEvaluation.length > 0 ? fromEvaluation : proposal.recommendedV1;
  const seen = new Set<string>();
  const criteria: string[] = [];
  for (const item of source) {
    const trimmed = item.trim();
    const key = trimmed.toLowerCase();
    if (trimmed.length === 0 || seen.has(key)) continue;
    seen.add(key);
    criteria.push(trimmed);
    if (criteria.length === MAX_CRITERIA) break;
  }
  return criteria;
}

/**
 * The instruction itself.
 *
 * Imperative, named, and specific about what to produce. When there is no assessed V1 it says that
 * plainly and asks for the smallest working version rather than pretending to a scope nobody
 * agreed — an honest instruction to build something small beats a confident instruction to build
 * the wrong thing.
 */
function objectiveFor(
  name: string,
  criteria: readonly string[],
  evaluation: IdeaEvaluation | null,
  constraints: readonly string[],
): string {
  const lines = [`${OBJECTIVE_OPENING} ${name}.`];

  if (evaluation?.problem) {
    lines.push('', `What it is for: ${evaluation.problem.trim()}`);
  }

  if (criteria.length > 0) {
    lines.push('', 'The first version must do all of the following:');
    for (const item of criteria) lines.push(`- ${item}`);
  } else {
    lines.push(
      '',
      'No assessed scope was agreed, so keep the first version as small as it can be while still',
      'being worth using, and say in the plan what you decided to leave out.',
    );
  }

  if (constraints.length > 0) {
    /*
     * Placed after the criteria and labelled as decisions, so a builder reads "no tax feature in
     * V1" as a boundary rather than as something to build. Quoted rather than summarised: these
     * are the owner's words, and paraphrasing a constraint is how it stops binding.
     */
    lines.push('', 'The owner has already decided these, and they override anything above:');
    for (const item of constraints) lines.push(`- ${item}`);
  }

  lines.push(
    '',
    'This is an implementation, not a report: produce working code in the repository. Anything',
    `beyond the list above is out of scope for this version — raise it rather than building it.`,
  );

  return lines.join('\n');
}

/** One line for the project's goal column. Short, because it is shown next to the project's name. */
function goalFor(name: string, evaluation: IdeaEvaluation | null): string {
  const verdict = evaluation?.verdict.trim();
  if (!verdict) return `${OBJECTIVE_OPENING} ${name}.`;
  const firstSentence = verdict.split(/(?<=[.!?])\s+/)[0]?.trim() ?? verdict;
  return `${OBJECTIVE_OPENING} ${name}. ${firstSentence}`.slice(0, 600).trim();
}

/**
 * The context column.
 *
 * Who it is for and what is being assumed — useful to whoever builds it, and deliberately separate
 * from the objective so that reading the instruction never means reading around the background.
 */
function descriptionFor(name: string, evaluation: IdeaEvaluation | null): string | null {
  if (!evaluation) return null;
  const parts = [`${name}, as assessed by Claude on the owner's subscription.`];
  if (evaluation.likelyUser.trim()) parts.push(`Likely user: ${evaluation.likelyUser.trim()}`);
  if (evaluation.assumptions.length > 0) {
    parts.push(`Assumptions: ${evaluation.assumptions.join('; ')}`);
  }
  if (evaluation.uncertainties.length > 0) {
    parts.push(`Not known: ${evaluation.uncertainties.join('; ')}`);
  }
  return parts.join('\n\n').slice(0, 4000);
}

/**
 * Does this mission's request read like something somebody said, rather than an instruction?
 *
 * The tell is the vocabulary of a conversation: asking for an assessment, forbidding a build,
 * addressing Jarvis directly. A mission written from a brief opens with "Build the first working
 * version of" and is never a replay, so it is excluded first and cheaply.
 *
 * Used by the repair path to decide which missions are safe to retitle. A mission that already
 * reads as an instruction is left exactly as it is: rewriting one that is fine is churn, and
 * rewriting one that has run makes its own history unreadable.
 */
export function readsLikeAConversation(rawRequest: string): boolean {
  if (rawRequest.startsWith(OBJECTIVE_OPENING)) return false;
  return /\b(?:re-?evaluate|assess\w*|do not build|don'?t build|give (?:me )?your|what do you think)\b/i.test(
    rawRequest,
  );
}
