import {
  CAPABILITY_BY_CLASS,
  EXCEPTIONAL_ACTION_LABELS,
  SCOPE_KIND_LABELS,
  branchScopeContains,
  isCapabilityClass,
  scopeContains,
  type CapabilityClass,
  type CapabilityGrant,
  type CharterContent,
  type ExceptionalAction,
  type ScopeKind,
} from './charter';
import { modeGrantsStandingAuthority, modeMayPropose, type OperatingMode } from './operating-mode';
/*
 * `CAPABILITY_REQUIRED_LEVEL` is imported rather than re-derived, so this file and the activation
 * lock cannot come to different conclusions about the same capability.
 */
import {
  CAPABILITY_REQUIRED_LEVEL as REQUIRED_LEVEL,
  meetsLevel,
  type QualificationLevel,
} from './qualification';

/**
 * Deciding whether Jarvis may do something without asking.
 *
 * ## This file contains no model, and never will
 *
 * The whole value of a standing authority is that the thing checking it cannot be talked round. A
 * model deciding whether a model's plan is within its permissions is not a control; it is a
 * conversation, and conversations can be steered by whatever text happens to be in the context.
 * So this is a pure function over three inputs — the request, the charter, and what the deployment
 * has proved it can do — and it has no provider, no retrieval, no network and no clock beyond the
 * one it is handed.
 *
 * ## Three gates, and all three must open
 *
 * 1. **The mode.** Is Jarvis currently operating at all? (`operating-mode.ts`)
 * 2. **The charter.** Did the owner authorise this capability, over this thing? (`charter.ts`)
 * 3. **The activation lock.** Has this deployment demonstrated it can do this safely?
 *    (`qualification.ts`)
 *
 * They fail differently on purpose, and the difference is what the owner is told:
 *
 *  - A charter gap is **`needs_owner`** — you could grant this, and here is exactly what to grant.
 *  - An activation gap is **`refused`** — granting it would change nothing, because the deployment
 *    has not proved it yet. Telling someone to "just approve it" when approval is not the missing
 *    ingredient is how a control gets removed for being wrong.
 *
 * ## No partial reinterpretation
 *
 * If a plan asks to merge a pull request and the charter grants only opening one, the answer is
 * not "open one instead". Capabilities are never substituted, weakened, widened by resemblance, or
 * matched by prefix. The in-bounds capabilities may still proceed — that is a *subset*, not a
 * reinterpretation — and the out-of-bounds ones are named with the precise authority they lack.
 */

/* ------------------------------------------------------------------ request */

/**
 * One thing a plan proposes to do.
 *
 * Produced by a planner that may well be a model, and treated accordingly: it is *data describing
 * an intention*, validated against a closed vocabulary before it means anything. `reason` exists so
 * the owner can read why it was wanted. It is never parsed, never matched against, and can never
 * make a refusal into an authorisation.
 */
export interface CapabilityRequest {
  readonly capability: CapabilityClass;
  readonly projectId: string | null;
  /** `owner/repo`, exactly as the control plane resolved it. */
  readonly repository: string | null;
  readonly branch: string | null;
  readonly environment: string | null;
  readonly releaseChannel: string | null;
  readonly connectorId: string | null;
  readonly reason: string;
}

export interface AuthorizationRequest {
  readonly missionId: string | null;
  readonly capabilities: readonly CapabilityRequest[];
  /** What the plan expects to spend. Null means it could not estimate, which is not zero. */
  readonly estimatedSpendUsd: number | null;
  readonly estimatedMinutes: number | null;
  readonly parallelAgents: number;
  /**
   * Anything the plan itself recognises as exceptional.
   *
   * Populated by trusted code from the action being proposed, not by the model's own opinion of
   * how serious it is. Present here so that a plan which reaches one is refused by this function
   * rather than discovered later by whatever was about to execute it.
   */
  readonly exceptional: readonly ExceptionalAction[];
}

/* ----------------------------------------------------------------- decision */

export const AUTHORIZATION_OUTCOMES = ['authorized', 'needs_owner', 'refused'] as const;
export type AuthorizationOutcome = (typeof AUTHORIZATION_OUTCOMES)[number];

export const AUTHORIZATION_OUTCOME_LABELS: Record<AuthorizationOutcome, string> = {
  authorized: 'Authorised by your charter',
  needs_owner: 'Needs your authority',
  refused: 'Refused',
};

/**
 * Why one capability was allowed or not.
 *
 * `missingAuthority` is the sentence the owner is shown and, when they agree, the thing that gets
 * added to the charter. It names the capability and the scope, because "Jarvis needs more
 * permission" is not something anyone can safely say yes to.
 */
export interface CapabilityVerdict {
  readonly capability: CapabilityClass;
  readonly allowed: boolean;
  /** Which rule decided it. `null` when the capability was simply granted. */
  readonly rule: string | null;
  readonly reason: string;
  readonly missingAuthority: string | null;
  /** True when the owner could fix this by granting; false when it is a qualification matter. */
  readonly ownerCanGrant: boolean;
}

export interface AuthorizationDecision {
  readonly outcome: AuthorizationOutcome;
  /** The charter that decided this, named so a later reader can check it was not edited since. */
  readonly charterVersionId: string | null;
  readonly charterDigest: string | null;
  readonly mode: OperatingMode;
  readonly qualificationLevel: QualificationLevel;
  readonly verdicts: readonly CapabilityVerdict[];
  /** One sentence for a log, a timeline entry or a spoken update. */
  readonly summary: string;
  readonly decidedAt: string;
}

export interface ActiveCharter {
  readonly versionId: string;
  readonly digest: string;
  readonly content: CharterContent;
}

export interface AuthorizationContext {
  readonly mode: OperatingMode;
  readonly charter: ActiveCharter | null;
  readonly qualificationLevel: QualificationLevel;
  readonly now: Date;
}

/* -------------------------------------------------------------------- rules */

export const AUTHORIZATION_RULES = {
  'R-AU1': 'Standing authority applies only while Jarvis is in Operator mode.',
  'R-AU2': 'An absent, expired or unactivated charter authorises nothing.',
  'R-AU3': 'A capability must be granted by name. Nothing is substituted for anything else.',
  'R-AU4': 'A grant applies only within the scope the owner wrote.',
  'R-AU5': 'The deployment must independently have qualified for the capability.',
  'R-AU6': 'An exceptional action is never authorised in advance.',
  'R-AU7': 'A plan must fit inside the charter’s limits.',
  'R-AU8': 'An unrecognised capability is refused, not interpreted.',
} as const;
export type AuthorizationRule = keyof typeof AUTHORIZATION_RULES;

/* ------------------------------------------------------------- the decision */

/**
 * Decide whether a plan may proceed on standing authority.
 *
 * Returns a verdict for **every** requested capability rather than stopping at the first refusal,
 * because an owner asked to widen a charter should be shown the whole gap at once. The outcome is
 * the worst of the verdicts: any activation failure makes it `refused`, otherwise any charter gap
 * makes it `needs_owner`, and only a clean sweep is `authorized`.
 */
export function authorize(
  request: AuthorizationRequest,
  context: AuthorizationContext,
): AuthorizationDecision {
  const decidedAt = context.now.toISOString();
  const base = {
    charterVersionId: context.charter?.versionId ?? null,
    charterDigest: context.charter?.digest ?? null,
    mode: context.mode,
    qualificationLevel: context.qualificationLevel,
    decidedAt,
  };

  /* R-AU1 — the mode gate, before anything is even read out of the charter. */
  if (!modeGrantsStandingAuthority(context.mode)) {
    const canPropose = modeMayPropose(context.mode);
    return {
      ...base,
      outcome: canPropose ? 'needs_owner' : 'refused',
      verdicts: request.capabilities.map((entry) =>
        deny(
          entry.capability,
          'R-AU1',
          canPropose
            ? 'Jarvis is supervised, so every mission waits for you.'
            : `Jarvis is ${context.mode.replace('_', ' ')} and is not starting work.`,
          canPropose
            ? 'Turn on Operator mode to let the charter stand in for this approval.'
            : null,
          canPropose,
        ),
      ),
      summary: canPropose
        ? 'Waiting for you: Jarvis is supervised rather than operating.'
        : `Refused: Jarvis is ${context.mode.replace('_', ' ')}.`,
    };
  }

  /* R-AU2 — a charter that is absent, unreadable or out of date authorises nothing. */
  const charter = context.charter;
  if (!charter) {
    return {
      ...base,
      outcome: 'needs_owner',
      verdicts: request.capabilities.map((entry) =>
        deny(
          entry.capability,
          'R-AU2',
          'There is no active operating charter.',
          'Write and activate an operating charter.',
          true,
        ),
      ),
      summary: 'Waiting for you: there is no active operating charter.',
    };
  }
  const expiry = charter.content.expiresAt ? Date.parse(charter.content.expiresAt) : null;
  if (expiry !== null && Number.isFinite(expiry) && expiry <= context.now.getTime()) {
    return {
      ...base,
      outcome: 'needs_owner',
      verdicts: request.capabilities.map((entry) =>
        deny(
          entry.capability,
          'R-AU2',
          `The charter expired on ${charter.content.expiresAt?.slice(0, 10)}.`,
          'Review the charter and set a new review date.',
          true,
        ),
      ),
      summary: 'Waiting for you: the operating charter has expired.',
    };
  }

  /* R-AU6 — exceptional actions, before any capability is considered. */
  if (request.exceptional.length > 0) {
    return {
      ...base,
      outcome: 'needs_owner',
      verdicts: request.capabilities.map((entry) =>
        deny(
          entry.capability,
          'R-AU6',
          `This plan reaches ${request.exceptional.map((action) => EXCEPTIONAL_ACTION_LABELS[action].toLowerCase()).join(' and ')}, which a charter never authorises in advance.`,
          'Approve this one action directly, with read-back.',
          true,
        ),
      ),
      summary: `Waiting for you: ${request.exceptional
        .map((action) => EXCEPTIONAL_ACTION_LABELS[action].toLowerCase())
        .join(' and ')} needs a decision from you.`,
    };
  }

  /* R-AU7 — the plan's own shape against the charter's ceilings. */
  const limitProblem = checkLimits(request, charter.content);
  if (limitProblem) {
    return {
      ...base,
      outcome: 'needs_owner',
      verdicts: request.capabilities.map((entry) =>
        deny(entry.capability, 'R-AU7', limitProblem.reason, limitProblem.remedy, true),
      ),
      summary: `Waiting for you: ${limitProblem.reason}`,
    };
  }

  const grantByClass = new Map<CapabilityClass, CapabilityGrant>(
    charter.content.grants.map((grant) => [grant.capability, grant]),
  );

  const verdicts = request.capabilities.map((entry) =>
    judge(entry, grantByClass.get(entry.capability), context.qualificationLevel),
  );

  const refusals = verdicts.filter((verdict) => !verdict.allowed);
  const blocked = refusals.filter((verdict) => !verdict.ownerCanGrant);

  const outcome: AuthorizationOutcome =
    blocked.length > 0 ? 'refused' : refusals.length > 0 ? 'needs_owner' : 'authorized';

  return {
    ...base,
    outcome,
    verdicts,
    summary: summarise(outcome, verdicts, refusals),
  };
}

/* ------------------------------------------------------------ one capability */

function judge(
  entry: CapabilityRequest,
  grant: CapabilityGrant | undefined,
  level: QualificationLevel,
): CapabilityVerdict {
  /* R-AU8 — an unknown capability is a refusal. It is never resolved by resemblance. */
  if (!isCapabilityClass(entry.capability)) {
    return deny(entry.capability, 'R-AU8', 'That is not a capability Jarvis has.', null, false);
  }
  const definition = CAPABILITY_BY_CLASS[entry.capability];

  /* R-AU3 — granted by name, or not at all. */
  if (!grant) {
    return deny(
      entry.capability,
      'R-AU3',
      `Your charter does not grant "${definition.label}".`,
      describeMissing(entry, definition.label),
      true,
    );
  }

  /* R-AU4 — and only within the scope the owner wrote. */
  for (const kind of definition.scopeKinds) {
    const wanted = requestedValue(entry, kind);
    if (wanted === null) {
      return deny(
        entry.capability,
        'R-AU4',
        `This plan does not say which ${singular(kind)} it means, and "${definition.label}" is scoped by ${SCOPE_KIND_LABELS[kind].toLowerCase()}.`,
        null,
        false,
      );
    }
    const contained =
      kind === 'branches'
        ? branchScopeContains(grant.scope.branches, wanted)
        : scopeContains(grant.scope[kind], wanted);
    if (!contained) {
      return deny(
        entry.capability,
        'R-AU4',
        `Your charter grants "${definition.label}" but not for ${singular(kind)} ${wanted}.`,
        `Add ${wanted} to the ${SCOPE_KIND_LABELS[kind].toLowerCase()} for "${definition.label}".`,
        true,
      );
    }
  }

  /*
   * R-AU5 — and the deployment must independently have earned it.
   *
   * Last, deliberately. An owner reading a refusal wants to know first whether they forgot to
   * grant something; being told "you have not qualified for this" when you also never granted it
   * sends them to the wrong page.
   */
  const required = definition.requires;
  const requiredLevel = REQUIRED_LEVEL[required];
  if (!meetsLevel(level, requiredLevel)) {
    return deny(
      entry.capability,
      'R-AU5',
      `"${definition.label}" needs this deployment to have qualified to "${requiredLevel}". It is at "${level}".`,
      null,
      /* The owner cannot grant their way past this, and saying otherwise would waste their time. */
      false,
    );
  }

  return {
    capability: entry.capability,
    allowed: true,
    rule: null,
    reason: `Granted by your charter${scopeSentence(entry)}.`,
    missingAuthority: null,
    ownerCanGrant: true,
  };
}

/* ------------------------------------------------------------------ helpers */

function deny(
  capability: CapabilityClass,
  rule: AuthorizationRule,
  reason: string,
  missingAuthority: string | null,
  ownerCanGrant: boolean,
): CapabilityVerdict {
  return { capability, allowed: false, rule, reason, missingAuthority, ownerCanGrant };
}

function requestedValue(entry: CapabilityRequest, kind: ScopeKind): string | null {
  switch (kind) {
    case 'projects':
      return entry.projectId;
    case 'repositories':
      return entry.repository;
    case 'branches':
      return entry.branch;
    case 'environments':
      return entry.environment;
    case 'releaseChannels':
      return entry.releaseChannel;
    case 'connectors':
      return entry.connectorId;
  }
}

function singular(kind: ScopeKind): string {
  return SCOPE_KIND_LABELS[kind].toLowerCase().replace(/s$/, '');
}

function scopeSentence(entry: CapabilityRequest): string {
  const parts = [
    entry.repository ? `in ${entry.repository}` : null,
    entry.branch ? `on ${entry.branch}` : null,
    entry.environment ? `for ${entry.environment}` : null,
  ].filter((part): part is string => part !== null);
  return parts.length > 0 ? `, ${parts.join(' ')}` : '';
}

function describeMissing(entry: CapabilityRequest, label: string): string {
  const where = [
    entry.repository ? `repository ${entry.repository}` : null,
    entry.branch ? `branch ${entry.branch}` : null,
    entry.environment ? `environment ${entry.environment}` : null,
    entry.connectorId ? `connector ${entry.connectorId}` : null,
  ].filter((part): part is string => part !== null);
  return where.length > 0 ? `Grant "${label}" for ${where.join(', ')}.` : `Grant "${label}".`;
}

interface LimitProblem {
  readonly reason: string;
  readonly remedy: string;
}

/**
 * The plan's shape against the charter's ceilings.
 *
 * An unestimated cost is not a free one. A plan that cannot say what it will spend is exactly the
 * plan a spending limit exists for, so when the charter sets a limit and the plan offers no
 * estimate, that is a refusal rather than a pass — the alternative is that "I don't know" becomes
 * the cheapest possible answer.
 */
function checkLimits(request: AuthorizationRequest, content: CharterContent): LimitProblem | null {
  const { limits } = content;

  if (limits.dailySpendUsd !== null) {
    if (request.estimatedSpendUsd === null) {
      return {
        reason: 'this plan cannot say what it would cost, and your charter sets a spending limit',
        remedy: 'Approve it once, or remove the spending limit.',
      };
    }
    if (request.estimatedSpendUsd > limits.dailySpendUsd) {
      return {
        reason: `this plan expects to spend about $${request.estimatedSpendUsd.toFixed(2)}, over your $${limits.dailySpendUsd.toFixed(2)} daily limit`,
        remedy: 'Approve it once, or raise the daily limit.',
      };
    }
  }

  if (request.estimatedMinutes !== null && request.estimatedMinutes > limits.maxMissionMinutes) {
    return {
      reason: `this plan expects to take about ${request.estimatedMinutes} minutes, over your ${limits.maxMissionMinutes}-minute ceiling`,
      remedy: 'Approve it once, or raise the mission time limit.',
    };
  }

  if (request.parallelAgents > limits.maxParallelAgents) {
    return {
      reason: `this plan wants ${request.parallelAgents} agents at once, over your limit of ${limits.maxParallelAgents}`,
      remedy: 'Approve it once, or raise the parallel-agent limit.',
    };
  }

  return null;
}

function summarise(
  outcome: AuthorizationOutcome,
  verdicts: readonly CapabilityVerdict[],
  refusals: readonly CapabilityVerdict[],
): string {
  if (outcome === 'authorized') {
    return `Authorised by your charter: ${verdicts
      .map((verdict) => CAPABILITY_BY_CLASS[verdict.capability]?.label ?? verdict.capability)
      .join(', ')}.`;
  }
  const named = refusals
    .map((verdict) => CAPABILITY_BY_CLASS[verdict.capability]?.label ?? verdict.capability)
    .join(', ');
  return outcome === 'needs_owner' ? `Waiting for you: ${named}.` : `Refused: ${named}.`;
}

/**
 * The capabilities a decision refused that the owner could grant.
 *
 * Exposed separately because this is the list that becomes a question — spoken on a call, shown on
 * a card — and building it at each call site is how two of them end up disagreeing.
 */
export function missingAuthorities(decision: AuthorizationDecision): readonly string[] {
  return decision.verdicts
    .filter((verdict) => !verdict.allowed && verdict.ownerCanGrant && verdict.missingAuthority)
    .map((verdict) => verdict.missingAuthority!);
}

/** The capabilities a decision authorised. The subset that may proceed when others could not. */
export function authorizedCapabilities(
  decision: AuthorizationDecision,
): readonly CapabilityClass[] {
  return decision.verdicts
    .filter((verdict) => verdict.allowed)
    .map((verdict) => verdict.capability);
}
