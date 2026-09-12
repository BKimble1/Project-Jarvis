import { z } from 'zod';
import { SUMMARY_METHODS } from './enums';
import type { Claim } from './evidence';
import type { FreshnessState, ProjectStatus, ProvenanceLevel } from './enums';

export const summaryMethodSchema = z.enum(SUMMARY_METHODS);
export type SummaryMethodValue = z.infer<typeof summaryMethodSchema>;

/** A single reason why a project is asking for the owner's time. */
export interface AttentionReason {
  readonly code:
    | 'decision_required'
    | 'active_blocker'
    | 'failed_workflow'
    | 'failed_sync'
    | 'stale_data'
    | 'overdue_action'
    | 'overdue_target_date'
    | 'archived_repository';
  readonly severity: 'critical' | 'high' | 'medium' | 'low';
  readonly summary: string;
  readonly provenance: ProvenanceLevel;
  readonly evidenceIds: readonly string[];
  /** The deterministic rule id that produced this reason. Keeps rules testable and explainable. */
  readonly rule: string;
}

/** A recommended action produced by the deterministic engine (never invented by the narrator). */
export interface RecommendedAction {
  readonly action: string;
  readonly rationale: string;
  readonly provenance: ProvenanceLevel;
  readonly evidenceIds: readonly string[];
  readonly requiresOwner: boolean;
  readonly rule: string;
}

export interface FreshnessAssessment {
  readonly state: FreshnessState;
  readonly observedAt: string | null;
  readonly ageHours: number | null;
  readonly explanation: string;
  /** Present when the most recent synchronisation attempt failed. */
  readonly lastError: string | null;
}

/**
 * The deterministic engine's complete, UI-agnostic verdict about one project.
 * Layer 2 (narration) may reword `headline` and reorder `recommendedActions`; it may not add,
 * remove or contradict anything here.
 */
export interface ProjectAssessment {
  readonly projectId: string;
  readonly generatedAt: string;
  readonly status: ProjectStatus;
  /** `derivedStatus` differs from the stored status when evidence contradicts it. */
  readonly statusProvenance: ProvenanceLevel;
  readonly phase: string | null;
  readonly phaseProvenance: ProvenanceLevel;
  readonly headline: Claim;
  readonly recentlyCompleted: readonly Claim[];
  readonly currentWork: readonly Claim[];
  readonly activeBlockers: readonly Claim[];
  readonly decisionsNeeded: readonly Claim[];
  readonly recommendedActions: readonly RecommendedAction[];
  readonly attention: readonly AttentionReason[];
  readonly needsAttention: boolean;
  readonly freshness: FreshnessAssessment;
  readonly unknowns: readonly string[];
  readonly keyEvidenceIds: readonly string[];
  /** Stable hash of everything above; used to avoid re-calling the narrator for no reason. */
  readonly evidenceFingerprint: string;
}

/** What the narrator (deterministic or AI) returns. Validated against a schema either way. */
export const briefingNarrativeSchema = z.object({
  currentState: z.string().trim().min(1).max(400),
  recentlyCompleted: z.array(z.string().trim().min(1).max(300)).max(8).default([]),
  inProgress: z.array(z.string().trim().min(1).max(300)).max(8).default([]),
  blockers: z.array(z.string().trim().min(1).max(300)).max(8).default([]),
  decisionsNeeded: z.array(z.string().trim().min(1).max(300)).max(8).default([]),
  nextActions: z.array(z.string().trim().min(1).max(300)).max(3).default([]),
  unknowns: z.array(z.string().trim().min(1).max(300)).max(8).default([]),
  /** Evidence IDs the narrator relied on. Any ID not supplied to it is rejected. */
  citedEvidenceIds: z.array(z.string().min(1).max(64)).max(40).default([]),
});
export type BriefingNarrative = z.infer<typeof briefingNarrativeSchema>;

/** A briefing = deterministic assessment + narration + the method that produced the narration. */
export interface ProjectBriefing {
  readonly assessment: ProjectAssessment;
  readonly narrative: BriefingNarrative;
  readonly method: SummaryMethodValue;
  readonly generatedAt: string;
  readonly narratorError: string | null;
}

export interface PortfolioCounts {
  readonly total: number;
  readonly active: number;
  readonly progressing: number;
  readonly needsAttention: number;
  readonly blocked: number;
  readonly waiting: number;
  readonly paused: number;
  readonly completed: number;
  readonly stale: number;
  readonly archived: number;
  readonly syncFailing: number;
}

export interface PortfolioAssessment {
  readonly generatedAt: string;
  readonly counts: PortfolioCounts;
  readonly progressingProjectIds: readonly string[];
  readonly needsAttentionProjectIds: readonly string[];
  readonly blockedProjectIds: readonly string[];
  readonly waitingProjectIds: readonly string[];
  readonly pausedProjectIds: readonly string[];
  readonly staleProjectIds: readonly string[];
  readonly recentChanges: readonly PortfolioChange[];
  readonly decisionsNeeded: readonly AttentionReason[];
  readonly focusOrder: readonly FocusEntry[];
  readonly unknowns: readonly string[];
}

export interface FocusEntry {
  readonly projectId: string;
  readonly projectName: string;
  readonly reason: string;
  readonly provenance: ProvenanceLevel;
  readonly rank: number;
}

export interface PortfolioChange {
  readonly projectId: string;
  readonly projectName: string;
  readonly summary: string;
  readonly occurredAt: string;
  readonly provenance: ProvenanceLevel;
  readonly evidenceIds: readonly string[];
}

export interface PortfolioBriefing {
  readonly assessment: PortfolioAssessment;
  readonly narrative: PortfolioNarrative;
  readonly method: SummaryMethodValue;
  readonly generatedAt: string;
  readonly narratorError: string | null;
}

export const portfolioNarrativeSchema = z.object({
  headline: z.string().trim().min(1).max(400),
  importantChanges: z.array(z.string().trim().min(1).max(300)).max(10).default([]),
  decisionsNeeded: z.array(z.string().trim().min(1).max(300)).max(10).default([]),
  focusOrder: z.array(z.string().trim().min(1).max(300)).max(10).default([]),
  unknowns: z.array(z.string().trim().min(1).max(300)).max(10).default([]),
  citedEvidenceIds: z.array(z.string().min(1).max(64)).max(60).default([]),
});
export type PortfolioNarrative = z.infer<typeof portfolioNarrativeSchema>;

/* --------------------------------------------------------------- snapshots */

export interface StatusSnapshot {
  readonly id: string;
  readonly projectId: string;
  readonly generatedAt: string;
  readonly status: ProjectStatus;
  readonly phase: string | null;
  readonly headline: string;
  readonly recentlyCompleted: readonly Claim[];
  readonly currentWork: readonly Claim[];
  readonly blockers: readonly Claim[];
  readonly decisionsNeeded: readonly Claim[];
  readonly recommendedActions: readonly RecommendedAction[];
  readonly evidenceIds: readonly string[];
  readonly freshness: FreshnessAssessment;
  readonly unknowns: readonly string[];
  readonly summaryMethod: SummaryMethodValue;
  readonly fingerprint: string;
  /** The narrative stored with the snapshot, reused when evidence has not changed. */
  readonly narrative: unknown;
}

export const CHANGE_KINDS = [
  'work_completed',
  'blocker_added',
  'blocker_resolved',
  'status_changed',
  'phase_changed',
  'workflow_failed',
  'workflow_recovered',
  'pr_opened',
  'pr_merged',
  'decision_recorded',
  'next_actions_changed',
] as const;
export type ChangeKind = (typeof CHANGE_KINDS)[number];

export interface StatusChange {
  readonly kind: ChangeKind;
  readonly projectId: string;
  readonly summary: string;
  readonly detail: string | null;
  readonly provenance: ProvenanceLevel;
  readonly evidenceIds: readonly string[];
  readonly occurredAt: string;
}
