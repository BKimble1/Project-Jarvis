import { z } from 'zod';
import type { AgentRole } from './agent-role';
import type { TaskState } from './mission-task';
import type { ReviewVerdict, FindingSeverity } from './mission-review';
import type { VerificationOutcome } from './mission-run';

/**
 * The completion receipt.
 *
 * A mission is delivery-ready when Jarvis can produce one of these, and the reason it exists is a
 * single sentence: **"done" is ambiguous and this makes it unambiguous.** Code written, checks
 * run, review passed, pull request opened, pull request merged, deployed, uploaded to TestFlight,
 * released — those are eight different things, and Prompt 3's job is to never let the first be
 * reported as the last.
 *
 * So the receipt does not have a `status` field. It has a *ladder*, every rung of which is
 * separately true or false, with the evidence that makes it so. A receipt whose `codeCompleted`
 * is true and whose `pullRequestMerged` is false says exactly that, in those words, on screen.
 */

/* ------------------------------------------------------------- the ladder */

export const DELIVERY_STAGES = [
  'code_completed',
  'verification_completed',
  'review_completed',
  'pull_request_created',
  'pull_request_merged',
  'deployed',
  'testflight_uploaded',
  'production_released',
] as const;
export type DeliveryStage = (typeof DELIVERY_STAGES)[number];

export const DELIVERY_STAGE_LABELS: Record<DeliveryStage, string> = {
  code_completed: 'Code written',
  verification_completed: 'Checks run',
  review_completed: 'Independently reviewed',
  pull_request_created: 'Draft pull request opened',
  pull_request_merged: 'Pull request merged',
  deployed: 'Deployed',
  testflight_uploaded: 'Uploaded to TestFlight',
  production_released: 'Released to production',
};

/**
 * What Jarvis is capable of doing at all.
 *
 * The last four rungs are `false` in every receipt Prompt 3 can produce, and they are shown
 * anyway — an owner reading a receipt should be able to see the ceiling, not infer it. If a later
 * phase ever makes one of these reachable, the ladder is where it becomes visible.
 */
export const STAGES_JARVIS_NEVER_PERFORMS = [
  'pull_request_merged',
  'deployed',
  'production_released',
] as const satisfies readonly DeliveryStage[];

export interface DeliveryStageState {
  readonly stage: DeliveryStage;
  readonly reached: boolean;
  /** How Jarvis knows. Empty when the stage was not reached. */
  readonly evidence: string | null;
  /** Present when Jarvis structurally cannot reach this stage. */
  readonly unreachableReason: string | null;
}

/* -------------------------------------------------------------- the receipt */

export interface ReceiptTaskOutcome {
  readonly key: string;
  readonly title: string;
  readonly role: AgentRole;
  readonly state: TaskState;
  readonly branchName: string | null;
  readonly changedFiles: number;
  readonly attempt: number;
  readonly outputTokens: number | null;
  readonly durationMs: number | null;
  readonly failureMessage: string | null;
}

export interface ReceiptReviewOutcome {
  readonly reviewerRole: AgentRole;
  readonly verdict: ReviewVerdict;
  readonly repairRound: number;
  readonly summary: string;
  readonly blockingFindings: number;
  readonly totalFindings: number;
  readonly diffFingerprint: string;
}

export interface ReceiptFinding {
  readonly key: string;
  readonly severity: FindingSeverity;
  readonly title: string;
  readonly state: string;
  readonly file: string | null;
  readonly repairRound: number;
}

export interface ReceiptVerification {
  readonly check: string;
  readonly outcome: VerificationOutcome;
  readonly required: boolean;
  readonly blocksDelivery: boolean;
  readonly exitCode: number | null;
  readonly detail: string | null;
}

export interface CompletionReceiptContent {
  readonly missionId: string;
  readonly missionTitle: string;
  readonly rawRequest: string;
  readonly projectName: string | null;
  readonly planVersion: number;
  readonly graphVersion: number;
  readonly playbook: { readonly key: string; readonly version: number } | null;

  readonly agents: readonly { readonly role: AgentRole; readonly runs: number }[];
  readonly tasks: readonly ReceiptTaskOutcome[];

  readonly integrationBranch: string | null;
  readonly taskBranches: readonly string[];
  readonly integrationResult: 'clean' | 'conflicted' | 'not_required' | 'not_attempted';
  readonly integrationDetail: string | null;

  readonly changedFiles: readonly string[];
  readonly diffSummary: {
    readonly files: number;
    readonly insertions: number;
    readonly deletions: number;
  } | null;

  readonly verification: readonly ReceiptVerification[];
  readonly reviews: readonly ReceiptReviewOutcome[];
  readonly repairedFindings: readonly ReceiptFinding[];
  readonly remainingFindings: readonly ReceiptFinding[];
  readonly unresolvedRisks: readonly string[];

  readonly artifacts: readonly {
    readonly id: string;
    readonly title: string;
    readonly kind: string;
  }[];
  readonly pullRequestUrl: string | null;
  readonly pullRequestNumber: number | null;

  readonly usage: {
    readonly outputTokens: number | null;
    readonly inputTokens: number | null;
    readonly durationMs: number | null;
    readonly agentRuns: number;
    /** An estimate the runtime reported, if it reported one. Never computed from tokens here. */
    readonly estimatedCostUsd: number | null;
  };

  readonly stages: readonly DeliveryStageState[];
  /** What the owner has to do, in order. Written as instructions, not as congratulations. */
  readonly nextSteps: readonly string[];
  readonly generatedAt: string;
}

export interface CompletionReceipt {
  readonly id: string;
  readonly missionId: string;
  readonly graphVersion: number;
  readonly planVersion: number;
  readonly content: CompletionReceiptContent;
  readonly createdAt: string;
}

/* ------------------------------------------------------------- construction */

export interface ReceiptStageInput {
  readonly hasChangedFiles: boolean;
  readonly verification: readonly ReceiptVerification[];
  readonly reviews: readonly ReceiptReviewOutcome[];
  readonly pullRequestUrl: string | null;
  readonly testFlightUploaded: boolean;
  readonly testFlightEvidence: string | null;
}

/**
 * Work out which rungs are true.
 *
 * Every `reached: true` carries an evidence string naming the thing that makes it true. That is
 * the whole mechanism: a stage cannot be marked reached without something to point at, so a
 * receipt that claims review passed has to name the verdict that says so.
 */
export function buildDeliveryStages(input: ReceiptStageInput): readonly DeliveryStageState[] {
  const required = input.verification.filter((check) => check.required);
  const allRequiredRan =
    required.length > 0 && required.every((check) => check.outcome !== 'skipped');
  const requiredPassed = required.filter((check) => check.outcome === 'passed').length;
  const deliverableReview = input.reviews.find(
    (review) => review.verdict === 'approved' || review.verdict === 'approved_with_notes',
  );

  const stage = (
    stageId: DeliveryStage,
    reached: boolean,
    evidence: string | null,
    unreachableReason: string | null = null,
  ): DeliveryStageState => ({ stage: stageId, reached, evidence, unreachableReason });

  return [
    stage(
      'code_completed',
      input.hasChangedFiles,
      input.hasChangedFiles ? 'Files were changed on a mission branch.' : null,
    ),
    stage(
      'verification_completed',
      allRequiredRan,
      allRequiredRan
        ? `${requiredPassed} of ${required.length} required checks passed; the rest are reported as they really were.`
        : null,
    ),
    stage(
      'review_completed',
      Boolean(deliverableReview),
      deliverableReview
        ? `${deliverableReview.reviewerRole} returned "${deliverableReview.verdict}" against diff ${deliverableReview.diffFingerprint.slice(0, 12)}.`
        : null,
    ),
    stage(
      'pull_request_created',
      Boolean(input.pullRequestUrl),
      input.pullRequestUrl ? `Draft pull request at ${input.pullRequestUrl}.` : null,
    ),
    stage(
      'pull_request_merged',
      false,
      null,
      'Jarvis never merges. Merging is yours to do, after you have read the diff.',
    ),
    stage('deployed', false, null, 'Jarvis does not deploy anything.'),
    stage(
      'testflight_uploaded',
      input.testFlightUploaded,
      input.testFlightUploaded ? input.testFlightEvidence : null,
      input.testFlightUploaded
        ? null
        : 'A TestFlight upload happens only through an allow-listed workflow you approved for an exact commit.',
    ),
    stage(
      'production_released',
      false,
      null,
      'Jarvis never submits to the App Store or publishes a release.',
    ),
  ];
}

/**
 * The honest one-line summary.
 *
 * Reads the ladder from the top down and names the highest rung actually reached — so the worst
 * thing it can say is the truth, and it can never say "deployed" because that rung is never
 * `true`.
 */
export function describeReceipt(stages: readonly DeliveryStageState[]): string {
  const reached = [...stages].reverse().find((stage) => stage.reached);
  if (!reached) return 'Nothing was completed.';
  switch (reached.stage) {
    case 'code_completed':
      return 'Code was written. It has not been verified or reviewed.';
    case 'verification_completed':
      return 'Code was written and the checks ran. It has not been reviewed.';
    case 'review_completed':
      return 'Code was written, checked and independently reviewed. There is no pull request yet.';
    case 'pull_request_created':
      return 'A draft pull request is open, reviewed and evidenced. It is not merged.';
    case 'testflight_uploaded':
      return 'A build reached TestFlight. Nothing has been released to the App Store.';
    default:
      return 'Completed.';
  }
}

/** Owner-facing next steps derived from what actually happened. */
export function deriveNextSteps(content: {
  readonly stages: readonly DeliveryStageState[];
  readonly remainingFindings: readonly ReceiptFinding[];
  readonly verification: readonly ReceiptVerification[];
  readonly pullRequestUrl: string | null;
}): readonly string[] {
  const steps: string[] = [];
  const inconclusive = content.verification.filter(
    (check) => check.required && check.outcome !== 'passed' && check.outcome !== 'failed',
  );

  if (content.pullRequestUrl) {
    steps.push(
      `Read the diff at ${content.pullRequestUrl}. Jarvis has not merged it and will not.`,
    );
  }
  if (inconclusive.length > 0) {
    steps.push(
      `${inconclusive.length} required check(s) could not run here: ${inconclusive
        .map((check) => check.check)
        .slice(0, 3)
        .join(', ')}. Run them where they work before you merge.`,
    );
  }
  const failed = content.verification.filter((check) => check.outcome === 'failed');
  if (failed.length > 0) {
    steps.push(`${failed.length} check(s) are still failing. Do not merge until you have looked.`);
  }
  if (content.remainingFindings.length > 0) {
    steps.push(
      `${content.remainingFindings.length} non-blocking review finding(s) were left for you to judge.`,
    );
  }
  if (steps.length === 0) steps.push('Read the diff, then merge it yourself if you are happy.');
  return steps;
}

/* ------------------------------------------------------------------ schemas */

export const receiptQuerySchema = z.object({
  missionId: z.string().uuid(),
});

/** A stage may only be marked reached with evidence. Asserted in tests, checked here. */
export function receiptIsHonest(content: CompletionReceiptContent): boolean {
  return content.stages.every((stage) => !stage.reached || Boolean(stage.evidence));
}
