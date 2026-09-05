import { z } from 'zod';
import {
  AGENT_ROLES,
  PERMISSION_PROFILE_IDS,
  ceilingForRole,
  isWithinCeiling,
  narrowProfile,
  profileNarrowingSchema,
  resolvePermissionProfile,
  type AgentRole,
} from './agent-role';
import {
  TASK_TYPES,
  WORKSPACE_REQUIREMENTS,
  taskKeySchema,
  type TaskProposal,
} from './mission-task';
import { DEFAULT_GRAPH_LIMITS } from './task-graph';
import { PROJECT_TYPES, type ProjectType } from './enums';

/**
 * Reusable, versioned playbooks.
 *
 * A playbook is a *template for a task graph*, not a script and not a permission grant. It says
 * what shape a kind of work usually takes — which roles, in what order, with which checks and
 * which reviews — so that "build a feature", "chase a bug" or "audit this repository" do not have
 * to be re-invented every time.
 *
 * Three properties matter more than the convenience:
 *
 *  1. **A playbook can only narrow.** Every permission it names is checked against the ceiling of
 *     the role it names (`isWithinCeiling`), and every required check it *adds* is additive. The
 *     schema has no field for removing a globally required check, and `mergeRequiredChecks` takes
 *     a union rather than a replacement — so there is no expression in this language that means
 *     "skip the tests".
 *  2. **A playbook is versioned and pinned.** Running one records the exact version; editing one
 *     creates a new version and never changes what a running mission is following.
 *  3. **An agent may recommend a playbook; it may never install, edit or enable one.** That is
 *     enforced at the route layer, but the shape here supports it: a playbook has no field an
 *     agent's output feeds into.
 */

/* ------------------------------------------------------------------ the shape */

export const PLAYBOOK_RISK_LEVELS = ['read_only', 'low', 'moderate', 'high'] as const;
export type PlaybookRiskLevel = (typeof PLAYBOOK_RISK_LEVELS)[number];

export const PLAYBOOK_INPUT_KINDS = [
  'text',
  'long_text',
  'choice',
  'boolean',
  'repository',
] as const;
export type PlaybookInputKind = (typeof PLAYBOOK_INPUT_KINDS)[number];

export const playbookInputSchema = z.object({
  key: z
    .string()
    .trim()
    .regex(/^[a-z][a-z0-9_]{1,40}$/, 'An input key is lower_snake_case.'),
  label: z.string().trim().min(2).max(120),
  kind: z.enum(PLAYBOOK_INPUT_KINDS),
  required: z.boolean().default(false),
  help: z.string().trim().max(400).nullish(),
  choices: z.array(z.string().trim().min(1).max(120)).max(20).default([]),
  default: z.string().trim().max(400).nullish(),
});
export type PlaybookInput = z.infer<typeof playbookInputSchema>;

/** One task template. Mirrors `TaskProposal` but with placeholders and conditions. */
export const playbookTaskSchema = z.object({
  key: taskKeySchema,
  title: z.string().trim().min(3).max(160),
  description: z.string().trim().min(3).max(4000),
  role: z.enum(AGENT_ROLES),
  /** Optional and always checked against the role's ceiling. Never a way to gain capability. */
  permissionProfileId: z.enum(PERMISSION_PROFILE_IDS).optional(),
  narrowing: profileNarrowingSchema.optional(),
  taskType: z.enum(TASK_TYPES),
  dependsOn: z.array(taskKeySchema).max(20).default([]),
  workspaceRequirement: z.enum(WORKSPACE_REQUIREMENTS),
  requiresRepository: z.boolean().default(true),
  expectedFileAreas: z.array(z.string().trim().min(1).max(200)).max(40).default([]),
  declaredWriteSet: z.array(z.string().trim().min(1).max(200)).max(60).default([]),
  acceptanceCriteria: z.array(z.string().trim().min(1).max(400)).max(20).default([]),
  expectedInputs: z.array(z.string().trim().min(1).max(300)).max(20).default([]),
  expectedOutputs: z.array(z.string().trim().min(1).max(300)).max(20).default([]),
  maxAttempts: z.number().int().min(1).max(3).default(1),
  reviewsTaskKey: taskKeySchema.nullish(),
  repairRound: z.number().int().min(0).max(3).default(0),
  estimatedCost: z.enum(['small', 'medium', 'large']).default('medium'),
  /**
   * When this task is included.
   *
   * `always` is the default. The conditions are evaluated by deterministic code against the
   * mission, never by a model, so a playbook cannot talk its way into including a task.
   */
  condition: z
    .enum([
      'always',
      'if_repository',
      'if_no_repository',
      'if_web_research_allowed',
      'if_write_mission',
      'if_ios_project',
      'if_website_project',
    ])
    .default('always'),
});
export type PlaybookTask = z.infer<typeof playbookTaskSchema>;

export const playbookCheckSchema = z.object({
  /** A key the worker maps to a real command via the repository's own configuration. */
  id: z.string().trim().min(1).max(60),
  label: z.string().trim().min(2).max(120),
  /** Additive only: a playbook may make a check required, never make one optional. */
  required: z.boolean().default(true),
  /** True when a failure stops delivery rather than merely being reported. */
  blocksDelivery: z.boolean().default(true),
});
export type PlaybookCheck = z.infer<typeof playbookCheckSchema>;

export const playbookDefinitionSchema = z.object({
  key: z
    .string()
    .trim()
    .regex(/^[a-z][a-z0-9_]{2,48}$/, 'A playbook key is lower_snake_case.'),
  name: z.string().trim().min(3).max(120),
  description: z.string().trim().min(10).max(1000),
  supportedProjectTypes: z.array(z.enum(PROJECT_TYPES)).max(PROJECT_TYPES.length).default([]),
  riskLevel: z.enum(PLAYBOOK_RISK_LEVELS),
  inputs: z.array(playbookInputSchema).max(12).default([]),
  tasks: z.array(playbookTaskSchema).min(1).max(DEFAULT_GRAPH_LIMITS.maxTasks),
  /** Checks this playbook adds on top of whatever is globally required. */
  additionalChecks: z.array(playbookCheckSchema).max(20).default([]),
  /** Reviews this playbook always requires, on top of the deterministic triggers. */
  requiredReviews: z.array(z.enum(AGENT_ROLES)).max(6).default([]),
  ownerApprovalPoints: z.array(z.string().trim().min(3).max(200)).max(10).default([]),
  maxParallelTasks: z.number().int().min(1).max(6).default(3),
  maxRepairRounds: z.number().int().min(0).max(3).default(2),
  expectedArtifacts: z.array(z.string().trim().min(1).max(200)).max(12).default([]),
  completionDefinition: z.string().trim().min(10).max(1000),
  /** True when this playbook can ask for an external build. Forces a release verifier. */
  canDispatchExternalBuild: z.boolean().default(false),
});
export type PlaybookDefinition = z.infer<typeof playbookDefinitionSchema>;

export interface Playbook {
  readonly id: string;
  readonly key: string;
  readonly name: string;
  readonly description: string;
  readonly builtIn: boolean;
  readonly enabled: boolean;
  readonly latestVersion: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface PlaybookVersion {
  readonly id: string;
  readonly playbookId: string;
  readonly playbookKey: string;
  readonly version: number;
  readonly definition: PlaybookDefinition;
  readonly fingerprint: string;
  readonly createdAt: string;
  readonly createdBy: string;
  readonly note: string | null;
}

/* --------------------------------------------------------------- validation */

export interface PlaybookViolation {
  readonly rule: string;
  readonly message: string;
  readonly taskKey: string | null;
}

export interface PlaybookValidationResult {
  readonly ok: boolean;
  readonly violations: readonly PlaybookViolation[];
}

const bad = (rule: string, message: string, taskKey: string | null = null): PlaybookViolation => ({
  rule,
  message,
  taskKey,
});

/**
 * Is this playbook safe to install?
 *
 * The permission ceiling check (R-PB4/R-PB5) is the security-relevant one: everything a playbook
 * says about permissions is compared against what the role it names already allows, and anything
 * wider is rejected outright rather than silently clamped. Silent clamping would leave an author
 * believing their playbook does something it does not.
 */
export function validatePlaybook(definition: PlaybookDefinition): PlaybookValidationResult {
  const violations: PlaybookViolation[] = [];
  const keys = new Set<string>();

  for (const task of definition.tasks) {
    if (keys.has(task.key))
      violations.push(bad('R-PB1', `Two tasks share the key ${task.key}.`, task.key));
    keys.add(task.key);
  }

  for (const task of definition.tasks) {
    for (const dependency of task.dependsOn) {
      if (!keys.has(dependency)) {
        violations.push(
          bad(
            'R-PB2',
            `${task.key} depends on ${dependency}, which this playbook does not define.`,
            task.key,
          ),
        );
      }
    }
    if (task.reviewsTaskKey && !keys.has(task.reviewsTaskKey)) {
      violations.push(
        bad(
          'R-PB3',
          `${task.key} reviews ${task.reviewsTaskKey}, which this playbook does not define.`,
          task.key,
        ),
      );
    }

    let ceiling;
    try {
      ceiling = ceilingForRole(task.role);
    } catch {
      violations.push(bad('R-PB4', `${task.key} names a role that does not exist.`, task.key));
      continue;
    }

    if (task.permissionProfileId) {
      let proposed;
      try {
        proposed = resolvePermissionProfile(task.permissionProfileId);
      } catch {
        violations.push(
          bad('R-PB5', `${task.key} names a permission profile that does not exist.`, task.key),
        );
        continue;
      }
      if (!isWithinCeiling(proposed, ceiling)) {
        violations.push(
          bad(
            'R-PB6',
            `${task.key} asks for ${proposed.id}, which is wider than ${task.role} may ever be.`,
            task.key,
          ),
        );
      }
    }

    if (task.narrowing) {
      const narrowed = narrowProfile(ceiling, task.narrowing);
      if (!isWithinCeiling(narrowed, ceiling)) {
        /* Defensive: `narrowProfile` cannot widen, and this asserts it for every playbook too. */
        violations.push(
          bad('R-PB7', `${task.key} narrows its profile into something wider.`, task.key),
        );
      }
    }
  }

  /*
   * Every combination of `required` and `blocksDelivery` means something real:
   * required+blocking must run and stops delivery; required+non-blocking must run and is merely
   * reported; optional+blocking blocks if it runs and fails; optional+non-blocking is advisory.
   * So there is nothing to reject there. What *is* an author mistake is naming the same check
   * twice, because the second definition silently wins.
   */
  const checkIds = new Set<string>();
  for (const check of definition.additionalChecks) {
    if (checkIds.has(check.id)) {
      violations.push(bad('R-PB8', `The check "${check.id}" is defined twice.`));
    }
    checkIds.add(check.id);
  }

  if (
    definition.canDispatchExternalBuild &&
    !definition.requiredReviews.includes('release_verifier')
  ) {
    violations.push(
      bad(
        'R-PB9',
        'A playbook that can trigger an external build must require a release verifier.',
      ),
    );
  }

  if (definition.maxRepairRounds > DEFAULT_GRAPH_LIMITS.maxRepairRounds) {
    violations.push(
      bad(
        'R-PB10',
        `This playbook asks for ${definition.maxRepairRounds} repair rounds; Jarvis allows ${DEFAULT_GRAPH_LIMITS.maxRepairRounds}.`,
      ),
    );
  }

  const writeTasks = definition.tasks.filter(
    (task) => task.role === 'builder' || task.role === 'repairer',
  );
  if (writeTasks.length > 0 && definition.riskLevel === 'read_only') {
    violations.push(
      bad('R-PB11', 'This playbook is marked read-only but contains tasks that change files.'),
    );
  }

  return { ok: violations.length === 0, violations };
}

/* ------------------------------------------------------------- instantiation */

export interface PlaybookContext {
  readonly hasRepository: boolean;
  readonly allowWebResearch: boolean;
  readonly missionWrites: boolean;
  readonly projectType: ProjectType | null;
  readonly inputs: Readonly<Record<string, string>>;
}

function conditionHolds(task: PlaybookTask, context: PlaybookContext): boolean {
  switch (task.condition) {
    case 'always':
      return true;
    case 'if_repository':
      return context.hasRepository;
    case 'if_no_repository':
      return !context.hasRepository;
    case 'if_web_research_allowed':
      return context.allowWebResearch;
    case 'if_write_mission':
      return context.missionWrites;
    case 'if_ios_project':
      return (
        context.projectType === 'software' &&
        /ios|iphone|ipad|swift/i.test(context.inputs.platform ?? '')
      );
    case 'if_website_project':
      return (
        context.projectType === 'software' &&
        /web|site|marketing/i.test(context.inputs.platform ?? '')
      );
    default:
      return false;
  }
}

/**
 * Fill in the templates and drop the tasks whose conditions do not hold.
 *
 * Dependencies on a dropped task are removed rather than left dangling, so a graph produced here
 * always satisfies R-TG04. `{{input}}` substitution is textual and bounded: values come from the
 * owner's own answers, and they land in descriptions, never in a command, a path or a branch.
 */
export function instantiatePlaybook(
  definition: PlaybookDefinition,
  context: PlaybookContext,
): readonly TaskProposal[] {
  const included = definition.tasks.filter((task) => conditionHolds(task, context));
  const includedKeys = new Set(included.map((task) => task.key));

  const substitute = (text: string): string =>
    text.replace(/\{\{\s*([a-z][a-z0-9_]{0,40})\s*\}\}/g, (match, key: string) => {
      const value = context.inputs[key];
      return value === undefined ? match : value.slice(0, 400);
    });

  return included.map((task) => ({
    key: task.key,
    title: substitute(task.title).slice(0, 160),
    description: substitute(task.description).slice(0, 4000),
    role: task.role,
    ...(task.permissionProfileId ? { permissionProfileId: task.permissionProfileId } : {}),
    taskType: task.taskType,
    dependsOn: task.dependsOn.filter((key) => includedKeys.has(key)),
    expectedInputs: task.expectedInputs,
    expectedOutputs: task.expectedOutputs,
    acceptanceCriteria: task.acceptanceCriteria.map(substitute),
    workspaceRequirement: task.workspaceRequirement,
    requiresRepository: task.requiresRepository,
    expectedFileAreas: task.expectedFileAreas,
    declaredWriteSet: task.declaredWriteSet,
    maxAttempts: task.maxAttempts,
    ...(task.reviewsTaskKey && includedKeys.has(task.reviewsTaskKey)
      ? { reviewsTaskKey: task.reviewsTaskKey }
      : {}),
    repairRound: task.repairRound,
    estimatedCost: task.estimatedCost,
  }));
}

/**
 * Combine globally required checks with a playbook's own.
 *
 * A union, deliberately. There is no argument order and no flag by which a playbook's entry
 * replaces a global one: where both name the same check, the *stricter* pair of flags wins. That
 * is what "a playbook may add checks but may not remove globally required ones" means in code.
 */
export function mergeRequiredChecks(
  global: readonly PlaybookCheck[],
  fromPlaybook: readonly PlaybookCheck[],
): readonly PlaybookCheck[] {
  const merged = new Map<string, PlaybookCheck>();
  for (const check of global) merged.set(check.id, check);
  for (const check of fromPlaybook) {
    const existing = merged.get(check.id);
    merged.set(
      check.id,
      existing
        ? {
            ...existing,
            required: existing.required || check.required,
            blocksDelivery: existing.blocksDelivery || check.blocksDelivery,
          }
        : check,
    );
  }
  return [...merged.values()];
}

/** The material content of a playbook version, for fingerprinting. */
export function playbookMaterialContent(definition: PlaybookDefinition): string {
  return JSON.stringify(definition, Object.keys(definition).sort());
}

/* ------------------------------------------------------------------ schemas */

export const playbookInstallSchema = z.object({
  definition: playbookDefinitionSchema,
  note: z.string().trim().max(1000).nullish(),
});

export const playbookToggleSchema = z.object({
  enabled: z.boolean(),
});

export const playbookRunRequestSchema = z.object({
  playbookKey: z
    .string()
    .trim()
    .regex(/^[a-z][a-z0-9_]{2,48}$/),
  /** Pinned by the caller so a playbook edited mid-flight cannot change what runs. */
  playbookVersion: z.number().int().min(1),
  inputs: z.record(z.string().max(48), z.string().max(2000)).default({}),
});
export type PlaybookRunRequestInput = z.infer<typeof playbookRunRequestSchema>;

export function playbookSupportsProject(
  definition: PlaybookDefinition,
  projectType: ProjectType | null,
): boolean {
  if (definition.supportedProjectTypes.length === 0) return true;
  if (!projectType) return false;
  return definition.supportedProjectTypes.includes(projectType);
}

export function requiredReviewRoles(definition: PlaybookDefinition): readonly AgentRole[] {
  return definition.requiredReviews;
}
