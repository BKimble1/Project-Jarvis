import { ForbiddenError } from './errors';

/**
 * Whether the work Jarvis chose to do actually helped.
 *
 * ## Why this exists
 *
 * An operator that picks its own work and never checks the result is not an operator, it is a
 * process that generates activity. The distinguishing feature of useful autonomous work is that
 * somebody wrote down, *before starting*, what they expected to improve and how they would know —
 * and then went back and looked. Without the first half the second half is unfalsifiable, so the
 * hypothesis is recorded when the mission is created and cannot be edited afterwards.
 *
 * ## Why the verdict is deliberately hard to make positive
 *
 * Because the failure mode is not "Jarvis is too modest". It is a system that reports a string of
 * successes nobody can check, which is worse than no measurement at all: it converts uncertainty
 * into false confidence and spends real money doing it. So `too_early` and `inconclusive` are
 * first-class answers, `supported` requires a named signal that actually moved, and a claim about
 * revenue requires evidence from a connected financial source — which today does not exist, so
 * today the answer is always no.
 *
 * ## What Jarvis may never do to make a number go up
 *
 * Buy anything, move money, enter into an agreement, act as the owner, or publish a claim. These
 * are refused at the point a hypothesis is written rather than at the point work starts, because a
 * benefit nobody may pursue is a benefit nobody should be planning around.
 */

/* ------------------------------------------------------------------ shapes */

export const BENEFIT_KINDS = [
  /** Fewer failures, less breakage, fewer repeats. */
  'reliability',
  /** The same thing, sooner. */
  'speed',
  /** Less money or less capacity spent doing it. */
  'cost',
  /** A hazard reduced. Nothing observable improves; something bad becomes less likely. */
  'risk',
  /** Somebody can now understand or find something they could not. */
  'clarity',
  /** Money in. Requires evidence from a connected financial source — see `revenueClaimable`. */
  'revenue',
] as const;
export type BenefitKind = (typeof BENEFIT_KINDS)[number];

export const BENEFIT_KIND_LABELS: Record<BenefitKind, string> = {
  reliability: 'Fewer failures',
  speed: 'Sooner',
  cost: 'Cheaper',
  risk: 'Less risky',
  clarity: 'Clearer',
  revenue: 'Revenue',
};

export const EFFORT_SIZES = ['small', 'medium', 'large'] as const;
export type EffortSize = (typeof EFFORT_SIZES)[number];

export interface OutcomeHypothesis {
  /** What Jarvis observed, in the words of the opportunity that raised it. */
  readonly observedProblem: string;
  readonly expectedBenefit: string;
  readonly benefitKind: BenefitKind;
  /** Why this, now, rather than later or never. */
  readonly whyNow: string;
  readonly estimatedEffort: EffortSize;
  /** How the result will be checked. Must name something, not "we will see". */
  readonly verificationPlan: string;
  /** The one observable that would move if this worked. */
  readonly successSignal: string;
}

export const OUTCOME_VERDICTS = [
  /** Not enough time has passed for the signal to have moved either way. */
  'too_early',
  /** The signal moved the way the hypothesis said it would. */
  'supported',
  /** The signal did not move, or moved the other way. */
  'not_supported',
  /** The signal cannot be read: the source is gone, or too much changed at once. */
  'inconclusive',
] as const;
export type OutcomeVerdict = (typeof OUTCOME_VERDICTS)[number];

export const OUTCOME_VERDICT_LABELS: Record<OutcomeVerdict, string> = {
  too_early: 'Too early to say',
  supported: 'It helped',
  not_supported: 'It did not help',
  inconclusive: 'Cannot tell',
};

export interface OutcomeObservation {
  readonly observedAt: string;
  /** The success signal as it read before the work. Null when it was never captured. */
  readonly before: string | null;
  /** The same signal now. */
  readonly after: string | null;
  readonly verdict: OutcomeVerdict;
  /** One sentence a person can disagree with. */
  readonly note: string;
  /** Rows this was read from, so the verdict can be checked rather than believed. */
  readonly evidenceIds: readonly string[];
}

/* ------------------------------------------------------------------- rules */

/**
 * How long after a mission finishes before its result means anything.
 *
 * Twenty-four hours. Shorter and the signal is measuring the deployment rather than the change;
 * much longer and nobody connects the two. `too_early` before this is not a failure to measure,
 * it is the honest reading.
 */
export const OBSERVATION_DELAY_MS = 24 * 3_600_000;

/**
 * How many self-started missions may be in flight at once.
 *
 * Separate from the deployment's concurrency ceiling and deliberately much smaller. The general
 * ceiling protects the machine; this protects the *owner* — from opening Jarvis to find that every
 * available slot is taken by work it chose for itself while the thing they actually asked for sits
 * in a queue behind it. Three is enough to be useful and few enough to read.
 */
export const MAX_SELF_STARTED_CONCURRENT = 3;

/**
 * Things Jarvis may not set out to do, whatever the benefit.
 *
 * Refused when the hypothesis is written rather than when the work starts. A plan whose stated
 * benefit is "renew the subscription" has already gone wrong: the refusal belongs at the point
 * somebody wrote it down, where it can be read, not three steps later inside an authorisation
 * check where it looks like a technicality.
 */
const PROHIBITED: readonly { readonly pattern: RegExp; readonly what: string }[] = [
  {
    pattern: /\b(?:buy|purchase|order|subscribe to|renew the|upgrade the plan|top ?up)\b/i,
    what: 'buying something',
  },
  {
    pattern: /\b(?:pay|transfer|refund|invoice|withdraw|send money|charge the card)\b/i,
    what: 'moving money',
  },
  {
    pattern: /\b(?:sign|agree to|accept the terms|enter into|contract with|commit us to)\b/i,
    what: 'entering an agreement',
  },
  {
    pattern:
      /\b(?:email (?:the|our) (?:client|customer)|post as|tweet|reply on behalf|as if from)\b/i,
    what: 'acting as you',
  },
  {
    pattern: /\b(?:publish|announce|press release|marketing (?:copy|campaign)|advertis)/i,
    what: 'publishing a claim',
  },
];

/**
 * Refuse a hypothesis that plans something Jarvis will never be allowed to do.
 *
 * Throws, because there is no useful way to continue with a plan whose stated point is forbidden.
 */
export function assertBenefitPermitted(
  hypothesis: Pick<OutcomeHypothesis, 'expectedBenefit'>,
): void {
  const found = PROHIBITED.find((entry) => entry.pattern.test(hypothesis.expectedBenefit));
  if (!found) return;
  throw new ForbiddenError(
    `Jarvis will not plan work whose point is ${found.what}. That is yours to do, and it will say so rather than quietly leaving it out of the plan.`,
    { rule: 'R-OC1', what: found.what },
  );
}

/**
 * Whether a revenue claim may be made at all.
 *
 * Answered from the connections, not from the work. No financial source is connected, so nothing
 * can establish that money arrived — and a system that inferred revenue from a shipped feature
 * would be manufacturing the single most consequential number it reports.
 */
export function revenueClaimable(input: { readonly financialSourceConnected: boolean }): boolean {
  return input.financialSourceConnected;
}

export interface VerdictInput {
  readonly hypothesis: Pick<OutcomeHypothesis, 'benefitKind' | 'successSignal'>;
  readonly finishedAt: string | null;
  readonly now: Date;
  /** The signal as captured when the work started. Null when nothing was captured. */
  readonly before: string | null;
  /** The signal now. Null when it can no longer be read. */
  readonly after: string | null;
  /** True when the signal moved in the direction the hypothesis predicted. */
  readonly improved: boolean | null;
  readonly financialSourceConnected: boolean;
}

/**
 * Read the result, conservatively.
 *
 * The order is the argument. Time first, because a signal read too early is noise wearing a
 * verdict's clothes. Then the revenue refusal, because it holds regardless of what any signal did.
 * Then readability. Only then does the comparison get to speak, and it only ever says `supported`
 * when something was captured on both sides and actually moved.
 */
export function deriveVerdict(input: VerdictInput): {
  readonly verdict: OutcomeVerdict;
  readonly note: string;
  readonly rule: string;
} {
  const finished = input.finishedAt ? Date.parse(input.finishedAt) : null;
  if (finished === null || Number.isNaN(finished)) {
    return {
      verdict: 'too_early',
      note: 'The work has not finished yet.',
      rule: 'R-OC2',
    };
  }
  if (input.now.getTime() - finished < OBSERVATION_DELAY_MS) {
    return {
      verdict: 'too_early',
      note: `Less than a day since this finished. ${input.hypothesis.successSignal} has not had time to move.`,
      rule: 'R-OC3',
    };
  }

  if (
    input.hypothesis.benefitKind === 'revenue' &&
    !revenueClaimable({ financialSourceConnected: input.financialSourceConnected })
  ) {
    return {
      verdict: 'inconclusive',
      note: 'No financial data is connected, so Jarvis cannot say whether this made any money. It will not guess.',
      rule: 'R-OC4',
    };
  }

  if (input.before === null || input.after === null) {
    return {
      verdict: 'inconclusive',
      note:
        input.before === null
          ? `Nothing was recorded for ${input.hypothesis.successSignal} before the work, so there is nothing to compare against.`
          : `${input.hypothesis.successSignal} can no longer be read.`,
      rule: 'R-OC5',
    };
  }

  if (input.improved === null) {
    return {
      verdict: 'inconclusive',
      note: `${input.hypothesis.successSignal} changed, but not in a way Jarvis can attribute to this work.`,
      rule: 'R-OC6',
    };
  }

  return input.improved
    ? {
        verdict: 'supported',
        note: `${input.hypothesis.successSignal} moved as expected: ${input.before} → ${input.after}.`,
        rule: 'R-OC7',
      }
    : {
        verdict: 'not_supported',
        note: `${input.hypothesis.successSignal} did not improve: ${input.before} → ${input.after}.`,
        rule: 'R-OC8',
      };
}

/**
 * One line for a person who wants to know whether any of this is working.
 *
 * Counts rather than a percentage. A "68% success rate" over eleven observations is a number that
 * sounds like measurement and is mostly noise; "four helped, two did not, five too early to say"
 * is what was actually seen.
 */
export function summariseOutcomes(verdicts: readonly OutcomeVerdict[]): string {
  if (verdicts.length === 0) return 'Jarvis has not started anything on its own yet.';
  const count = (verdict: OutcomeVerdict) => verdicts.filter((entry) => entry === verdict).length;
  const parts = [
    count('supported') > 0 ? `${count('supported')} helped` : null,
    count('not_supported') > 0 ? `${count('not_supported')} did not` : null,
    count('too_early') > 0 ? `${count('too_early')} too early to say` : null,
    count('inconclusive') > 0 ? `${count('inconclusive')} cannot be told either way` : null,
  ].filter((part): part is string => part !== null);
  return `Of ${verdicts.length} thing${verdicts.length === 1 ? '' : 's'} Jarvis started itself: ${parts.join(', ')}.`;
}
