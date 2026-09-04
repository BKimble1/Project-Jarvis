import { createHash } from 'node:crypto';
import type { CapabilityClass } from './charter';
import type { ProvenanceLevel } from './enums';
import type { AttentionReason, ProjectAssessment, RecommendedAction } from './status';

/**
 * What Jarvis could usefully do next, and in what order.
 *
 * This is the middle of the operating loop — observe, *understand*, *prioritise*, plan — and it is
 * a pure module with no model in it, for the same reason `authorization.ts` is: an operator that
 * decides its own priorities by asking a model to rank a list is an operator whose priorities
 * cannot be explained, reproduced, or argued with afterwards.
 *
 * Three properties are load-bearing.
 *
 * **An opportunity is derived, never invented.** Every one carries the deterministic rule that
 * produced it and the evidence ids behind that rule. There is deliberately no constructor that
 * takes a free-text description with no rule attached, because "keep the agents busy" is the
 * failure mode of an autonomous system and inventing work is how it starts.
 *
 * **A silent system is unknown, not healthy.** A project whose sources have not reported produces
 * no opportunities *and* is reported as unobserved. Treating "we saw nothing" as "nothing is
 * wrong" is the single most expensive mistake an unattended operator can make, and it is a very
 * easy one to make by accident.
 *
 * **The score orders; it does not measure.** `prioritise` returns an integer and a band, and the
 * integer exists only to sort. It is not a probability, an expected value, or a confidence. Every
 * point it carries is attributed to a named factor so that "why is this first?" has an answer made
 * of sentences rather than of arithmetic nobody can check.
 */

/* ------------------------------------------------------------- observation */

export const OBSERVATION_STATES = [
  /** A configured source reported, recently enough to act on. */
  'observed',
  /** A configured source reported, but long enough ago that it may be out of date. */
  'stale',
  /** A configured source failed. Jarvis knows it does not know. */
  'failed',
  /** Nothing is configured to watch this at all. */
  'unwatched',
] as const;
export type ObservationState = (typeof OBSERVATION_STATES)[number];

export const OBSERVATION_STATE_MEANING: Record<ObservationState, string> = {
  observed: 'Jarvis has current information about this.',
  stale: 'Jarvis has information about this, but it is old enough to be wrong.',
  failed: 'Jarvis tried to look and could not.',
  unwatched: 'Nothing is connected that would tell Jarvis about this.',
};

/**
 * What Jarvis actually managed to see, per project.
 *
 * Carried alongside the opportunities rather than folded into them, because the two answer
 * different questions and only one of them is ever "nothing to do".
 */
export interface ObservationCoverage {
  readonly projectId: string;
  readonly projectName: string;
  readonly state: ObservationState;
  readonly observedAt: string | null;
  readonly detail: string;
}

/** Whether opportunities derived from this coverage may be acted on unattended. */
export function coverageIsActionable(coverage: ObservationCoverage): boolean {
  return coverage.state === 'observed';
}

/* ------------------------------------------------------------ opportunities */

export const OPPORTUNITY_SOURCES = [
  /** Derived from an `AttentionReason` the status engine produced. */
  'attention',
  /** Derived from a `RecommendedAction` the status engine produced. */
  'recommendation',
  /** Derived from a mission's own state — stalled, failed with retries left, waiting. */
  'mission',
] as const;
export type OpportunitySource = (typeof OPPORTUNITY_SOURCES)[number];

export const OPPORTUNITY_STATES = [
  /** Seen, not yet acted on. */
  'open',
  /** A mission exists for it. */
  'taken',
  /** Its underlying reason has gone. Nothing was done; it stopped being true. */
  'resolved',
  /** The owner said no. It never comes back on its own. */
  'dismissed',
  /** Jarvis decided against it. It may return if the evidence changes. */
  'declined',
] as const;
export type OpportunityState = (typeof OPPORTUNITY_STATES)[number];

export interface Opportunity {
  /**
   * A deterministic identity, so the same situation seen twice is one opportunity.
   *
   * Derived from what the opportunity is *about* — the project, the rule, the subject — and never
   * from when it was noticed or how it was worded. Two ticks an hour apart looking at the same
   * failing workflow must produce the same key, or the backlog fills with duplicates and the
   * operator works the same problem repeatedly.
   */
  readonly key: string;
  readonly projectId: string | null;
  readonly source: OpportunitySource;
  /** The deterministic rule that produced it. Every opportunity has one; there is no other path. */
  readonly rule: string;
  readonly title: string;
  readonly detail: string;
  readonly severity: 'critical' | 'high' | 'medium' | 'low';
  readonly provenance: ProvenanceLevel;
  readonly evidenceIds: readonly string[];
  /**
   * What acting on this would require the charter to grant.
   *
   * Empty means looking and reporting, which needs no capability of its own. This is a *claim
   * about the work*, not an authorisation — `authorize` still decides, and it decides against the
   * charter rather than against this list.
   */
  readonly capabilities: readonly CapabilityClass[];
  /** True when only a person can settle it. Jarvis surfaces these and does not act on them. */
  readonly requiresOwner: boolean;
  readonly observedAt: string;
}

/**
 * The dedup identity.
 *
 * Hashed rather than concatenated so the key has a fixed shape whatever the subject contains, and
 * length-prefixed so that `("ab", "c")` and `("a", "bc")` cannot collide — the same reason
 * `canonicalAuditForm` does it.
 */
export function opportunityKey(input: {
  readonly projectId: string | null;
  readonly rule: string;
  readonly subject: string;
}): string {
  const parts = [input.projectId ?? '-', input.rule, input.subject];
  return createHash('sha256')
    .update(parts.map((part) => `${part.length}:${part}`).join('|'))
    .digest('hex')
    .slice(0, 32);
}

/* ------------------------------------------------------------- derivation */

/**
 * Which capabilities a rule's work would need.
 *
 * A lookup rather than a guess, and the default is the empty list — an unrecognised rule produces
 * an opportunity that can be *looked at* and nothing more. That is the safe direction to be wrong
 * in: a new rule added later is under-permissioned until somebody decides what it should reach,
 * rather than silently inheriting the ability to write.
 */
const RULE_CAPABILITIES: Readonly<Record<string, readonly CapabilityClass[]>> = {
  active_blocker: ['bug.diagnose'],
  failed_workflow: ['bug.diagnose', 'checks.repair'],
  failed_sync: ['repository.audit'],
  stale_data: [],
  overdue_action: ['project.status.update'],
  overdue_target_date: ['project.status.update'],
  archived_repository: [],
  decision_required: [],
};

/**
 * Opportunities from one project's assessment.
 *
 * The assessment is the status engine's deterministic verdict, so everything here is a
 * transformation of something already explainable rather than a new judgement. A reason that
 * requires the owner becomes an opportunity marked `requiresOwner` rather than being dropped —
 * the owner still needs to see it, and the loop still must not act on it.
 */
export function opportunitiesFromAssessment(
  assessment: ProjectAssessment,
  now: Date,
): readonly Opportunity[] {
  const observedAt = now.toISOString();
  const fromAttention = assessment.attention.map((reason: AttentionReason) => ({
    key: opportunityKey({
      projectId: assessment.projectId,
      rule: reason.rule,
      subject: subjectOf(reason.evidenceIds, reason.code),
    }),
    projectId: assessment.projectId,
    source: 'attention' as const,
    rule: reason.rule,
    title: reason.summary,
    detail: reason.summary,
    severity: reason.severity,
    provenance: reason.provenance,
    evidenceIds: reason.evidenceIds,
    capabilities: RULE_CAPABILITIES[reason.code] ?? [],
    requiresOwner: reason.code === 'decision_required',
    observedAt,
  }));

  const fromActions = assessment.recommendedActions.map((action: RecommendedAction) => ({
    key: opportunityKey({
      projectId: assessment.projectId,
      rule: action.rule,
      subject: subjectOf(action.evidenceIds, action.action),
    }),
    projectId: assessment.projectId,
    source: 'recommendation' as const,
    rule: action.rule,
    title: action.action,
    detail: action.rationale,
    severity: 'medium' as const,
    provenance: action.provenance,
    evidenceIds: action.evidenceIds,
    capabilities: RULE_CAPABILITIES[action.rule] ?? [],
    requiresOwner: action.requiresOwner,
    observedAt,
  }));

  return dedupe([...fromAttention, ...fromActions]);
}

/**
 * The subject an opportunity is about.
 *
 * Evidence ids when there are any, because they name the actual failing workflow or open blocker
 * and are stable across ticks. The rule's own code otherwise, which collapses every instance of a
 * general condition into one opportunity — correct, because "this project's data is stale" is one
 * situation however many ways it manifests.
 */
function subjectOf(evidenceIds: readonly string[], fallback: string): string {
  return evidenceIds.length > 0 ? [...evidenceIds].sort().join(',') : fallback;
}

/** First occurrence wins, so the earlier-derived reason keeps its severity and wording. */
export function dedupe(candidates: readonly Opportunity[]): readonly Opportunity[] {
  const seen = new Set<string>();
  const kept: Opportunity[] = [];
  for (const candidate of candidates) {
    if (seen.has(candidate.key)) continue;
    seen.add(candidate.key);
    kept.push(candidate);
  }
  return kept;
}

/** Candidates that are not already in the backlog under any state. */
export function novel(
  candidates: readonly Opportunity[],
  known: ReadonlySet<string>,
): readonly Opportunity[] {
  return dedupe(candidates).filter((candidate) => !known.has(candidate.key));
}

/* ------------------------------------------------------------ prioritising */

export const PRIORITY_BANDS = [
  /** Work on it now. */
  'now',
  /** Work on it once the `now` band is empty. */
  'next',
  /** Real, but it can wait. */
  'later',
  /** Recorded and deliberately not worked on. Never becomes a mission on its own. */
  'watch',
] as const;
export type PriorityBand = (typeof PRIORITY_BANDS)[number];

export const PRIORITY_BAND_MEANING: Record<PriorityBand, string> = {
  now: 'Jarvis will pick this up next.',
  next: 'Queued behind the urgent work.',
  later: 'Real, but not worth interrupting anything for.',
  watch: 'Recorded so you can see it. Jarvis will not act on this by itself.',
};

export interface PriorityFactor {
  readonly name: string;
  readonly points: number;
  /** Why those points, in a sentence a person can disagree with. */
  readonly why: string;
}

export interface Priority {
  readonly band: PriorityBand;
  /**
   * An ordering device with no units.
   *
   * It is not a probability, an expected value, a confidence, or money. Showing it as a percentage
   * or a currency would be exactly the invented precision this module exists to avoid; showing the
   * factors instead gives a person something they can actually check.
   */
  readonly score: number;
  readonly factors: readonly PriorityFactor[];
}

export interface PriorityContext {
  /** Projects the charter names. An opportunity outside them is real but not the operator's job. */
  readonly chartedProjectIds: ReadonlySet<string>;
  /** Projects a charter goal points at, which is a stronger signal than merely being in scope. */
  readonly goalProjectIds: ReadonlySet<string>;
  /** How Jarvis is seeing this project. Anything but `observed` caps the band. */
  readonly coverage: ObservationState;
  readonly now: Date;
}

const SEVERITY_POINTS: Record<Opportunity['severity'], number> = {
  critical: 50,
  high: 30,
  medium: 15,
  low: 5,
};

const PROVENANCE_POINTS: Record<ProvenanceLevel, number> = {
  verified: 15,
  manual: 10,
  inferred: 0,
  unknown: -10,
};

/**
 * Where an opportunity sits in the queue, and why.
 *
 * The band is not derived from the score alone. Three conditions override it downwards whatever
 * the arithmetic says, because each describes a situation where acting would be wrong however
 * urgent the thing appears:
 *
 * - **Only a person can settle it.** An operator that "handles" a decision the owner has to make
 *   has not handled it.
 * - **Jarvis cannot see the project properly.** Acting on stale or failed observation is acting on
 *   a guess, and the guess is invisible by the time anything goes wrong.
 * - **The charter does not name the project.** Work outside the charter is not the operator's to
 *   start, and quietly ranking it first would make that easy to miss.
 */
export function prioritise(opportunity: Opportunity, context: PriorityContext): Priority {
  const factors: PriorityFactor[] = [
    {
      name: 'severity',
      points: SEVERITY_POINTS[opportunity.severity],
      why: `The status engine rated this ${opportunity.severity}.`,
    },
    {
      name: 'evidence',
      points: PROVENANCE_POINTS[opportunity.provenance],
      why:
        opportunity.provenance === 'verified'
          ? 'It comes from evidence Jarvis read itself.'
          : opportunity.provenance === 'manual'
            ? 'It comes from something you told Jarvis.'
            : opportunity.provenance === 'inferred'
              ? 'It is inferred rather than observed, so it may be wrong.'
              : 'Jarvis cannot say where this came from.',
    },
  ];

  if (opportunity.projectId && context.goalProjectIds.has(opportunity.projectId)) {
    factors.push({
      name: 'goal',
      points: 20,
      why: 'It belongs to a project one of your charter goals names.',
    });
  } else if (opportunity.projectId && context.chartedProjectIds.has(opportunity.projectId)) {
    factors.push({
      name: 'scope',
      points: 5,
      why: 'It belongs to a project your charter covers.',
    });
  } else {
    factors.push({
      name: 'scope',
      points: -20,
      why: 'Your charter does not cover this project, so Jarvis will not start work on it.',
    });
  }

  const ageHours = hoursSince(opportunity.observedAt, context.now);
  if (ageHours !== null && ageHours >= 24) {
    factors.push({
      name: 'age',
      points: Math.min(10, Math.floor(ageHours / 24) * 5),
      why: `It has been outstanding for ${Math.floor(ageHours / 24)} day(s).`,
    });
  }

  const score = factors.reduce((total, factor) => total + factor.points, 0);
  let band: PriorityBand = score >= 60 ? 'now' : score >= 35 ? 'next' : score >= 15 ? 'later' : 'watch';

  const cap = (to: PriorityBand, name: string, why: string) => {
    if (PRIORITY_BANDS.indexOf(band) < PRIORITY_BANDS.indexOf(to)) {
      band = to;
      factors.push({ name, points: 0, why });
    }
  };

  if (opportunity.requiresOwner) {
    cap('watch', 'needs you', 'Only you can settle this, so Jarvis will raise it rather than act.');
  }
  if (context.coverage !== 'observed') {
    cap(
      'watch',
      'not observed',
      `${OBSERVATION_STATE_MEANING[context.coverage]} Jarvis will not act on what it cannot currently see.`,
    );
  }
  if (opportunity.projectId && !context.chartedProjectIds.has(opportunity.projectId)) {
    cap('watch', 'outside the charter', 'Your charter does not cover this project.');
  }

  return { band, score, factors };
}

export interface RankedOpportunity {
  readonly opportunity: Opportunity;
  readonly priority: Priority;
}

/**
 * The backlog, in the order the operator would work it.
 *
 * Ties break on the key rather than on insertion order, so two ticks over the same unchanged
 * backlog produce the same sequence. A queue that reshuffles itself between ticks makes "why did
 * it do that one first?" unanswerable.
 */
export function rank(
  opportunities: readonly Opportunity[],
  context: (opportunity: Opportunity) => PriorityContext,
): readonly RankedOpportunity[] {
  return [...opportunities]
    .map((opportunity) => ({ opportunity, priority: prioritise(opportunity, context(opportunity)) }))
    .sort((left, right) => {
      const byBand =
        PRIORITY_BANDS.indexOf(left.priority.band) - PRIORITY_BANDS.indexOf(right.priority.band);
      if (byBand !== 0) return byBand;
      if (right.priority.score !== left.priority.score) {
        return right.priority.score - left.priority.score;
      }
      return left.opportunity.key < right.opportunity.key ? -1 : 1;
    });
}

/**
 * What the operator may actually start, given how much room it has.
 *
 * `watch` is excluded by construction rather than by a caller remembering to filter it, because
 * "recorded and deliberately not worked on" is the only band whose whole meaning is that nothing
 * happens. The cap is a number of missions rather than a time budget: time is enforced per mission
 * by the charter's limits, and two ceilings on the same thing eventually disagree.
 */
export function selectWork(
  ranked: readonly RankedOpportunity[],
  room: number,
): readonly RankedOpportunity[] {
  if (room <= 0) return [];
  return ranked.filter((entry) => entry.priority.band !== 'watch').slice(0, room);
}

function hoursSince(iso: string, now: Date): number | null {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return null;
  return (now.getTime() - then) / 3_600_000;
}
