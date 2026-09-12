import { z } from 'zod';
import { ForbiddenError } from './errors';

/**
 * How far Jarvis has actually been proved, and what it is therefore allowed to do.
 *
 * Phases 1–3 built a great deal and verified almost all of it — against a scripted runtime, a
 * local git remote and a fake GitHub. That is real verification and it caught seventeen genuine
 * defects. It is also **not the same thing** as having watched a real model do real work, and the
 * single worst thing this file could do is let those two collapse into one `healthy: true`.
 *
 * So qualification is a *ladder*, not a flag. Each rung is a claim about what has been observed,
 * each is earned by named checks, and the interface shows the rung actually reached rather than
 * the rung hoped for. A system that says "production-qualified" because a boolean defaulted to
 * true is worse than one that says nothing.
 *
 * The ladder also *gates*. Unattended automation is the place where an unproved capability does
 * damage without anyone watching, so `assertActivationAllowed` refuses to let a scheduled job
 * start model work or touch GitHub until the matching rung has been earned. That refusal is
 * server-side, at the dispatch boundary, and it is not something the UI can talk out of.
 */

/* ------------------------------------------------------------------- levels */

export const QUALIFICATION_LEVELS = [
  /** The code exists. Nothing has been run. */
  'built',
  /** The automated suite passes: unit, integration, real-git, end-to-end. */
  'automated',
  /** It ran end to end with replacement providers — a scripted runtime, a fake delivery client. */
  'simulated',
  /** A real model inspected a real sandbox repository with no write authority. */
  'live_read',
  /** A real model produced a harmless branch and draft pull request in an approved sandbox. */
  'live_write',
  /** Every required live, recovery and security check has passed. */
  'production',
] as const;
export type QualificationLevel = (typeof QUALIFICATION_LEVELS)[number];

export const QUALIFICATION_LEVEL_LABELS: Record<QualificationLevel, string> = {
  built: 'Built',
  automated: 'Automated verification passed',
  simulated: 'Simulated runtime passed',
  live_read: 'Live read qualification passed',
  live_write: 'Live write qualification passed',
  production: 'Production-qualified',
};

/**
 * What each rung does and does not entitle anyone to believe.
 *
 * Written for the interface, in the second person, because the person reading it is deciding
 * whether to trust Jarvis with something. Vague reassurance is the failure mode.
 */
export const QUALIFICATION_LEVEL_MEANING: Record<QualificationLevel, string> = {
  built:
    'The functionality exists in the code. Nothing has been run to prove it behaves, so believe none of it yet.',
  automated:
    'The test suite passes: unit, real-handler, real-git and end-to-end. That proves the rules and refusals behave as written. It does not prove a real model does anything useful.',
  simulated:
    'A whole mission ran end to end against a scripted runtime and a fake GitHub. The orchestration is proved. The model is still a stand-in.',
  live_read:
    'A real Claude session read a real sandbox repository with no write authority and produced findings about the actual code. Reading works.',
  live_write:
    'A real Claude session produced a harmless branch and a draft pull request in an approved sandbox repository, through verification and independent review. Writing works, within the limits.',
  production:
    'Every required live, recovery and security check has passed. Unattended automation is permitted for the capabilities those checks covered — and nothing beyond them.',
};

export function levelIndex(level: QualificationLevel): number {
  return QUALIFICATION_LEVELS.indexOf(level);
}

/** Is `level` at least `required`? The only comparison anything should make. */
export function meetsLevel(level: QualificationLevel, required: QualificationLevel): boolean {
  return levelIndex(level) >= levelIndex(required);
}

/* ------------------------------------------------------------------- checks */

export const QUALIFICATION_CHECK_IDS = [
  'worker_enrolled',
  'worker_version',
  'model_provider',
  'github_read',
  'github_write_credential',
  'sandbox_selected',
  'sandbox_allow_listed',
  'verification_discoverable',
  'delivery_restricted',
  'backup_configured',
  'migrations_applied',
  'notification_destination',
  'display_read_only',
  /* Earned by running real work, not by inspecting configuration. */
  'live_read_audit',
  'live_write_draft_pr',
  'recovery_drill',
  'security_review',
] as const;
export type QualificationCheckId = (typeof QUALIFICATION_CHECK_IDS)[number];

export interface QualificationCheckDefinition {
  readonly id: QualificationCheckId;
  readonly title: string;
  /** What a pass actually establishes. Shown next to the result. */
  readonly proves: string;
  /** The rung this check is required for. A check may gate more than one via `meetsLevel`. */
  readonly requiredFor: QualificationLevel;
  /**
   * True when this can be decided from Jarvis's own configuration and records.
   *
   * The rest need a real credential or a real run, which is why an environment without one lands
   * honestly on `automated` rather than pretending.
   */
  readonly selfEvaluable: boolean;
  /** How to make it pass, for the setup screen and the documented procedure. */
  readonly remedy: string;
}

/**
 * The checks, in the order a person would work through them.
 *
 * Every one of them is a *presence or behaviour* check. Not one of them reads a credential value,
 * and there is deliberately no field on a result that could carry one — the closest any of them
 * comes is reporting that a credential exists and what identity it authenticated as, which is
 * what makes the check useful without making it dangerous.
 */
export const QUALIFICATION_CHECKS: readonly QualificationCheckDefinition[] = [
  {
    id: 'worker_enrolled',
    title: 'A worker is enrolled and reachable',
    proves: 'Something is listening that can actually do work.',
    requiredFor: 'live_read',
    selfEvaluable: true,
    remedy: 'Enrol a worker on the Workers page and start the worker process.',
  },
  {
    id: 'worker_version',
    title: 'The worker speaks a compatible protocol',
    proves:
      'The worker and the control plane agree on the protocol, so a report means what the control plane thinks it means.',
    requiredFor: 'live_read',
    selfEvaluable: true,
    remedy: 'Update the worker to a build matching this control plane, then restart it.',
  },
  {
    id: 'model_provider',
    title: 'The worker has a model provider configured',
    proves:
      'The worker can start a real agent session. Jarvis knows only that the worker reported a usable runtime; the key itself never leaves the worker.',
    requiredFor: 'live_read',
    selfEvaluable: true,
    remedy:
      'Set the model credential in the worker’s own environment or secret store, then restart the worker. Never put it in the control plane.',
  },
  {
    id: 'github_read',
    title: 'GitHub read access works',
    proves: 'Evidence synchronisation can see the repositories it is meant to.',
    requiredFor: 'live_read',
    selfEvaluable: true,
    remedy: 'Check GITHUB_READ_TOKEN and its repository selection, then re-run this check.',
  },
  {
    id: 'github_write_credential',
    title: 'A separate write credential exists at the delivery boundary',
    proves:
      'Delivery has a credential of its own. It is held by the worker or the CI controller and is never the read token widened.',
    requiredFor: 'live_write',
    selfEvaluable: true,
    remedy:
      'Configure the worker’s GitHub write token, or the CI controller’s own credential, in its own environment.',
  },
  {
    id: 'sandbox_selected',
    title: 'A sandbox repository has been chosen',
    proves: 'Live qualification has somewhere harmless to happen.',
    requiredFor: 'live_read',
    selfEvaluable: true,
    remedy: 'Choose a sandbox repository in Operations → Qualification.',
  },
  {
    id: 'sandbox_allow_listed',
    title: 'That repository is allow-listed for live qualification',
    proves:
      'The repository was named deliberately for this. A repository Jarvis merely has access to is not automatically a place to rehearse.',
    requiredFor: 'live_read',
    selfEvaluable: true,
    remedy: 'Add it to JARVIS_QUALIFICATION_REPOS, then re-run this check.',
  },
  {
    id: 'verification_discoverable',
    title: 'The repository’s own checks can be found and run',
    proves:
      'There is something real to verify against, so a review has evidence rather than an opinion.',
    requiredFor: 'live_write',
    selfEvaluable: false,
    remedy:
      'Make sure the sandbox repository defines a test or lint script the worker can discover and run.',
  },
  {
    id: 'delivery_restricted',
    title: 'Delivery is still limited to a draft pull request',
    proves:
      'The delivery client has no method that could merge, release, deploy or change a setting. Asserted against the object, not the documentation.',
    requiredFor: 'live_write',
    selfEvaluable: true,
    remedy: 'This should never fail. If it does, stop and read the delivery client’s diff.',
  },
  {
    id: 'backup_configured',
    title: 'Backups are configured and a restore has been rehearsed',
    proves: 'A database loss is recoverable. Untested backups are a belief, not a control.',
    requiredFor: 'production',
    selfEvaluable: true,
    remedy: 'Configure backup storage, then run the documented restore drill.',
  },
  {
    id: 'migrations_applied',
    title: 'Every migration is applied',
    proves:
      'The database matches the code. A half-migrated production database is the failure that looks like a hundred unrelated bugs.',
    requiredFor: 'production',
    selfEvaluable: true,
    remedy: 'Run npm run db:migrate against the production database.',
  },
  {
    id: 'notification_destination',
    title: 'There is at least one safe way to reach me',
    proves:
      'A serious failure can actually be reported. In-app alone satisfies this; it requires me to open Jarvis, and the check says so.',
    requiredFor: 'production',
    selfEvaluable: true,
    remedy: 'Enable in-app notifications, and add web push if the device supports it.',
  },
  {
    id: 'display_read_only',
    title: 'Display credentials are still read-only and revocable',
    proves:
      'A wallboard cannot act. Asserted by enumerating the display-authenticated routes rather than by trusting a flag.',
    requiredFor: 'production',
    selfEvaluable: true,
    remedy: 'This should never fail. If it does, a display-authenticated write route was added.',
  },
  {
    id: 'live_read_audit',
    title: 'A real model audited a real repository, read-only',
    proves:
      'A live Claude session received the right repository, could not write to anything, and produced findings that refer to files and commits that exist.',
    requiredFor: 'live_read',
    selfEvaluable: false,
    remedy: 'Run the read-only audit from Operations → Qualification, or npm run qualify:read.',
  },
  {
    id: 'live_write_draft_pr',
    title: 'A real model produced a harmless draft pull request',
    proves:
      'A live session wrote inside its declared paths, passed the repository’s checks, was independently reviewed and delivered a draft pull request against an exact commit — with no merge, force push or release.',
    requiredFor: 'live_write',
    selfEvaluable: false,
    remedy:
      'Approve the write task, then run the harmless mission from Operations → Qualification, or npm run qualify:write.',
  },
  {
    id: 'recovery_drill',
    title: 'Recovery has been rehearsed',
    proves:
      'A worker crash, a failed deployment and a database restore have each been walked through and the system came back.',
    requiredFor: 'production',
    selfEvaluable: false,
    remedy: 'Follow docs/RECOVERY.md and record the drill.',
  },
  {
    id: 'security_review',
    title: 'The security review passed on this build',
    proves: 'The current build was reviewed against the threat model rather than an older one.',
    requiredFor: 'production',
    selfEvaluable: false,
    remedy: 'Run the security review for this commit and record the result.',
  },
];

export const CHECK_BY_ID: Readonly<Record<QualificationCheckId, QualificationCheckDefinition>> =
  Object.freeze(
    Object.fromEntries(QUALIFICATION_CHECKS.map((check) => [check.id, check])) as Record<
      QualificationCheckId,
      QualificationCheckDefinition
    >,
  );

/* ------------------------------------------------------------------ results */

export const CHECK_OUTCOMES = [
  'pass',
  'fail',
  /** Cannot be decided here — no credential, no worker, nothing to ask. Never a pass. */
  'unavailable',
  /** Genuinely does not apply to this deployment. Must carry a reason. */
  'not_applicable',
] as const;
export type CheckOutcome = (typeof CHECK_OUTCOMES)[number];

export const CHECK_OUTCOME_LABELS: Record<CheckOutcome, string> = {
  pass: 'Passed',
  fail: 'Failed',
  unavailable: 'Cannot be checked yet',
  not_applicable: 'Not applicable',
};

export interface QualificationCheckResult {
  readonly id: QualificationCheckId;
  readonly outcome: CheckOutcome;
  /** One sentence. Redacted before storage; never a credential, never a raw environment value. */
  readonly detail: string;
  /**
   * Safe corroboration: a version string, a login, a repository name, a commit, a count.
   *
   * Typed as a string map on purpose. There is no `value` field, no `secret` field and no place a
   * credential could be put even by a caller trying to.
   */
  readonly evidence: Readonly<Record<string, string>>;
  readonly checkedAt: string;
  readonly durationMs: number | null;
}

export interface QualificationRun {
  readonly id: string;
  readonly level: QualificationLevel;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly startedBy: string;
  readonly results: readonly QualificationCheckResult[];
  /** The commit and config fingerprint this was qualified against, for requalification. */
  readonly buildRef: string | null;
  readonly assumptions: QualificationAssumptions;
  readonly note: string | null;
  readonly supersededAt: string | null;
}

/**
 * The trust assumptions a qualification was earned under.
 *
 * Stored with the run so a later change can be *detected* rather than remembered. A
 * qualification is a statement about a specific system; when the system changes underneath it,
 * the honest thing is to say the qualification no longer applies.
 */
export interface QualificationAssumptions {
  readonly workerProtocolVersion: string | null;
  readonly permissionPolicyFingerprint: string | null;
  readonly githubCredentialFingerprint: string | null;
  readonly runtimeName: string | null;
  readonly integrationAlgorithmFingerprint: string | null;
  readonly reviewAlgorithmFingerprint: string | null;
  readonly sandboxRepository: string | null;
}

export const EMPTY_ASSUMPTIONS: QualificationAssumptions = Object.freeze({
  workerProtocolVersion: null,
  permissionPolicyFingerprint: null,
  githubCredentialFingerprint: null,
  runtimeName: null,
  integrationAlgorithmFingerprint: null,
  reviewAlgorithmFingerprint: null,
  sandboxRepository: null,
});

/* ---------------------------------------------------------------- evaluation */

export interface QualificationVerdict {
  readonly level: QualificationLevel;
  /** The checks standing between the level reached and the next one up. */
  readonly blocking: readonly {
    readonly id: QualificationCheckId;
    readonly title: string;
    readonly outcome: CheckOutcome;
    readonly remedy: string;
  }[];
  readonly nextLevel: QualificationLevel | null;
  /** Every rung, with whether it is satisfied. The interface shows the whole ladder. */
  readonly ladder: readonly { readonly level: QualificationLevel; readonly reached: boolean }[];
}

/**
 * Work out the highest rung actually earned.
 *
 * Walks *upward* and stops at the first rung with an unsatisfied check, so a later rung passing
 * cannot lift an earlier one that did not. A missing result counts as `unavailable`, which counts
 * as not passing — the default has to be the honest direction, because a qualification system
 * whose absent evidence reads as success is a qualification system that lies by omission.
 *
 * `automated` and `simulated` have no configuration checks of their own: they are earned by the
 * suite and by the smoke test, which report themselves through `recordSuiteOutcome`. When nothing
 * has reported, the answer is `built`.
 */
export function evaluateQualification(input: {
  readonly results: readonly QualificationCheckResult[];
  /** Whether the automated suite and the simulated smoke test last passed on this build. */
  readonly automatedPassed: boolean;
  readonly simulatedPassed: boolean;
}): QualificationVerdict {
  const byId = new Map(input.results.map((result) => [result.id, result]));

  const satisfied = (level: QualificationLevel): boolean => {
    if (level === 'built') return true;
    if (level === 'automated') return input.automatedPassed;
    if (level === 'simulated') return input.automatedPassed && input.simulatedPassed;
    return QUALIFICATION_CHECKS.filter((check) => check.requiredFor === level).every(
      (check) => byId.get(check.id)?.outcome === 'pass' || isWaived(byId.get(check.id)),
    );
  };

  let reached: QualificationLevel = 'built';
  for (const level of QUALIFICATION_LEVELS) {
    if (!satisfied(level)) break;
    reached = level;
  }

  const nextIndex = levelIndex(reached) + 1;
  const nextLevel = QUALIFICATION_LEVELS[nextIndex] ?? null;

  const blocking = nextLevel
    ? nextLevel === 'automated' || nextLevel === 'simulated'
      ? [
          {
            id: 'security_review' as QualificationCheckId,
            title:
              nextLevel === 'automated'
                ? 'The automated suite has not reported a pass for this build'
                : 'The multi-agent smoke test has not reported a pass for this build',
            outcome: 'unavailable' as CheckOutcome,
            remedy: 'Run npm run verify and record the result.',
          },
        ]
      : QUALIFICATION_CHECKS.filter((check) => check.requiredFor === nextLevel)
          .filter((check) => {
            const result = byId.get(check.id);
            return result?.outcome !== 'pass' && !isWaived(result);
          })
          .map((check) => ({
            id: check.id,
            title: check.title,
            outcome: byId.get(check.id)?.outcome ?? ('unavailable' as CheckOutcome),
            remedy: check.remedy,
          }))
    : [];

  return {
    level: reached,
    blocking,
    nextLevel,
    ladder: QUALIFICATION_LEVELS.map((level) => ({ level, reached: satisfied(level) })),
  };
}

/**
 * `not_applicable` counts, but only with a reason.
 *
 * A deployment with no CI controller genuinely does not need a controller credential. An empty
 * `not_applicable` with no explanation is the loophole through which every check eventually
 * becomes optional, so it does not count.
 */
function isWaived(result: QualificationCheckResult | undefined): boolean {
  return result?.outcome === 'not_applicable' && result.detail.trim().length >= 10;
}

/* ------------------------------------------------------- requalification */

export const REQUALIFICATION_TRIGGERS = [
  'worker_protocol_changed',
  'permission_policy_changed',
  'github_credential_changed',
  'runtime_changed',
  'integration_algorithm_changed',
  'review_algorithm_changed',
  'sandbox_repository_changed',
  'recovery_check_failed',
  'security_check_failed',
  'expired',
] as const;
export type RequalificationTrigger = (typeof REQUALIFICATION_TRIGGERS)[number];

export const REQUALIFICATION_TRIGGER_LABELS: Record<RequalificationTrigger, string> = {
  worker_protocol_changed: 'The worker protocol changed',
  permission_policy_changed: 'The permission policy changed',
  github_credential_changed: 'The GitHub credential was replaced or its scope widened',
  runtime_changed: 'The model runtime changed',
  integration_algorithm_changed: 'The integration algorithm changed',
  review_algorithm_changed: 'The review algorithm changed',
  sandbox_repository_changed: 'The sandbox repository changed',
  recovery_check_failed: 'A required recovery check failed',
  security_check_failed: 'A required security check failed',
  expired: 'The qualification is older than the maximum age',
};

/** How long a live qualification stands before it must be re-earned. */
export const QUALIFICATION_MAX_AGE_DAYS = 90;

export interface RequalificationVerdict {
  readonly required: boolean;
  readonly triggers: readonly RequalificationTrigger[];
  readonly reason: string | null;
}

/**
 * Does a stored qualification still describe this system?
 *
 * Compares the assumptions it was earned under against the assumptions that hold now. Any
 * difference invalidates the *live* rungs — deliberately all of them, rather than trying to reason
 * about which specific change affects which rung, because that reasoning is exactly where a
 * plausible-sounding exception gets made and something ships unqualified.
 *
 * A null on either side means "not known", and an unknown assumption does not trigger
 * requalification on its own: an environment that cannot fingerprint its credential should land
 * on `unavailable` for that check, not thrash between qualified and not.
 */
export function requiresRequalification(input: {
  readonly qualifiedUnder: QualificationAssumptions;
  readonly current: QualificationAssumptions;
  readonly qualifiedAt: string;
  readonly nowIso: string;
  readonly recoveryCheckPassing?: boolean;
  readonly securityCheckPassing?: boolean;
}): RequalificationVerdict {
  const triggers: RequalificationTrigger[] = [];

  const changed = (key: keyof QualificationAssumptions, trigger: RequalificationTrigger): void => {
    const before = input.qualifiedUnder[key];
    const after = input.current[key];
    if (before !== null && after !== null && before !== after) triggers.push(trigger);
  };

  changed('workerProtocolVersion', 'worker_protocol_changed');
  changed('permissionPolicyFingerprint', 'permission_policy_changed');
  changed('githubCredentialFingerprint', 'github_credential_changed');
  changed('runtimeName', 'runtime_changed');
  changed('integrationAlgorithmFingerprint', 'integration_algorithm_changed');
  changed('reviewAlgorithmFingerprint', 'review_algorithm_changed');
  changed('sandboxRepository', 'sandbox_repository_changed');

  if (input.recoveryCheckPassing === false) triggers.push('recovery_check_failed');
  if (input.securityCheckPassing === false) triggers.push('security_check_failed');

  const ageMs = Date.parse(input.nowIso) - Date.parse(input.qualifiedAt);
  if (Number.isFinite(ageMs) && ageMs > QUALIFICATION_MAX_AGE_DAYS * 86_400_000) {
    triggers.push('expired');
  }

  return {
    required: triggers.length > 0,
    triggers,
    reason:
      triggers.length === 0
        ? null
        : `${triggers.map((trigger) => REQUALIFICATION_TRIGGER_LABELS[trigger]).join('; ')}. Live qualification no longer applies.`,
  };
}

/* ------------------------------------------------------ the activation lock */

export const ACTIVATION_CAPABILITIES = [
  /* Things a schedule may always do, once the suite passes. */
  'scheduled_evidence_refresh',
  'scheduled_briefing',
  'scheduled_notification',
  /* Things that need a real model. */
  'scheduled_research',
  'scheduled_mission_draft',
  'model_task_readonly',
  /* Things that write. */
  'model_task_write',
  'github_write',
  'ci_dispatch',
  'testflight_dispatch',
] as const;
export type ActivationCapability = (typeof ACTIVATION_CAPABILITIES)[number];

/**
 * The rung each capability needs before it may run **unattended**.
 *
 * Note what is *not* here: nothing requires `production` except the two capabilities that reach
 * other people's devices and other people's infrastructure. Gating ordinary read-only research
 * behind a full production qualification would make the lock so annoying that the first thing
 * anyone did would be to remove it, and a security control nobody can live with is not a control.
 */
export const CAPABILITY_REQUIRED_LEVEL: Record<ActivationCapability, QualificationLevel> = {
  scheduled_evidence_refresh: 'automated',
  scheduled_briefing: 'automated',
  scheduled_notification: 'automated',
  scheduled_research: 'live_read',
  scheduled_mission_draft: 'live_read',
  model_task_readonly: 'live_read',
  model_task_write: 'live_write',
  github_write: 'live_write',
  ci_dispatch: 'production',
  testflight_dispatch: 'production',
};

export const CAPABILITY_LABELS: Record<ActivationCapability, string> = {
  scheduled_evidence_refresh: 'refresh evidence on a schedule',
  scheduled_briefing: 'produce a briefing on a schedule',
  scheduled_notification: 'send a notification on a schedule',
  scheduled_research: 'run read-only research on a schedule',
  scheduled_mission_draft: 'draft a mission on a schedule',
  model_task_readonly: 'run a read-only agent task',
  model_task_write: 'run an agent task that writes',
  github_write: 'push a branch or open a pull request',
  ci_dispatch: 'start a CI workflow',
  testflight_dispatch: 'send a build to TestFlight',
};

export interface ActivationVerdict {
  readonly allowed: boolean;
  readonly required: QualificationLevel;
  readonly actual: QualificationLevel;
  readonly reason: string | null;
}

export function evaluateActivation(
  capability: ActivationCapability,
  level: QualificationLevel,
): ActivationVerdict {
  const required = CAPABILITY_REQUIRED_LEVEL[capability];
  const allowed = meetsLevel(level, required);
  return {
    allowed,
    required,
    actual: level,
    reason: allowed
      ? null
      : `Jarvis will not ${CAPABILITY_LABELS[capability]} unattended until ${QUALIFICATION_LEVEL_LABELS[required].toLowerCase()}. It is currently at "${QUALIFICATION_LEVEL_LABELS[level]}".`,
  };
}

/**
 * The choke point.
 *
 * Throws, because every caller's correct response is to stop, and a boolean at a dispatch boundary
 * is a boolean somebody eventually forgets to read. `ForbiddenError` rather than a validation
 * error: the request is well-formed and the answer is still no.
 */
export function assertActivationAllowed(
  capability: ActivationCapability,
  level: QualificationLevel,
): void {
  const verdict = evaluateActivation(capability, level);
  if (!verdict.allowed) {
    throw new ForbiddenError(verdict.reason ?? 'That is not qualified to run unattended.', {
      capability,
      required: verdict.required,
      actual: verdict.actual,
    });
  }
}

/**
 * Which capabilities are currently unlocked, for the interface to show plainly.
 *
 * Both halves are returned. Showing only what is unlocked invites the reading that everything else
 * is broken; showing both makes the ladder legible.
 */
export function describeActivation(level: QualificationLevel): {
  readonly unlocked: readonly ActivationCapability[];
  readonly locked: readonly {
    readonly capability: ActivationCapability;
    readonly needs: QualificationLevel;
  }[];
} {
  const unlocked: ActivationCapability[] = [];
  const locked: { capability: ActivationCapability; needs: QualificationLevel }[] = [];
  for (const capability of ACTIVATION_CAPABILITIES) {
    const needs = CAPABILITY_REQUIRED_LEVEL[capability];
    if (meetsLevel(level, needs)) unlocked.push(capability);
    else locked.push({ capability, needs });
  }
  return { unlocked, locked };
}

/* ------------------------------------------------------------------ schemas */

export const qualificationRunSchema = z.object({
  /** Which rung to attempt. Everything below it is checked as well. */
  target: z.enum(QUALIFICATION_LEVELS).default('live_read'),
  note: z.string().trim().max(600).nullish(),
});
export type QualificationRunInput = z.infer<typeof qualificationRunSchema>;

export const sandboxSelectionSchema = z.object({
  repositoryFullName: z
    .string()
    .trim()
    .max(200)
    .regex(/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/, 'Use owner/repo.'),
  /** Typed, because a sandbox is where a real model is about to write. */
  confirmation: z.literal('use this repository for qualification'),
});
export type SandboxSelectionInput = z.infer<typeof sandboxSelectionSchema>;

export const liveWriteApprovalSchema = z.object({
  runId: z.string().uuid(),
  confirmation: z.literal('let a real agent write to the sandbox'),
  note: z.string().trim().max(600).nullish(),
});

/**
 * A recorded live qualification.
 *
 * Every field is safe to store. Notably absent: any credential, and any raw provider response.
 * The commit and the pull-request number are the evidence; they are checkable by me and useless
 * to anyone else.
 */
export interface LiveQualificationEvidence {
  readonly id: string;
  readonly kind: 'live_read' | 'live_write';
  readonly runId: string;
  readonly missionId: string | null;
  readonly performedAt: string;
  readonly providerName: string | null;
  readonly modelName: string | null;
  readonly repositoryFullName: string;
  readonly commitSha: string | null;
  readonly branchName: string | null;
  readonly pullRequestUrl: string | null;
  readonly pullRequestNumber: number | null;
  readonly findingsCount: number | null;
  readonly outputTokens: number | null;
  readonly durationMs: number | null;
  readonly qualificationVersion: string;
  readonly summary: string;
}

/**
 * The version of the qualification *procedure*.
 *
 * Bumped when the checks themselves change meaningfully, so a run recorded under an older
 * procedure is visibly older rather than silently equivalent. A qualification is only as good as
 * the questions it asked.
 */
export const QUALIFICATION_VERSION = '4.0';
