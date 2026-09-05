import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { MissionFailureCode, MissionState } from '@/domain/mission';
import { isReadOnlyMissionType } from '@/domain/mission';
import { isMissionAlreadyUnderway } from '@/domain/mission-state';
import type { MissionEventInput, VerificationInput } from '@/domain/mission-run';
import type { MissionPlanContent } from '@/domain/mission-plan';
import type { MissionAssignment, PendingCommand } from '@/domain/worker-protocol';
import { boundText, redactSecrets } from '@/domain/redaction';
import { ControlPlaneError, type ControlPlaneClient } from './client';
import type { WorkerConfig } from './config';
import { DeliveryError, buildPullRequestBody, type GitHubDelivery } from './delivery';
import { changedFiles, git, headSha, pushMissionBranch } from './git';
import { filesAgainstBase } from './integration';
import {
  buildPolicyPrompt,
  evaluateToolUse,
  type PolicyContext,
  type PolicyDecision,
} from './policy';
import type { AgentEvent, AgentRuntime, AgentSession } from './runtime/types';
import { discoverCommands, runVerification, summariseVerification } from './verification';
import {
  WorkspaceError,
  prepareScratchWorkspace,
  prepareWorkspace,
  type WorkspaceHandle,
} from './workspace';

/**
 * One mission, start to finish.
 *
 * The shape of the run is:
 *
 *   prepare workspace → start agent → stream events → verify → commit → push → draft PR
 *
 * with owner commands (pause, resume, message, stop) interleaved at safe boundaries, and every
 * meaningful step reported to the control plane as it happens rather than in a summary at the end.
 * If the worker dies halfway through, the record explains exactly how far it got.
 */

export interface MissionRunnerDeps {
  readonly config: WorkerConfig;
  readonly client: ControlPlaneClient;
  readonly runtime: AgentRuntime;
  readonly delivery: GitHubDelivery | null;
  readonly clock?: () => Date;
}

interface PendingPermission {
  readonly requestKey: string;
  resolve: (decision: 'approve' | 'deny') => void;
}

export class MissionRunner {
  private seq = 0;
  private stopRequested = false;
  private pauseRequested = false;
  private readonly abort = new AbortController();
  private session: AgentSession | null = null;
  private workspace: WorkspaceHandle | null = null;
  private readonly verifications: VerificationInput[] = [];
  private readonly pendingPermissions = new Map<string, PendingPermission>();
  private readonly handledCommands = new Set<string>();
  private sessionId: string | null = null;
  private finished = false;

  constructor(
    private readonly deps: MissionRunnerDeps,
    private readonly assignment: MissionAssignment,
  ) {}

  private get clock(): Date {
    return this.deps.clock?.() ?? new Date();
  }

  /** Owner commands arrive through the poll loop and are applied here. */
  async applyCommand(command: PendingCommand): Promise<void> {
    if (this.handledCommands.has(command.id)) return;
    this.handledCommands.add(command.id);

    switch (command.kind) {
      case 'pause':
        this.pauseRequested = true;
        await this.emit(
          'command_acknowledged',
          'Pause requested. Stopping at the next safe point.',
          {
            commandId: command.id,
          },
        );
        await this.deps.client.acknowledgeCommand(command.id, 'acknowledged');
        break;

      case 'stop':
        this.stopRequested = true;
        await this.emit(
          'command_acknowledged',
          'Stop requested. Interrupting the agent and preserving the workspace.',
          { commandId: command.id },
          'warning',
        );
        await this.deps.client.acknowledgeCommand(command.id, 'acknowledged');
        await this.session?.interrupt();
        break;

      case 'resume':
        this.pauseRequested = false;
        await this.deps.client.acknowledgeCommand(command.id, 'completed');
        break;

      case 'message': {
        const message = typeof command.payload.message === 'string' ? command.payload.message : '';
        if (message.length > 0 && this.session) {
          await this.session.send(message);
          await this.emit('owner_message', `Delivered your message to the agent.`, {
            commandId: command.id,
          });
          await this.deps.client.acknowledgeCommand(command.id, 'completed');
        } else {
          await this.deps.client.acknowledgeCommand(
            command.id,
            'failed',
            'There is no running agent session to deliver it to.',
          );
        }
        break;
      }

      case 'permission_response':
      case 'answer': {
        const requestKey =
          typeof command.payload.requestKey === 'string' ? command.payload.requestKey : '';
        const decision = command.payload.decision === 'deny' ? 'deny' : 'approve';
        const waiting = this.pendingPermissions.get(requestKey);
        if (waiting) {
          waiting.resolve(decision);
          this.pendingPermissions.delete(requestKey);
        }
        /* An answer is also delivered to the conversation, so the agent can act on it. */
        const answer = typeof command.payload.answer === 'string' ? command.payload.answer : '';
        if (answer.length > 0) await this.session?.send(answer);
        await this.deps.client.acknowledgeCommand(command.id, 'completed');
        break;
      }
    }
  }

  /* ------------------------------------------------------------------ run */

  async run(): Promise<void> {
    try {
      /*
       * Three ways in, decided by where the control plane says this mission already is.
       *
       * A worker that restarts is handed back the run it still holds, through the same call that
       * hands out a first claim. Treating every assignment as a fresh start is what used to make
       * a restart destructive: it re-ran an agent whose work was already committed, and it
       * announced a state the mission had long since left.
       */
      if (this.assignment.missionState === 'stopping') {
        await this.confirmStoppedAfterRestart();
      } else if (this.assignment.kind === 'inspection') {
        await this.runInspection();
      } else if (this.assignment.missionState === 'creating_pull_request') {
        await this.resumeDelivery();
      } else {
        await this.runExecution();
      }
    } catch (error) {
      await this.fail(classifyFailure(error), describe(error));
    } finally {
      await this.session?.close().catch(() => undefined);
    }
  }

  /**
   * The repository to clone.
   *
   * Ordinarily exactly what the control plane sent. A worker configured with a sandbox mapping
   * redirects the clone somewhere harmless — and says so in the timeline, so a rehearsal can
   * never be mistaken for the real delivery.
   */
  private async repositoryForRun(): Promise<MissionAssignment['repository']> {
    const repository = this.assignment.repository;
    if (!repository) return null;
    const redirect = this.deps.config.sandboxRepositories.get(repository.fullName.toLowerCase());
    if (!redirect) return repository;

    await this.emit(
      'warning',
      `Sandbox mode: cloning ${repository.fullName} from ${redirect} instead of the real repository. No code is read from ${repository.fullName} and nothing is pushed to it — a pull request would still be opened against it, so restrict that with JARVIS_WORKER_ALLOWED_REPOS or a scoped token if this is a rehearsal.`,
      { sandbox: true },
      'warning',
    );
    return { ...repository, cloneUrl: redirect };
  }

  /**
   * Why this run may not open a pull request, or null when it may.
   *
   * Returns a sentence rather than a boolean because the sentence is what reaches the owner, and
   * "delivery was refused" without the reason is the kind of message that gets read as a bug.
   *
   * Sandbox redirection deliberately does *not* appear here. It changes where the code is cloned
   * from and nothing else — the control plane still names the repository a pull request would be
   * opened against, and the controls that stop one reaching a repository you care about are this
   * allow-list, the token's own scopes, and `JARVIS_WORKER_GITHUB_API_URL`. Treating a redirect
   * as an implicit delivery refusal would read well and would leave a rehearsal against a real
   * repository, with no allow-list set, exactly as exposed as before.
   */
  private deliveryRefusal(fullName: string): string | null {
    const allowed = this.deps.config.allowedRepositories;
    if (allowed && !allowed.has(fullName.toLowerCase())) {
      return `This worker is not permitted to deliver to ${fullName}. Add it to JARVIS_WORKER_ALLOWED_REPOS on the worker if that is what you intend. The work is committed on the mission branch.`;
    }
    return null;
  }

  /* ----------------------------------------------------------- inspection */

  /**
   * Read-only planning.
   *
   * The workspace is cloned but no branch is created and every mutating tool is denied, so an
   * inspection run genuinely cannot change anything — the permission mode and the absence of a
   * branch are two independent reasons rather than one.
   */
  private async runInspection(): Promise<void> {
    await this.report('inspecting', { currentAction: 'Preparing a read-only workspace' });

    if (!this.assignment.repository) {
      /* A project with no repository can still be planned, just from Jarvis's own record. */
      await this.emit(
        'info',
        'This project has no repository, so planning uses the Jarvis record only.',
      );
      await this.submitPlan(this.fallbackPlan());
      return;
    }

    this.workspace = await prepareWorkspace({
      workspaceRoot: this.deps.config.workspaceRoot,
      missionId: this.assignment.missionId,
      repository: (await this.repositoryForRun())!,
      branchName: null,
      credentialToken: this.deps.config.githubToken,
      readOnly: true,
      reuseExisting: false,
      /* Its own clone, so the execution run that follows does not find this one in its way. */
      slot: 'inspect',
      onProgress: (message) => void this.emit('info', message),
    });

    await this.emit('workspace_prepared', `Inspecting ${this.assignment.repository.fullName}.`, {
      baseBranch: this.workspace.baseBranch,
      baseSha: this.workspace.baseSha,
    });

    const collected: string[] = [];
    await this.driveAgent({
      readOnly: true,
      prompt: this.buildInspectionPrompt(),
      onMessage: (text) => collected.push(text),
    });

    const plan = parsePlanFromTranscript(collected.join('\n\n'), this.assignment, this.workspace);
    await this.submitPlan(plan);
  }

  private async submitPlan(content: MissionPlanContent): Promise<void> {
    await this.deps.client.submitPlan(this.assignment.missionId, {
      runId: this.assignment.runId,
      content,
    });
    await this.emit('plan_submitted', 'Plan submitted for your approval.', {
      scopeItems: content.scope.length,
    });
  }

  /* ------------------------------------------------------------ execution */

  private async runExecution(): Promise<void> {
    const readOnly = isReadOnlyMissionType(this.assignment.missionType);
    const continuing = isMissionAlreadyUnderway(this.assignment.missionState);

    if (continuing) {
      /*
       * A re-claim. The mission is already past `preparing_workspace` in the control plane's
       * record — the worker restarted, or its process was replaced, and the run it still holds
       * was handed straight back to it.
       *
       * Announcing `preparing_workspace` here is what used to kill these missions: it is not a
       * move a `running` mission allows, the 409 is not retryable, and the failure classifier
       * read that as `worker_lost` and failed a mission whose work was sitting intact on disk.
       * So the state is left where it is and the `running` report below re-synchronises it,
       * which every state a re-claim can arrive in does permit.
       */
      await this.emit(
        'info',
        'Picking this mission back up after a worker restart. Its workspace and branch are preserved.',
        { resumed: true, missionState: this.assignment.missionState },
        'notice',
      );
    } else {
      await this.report('preparing_workspace', { currentAction: 'Preparing the workspace' });
    }

    const repository = await this.repositoryForRun();
    this.workspace = repository
      ? await prepareWorkspace({
          workspaceRoot: this.deps.config.workspaceRoot,
          missionId: this.assignment.missionId,
          repository,
          branchName: readOnly ? null : this.assignment.branchName,
          credentialToken: this.deps.config.githubToken,
          readOnly,
          /*
           * A resume continues in the preserved workspace; a fresh attempt refuses to reuse one.
           *
           * The mission's state decides this alongside the session id, because the two can
           * disagree: a worker killed before it ever reported a session id leaves a mission
           * `running` with `agentSessionId` null, and reading only the session id would then
           * refuse the very workspace the run had already built.
           */
          reuseExisting: this.assignment.resumeSessionId !== null || continuing,
          onProgress: (message) => void this.emit('info', message),
        })
      : await prepareScratchWorkspace(this.deps.config.workspaceRoot, this.assignment.missionId);

    await this.emit(
      this.workspace.branch ? 'branch_created' : 'workspace_prepared',
      this.workspace.branch
        ? `Created ${this.workspace.branch} from ${this.workspace.baseBranch}@${this.workspace.baseSha.slice(0, 7)}.`
        : 'Workspace ready (read-only).',
      { baseBranch: this.workspace.baseBranch, baseSha: this.workspace.baseSha },
    );

    await this.report('running', {
      currentAction: 'Working through the approved plan',
      workspacePath: this.workspace.repoPath,
      baseBranch: this.workspace.baseBranch,
      baseSha: this.workspace.baseSha,
      branchName: this.workspace.branch,
    });

    const messages: string[] = [];
    const outcome = await this.driveAgent({
      readOnly,
      prompt: this.buildExecutionPrompt(),
      onMessage: (text) => messages.push(text),
    });

    if (this.stopRequested) return this.confirmStopped();
    if (outcome === 'failed') return;
    if (this.pauseRequested) return this.confirmPaused();

    if (readOnly || !this.workspace.branch) {
      await this.deliverReport(messages.join('\n\n'));
      return;
    }

    await this.verifyAndDeliver(messages.join('\n\n'));
  }

  /**
   * Resume a run that was interrupted between committing and opening the pull request.
   *
   * The agent is deliberately **not** run again. Its work is already committed on the mission
   * branch; re-running it would spend the model a second time, could produce a different commit
   * from the one that was verified, and would have nothing to commit at the end of it.
   *
   * So this picks up exactly where the previous process died: reuse the workspace, push the
   * branch (a no-op if the push already landed), and adopt or open the draft pull request. The
   * verifications are not re-run either — they were reported to the control plane as they
   * happened, and the record of them is there rather than in this process's memory.
   */
  private async resumeDelivery(): Promise<void> {
    const repository = await this.repositoryForRun();
    if (!repository || !this.assignment.branchName) {
      await this.fail(
        'worker_lost',
        'This run was interrupted while opening its pull request, but it has no repository or branch to resume from.',
      );
      return;
    }
    if (!this.deps.delivery || !this.deps.config.githubToken) {
      await this.fail(
        'github_auth_error',
        'This run was interrupted while opening its pull request, and this worker has no GitHub write credential to finish it with. The commit is safe on the mission branch.',
      );
      return;
    }

    await this.emit(
      'info',
      'The previous run was interrupted after committing, while opening the draft pull request. Resuming at delivery — the agent is not run again.',
      { resumed: true, missionState: this.assignment.missionState },
      'notice',
    );

    this.workspace = await prepareWorkspace({
      workspaceRoot: this.deps.config.workspaceRoot,
      missionId: this.assignment.missionId,
      repository,
      branchName: this.assignment.branchName,
      credentialToken: this.deps.config.githubToken,
      readOnly: false,
      reuseExisting: true,
      onProgress: (message) => void this.emit('info', message),
    });

    const gitOptions = {
      cwd: this.workspace.repoPath,
      credentialToken: this.deps.config.githubToken,
    };
    const head = await headSha(gitOptions);
    const files = await filesAgainstBase(
      this.workspace.repoPath,
      this.workspace.baseBranch,
      this.deps.config.githubToken,
    );

    await this.deliverBranch({
      head,
      files,
      /*
       * The transcript died with the previous process. Saying so is better than inventing a
       * summary, and better than an empty one that reads like the agent had nothing to report.
       */
      summary:
        'This run was interrupted after its work was committed and verified. The pull request below delivers that exact commit; the narrative summary from the interrupted run was not recovered.',
    });
  }

  /**
   * The mission was already stopping when this worker came back.
   *
   * It is not resumed and no agent is started: the owner asked for a stop, and a restart is not
   * a reason to overrule that. Confirming it here is what releases a mission that would otherwise
   * sit in `stopping` forever waiting for a process that no longer exists.
   */
  private async confirmStoppedAfterRestart(): Promise<void> {
    await this.emit(
      'run_finished',
      'You asked for this mission to stop, and the worker restarted before it could confirm. Nothing was resumed; its workspace and branch are untouched on disk.',
      { resumed: true },
      'warning',
    );
    await this.report('stopped', { currentAction: null, workspacePreserved: true });
    this.finished = true;
  }

  /* ------------------------------------------------------------- the agent */

  private async driveAgent(options: {
    readOnly: boolean;
    prompt: string;
    onMessage: (text: string) => void;
  }): Promise<'done' | 'failed' | 'paused' | 'stopped'> {
    const workspace = this.workspace;
    if (!workspace) throw new Error('The workspace was not prepared.');

    const policy: PolicyContext = {
      workspaceRoot: workspace.repoPath,
      readOnly: options.readOnly,
      branchName: workspace.branch,
      defaultBranch: workspace.baseBranch,
      doNotTouch: this.assignment.doNotTouch,
      allowWebResearch: this.assignment.allowWebResearch && this.deps.config.allowWebResearch,
    };

    this.session = await this.deps.runtime.start({
      workspaceRoot: workspace.repoPath,
      systemPrompt: buildPolicyPrompt(policy),
      prompt: options.prompt,
      resumeSessionId: this.assignment.resumeSessionId,
      readOnly: options.readOnly,
      maxTurns: this.deps.config.maxTurns,
      model: this.deps.config.model,
      signal: this.abort.signal,
      decide: (request) => this.decide(request, policy),
    });

    for await (const event of this.session.events) {
      const outcome = await this.handleAgentEvent(event, options.onMessage);
      if (outcome) return outcome;
      if (this.stopRequested) {
        await this.session.interrupt();
        return 'stopped';
      }
    }

    return this.pauseRequested ? 'paused' : 'done';
  }

  private async handleAgentEvent(
    event: AgentEvent,
    onMessage: (text: string) => void,
  ): Promise<'done' | 'failed' | null> {
    switch (event.type) {
      case 'session':
        this.sessionId = event.sessionId;
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
        await this.emit('info', 'The agent finished its work.', {});
        onMessage(event.result);
        return 'done';

      case 'error':
        await this.fail('agent_error', event.message);
        return 'failed';
    }
  }

  /**
   * The permission callback.
   *
   * `allow` and `deny` are answered by the policy alone. `ask` blocks the tool call, creates an
   * owner-facing permission request, and waits — which is exactly the behaviour the spec asks
   * for: an operation outside the permission set becomes a request, never a silent allow.
   */
  private async decide(
    request: { toolName: string; input: Record<string, unknown> },
    policy: PolicyContext,
  ): Promise<PolicyDecision> {
    const decision = evaluateToolUse(request, policy);
    if (decision.verdict !== 'ask') return decision;

    const requestKey = `${request.toolName}:${hashInput(request.input)}`;
    await this.deps.client.permission({
      runId: this.assignment.runId,
      requestKey,
      kind:
        request.toolName === 'WebSearch' || request.toolName === 'WebFetch'
          ? 'unavailable_access'
          : 'tool_permission',
      toolName: request.toolName,
      requestedAction: boundText(redactSecrets(describeRequest(request)), 900),
      reason: decision.reason,
      risk: 'medium',
      ifApproved: `The agent performs this one ${request.toolName} call. The approval does not extend to any other call.`,
      alternatives: ['Deny and let the agent find another way.', 'Stop the mission.'],
    });

    await this.report('waiting_for_permission', {
      currentAction: `Waiting for your decision on ${request.toolName}`,
    });

    const answer = await new Promise<'approve' | 'deny'>((resolve) => {
      this.pendingPermissions.set(requestKey, { requestKey, resolve });
      this.abort.signal.addEventListener('abort', () => resolve('deny'), { once: true });
    });

    await this.report('running', { currentAction: 'Working through the approved plan' });

    return answer === 'approve'
      ? { verdict: 'allow' }
      : { verdict: 'deny', rule: decision.rule, reason: 'You denied this request.' };
  }

  /* -------------------------------------------------------- verify & deliver */

  private async verifyAndDeliver(summary: string): Promise<void> {
    const workspace = this.workspace;
    if (!workspace?.branch) throw new Error('There is no mission branch to deliver.');
    const gitOptions = { cwd: workspace.repoPath, credentialToken: this.deps.config.githubToken };

    const files = await changedFiles(gitOptions);
    if (files.length === 0) {
      await this.emit(
        'warning',
        'The agent finished without changing any file, so there is nothing to deliver.',
        {},
        'warning',
      );
      await this.report('completed', {
        completionSummary: boundText(summary, 3000) || 'No changes were needed.',
        filesChanged: [],
      });
      this.finished = true;
      return;
    }

    await this.emit(
      'file_changed',
      `${files.length} file${files.length === 1 ? '' : 's'} changed.`,
      {
        files: files.slice(0, 100),
      },
    );

    /* ---------------------------------------------------------- verify */
    await this.report('verifying', { currentAction: 'Running verification', filesChanged: files });
    const planned = this.assignment.plan?.verification ?? [];
    const discovered = await discoverCommands(workspace.repoPath);
    const commands = planned.length > 0 ? planned : discovered;

    for (const command of commands) {
      if (this.stopRequested) return this.confirmStopped();
      await this.emit('verification_started', `Running ${command.command}…`);
      const result = await runVerification(command, {
        repoPath: workspace.repoPath,
        workspaceRoot: this.deps.config.workspaceRoot,
        timeoutMs: this.deps.config.verifyTimeoutMs,
      });
      this.verifications.push(result);
      await this.deps.client.verification({ ...result, runId: this.assignment.runId });
    }

    const summaryOfChecks = summariseVerification(this.verifications);
    await this.emit(
      'verification_finished',
      `Verification: ${summaryOfChecks.headline}`,
      { ...summaryOfChecks },
      summaryOfChecks.failed > 0 ? 'warning' : 'info',
    );

    /* ---------------------------------------------------------- commit */
    await git(['add', '--all'], gitOptions);
    const message = buildCommitMessage(this.assignment, summary);
    await git(['commit', '--message', message], gitOptions);
    const head = await headSha(gitOptions);
    await this.emit('commit_created', `Committed ${head.slice(0, 7)}.`, { sha: head });

    /* ------------------------------------------------------------ push */
    if (!this.deps.delivery || !this.deps.config.githubToken || !this.assignment.repository) {
      await this.emit(
        'warning',
        'The work is committed on the mission branch, but this worker has no GitHub write credential, so it cannot push or open a pull request.',
        {},
        'warning',
      );
      await this.report('completed', {
        headSha: head,
        filesChanged: files,
        completionSummary: `${boundText(summary, 2000)}\n\nCommitted locally on ${workspace.branch}; no pull request was opened because this worker has no GitHub write credential.`,
      });
      this.finished = true;
      return;
    }

    await this.deliverBranch({ head, files, summary });
  }

  /**
   * Push the mission branch and deliver the draft pull request.
   *
   * Split out of `verifyAndDeliver` because a run interrupted mid-delivery re-enters here and
   * nowhere else: one copy of the push, the adoption check and the `pull_request_ready` report
   * means a resumed delivery cannot drift from a first-time one.
   */
  private async deliverBranch(input: {
    head: string;
    files: readonly string[];
    summary: string;
  }): Promise<void> {
    const workspace = this.workspace;
    if (!workspace?.branch) throw new Error('There is no mission branch to deliver.');
    if (!this.deps.delivery || !this.deps.config.githubToken || !this.assignment.repository) {
      throw new Error('This worker has no GitHub write credential.');
    }
    const { head, files, summary } = input;
    const delivery = this.deps.delivery;
    const repository = this.assignment.repository;

    /*
     * Refused before anything is pushed and before any request is made.
     *
     * An allow-listed worker refuses a repository nobody put on its list, whatever the
     * credential would have permitted — the token is the first lock and this is the second, held
     * by the machine that does the pushing rather than by GitHub's settings page.
     */
    const refusal = this.deliveryRefusal(repository.fullName);
    if (refusal) {
      await this.emit('warning', refusal, { repository: repository.fullName }, 'warning');
      await this.report('completed', {
        headSha: head,
        filesChanged: files,
        completionSummary: `${boundText(summary, 2000)}\n\n${refusal}`,
        currentAction: null,
      });
      this.finished = true;
      return;
    }

    await this.report('creating_pull_request', {
      currentAction: 'Pushing the mission branch',
      headSha: head,
    });

    /*
     * `pushMissionBranch` re-checks the branch, the default branch and every argument before a
     * process is started. It cannot push anything but this mission's branch.
     */
    await pushMissionBranch({
      cwd: workspace.repoPath,
      branch: workspace.branch,
      defaultBranch: workspace.baseBranch,
      credentialToken: this.deps.config.githubToken,
    });
    await this.emit('branch_pushed', `Pushed ${workspace.branch}.`, { branch: workspace.branch });

    /* ------------------------------------------------------ draft PR */
    const body = buildPullRequestBody({
      missionId: this.assignment.missionId,
      missionTitle: this.assignment.missionTitle,
      baseUrl: this.deps.config.controlPlaneUrl,
      plan: this.assignment.plan,
      verifications: this.verifications,
      filesChanged: files,
      openQuestions: [],
    });

    /*
     * Look before opening.
     *
     * The window between pushing the branch and opening the pull request is small, but a worker
     * killed inside it used to come back and open a second draft pull request for the same
     * commit. The branch is this mission's alone, so an open pull request already pointing at it
     * is this mission's pull request — it is adopted, not duplicated.
     */
    const existing = await delivery
      .findOpenPullRequest(repository.owner, repository.name, workspace.branch)
      .catch(() => null);

    if (existing) {
      /* Bring the body up to date with the run that actually finished. */
      await delivery
        .updatePullRequestBody(repository.owner, repository.name, existing.number, body)
        .catch(() => undefined);
    }

    const pull =
      existing ??
      (await delivery.createDraftPullRequest({
        owner: repository.owner,
        repo: repository.name,
        title: this.assignment.missionTitle,
        body,
        head: workspace.branch,
        base: workspace.baseBranch,
      }));

    await this.emit(
      'pull_request_created',
      existing
        ? `Draft pull request #${pull.number} was already open for this branch, so it was updated rather than duplicated. It is not merged.`
        : `Opened draft pull request #${pull.number}. It is not merged.`,
      { url: pull.url, number: pull.number, draft: pull.draft, adopted: existing !== null },
      'notice',
    );

    const checks = await delivery
      .checkStatus(repository.owner, repository.name, head)
      .catch(() => null);
    if (checks) {
      await this.emit('ci_status', `CI: ${checks.summary}`, { state: checks.state });
    }

    await this.report('pull_request_ready', {
      pullRequestUrl: pull.url,
      pullRequestNumber: pull.number,
      headSha: head,
      filesChanged: files,
      completionSummary: boundText(summary, 3000),
      currentAction: null,
    });
    this.finished = true;
  }

  /** A research or investigation mission ends in a report, never a branch. */
  private async deliverReport(summary: string): Promise<void> {
    const title = `${this.assignment.missionTitle} — findings`;
    const content = summary.trim().length > 0 ? summary : 'The agent produced no findings.';

    await this.deps.client.artifact(this.assignment.missionId, {
      runId: this.assignment.runId,
      kind:
        this.assignment.missionType === 'research_report' ? 'research_report' : 'technical_report',
      title,
      contentType: 'text/markdown',
      content: boundText(content, 190_000),
      sources: [],
    });

    if (this.workspace) {
      /* A copy on disk too, so a stopped mission's findings survive without the control plane. */
      await writeFile(path.join(this.workspace.missionRoot, 'report.md'), content, 'utf8').catch(
        () => undefined,
      );
    }

    await this.report('completed', {
      completionSummary: boundText(content, 3000),
      currentAction: null,
    });
    this.finished = true;
  }

  /* --------------------------------------------------------------- endings */

  private async confirmPaused(): Promise<void> {
    await this.session?.close().catch(() => undefined);
    await this.emit(
      'info',
      'Paused. The workspace, branch and session are preserved.',
      {},
      'notice',
    );
    await this.report('paused', {
      currentAction: 'Paused',
      workspacePreserved: true,
      agentSessionId: this.sessionId,
    });
    this.finished = true;
  }

  private async confirmStopped(): Promise<void> {
    await this.session?.close().catch(() => undefined);
    const files = this.workspace
      ? await changedFiles({ cwd: this.workspace.repoPath }).catch(() => [])
      : [];
    await this.emit(
      'run_finished',
      `Stopped. ${files.length} changed file${files.length === 1 ? '' : 's'} and the workspace are preserved — nothing was deleted.`,
      { files: files.slice(0, 50) },
      'warning',
    );
    await this.report('stopped', {
      currentAction: null,
      workspacePreserved: true,
      filesChanged: files,
    });
    this.finished = true;
  }

  private async fail(code: MissionFailureCode, message: string): Promise<void> {
    if (this.finished) return;
    this.finished = true;
    const preserved = this.workspace !== null;
    await this.emit(
      'error',
      boundText(redactSecrets(message), 1500),
      { failureCode: code },
      'error',
    );
    await this.report('failed', {
      failureCode: code,
      failureMessage: boundText(redactSecrets(message), 1500),
      workspacePreserved: preserved,
      currentAction: null,
    }).catch(() => undefined);
  }

  /* -------------------------------------------------------------- plumbing */

  private async emit(
    type: MissionEventInput['type'],
    summary: string,
    detail: Record<string, unknown> = {},
    level: MissionEventInput['level'] = 'info',
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
      /*
       * A dropped event must never kill a mission. The control plane's own record of the run
       * state remains authoritative, and the next successful report re-synchronises it.
       */
      if (error instanceof ControlPlaneError && error.fatal) throw error;
    }
  }

  /**
   * Report progress.
   *
   * A `null` state means "metadata only": the session id or the token count changed and the
   * worker has nothing to say about the mission's state. It deliberately does not re-assert the
   * state the worker last set — during a read-only inspection that would claim `running`, which
   * is not a move `inspecting` allows, and mid-run it would fight an owner's pause.
   */
  private async report(state: MissionState | null, patch: Record<string, unknown>): Promise<void> {
    const response = await this.deps.client.runState({
      runId: this.assignment.runId,
      ...(state ? { missionState: state } : {}),
      runtimeName: this.deps.runtime.name,
      runtimeVersion: this.deps.config.version,
      ...patch,
    } as never);
    /* The control plane is the authority on whether the owner asked for a stop or a pause. */
    if (response.stopRequested) this.stopRequested = true;
    if (response.pauseRequested) this.pauseRequested = true;
  }

  private buildInspectionPrompt(): string {
    const a = this.assignment;
    return [
      `# Mission (read-only inspection)`,
      ``,
      `The owner asked: "${a.rawRequest}"`,
      a.missionDescription ? `\nMore detail: ${a.missionDescription}` : '',
      ``,
      `Project: ${a.projectName}${a.projectGoal ? ` — goal: ${a.projectGoal}` : ''}`,
      a.repository
        ? `Repository: ${a.repository.fullName} (default branch ${a.repository.defaultBranch})`
        : '',
      ``,
      ...(a.clarifications.length > 0
        ? [
            `## What the owner already decided`,
            ...a.clarifications.map(
              (item) =>
                `- ${item.question} → ${item.answer}${item.assumed ? ' _(Jarvis assumed this; it is not the owner’s decision)_' : ''}`,
            ),
            ``,
          ]
        : []),
      ...(a.projectContext.length > 0
        ? ['## What Jarvis already knows', ...a.projectContext.map((line) => `- ${line}`), '']
        : []),
      `## Your task`,
      ``,
      `Inspect this repository and produce an implementation plan. **Change nothing.**`,
      ``,
      `Read the structure, any CLAUDE.md or AGENTS.md, the architecture docs, recent history, the`,
      `existing implementation of anything related, the tests, and the CI workflows. Work out what`,
      `commands this repository actually uses to verify itself.`,
      ``,
      `Then output the plan as a single fenced \`\`\`json block matching this shape exactly:`,
      ``,
      '```json',
      JSON.stringify(
        {
          summary: 'one paragraph',
          proposedOutcome: 'what will be true when this is done',
          assumptions: ['…'],
          scope: ['…'],
          outOfScope: ['…'],
          affectedAreas: ['path/to/file.ts'],
          approach: 'numbered steps',
          dataMigrations: [],
          testsToAddOrUpdate: ['…'],
          verification: [
            { command: 'npm test', purpose: 'run the suite', source: 'package_script' },
          ],
          uiValidation: [],
          risks: [{ description: '…', mitigation: '…', severity: 'medium' }],
          rollback: 'how to undo it',
          acceptanceCriteria: ['…'],
          openQuestions: [],
          estimatedComplexity: 'small',
          withinRequestedScope: true,
          reviewOnlyDelivery: true,
        },
        null,
        2,
      ),
      '```',
      ``,
      `Every \`verification\` command must be one you actually found in this repository. Set`,
      `\`source\` to where you found it: package_script, makefile, ci_workflow or documentation.`,
      `Use agent_inference only when you are guessing, and say so in the assumptions.`,
    ]
      .filter((line) => line !== '')
      .join('\n');
  }

  private buildExecutionPrompt(): string {
    const a = this.assignment;
    const plan = a.plan;
    return [
      `# Approved mission`,
      ``,
      `The owner asked: "${a.rawRequest}"`,
      `Mission: ${a.missionTitle}`,
      a.missionDescription ? `Detail: ${a.missionDescription}` : '',
      `Project: ${a.projectName}`,
      a.repository ? `Repository: ${a.repository.fullName}` : '',
      a.branchName ? `Branch: ${a.branchName} (already created and checked out for you)` : '',
      ``,
      ...(plan
        ? [
            `## The approved plan — version ${a.planVersion}`,
            ``,
            `**Outcome:** ${plan.proposedOutcome}`,
            ``,
            `**Approach:**`,
            plan.approach,
            ``,
            plan.scope.length > 0
              ? `**In scope:**\n${plan.scope.map((s) => `- ${s}`).join('\n')}`
              : '',
            plan.outOfScope.length > 0
              ? `\n**Out of scope — do not do these:**\n${plan.outOfScope.map((s) => `- ${s}`).join('\n')}`
              : '',
            plan.testsToAddOrUpdate.length > 0
              ? `\n**Tests to add or update:**\n${plan.testsToAddOrUpdate.map((s) => `- ${s}`).join('\n')}`
              : '',
            plan.acceptanceCriteria.length > 0
              ? `\n**Done means:**\n${plan.acceptanceCriteria.map((s) => `- ${s}`).join('\n')}`
              : '',
            ``,
          ]
        : []),
      ...(a.constraints.length > 0
        ? [`## Constraints`, ...a.constraints.map((c) => `- ${c}`), ``]
        : []),
      ...(a.doNotTouch.length > 0
        ? [`## Do not change`, ...a.doNotTouch.map((c) => `- ${c}`), ``]
        : []),
      ...(a.clarifications.length > 0
        ? [
            `## Decisions already made`,
            ...a.clarifications.map(
              (item) =>
                `- ${item.question} → ${item.answer}${item.assumed ? ' _(assumed, not confirmed by the owner)_' : ''}`,
            ),
            ``,
          ]
        : []),
      `## How to work`,
      ``,
      `Implement the approved plan and nothing beyond it. Write or update the tests it names.`,
      `Do not commit, push, or open a pull request — Jarvis does all of that itself once you are`,
      `finished, after running the repository's own verification.`,
      ``,
      `If the plan turns out to be wrong, or the right fix is outside its scope, stop and explain`,
      `rather than doing it anyway.`,
      ``,
      `When you are done, finish with a short summary of what you changed and why.`,
    ]
      .filter((line) => line !== '')
      .join('\n');
  }

  /** Used when a project has no repository to inspect. */
  private fallbackPlan(): MissionPlanContent {
    return {
      summary: this.assignment.rawRequest,
      proposedOutcome: `A report attached to ${this.assignment.projectName}.`,
      assumptions: ['This project has no connected repository, so nothing was inspected.'],
      scope: [this.assignment.missionTitle],
      outOfScope: ['Any change to code.'],
      affectedAreas: [],
      approach: 'Research the question and write it up as a report attached to the project.',
      dataMigrations: [],
      testsToAddOrUpdate: [],
      verification: [],
      uiValidation: [],
      risks: [],
      rollback: 'Nothing is changed, so there is nothing to undo.',
      acceptanceCriteria: ['A report that answers the question.'],
      openQuestions: [],
      estimatedComplexity: 'unknown',
      withinRequestedScope: true,
      scopeNotes: null,
      reviewOnlyDelivery: true,
      evidenceIds: [],
      repositoryFacts: {},
    };
  }
}

/* ------------------------------------------------------------------ helpers */

/**
 * Extract the plan from what the agent said.
 *
 * A model can produce almost-JSON, or wrap it in prose, or produce nothing usable at all. All
 * three are handled the same way: parse what is there, and where a field is missing, fall back to
 * something the owner can see is a fallback rather than inventing a confident-looking value.
 */
export function parsePlanFromTranscript(
  transcript: string,
  assignment: MissionAssignment,
  workspace: WorkspaceHandle | null,
): MissionPlanContent {
  const fenced = /```json\s*([\s\S]*?)```/i.exec(transcript);
  const raw = fenced?.[1] ?? extractBalancedObject(transcript);

  let parsed: Record<string, unknown> = {};
  if (raw) {
    try {
      parsed = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      parsed = {};
    }
  }

  const strings = (key: string, fallback: string[] = []): string[] => {
    const value = parsed[key];
    if (!Array.isArray(value)) return fallback;
    return value.filter((item): item is string => typeof item === 'string').slice(0, 30);
  };
  const text = (key: string, fallback: string): string => {
    const value = parsed[key];
    return typeof value === 'string' && value.trim().length > 0 ? value : fallback;
  };

  const verification = Array.isArray(parsed.verification)
    ? (parsed.verification as Record<string, unknown>[])
        .filter((entry) => typeof entry?.command === 'string')
        .slice(0, 15)
        .map((entry) => ({
          command: String(entry.command),
          purpose: typeof entry.purpose === 'string' ? entry.purpose : 'Verification.',
          source: isVerificationSource(entry.source) ? entry.source : ('agent_inference' as const),
          expectedUnavailableReason: null,
        }))
    : [];

  const risks = Array.isArray(parsed.risks)
    ? (parsed.risks as Record<string, unknown>[])
        .filter((entry) => typeof entry?.description === 'string')
        .slice(0, 20)
        .map((entry) => ({
          description: String(entry.description),
          mitigation:
            typeof entry.mitigation === 'string'
              ? entry.mitigation
              : 'Delivered as a draft pull request for review.',
          severity: isSeverity(entry.severity) ? entry.severity : ('medium' as const),
        }))
    : [];

  return {
    summary: text('summary', assignment.rawRequest),
    proposedOutcome: text(
      'proposedOutcome',
      `A draft pull request delivering: ${assignment.missionTitle}.`,
    ),
    assumptions: strings('assumptions'),
    scope: strings('scope', [assignment.missionTitle]),
    outOfScope: strings('outOfScope', [
      'Merging the pull request.',
      'Deploying, publishing or releasing anything.',
    ]),
    affectedAreas: strings('affectedAreas'),
    approach: text('approach', 'The agent did not return a structured approach.'),
    dataMigrations: strings('dataMigrations'),
    testsToAddOrUpdate: strings('testsToAddOrUpdate'),
    verification,
    uiValidation: strings('uiValidation'),
    risks,
    rollback: text(
      'rollback',
      'Close the draft pull request and delete the mission branch; the default branch is untouched.',
    ),
    acceptanceCriteria: strings('acceptanceCriteria', [
      'The described behaviour works and the existing test suite is still green.',
    ]),
    openQuestions: raw
      ? strings('openQuestions')
      : [
          'The inspection did not return a structured plan, so this one was reconstructed from its notes. Review the scope carefully.',
        ],
    estimatedComplexity: isComplexity(parsed.estimatedComplexity)
      ? parsed.estimatedComplexity
      : 'unknown',
    withinRequestedScope: parsed.withinRequestedScope !== false,
    scopeNotes: typeof parsed.scopeNotes === 'string' ? parsed.scopeNotes : null,
    /* Never taken from the model: Jarvis's delivery is review-only by construction. */
    reviewOnlyDelivery: true,
    evidenceIds: [],
    repositoryFacts: workspace
      ? {
          defaultBranch: workspace.baseBranch,
          headSha: workspace.baseSha,
          repositoryFullName: workspace.repositoryFullName,
        }
      : {},
  };
}

/** Finds the first balanced `{…}` in free text, for a model that skipped the fence. */
function extractBalancedObject(text: string): string | null {
  const start = text.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (char === '"') inString = !inString;
    if (inString) continue;
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  return null;
}

function isVerificationSource(
  value: unknown,
): value is
  | 'package_script'
  | 'makefile'
  | 'ci_workflow'
  | 'documentation'
  | 'agent_inference'
  | 'configured' {
  return (
    typeof value === 'string' &&
    [
      'package_script',
      'makefile',
      'ci_workflow',
      'documentation',
      'agent_inference',
      'configured',
    ].includes(value)
  );
}

function isSeverity(value: unknown): value is 'critical' | 'high' | 'medium' | 'low' {
  return typeof value === 'string' && ['critical', 'high', 'medium', 'low'].includes(value);
}

function isComplexity(
  value: unknown,
): value is 'trivial' | 'small' | 'medium' | 'large' | 'unknown' {
  return (
    typeof value === 'string' && ['trivial', 'small', 'medium', 'large', 'unknown'].includes(value)
  );
}

export function buildCommitMessage(assignment: MissionAssignment, summary: string): string {
  const subject = assignment.missionTitle.slice(0, 68);
  const body = boundText(redactSecrets(summary.trim()), 1500);
  return [
    subject,
    '',
    body,
    '',
    `Jarvis-Mission: ${assignment.missionId}`,
    `Jarvis-Plan-Version: ${assignment.planVersion ?? 'n/a'}`,
  ]
    .filter((line, index, all) => !(line === '' && all[index - 1] === ''))
    .join('\n');
}

function describeRequest(request: { toolName: string; input: Record<string, unknown> }): string {
  const target =
    request.input.file_path ?? request.input.path ?? request.input.command ?? request.input.url;
  return typeof target === 'string'
    ? `${request.toolName}: ${target}`
    : `${request.toolName} with ${Object.keys(request.input).join(', ') || 'no arguments'}`;
}

function hashInput(input: Record<string, unknown>): string {
  const text = JSON.stringify(input);
  let hash = 0;
  for (let index = 0; index < text.length; index += 1) {
    hash = (hash * 31 + text.charCodeAt(index)) | 0;
  }
  return Math.abs(hash).toString(36);
}

function classifyFailure(error: unknown): MissionFailureCode {
  if (error instanceof WorkspaceError) {
    return error.code === 'clone_failed' ? 'git_error' : 'workspace_error';
  }
  if (error instanceof DeliveryError) return error.failureCode;
  if (error instanceof ControlPlaneError) return 'worker_lost';
  const message = describe(error).toLowerCase();
  if (message.includes('git ')) return 'git_error';
  if (message.includes('not allowed') || message.includes('policy')) return 'policy_violation';
  if (message.includes('timeout') || message.includes('time limit')) return 'timeout';
  return 'agent_error';
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
