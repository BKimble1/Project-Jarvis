import { z } from 'zod';
import { REVIEW_ROLES, type AgentRole } from './agent-role';
import type { VerificationOutcome } from './mission-run';

/**
 * Independent review.
 *
 * The point of this module is a single property: **the reviewer's opinion is worth something
 * because of what it was not given.** A reviewer session receives the approved plan, the approved
 * graph, the acceptance criteria, the final diff, the repository's own verification results and
 * the artifacts — assembled here, deterministically, from stored records. It never receives the
 * builder's conversation, the builder's reasoning, or the builder's own claim that the tests
 * passed. `buildReviewContext` is the only way a review prompt is constructed, and it takes
 * exactly those inputs, so "the reviewer inherited the builder's context" is not a mistake that
 * can be made by forgetting something — there is no parameter through which it could arrive.
 *
 * The second property is that a verdict is a *structured* object, not prose. "Looks good to me"
 * cannot be stored. A finding that blocks delivery must name a file, a rule and an evidence
 * string, so a repair can be scoped to it and an owner can check it.
 */

/* ---------------------------------------------------------------- severities */

export const FINDING_SEVERITIES = ['critical', 'high', 'medium', 'low', 'informational'] as const;
export type FindingSeverity = (typeof FINDING_SEVERITIES)[number];

export const FINDING_SEVERITY_RANK: Record<FindingSeverity, number> = {
  informational: 0,
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

export const FINDING_CATEGORIES = [
  'correctness',
  'regression_risk',
  'security',
  'data_safety',
  'migration_safety',
  'test_coverage',
  'error_handling',
  'performance',
  'accessibility',
  'user_experience',
  'documentation',
  'scope',
  'unintended_change',
  'evidence_gap',
] as const;
export type FindingCategory = (typeof FINDING_CATEGORIES)[number];

export const FINDING_STATES = [
  /** Recorded, not yet triaged by deterministic policy. */
  'open',
  /** Deterministic policy or the owner accepted it; a repair may address it. */
  'accepted',
  /** The owner decided it does not need fixing in this mission. */
  'rejected',
  /** A repair addressed it and a fresh review no longer reports it. */
  'repaired',
  /** Not blocking; recorded for the owner and carried forward. */
  'noted',
  /** Needs a product decision only the owner can make. */
  'owner_decision',
] as const;
export type FindingState = (typeof FINDING_STATES)[number];

export const REVIEW_VERDICTS = [
  'approved',
  'approved_with_notes',
  'repair_required',
  'owner_decision_required',
  'blocked',
  /** The review could not be performed. Never treated as an approval. */
  'unavailable',
] as const;
export type ReviewVerdict = (typeof REVIEW_VERDICTS)[number];

export const REVIEW_VERDICT_LABELS: Record<ReviewVerdict, string> = {
  approved: 'Approved',
  approved_with_notes: 'Approved with notes',
  repair_required: 'Repair required',
  owner_decision_required: 'Needs your decision',
  blocked: 'Blocked',
  unavailable: 'Review unavailable',
};

/** Verdicts that permit delivery to proceed. Deliberately short. */
export const DELIVERABLE_VERDICTS = [
  'approved',
  'approved_with_notes',
] as const satisfies readonly ReviewVerdict[];

export function verdictAllowsDelivery(verdict: ReviewVerdict): boolean {
  return (DELIVERABLE_VERDICTS as readonly ReviewVerdict[]).includes(verdict);
}

export const FINDING_CONFIDENCE = ['high', 'medium', 'low'] as const;
export type FindingConfidence = (typeof FINDING_CONFIDENCE)[number];

/* ------------------------------------------------------------------ records */

export interface ReviewFinding {
  readonly id: string;
  readonly reviewId: string;
  readonly missionId: string;
  /** Stable within a review: `F1`, `F2`. Used to scope a repair and to match across rounds. */
  readonly key: string;
  readonly severity: FindingSeverity;
  readonly category: FindingCategory;
  readonly title: string;
  readonly description: string;
  /** A quotation from the diff, a log or a file. Not the reviewer's summary of one. */
  readonly evidence: string;
  readonly file: string | null;
  readonly line: number | null;
  readonly component: string | null;
  /** The acceptance criterion or rule this violates, quoted. */
  readonly violates: string | null;
  readonly reproduction: string | null;
  readonly recommendation: string;
  readonly confidence: FindingConfidence;
  readonly blocksDelivery: boolean;
  readonly state: FindingState;
  readonly ownerDecision: string | null;
  readonly resolvedByTaskId: string | null;
  readonly repairRound: number;
  readonly createdAt: string;
  readonly resolvedAt: string | null;
}

export interface MissionReview {
  readonly id: string;
  readonly missionId: string;
  readonly taskId: string;
  readonly runId: string | null;
  readonly graphVersion: number;
  readonly planVersion: number;
  readonly reviewerRole: AgentRole;
  readonly verdict: ReviewVerdict;
  readonly summary: string;
  /** The exact diff the reviewer saw, identified so a later diff cannot inherit this verdict. */
  readonly diffFingerprint: string;
  readonly reviewedFiles: readonly string[];
  /** A copy of the verification outcomes at review time, so "it passed" is checkable later. */
  readonly verificationSnapshot: readonly {
    readonly check: string;
    readonly outcome: VerificationOutcome;
    readonly required: boolean;
  }[];
  readonly repairRound: number;
  /** False when the reviewer inherited nothing from the builder — always true in practice. */
  readonly coldContext: boolean;
  readonly unavailableReason: string | null;
  readonly createdAt: string;
}

/* ------------------------------------------------------------- verdict rules */

export interface VerdictPolicyInput {
  readonly proposedVerdict: ReviewVerdict;
  readonly findings: readonly Pick<ReviewFinding, 'severity' | 'blocksDelivery'>[];
  /** Required checks and their real outcomes, from the verification records. */
  readonly requiredChecks: readonly { readonly outcome: VerificationOutcome }[];
}

export interface VerdictDecision {
  readonly verdict: ReviewVerdict;
  readonly rule: string | null;
  readonly reason: string | null;
  readonly overridden: boolean;
}

/**
 * Reconcile what the reviewer said with what is actually true.
 *
 * A reviewer can be wrong in two directions and both are corrected here rather than trusted:
 *
 *  - It can approve while a required check failed. Deterministic policy overrides that; the model
 *    does not get to decide that a red test is acceptable (R-RV1).
 *  - It can report critical findings and then approve anyway. Also overridden (R-RV2).
 *
 * The reverse — a reviewer that blocks with no finding to point at — is left alone. A reviewer
 * refusing to sign off is allowed to be conservative; it just cannot be *silent*, so R-RV4 turns
 * an unevidenced block into an owner decision rather than an unexplained stop.
 */
export function decideVerdict(input: VerdictPolicyInput): VerdictDecision {
  const blockingFindings = input.findings.filter(
    (finding) => finding.blocksDelivery || finding.severity === 'critical',
  );
  const failedRequired = input.requiredChecks.filter((check) => check.outcome === 'failed');
  const unavailableRequired = input.requiredChecks.filter(
    (check) => check.outcome === 'unavailable',
  );

  if (failedRequired.length > 0 && verdictAllowsDelivery(input.proposedVerdict)) {
    return {
      verdict: 'repair_required',
      rule: 'R-RV1',
      reason: `${failedRequired.length} required check(s) failed, so this cannot be approved.`,
      overridden: true,
    };
  }

  if (blockingFindings.length > 0 && verdictAllowsDelivery(input.proposedVerdict)) {
    return {
      verdict: 'repair_required',
      rule: 'R-RV2',
      reason: 'The review recorded blocking findings, so it cannot also approve.',
      overridden: true,
    };
  }

  if (unavailableRequired.length > 0 && input.proposedVerdict === 'approved') {
    return {
      verdict: 'owner_decision_required',
      rule: 'R-RV3',
      reason:
        'A required check could not run here. That is not a pass, and it is not a failure either — it is your call.',
      overridden: true,
    };
  }

  if (input.proposedVerdict === 'blocked' && blockingFindings.length === 0) {
    return {
      verdict: 'owner_decision_required',
      rule: 'R-RV4',
      reason: 'The review blocked delivery without recording a blocking finding to point at.',
      overridden: true,
    };
  }

  return { verdict: input.proposedVerdict, rule: null, reason: null, overridden: false };
}

/** Which findings a repair round is allowed to touch. Nothing else may be changed. */
export function acceptedFindings(findings: readonly ReviewFinding[]): readonly ReviewFinding[] {
  return findings.filter((finding) => finding.state === 'accepted');
}

/**
 * Triage a review's findings against deterministic policy.
 *
 * Critical and high findings that block delivery are accepted automatically — they are not a
 * matter of taste. Anything that turns on product judgement is routed to the owner rather than
 * decided by Jarvis, and everything else is recorded as a note so it is not lost.
 */
export function triageFindings(
  findings: readonly Pick<ReviewFinding, 'key' | 'severity' | 'blocksDelivery' | 'category'>[],
): readonly { readonly key: string; readonly state: FindingState; readonly rule: string }[] {
  return findings.map((finding) => {
    if (finding.severity === 'critical') {
      return { key: finding.key, state: 'accepted' as const, rule: 'R-FT1' };
    }
    if (finding.blocksDelivery && finding.severity === 'high') {
      return { key: finding.key, state: 'accepted' as const, rule: 'R-FT2' };
    }
    if (finding.blocksDelivery) {
      /* Blocking but not severe: the owner decides whether it is worth another round. */
      return { key: finding.key, state: 'owner_decision' as const, rule: 'R-FT3' };
    }
    if (finding.category === 'scope' || finding.category === 'unintended_change') {
      return { key: finding.key, state: 'owner_decision' as const, rule: 'R-FT4' };
    }
    return { key: finding.key, state: 'noted' as const, rule: 'R-FT5' };
  });
}

/* --------------------------------------------------- specialist review rules */

export interface SpecialistTriggerInput {
  readonly changedFiles: readonly string[];
  readonly projectType: string | null;
  readonly missionType: string;
  readonly riskLevel: string;
  /** True when the mission's playbook can dispatch CI or an external build. */
  readonly canDispatchExternalBuild: boolean;
}

export interface SpecialistRequirement {
  readonly role: AgentRole;
  readonly rule: string;
  readonly reason: string;
}

/**
 * Paths whose change requires a security review.
 *
 * Matched on the *path*, not on the diff's prose, so a change cannot avoid the trigger by being
 * described differently. Deliberately broad: a false positive costs one extra read-only review.
 */
const SECURITY_PATH_PATTERNS: readonly { pattern: RegExp; reason: string }[] = [
  {
    pattern: /(?:^|\/)(?:auth|authn|authz|session|login|oauth)(?:\/|\.|$)/i,
    reason: 'authentication or sessions',
  },
  {
    pattern: /(?:^|\/)(?:middleware|guard|permission|policy|acl|rbac)(?:\/|\.|$)/i,
    reason: 'authorisation',
  },
  {
    pattern: /(?:credential|secret|token|password|apikey|api-key|keystore)/i,
    reason: 'credentials',
  },
  { pattern: /(?:^|\/)export(?:\/|\.|$)|(?:^|\/)backup(?:\/|\.|$)/i, reason: 'data export' },
  { pattern: /(?:crypt|cipher|hash|signature|jwt|hmac)/i, reason: 'encryption or signing' },
  {
    pattern: /(?:^|\/)(?:cors|csp|headers|proxy|webhook)(?:\/|\.|$)/i,
    reason: 'network boundaries',
  },
  { pattern: /(?:upload|multipart|file-?store)/i, reason: 'file uploads' },
  { pattern: /(?:^|\/)worker\/|worker-protocol|worker-handler/i, reason: 'the worker protocol' },
  {
    pattern: /(?:github|octokit).*(?:permission|scope|token)|github-token/i,
    reason: 'GitHub permissions',
  },
  { pattern: /(?:billing|payment|invoice-charge|stripe|subscription)/i, reason: 'billing' },
  {
    pattern: /(?:^|\/)(?:pii|personal|gdpr|privacy)(?:\/|\.|$)/i,
    reason: 'sensitive personal data',
  },
  { pattern: /(?:^|\/)(?:migrations?|drizzle)\//i, reason: 'a database migration' },
];

const UI_PATH_PATTERN =
  /\.(?:tsx|jsx|vue|svelte|swift|css|scss)$|(?:^|\/)(?:components?|views?|screens?|pages?|ui)(?:\/|$)/i;

/**
 * Which specialist reviews this change must have.
 *
 * Deterministic and file-driven. A general reviewer never satisfies one of these — they are
 * stored as separate verdicts and synthesised, so a single "looks fine" cannot silently stand in
 * for a security review that was required.
 */
export function requiredSpecialistReviews(
  input: SpecialistTriggerInput,
): readonly SpecialistRequirement[] {
  const required: SpecialistRequirement[] = [];

  const securityHits = new Set<string>();
  for (const file of input.changedFiles) {
    for (const rule of SECURITY_PATH_PATTERNS) {
      if (rule.pattern.test(file)) securityHits.add(rule.reason);
    }
  }
  if (securityHits.size > 0) {
    required.push({
      role: 'security_reviewer',
      rule: 'R-SP1',
      reason: `This change touches ${[...securityHits].slice(0, 3).join(', ')}.`,
    });
  }

  const uiFiles = input.changedFiles.filter((file) => UI_PATH_PATTERN.test(file));
  if (uiFiles.length > 0) {
    required.push({
      role: 'ux_reviewer',
      rule: 'R-SP2',
      reason: `This change materially affects ${uiFiles.length} user-facing file(s).`,
    });
  }

  if (input.canDispatchExternalBuild) {
    required.push({
      role: 'release_verifier',
      rule: 'R-SP3',
      reason: 'This playbook can trigger an external build, so the build must be verified first.',
    });
  }

  return required;
}

/* ------------------------------------------------------- the review context */

export interface ReviewContextInput {
  readonly missionTitle: string;
  readonly missionRequest: string;
  readonly planSummary: string;
  readonly planApproach: string;
  readonly planScope: readonly string[];
  readonly planOutOfScope: readonly string[];
  readonly acceptanceCriteria: readonly string[];
  readonly graphSummary: string;
  readonly taskSummaries: readonly {
    readonly key: string;
    readonly title: string;
    readonly role: string;
  }[];
  readonly diff: string;
  readonly changedFiles: readonly string[];
  readonly verification: readonly {
    readonly check: string;
    readonly outcome: VerificationOutcome;
    readonly required: boolean;
    readonly detail: string;
  }[];
  readonly artifacts: readonly { readonly title: string; readonly kind: string }[];
  readonly repositoryInstructions: string | null;
  /** Only on a repair round: what the previous round was asked to fix, never what it concluded. */
  readonly repairScope: readonly { readonly key: string; readonly title: string }[];
  readonly repairRound: number;
}

/**
 * Build the reviewer's entire world.
 *
 * Note what this signature does *not* accept: there is no `builderTranscript`, no
 * `builderSummary`, no `previousVerdict`. A fresh reviewer on a repair round is told which
 * findings were accepted for repair — it needs the scope to check the work — but never that an
 * earlier reviewer approved or blocked, because that is a conclusion and conclusions are exactly
 * what an independent review is for.
 */
export function buildReviewContext(input: ReviewContextInput): string {
  const lines: string[] = [];
  lines.push('# Independent review');
  lines.push('');
  lines.push(
    'You are reviewing finished work. You did not write it and you have not seen how it was',
    'written — that is deliberate. Judge what is in front of you.',
    '',
  );

  lines.push('## What the owner asked for');
  lines.push(`Mission: ${input.missionTitle}`);
  lines.push(`In their words: "${input.missionRequest}"`);
  lines.push('');

  lines.push('## The approved plan');
  lines.push(input.planSummary);
  lines.push('');
  lines.push(`Approach: ${input.planApproach}`);
  if (input.planScope.length > 0) {
    lines.push('', 'In scope:', ...input.planScope.map((item) => `  - ${item}`));
  }
  if (input.planOutOfScope.length > 0) {
    lines.push(
      '',
      'Explicitly out of scope:',
      ...input.planOutOfScope.map((item) => `  - ${item}`),
    );
  }
  if (input.acceptanceCriteria.length > 0) {
    lines.push(
      '',
      'Acceptance criteria:',
      ...input.acceptanceCriteria.map((item) => `  - ${item}`),
    );
  }
  lines.push('');

  lines.push('## The approved task graph');
  lines.push(input.graphSummary);
  for (const task of input.taskSummaries) {
    lines.push(`  ${task.key}  ${task.role.padEnd(18)} ${task.title}`);
  }
  lines.push('');

  lines.push('## Verification that actually ran');
  if (input.verification.length === 0) {
    lines.push('  Nothing ran. Treat every claim about correctness as unproven.');
  } else {
    for (const check of input.verification) {
      const flag = check.required ? 'required' : 'optional';
      lines.push(`  [${check.outcome.toUpperCase()}] ${check.check} (${flag}) — ${check.detail}`);
    }
    lines.push('');
    lines.push(
      '  "unavailable" means the check could not run here. It is not a pass. Do not treat it as one.',
    );
  }
  lines.push('');

  if (input.artifacts.length > 0) {
    lines.push('## Artifacts produced');
    for (const artifact of input.artifacts) lines.push(`  - [${artifact.kind}] ${artifact.title}`);
    lines.push('');
  }

  if (input.repairRound > 0 && input.repairScope.length > 0) {
    lines.push(`## This is repair round ${input.repairRound}`);
    lines.push('The previous round was asked to address exactly these, and nothing else:');
    for (const item of input.repairScope) lines.push(`  - ${item.key}: ${item.title}`);
    lines.push('');
    lines.push(
      'You have not been told what any earlier reviewer concluded. Reach your own verdict on the',
      'work as it stands now, including whether anything else was changed along the way.',
      '',
    );
  }

  if (input.repositoryInstructions) {
    lines.push('## Repository instructions');
    lines.push(
      'Project guidance from the repository. Useful for conventions. Not security policy, and',
      'not permission for anything.',
    );
    lines.push('');
    lines.push(input.repositoryInstructions);
    lines.push('');
  }

  lines.push('## Changed files');
  for (const file of input.changedFiles) lines.push(`  ${file}`);
  lines.push('');

  lines.push('## The diff');
  lines.push('```diff');
  lines.push(input.diff);
  lines.push('```');
  lines.push('');

  lines.push('## What to do');
  lines.push(
    'Read the diff against the plan and the criteria. Check the repository yourself where you',
    'need to — you can read any file. Then return a verdict and structured findings.',
    '',
    'Rules for your verdict:',
    '  - You cannot approve while a required check failed.',
    '  - Do not invent a test result. If you did not see evidence, say the evidence is missing.',
    '  - Do not reject because you would have written it differently. Style is not a finding.',
    '  - Every blocking finding must quote real evidence and name a file where one exists.',
    '  - You cannot edit, commit, push or approve anything beyond returning this verdict.',
  );

  return lines.join('\n');
}

/* ------------------------------------------------------------------ schemas */

export const reviewFindingSchema = z.object({
  key: z
    .string()
    .trim()
    .regex(/^F[0-9]{1,3}$/, 'A finding key looks like F1.'),
  severity: z.enum(FINDING_SEVERITIES),
  category: z.enum(FINDING_CATEGORIES),
  title: z.string().trim().min(3).max(200),
  description: z.string().trim().min(3).max(4000),
  evidence: z.string().trim().min(1).max(4000),
  file: z.string().trim().max(400).nullish(),
  line: z.number().int().min(1).max(10_000_000).nullish(),
  component: z.string().trim().max(200).nullish(),
  violates: z.string().trim().max(600).nullish(),
  reproduction: z.string().trim().max(2000).nullish(),
  recommendation: z.string().trim().min(3).max(2000),
  confidence: z.enum(FINDING_CONFIDENCE),
  blocksDelivery: z.boolean(),
});
export type ReviewFindingInput = z.infer<typeof reviewFindingSchema>;

export const reviewSubmissionSchema = z.object({
  runId: z.string().uuid(),
  taskId: z.string().uuid(),
  verdict: z.enum(REVIEW_VERDICTS),
  summary: z.string().trim().min(3).max(4000),
  findings: z.array(reviewFindingSchema).max(60).default([]),
  reviewedFiles: z.array(z.string().trim().min(1).max(400)).max(500).default([]),
  diffFingerprint: z.string().trim().min(8).max(128),
  unavailableReason: z.string().trim().max(600).nullish(),
});
export type ReviewSubmissionInput = z.infer<typeof reviewSubmissionSchema>;

export const findingDecisionSchema = z.object({
  findingId: z.string().uuid(),
  decision: z.enum(['accept', 'reject', 'defer']),
  note: z.string().trim().max(2000).nullish(),
});
export type FindingDecisionInput = z.infer<typeof findingDecisionSchema>;

export function isReviewerRole(role: AgentRole): boolean {
  return (REVIEW_ROLES as readonly AgentRole[]).includes(role);
}
