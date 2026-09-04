import { sql } from 'drizzle-orm';
import { ForbiddenError, ValidationError } from '@/domain/errors';
import {
  QUALIFICATION_CHECKS,
  QUALIFICATION_VERSION,
  evaluateActivation,
  evaluateQualification,
  requiresRequalification,
  type ActivationCapability,
  type ActivationVerdict,
  type CheckOutcome,
  type QualificationAssumptions,
  type QualificationCheckId,
  type QualificationCheckResult,
  type QualificationLevel,
  type QualificationRun,
  type QualificationVerdict,
  type RequalificationVerdict,
} from '@/domain/qualification';
import { WORKER_VERSION, isCompatibleWorkerVersion } from '@/domain/worker-protocol';
import { deriveWorkerHealth } from '@/domain/worker';
import type { AppConfig } from '@/server/config/env';
import type { Database } from '@/server/db/client';
import type { SourceProvider } from '@/server/providers/types';
import type {
  QualificationRepository,
  PreferenceRepository,
  PushRepository,
} from '@/server/repositories/automation-types';
import type { ReceiptRepository } from '@/server/repositories/factory-types';
import type {
  MissionRepository,
  VerificationRepository,
} from '@/server/repositories/mission-types';
import type { SourceRepository } from '@/server/repositories/types';
import { resolveMissionRepository } from '@/server/missions/repository-resolution';
import type { SettingsRepository } from '@/server/repositories/types';
import type { WorkerRepository } from '@/server/repositories/mission-types';
import {
  checkDeliveryRestricted,
  checkDisplayReadOnly,
  checkDispatcherRestricted,
} from './surface-checks';

/**
 * Qualification.
 *
 * The rule this service exists to enforce is the one Prompt 4 states first: **built**, **automated
 * verification passed**, **simulated runtime passed**, **live read qualified**, **live write
 * qualified** and **production-qualified** are six different claims, and collapsing them into one
 * "healthy" flag is how a system comes to lie about itself.
 *
 * Three properties hold here regardless of what a caller asks for:
 *
 *  - **An absent answer is not a pass.** A check that cannot run reports `unavailable`, which
 *    never satisfies a rung. An environment with no model credential lands honestly on
 *    `automated` rather than on a level it has not earned.
 *  - **Nothing here reads a credential value.** The checks establish presence, identity and
 *    behaviour. There is no code path by which a secret could reach a result, because
 *    `QualificationCheckResult` has nowhere to put one.
 *  - **Live rungs cannot be self-reported.** `live_read_audit` and `live_write_draft_pr` are
 *    satisfied only by a `live_qualification_evidence` row naming a real repository and a real
 *    commit, recorded under the current qualification version.
 */

/**
 * The migrations this build expects to find applied.
 *
 * A constant rather than a directory listing, because the source tree is not present at runtime
 * in a serverless deployment. A test compares this list against `drizzle/*.sql`, so adding a
 * migration without adding it here fails the suite rather than producing a check that quietly
 * stops meaning anything.
 */
export const EXPECTED_MIGRATIONS: readonly string[] = [
  '0000_init.sql',
  '0001_missions.sql',
  '0002_factory.sql',
  '0003_completion.sql',
  '0004_knowledge_revisions.sql',
  '0005_memory_sensitivity.sql',
  '0006_ask_conversations.sql',
];

/** Settings keys this service owns. Named once so a typo cannot silently create a second key. */
export const QUALIFICATION_KEYS = Object.freeze({
  sandbox: 'qualification.sandboxRepository',
  recoveryDrill: 'qualification.recoveryDrill',
  securityReview: 'qualification.securityReview',
});

export interface RecordedAttestation {
  readonly recordedAt: string;
  readonly recordedBy: string;
  readonly buildRef: string | null;
  readonly note: string;
}

export interface QualificationStatus {
  readonly verdict: QualificationVerdict;
  readonly run: QualificationRun | null;
  readonly requalification: RequalificationVerdict | null;
  readonly automatedPassed: boolean;
  readonly simulatedPassed: boolean;
  readonly qualificationVersion: string;
  readonly sandboxRepository: string | null;
  readonly allowedSandboxes: readonly string[];
  readonly buildRef: string | null;
}

export interface QualificationServiceOptions {
  readonly qualification: QualificationRepository;
  readonly workers: WorkerRepository;
  readonly settings: SettingsRepository;
  readonly preferences: PreferenceRepository;
  readonly push: PushRepository;
  readonly provider: SourceProvider;
  readonly missions: MissionRepository;
  readonly receipts: ReceiptRepository;
  /**
   * Needed by `verification_discoverable`, which used to answer a different question.
   *
   * That check's title is "the repository's own checks can be found and run", and it was
   * implemented as "a live write was recorded" — the same call as `live_write_draft_pr`, so the
   * two were indistinguishable and neither looked at a verification. Answering it honestly means
   * reading what actually ran.
   */
  readonly verifications: VerificationRepository;
  readonly sources: SourceRepository;
  readonly config: AppConfig;
  readonly db: Database;
  readonly clock?: () => Date;
}

export class QualificationService {
  private readonly clock: () => Date;

  constructor(private readonly options: QualificationServiceOptions) {
    this.clock = options.clock ?? (() => new Date());
  }

  /* -------------------------------------------------------------- reading */

  /**
   * Where the system currently stands.
   *
   * Reads the last non-superseded run rather than re-running the checks, because a level is a
   * *dated claim about a build*, not a live measurement. Re-deriving it on every page load would
   * mean a level that silently changed when a credential expired — which is exactly what
   * `requiresRequalification` is for: it says the claim no longer applies, rather than quietly
   * substituting a different one.
   */
  async status(): Promise<QualificationStatus> {
    const [run, outcomes, sandbox] = await Promise.all([
      this.options.qualification.latestRun(),
      this.options.qualification.suiteOutcomes(),
      this.options.settings.get<string>(QUALIFICATION_KEYS.sandbox),
    ]);

    const automated = outcomes.find((outcome) => outcome.kind === 'automated');
    const simulated = outcomes.find((outcome) => outcome.kind === 'simulated');
    const buildRef = this.options.config.qualification.buildRef;

    /*
     * A suite that passed on a *different* build says nothing about this one. Comparing the build
     * ref is what stops yesterday's green run from qualifying today's deployment — and when no
     * build ref is configured at all, the comparison cannot be made, so the outcome stands and
     * the interface reports the missing ref as a gap rather than pretending to a check it did not
     * perform.
     */
    const sameBuild = (candidate: string | null): boolean =>
      buildRef === null || candidate === null || candidate === buildRef;

    const automatedPassed = Boolean(automated?.passed && sameBuild(automated.buildRef));
    const simulatedPassed = Boolean(simulated?.passed && sameBuild(simulated.buildRef));

    const verdict = evaluateQualification({
      results: run?.results ?? [],
      automatedPassed,
      simulatedPassed,
    });

    const requalification = run
      ? requiresRequalification({
          qualifiedUnder: run.assumptions,
          current: await this.currentAssumptions(),
          qualifiedAt: run.startedAt,
          nowIso: this.clock().toISOString(),
          /*
           * The two attestations feed back in as triggers. A security review that has stopped
           * applying to this build does not merely fail its own check — it invalidates the live
           * rungs that were earned while it did apply.
           */
          recoveryCheckPassing: checkOutcome(run, 'recovery_drill'),
          securityCheckPassing: checkOutcome(run, 'security_review'),
        })
      : null;

    return {
      verdict,
      run,
      requalification,
      automatedPassed,
      simulatedPassed,
      qualificationVersion: QUALIFICATION_VERSION,
      sandboxRepository: sandbox ?? null,
      allowedSandboxes: this.options.config.qualification.sandboxRepositories,
      buildRef,
    };
  }

  /**
   * The level in force *right now*, for a gate rather than for a screen.
   *
   * Demotes to `built` when requalification is required. A qualification earned under different
   * assumptions is not a qualification for the system as it stands, and the safe reading of "the
   * worker protocol changed underneath the run that qualified it" is that nothing is qualified
   * until it is checked again.
   */
  async currentLevel(): Promise<QualificationLevel> {
    const status = await this.status();
    if (status.requalification?.required) return 'built';
    return status.verdict.level;
  }

  /* ------------------------------------------------------------ activation */

  /**
   * The activation lock.
   *
   * Throws, because at a dispatch boundary the only correct response is to stop. Callers that
   * need to *report* rather than refuse — a worker-facing route, where a 403 would kill the
   * worker process — ask `evaluate` instead and put the refusal in a 200 body.
   */
  async assertAllowed(capability: ActivationCapability): Promise<void> {
    const verdict = await this.evaluate(capability);
    if (!verdict.allowed) {
      throw new ForbiddenError(verdict.reason ?? 'That is not qualified to run unattended.', {
        capability,
        required: verdict.required,
        actual: verdict.actual,
      });
    }
  }

  async evaluate(capability: ActivationCapability): Promise<ActivationVerdict> {
    return evaluateActivation(capability, await this.currentLevel());
  }

  /* -------------------------------------------------------------- running */

  /**
   * Run every check this environment can decide for itself, and record the result.
   *
   * Checks that need a real credential, a real repository or a real model session are recorded as
   * `unavailable` with a remedy rather than skipped: a check nobody can see is a check nobody
   * fixes.
   */
  async run(
    input: { readonly startedBy: string; readonly note?: string | null } = { startedBy: 'owner' },
  ): Promise<QualificationStatus> {
    const assumptions = await this.currentAssumptions();
    const run = await this.options.qualification.createRun({
      startedBy: input.startedBy,
      buildRef: this.options.config.qualification.buildRef,
      assumptions,
      note: input.note ?? null,
      qualificationVersion: QUALIFICATION_VERSION,
    });

    for (const check of QUALIFICATION_CHECKS) {
      const started = Date.now();
      const outcome = await this.performCheck(check.id);
      await this.options.qualification.recordCheck(run.id, {
        id: check.id,
        outcome: outcome.outcome,
        detail: outcome.detail,
        evidence: outcome.evidence,
        durationMs: Date.now() - started,
      });
    }

    const stored = await this.options.qualification.findRun(run.id);
    const outcomes = await this.options.qualification.suiteOutcomes();
    const verdict = evaluateQualification({
      results: stored?.results ?? [],
      automatedPassed: Boolean(outcomes.find((entry) => entry.kind === 'automated')?.passed),
      simulatedPassed: Boolean(outcomes.find((entry) => entry.kind === 'simulated')?.passed),
    });

    await this.options.qualification.finishRun(run.id, verdict.level, this.clock());
    await this.options.qualification.supersedeOlderThan(run.id, this.clock());
    return this.status();
  }

  /**
   * Run every check now, and record nothing.
   *
   * `status()` reports the last stored run, which is the right answer for "what is this
   * deployment qualified for" — a qualification is a dated claim, and re-measuring it on every
   * page load would make it a live gauge instead. But a diagnostic needs the opposite: what is
   * true *right now*, before anything has been recorded. Recording every invocation would also
   * mean a `doctor` run could quietly demote a deployment.
   *
   * So this shares `performCheck` with `run()` — the same code, the same rules, no writes.
   */
  async dryRun(): Promise<readonly QualificationCheckResult[]> {
    const results: QualificationCheckResult[] = [];
    for (const check of QUALIFICATION_CHECKS) {
      const started = Date.now();
      const outcome = await this.performCheck(check.id);
      results.push({
        id: check.id,
        outcome: outcome.outcome,
        detail: outcome.detail,
        evidence: outcome.evidence,
        checkedAt: this.clock().toISOString(),
        durationMs: Date.now() - started,
      });
    }
    return results;
  }

  /* ------------------------------------------------------------- recording */

  async recordSuite(input: {
    readonly kind: 'automated' | 'simulated';
    readonly passed: boolean;
    readonly detail: string;
    readonly testCount: number | null;
  }): Promise<void> {
    await this.options.qualification.recordSuiteOutcome({
      kind: input.kind,
      passed: input.passed,
      buildRef: this.options.config.qualification.buildRef,
      detail: input.detail,
      testCount: input.testCount,
    });
  }

  /**
   * Choose the sandbox.
   *
   * Refused unless the repository is on the configured allow-list. Jarvis having read access to a
   * repository is not the same as that repository being a place to rehearse a real write, and
   * conflating the two is how a "qualification run" ends up opening a pull request against
   * something that matters.
   */
  async selectSandbox(repositoryFullName: string): Promise<string> {
    const normalised = repositoryFullName.trim().toLowerCase();
    if (!this.options.config.qualification.sandboxRepositories.includes(normalised)) {
      throw new ValidationError(
        `${repositoryFullName} is not allow-listed for qualification. Add it to JARVIS_QUALIFICATION_REPOS first.`,
      );
    }
    await this.options.settings.set(QUALIFICATION_KEYS.sandbox, normalised);
    return normalised;
  }

  async recordAttestation(input: {
    readonly kind: 'recoveryDrill' | 'securityReview';
    readonly note: string;
    readonly recordedBy: string;
  }): Promise<RecordedAttestation> {
    if (input.note.trim().length < 10) {
      throw new ValidationError(
        'Record what was actually done. A one-word attestation is not evidence.',
      );
    }
    const attestation: RecordedAttestation = {
      recordedAt: this.clock().toISOString(),
      recordedBy: input.recordedBy,
      buildRef: this.options.config.qualification.buildRef,
      note: input.note.trim().slice(0, 600),
    };
    await this.options.settings.set(QUALIFICATION_KEYS[input.kind], attestation);
    return attestation;
  }

  /**
   * Turn a finished mission into live qualification evidence.
   *
   * Deliberately not a form. A person cannot assert that a live run happened; the service reads
   * what the mission actually produced and refuses when it does not match the claim:
   *
   *  - **R-QL1** — the mission has to have succeeded. A mission that failed proves the opposite.
   *  - **R-QL2** — it has to have run against the selected sandbox. A successful run against a
   *    real project is not a rehearsal, and recording it as one would be the exact confusion the
   *    allow-list exists to prevent.
   *  - **R-QL3** — a write qualification needs a pull request that exists, with a number.
   *  - **R-QL4** — a *read* qualification must have produced a report and must **not** have
   *    opened a pull request. A read-only run that wrote something is a failed read-only run, and
   *    accepting it would qualify exactly the property it disproved.
   *  - **R-QL5** — one mission produces one piece of evidence. Recording the same run twice
   *    would make one rehearsal look like a pattern.
   */
  async recordLiveQualification(input: {
    readonly missionId: string;
    readonly kind: 'live_read' | 'live_write';
  }): Promise<{ readonly rule: string; readonly summary: string }> {
    const mission = await this.options.missions.findById(input.missionId);
    if (!mission) throw new ValidationError('That mission does not exist.');

    if (mission.state !== 'completed') {
      throw new ValidationError(
        `Mission "${mission.title}" is ${mission.state}. Only a mission that succeeded is evidence of anything (R-QL1).`,
      );
    }

    const sandbox = await this.options.settings.get<string>(QUALIFICATION_KEYS.sandbox);

    /*
     * Resolved the same way every other caller resolves it, rather than read off the mission's
     * own columns. Those columns are an *override* that the ordinary creation path never sets;
     * reading them directly would mean every real mission resolved to no repository and every
     * live qualification was refused — the same defect the shared resolver was written to fix.
     */
    const projectSources = mission.projectId
      ? await this.options.sources.listByProject(mission.projectId)
      : [];
    const resolved = resolveMissionRepository(mission, projectSources);
    const repository = resolved ? resolved.fullName.toLowerCase() : null;

    if (!sandbox || repository !== sandbox) {
      throw new ValidationError(
        `That mission ran against ${repository ?? 'no repository'}, not the selected sandbox ${sandbox ?? '(none chosen)'} (R-QL2).`,
      );
    }

    const receipt = await this.options.receipts.findByMission(mission.id);
    const content = receipt?.content ?? null;

    if (input.kind === 'live_write') {
      if (!content?.pullRequestUrl || content.pullRequestNumber === null) {
        throw new ValidationError(
          'That mission did not open a pull request, so it is not evidence that live write works (R-QL3).',
        );
      }
    } else {
      if (content?.pullRequestUrl) {
        throw new ValidationError(
          'That mission opened a pull request, so it is not evidence of a read-only run (R-QL4).',
        );
      }
      if (!content || content.artifacts.length === 0) {
        throw new ValidationError(
          'That mission produced no report, so there is nothing to show a model actually read the repository (R-QL4).',
        );
      }
    }

    const existing = await this.options.qualification.listLiveEvidence(50);
    if (existing.some((entry) => entry.missionId === mission.id)) {
      throw new ValidationError('That mission has already been recorded as evidence (R-QL5).');
    }

    const run =
      (await this.options.qualification.latestRun()) ??
      (await this.options.qualification.createRun({
        startedBy: 'system',
        buildRef: this.options.config.qualification.buildRef,
        assumptions: await this.currentAssumptions(),
        qualificationVersion: QUALIFICATION_VERSION,
      }));

    const findings =
      (content?.remainingFindings.length ?? 0) + (content?.repairedFindings.length ?? 0);

    await this.options.qualification.recordLiveEvidence({
      kind: input.kind,
      runId: run.id,
      missionId: mission.id,
      providerName: this.options.config.ai.enabled ? 'anthropic' : null,
      modelName: this.options.config.ai.model,
      repositoryFullName: repository,
      commitSha: mission.baseSha ?? null,
      branchName: content?.integrationBranch ?? null,
      pullRequestUrl: content?.pullRequestUrl ?? null,
      pullRequestNumber: content?.pullRequestNumber ?? null,
      findingsCount: findings,
      outputTokens: content?.usage.outputTokens ?? null,
      durationMs: content?.usage.durationMs ?? null,
      qualificationVersion: QUALIFICATION_VERSION,
      summary:
        input.kind === 'live_write'
          ? `A live session wrote inside its declared paths on ${repository} and left draft pull request #${content?.pullRequestNumber}. Nothing was merged.`
          : `A live session audited ${repository} read-only and produced ${content?.artifacts.length ?? 0} report(s) with ${findings} finding(s). Nothing was written.`,
    });

    return {
      rule: 'R-QL0',
      summary: `Recorded ${input.kind === 'live_write' ? 'a live write' : 'a live read'} against ${repository}.`,
    };
  }

  /* ---------------------------------------------------------------- checks */

  private async performCheck(id: QualificationCheckId): Promise<{
    readonly outcome: CheckOutcome;
    readonly detail: string;
    readonly evidence: Readonly<Record<string, string>>;
  }> {
    switch (id) {
      case 'worker_enrolled':
        return this.checkWorkerEnrolled();
      case 'worker_version':
        return this.checkWorkerVersion();
      case 'model_provider':
        return this.checkModelProvider();
      case 'github_read':
        return this.checkGithubRead();
      case 'github_write_credential':
        return this.checkGithubWrite();
      case 'sandbox_selected':
        return this.checkSandboxSelected();
      case 'sandbox_allow_listed':
        return this.checkSandboxAllowListed();
      case 'delivery_restricted':
        return fromSurface(checkDeliveryRestricted(), checkDispatcherRestricted());
      case 'display_read_only':
        return fromSurface(await checkDisplayReadOnly());
      case 'backup_configured':
        return this.checkBackups();
      case 'migrations_applied':
        return this.checkMigrations();
      case 'notification_destination':
        return this.checkNotificationDestination();
      case 'verification_discoverable':
        return this.checkVerificationRan();
      case 'live_read_audit':
        return this.checkRecordedEvidence('live_read', 'audit');
      case 'live_write_draft_pr':
        return this.checkRecordedEvidence('live_write', 'draft pull request');
      case 'recovery_drill':
        return this.checkAttestation('recoveryDrill');
      case 'security_review':
        return this.checkAttestation('securityReview');
    }
  }

  private async checkWorkerEnrolled() {
    const workers = await this.options.workers.list();
    const live = workers.filter((worker) => {
      const health = deriveWorkerHealth(worker, this.clock());
      /*
       * `disconnected` is the honest reading of a worker whose heartbeat has lapsed: the row
       * still exists, but nothing is listening, and a rung that needs a worker is not earned by
       * a row.
       */
      return (
        worker.revokedAt === null &&
        health.effectiveStatus !== 'disconnected' &&
        health.effectiveStatus !== 'revoked'
      );
    });

    if (live.length === 0) {
      return unavailable(
        workers.length === 0
          ? 'No worker has ever enrolled.'
          : `${workers.length} worker(s) are enrolled but none has sent a recent heartbeat.`,
        { enrolled: String(workers.length) },
      );
    }
    return pass(`${live.length} worker(s) enrolled and sending heartbeats.`, {
      workers: String(live.length),
    });
  }

  private async checkWorkerVersion() {
    const workers = await this.options.workers.list();
    const live = workers.filter((worker) => worker.revokedAt === null);
    if (live.length === 0) return unavailable('No worker to ask.', {});

    const incompatible = live.filter((worker) => !isCompatibleWorkerVersion(worker.version));
    if (incompatible.length > 0) {
      return fail(
        `${incompatible.length} worker(s) report a version incompatible with ${WORKER_VERSION}.`,
        {
          expected: WORKER_VERSION,
          seen: incompatible.map((w) => w.version ?? 'unknown').join(', '),
        },
      );
    }
    return pass(`Every worker reports a build compatible with ${WORKER_VERSION}.`, {
      expected: WORKER_VERSION,
      seen: [...new Set(live.map((worker) => worker.version ?? 'unknown'))].join(', '),
    });
  }

  private async checkModelProvider() {
    const workers = (await this.options.workers.list()).filter((w) => w.revokedAt === null);
    if (workers.length === 0) return unavailable('No worker to ask.', {});

    const ready = workers.filter((worker) => worker.runtimeAvailable);
    if (ready.length === 0) {
      return unavailable(
        'No worker reports a usable model runtime. The credential belongs in the worker’s own environment, never here.',
        { workers: String(workers.length) },
      );
    }

    /*
     * A stand-in runtime is not a model provider.
     *
     * `JARVIS_WORKER_RUNTIME=scripted` exists so the whole mission path can be exercised without
     * a model, and it reports itself available because it genuinely is — for what it is. Counting
     * it here would let a deployment with no Anthropic key anywhere qualify as having a model
     * provider, which is the exact shape of dishonesty this ladder exists to prevent, and the
     * mistake would only surface when a real mission produced scripted output.
     */
    const real = ready.filter((worker) => !isStandInRuntime(worker.runtimeName));
    if (real.length === 0) {
      return fail(
        `Every available worker is running a stand-in runtime (${[
          ...new Set(ready.map((worker) => worker.runtimeName ?? 'unnamed')),
        ].join(
          ', ',
        )}), which runs no model. Unset JARVIS_WORKER_RUNTIME and give the worker a real model credential.`,
        {
          runtimes: [...new Set(ready.map((worker) => worker.runtimeName ?? 'unnamed'))].join(', '),
        },
      );
    }

    return pass(
      `${real.length} worker(s) report a real model runtime. Jarvis knows only that; the key never leaves the worker.`,
      { runtimes: [...new Set(real.map((worker) => worker.runtimeName ?? 'unnamed'))].join(', ') },
    );
  }

  private async checkGithubRead() {
    if (!this.options.provider.isConfigured()) {
      return unavailable('No GitHub read credential is configured.', {});
    }
    try {
      const health = await this.options.provider.checkHealth();
      if (!health.ok) {
        return fail(`GitHub read access is configured but not working: ${health.message}`, {
          account: health.account ?? 'unknown',
        });
      }
      return pass(`GitHub read access works as ${health.account ?? 'an unnamed identity'}.`, {
        account: health.account ?? 'unknown',
        readOnly: String(health.readOnly),
      });
    } catch (error) {
      return unavailable(
        `GitHub could not be reached: ${error instanceof Error ? error.message : 'unknown error'}`,
        {},
      );
    }
  }

  private async checkGithubWrite() {
    const workers = (await this.options.workers.list()).filter((w) => w.revokedAt === null);
    const workerDelivery = workers.filter((worker) => worker.githubDeliveryConfigured);
    const ciCredential = this.options.config.ci.credentialConfigured;

    if (workerDelivery.length === 0 && !ciCredential) {
      return unavailable(
        'No write credential exists at the delivery boundary. It belongs to the worker or the CI controller, never to the browser and never to the read token.',
        {},
      );
    }
    return pass(
      /*
       * Says what was established and no more. This reads a boolean the worker reports about its
       * own environment — the credential itself never comes here — so "a credential is present"
       * is the whole finding. Whether it authenticates is proved by `live_write_draft_pr`, which
       * needs a real draft pull request, and the rung requires both.
       */
      `A write credential is present at the delivery boundary: ${[
        workerDelivery.length > 0 ? `${workerDelivery.length} worker(s)` : null,
        ciCredential ? 'the CI controller' : null,
      ]
        .filter(Boolean)
        .join(
          ' and ',
        )}. It lives outside the control plane, so nothing here can read it; that it works is proved by a real draft pull request, not by this check.`,
      {
        workerDelivery: String(workerDelivery.length),
        ciController: String(ciCredential),
      },
    );
  }

  private async checkSandboxSelected() {
    const sandbox = await this.options.settings.get<string>(QUALIFICATION_KEYS.sandbox);
    if (!sandbox) {
      return unavailable('No sandbox repository has been chosen.', {});
    }
    return pass(`Live qualification will use ${sandbox}.`, { repository: sandbox });
  }

  private async checkSandboxAllowListed() {
    const sandbox = await this.options.settings.get<string>(QUALIFICATION_KEYS.sandbox);
    const allowed = this.options.config.qualification.sandboxRepositories;

    if (allowed.length === 0) {
      return unavailable('JARVIS_QUALIFICATION_REPOS is empty, so nothing is allow-listed.', {});
    }
    if (!sandbox)
      return unavailable('No sandbox has been chosen yet.', {
        allowListed: String(allowed.length),
      });
    if (!allowed.includes(sandbox)) {
      return fail(`${sandbox} is not on the allow-list.`, {
        repository: sandbox,
        allowListed: allowed.join(', '),
      });
    }
    return pass(`${sandbox} was named deliberately for qualification.`, {
      repository: sandbox,
      allowListed: String(allowed.length),
    });
  }

  private async checkBackups() {
    const { backupConfigured, backupTarget, backupRestoreTestedAt } =
      this.options.config.qualification;

    if (!backupConfigured) {
      return unavailable('No backup target is configured.', {});
    }
    if (!backupRestoreTestedAt) {
      return fail(
        'Backups are configured but no restore has been rehearsed. An untested backup is a belief, not a control.',
        { target: backupTarget ?? 'unnamed' },
      );
    }
    return pass(
      /*
       * Attributed, not asserted. Both halves of this are declarations an owner made in the
       * environment; Jarvis cannot see a backup and did not watch the restore. The stronger claim
       * is `recovery_drill`, which needs an attestation recorded through the CLI describing what
       * was actually seen — and it is a separate check for exactly that reason.
       */
      `You have declared backups to ${backupTarget ?? 'the configured target'}, with a restore rehearsed on ${backupRestoreTestedAt.slice(0, 10)}. Jarvis takes that on your word; the recovery drill check is the one with evidence behind it.`,
      { target: backupTarget ?? 'unnamed', restoreTested: backupRestoreTestedAt },
    );
  }

  private async checkMigrations() {
    try {
      const result = await this.options.db.execute(
        sql`select name from _jarvis_migrations order by name`,
      );
      const applied = new Set(rowsOf(result).map((row) => String((row as { name: unknown }).name)));
      const missing = EXPECTED_MIGRATIONS.filter((name) => !applied.has(name));

      if (missing.length > 0) {
        return fail(
          `${missing.length} migration(s) have not been applied: ${missing.join(', ')}.`,
          { missing: missing.join(', '), applied: String(applied.size) },
        );
      }
      return pass(`All ${EXPECTED_MIGRATIONS.length} migrations are applied.`, {
        applied: String(applied.size),
      });
    } catch (error) {
      return unavailable(
        `The migration table could not be read: ${error instanceof Error ? error.message : 'unknown error'}`,
        {},
      );
    }
  }

  private async checkNotificationDestination() {
    const [preferences, subscriptions] = await Promise.all([
      this.options.preferences.all(),
      this.options.push.list(),
    ]);

    const livePush = subscriptions.filter((subscription) => subscription.revokedAt === null);
    const silenced = preferences.filter(
      (preference) => !preference.enabled || preference.channels.length === 0,
    );

    /*
     * In-app is always available and always carries, so this check cannot fail — but it can be
     * *weak*, and saying so is the point. "You will find out when you next open Jarvis" is a
     * real answer to "how would I learn the worker died at 3am", and it is not a good one.
     */
    if (livePush.length === 0) {
      return pass(
        'In-app notifications are available. There is no push destination, so a serious failure would wait until Jarvis is next opened.',
        { push: '0', silencedCategories: String(silenced.length) },
      );
    }
    return pass(
      `In-app notifications are available and ${livePush.length} push destination(s) are registered.`,
      { push: String(livePush.length), silencedCategories: String(silenced.length) },
    );
  }

  /**
   * A rung that can only be earned by doing the thing.
   *
   * Looks for a `live_qualification_evidence` row of the right kind, recorded under the current
   * qualification version. An older procedure's evidence does not carry forward, because the
   * questions changed.
   */
  private async checkRecordedEvidence(kind: 'live_read' | 'live_write', what: string) {
    const evidence = await this.options.qualification.listLiveEvidence(20);
    const match = evidence.find(
      (entry) => entry.kind === kind && entry.qualificationVersion === QUALIFICATION_VERSION,
    );

    if (!match) {
      const older = evidence.find((entry) => entry.kind === kind);
      return unavailable(
        older
          ? `The most recent ${what} was recorded under qualification version ${older.qualificationVersion}; this build asks version ${QUALIFICATION_VERSION}.`
          : `No live ${what} has been recorded.`,
        older ? { lastVersion: older.qualificationVersion, lastAt: older.performedAt } : {},
      );
    }

    return pass(
      `A live ${what} ran against ${match.repositoryFullName} on ${match.performedAt.slice(0, 10)}.`,
      {
        repository: match.repositoryFullName,
        commit: match.commitSha ?? 'unrecorded',
        pullRequest: match.pullRequestUrl ?? 'none',
        model: match.modelName ?? 'unrecorded',
      },
    );
  }

  /**
   * Did the repository's own checks actually get found and run?
   *
   * This is the question the check's title asks, and until now it was implemented as
   * `checkRecordedEvidence('live_write', …)` — the identical call `live_write_draft_pr` makes.
   * Two checks answering one question is one check pretending to be two, and the one pretending
   * was the one gating "Jarvis can verify work in your repository".
   *
   * So it reads the verification records of the mission that produced the live evidence. A
   * mission that opened a draft pull request without a single command being discovered and run
   * proves the delivery path and says nothing about verification, and that is now visible.
   */
  private async checkVerificationRan() {
    const evidence = await this.options.qualification.listLiveEvidence(20);
    const match = evidence.find(
      (entry) =>
        entry.kind === 'live_write' && entry.qualificationVersion === QUALIFICATION_VERSION,
    );
    if (!match) {
      return unavailable('No live write has been recorded, so nothing has been verified yet.', {});
    }
    if (!match.missionId) {
      return unavailable(
        'The recorded live write is not tied to a mission whose checks Jarvis can read.',
        {
          repository: match.repositoryFullName,
        },
      );
    }

    const verifications = await this.options.verifications.list(match.missionId);
    if (verifications.length === 0) {
      return fail(
        `The live write against ${match.repositoryFullName} ran no verification at all. Jarvis discovers a repository's own test, lint or build script; if it found none, it delivered work nothing checked.`,
        { repository: match.repositoryFullName, mission: match.missionId },
      );
    }

    /*
     * A command that could not run is not the same as a command that failed, and neither is the
     * same as one that passed. What this check needs is that commands were *found and executed* —
     * a failing test is a real verification and an honest result.
     */
    const ran = verifications.filter((entry) => entry.outcome !== 'unavailable');
    if (ran.length === 0) {
      return fail(
        `${verifications.length} verification command(s) were found for ${match.repositoryFullName}, but none could run here. The worker needs the toolchain the repository's own scripts expect.`,
        {
          repository: match.repositoryFullName,
          commands: verifications.map((entry) => entry.command).join(', '),
        },
      );
    }

    const passed = ran.filter((entry) => entry.outcome === 'passed').length;
    return pass(
      `${ran.length} of the repository's own command(s) were discovered and run against ${match.repositoryFullName} (${passed} passed).`,
      {
        repository: match.repositoryFullName,
        commands: ran.map((entry) => entry.command).join(', '),
        passed: String(passed),
      },
    );
  }

  private async checkAttestation(kind: 'recoveryDrill' | 'securityReview') {
    const attestation = await this.options.settings.get<RecordedAttestation>(
      QUALIFICATION_KEYS[kind],
    );
    if (!attestation) {
      return unavailable('Nothing has been recorded.', {});
    }

    const buildRef = this.options.config.qualification.buildRef;
    if (kind === 'securityReview' && buildRef && attestation.buildRef !== buildRef) {
      return fail(
        `The recorded security review covers ${attestation.buildRef ?? 'an unnamed build'}, not this one.`,
        { reviewed: attestation.buildRef ?? 'unnamed', current: buildRef },
      );
    }

    return pass(
      `Recorded on ${attestation.recordedAt.slice(0, 10)} by ${attestation.recordedBy}.`,
      {
        recordedAt: attestation.recordedAt,
        buildRef: attestation.buildRef ?? 'unnamed',
      },
    );
  }

  /* ----------------------------------------------------------- assumptions */

  /**
   * The trust assumptions as they stand right now.
   *
   * Compared against the ones a run was earned under, so a change is *detected* rather than
   * remembered. Fingerprints rather than values: the point is to notice that something changed,
   * not to record what it changed to.
   */
  private async currentAssumptions(): Promise<QualificationAssumptions> {
    const workers = (await this.options.workers.list()).filter((w) => w.revokedAt === null);
    const sandbox = await this.options.settings.get<string>(QUALIFICATION_KEYS.sandbox);
    const runtimes = [...new Set(workers.map((worker) => worker.runtimeName).filter(Boolean))];

    return {
      workerProtocolVersion: WORKER_VERSION,
      permissionPolicyFingerprint: PERMISSION_POLICY_FINGERPRINT,
      /*
       * Whether a delivery credential exists, and where — never a hash of the credential itself.
       * A fingerprint of a secret is still derived from a secret.
       */
      githubCredentialFingerprint: [
        workers.some((worker) => worker.githubDeliveryConfigured) ? 'worker' : 'none',
        this.options.config.ci.credentialConfigured ? 'ci' : 'none',
      ].join('+'),
      runtimeName: runtimes[0] ?? null,
      integrationAlgorithmFingerprint: INTEGRATION_ALGORITHM_FINGERPRINT,
      reviewAlgorithmFingerprint: REVIEW_ALGORITHM_FINGERPRINT,
      sandboxRepository: sandbox ?? null,
    };
  }
}

/*
 * Fingerprints of the algorithms a qualification depends on.
 *
 * Bumped by hand when the corresponding logic changes in a way that would invalidate a live
 * qualification — a different integration strategy, a different review gate, a different
 * permission profile set. Deliberately manual: a hash computed from the source would change on
 * every comment edit and requalification would become noise nobody reads.
 */
export const PERMISSION_POLICY_FINGERPRINT = 'profiles-v3';
export const INTEGRATION_ALGORITHM_FINGERPRINT = 'sequential-merge-v3';
export const REVIEW_ALGORITHM_FINGERPRINT = 'cold-review-v3';

/**
 * How one check came out in a stored run, as a tri-state.
 *
 * `undefined` for a check the run did not record, because "not asked" and "asked and failed" are
 * different, and `requiresRequalification` treats only the second as a trigger.
 */
function checkOutcome(run: QualificationRun, id: QualificationCheckId): boolean | undefined {
  const result = run.results.find((entry) => entry.id === id);
  if (!result) return undefined;
  if (result.outcome === 'unavailable') return undefined;
  return result.outcome === 'pass' || result.outcome === 'not_applicable';
}

function pass(detail: string, evidence: Readonly<Record<string, string>>) {
  return { outcome: 'pass' as CheckOutcome, detail, evidence };
}

function fail(detail: string, evidence: Readonly<Record<string, string>>) {
  return { outcome: 'fail' as CheckOutcome, detail, evidence };
}

function unavailable(detail: string, evidence: Readonly<Record<string, string>>) {
  return { outcome: 'unavailable' as CheckOutcome, detail, evidence };
}

/** Combine one or more surface verdicts. Any failure fails the check. */
function fromSurface(
  ...verdicts: readonly {
    ok: boolean;
    detail: string;
    evidence: Readonly<Record<string, string>>;
  }[]
) {
  const broken = verdicts.find((verdict) => !verdict.ok);
  if (broken) return fail(broken.detail, broken.evidence);
  return pass(
    verdicts.map((verdict) => verdict.detail).join(' '),
    Object.assign({}, ...verdicts.map((verdict) => verdict.evidence)) as Record<string, string>,
  );
}

/**
 * Runtimes that run no model.
 *
 * Matched by name rather than by a flag on the heartbeat, because the worker reports what it is
 * and the control plane decides what that means — a worker asserting "I am a real model provider"
 * would be a worker deciding its own qualification.
 */
const STAND_IN_RUNTIMES = new Set(['scripted', 'none', 'unavailable']);

function isStandInRuntime(name: string | null): boolean {
  return STAND_IN_RUNTIMES.has((name ?? '').trim().toLowerCase());
}

function rowsOf(result: unknown): unknown[] {
  if (Array.isArray(result)) return result;
  if (result && typeof result === 'object' && 'rows' in result) {
    const rows = (result as { rows: unknown }).rows;
    if (Array.isArray(rows)) return rows;
  }
  return [];
}
