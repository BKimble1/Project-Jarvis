import { hostname, platform, release } from 'node:os';
import type { WorkerHeartbeatInput } from '@/domain/worker-protocol';
import { ControlPlaneClient, ControlPlaneError } from './client';
import { buildWorkerConfig, describeWorkerConfig, type WorkerConfig } from './config';
import { GitHubRestDelivery, type GitHubDelivery } from './delivery';
import { MissionRunner } from './mission-runner';
import { TaskRunner } from './task-runner';
import { DETERMINISTIC_ROLES, AGENT_ROLES } from '@/domain/agent-role';
import { ClaudeAgentRuntime } from './runtime/claude-agent-sdk';
import { ScriptedRuntime } from './runtime/scripted';
import type { AgentRuntime } from './runtime/types';
import { checkWorkspaceRoot, listWorkspaces } from './workspace';

/**
 * The Jarvis Worker.
 *
 * A long-lived process. It polls the control plane, claims at most one mission at a time, runs
 * it, and reports what happened. It does not listen on a port and it holds no inbound state, so
 * it runs equally well on a laptop, in Docker, or on a small VM behind a home router.
 *
 * Closing the Jarvis browser tab has no effect on it. That is the whole point.
 */

export interface WorkerRuntimeDeps {
  readonly config: WorkerConfig;
  readonly client: ControlPlaneClient;
  readonly runtime: AgentRuntime;
  readonly delivery: GitHubDelivery | null;
  readonly log?: (message: string) => void;
  readonly sleep?: (ms: number) => Promise<void>;
}

export class JarvisWorkerProcess {
  private draining = false;
  private stopped = false;
  private current: MissionRunner | null = null;
  private currentTask: TaskRunner | null = null;
  private currentMissionId: string | null = null;
  private currentRunId: string | null = null;
  private lastActivityAt: Date | null = null;
  private runtimeAvailable = false;
  private runtimeDetail = 'Not yet checked.';
  private workspaceHealthy = false;
  private workspaceDetail = 'Not yet checked.';

  constructor(private readonly deps: WorkerRuntimeDeps) {}

  private log(message: string): void {
    this.deps.log?.(message);
  }

  private sleep(ms: number): Promise<void> {
    return this.deps.sleep
      ? this.deps.sleep(ms)
      : new Promise((resolve) => setTimeout(resolve, ms));
  }

  /** Begin draining: finish the current mission, then stop. Triggered by SIGTERM/SIGINT. */
  drain(): void {
    if (this.draining) return;
    this.draining = true;
    this.log('Draining. The current mission will finish; no new work will be claimed.');
  }

  stop(): void {
    this.stopped = true;
  }

  private async refreshHealth(): Promise<void> {
    const availability = await this.deps.runtime.availability();
    this.runtimeAvailable = availability.available;
    this.runtimeDetail = availability.detail;

    const workspace = await checkWorkspaceRoot(this.deps.config.workspaceRoot);
    this.workspaceHealthy = workspace.ok;
    this.workspaceDetail = workspace.detail;
  }

  private async heartbeat(): Promise<WorkerHeartbeatInput> {
    const workspaces = await listWorkspaces(this.deps.config.workspaceRoot);
    const described = describeWorkerConfig(this.deps.config);

    const diagnostics = [
      ...this.deps.config.diagnostics,
      this.runtimeAvailable ? null : this.runtimeDetail,
      this.workspaceHealthy ? null : this.workspaceDetail,
      workspaces.length > 0 ? `${workspaces.length} preserved workspace(s) on disk.` : null,
    ].filter((entry): entry is string => entry !== null);

    return {
      status: this.draining
        ? 'draining'
        : this.currentMissionId
          ? 'busy'
          : this.runtimeAvailable && this.workspaceHealthy
            ? 'idle'
            : 'unhealthy',
      version: this.deps.config.version,
      /*
       * Enough to tell two workers apart and to explain a platform-unavailable verification.
       * Deliberately not an environment dump: no paths, no user, no variables.
       */
      platform: `${platform()} ${release()} · ${hostname()}`,
      runtimeAvailable: this.runtimeAvailable,
      runtimeName: this.deps.runtime.name,
      runtimeDetail: this.runtimeDetail,
      workspaceHealthy: this.workspaceHealthy,
      workspaceRootLabel: described.workspaceRootLabel,
      githubDeliveryConfigured: described.githubDeliveryConfigured,
      diagnostics: diagnostics.slice(0, 12),
      currentMissionId: this.currentMissionId,
      currentRunId: this.currentRunId,
      lastActivityAt: this.lastActivityAt?.toISOString() ?? null,
      /*
       * Absent when this runtime has never read capacity, which is most heartbeats: the figures
       * come from a live Claude session and between missions there is not one. Absent means
       * "nothing new", and the control plane keeps the last reading and lets it age. The reading
       * carries its own observation time, so re-sending it does not make it look fresh.
       */
      capacity: this.deps.runtime.capacity?.() ?? null,
    };
  }

  /**
   * Two loops, running at the same time.
   *
   * ## Why this is not one loop
   *
   * It used to be: poll, then claim, then run the mission to completion, then poll again. That
   * reads perfectly well and is wrong the moment a mission takes longer than two minutes, which
   * every real Claude mission does. The heartbeat is only written by the poll, so a worker
   * happily running a mission stopped saying anything at all for the entire mission, and after
   * `WORKER_DISCONNECT_SECONDS` the control plane concluded — correctly, from what it could see —
   * that the worker had died.
   *
   * That single silence produced four separate dishonesties, all of them at exactly the moment an
   * owner is most likely to be watching. The workers page showed a healthy worker as disconnected.
   * An owner's Stop was confirmed as "stopped, nothing touched" while the agent was in fact still
   * running and would still open a pull request. The qualification ladder demoted itself
   * mid-mission, because a rung that needs a live worker could not see one. And no owner command
   * — stop, pause, or a message into the conversation — could reach the running agent, because
   * commands are delivered by the poll and the poll was not happening.
   *
   * So the poll runs on its own now: it keeps the heartbeat current and keeps delivering commands
   * for the whole length of a mission, while the work loop is busy running it.
   *
   * ## What each loop owns
   *
   * The poll loop owns talking: the heartbeat, the revoke directive, and handing owner commands to
   * whatever is running. The work loop owns doing: claiming, running, and deciding when a drain is
   * complete. Neither touches the other's business, and only the work loop ever blocks for long.
   *
   * `stopped` is the one thing they share, and it is set by whichever notices first. A revoke seen
   * by the poll loop ends the poll loop immediately but lets the work loop finish the mission it
   * is holding rather than abandoning a half-written branch — which is also what the single-loop
   * version did, since it could only ever check between missions.
   *
   * Neither loop is allowed to throw. A control plane that is briefly unreachable is an ordinary
   * condition for a worker on someone's home network, and it must not take the worker down; a
   * throw escaping one loop would leave the other running forever with nothing to end it.
   */
  async run(): Promise<void> {
    await this.refreshHealth();
    this.log(
      `Jarvis worker ${this.deps.config.name} v${this.deps.config.version} → ${this.deps.config.controlPlaneUrl}`,
    );
    this.log(`Runtime: ${this.deps.runtime.name} — ${this.runtimeDetail}`);
    this.log(`Workspaces: ${this.workspaceDetail}`);

    await Promise.all([this.pollLoop(), this.workLoop()]);
  }

  /**
   * Whether this worker would take something new right now.
   *
   * Now that the poll runs during a mission, this has to account for being busy — before, a poll
   * only ever happened while idle, so "I am free" was true by construction and the field was
   * decorative. A worker that reported `wantsWork: true` from inside a mission would be stating
   * something plainly false about itself several times a minute.
   */
  private wantsWork(): boolean {
    return (
      !this.draining &&
      !this.current &&
      !this.currentTask &&
      this.runtimeAvailable &&
      this.workspaceHealthy
    );
  }

  /** Keep the control plane informed, and keep owner commands flowing to a running mission. */
  private async pollLoop(): Promise<void> {
    let interval = this.deps.config.pollIntervalMs;

    while (!this.stopped) {
      try {
        const response = await this.deps.client.poll({
          heartbeat: await this.heartbeat(),
          wantsWork: this.wantsWork(),
          acknowledgedCommandIds: [],
        });

        if (response.directive === 'revoked') {
          this.log('This worker has been revoked. Shutting down.');
          this.stopped = true;
          break;
        }
        interval = response.pollIntervalMs;

        /* Owner commands are applied to the mission this worker is actually running. */
        for (const command of response.commands) {
          if (this.current && command.missionId === this.currentMissionId) {
            await this.current.applyCommand(command);
            this.lastActivityAt = new Date();
          }
        }
      } catch (error) {
        if (error instanceof ControlPlaneError && error.fatal) {
          this.log(`The control plane rejected this worker: ${error.message}`);
          this.stopped = true;
          break;
        }
        this.log(`Poll failed: ${error instanceof Error ? error.message : String(error)}`);
        await this.refreshHealth().catch(() => undefined);
      }

      await this.sleep(interval);
    }
  }

  /** Claim and run. The only loop that blocks for a long time, and the one that ends a drain. */
  private async workLoop(): Promise<void> {
    while (!this.stopped) {
      try {
        if (!this.current && !this.currentTask && !this.draining && this.workspaceHealthy) {
          /*
           * Missions first, then tasks, and genuinely first: `claimAndRun` reports whether it took
           * anything, so a worker that just finished a mission goes back round rather than
           * immediately claiming a task in the same breath. A worker with no model runtime still
           * reaches the task claim, because verification and integration need no model at all.
           */
          const tookMission = this.runtimeAvailable ? await this.claimAndRun() : false;
          if (!tookMission) await this.claimAndRunTask();
        }
        if (this.draining && !this.current && !this.currentTask) {
          this.log('Drained. Exiting.');
          this.stopped = true;
          break;
        }
      } catch (error) {
        if (error instanceof ControlPlaneError && error.fatal) {
          this.log(`The control plane rejected this worker: ${error.message}`);
          this.stopped = true;
          break;
        }
        this.log(`Work failed: ${error instanceof Error ? error.message : String(error)}`);
        await this.refreshHealth().catch(() => undefined);
      }

      await this.sleep(this.deps.config.pollIntervalMs);
    }
  }

  /**
   * Which roles this worker will accept.
   *
   * A worker whose model runtime is unavailable still takes `verifier` and `integrator`: those
   * run no model at all, and a mission that can be integrated and verified while its Anthropic
   * key is missing is better than one that stalls entirely.
   */
  private acceptedRoles(): readonly string[] {
    return this.runtimeAvailable ? [...AGENT_ROLES] : [...DETERMINISTIC_ROLES];
  }

  /** Returns whether a task was claimed. Symmetrical with `claimAndRun`, for the same reason. */
  private async claimAndRunTask(): Promise<boolean> {
    const assignment = await this.deps.client.claimTask({
      heartbeat: await this.heartbeat(),
      roles: this.acceptedRoles(),
    });
    if (!assignment) return false;

    this.currentMissionId = assignment.missionId;
    this.currentRunId = assignment.runId;
    this.lastActivityAt = new Date();
    this.log(
      `Claimed task ${assignment.taskKey} (${assignment.role}) for "${assignment.missionTitle}".`,
    );

    const runner = new TaskRunner(
      {
        config: this.deps.config,
        client: this.deps.client,
        runtime: this.deps.runtime,
        delivery: this.deps.delivery,
      },
      assignment,
    );
    this.currentTask = runner;
    try {
      await runner.run();
    } finally {
      this.currentTask = null;
      this.currentMissionId = null;
      this.currentRunId = null;
      this.lastActivityAt = new Date();
      this.log(`Finished task ${assignment.taskKey}.`);
    }
    return true;
  }

  /** Returns whether a mission was claimed, so the work loop can genuinely prefer one to a task. */
  private async claimAndRun(): Promise<boolean> {
    const assignment = await this.deps.client.claim({
      heartbeat: await this.heartbeat(),
      accepts: [...this.deps.config.accepts],
    });
    if (!assignment) return false;

    this.currentMissionId = assignment.missionId;
    this.currentRunId = assignment.runId;
    this.lastActivityAt = new Date();
    this.log(`Claimed ${assignment.kind} run for "${assignment.missionTitle}".`);

    const runner = new MissionRunner(
      {
        config: this.deps.config,
        client: this.deps.client,
        runtime: this.deps.runtime,
        delivery: this.deps.delivery,
      },
      assignment,
    );
    this.current = runner;

    try {
      await runner.run();
    } finally {
      this.current = null;
      this.currentMissionId = null;
      this.currentRunId = null;
      this.lastActivityAt = new Date();
      this.log(`Finished the run for "${assignment.missionTitle}".`);
    }
    return true;
  }
}

/** Build the worker from the environment. Exported so tests can build one with fakes instead. */
export function createWorker(
  config: WorkerConfig,
  log?: (message: string) => void,
): JarvisWorkerProcess {
  const client = new ControlPlaneClient({
    baseUrl: config.controlPlaneUrl,
    token: config.token,
  });

  /*
   * The scripted runtime exists so the whole mission path — claim, workspace, branch, verify,
   * commit, push, draft PR — can be exercised without a model. It is opt-in through
   * `JARVIS_WORKER_RUNTIME=scripted` and makes one harmless, visible change: a line appended to
   * the repository's README. It is never the default.
   */
  const runtime: AgentRuntime =
    config.runtime === 'scripted'
      ? new ScriptedRuntime({
          steps: [
            { kind: 'message', text: 'Adding a note to the readme.' },
            {
              kind: 'tool',
              toolName: 'Edit',
              input: { file_path: 'README.md' },
              effect: async (workspaceRoot: string) => {
                const { appendFile } = await import('node:fs/promises');
                const { join } = await import('node:path');
                await appendFile(
                  join(workspaceRoot, 'README.md'),
                  '\nAdded by a Jarvis sandbox mission.\n',
                  'utf8',
                );
              },
            },
            { kind: 'done', result: 'Appended a note to the readme.' },
          ],
        })
      : new ClaudeAgentRuntime({
          apiKey: config.anthropicApiKey,
          oauthToken: config.claudeOauthToken,
          authMode: config.authMode,
          apiKeyPresent: config.anthropicApiKeyPresent,
          model: config.model,
        });

  const delivery = config.githubToken
    ? new GitHubRestDelivery({ token: config.githubToken, apiBaseUrl: config.githubApiUrl })
    : null;

  return new JarvisWorkerProcess({
    config,
    client,
    runtime,
    delivery,
    ...(log ? { log } : {}),
  });
}

/** Entry point for `npm run worker`. */
export async function main(): Promise<void> {
  const config = buildWorkerConfig();
  const worker = createWorker(config, (message) => {
    console.error(`[jarvis-worker] ${message}`);
  });

  /* A signal drains rather than kills: an in-flight mission finishes and reports honestly. */
  const drain = () => worker.drain();
  process.on('SIGTERM', drain);
  process.on('SIGINT', drain);

  await worker.run();
}
