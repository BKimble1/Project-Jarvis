import { AGENT_ROLE_LABELS, resolvePermissionProfile, type AgentRole } from '@/domain/agent-role';
import { buildReviewContext, type ReviewFindingInput } from '@/domain/mission-review';
import { filesOutsideWriteSet, describeWriteSet } from '@/domain/write-set';
import { boundText, redactSecrets } from '@/domain/redaction';
import type { TaskAssignment } from '@/domain/worker-protocol';
import type { VerificationInput } from '@/domain/mission-run';
import { ControlPlaneError, type ControlPlaneClient } from './client';
import type { WorkerConfig } from './config';
import { buildPullRequestBody, DeliveryError, type GitHubDelivery } from './delivery';
import { changedFiles, git, headSha, pushMissionBranch } from './git';
import { commitTaskWork, filesAgainstBase, integrateBranches, readBranchDiff } from './integration';
import { buildPolicyPrompt, evaluateToolUse, type PolicyContext } from './policy';
import type { AgentEvent, AgentRuntime, AgentSession } from './runtime/types';
import { discoverCommands, runVerification, summariseVerification } from './verification';
import {
  INTEGRATION_SLOT,
  prepareScratchWorkspace,
  prepareWorkspace,
  taskSlot,
  type WorkspaceHandle,
} from './workspace';

/**
 * One task of a task graph, start to finish.
 *
 * Sibling to `MissionRunner` rather than a replacement for it: a Prompt 2 mission still runs
 * through the mission runner unchanged, and this handles the Prompt 3 shape where a mission is
 * several tasks with different roles.
 *
 * What each role does here is deliberately different, and the differences are enforced by the
 * worker rather than described to the model:
 *
 *  - a **researcher** gets a read-only clone and no branch, so there is nothing for it to commit;
 *  - a **builder** gets its own clone and its own branch, plus a write lease, and its actual
 *    changes are checked against the write set the owner approved *after* the session ends as
 *    well as at each tool call;
 *  - a **verifier** and an **integrator** run no model at all;
 *  - a **reviewer** gets a context assembled by the control plane from stored records, and there
 *    is no parameter on this class through which a builder's transcript could reach it.
 */

export interface TaskRunnerDeps {
  readonly config: WorkerConfig;
  readonly client: ControlPlaneClient;
  readonly runtime: AgentRuntime;
  readonly delivery: GitHubDelivery | null;
  readonly clock?: () => Date;
}

export class TaskRunner {
  private seq = 0;
  private session: AgentSession | null = null;
  private workspace: WorkspaceHandle | null = null;
  private stopRequested = false;
  private readonly abort = new AbortController();
  private readonly verifications: VerificationInput[] = [];

  constructor(
    private readonly deps: TaskRunnerDeps,
    private readonly assignment: TaskAssignment,
  ) {}

  private get clock(): Date {
    return this.deps.clock?.() ?? new Date();
  }

  private get role(): AgentRole {
    return this.assignment.role as AgentRole;
  }

  async run(): Promise<void> {
    try {
      await this.emit(
        'info',
        `${AGENT_ROLE_LABELS[this.role] ?? this.assignment.role} starting ${this.assignment.taskKey}: ${this.assignment.title}`,
        { role: this.assignment.role, profile: this.assignment.permissionProfileId },
      );

      switch (this.role) {
        case 'integrator':
          await (this.assignment.taskType === 'delivery'
            ? this.runDelivery()
            : this.runIntegration());
          return;
        case 'verifier':
          await this.runVerification();
          return;
        case 'reviewer':
        case 'security_reviewer':
        case 'ux_reviewer':
        case 'release_verifier':
          await this.runReview();
          return;
        case 'builder':
        case 'repairer':
          await this.runWrite();
          return;
        default:
          await this.runReadOnly();
          return;
      }
    } catch (error) {
      await this.fail(
        'agent_error',
        error instanceof Error ? error.message : 'The task failed for an unrecorded reason.',
      );
    }
  }

  /* ------------------------------------------------------------ read-only */

  private async runReadOnly(): Promise<void> {
    await this.report('preparing', { currentAction: 'Preparing a read-only clone' });
    await this.prepare({
      readOnly: true,
      branch: null,
      slot: taskSlot('read', this.assignment.taskKey),
    });

    await this.report('running', { currentAction: this.assignment.title });
    const messages: string[] = [];
    const outcome = await this.driveAgent({
      readOnly: true,
      prompt: this.buildReadOnlyPrompt(),
      onMessage: (text) => messages.push(text),
    });
    if (outcome === 'failed') return;
    if (this.stopRequested) return this.confirmStopped();

    /* A read-only task's deliverable is its artifact, so it is stored before the task succeeds. */
    await this.deps.client.artifact(this.assignment.missionId, {
      runId: this.assignment.runId,
      kind: this.assignment.taskType === 'synthesis' ? 'summary' : 'research_report',
      title: this.assignment.title,
      content: boundText(redactSecrets(messages.join('\n\n')), 40_000),
      contentType: 'text/markdown',
      sources: [],
    });
    await this.emit('artifact_created', `${this.assignment.taskKey} produced its findings.`);
    await this.report('succeeded', {
      currentAction: null,
      completionSummary: boundText(messages.join('\n\n'), 3000),
    });
  }

  /* --------------------------------------------------------------- write */

  /**
   * A builder or a repairer.
   *
   * The write-set check happens twice, and both times matter. At each tool call
   * `evaluateToolUse` refuses a write outside the declared set — that stops the damage. After the
   * session, the real diff is compared against the same set — that catches anything the tool-call
   * check could not see, such as a file changed by a command rather than an edit. A violation
   * fails the task with the workspace preserved, so the work is inspectable rather than lost.
   */
  private async runWrite(): Promise<void> {
    await this.report('preparing', { currentAction: 'Preparing its own workspace' });

    const lease = await this.deps.client.acquireLease({
      runId: this.assignment.runId,
      taskId: this.assignment.taskId,
      paths: this.assignment.declaredWriteSet,
    });
    if (!lease.granted) {
      await this.fail(
        'write_lease_conflict',
        lease.reason ?? 'Another task holds a write lease over the same files.',
      );
      return;
    }
    await this.emit(
      'info',
      `Holding a write lease over ${describeWriteSet(this.assignment.declaredWriteSet)}.`,
      { paths: this.assignment.declaredWriteSet },
    );

    await this.prepare({
      readOnly: false,
      branch: this.assignment.branchName,
      slot: taskSlot('task', this.assignment.taskKey),
      /* A repair continues the branch it repairs rather than starting beside it. */
      startFrom: this.assignment.baseTaskBranch,
    });
    const workspace = this.workspace!;

    await this.report('running', {
      currentAction: this.assignment.title,
      workspacePath: workspace.repoPath,
      branchName: workspace.branch,
      baseSha: workspace.baseSha,
    });

    const messages: string[] = [];
    const outcome = await this.driveAgent({
      readOnly: false,
      prompt: this.assignment.repairScope ? this.buildRepairPrompt() : this.buildBuildPrompt(),
      onMessage: (text) => messages.push(text),
    });
    if (outcome === 'failed') return;
    if (this.stopRequested) return this.confirmStopped();

    const gitOptions = { cwd: workspace.repoPath, credentialToken: null };
    const changed = await changedFiles(gitOptions);

    /* The second write-set check: against what really changed, not what was requested. */
    const outside = filesOutsideWriteSet(this.assignment.declaredWriteSet, changed);
    if (outside.length > 0) {
      await this.emit(
        'policy_refusal',
        `${this.assignment.taskKey} changed ${outside.length} file(s) outside its approved write set.`,
        { files: outside.slice(0, 20) },
        'error',
      );
      await this.fail(
        'write_scope_violation',
        `Changed ${outside.slice(0, 5).join(', ')}${outside.length > 5 ? ` and ${outside.length - 5} more` : ''}, which this task was not approved to touch. The workspace is preserved so you can see exactly what it did.`,
        { changedFiles: changed },
      );
      return;
    }

    if (changed.length === 0) {
      await this.emit('info', 'Nothing needed changing.');
      await this.report('succeeded', {
        currentAction: null,
        completionSummary: boundText(messages.join('\n\n'), 3000),
        filesChanged: [],
      });
      return;
    }

    const commit = await commitTaskWork({
      repoPath: workspace.repoPath,
      branch: workspace.branch!,
      message: `${this.assignment.title}\n\n${boundText(redactSecrets(messages.join('\n\n')), 1500)}`,
    });
    await this.emit(
      'commit_created',
      `Committed ${changed.length} file(s) to ${workspace.branch}.`,
      {
        sha: commit?.sha,
      },
    );

    /*
     * Publish the task branch.
     *
     * A task branch that only exists in this workspace is invisible to the integrator, which
     * runs in a workspace of its own and may not even be on this machine. Pushing it under
     * `jarvis/` — the same policy-checked path Prompt 2 already uses, so the default branch is
     * still unreachable and a force push is still refused — is what makes the work shareable,
     * and it doubles as the durable record of what this agent did.
     *
     * A worker with no GitHub write credential can still build and review; it simply cannot hand
     * its branch to anyone else, and the integrator says so plainly rather than failing with a
     * git error nobody can read.
     */
    if (this.deps.delivery) {
      try {
        await pushMissionBranch({
          cwd: workspace.repoPath,
          branch: workspace.branch!,
          defaultBranch: workspace.baseBranch,
          credentialToken: this.deps.config.githubToken,
        });
        await this.emit('branch_pushed', `Pushed ${workspace.branch}.`);
      } catch (error) {
        await this.fail(
          'github_error',
          `The work is committed on ${workspace.branch}, but pushing it failed, so no other task can reach it: ${error instanceof Error ? error.message.slice(0, 300) : 'unknown error'}`,
          { changedFiles: changed },
        );
        return;
      }
    } else {
      await this.emit(
        'info',
        `This worker has no GitHub write credential, so ${workspace.branch} stays on this machine.`,
        {},
        'warning',
      );
    }

    await this.report('succeeded', {
      currentAction: null,
      headSha: commit?.sha ?? null,
      filesChanged: [...changed],
      completionSummary: boundText(messages.join('\n\n'), 3000),
    });
  }

  /* --------------------------------------------------------- integration */

  /** Deterministic git. No model is started, and there is nothing here for one to influence. */
  private async runIntegration(): Promise<void> {
    await this.report('preparing', { currentAction: 'Preparing the integration workspace' });
    /*
     * The integration workspace is reused across rounds rather than re-cloned.
     *
     * There is exactly one of it per mission — the verifier already resumes into it — and a
     * repair round integrates a second time. Refusing to reuse it made the second round fail with
     * "a workspace already exists from an earlier attempt", which is the right message for a
     * *task* workspace and the wrong one here. Reuse is safe because `integrateBranches` starts
     * by resetting the integration branch to the base with `checkout -B`, and because `prepare`
     * still refuses a workspace with uncommitted changes in it.
     */
    await this.prepare({ readOnly: false, branch: null, slot: INTEGRATION_SLOT, reuse: true });
    const workspace = this.workspace!;

    await this.report('integrating', {
      currentAction: `Merging ${this.assignment.mergeBranches.length} task branch(es)`,
      workspacePath: workspace.repoPath,
    });

    const result = await integrateBranches({
      repoPath: workspace.repoPath,
      integrationBranch: this.assignment.integrationBranch ?? '',
      baseBranch: workspace.baseBranch,
      branches: this.assignment.mergeBranches,
      onProgress: (message) => void this.emit('info', message),
    });

    if (!result.ok && result.conflict) {
      await this.emit(
        'error',
        `${result.conflict.branch} could not be merged. ${result.conflict.detail}`,
        { files: result.conflict.files },
        'error',
      );
      await this.fail(
        'integration_conflict',
        `${result.conflict.detail} Both branches are preserved exactly as they were — nothing was discarded to make the merge succeed. Decide what the merged result should be, then either fix the branch or resolve it yourself.`,
      );
      return;
    }

    await this.emit(
      'branch_created',
      `Merged ${result.merged.length} branch(es) into ${this.assignment.integrationBranch}.`,
      { headSha: result.headSha, files: result.changedFiles.length },
    );

    /*
     * Publish the integration branch.
     *
     * The reviewer works in a clone of its own — that is what makes the review independent — so
     * an integration branch that exists only in this workspace is an integration branch the
     * reviewer cannot read. Delivery pushes it too; pushing here is what makes it reviewable
     * before anyone decides whether to deliver it.
     */
    if (this.deps.delivery && this.assignment.integrationBranch) {
      try {
        await pushMissionBranch({
          cwd: workspace.repoPath,
          branch: this.assignment.integrationBranch,
          defaultBranch: workspace.baseBranch,
          credentialToken: this.deps.config.githubToken,
        });
        await this.emit('branch_pushed', `Pushed ${this.assignment.integrationBranch}.`);
      } catch (error) {
        await this.fail(
          'github_error',
          `The merge succeeded but pushing ${this.assignment.integrationBranch} failed, so no reviewer can read it: ${error instanceof Error ? error.message.slice(0, 300) : 'unknown error'}`,
        );
        return;
      }
    }

    await this.report('succeeded', {
      currentAction: null,
      branchName: this.assignment.integrationBranch,
      headSha: result.headSha,
      filesChanged: [...result.changedFiles],
      completionSummary: `Merged ${result.merged.length} task branch(es) cleanly.`,
    });
  }

  /* -------------------------------------------------------- verification */

  /**
   * Run the repository's own checks.
   *
   * No model. What runs is discovered from the repository and from the approved plan, and each
   * outcome is recorded as it really was — `unavailable` when the tool is not on this machine,
   * which is emphatically not a pass and is never rendered as one.
   */
  private async runVerification(): Promise<void> {
    await this.report('preparing', { currentAction: 'Preparing the verification workspace' });
    await this.prepare({ readOnly: true, branch: null, slot: INTEGRATION_SLOT, reuse: true });
    const workspace = this.workspace!;

    await this.report('verifying', { currentAction: "Running the repository's checks" });

    /*
     * What runs is the union of what the plan named and what the repository itself defines. The
     * plan's entries come first, because a check the owner approved should not be crowded out by
     * a discovered one.
     */
    const planned = this.assignment.plan?.verification ?? [];
    const discovered = await discoverCommands(workspace.repoPath);
    const seen = new Set<string>();
    const commands = [...planned, ...discovered].filter((entry) => {
      if (seen.has(entry.command)) return false;
      seen.add(entry.command);
      return true;
    });

    for (const command of commands) {
      const result = await runVerification(command, {
        repoPath: workspace.repoPath,
        workspaceRoot: workspace.repoPath,
        timeoutMs: this.deps.config.verifyTimeoutMs,
      });
      this.verifications.push(result);
      await this.deps.client.verification({ runId: this.assignment.runId, ...result });
      await this.emit(
        'verification_finished',
        `${result.outcome.toUpperCase()}: ${result.command}`,
        { outcome: result.outcome, exitCode: result.exitCode },
        result.outcome === 'failed' ? 'warning' : 'info',
      );
    }

    const summary = summariseVerification(this.verifications).headline;
    const failed = this.verifications.filter((entry) => entry.outcome === 'failed');
    if (failed.length > 0) {
      /*
       * A failed check does not fail the *task* — the task did its job, which was to find out.
       * What it does is give the reviewer evidence, and deterministic policy will refuse to let
       * an approval stand on top of it.
       */
      await this.emit(
        'info',
        `${failed.length} check(s) failed. Recorded for review.`,
        {},
        'warning',
      );
    }
    await this.report('succeeded', { currentAction: null, completionSummary: summary });
  }

  /* -------------------------------------------------------------- review */

  /**
   * A cold, independent review.
   *
   * The prompt is built by `buildReviewContext` from what the control plane sent: the plan, the
   * graph, the criteria, the diff, the verification evidence and the artifacts. There is no
   * builder transcript in `TaskAssignment` and none in scope here, so a reviewer cannot be given
   * one by mistake.
   */
  private async runReview(): Promise<void> {
    const review = this.assignment.review;
    if (!review) {
      await this.fail('agent_error', 'This review task arrived without anything to review.');
      return;
    }

    await this.report('preparing', { currentAction: 'Preparing a read-only clone' });
    await this.prepare({
      readOnly: true,
      branch: null,
      slot: taskSlot('read', this.assignment.taskKey),
    });

    await this.report('running', { currentAction: 'Reviewing the finished work' });

    /*
     * Fetch the work into this clone and read the diff.
     *
     * The control plane sends the review's *context* — the plan, the criteria, the verification
     * evidence — but never the patch, so the diff comes from here. Without this the reviewer sat
     * in a fresh clone of the default branch and was asked to review a change it could not see;
     * it would have had to form a verdict out of file names, which is not review.
     */
    const integrationBranch = this.assignment.integrationBranch;
    const seen = integrationBranch
      ? await readBranchDiff({
          repoPath: this.workspace!.repoPath,
          branch: integrationBranch,
          baseBranch: this.workspace!.baseBranch,
          credentialToken: this.deps.config.githubToken,
        })
      : { diff: '', files: [], headSha: null, truncated: false };

    if (!seen.diff) {
      /*
       * No diff is not "nothing to complain about". A reviewer with nothing to read cannot
       * approve, so the task fails and the owner is told why rather than being handed a verdict
       * that was never based on anything.
       */
      await this.fail(
        'agent_error',
        `There is no diff to review: ${integrationBranch ?? 'the integration branch'} could not be read from this workspace. Usually that means it was never pushed — a worker with no GitHub write credential can build and integrate, but nothing it produces is visible to a reviewer working in its own clone.`,
      );
      return;
    }

    await this.emit(
      'info',
      `Reviewing ${seen.files.length} changed file(s) on ${integrationBranch}${seen.truncated ? ' (diff truncated)' : ''}.`,
      { files: seen.files.slice(0, 20), headSha: seen.headSha },
    );

    const prompt = buildReviewContext({
      missionTitle: this.assignment.missionTitle,
      missionRequest: this.assignment.rawRequest,
      planSummary: review.planSummary,
      planApproach: review.planApproach,
      planScope: review.planScope,
      planOutOfScope: review.planOutOfScope,
      acceptanceCriteria: review.acceptanceCriteria,
      graphSummary: this.assignment.graphSummary,
      taskSummaries: this.assignment.siblingTasks.map((task) => ({
        key: task.key,
        title: task.title,
        role: task.role,
      })),
      diff: seen.diff,
      changedFiles: seen.files.length > 0 ? seen.files : review.changedFiles,
      verification: this.assignment.verification.map((entry) => ({
        check: entry.check,
        outcome: entry.outcome as VerificationInput['outcome'],
        required: entry.required,
        detail: entry.detail,
      })),
      artifacts: review.artifacts,
      repositoryInstructions: review.repositoryInstructions,
      repairScope: (this.assignment.repairScope ?? []).map((finding) => ({
        key: finding.key,
        title: finding.title,
      })),
      repairRound: this.assignment.repairRound,
    });

    const messages: string[] = [];
    const outcome = await this.driveAgent({
      readOnly: true,
      prompt: `${prompt}\n\n${REVIEW_OUTPUT_INSTRUCTION}`,
      onMessage: (text) => messages.push(text),
    });
    if (outcome === 'failed') return;
    if (this.stopRequested) return this.confirmStopped();

    const parsed = parseReview(messages.join('\n\n'));
    await this.deps.client.submitReview({
      runId: this.assignment.runId,
      taskId: this.assignment.taskId,
      verdict: parsed.verdict,
      summary: parsed.summary,
      findings: parsed.findings,
      reviewedFiles: [...(seen.files.length > 0 ? seen.files : review.changedFiles)],
      diffFingerprint: review.diffFingerprint,
      unavailableReason: parsed.unavailableReason,
    });
    await this.emit(
      'info',
      `Review returned "${parsed.verdict}" with ${parsed.findings.length} finding(s).`,
      { verdict: parsed.verdict },
    );
    /*
     * The task's own state is set by the control plane, not here: what a verdict *means* — repair,
     * escalate, approve — is a deterministic decision, and letting the reviewing worker report
     * `succeeded` would be letting the reviewer grade its own paper.
     */
  }

  /* ------------------------------------------------------------ delivery */

  private async runDelivery(): Promise<void> {
    await this.report('preparing', { currentAction: 'Preparing to deliver' });
    await this.prepare({ readOnly: false, branch: null, slot: INTEGRATION_SLOT, reuse: true });
    const workspace = this.workspace!;
    const branch = this.assignment.integrationBranch;
    const repository = this.assignment.repository;

    if (!branch || !repository) {
      await this.fail('workspace_error', 'There is no integration branch to deliver.');
      return;
    }

    const gitOptions = { cwd: workspace.repoPath, credentialToken: this.deps.config.githubToken };
    await git(['checkout', branch], { cwd: workspace.repoPath, credentialToken: null });
    const head = await headSha({ cwd: workspace.repoPath, credentialToken: null });
    const files = await filesAgainstBase(workspace.repoPath, workspace.baseBranch, null);

    if (!this.deps.delivery) {
      await this.emit(
        'info',
        'This worker has no GitHub write credential, so nothing was pushed. The branch is complete locally.',
        {},
        'warning',
      );
      await this.report('succeeded', {
        currentAction: null,
        branchName: branch,
        headSha: head,
        filesChanged: [...files],
        completionSummary:
          'The work is finished and committed locally. There is no GitHub write credential configured, so no pull request was opened.',
      });
      return;
    }

    await this.report('running', { currentAction: 'Pushing the mission branch' });
    await pushMissionBranch({
      cwd: workspace.repoPath,
      branch,
      defaultBranch: workspace.baseBranch,
      credentialToken: this.deps.config.githubToken,
    });
    await this.emit('branch_pushed', `Pushed ${branch}.`);

    const body = buildPullRequestBody({
      missionId: this.assignment.missionId,
      missionTitle: this.assignment.missionTitle,
      baseUrl: this.deps.config.controlPlaneUrl,
      plan: this.assignment.plan,
      verifications: this.verifications,
      filesChanged: files,
      openQuestions: this.assignment.plan?.openQuestions ?? [],
    });

    try {
      /*
       * Adopt before creating. A delivery task retried after a worker restart must not open a
       * second draft pull request for a branch that already has one — see the same guard in
       * `MissionRunner`.
       */
      const existing = await this.deps.delivery
        .findOpenPullRequest(repository.owner, repository.name, branch)
        .catch(() => null);
      if (existing) {
        await this.deps.delivery
          .updatePullRequestBody(repository.owner, repository.name, existing.number, body)
          .catch(() => undefined);
      }
      const pull =
        existing ??
        (await this.deps.delivery.createDraftPullRequest({
          owner: repository.owner,
          repo: repository.name,
          head: branch,
          base: workspace.baseBranch,
          title: this.assignment.missionTitle.slice(0, 120),
          body,
        }));
      await this.emit(
        'pull_request_created',
        existing
          ? `Draft pull request #${pull.number} was already open for this branch, so it was updated rather than duplicated. It is not merged.`
          : `Opened draft pull request #${pull.number}. It is not merged.`,
        { url: pull.url, adopted: existing !== null },
      );
      await this.report('succeeded', {
        currentAction: null,
        branchName: branch,
        headSha: head,
        filesChanged: [...files],
        pullRequestUrl: pull.url,
        pullRequestNumber: pull.number,
        completionSummary: `Draft pull request #${pull.number} is open for your review. Jarvis has not merged it and will not.`,
      });
    } catch (error) {
      const code =
        error instanceof DeliveryError && error.status === 401
          ? 'github_auth_error'
          : error instanceof DeliveryError && error.status === 403
            ? 'github_auth_error'
            : 'github_error';
      await this.fail(
        code,
        `The work is committed and pushed to ${branch}; opening the pull request failed: ${error instanceof Error ? error.message : 'unknown'}`,
      );
    }
    void gitOptions;
  }

  /* --------------------------------------------------------------- agent */

  private async driveAgent(options: {
    readOnly: boolean;
    prompt: string;
    onMessage: (text: string) => void;
  }): Promise<'done' | 'failed' | 'stopped'> {
    const workspace = this.workspace;
    if (!workspace) throw new Error('The workspace was not prepared.');

    const profile = resolvePermissionProfile(this.assignment.permissionProfileId);
    const policy: PolicyContext = {
      workspaceRoot: workspace.repoPath,
      readOnly: options.readOnly,
      branchName: workspace.branch,
      defaultBranch: workspace.baseBranch,
      doNotTouch: this.assignment.doNotTouch,
      allowWebResearch: this.assignment.allowWebResearch && this.deps.config.allowWebResearch,
      role: this.role,
      profile,
      declaredWriteSet: this.assignment.declaredWriteSet,
    };

    this.session = await this.deps.runtime.start({
      workspaceRoot: workspace.repoPath,
      systemPrompt: `${buildPolicyPrompt(policy)}\n\n${this.buildRolePrompt(profile.summary)}`,
      prompt: options.prompt,
      resumeSessionId: null,
      readOnly: options.readOnly,
      maxTurns: Math.min(
        this.assignment.maxTurns ?? profile.usage.maxTurns,
        profile.usage.maxTurns,
      ),
      model: this.deps.config.model,
      signal: this.abort.signal,
      decide: (request) => Promise.resolve(evaluateToolUse(request, policy)),
    });

    for await (const event of this.session.events) {
      const outcome = await this.handleAgentEvent(event, options.onMessage);
      if (outcome === 'failed') return 'failed';
      if (outcome === 'done') return 'done';
      if (this.stopRequested) {
        await this.session.interrupt();
        return 'stopped';
      }
    }
    return 'done';
  }

  private async handleAgentEvent(
    event: AgentEvent,
    onMessage: (text: string) => void,
  ): Promise<'done' | 'failed' | null> {
    switch (event.type) {
      case 'session':
        await this.report(null, { agentSessionId: event.sessionId });
        return null;
      case 'message':
        onMessage(event.text);
        await this.emit('agent_message', event.text);
        return null;
      case 'summary':
        await this.emit('agent_summary', event.text, {}, 'debug');
        return null;
      case 'tool_use':
        await this.emit('tool_use', event.summary, { tool: event.toolName, ...event.detail });
        return null;
      case 'tool_result':
        await this.emit(
          'tool_result',
          event.summary,
          { tool: event.toolName },
          event.isError ? 'warning' : 'debug',
        );
        return null;
      case 'denied':
        await this.emit(
          'policy_refusal',
          `Refused: ${event.toolName} — ${event.reason}`,
          { tool: event.toolName },
          'warning',
        );
        return null;
      case 'usage':
        await this.report(null, { usage: event.usage });
        return null;
      case 'done':
        if (event.usage) await this.report(null, { usage: event.usage });
        onMessage(event.result);
        return 'done';
      case 'error':
        await this.fail('agent_error', event.message);
        return 'failed';
    }
  }

  /* ------------------------------------------------------------ plumbing */

  private async prepare(options: {
    readOnly: boolean;
    branch: string | null;
    slot: string;
    reuse?: boolean;
    startFrom?: string | null;
  }): Promise<void> {
    if (!this.assignment.repository || this.assignment.workspaceRequirement === 'none') {
      this.workspace = await prepareScratchWorkspace(
        this.deps.config.workspaceRoot,
        this.assignment.missionId,
      );
      return;
    }
    this.workspace = await prepareWorkspace({
      workspaceRoot: this.deps.config.workspaceRoot,
      missionId: this.assignment.missionId,
      repository: this.repositoryForRun(),
      branchName: options.branch,
      startFromBranch: options.startFrom ?? null,
      credentialToken: this.deps.config.githubToken,
      readOnly: options.readOnly,
      reuseExisting: options.reuse ?? false,
      slot: options.slot,
      onProgress: (message) => void this.emit('info', message),
    });
    await this.emit('workspace_prepared', `${this.assignment.taskKey} has its own workspace.`, {
      slot: options.slot,
      baseSha: this.workspace.baseSha,
    });
  }

  /** Sandbox redirection, identical to the mission runner's, so a rehearsal cannot reach real code. */
  private repositoryForRun(): NonNullable<TaskAssignment['repository']> {
    const repository = this.assignment.repository!;
    /*
     * Lower-cased, because `parseSandboxRepositories` lower-cases its keys. Looking up the name
     * as written meant a repository with any capital letter silently missed its redirect and the
     * task cloned the real repository — the one thing sandbox mode exists to make impossible.
     */
    const redirect = this.deps.config.sandboxRepositories.get(repository.fullName.toLowerCase());
    if (!redirect) return repository;
    void this.emit(
      'info',
      `Sandbox mode: cloning ${repository.fullName} from ${redirect} instead of the real repository. Nothing here reaches ${repository.fullName}.`,
      {},
      'warning',
    );
    return { ...repository, cloneUrl: redirect };
  }

  private async emit(
    type: Parameters<ControlPlaneClient['events']>[0]['events'][number]['type'],
    summary: string,
    detail: Record<string, unknown> = {},
    level: 'debug' | 'info' | 'warning' | 'error' = 'info',
  ): Promise<void> {
    this.seq += 1;
    try {
      await this.deps.client.events({
        runId: this.assignment.runId,
        events: [
          {
            seq: this.seq,
            type,
            level,
            actor: 'agent',
            summary: boundText(redactSecrets(summary), 1900),
            detail,
            occurredAt: this.clock.toISOString(),
          },
        ],
      });
    } catch (error) {
      if (error instanceof ControlPlaneError && error.fatal) throw error;
    }
  }

  /** A `null` state is metadata only, exactly as in the mission runner. */
  private async report(state: string | null, patch: Record<string, unknown>): Promise<void> {
    const response = await this.deps.client.taskState({
      runId: this.assignment.runId,
      taskId: this.assignment.taskId,
      ...(state ? { taskState: state } : {}),
      runtimeName: this.deps.runtime.name,
      runtimeVersion: this.deps.config.version,
      ...patch,
    } as never);
    if (response.stopRequested) this.stopRequested = true;
  }

  private async fail(
    code: string,
    message: string,
    extra: Record<string, unknown> = {},
  ): Promise<void> {
    await this.emit('error', message, { code }, 'error');
    await this.report('failed', {
      failureCode: code,
      failureMessage: boundText(redactSecrets(message), 1500),
      workspacePreserved: true,
      currentAction: null,
      ...extra,
    }).catch(() => undefined);
  }

  private async confirmStopped(): Promise<void> {
    await this.emit('info', 'Stopped. The workspace is preserved — nothing was deleted.');
    await this.report('stopped', { workspacePreserved: true, currentAction: null });
  }

  /* -------------------------------------------------------------- prompts */

  private buildRolePrompt(profileSummary: string): string {
    return [
      `Your role in this mission is: ${AGENT_ROLE_LABELS[this.role] ?? this.assignment.role}.`,
      profileSummary,
      '',
      'Other agents are working on other parts of this mission. You cannot see their sessions and',
      'they cannot see yours. Do not try to coordinate with them, do not do their tasks, and do',
      'not assume what they concluded — Jarvis handles the hand-offs.',
      '',
      'You cannot change your own role, widen your own permissions, raise a limit, add a repair',
      'round, or approve anything. Those are not things to ask for; they do not exist for you.',
    ].join('\n');
  }

  private buildReadOnlyPrompt(): string {
    const a = this.assignment;
    return [
      `# ${a.taskKey}: ${a.title}`,
      '',
      a.description,
      '',
      `The mission is: "${a.rawRequest}"`,
      `The project is ${a.projectName}${a.projectGoal ? ` — ${a.projectGoal}` : ''}.`,
      '',
      a.acceptanceCriteria.length > 0
        ? `You are done when:\n${a.acceptanceCriteria.map((c) => `  - ${c}`).join('\n')}`
        : '',
      '',
      '**Change nothing.** This is a read-only task. Report what you find, cite where you found',
      'it, and separate what you observed from what you concluded.',
    ]
      .filter(Boolean)
      .join('\n');
  }

  private buildBuildPrompt(): string {
    const a = this.assignment;
    return [
      `# ${a.taskKey}: ${a.title}`,
      '',
      a.description,
      '',
      `The mission is: "${a.rawRequest}"`,
      a.plan ? `\nThe approved approach:\n${a.plan.approach}` : '',
      '',
      `You may change files only within: ${describeWriteSet(a.declaredWriteSet)}.`,
      'A change outside that is refused at the tool call, and checked again against the real diff',
      'afterwards. If the right fix is outside it, stop and say so — that is the owner’s decision.',
      '',
      a.acceptanceCriteria.length > 0
        ? `You are done when:\n${a.acceptanceCriteria.map((c) => `  - ${c}`).join('\n')}`
        : '',
      '',
      'Commit nothing yourself; Jarvis commits what you leave in the working tree onto your own',
      'task branch. Do not push, merge or open a pull request — you have no way to and no need.',
    ]
      .filter(Boolean)
      .join('\n');
  }

  private buildRepairPrompt(): string {
    const a = this.assignment;
    const findings = a.repairScope ?? [];
    return [
      `# ${a.taskKey}: repair round ${a.repairRound}`,
      '',
      'An independent review found these, and you are being asked to fix exactly these:',
      '',
      ...findings.map(
        (finding) =>
          `  ${finding.key} [${finding.severity}] ${finding.title}\n      Recommended: ${finding.recommendation}${finding.file ? `\n      In: ${finding.file}` : ''}`,
      ),
      '',
      'A finding is not permission to widen the mission. Fix these and nothing else.',
      '',
      '**Do not weaken, skip, delete or rewrite a test to make something pass.** If you believe a',
      'test is genuinely wrong, leave it alone and say why in your summary — the next review will',
      'consider it. Removing a check to get a green result is the one thing that would make all of',
      'this worthless.',
      '',
      `You may change files only within: ${describeWriteSet(a.declaredWriteSet)}.`,
    ].join('\n');
  }
}

/* ------------------------------------------------------------ review parsing */

const REVIEW_OUTPUT_INSTRUCTION = [
  '## Return your verdict as JSON',
  '',
  'End your reply with a single fenced ```json block and nothing after it:',
  '',
  '```json',
  '{',
  '  "verdict": "approved | approved_with_notes | repair_required | owner_decision_required | blocked",',
  '  "summary": "One paragraph: what you checked and what you concluded.",',
  '  "findings": [',
  '    {',
  '      "key": "F1",',
  '      "severity": "critical | high | medium | low | informational",',
  '      "category": "correctness | regression_risk | security | data_safety | migration_safety | test_coverage | error_handling | performance | accessibility | user_experience | documentation | scope | unintended_change | evidence_gap",',
  '      "title": "Short statement of the defect",',
  '      "description": "What is wrong and why it matters.",',
  '      "evidence": "A quotation from the diff, a file or a log. Not your summary of one.",',
  '      "file": "path/to/file.ts",',
  '      "line": 42,',
  '      "violates": "The acceptance criterion or rule this breaks, quoted.",',
  '      "recommendation": "What to do about it.",',
  '      "confidence": "high | medium | low",',
  '      "blocksDelivery": true',
  '    }',
  '  ]',
  '}',
  '```',
  '',
  'If you genuinely could not review — the diff is missing, the repository would not open — use',
  'verdict "blocked" and say so in the summary. Never approve something you could not read.',
].join('\n');

export interface ParsedReview {
  readonly verdict:
    | 'approved'
    | 'approved_with_notes'
    | 'repair_required'
    | 'owner_decision_required'
    | 'blocked'
    | 'unavailable';
  readonly summary: string;
  readonly findings: readonly ReviewFindingInput[];
  readonly unavailableReason: string | null;
}

/**
 * Read a verdict out of a reviewer's reply.
 *
 * When the JSON is missing or malformed the result is `unavailable`, **never** an approval. A
 * reviewer whose output could not be parsed has not approved anything, and defaulting to the
 * permissive answer here would undo the entire review gate.
 */
export function parseReview(text: string): ParsedReview {
  const fenced = /```json\s*([\s\S]*?)```/gi;
  let candidate: string | null = null;
  for (const match of text.matchAll(fenced)) candidate = match[1] ?? candidate;

  if (!candidate) {
    return {
      verdict: 'unavailable',
      summary: boundText(redactSecrets(text), 3000) || 'The review returned nothing structured.',
      findings: [],
      unavailableReason: 'The review did not return a structured verdict, so none was recorded.',
    };
  }

  try {
    const parsed = JSON.parse(candidate) as {
      verdict?: string;
      summary?: string;
      findings?: unknown[];
    };
    const verdicts = [
      'approved',
      'approved_with_notes',
      'repair_required',
      'owner_decision_required',
      'blocked',
    ] as const;
    const verdict = verdicts.includes(parsed.verdict as (typeof verdicts)[number])
      ? (parsed.verdict as ParsedReview['verdict'])
      : 'unavailable';

    const findings = (parsed.findings ?? [])
      .slice(0, 60)
      .map((raw, index) => normaliseFinding(raw, index))
      .filter((finding): finding is ReviewFindingInput => finding !== null);

    return {
      verdict,
      summary: boundText(redactSecrets(parsed.summary ?? ''), 4000) || 'No summary was given.',
      findings,
      unavailableReason:
        verdict === 'unavailable'
          ? 'The review returned a verdict Jarvis does not recognise.'
          : null,
    };
  } catch {
    return {
      verdict: 'unavailable',
      summary: 'The review returned malformed JSON, so no verdict could be recorded.',
      findings: [],
      unavailableReason: 'The review returned malformed JSON.',
    };
  }
}

function normaliseFinding(raw: unknown, index: number): ReviewFindingInput | null {
  if (!raw || typeof raw !== 'object') return null;
  const row = raw as Record<string, unknown>;
  const str = (value: unknown, max: number): string =>
    typeof value === 'string' ? boundText(redactSecrets(value), max) : '';
  const title = str(row.title, 200);
  if (!title) return null;
  const severities = ['critical', 'high', 'medium', 'low', 'informational'] as const;
  const confidences = ['high', 'medium', 'low'] as const;
  const categories = [
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
  return {
    key: /^F[0-9]{1,3}$/.test(String(row.key)) ? String(row.key) : `F${index + 1}`,
    severity: severities.includes(row.severity as (typeof severities)[number])
      ? (row.severity as ReviewFindingInput['severity'])
      : 'medium',
    category: categories.includes(row.category as (typeof categories)[number])
      ? (row.category as ReviewFindingInput['category'])
      : 'correctness',
    title,
    description: str(row.description, 4000) || title,
    evidence: str(row.evidence, 4000) || 'No evidence was quoted.',
    file: str(row.file, 400) || null,
    line: typeof row.line === 'number' && Number.isInteger(row.line) ? row.line : null,
    component: str(row.component, 200) || null,
    violates: str(row.violates, 600) || null,
    reproduction: str(row.reproduction, 2000) || null,
    recommendation: str(row.recommendation, 2000) || 'No recommendation was given.',
    confidence: confidences.includes(row.confidence as (typeof confidences)[number])
      ? (row.confidence as ReviewFindingInput['confidence'])
      : 'medium',
    blocksDelivery: row.blocksDelivery === true,
  };
}
