import { z } from 'zod';
import {
  BLOCKER_SEVERITIES,
  FRESHNESS_STATES,
  GOAL_STATUSES,
  MILESTONE_STATES,
  NEXT_ACTION_PRIORITIES,
  NEXT_ACTION_STATUSES,
  PROJECT_PRIORITIES,
  PROJECT_STATUSES,
  PROJECT_TYPES,
  PROVENANCE_LEVELS,
  SOURCE_CAPABILITIES,
  SOURCE_KINDS,
  SYNC_STATUSES,
} from './enums';

/** Trimmed, non-empty, length-bounded text. Used everywhere a human types something. */
const text = (max: number) => z.string().trim().min(1).max(max);
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => (v.length === 0 ? null : v))
    .nullable()
    .optional();

/** ISO-8601 instant. All timestamps are stored and transported in UTC. */
export const isoDateTime = z.iso.datetime({ offset: true });
/** Calendar date (target dates, due dates) — no time component, no timezone ambiguity. */
export const isoDate = z.iso.date();

export const hexColor = z
  .string()
  .trim()
  .regex(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/, 'Must be a hex colour such as #4f46e5');

/**
 * External links are user-supplied. They are only ever rendered as anchors — they are never
 * fetched by the server — and the scheme allow-list keeps `javascript:`/`data:` out of the DOM.
 */
export const externalUrl = z
  .string()
  .trim()
  .max(2048)
  .refine((value) => {
    try {
      const url = new URL(value);
      return url.protocol === 'https:' || url.protocol === 'http:';
    } catch {
      return false;
    }
  }, 'Must be an http(s) URL');

export const externalLinkSchema = z.object({
  label: text(80),
  url: externalUrl,
});
export type ExternalLink = z.infer<typeof externalLinkSchema>;

export const tagSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(1)
  .max(32)
  .regex(
    /^[a-z0-9][a-z0-9 _-]*$/,
    'Tags may contain letters, numbers, spaces, hyphens and underscores',
  );

export const projectTypeSchema = z.enum(PROJECT_TYPES);
export const projectStatusSchema = z.enum(PROJECT_STATUSES);
export const projectPrioritySchema = z.enum(PROJECT_PRIORITIES);
export const provenanceSchema = z.enum(PROVENANCE_LEVELS);
export const freshnessSchema = z.enum(FRESHNESS_STATES);
export const sourceKindSchema = z.enum(SOURCE_KINDS);
export const syncStatusSchema = z.enum(SYNC_STATUSES);
export const sourceCapabilitySchema = z.enum(SOURCE_CAPABILITIES);

/** Everything the owner can set on a project. Used by create and (partially) by update. */
export const projectInputSchema = z.object({
  name: text(120),
  shortName: optionalText(40),
  description: optionalText(4000),
  type: projectTypeSchema,
  status: projectStatusSchema.default('active'),
  phase: optionalText(60),
  goal: optionalText(600),
  priority: projectPrioritySchema.default('medium'),
  targetDate: isoDate.nullable().optional(),
  icon: optionalText(16),
  color: hexColor.nullable().optional(),
  tags: z.array(tagSchema).max(20).default([]),
  links: z.array(externalLinkSchema).max(20).default([]),
});
export type ProjectInput = z.infer<typeof projectInputSchema>;

export const projectUpdateSchema = projectInputSchema.partial();
export type ProjectUpdateInput = z.infer<typeof projectUpdateSchema>;

/** A project as stored and returned by the repository layer. */
export interface Project {
  readonly id: string;
  readonly name: string;
  readonly shortName: string | null;
  readonly description: string | null;
  readonly type: z.infer<typeof projectTypeSchema>;
  readonly status: z.infer<typeof projectStatusSchema>;
  readonly phase: string | null;
  readonly goal: string | null;
  readonly priority: z.infer<typeof projectPrioritySchema>;
  readonly targetDate: string | null;
  readonly icon: string | null;
  readonly color: string | null;
  readonly tags: readonly string[];
  readonly links: readonly ExternalLink[];
  readonly createdAt: string;
  readonly updatedAt: string;
  /** Last time a human explicitly changed something (not a sync, not a briefing). */
  readonly lastManualUpdateAt: string | null;
  /** Last time any source successfully synchronised. */
  readonly lastSyncedAt: string | null;
  readonly archivedAt: string | null;
  /** Derived and persisted by the status engine so list queries stay cheap. */
  readonly freshness: z.infer<typeof freshnessSchema>;
  readonly needsAttention: boolean;
}

/* ------------------------------------------------------------------ sources */

export const githubSourceConfigSchema = z.object({
  owner: z
    .string()
    .trim()
    .min(1)
    .max(39)
    .regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/, 'Invalid GitHub owner'),
  repo: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .regex(/^[A-Za-z0-9._-]+$/, 'Invalid GitHub repository name'),
});
export type GithubSourceConfig = z.infer<typeof githubSourceConfigSchema>;

/**
 * Provider-observed repository facts. Everything is nullable: a credential with partial
 * permissions, an empty repository or a renamed repository must all be representable.
 */
export interface GithubSourceState {
  readonly repoId: number | null;
  readonly owner: string;
  readonly repo: string;
  readonly url: string | null;
  readonly visibility: 'public' | 'private' | 'internal' | null;
  readonly defaultBranch: string | null;
  readonly archived: boolean;
  readonly primaryLanguage: string | null;
  readonly lastActivityAt: string | null;
}

export interface ProjectSource {
  readonly id: string;
  readonly projectId: string;
  readonly kind: z.infer<typeof sourceKindSchema>;
  readonly isPrimary: boolean;
  readonly label: string | null;
  /** Present for `github_repo` sources. */
  readonly github: GithubSourceState | null;
  /** Present for `external_link` sources. */
  readonly externalUrl: string | null;
  readonly syncStatus: z.infer<typeof syncStatusSchema>;
  readonly lastSyncOkAt: string | null;
  readonly lastSyncFailedAt: string | null;
  readonly lastSyncError: string | null;
  readonly availableCapabilities: readonly z.infer<typeof sourceCapabilitySchema>[];
  readonly unavailableCapabilities: readonly z.infer<typeof sourceCapabilitySchema>[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

/* -------------------------------------------------------------- sub-entities */

export const goalInputSchema = z.object({
  statement: text(600),
  successDefinition: optionalText(1200),
  status: z.enum(GOAL_STATUSES).default('open'),
  targetDate: isoDate.nullable().optional(),
});
export type GoalInput = z.infer<typeof goalInputSchema>;

export interface Goal extends GoalInput {
  readonly id: string;
  readonly projectId: string;
  readonly provenance: z.infer<typeof provenanceSchema>;
  readonly sourceSystem: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export const milestoneInputSchema = z.object({
  title: text(160),
  description: optionalText(2000),
  state: z.enum(MILESTONE_STATES).default('planned'),
  position: z.number().int().min(0).max(10_000).default(0),
  targetDate: isoDate.nullable().optional(),
  completedAt: isoDateTime.nullable().optional(),
});
export type MilestoneInput = z.infer<typeof milestoneInputSchema>;

export interface Milestone extends MilestoneInput {
  readonly id: string;
  readonly projectId: string;
  readonly provenance: z.infer<typeof provenanceSchema>;
  readonly sourceSystem: string;
  readonly evidenceIds: readonly string[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export const blockerInputSchema = z.object({
  title: text(160),
  description: optionalText(2000),
  severity: z.enum(BLOCKER_SEVERITIES).default('medium'),
  resolutionRequirement: optionalText(1000),
  requiresOwnerDecision: z.boolean().default(false),
});
export type BlockerInput = z.infer<typeof blockerInputSchema>;

export interface Blocker extends BlockerInput {
  readonly id: string;
  readonly projectId: string;
  readonly isActive: boolean;
  readonly provenance: z.infer<typeof provenanceSchema>;
  readonly sourceSystem: string;
  readonly evidenceIds: readonly string[];
  readonly createdAt: string;
  readonly resolvedAt: string | null;
}

export const decisionInputSchema = z.object({
  title: text(160),
  decision: text(2000),
  reasoning: optionalText(4000),
  decidedOn: isoDate.nullable().optional(),
  supersedesDecisionId: z.uuid().nullable().optional(),
});
export type DecisionInput = z.infer<typeof decisionInputSchema>;

export interface Decision extends DecisionInput {
  readonly id: string;
  readonly projectId: string;
  readonly provenance: z.infer<typeof provenanceSchema>;
  readonly sourceSystem: string;
  readonly evidenceIds: readonly string[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export const manualUpdateInputSchema = z.object({
  whatChanged: text(2000),
  currentWork: optionalText(2000),
  problemsOrRisks: optionalText(2000),
  proposedNextAction: optionalText(1000),
  occurredOn: isoDate.nullable().optional(),
});
export type ManualUpdateInput = z.infer<typeof manualUpdateInputSchema>;

export interface ManualUpdate extends ManualUpdateInput {
  readonly id: string;
  readonly projectId: string;
  readonly provenance: 'manual';
  readonly sourceSystem: string;
  readonly createdAt: string;
}

export const nextActionInputSchema = z.object({
  action: text(400),
  priority: z.enum(NEXT_ACTION_PRIORITIES).default('medium'),
  status: z.enum(NEXT_ACTION_STATUSES).default('open'),
  position: z.number().int().min(0).max(10_000).default(0),
  dueDate: isoDate.nullable().optional(),
  requiresOwner: z.boolean().default(false),
});
export type NextActionInput = z.infer<typeof nextActionInputSchema>;

export interface NextAction extends NextActionInput {
  readonly id: string;
  readonly projectId: string;
  readonly provenance: z.infer<typeof provenanceSchema>;
  readonly sourceSystem: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly completedAt: string | null;
}

/** A project plus everything needed to assess and render it. */
export interface ProjectAggregate {
  readonly project: Project;
  readonly sources: readonly ProjectSource[];
  readonly goals: readonly Goal[];
  readonly milestones: readonly Milestone[];
  readonly blockers: readonly Blocker[];
  readonly decisions: readonly Decision[];
  readonly updates: readonly ManualUpdate[];
  readonly nextActions: readonly NextAction[];
}
