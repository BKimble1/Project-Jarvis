import { z } from 'zod';

/**
 * The worker registry.
 *
 * A worker is a long-lived process the owner enrols. The control plane keeps its identity, its
 * health and what it is currently doing; the worker's secret exists here only as a hash.
 */

export const WORKER_STATUSES = [
  'registered',
  'idle',
  'busy',
  'draining',
  'unhealthy',
  'disconnected',
  'revoked',
] as const;
export type WorkerStatus = (typeof WORKER_STATUSES)[number];

/**
 * A worker's *reported* status, which is only part of the story. `disconnected` and `unhealthy`
 * are derived by the control plane from the heartbeat age, because a worker that has stopped
 * reporting is in no position to report that it stopped.
 */
export const WORKER_REPORTED_STATUSES = [
  'idle',
  'busy',
  'draining',
  'unhealthy',
] as const satisfies readonly WorkerStatus[];

export interface JarvisWorker {
  readonly id: string;
  readonly name: string;
  /** First characters of the secret, for recognising a worker. Never enough to authenticate. */
  readonly tokenPrefix: string;
  readonly status: WorkerStatus;
  readonly version: string | null;
  readonly platform: string | null;
  readonly currentMissionId: string | null;
  readonly currentRunId: string | null;
  readonly maxConcurrency: number;
  readonly runtimeAvailable: boolean;
  readonly runtimeName: string | null;
  readonly runtimeDetail: string | null;
  readonly workspaceHealthy: boolean;
  readonly workspaceRootLabel: string | null;
  readonly githubDeliveryConfigured: boolean;
  readonly diagnostics: readonly string[];
  readonly lastHeartbeatAt: string | null;
  readonly lastActivityAt: string | null;
  readonly createdAt: string;
  readonly rotatedAt: string | null;
  readonly revokedAt: string | null;
  readonly revokedReason: string | null;
}

/** A worker plus the freshness verdict the control plane derives from its heartbeat. */
export interface WorkerHealth {
  readonly worker: JarvisWorker;
  readonly effectiveStatus: WorkerStatus;
  readonly heartbeatAgeSeconds: number | null;
  readonly explanation: string;
}

/** How long a worker may be silent before Jarvis stops describing it as connected. */
export const WORKER_HEARTBEAT_GRACE_SECONDS = 45;
export const WORKER_DISCONNECT_SECONDS = 120;

export function deriveWorkerHealth(worker: JarvisWorker, now: Date): WorkerHealth {
  if (worker.revokedAt) {
    return {
      worker,
      effectiveStatus: 'revoked',
      heartbeatAgeSeconds: null,
      explanation: 'Revoked. This worker can no longer claim missions or post events.',
    };
  }
  if (!worker.lastHeartbeatAt) {
    return {
      worker,
      effectiveStatus: 'registered',
      heartbeatAgeSeconds: null,
      explanation: 'Enrolled but never seen. Start the worker with its token to connect it.',
    };
  }

  const beat = new Date(worker.lastHeartbeatAt).getTime();
  if (Number.isNaN(beat)) {
    return {
      worker,
      effectiveStatus: 'unhealthy',
      heartbeatAgeSeconds: null,
      explanation: 'The last heartbeat could not be read.',
    };
  }
  const ageSeconds = Math.max(0, Math.round((now.getTime() - beat) / 1000));

  if (ageSeconds > WORKER_DISCONNECT_SECONDS) {
    return {
      worker,
      effectiveStatus: 'disconnected',
      heartbeatAgeSeconds: ageSeconds,
      explanation: `No heartbeat for ${formatAge(ageSeconds)}. Any mission it held is preserved, not failed.`,
    };
  }
  if (ageSeconds > WORKER_HEARTBEAT_GRACE_SECONDS) {
    return {
      worker,
      effectiveStatus: 'unhealthy',
      heartbeatAgeSeconds: ageSeconds,
      explanation: `Last heartbeat ${formatAge(ageSeconds)} ago — slower than expected.`,
    };
  }
  if (!worker.runtimeAvailable) {
    return {
      worker,
      effectiveStatus: 'unhealthy',
      heartbeatAgeSeconds: ageSeconds,
      explanation:
        worker.runtimeDetail ??
        'Connected, but its Claude runtime is unavailable, so it cannot execute missions.',
    };
  }
  if (!worker.workspaceHealthy) {
    return {
      worker,
      effectiveStatus: 'unhealthy',
      heartbeatAgeSeconds: ageSeconds,
      explanation: 'Connected, but its workspace root is not writable.',
    };
  }
  const status: WorkerStatus =
    worker.status === 'draining'
      ? 'draining'
      : worker.currentMissionId
        ? 'busy'
        : worker.status === 'unhealthy'
          ? 'unhealthy'
          : 'idle';
  return {
    worker,
    effectiveStatus: status,
    heartbeatAgeSeconds: ageSeconds,
    explanation:
      status === 'busy'
        ? 'Connected and working on a mission.'
        : status === 'draining'
          ? 'Connected and finishing up before shutting down. It will not claim new work.'
          : status === 'unhealthy'
            ? 'Connected but reporting a problem.'
            : 'Connected and idle.',
  };
}

function formatAge(seconds: number): string {
  if (seconds < 90) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes} min`;
  return `${Math.round(minutes / 60)} h`;
}

export const WORKER_STATUS_LABELS: Record<WorkerStatus, string> = {
  registered: 'Never connected',
  idle: 'Idle',
  busy: 'Busy',
  draining: 'Draining',
  unhealthy: 'Unhealthy',
  disconnected: 'Disconnected',
  revoked: 'Revoked',
};

/* ------------------------------------------------------------------ schemas */

export const workerEnrolmentSchema = z.object({
  name: z.string().trim().min(2).max(80),
  maxConcurrency: z.number().int().min(1).max(4).default(1),
});
export type WorkerEnrolmentInput = z.infer<typeof workerEnrolmentSchema>;

/**
 * The enrolment secret, returned exactly once.
 *
 * `token` is the only time the full value exists outside the worker's own configuration; the
 * control plane keeps a SHA-256 hash and the prefix.
 */
export interface WorkerEnrolment {
  readonly worker: JarvisWorker;
  readonly token: string;
}
