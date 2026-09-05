import { createHash } from 'node:crypto';
import { ConflictError, ForbiddenError, NotFoundError } from '@/domain/errors';
import {
  DISABLED_CI_CONTROLLER,
  dispatchIdentity,
  evaluateCiDispatch,
  evaluateTestFlightDispatch,
  initialReleaseStages,
  type CiControllerConfig,
  type CiDispatch,
  type CiDispatchRequest,
  type CiDispatchRequestInput,
  type ReleaseApproval,
  type ReleaseApprovalInput,
} from '@/domain/ci-dispatch';
import { assessTestFlightReadiness } from '@/domain/app-profile';
import { assertActivationAllowed, type QualificationLevel } from '@/domain/qualification';
import { redactSecrets } from '@/domain/redaction';
import type {
  AppProfileRepository,
  CiDispatchRepository,
  ReleaseApprovalRepository,
} from '../repositories/factory-types';
import type { ActivityLogService } from '../repositories/types';

/**
 * The CI controller.
 *
 * Prompt 2's worker delivery client has four methods and no fifth — no Actions, no secrets, no
 * settings — and **that client is not touched here**. This is a separate object, with a separate
 * credential, that lives on the control plane and that no agent can call. An agent's entire power
 * over CI is to have a task of type `ci_dispatch` in an approved graph, which produces a *request*
 * the owner must approve.
 *
 * Six independent gates stand between a request and a build: the controller must be enabled; it
 * must have its own credential; the repository must be allow-listed; the workflow must be
 * allow-listed; the ref must be allow-listed; and the owner must approve. For a release there is
 * a seventh — the approval is bound to an exact commit, so approving one thing cannot dispatch
 * another.
 *
 * A refusal is a stored row with the rule that caused it. A CI controller that silently drops
 * what it will not do is impossible to audit and impossible to debug.
 */

export interface DispatchOutcome {
  readonly dispatch: CiDispatch;
  readonly allowed: boolean;
  readonly rule: string | null;
  readonly reason: string | null;
}

/** The narrow shape the controller needs from GitHub. Deliberately three methods. */
export interface WorkflowDispatcher {
  dispatch(input: {
    repositoryFullName: string;
    workflowFile: string;
    ref: string;
    inputs: Readonly<Record<string, string>>;
  }): Promise<{ ok: boolean; status: number; detail: string }>;
  /** Find the run this dispatch produced, so its progress can be reported. */
  findRun(input: {
    repositoryFullName: string;
    workflowFile: string;
    ref: string;
    since: string;
  }): Promise<{ id: string; url: string; status: string; conclusion: string | null } | null>;
  /** Whether a repository declares a set of secret *names*. Never their values. */
  declaredSecretNames(repositoryFullName: string): Promise<readonly string[]>;
}

export interface CiControllerDeps {
  readonly config: CiControllerConfig;
  readonly dispatcher: WorkflowDispatcher | null;
  readonly dispatches: CiDispatchRepository;
  readonly approvals: ReleaseApprovalRepository;
  readonly appProfiles: AppProfileRepository;
  readonly activity: ActivityLogService;
  /**
   * The rung this deployment has actually earned.
   *
   * A function rather than a value because the level changes as qualification runs, and a
   * controller constructed once at start-up must not hold a stale one. Optional so a test can
   * construct the controller without the whole qualification stack; absent means unlocked, which
   * is the pre-existing behaviour and only ever reachable from a test.
   */
  readonly currentLevel?: () => Promise<QualificationLevel>;
  readonly clock?: () => Date;
}

export class CiController {
  private readonly clock: () => Date;

  constructor(private readonly deps: CiControllerDeps) {
    this.clock = deps.clock ?? (() => new Date());
  }

  get config(): CiControllerConfig {
    return this.deps.config ?? DISABLED_CI_CONTROLLER;
  }

  /** Owner-facing status, with no credential in it. */
  describe(): {
    enabled: boolean;
    credentialConfigured: boolean;
    repositories: readonly string[];
    workflows: readonly string[];
    refs: readonly string[];
    maxDispatchesPerHour: number;
  } {
    return {
      enabled: this.config.enabled,
      credentialConfigured: this.config.credentialConfigured,
      repositories: this.config.repositories,
      workflows: this.config.workflows,
      refs: this.config.refs,
      maxDispatchesPerHour: this.config.maxDispatchesPerHour,
    };
  }

  /**
   * Record a request for a workflow run.
   *
   * Always writes a row. When policy refuses, the row is `refused` with the rule; when it does
   * not, the row is `awaiting_approval` and *nothing has been dispatched*. This method never
   * calls GitHub.
   */
  async request(input: CiDispatchRequestInput, requestedBy: string): Promise<DispatchOutcome> {
    const request: CiDispatchRequest = {
      repositoryFullName: input.repositoryFullName,
      workflowFile: input.workflowFile,
      ref: input.ref,
      commitSha: input.commitSha,
      inputs: input.inputs,
      purpose: input.purpose,
    };
    const since = new Date(this.clock().getTime() - 60 * 60_000);
    const verdict = evaluateCiDispatch(request, this.config, {
      dispatchesThisHour: await this.deps.dispatches.countSince(since),
    });

    const identity = dispatchIdentity(request);
    const { dispatch } = await this.deps.dispatches.record({
      missionId: input.missionId ?? null,
      taskId: input.taskId ?? null,
      projectId: null,
      purpose: input.purpose,
      repositoryFullName: request.repositoryFullName,
      workflowFile: request.workflowFile,
      ref: request.ref,
      commitSha: request.commitSha,
      inputs: request.inputs,
      inputsFingerprint: createHash('sha256').update(identity).digest('hex'),
      idempotencyKey: createHash('sha256').update(`${identity}|${input.purpose}`).digest('hex'),
      requestedBy,
      state: verdict.allowed ? 'awaiting_approval' : 'refused',
      refusalRule: verdict.rule,
      refusalReason: verdict.reason,
    });

    await this.deps.activity.record({
      kind: verdict.allowed ? 'ci_dispatch_requested' : 'ci_dispatch_refused',
      summary: verdict.allowed
        ? `A workflow run was requested for ${request.repositoryFullName} and is waiting for approval.`
        : `A workflow request was refused (${verdict.rule}).`,
      detail: { workflow: request.workflowFile, rule: verdict.rule },
    });

    return { dispatch, allowed: verdict.allowed, rule: verdict.rule, reason: verdict.reason };
  }

  /**
   * Actually run the workflow.
   *
   * Re-evaluates policy immediately before dispatching rather than trusting the state stored at
   * request time: an allow-list edited in between must take effect, and the cheap thing to do —
   * trusting `state === 'approved'` — would mean a repository removed from the list could still
   * be built.
   */
  async dispatch(dispatchId: string, approvedBy: string): Promise<CiDispatch> {
    const dispatch = await this.deps.dispatches.findById(dispatchId);
    if (!dispatch) throw new NotFoundError('Dispatch');
    if (dispatch.state === 'dispatched' || dispatch.state === 'running') return dispatch;
    if (dispatch.state !== 'awaiting_approval' && dispatch.state !== 'approved') {
      throw new ConflictError(`That request is ${dispatch.state}; it cannot be dispatched.`);
    }

    /*
     * The activation lock, at the boundary it was written for.
     *
     * `assertActivationAllowed` has existed since Phase 4A with the comment "server-side, at the
     * dispatch boundary" and no caller anywhere — the lock was a described control rather than an
     * enforced one. This is the dispatch boundary: past this line a workflow runs on GitHub, and
     * a TestFlight purpose sends a build to real people. Both need `production`.
     *
     * It throws rather than returning a refusal, and the caller's own catch records that as a
     * refused dispatch — the state a refusal already has. A boolean here would be a boolean
     * somebody eventually forgets to read.
     */
    if (this.deps.currentLevel) {
      assertActivationAllowed(
        dispatch.purpose === 'testflight' ? 'testflight_dispatch' : 'ci_dispatch',
        await this.deps.currentLevel(),
      );
    }

    const verdict = evaluateCiDispatch(
      {
        repositoryFullName: dispatch.repositoryFullName,
        workflowFile: dispatch.workflowFile,
        ref: dispatch.ref,
        commitSha: dispatch.commitSha,
        inputs: dispatch.inputs,
        purpose: dispatch.purpose,
      },
      this.config,
      {
        dispatchesThisHour: await this.deps.dispatches.countSince(
          new Date(this.clock().getTime() - 60 * 60_000),
        ),
      },
    );
    if (!verdict.allowed) {
      return this.deps.dispatches.patch(dispatch.id, {
        state: 'refused',
        refusalRule: verdict.rule,
        refusalReason: verdict.reason,
      });
    }
    if (!this.deps.dispatcher) {
      return this.deps.dispatches.patch(dispatch.id, {
        state: 'refused',
        refusalRule: 'R-CI2',
        refusalReason: 'The CI controller has no credential of its own.',
      });
    }

    const now = this.clock();
    const result = await this.deps.dispatcher.dispatch({
      repositoryFullName: dispatch.repositoryFullName,
      workflowFile: dispatch.workflowFile,
      ref: dispatch.ref,
      inputs: dispatch.inputs,
    });

    if (!result.ok) {
      return this.deps.dispatches.patch(dispatch.id, {
        state: 'failed',
        refusalRule: 'R-CI14',
        refusalReason: redactSecrets(
          `GitHub refused the dispatch (${result.status}): ${result.detail}`,
        ),
        finishedAt: now,
      });
    }

    const updated = await this.deps.dispatches.patch(dispatch.id, {
      state: 'dispatched',
      approvedBy,
      approvedAt: now,
      dispatchedAt: now,
      stageReport: initialReleaseStages().map((stage) => ({
        stage: stage.stage,
        state: stage.stage === 'queued' ? 'running' : stage.state,
      })),
    });
    await this.deps.activity.record({
      kind: 'ci_dispatch_sent',
      summary: `Dispatched ${dispatch.workflowFile} on ${dispatch.repositoryFullName}@${dispatch.commitSha.slice(0, 7)}.`,
      detail: { dispatchId: dispatch.id },
    });
    return updated;
  }

  /**
   * Update a dispatch from GitHub's own view of the run.
   *
   * Reports the workflow's stages separately and never promotes "the workflow finished" into
   * "the build reached testers" — Apple's processing is something Jarvis cannot observe, so it
   * stays `unknown`.
   */
  async refresh(dispatchId: string): Promise<CiDispatch> {
    const dispatch = await this.deps.dispatches.findById(dispatchId);
    if (!dispatch) throw new NotFoundError('Dispatch');
    if (!this.deps.dispatcher || !dispatch.dispatchedAt) return dispatch;

    const run = await this.deps.dispatcher.findRun({
      repositoryFullName: dispatch.repositoryFullName,
      workflowFile: dispatch.workflowFile,
      ref: dispatch.ref,
      since: dispatch.dispatchedAt,
    });
    if (!run) return dispatch;

    const finished = run.status === 'completed';
    const succeeded = finished && run.conclusion === 'success';
    return this.deps.dispatches.patch(dispatch.id, {
      state: finished ? (succeeded ? 'succeeded' : 'failed') : 'running',
      externalRunId: run.id,
      externalRunUrl: run.url,
      conclusion: run.conclusion,
      ...(finished ? { finishedAt: this.clock() } : {}),
      stageReport: [
        { stage: 'queued', state: 'succeeded' },
        { stage: 'archive', state: succeeded ? 'succeeded' : finished ? 'failed' : 'running' },
        { stage: 'export', state: succeeded ? 'succeeded' : finished ? 'failed' : 'pending' },
        { stage: 'upload', state: succeeded ? 'succeeded' : finished ? 'failed' : 'pending' },
        /* Jarvis cannot see App Store Connect, so it does not claim to. */
        { stage: 'processing', state: 'unknown' },
      ],
    });
  }

  /* ---------------------------------------------------------- TestFlight */

  /**
   * What the TestFlight approval screen must show, and whether it may be shown at all.
   *
   * Everything here is a presence check. Jarvis asks GitHub which secret *names* a repository
   * declares so it can say "this looks configured"; it has no capability that could read a value
   * and no code path that would want one.
   */
  async testFlightReadiness(input: {
    projectId: string;
    projectType: string | null;
    repositoryFullName: string | null;
    commitSha: string | null;
    requiredChecksPassed: boolean;
    reviewApproved: boolean;
  }): Promise<{
    ready: boolean;
    rule: string | null;
    reason: string | null;
    missing: readonly string[];
    warnings: readonly string[];
    workflowFile: string | null;
    bundleIdentifier: string | null;
  }> {
    const profile = await this.deps.appProfiles.findByProject(input.projectId);
    if (!profile) {
      return {
        ready: false,
        rule: 'R-TF3',
        reason: 'This project has no app profile, so Jarvis does not know what would be built.',
        missing: ['An app profile with a bundle identifier and a TestFlight workflow.'],
        warnings: [],
        workflowFile: null,
        bundleIdentifier: null,
      };
    }

    const declared =
      this.deps.dispatcher && input.repositoryFullName
        ? await this.deps.dispatcher.declaredSecretNames(input.repositoryFullName).catch(() => [])
        : [];
    const readiness = assessTestFlightReadiness(profile, declared);

    const identity =
      input.repositoryFullName && profile.testFlightWorkflow && input.commitSha
        ? dispatchIdentity({
            repositoryFullName: input.repositoryFullName,
            workflowFile: profile.testFlightWorkflow,
            ref: input.commitSha,
            commitSha: input.commitSha,
            inputs: {},
            purpose: 'testflight',
          })
        : '';
    const approval = identity ? await this.deps.approvals.findActiveForIdentity(identity) : null;

    const verdict = evaluateTestFlightDispatch({
      projectType: input.projectType,
      repositoryAllowListed: Boolean(
        input.repositoryFullName && this.config.repositories.includes(input.repositoryFullName),
      ),
      workflowConfigured: Boolean(profile.testFlightWorkflow),
      signingConfigurationPresent: readiness.ready,
      commitSha: input.commitSha,
      requiredChecksPassed: input.requiredChecksPassed,
      reviewApproved: input.reviewApproved,
      approval,
      requestedIdentity: identity,
    });

    return {
      ready: verdict.allowed,
      rule: verdict.rule,
      reason: verdict.reason,
      missing: readiness.missing,
      warnings: readiness.warnings,
      workflowFile: profile.testFlightWorkflow,
      bundleIdentifier: profile.bundleIdentifier,
    };
  }

  /**
   * Record an owner's approval for one exact build.
   *
   * Approving supersedes every other live approval for the project, so an old approval cannot sit
   * around waiting to be matched by a later request. The identity — repository, workflow, ref,
   * commit and inputs — is what the approval is *for*; change any of it and it no longer applies.
   */
  async approveRelease(input: ReleaseApprovalInput, approvedBy: string): Promise<ReleaseApproval> {
    if (!this.config.enabled) {
      throw new ForbiddenError(
        'The CI controller is switched off, so there is nothing to approve.',
      );
    }
    const identity = dispatchIdentity({
      repositoryFullName: input.repositoryFullName,
      workflowFile: input.workflowFile,
      ref: input.ref,
      commitSha: input.commitSha,
      inputs: input.inputs,
      purpose: 'testflight',
    });
    const profile = await this.deps.appProfiles.findByProject(input.projectId);
    const approval = await this.deps.approvals.create({
      missionId: input.missionId ?? null,
      projectId: input.projectId,
      repositoryFullName: input.repositoryFullName,
      workflowFile: input.workflowFile,
      ref: input.ref,
      commitSha: input.commitSha,
      inputs: input.inputs,
      identity,
      approvedBy,
      bundleIdentifier: profile?.bundleIdentifier ?? null,
    });
    await this.deps.approvals.supersedeOthers(
      input.projectId,
      identity,
      'A newer approval was given for a different commit.',
    );
    await this.deps.activity.record({
      kind: 'release_approved',
      summary: `You approved a TestFlight build of ${input.repositoryFullName}@${input.commitSha.slice(0, 7)}.`,
      detail: { workflow: input.workflowFile },
    });
    return approval;
  }

  async revokeRelease(approvalId: string): Promise<ReleaseApproval> {
    return this.deps.approvals.setState(approvalId, 'revoked');
  }

  /**
   * Invalidate approvals whose commit has moved on.
   *
   * Called whenever a mission's head changes. Without it, an approval given for one commit would
   * quietly still match a request built from the same repository and workflow — which is exactly
   * the failure §21 names.
   */
  async supersedeForMovedCommit(
    projectId: string,
    currentCommitSha: string | null,
  ): Promise<number> {
    const approvals = await this.deps.approvals.listForProject(projectId);
    let superseded = 0;
    for (const approval of approvals) {
      if (approval.state !== 'approved') continue;
      if (currentCommitSha && approval.commitSha === currentCommitSha) continue;
      await this.deps.approvals.setState(approval.id, 'superseded', {
        supersededReason: `The code moved on from ${approval.commitSha.slice(0, 7)}.`,
      });
      superseded += 1;
    }
    return superseded;
  }
}
