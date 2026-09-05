import { z } from 'zod';
import { CAPACITY_TASK_STATES, type MissionTask, type TaskState } from './mission-task';
import { isWriteRole } from './agent-role';

/**
 * How much Jarvis is allowed to be doing at once, and what happens when it reaches the ceiling.
 *
 * Multi-agent work fails in a particular way: it does not crash, it just quietly costs more and
 * more while producing less and less. So every ceiling here is a *number decided in advance*, and
 * the only thing an agent can do about one is stop. There is deliberately no path — no tool, no
 * permission request, no playbook field — by which a running agent raises its own limit, adds a
 * repair round, or gets a bigger budget. Those are owner decisions and they are made outside the
 * session.
 *
 * When a ceiling is reached Jarvis stops *scheduling*, tries to pause what is running, preserves
 * the work, records why, and puts it in front of the owner. It never switches to a cheaper model
 * to keep going, and it never switches to a more expensive one to try harder.
 */

export interface CapacityLimits {
  /** Missions that may be active across the whole instance. */
  readonly maxActiveMissions: number;
  /** Agent runs that may be active across the whole instance. */
  readonly maxActiveRuns: number;
  /** Agent runs that may be active within one mission. */
  readonly maxRunsPerMission: number;
  /** Read-only tasks that may run in parallel within one mission. */
  readonly maxParallelReadOnly: number;
  /** Write-capable tasks that may run at once within one mission. */
  readonly maxParallelWriters: number;
  readonly maxRepairRounds: number;
  readonly maxTaskRuntimeMs: number;
  readonly maxMissionRuntimeMs: number;
  /** Output tokens across one mission, when the runtime reports usage. */
  readonly maxMissionOutputTokens: number | null;
  readonly maxTaskOutputTokens: number | null;
}

/**
 * Conservative by design.
 *
 * These are the values Prompt 3 ships with. They are small on purpose: a factory that runs two
 * missions well is worth more than one that runs eight badly, and every one of these can be
 * raised deliberately in configuration once the owner has watched it work.
 */
export const DEFAULT_CAPACITY_LIMITS: CapacityLimits = {
  maxActiveMissions: 2,
  maxActiveRuns: 4,
  maxRunsPerMission: 3,
  maxParallelReadOnly: 3,
  maxParallelWriters: 1,
  maxRepairRounds: 2,
  maxTaskRuntimeMs: 45 * 60_000,
  maxMissionRuntimeMs: 4 * 60 * 60_000,
  maxMissionOutputTokens: 3_000_000,
  maxTaskOutputTokens: 600_000,
};

/** Hard ceilings. Configuration may lower any limit; nothing may raise one past these. */
export const ABSOLUTE_CAPACITY_CEILINGS: CapacityLimits = {
  maxActiveMissions: 6,
  maxActiveRuns: 12,
  maxRunsPerMission: 6,
  maxParallelReadOnly: 6,
  maxParallelWriters: 3,
  maxRepairRounds: 3,
  maxTaskRuntimeMs: 4 * 60 * 60_000,
  maxMissionRuntimeMs: 12 * 60 * 60_000,
  maxMissionOutputTokens: 20_000_000,
  maxTaskOutputTokens: 4_000_000,
};

/**
 * Clamp configuration to the absolute ceilings.
 *
 * Applied wherever limits are read, so a mistaken environment variable or a database row cannot
 * produce a Jarvis that runs twenty agents. The clamp is silent by design — it is a safety net,
 * not a validation error that would stop the instance from booting.
 */
export function clampCapacityLimits(proposed: Partial<CapacityLimits>): CapacityLimits {
  const merged = { ...DEFAULT_CAPACITY_LIMITS, ...proposed };
  const clampNumber = (value: number, ceiling: number, floor = 1): number =>
    Math.max(floor, Math.min(value, ceiling));
  return {
    maxActiveMissions: clampNumber(
      merged.maxActiveMissions,
      ABSOLUTE_CAPACITY_CEILINGS.maxActiveMissions,
    ),
    maxActiveRuns: clampNumber(merged.maxActiveRuns, ABSOLUTE_CAPACITY_CEILINGS.maxActiveRuns),
    maxRunsPerMission: clampNumber(
      merged.maxRunsPerMission,
      ABSOLUTE_CAPACITY_CEILINGS.maxRunsPerMission,
    ),
    maxParallelReadOnly: clampNumber(
      merged.maxParallelReadOnly,
      ABSOLUTE_CAPACITY_CEILINGS.maxParallelReadOnly,
    ),
    maxParallelWriters: clampNumber(
      merged.maxParallelWriters,
      ABSOLUTE_CAPACITY_CEILINGS.maxParallelWriters,
    ),
    maxRepairRounds: clampNumber(
      merged.maxRepairRounds,
      ABSOLUTE_CAPACITY_CEILINGS.maxRepairRounds,
      0,
    ),
    maxTaskRuntimeMs: clampNumber(
      merged.maxTaskRuntimeMs,
      ABSOLUTE_CAPACITY_CEILINGS.maxTaskRuntimeMs,
      60_000,
    ),
    maxMissionRuntimeMs: clampNumber(
      merged.maxMissionRuntimeMs,
      ABSOLUTE_CAPACITY_CEILINGS.maxMissionRuntimeMs,
      60_000,
    ),
    maxMissionOutputTokens:
      merged.maxMissionOutputTokens === null
        ? null
        : clampNumber(
            merged.maxMissionOutputTokens,
            ABSOLUTE_CAPACITY_CEILINGS.maxMissionOutputTokens ?? Number.MAX_SAFE_INTEGER,
            1_000,
          ),
    maxTaskOutputTokens:
      merged.maxTaskOutputTokens === null
        ? null
        : clampNumber(
            merged.maxTaskOutputTokens,
            ABSOLUTE_CAPACITY_CEILINGS.maxTaskOutputTokens ?? Number.MAX_SAFE_INTEGER,
            1_000,
          ),
  };
}

/* ------------------------------------------------------------------ posture */

export const CAPACITY_POSTURES = [
  /** Normal operation. */
  'open',
  /** Finish what is running; start nothing new. */
  'draining',
  /** Stop everything that can be stopped, now. */
  'stopped',
] as const;
export type CapacityPosture = (typeof CAPACITY_POSTURES)[number];

export const CAPACITY_POSTURE_LABELS: Record<CapacityPosture, string> = {
  open: 'Running normally',
  draining: 'Draining — finishing what is running, starting nothing new',
  stopped: 'Stopped — nothing new will start',
};

/* -------------------------------------------------------------- the verdict */

export interface CapacitySnapshot {
  readonly activeMissions: number;
  readonly activeRuns: number;
  readonly posture: CapacityPosture;
}

export interface MissionCapacitySnapshot {
  readonly activeRuns: number;
  readonly activeReadOnly: number;
  readonly activeWriters: number;
  readonly outputTokensUsed: number;
  readonly runtimeMsUsed: number;
  readonly repairRoundsUsed: number;
}

export interface CapacityVerdict {
  readonly allowed: boolean;
  readonly rule: string | null;
  readonly reason: string | null;
  /** True when waiting will help; false when the owner has to do something. */
  readonly retryable: boolean;
}

const PERMIT: CapacityVerdict = { allowed: true, rule: null, reason: null, retryable: false };

const refuse = (rule: string, reason: string, retryable: boolean): CapacityVerdict => ({
  allowed: false,
  rule,
  reason,
  retryable,
});

export interface StartTaskCapacityInput {
  readonly limits: CapacityLimits;
  readonly instance: CapacitySnapshot;
  readonly mission: MissionCapacitySnapshot;
  readonly task: Pick<MissionTask, 'role' | 'repairRound'>;
  /** True when this task's mission is already active, so starting it adds no new mission. */
  readonly missionAlreadyActive: boolean;
}

/**
 * May this task start right now?
 *
 * Ordered so the most decisive answer comes first: an emergency stop is not a queueing problem,
 * and telling the owner "waiting will help" when it will not is worse than saying nothing.
 */
export function canStartTask(input: StartTaskCapacityInput): CapacityVerdict {
  const { limits, instance, mission, task } = input;

  if (instance.posture === 'stopped') {
    return refuse(
      'R-CAP1',
      'Jarvis is stopped. Nothing new will start until you resume it.',
      false,
    );
  }
  if (instance.posture === 'draining') {
    return refuse(
      'R-CAP2',
      'Jarvis is draining: it is finishing what is running and starting nothing new.',
      false,
    );
  }
  if (!input.missionAlreadyActive && instance.activeMissions >= limits.maxActiveMissions) {
    return refuse(
      'R-CAP3',
      `Jarvis runs ${limits.maxActiveMissions} missions at a time and both are busy.`,
      true,
    );
  }
  if (instance.activeRuns >= limits.maxActiveRuns) {
    return refuse(
      'R-CAP4',
      `${limits.maxActiveRuns} agents are already running across all missions.`,
      true,
    );
  }
  if (mission.activeRuns >= limits.maxRunsPerMission) {
    return refuse(
      'R-CAP5',
      `This mission already has ${limits.maxRunsPerMission} agents working.`,
      true,
    );
  }
  if (isWriteRole(task.role)) {
    if (mission.activeWriters >= limits.maxParallelWriters) {
      return refuse(
        'R-CAP6',
        `Only ${limits.maxParallelWriters} agent may change files in a mission at a time.`,
        true,
      );
    }
  } else if (mission.activeReadOnly >= limits.maxParallelReadOnly) {
    return refuse(
      'R-CAP7',
      `${limits.maxParallelReadOnly} read-only agents are already working on this mission.`,
      true,
    );
  }
  if (task.repairRound > limits.maxRepairRounds) {
    return refuse(
      'R-CAP8',
      `Repair round ${task.repairRound} is past the limit of ${limits.maxRepairRounds}.`,
      false,
    );
  }
  if (mission.repairRoundsUsed >= limits.maxRepairRounds && task.repairRound > 0) {
    return refuse(
      'R-CAP9',
      `This mission has used all ${limits.maxRepairRounds} repair rounds.`,
      false,
    );
  }
  if (
    limits.maxMissionOutputTokens !== null &&
    mission.outputTokensUsed >= limits.maxMissionOutputTokens
  ) {
    return refuse(
      'R-CAP10',
      `This mission has used its whole token allowance (${formatTokens(mission.outputTokensUsed)}).`,
      false,
    );
  }
  if (mission.runtimeMsUsed >= limits.maxMissionRuntimeMs) {
    return refuse('R-CAP11', 'This mission has used its whole runtime allowance.', false);
  }
  return PERMIT;
}

/** Should a running task be stopped because it has gone past a limit? */
export function taskExceedsLimits(
  task: Pick<MissionTask, 'timeLimitMs' | 'maxOutputTokens' | 'usage' | 'startedAt'>,
  nowIso: string,
): CapacityVerdict {
  if (task.startedAt && task.timeLimitMs !== null) {
    const elapsed = Date.parse(nowIso) - Date.parse(task.startedAt);
    if (Number.isFinite(elapsed) && elapsed > task.timeLimitMs) {
      return refuse(
        'R-CAP12',
        `This task has run for longer than its ${Math.round(task.timeLimitMs / 60_000)}-minute limit.`,
        false,
      );
    }
  }
  const output = task.usage.outputTokens;
  if (task.maxOutputTokens !== null && output !== null && output > task.maxOutputTokens) {
    return refuse(
      'R-CAP13',
      `This task has produced ${formatTokens(output)}, past its ${formatTokens(task.maxOutputTokens)} limit.`,
      false,
    );
  }
  return PERMIT;
}

/* ---------------------------------------------------------------- accounting */

/**
 * Count what is actually running.
 *
 * From stored task states rather than a counter, so a crashed worker, a duplicated claim or a
 * restart all converge. A task whose worker has stopped reporting is handled separately — see
 * `staleTasks` — because counting a dead session as occupied capacity forever is exactly the
 * failure this whole file exists to avoid.
 */
export function summariseMissionCapacity(
  tasks: readonly MissionTask[],
  options: { readonly repairRoundsUsed: number },
): MissionCapacitySnapshot {
  const active = tasks.filter((task) =>
    (CAPACITY_TASK_STATES as readonly TaskState[]).includes(task.state),
  );
  return {
    activeRuns: active.length,
    activeReadOnly: active.filter((task) => !isWriteRole(task.role)).length,
    activeWriters: active.filter((task) => isWriteRole(task.role)).length,
    outputTokensUsed: tasks.reduce((total, task) => total + (task.usage.outputTokens ?? 0), 0),
    runtimeMsUsed: tasks.reduce((total, task) => total + (task.usage.durationMs ?? 0), 0),
    repairRoundsUsed: options.repairRoundsUsed,
  };
}

/**
 * Tasks whose worker has gone quiet.
 *
 * Returned separately from "active" so the dashboard can say *stalled* rather than *running*, and
 * so the scheduler can release their capacity rather than waiting forever for a process that is
 * not coming back.
 */
export function staleTasks(
  tasks: readonly MissionTask[],
  nowIso: string,
  toleranceMs = 120_000,
): readonly MissionTask[] {
  const now = Date.parse(nowIso);
  return tasks.filter((task) => {
    if (!(CAPACITY_TASK_STATES as readonly TaskState[]).includes(task.state)) return false;
    const last = task.lastActivityAt ?? task.startedAt;
    if (!last) return false;
    const elapsed = now - Date.parse(last);
    return Number.isFinite(elapsed) && elapsed > toleranceMs;
  });
}

/** A token count, rounded to something a person can read. Never converted to money. */
export function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M tokens`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}k tokens`;
  return `${value} tokens`;
}

/* ------------------------------------------------------------------ schemas */

export const capacityPostureSchema = z.object({
  posture: z.enum(CAPACITY_POSTURES),
  reason: z.string().trim().max(600).nullish(),
});
export type CapacityPostureInput = z.infer<typeof capacityPostureSchema>;

/**
 * What the owner may change at run time.
 *
 * Only downward: `maxActiveRuns` and the parallelism settings may be reduced immediately to calm
 * a busy instance. Raising them is a configuration change, made deliberately, not a slider that
 * can be nudged while something is going wrong.
 */
export const capacityAdjustmentSchema = z.object({
  maxActiveRuns: z.number().int().min(1).max(ABSOLUTE_CAPACITY_CEILINGS.maxActiveRuns).optional(),
  maxRunsPerMission: z
    .number()
    .int()
    .min(1)
    .max(ABSOLUTE_CAPACITY_CEILINGS.maxRunsPerMission)
    .optional(),
  maxParallelReadOnly: z
    .number()
    .int()
    .min(1)
    .max(ABSOLUTE_CAPACITY_CEILINGS.maxParallelReadOnly)
    .optional(),
});
export type CapacityAdjustmentInput = z.infer<typeof capacityAdjustmentSchema>;

/**
 * Apply an owner adjustment, keeping only reductions.
 *
 * The asymmetry is the point and it is enforced here rather than in a route handler, so every
 * caller gets it. An owner who wants more concurrency edits configuration and restarts; an owner
 * who wants less gets it immediately, which is the direction that matters in an emergency.
 */
export function applyAdjustment(
  current: CapacityLimits,
  adjustment: CapacityAdjustmentInput,
): CapacityLimits {
  return {
    ...current,
    maxActiveRuns: Math.min(
      current.maxActiveRuns,
      adjustment.maxActiveRuns ?? current.maxActiveRuns,
    ),
    maxRunsPerMission: Math.min(
      current.maxRunsPerMission,
      adjustment.maxRunsPerMission ?? current.maxRunsPerMission,
    ),
    maxParallelReadOnly: Math.min(
      current.maxParallelReadOnly,
      adjustment.maxParallelReadOnly ?? current.maxParallelReadOnly,
    ),
  };
}
