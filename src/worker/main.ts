import { hostname, platform, release } from 'node:os';
import type { WorkerHeartbeatInput } from '@/domain/worker-protocol';
import { ControlPlaneClient, ControlPlaneError } from './client';
import { buildWorkerConfig, describeWorkerConfig, type WorkerConfig } from './config';
import { GitHubRestDelivery, type GitHubDelivery } from './delivery';
import { MissionRunner } from './mission-runner';
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
    };
  }

  /**
   * The main loop.
   *
   * Poll → deliver any commands → claim if idle → run. Errors never end the loop unless the
   * worker has been revoked: a control plane that is briefly unreachable is a normal condition
   * for a worker running on someone's home network.
   */
  async run(): Promise<void> {
    await this.refreshHealth();
    this.log(
      `Jarvis worker ${this.deps.config.name} v${this.deps.config.version} → ${this.deps.config.controlPlaneUrl}`,
    );
    this.log(`Runtime: ${this.deps.runtime.name} — ${this.runtimeDetail}`);
    this.log(`Workspaces: ${this.workspaceDetail}`);

    let interval = this.deps.config.pollIntervalMs;

    while (!this.stopped) {
      try {
        const response = await this.deps.client.poll({
          heartbeat: await this.heartbeat(),
          wantsWork: !this.draining && this.runtimeAvailable && this.workspaceHealthy,
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

        if (!this.current && !this.draining && this.runtimeAvailable && this.workspaceHealthy) {
          await this.claimAndRun();
        }
        if (this.draining && !this.current) {
          this.log('Drained. Exiting.');
          break;
        }
      } catch (error) {
        if (error instanceof ControlPlaneError && error.fatal) {
          this.log(`The control plane rejected this worker: ${error.message}`);
          this.stopped = true;
          break;
        }
        this.log(`Poll failed: ${error instanceof Error ? error.message : String(error)}`);
        await this.refreshHealth();
      }

      await this.sleep(interval);
    }
  }

  private async claimAndRun(): Promise<void> {
    const assignment = await this.deps.client.claim({
      heartbeat: await this.heartbeat(),
      accepts: [...this.deps.config.accepts],
    });
    if (!assignment) return;

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
      : new ClaudeAgentRuntime({ apiKey: config.anthropicApiKey, model: config.model });

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
