import { z } from 'zod';
import { MISSION_RISK_LEVELS, type MissionRiskLevel } from './mission';
import type { ProvenanceLevel } from './enums';

/**
 * Mission plans.
 *
 * A plan is immutable. Editing one produces a new version, and approval is recorded against a
 * specific version — so "approve" can never mean "approve whatever this becomes later".
 */

const line = z.string().trim().min(1).max(500);
const lines = (max: number) => z.array(line).max(max);

export const VERIFICATION_SOURCES = [
  'package_script',
  'makefile',
  'ci_workflow',
  'documentation',
  'agent_inference',
  'configured',
] as const;
export type VerificationSource = (typeof VERIFICATION_SOURCES)[number];

/** A command the plan proposes to run. Bounded and shell-free: an argv, not a command line. */
export const plannedVerificationSchema = z.object({
  command: z.string().trim().min(1).max(300),
  purpose: z.string().trim().min(1).max(300),
  source: z.enum(VERIFICATION_SOURCES),
  /** Set when the worker's platform cannot run it (an iOS archive on Linux, for example). */
  expectedUnavailableReason: z.string().trim().max(300).nullish(),
});
export type PlannedVerification = z.infer<typeof plannedVerificationSchema>;

export const planRiskSchema = z.object({
  description: line,
  mitigation: z.string().trim().min(1).max(500),
  severity: z.enum(['critical', 'high', 'medium', 'low']),
});
export type PlanRisk = z.infer<typeof planRiskSchema>;

export const missionPlanContentSchema = z.object({
  summary: z.string().trim().min(1).max(2000),
  proposedOutcome: z.string().trim().min(1).max(2000),
  assumptions: lines(20).default([]),
  scope: lines(30).default([]),
  outOfScope: lines(30).default([]),
  affectedAreas: lines(40).default([]),
  approach: z.string().trim().min(1).max(6000),
  dataMigrations: lines(15).default([]),
  testsToAddOrUpdate: lines(30).default([]),
  verification: z.array(plannedVerificationSchema).max(15).default([]),
  uiValidation: lines(15).default([]),
  risks: z.array(planRiskSchema).max(20).default([]),
  rollback: z.string().trim().min(1).max(2000),
  acceptanceCriteria: lines(20).default([]),
  openQuestions: lines(15).default([]),
  estimatedComplexity: z.enum(['trivial', 'small', 'medium', 'large', 'unknown']),
  /** The plan's own answer to "did I stay inside what was asked for?". */
  withinRequestedScope: z.boolean(),
  scopeNotes: z.string().trim().max(1000).nullish(),
  /**
   * True when executing this plan produces only a branch and a draft pull request — nothing
   * merged, published, deployed or uploaded. High-risk missions may only run when this is true.
   */
  reviewOnlyDelivery: z.boolean().default(true),
  /** Jarvis evidence ids the plan was built from. Keeps a plan auditable like any other claim. */
  evidenceIds: z.array(z.string().min(1).max(64)).max(60).default([]),
  /** Repository facts the plan depends on, re-checked before execution. */
  repositoryFacts: z
    .object({
      defaultBranch: z.string().trim().max(255).nullish(),
      headSha: z.string().trim().max(64).nullish(),
      repositoryFullName: z.string().trim().max(255).nullish(),
    })
    .default({}),
});
export type MissionPlanContent = z.infer<typeof missionPlanContentSchema>;

export const PLAN_AUTHORS = ['worker_inspection', 'owner_edit', 'jarvis_deterministic'] as const;
export type PlanAuthor = (typeof PLAN_AUTHORS)[number];

export interface MissionPlan {
  readonly id: string;
  readonly missionId: string;
  readonly version: number;
  readonly content: MissionPlanContent;
  readonly author: PlanAuthor;
  /** `verified` when built from inspected repository facts; `inferred` for a deterministic draft. */
  readonly provenance: ProvenanceLevel;
  readonly riskLevel: MissionRiskLevel;
  readonly runId: string | null;
  readonly createdAt: string;
  readonly supersededAt: string | null;
  /** SHA-256 of the content, so an "edit" that changes nothing does not create a version. */
  readonly fingerprint: string;
}

export interface MissionApproval {
  readonly id: string;
  readonly missionId: string;
  readonly planId: string;
  readonly planVersion: number;
  readonly approvedBy: string;
  readonly approvedAt: string;
  readonly approvedRiskLevel: MissionRiskLevel;
  readonly approvedScope: readonly string[];
  readonly note: string | null;
  readonly revokedAt: string | null;
  readonly revokedReason: string | null;

  /**
   * V2: which standing authority approved this, when a person did not.
   *
   * All three null on an owner approval, all three set on a charter one. `approvedBy` reads
   * `charter` in that case, and the digest is stored beside the version id so a later audit can
   * prove the charter it reads now is the charter that was read then.
   */
  readonly charterVersionId: string | null;
  readonly charterDigest: string | null;
  readonly authorizationDecisionId: string | null;
}

export const planApprovalSchema = z.object({
  planVersion: z.number().int().min(1),
  note: z.string().trim().max(1000).nullish(),
  /** The owner must acknowledge the risk level shown to them, not an older one. */
  acknowledgedRiskLevel: z.enum(MISSION_RISK_LEVELS),
  /** Required only when the project is paused: a deliberate, recorded one-time override. */
  pausedProjectOverride: z.boolean().default(false),
});
export type PlanApprovalInput = z.infer<typeof planApprovalSchema>;

export const planRevisionSchema = z.object({
  /** Free-text instruction for the next planning pass. */
  instruction: z.string().trim().min(1).max(2000),
});

/** An owner edit replaces the whole content: a partial patch would make versions ambiguous. */
export const planEditSchema = z.object({
  content: missionPlanContentSchema,
  reason: z.string().trim().max(1000).nullish(),
});
export type PlanEditInput = z.infer<typeof planEditSchema>;

/**
 * Did anything the worker must rely on change between approval and execution?
 *
 * Returns the specific facts that moved, so Jarvis can say what changed rather than just
 * refusing. An empty array means the approved plan is still valid.
 */
export function planFactsChanged(
  plan: MissionPlanContent,
  current: {
    defaultBranch: string | null;
    headSha: string | null;
    repositoryFullName: string | null;
  },
): readonly string[] {
  const changes: string[] = [];
  const facts = plan.repositoryFacts;
  if (
    facts.repositoryFullName &&
    current.repositoryFullName &&
    facts.repositoryFullName !== current.repositoryFullName
  ) {
    changes.push(
      `The repository is now ${current.repositoryFullName}; the plan was made against ${facts.repositoryFullName}.`,
    );
  }
  if (
    facts.defaultBranch &&
    current.defaultBranch &&
    facts.defaultBranch !== current.defaultBranch
  ) {
    changes.push(
      `The default branch is now ${current.defaultBranch}; the plan was made against ${facts.defaultBranch}.`,
    );
  }
  if (facts.headSha && current.headSha && facts.headSha !== current.headSha) {
    changes.push(
      `${facts.defaultBranch ?? 'The base branch'} has moved on since the plan was made.`,
    );
  }
  return changes;
}
