/**
 * What Jarvis must ask about, and what the owner has already said yes to.
 *
 * ## Why this is separate from the charter
 *
 * The charter answers "may Jarvis act unattended at all, and within what scope". This answers a
 * narrower and more practical question: given that it may act, which *kinds of act* still need a
 * person. They are different because the first is about trust in the deployment and the second is
 * about the consequence of one action — and conflating them is what produced a system where
 * ordinary implementation work stopped at the same screen as a production deploy.
 *
 * ## Why routine work is not on this list
 *
 * Because the owner's complaint was precise: creating a project, a repository, a branch, tests,
 * documentation and a draft pull request is *the work*, not a decision about the work. A system
 * that asks permission for each of those has not delegated anything; it has added a form. Nothing
 * routine appears below, and that absence is the design.
 *
 * ## Why three categories carry a warning
 *
 * Every category here can be pre-authorised, because the owner asked to be able to pre-authorise
 * the ones he trusts and it is his account. But three of them share a property the others do not:
 * an owner surprised by one cannot undo it. Money has moved, a credential is known to someone
 * else, or data is gone. Those are marked, and the sentence saying so travels with the category
 * rather than living in a document nobody reads at the moment of choosing.
 */

export const APPROVAL_CATEGORIES = [
  'destructive_delete',
  'merge',
  'release',
  'deploy',
  'spend',
  'external_message',
  'credential_change',
  'outside_boundary',
] as const;
export type ApprovalCategory = (typeof APPROVAL_CATEGORIES)[number];

export interface ApprovalCategoryInfo {
  readonly label: string;
  /** What pre-authorising this actually permits, in the words shown at the moment of choosing. */
  readonly permits: string;
  /**
   * True when being surprised by it cannot be undone.
   *
   * Not a prohibition — the owner may still pre-authorise it — but the interface must say this
   * before he does, and the audit must record that he was told.
   */
  readonly irreversible: boolean;
}

export const APPROVAL_CATEGORY_INFO: Record<ApprovalCategory, ApprovalCategoryInfo> = {
  destructive_delete: {
    label: 'Delete something permanently',
    permits: 'Deleting a repository, a branch with unmerged work, or data with no copy elsewhere.',
    irreversible: true,
  },
  merge: {
    label: 'Merge a pull request',
    permits: 'Merging work into a default branch without you reading it first.',
    irreversible: false,
  },
  release: {
    label: 'Cut a release',
    permits: 'Tagging and publishing a version other people can install.',
    irreversible: false,
  },
  deploy: {
    label: 'Deploy',
    permits: 'Putting a change in front of real users.',
    irreversible: false,
  },
  spend: {
    label: 'Spend money',
    permits:
      'Any action that bills your accounts, including paid API usage beyond the subscription.',
    irreversible: true,
  },
  external_message: {
    label: 'Send a message to someone else',
    permits: 'Email, issues, comments or messages that leave this machine and reach a person.',
    irreversible: false,
  },
  credential_change: {
    label: 'Change a credential',
    permits: 'Rotating, revoking or replacing a token, key or account recovery method.',
    irreversible: true,
  },
  outside_boundary: {
    label: 'Act outside the allowed workspace',
    permits: 'Reading or writing outside the configured workspace roots and repositories.',
    irreversible: false,
  },
};

/**
 * What the owner has pre-authorised.
 *
 * A set of categories and nothing else. Deliberately not a set of *rules*: a policy that can
 * express conditions is a policy nobody can read back and be sure of, and the whole value of this
 * is that the owner can look at eight lines and know what he has agreed to.
 */
export interface ApprovalPolicy {
  readonly preAuthorised: readonly ApprovalCategory[];
  /**
   * Whether routine implementation may proceed without a manual plan approval.
   *
   * Separate from the categories because it is not a category — it is the difference between
   * delegating the work and reviewing every step of it. Off by default: a deployment that starts
   * approving its own plans because a file was added is not something that should happen quietly.
   */
  readonly autoApproveRoutinePlans: boolean;
}

/** Where the owner's choice is stored. Named once so a typo cannot create a second policy. */
export const APPROVAL_POLICY_KEY = 'approval.policy';

/** Nothing pre-authorised, nothing automatic. What a new installation gets. */
export const CAUTIOUS_APPROVAL_POLICY: ApprovalPolicy = {
  preAuthorised: [],
  autoApproveRoutinePlans: false,
};

export function isApprovalCategory(value: string): value is ApprovalCategory {
  return (APPROVAL_CATEGORIES as readonly string[]).includes(value);
}

/**
 * Read a stored policy back, refusing to widen itself on malformed input.
 *
 * A settings row is not necessarily the shape it was written in — an older version, a hand edit, a
 * failed migration. Every unreadable field falls back to the cautious value, because the failure
 * mode of guessing generously here is Jarvis merging something nobody approved.
 */
export function parseApprovalPolicy(value: unknown): ApprovalPolicy {
  if (typeof value !== 'object' || value === null) return CAUTIOUS_APPROVAL_POLICY;
  const record = value as Record<string, unknown>;

  const raw = Array.isArray(record.preAuthorised) ? record.preAuthorised : [];
  const preAuthorised = raw.filter(
    (entry): entry is ApprovalCategory => typeof entry === 'string' && isApprovalCategory(entry),
  );

  return {
    preAuthorised: [...new Set(preAuthorised)],
    autoApproveRoutinePlans: record.autoApproveRoutinePlans === true,
  };
}

/**
 * Does this action still need a person?
 *
 * The question is asked per category rather than per action, so that a new kind of action inherits
 * an answer the owner has already given rather than defaulting to permitted.
 */
export function requiresOwnerApproval(category: ApprovalCategory, policy: ApprovalPolicy): boolean {
  return !policy.preAuthorised.includes(category);
}

/** Every category in this set that the owner has not pre-authorised, in a stable order. */
export function outstandingApprovals(
  categories: readonly ApprovalCategory[],
  policy: ApprovalPolicy,
): readonly ApprovalCategory[] {
  const needed = new Set(categories.filter((category) => requiresOwnerApproval(category, policy)));
  return APPROVAL_CATEGORIES.filter((category) => needed.has(category));
}

/**
 * Sentences promising *not* to do something, removed before anything is read out of them.
 *
 * ## Why this is here at all
 *
 * Because the first version of this function read a deterministic plan and concluded that ordinary
 * work would merge and deploy. The plan said:
 *
 *     "delivered as a draft pull request for your review before anything merges"
 *     outOfScope: ["Merging the pull request.", "Deploying, publishing or releasing anything."]
 *
 * Both are promises of restraint, and both contain the words that mean the opposite. It is exactly
 * the mistake that once named a project "Yet" after the sentence "Do not build anything yet" — a
 * prohibition mined for the thing it forbids — and it is worth naming as the same bug, because it
 * will be made a third time by whoever next writes a rule that reads prose.
 *
 * The caller is also expected not to pass an out-of-scope list at all. This is the second guard,
 * for the sentence that says it inside prose the caller cannot easily split.
 */
const DISCLAIMER =
  /\b(?:never|not|no|without|before anything|instead of|rather than|does ?n(?:o|')t|do ?n(?:o|')t|will not|won'?t|stops? short of|out of scope)\b/i;

function withoutDisclaimers(text: string): string {
  return text
    .split(/(?<=[.!?;])\s+|\n+/)
    .filter((sentence) => !DISCLAIMER.test(sentence))
    .join(' ');
}

/**
 * The categories a piece of work would touch.
 *
 * ## Why this reads text
 *
 * Because the alternative is a structured field somebody has to remember to set, and the action
 * that gets missed is the one that mattered. Reading the plan and the request is imperfect and
 * fails in the safe direction: an extra category costs one question, a missing one costs a merge
 * nobody agreed to.
 *
 * `outsideBoundary` and `spend` are passed in rather than inferred, because they are facts the
 * caller knows and prose does not: whether a path escaped the workspace roots, and whether a
 * provider is being billed. Guessing either from wording would be worse than not guessing.
 */
export function categoriesForWork(input: {
  /**
   * What the work will do.
   *
   * Must not include a plan's out-of-scope list. See `withoutDisclaimers` for why that mattered
   * enough to say twice.
   */
  readonly text: string;
  readonly missionType?: string | null;
  readonly outsideBoundary?: boolean;
  readonly spends?: boolean;
}): readonly ApprovalCategory[] {
  const found = new Set<ApprovalCategory>();
  const text = withoutDisclaimers(input.text).toLowerCase();

  const has = (pattern: RegExp) => pattern.test(text);

  if (has(/\bmerg(?:e|ing)\b|\bsquash and merge\b|\bland (?:the|this) (?:pr|pull request)\b/)) {
    found.add('merge');
  }
  if (has(/\brelease\b|\bpublish(?:ing)? (?:a )?(?:version|package|release)\b|\btag a version\b/)) {
    found.add('release');
  }
  if (has(/\bdeploy(?:ing|ment)?\b|\bship to production\b|\bgo live\b|\bpromote to prod\b/)) {
    found.add('deploy');
  }
  if (
    has(
      /\bdelete (?:the )?(?:repository|repo|branch|account|database)\b|\bdrop (?:the )?(?:database|table)\b|\bforce[- ]push\b|\brm -rf\b/,
    )
  ) {
    found.add('destructive_delete');
  }
  if (
    has(
      /\bsend (?:an? )?(?:email|message|invite)\b|\bemail (?:the|him|her|them)\b|\bpost (?:a )?comment\b|\bnotify (?:the )?(?:team|customer|user)s?\b/,
    )
  ) {
    found.add('external_message');
  }
  if (
    has(
      /\brotate (?:the )?(?:token|key|secret|credential)\b|\brevoke (?:the )?(?:token|key|credential)\b|\bchange (?:the )?password\b|\bapi key\b/,
    )
  ) {
    found.add('credential_change');
  }

  if (input.outsideBoundary) found.add('outside_boundary');
  if (input.spends) found.add('spend');

  return APPROVAL_CATEGORIES.filter((category) => found.has(category));
}

/**
 * Whether a plan may be approved without asking, and the sentence saying why.
 *
 * Returns a reason in both directions on purpose: a refusal the owner cannot account for is
 * indistinguishable from a bug, and an approval nobody can explain afterwards is worse.
 */
export function decideAutoApproval(input: {
  readonly policy: ApprovalPolicy;
  readonly categories: readonly ApprovalCategory[];
  /** The mission's own risk classification. Anything above `low` is a person's decision. */
  readonly riskLevel: 'read_only' | 'low' | 'moderate' | 'high' | 'prohibited';
}): { readonly approve: boolean; readonly reason: string } {
  if (!input.policy.autoApproveRoutinePlans) {
    return {
      approve: false,
      reason: 'Routine plans are not set to proceed on their own.',
    };
  }

  if (input.riskLevel !== 'read_only' && input.riskLevel !== 'low') {
    return {
      approve: false,
      reason: `This is ${input.riskLevel.replace(/_/g, ' ')} work, which is yours to approve.`,
    };
  }

  const outstanding = outstandingApprovals(input.categories, input.policy);
  if (outstanding.length > 0) {
    const labels = outstanding.map((category) => APPROVAL_CATEGORY_INFO[category].label);
    return {
      approve: false,
      reason: `It would ${labels.join(', ').toLowerCase()}, which you have not pre-authorised.`,
    };
  }

  return {
    approve: true,
    reason: 'Low-risk work inside what you already authorised.',
  };
}
