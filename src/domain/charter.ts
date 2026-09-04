import { createHash } from 'node:crypto';
import { z } from 'zod';
import { canonicalJson } from './audit';
import type { ActivationCapability } from './qualification';

/**
 * The operating charter: what the owner has authorised Jarvis to do without being asked again.
 *
 * ## Why this is not the activation lock
 *
 * These are two different questions and the system needs both answered before it acts:
 *
 *  - The **activation lock** (`qualification.ts`) asks *has this deployment demonstrated it can do
 *    this safely?* It is a claim about evidence. It is earned by running things and recording what
 *    happened, and no amount of owner enthusiasm can grant it.
 *  - The **charter** asks *has the owner permitted this?* It is a claim about authority. It is
 *    granted by a person, and no amount of successful qualification can supply it.
 *
 * A deployment that has qualified for live writes but has no charter must still not write
 * unattended. A charter that grants everything to a deployment at `built` must still not run a
 * model. `allowed = charterGrants(...) && activationProves(...)`, and neither implies the other.
 * Keeping them separate is what stops "it worked last time" from becoming permission, and
 * "I said yes once" from becoming capability.
 *
 * ## Why capabilities are a closed vocabulary
 *
 * A charter written in prose is a charter a model interprets, and a model interpreting its own
 * permissions is the failure this file exists to prevent. So authority is expressed as grants of
 * named capability classes over named scopes, and the authorisation decision is a containment
 * check that a person can read and a test can pin down. Anything not in `CAPABILITY_CLASSES` is
 * not a capability Jarvis has — it is a refusal, not a gap to be filled in by resemblance.
 *
 * ## What a grant cannot do
 *
 * A grant cannot be created, widened or interpreted by a model. It arrives from an owner-
 * authenticated route, is stored as a version, and is compared by pure code. Text retrieved from a
 * document, an issue, an email or a web page is evidence about the world; it is never authority
 * over Jarvis, and there is deliberately no code path by which it could become one.
 */

/* ------------------------------------------------------------------- scopes */

/**
 * The dimensions a grant can be confined to.
 *
 * Not every capability uses every dimension — auditing a repository has nothing to say about a
 * release channel — so each capability declares which ones it is meaningless without.
 */
export const SCOPE_KINDS = [
  'projects',
  'repositories',
  'branches',
  'environments',
  'releaseChannels',
  'connectors',
] as const;
export type ScopeKind = (typeof SCOPE_KINDS)[number];

export const SCOPE_KIND_LABELS: Record<ScopeKind, string> = {
  projects: 'Projects',
  repositories: 'Repositories',
  branches: 'Branches',
  environments: 'Environments',
  releaseChannels: 'Release channels',
  connectors: 'Connectors',
};

/**
 * The token that means "every member of this dimension".
 *
 * Spelled out rather than represented by an empty list, because those two must never be confused:
 * an empty list is a charter that grants nothing, and a missing list is a charter that forgot to
 * say. Only this exact string widens a dimension, and only where the capability permits it.
 */
export const SCOPE_ALL = '*';

/* ------------------------------------------------------------ capabilities */

/**
 * Everything the owner can put inside a charter.
 *
 * Ordered by blast radius rather than alphabetically, because the order is the argument: reading
 * costs nothing, changing a branch costs a review, and sending a message to another person cannot
 * be taken back.
 */
export const CAPABILITY_CLASSES = [
  /* Reading and thinking. Nothing leaves Jarvis. */
  'research.read',
  'repository.audit',
  'bug.diagnose',
  'analytics.read',
  'project.status.update',

  /* Changing code, inside a branch Jarvis owns. */
  'code.change',
  'test.add',
  'docs.write',
  'dependency.update',
  'branch.create',

  /* Offering the change to a human. */
  'pull_request.open',
  'checks.repair',

  /* Landing the change without a human in the loop. */
  'pull_request.merge',

  /* Reaching infrastructure. */
  'deploy.preview',
  'deploy.website',
  'ci.dispatch',
  'testflight.dispatch',

  /* Reaching other people. */
  'support.draft',
  'support.send',
  'marketing.create',
  'marketing.publish',
  'communication.send',

  /* The owner's own life. */
  'owner.tasks.organize',
  'calendar.write',

  /* Keeping itself going. */
  'mission.create_followup',
] as const;
export type CapabilityClass = (typeof CAPABILITY_CLASSES)[number];

/**
 * How far a capability's consequences travel.
 *
 * Used to decide two things without a table of special cases: whether a dimension may be granted
 * with `*`, and how loudly a decision involving it is reported.
 */
export const REACH_LEVELS = ['nothing', 'repository', 'infrastructure', 'people'] as const;
export type ReachLevel = (typeof REACH_LEVELS)[number];

export interface CapabilityDefinition {
  readonly capability: CapabilityClass;
  readonly label: string;
  /** What the owner is agreeing to, in the words they would use. */
  readonly meaning: string;
  /** True when it changes something outside Jarvis's own records. */
  readonly writes: boolean;
  readonly reach: ReachLevel;
  /**
   * The rung the deployment must independently have earned.
   *
   * The charter cannot substitute for this and this cannot substitute for the charter.
   */
  readonly requires: ActivationCapability;
  /** Dimensions this grant is meaningless without. A grant missing one of these is invalid. */
  readonly scopeKinds: readonly ScopeKind[];
  /**
   * Dimensions that may not be granted with `*`.
   *
   * "Every repository I own" is a sentence an owner can type in a moment and regret for a long
   * time, so the capabilities that merge, deploy, publish or contact a person require the set to
   * be written out. Naming three repositories is a small cost; naming all of them by accident is
   * not a small consequence.
   */
  readonly mustEnumerate: readonly ScopeKind[];
}

const DEF = (
  capability: CapabilityClass,
  label: string,
  meaning: string,
  writes: boolean,
  reach: ReachLevel,
  requires: ActivationCapability,
  scopeKinds: readonly ScopeKind[],
  mustEnumerate: readonly ScopeKind[] = [],
): CapabilityDefinition => ({
  capability,
  label,
  meaning,
  writes,
  reach,
  requires,
  scopeKinds,
  mustEnumerate,
});

export const CAPABILITY_DEFINITIONS: readonly CapabilityDefinition[] = [
  DEF(
    'research.read',
    'Research',
    'Read repositories, documents and the web to answer a question. Changes nothing.',
    false,
    'nothing',
    'model_task_readonly',
    ['projects'],
  ),
  DEF(
    'repository.audit',
    'Audit a repository',
    'Read a repository and report what it finds. Changes nothing.',
    false,
    'nothing',
    'model_task_readonly',
    ['projects', 'repositories'],
  ),
  DEF(
    'bug.diagnose',
    'Diagnose a bug',
    'Reproduce and explain a failure. Changes nothing.',
    false,
    'nothing',
    'model_task_readonly',
    ['projects', 'repositories'],
  ),
  DEF(
    'analytics.read',
    'Read product analytics',
    'Read metrics from a connected analytics or revenue system.',
    false,
    'nothing',
    'model_task_readonly',
    ['projects', 'connectors'],
  ),
  DEF(
    'project.status.update',
    'Update project status',
    "Change what Jarvis records about a project's state. Affects Jarvis only.",
    true,
    'nothing',
    'scheduled_evidence_refresh',
    ['projects'],
  ),
  DEF(
    'code.change',
    'Change code',
    'Edit source files on a branch Jarvis created. Never on the default branch.',
    true,
    'repository',
    'model_task_write',
    ['projects', 'repositories', 'branches'],
  ),
  DEF(
    'test.add',
    'Add or update tests',
    'Write tests on a branch Jarvis created.',
    true,
    'repository',
    'model_task_write',
    ['projects', 'repositories', 'branches'],
  ),
  DEF(
    'docs.write',
    'Write documentation',
    'Edit documentation on a branch Jarvis created.',
    true,
    'repository',
    'model_task_write',
    ['projects', 'repositories', 'branches'],
  ),
  DEF(
    'dependency.update',
    'Update dependencies',
    'Raise dependency versions on a branch Jarvis created.',
    true,
    'repository',
    'model_task_write',
    ['projects', 'repositories', 'branches'],
  ),
  DEF(
    'branch.create',
    'Create a branch',
    'Create a branch in the `jarvis/` namespace.',
    true,
    'repository',
    'github_write',
    ['projects', 'repositories', 'branches'],
  ),
  DEF(
    'pull_request.open',
    'Open a draft pull request',
    'Push a branch and open a pull request as a draft, for a person to review.',
    true,
    'repository',
    'github_write',
    ['projects', 'repositories'],
    ['repositories'],
  ),
  DEF(
    'checks.repair',
    'Repair failing checks',
    'Push further commits to its own pull request to make the checks pass.',
    true,
    'repository',
    'github_write',
    ['projects', 'repositories'],
    ['repositories'],
  ),
  DEF(
    'pull_request.merge',
    'Merge a qualifying pull request',
    'Land its own reviewed, green pull request without waiting for a person.',
    true,
    'repository',
    'github_write',
    ['projects', 'repositories', 'branches'],
    ['repositories', 'branches'],
  ),
  DEF(
    'deploy.preview',
    'Deploy a preview',
    'Publish a preview environment that is not the live site.',
    true,
    'infrastructure',
    'ci_dispatch',
    ['projects', 'environments'],
    ['environments'],
  ),
  DEF(
    'deploy.website',
    'Deploy a website',
    'Publish to a live website that other people visit.',
    true,
    'infrastructure',
    'ci_dispatch',
    ['projects', 'environments'],
    ['projects', 'environments'],
  ),
  DEF(
    'ci.dispatch',
    'Start a CI workflow',
    'Run a workflow on GitHub Actions.',
    true,
    'infrastructure',
    'ci_dispatch',
    ['projects', 'repositories'],
    ['repositories'],
  ),
  DEF(
    'testflight.dispatch',
    'Send a build to TestFlight',
    "Put a build on other people's devices.",
    true,
    'people',
    'testflight_dispatch',
    ['projects', 'releaseChannels'],
    ['projects', 'releaseChannels'],
  ),
  DEF(
    'support.draft',
    'Draft a support reply',
    'Write a reply for you to read. Sends nothing.',
    false,
    'nothing',
    'model_task_readonly',
    ['projects', 'connectors'],
  ),
  DEF(
    'support.send',
    'Send a support reply',
    'Reply to a customer in your name.',
    true,
    'people',
    'model_task_write',
    ['projects', 'connectors'],
    ['projects', 'connectors'],
  ),
  DEF(
    'marketing.create',
    'Create marketing material',
    'Write copy, metadata or assets for you to review. Publishes nothing.',
    false,
    'nothing',
    'model_task_readonly',
    ['projects'],
  ),
  DEF(
    'marketing.publish',
    'Publish marketing material',
    'Put material in front of the public through a connected account.',
    true,
    'people',
    'model_task_write',
    ['projects', 'connectors'],
    ['projects', 'connectors'],
  ),
  DEF(
    'communication.send',
    'Send a message',
    'Send email or a message to a person through a connected account.',
    true,
    'people',
    'model_task_write',
    ['connectors'],
    ['connectors'],
  ),
  DEF(
    'owner.tasks.organize',
    'Organise your tasks',
    'Create, reschedule and close items on your own task list.',
    true,
    'nothing',
    'scheduled_briefing',
    ['connectors'],
  ),
  DEF(
    'calendar.write',
    'Change your calendar',
    'Create or move events on your calendar.',
    true,
    'nothing',
    'scheduled_briefing',
    ['connectors'],
    ['connectors'],
  ),
  DEF(
    'mission.create_followup',
    'Start follow-up work',
    'Create and run a further mission when one finishes, inside this same charter.',
    false,
    'nothing',
    'scheduled_mission_draft',
    ['projects'],
  ),
];

export const CAPABILITY_BY_CLASS: Readonly<Record<CapabilityClass, CapabilityDefinition>> =
  Object.freeze(
    Object.fromEntries(CAPABILITY_DEFINITIONS.map((def) => [def.capability, def])) as Record<
      CapabilityClass,
      CapabilityDefinition
    >,
  );

export function isCapabilityClass(value: string): value is CapabilityClass {
  return Object.prototype.hasOwnProperty.call(CAPABILITY_BY_CLASS, value);
}

/* ------------------------------------------------------ exceptional actions */

/**
 * Things a charter may never authorise in advance.
 *
 * Deliberately short, and deliberately not a synonym for "important". Ordinary coding, testing,
 * deployment and business work belong in the charter — putting them here would make the exception
 * list the real interface and the charter decorative, which is how a standing authority becomes a
 * standing interruption and then gets switched off.
 *
 * What is here shares one property: an owner who is surprised by it cannot undo it. Money has
 * moved, a signature exists, a credential is known to someone else, data is gone, or a claim has
 * been made in public that other people have already acted on.
 */
export const EXCEPTIONAL_ACTIONS = [
  'money.move',
  'purchase.beyond_limit',
  'agreement.sign',
  'account.change_authentication',
  'credential.reveal',
  'data.delete_irreplaceable',
  'claim.public_material',
  'recovery.disable',
] as const;
export type ExceptionalAction = (typeof EXCEPTIONAL_ACTIONS)[number];

export const EXCEPTIONAL_ACTION_LABELS: Record<ExceptionalAction, string> = {
  'money.move': 'Move money',
  'purchase.beyond_limit': 'Buy something beyond the chartered limit',
  'agreement.sign': 'Sign a legal agreement',
  'account.change_authentication': 'Change account recovery or authentication',
  'credential.reveal': 'Reveal a credential',
  'data.delete_irreplaceable': 'Delete an account or irreplaceable data',
  'claim.public_material': 'Make a public claim with material legal consequences',
  'recovery.disable': 'Permanently disable a recovery mechanism',
};

/* --------------------------------------------------------------- the charter */

export interface CapabilityScope {
  readonly projects?: readonly string[];
  readonly repositories?: readonly string[];
  readonly branches?: readonly string[];
  readonly environments?: readonly string[];
  readonly releaseChannels?: readonly string[];
  readonly connectors?: readonly string[];
}

export interface CapabilityGrant {
  readonly capability: CapabilityClass;
  readonly scope: CapabilityScope;
  /** A ceiling on how often this may happen unattended. Null means the charter's limits apply. */
  readonly maxPerDay: number | null;
  /** Why the owner granted it. Shown back to them at review time; never read as authority. */
  readonly note: string | null;
}

export interface CharterGoal {
  readonly id: string;
  readonly statement: string;
  /** 1 is the most important. Ties are allowed and mean "these matter equally". */
  readonly priority: number;
  readonly projectIds: readonly string[];
}

export interface CharterLimits {
  /** Money Jarvis may spend on model usage per day, in USD. Null means no monetary ceiling. */
  readonly dailySpendUsd: number | null;
  readonly weeklySpendUsd: number | null;
  readonly maxMissionMinutes: number;
  readonly maxAttempts: number;
  readonly maxRepairRounds: number;
  readonly maxParallelAgents: number;
  /**
   * The share of the five-hour window to leave alone.
   *
   * Autonomous work is the thing that should yield when the owner wants to do something, so the
   * reserve is expressed as capacity the operator may not touch rather than capacity it may use.
   */
  readonly reserveFiveHourPercent: number;
  readonly reserveSevenDayPercent: number;
}

export const COMMUNICATION_CHANNELS = ['in_app', 'push', 'email', 'voice_call'] as const;
export type CommunicationChannel = (typeof COMMUNICATION_CHANNELS)[number];

export interface CharterCommunication {
  /** Channels Jarvis may use on its own initiative, in the order it should try them. */
  readonly channels: readonly CommunicationChannel[];
  /** Local time, `HH:MM`, during which only interrupting conditions may reach the owner. */
  readonly quietHoursStart: string | null;
  readonly quietHoursEnd: string | null;
  readonly timeZone: string;
  /** Conditions that justify interrupting, including during quiet hours. */
  readonly interruptOn: readonly InterruptCondition[];
  readonly maxCallsPerDay: number;
}

export const INTERRUPT_CONDITIONS = [
  'mission_failed',
  'mission_blocked',
  'authority_needed',
  'production_broken',
  'release_state_changed',
  'metric_moved_materially',
  'high_value_opportunity',
  'budget_exhausted',
  'capacity_exhausted',
] as const;
export type InterruptCondition = (typeof INTERRUPT_CONDITIONS)[number];

export const INTERRUPT_CONDITION_LABELS: Record<InterruptCondition, string> = {
  mission_failed: 'A mission failed',
  mission_blocked: 'A mission is blocked',
  authority_needed: 'Something needs authority the charter does not grant',
  production_broken: 'Something live is broken',
  release_state_changed: 'A release reached an important state',
  metric_moved_materially: 'A metric moved materially',
  high_value_opportunity: 'A high-value opportunity appeared',
  budget_exhausted: 'The spending limit is exhausted',
  capacity_exhausted: 'Claude capacity is exhausted',
};

export const EMERGENCY_STOP_BEHAVIOURS = [
  /** Stop at the next safe boundary, keep every workspace and branch. The default. */
  'halt_preserve',
  /** Let work already in flight finish, start nothing new. */
  'drain',
] as const;
export type EmergencyStopBehaviour = (typeof EMERGENCY_STOP_BEHAVIOURS)[number];

/**
 * Everything a charter version says.
 *
 * This object — and only this object — is what the digest covers and what an authorisation
 * decision names. Metadata about the version (who wrote it, when, which number it is) lives on the
 * row, not in here, so re-saving an identical charter produces an identical digest.
 */
export interface CharterContent {
  readonly goals: readonly CharterGoal[];
  readonly projectIds: readonly string[];
  readonly grants: readonly CapabilityGrant[];
  readonly limits: CharterLimits;
  readonly communication: CharterCommunication;
  readonly emergencyStop: EmergencyStopBehaviour;
  /** ISO date after which this charter no longer authorises anything until reviewed. */
  readonly expiresAt: string | null;
  /** Free text the owner wrote for themselves. Never parsed, never treated as a grant. */
  readonly notes: string | null;
}

/* -------------------------------------------------------------------- digest */

/**
 * A stable fingerprint of what the charter says.
 *
 * Length-prefixed and canonically ordered, for the same reason `auditHash` is: without length
 * prefixes, moving a character across a separator produces a different charter with the same
 * digest, and `JSON.stringify` orders keys by insertion, so two equal charters saved by different
 * code paths would fingerprint differently.
 *
 * The point of it is narrow and worth stating: an authorisation decision records the digest of the
 * charter that authorised it, so a later reader can prove the charter has not been edited
 * underneath a decision. It is not a signature — anyone who can write the table can rewrite both —
 * but it makes silent editing something that shows, which is the property that matters.
 */
export function charterDigest(content: CharterContent): string {
  const parts: readonly string[] = [
    canonicalJson(content.goals),
    canonicalJson([...content.projectIds].sort()),
    canonicalJson(
      [...content.grants].sort((left, right) =>
        left.capability < right.capability ? -1 : left.capability > right.capability ? 1 : 0,
      ),
    ),
    canonicalJson(content.limits),
    canonicalJson(content.communication),
    content.emergencyStop,
    content.expiresAt ?? ' (null)',
    content.notes ?? ' (null)',
  ];
  return createHash('sha256')
    .update(parts.map((part) => `${part.length}:${part}`).join('|'), 'utf8')
    .digest('hex');
}

/* -------------------------------------------------------------- validation */

const scopeListSchema = z.array(z.string().trim().min(1).max(200)).max(200);

const capabilityScopeSchema = z.object({
  projects: scopeListSchema.optional(),
  repositories: scopeListSchema.optional(),
  branches: scopeListSchema.optional(),
  environments: scopeListSchema.optional(),
  releaseChannels: scopeListSchema.optional(),
  connectors: scopeListSchema.optional(),
});

export const capabilityGrantSchema = z.object({
  capability: z.enum(CAPABILITY_CLASSES),
  scope: capabilityScopeSchema,
  maxPerDay: z.number().int().min(1).max(1000).nullable().default(null),
  note: z.string().trim().max(400).nullable().default(null),
});

export const charterContentSchema = z.object({
  goals: z
    .array(
      z.object({
        id: z.string().trim().min(1).max(64),
        statement: z.string().trim().min(3).max(400),
        priority: z.number().int().min(1).max(100),
        projectIds: z.array(z.string().uuid()).max(100).default([]),
      }),
    )
    .max(50)
    .default([]),
  projectIds: z.array(z.string().uuid()).max(200).default([]),
  grants: z
    .array(capabilityGrantSchema)
    .max(CAPABILITY_CLASSES.length * 4)
    .default([]),
  limits: z.object({
    dailySpendUsd: z.number().min(0).max(10_000).nullable().default(null),
    weeklySpendUsd: z.number().min(0).max(50_000).nullable().default(null),
    maxMissionMinutes: z.number().int().min(5).max(720).default(60),
    maxAttempts: z.number().int().min(1).max(5).default(2),
    maxRepairRounds: z.number().int().min(0).max(3).default(1),
    maxParallelAgents: z.number().int().min(1).max(12).default(3),
    reserveFiveHourPercent: z.number().int().min(0).max(90).default(25),
    reserveSevenDayPercent: z.number().int().min(0).max(90).default(20),
  }),
  communication: z.object({
    channels: z.array(z.enum(COMMUNICATION_CHANNELS)).max(4).default(['in_app']),
    quietHoursStart: z
      .string()
      .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
      .nullable()
      .default(null),
    quietHoursEnd: z
      .string()
      .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
      .nullable()
      .default(null),
    timeZone: z.string().trim().min(1).max(64).default('UTC'),
    interruptOn: z.array(z.enum(INTERRUPT_CONDITIONS)).max(20).default([]),
    maxCallsPerDay: z.number().int().min(0).max(20).default(3),
  }),
  emergencyStop: z.enum(EMERGENCY_STOP_BEHAVIOURS).default('halt_preserve'),
  expiresAt: z.string().datetime().nullable().default(null),
  notes: z.string().trim().max(4000).nullable().default(null),
});

export type CharterContentInput = z.infer<typeof charterContentSchema>;

/* ------------------------------------------------------------- grant checks */

export interface GrantProblem {
  readonly capability: CapabilityClass;
  readonly scopeKind: ScopeKind | null;
  readonly reason: string;
}

/**
 * Whether the grants in a charter are well formed, checked before it can ever be activated.
 *
 * Two rules, and both are deny-by-default rather than convenience:
 *
 *  - A dimension a capability is **meaningless without** must be present. An absent dimension is
 *    not an implicit wildcard; it is a charter that forgot to say, and a charter that forgot to say
 *    must not be readable as a charter that said everything.
 *  - A dimension a capability **must enumerate** may not be `*`. "Every repository I own" is a
 *    sentence someone types in a moment and lives with for a long time.
 *
 * Returns every problem rather than the first, because an owner fixing a charter wants the whole
 * list, not a game of whack-a-mole.
 */
export function validateGrants(
  /*
   * Structurally typed to the two fields it reads, rather than to `CapabilityGrant`.
   *
   * The validator is most useful *before* the schema's defaults have been applied — that is when
   * an owner is still editing — and requiring a fully-defaulted object would have forced every
   * caller to parse first and validate second, which is the wrong order for telling someone their
   * charter is not finished yet.
   */
  grants: readonly { readonly capability: CapabilityClass; readonly scope: CapabilityScope }[],
): readonly GrantProblem[] {
  const problems: GrantProblem[] = [];

  for (const grant of grants) {
    const definition = CAPABILITY_BY_CLASS[grant.capability];
    /* Unreachable through the schema, but a charter arriving another way is still checked. */
    if (!definition) {
      problems.push({
        capability: grant.capability,
        scopeKind: null,
        reason: 'That is not a capability Jarvis has.',
      });
      continue;
    }

    for (const kind of definition.scopeKinds) {
      const values = grant.scope[kind];
      if (values === undefined || values.length === 0) {
        problems.push({
          capability: grant.capability,
          scopeKind: kind,
          reason: `${definition.label} needs ${SCOPE_KIND_LABELS[kind].toLowerCase()} to be named. An empty list authorises nothing and a missing one authorises nothing either.`,
        });
        continue;
      }
      if (definition.mustEnumerate.includes(kind) && values.includes(SCOPE_ALL)) {
        problems.push({
          capability: grant.capability,
          scopeKind: kind,
          reason: `${definition.label} may not be granted over every ${SCOPE_KIND_LABELS[kind].toLowerCase().replace(/s$/, '')}. Name them.`,
        });
      }
    }
  }

  /* A capability granted twice is ambiguous about which scope applies, so it is refused. */
  const seen = new Set<CapabilityClass>();
  for (const grant of grants) {
    if (seen.has(grant.capability)) {
      problems.push({
        capability: grant.capability,
        scopeKind: null,
        reason: 'Granted more than once. Combine the scopes into a single grant.',
      });
    }
    seen.add(grant.capability);
  }

  return problems;
}

/**
 * Does a grant's scope contain this value?
 *
 * Exact match or the explicit `*`. Deliberately no prefix matching, no case folding beyond a
 * lower-cased comparison for names GitHub itself treats case-insensitively, and no "close enough":
 * a scope check that resembles is a scope check that eventually resembles the wrong repository.
 */
export function scopeContains(values: readonly string[] | undefined, wanted: string): boolean {
  if (!values || values.length === 0) return false;
  if (values.includes(SCOPE_ALL)) return true;
  const target = wanted.trim().toLowerCase();
  return values.some((value) => value.trim().toLowerCase() === target);
}

/**
 * Branch scope, which is the one dimension where a pattern is genuinely useful.
 *
 * `jarvis/*` is how an owner says "the branches Jarvis makes for itself", and requiring them to
 * enumerate branch names that do not exist yet would make the dimension unusable. The pattern is
 * a single trailing `*` and nothing else — no regular expressions, no `**`, no alternation — so
 * what it matches is obvious by reading it.
 */
export function branchScopeContains(
  values: readonly string[] | undefined,
  branch: string,
): boolean {
  if (!values || values.length === 0) return false;
  const target = branch.trim();
  return values.some((value) => {
    const pattern = value.trim();
    if (pattern === SCOPE_ALL) return true;
    if (pattern.endsWith('/*')) return target.startsWith(pattern.slice(0, -1));
    return pattern === target;
  });
}
