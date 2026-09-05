import { randomUUID } from 'node:crypto';
import type {
  MissionAssignment,
  WorkerClaimInput,
  WorkerEventBatchInput,
  WorkerPlanSubmissionInput,
  WorkerPollInput,
  WorkerPollResponse,
  WorkerRunStateInput,
  TaskAssignment,
} from '@/domain/worker-protocol';
import type {
  ArtifactInput,
  PermissionRequestInput,
  VerificationInput,
} from '@/domain/mission-run';
import { redactSecrets } from '@/domain/redaction';

/** What the worker learns from driving a pass. It acts on none of it; the control plane decides. */
export interface OperatorTickResponse {
  readonly outcome: string;
  readonly summary: string;
  readonly tickId: string | null;
  readonly missionsStarted: number;
  readonly capacity: { readonly verdict: string; readonly reason: string } | null;
}

/**
 * The worker's client for the Jarvis control plane.
 *
 * Every state-changing call carries an `Idempotency-Key`, so a request that times out can be
 * retried without applying twice. The worker's token goes in the `Authorization` header and
 * nowhere else — never in a URL, never in a log line, never in an error message (which is why
 * every error string here is redacted before it escapes).
 */

export class ControlPlaneError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
    this.name = 'ControlPlaneError';
  }

  /** A revoked worker must stop and exit; everything else is worth retrying. */
  get fatal(): boolean {
    return this.status === 401 || this.status === 403;
  }
}

export interface ControlPlaneClientOptions {
  readonly baseUrl: string;
  readonly token: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  readonly maxRetries?: number;
}

export class ControlPlaneClient {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: ControlPlaneClientOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  poll(input: WorkerPollInput): Promise<WorkerPollResponse> {
    return this.post('/api/worker/poll', input, { idempotent: false });
  }

  /**
   * Ask the control plane to take one pass of the operating loop.
   *
   * Not idempotency-guarded, and deliberately so: repeating it is the whole point. The pass takes
   * a lease, so two overlapping calls do not both run, and a pass that finds nothing to do records
   * that and returns.
   */
  operatorTick(): Promise<OperatorTickResponse> {
    return this.post('/api/worker/operator-tick', {}, { idempotent: false });
  }

  async claim(input: WorkerClaimInput): Promise<MissionAssignment | null> {
    const response = await this.post<{ assignment: MissionAssignment | null }>(
      '/api/worker/claim',
      input,
    );
    return response.assignment;
  }

  events(input: WorkerEventBatchInput): Promise<{ accepted: number }> {
    return this.post('/api/worker/events', input);
  }

  runState(input: WorkerRunStateInput): Promise<{
    ok: true;
    missionState: string;
    stopRequested: boolean;
    pauseRequested: boolean;
  }> {
    return this.post('/api/worker/run', input);
  }

  /**
   * Ask for a write lease before touching anything.
   *
   * Returns `{granted:false}` rather than throwing when another task holds an overlapping lease:
   * a task that has to wait is an ordinary outcome, not an error, and treating it as one would
   * turn a scheduling decision into a failed task.
   */
  /** Claim the next task of a task graph. Returns `null` when there is nothing this worker may take. */
  async claimTask(input: {
    heartbeat: unknown;
    roles: readonly string[];
  }): Promise<TaskAssignment | null> {
    const response = await this.post<{ assignment: TaskAssignment | null }>(
      '/api/worker/claim-task',
      input,
    );
    return response.assignment;
  }

  acquireLease(input: {
    runId: string;
    taskId: string;
    paths: readonly string[];
  }): Promise<{ granted: boolean; reason: string | null }> {
    return this.post('/api/worker/lease', input);
  }

  /** Report a task's state. `taskState` omitted means metadata only, as with `runState`. */
  taskState(input: {
    runId: string;
    taskId: string;
    taskState?: string;
    [key: string]: unknown;
  }): Promise<{ ok: true; taskState: string; stopRequested: boolean; pauseRequested: boolean }> {
    return this.post('/api/worker/task', input);
  }

  /**
   * Submit a review verdict.
   *
   * Deliberately does *not* return what the control plane decided to do about it. A reviewing
   * worker has no business knowing whether its verdict triggered a repair — and a fresh reviewer
   * in the next round must not be able to find out what the last one concluded.
   */
  submitReview(input: {
    runId: string;
    taskId: string;
    verdict: string;
    summary: string;
    findings: readonly unknown[];
    reviewedFiles: readonly string[];
    diffFingerprint: string;
    unavailableReason: string | null;
  }): Promise<{ ok: true }> {
    return this.post('/api/worker/review', input);
  }

  submitPlan(
    missionId: string,
    input: WorkerPlanSubmissionInput,
  ): Promise<{ ok: true; missionState: string; planVersion: number | null }> {
    return this.post(`/api/worker/missions/${missionId}/plan`, input);
  }

  permission(input: PermissionRequestInput & { runId: string }): Promise<{ id: string }> {
    return this.post('/api/worker/permission', input);
  }

  verification(input: VerificationInput & { runId: string }): Promise<{ id: string }> {
    return this.post('/api/worker/verification', input);
  }

  artifact(
    missionId: string,
    input: ArtifactInput & { runId?: string | null },
  ): Promise<{ id: string }> {
    return this.post(`/api/worker/missions/${missionId}/artifact`, input);
  }

  acknowledgeCommand(
    commandId: string,
    outcome: 'acknowledged' | 'completed' | 'failed',
    detail?: string,
  ): Promise<{ ok: true }> {
    return this.post('/api/worker/commands', {
      commandId,
      outcome,
      ...(detail ? { detail } : {}),
    });
  }

  private async post<T>(
    path: string,
    body: unknown,
    options: { idempotent?: boolean } = {},
  ): Promise<T> {
    const idempotent = options.idempotent ?? true;
    /*
     * The key is generated once, outside the retry loop, which is the entire point: every retry
     * of *this* request carries the same key, so the control plane replays its first response
     * instead of applying the change again.
     */
    const key = idempotent ? randomUUID() : null;
    const maxRetries = this.options.maxRetries ?? 4;

    let lastError: unknown = null;
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      if (attempt > 0) await delay(Math.min(8000, 500 * 2 ** (attempt - 1)));
      try {
        return await this.attempt<T>(path, body, key);
      } catch (error) {
        lastError = error;
        if (error instanceof ControlPlaneError && (error.fatal || error.status < 500)) throw error;
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new ControlPlaneError('The control plane could not be reached.', 0, 'unreachable');
  }

  private async attempt<T>(path: string, body: unknown, key: string | null): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 30_000);
    try {
      const response = await this.fetchImpl(`${this.options.baseUrl}${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.options.token}`,
          ...(key ? { 'idempotency-key': key } : {}),
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      const text = await response.text();
      const parsed = text.length > 0 ? (JSON.parse(text) as unknown) : {};

      if (!response.ok) {
        const error = parsed as { error?: { code?: string; message?: string } };
        throw new ControlPlaneError(
          redactSecrets(error.error?.message ?? `Request failed with ${response.status}.`),
          response.status,
          error.error?.code ?? 'unknown',
        );
      }
      return parsed as T;
    } catch (error) {
      if (error instanceof ControlPlaneError) throw error;
      throw new ControlPlaneError(
        redactSecrets(error instanceof Error ? error.message : String(error)),
        0,
        'network_error',
      );
    } finally {
      clearTimeout(timer);
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
