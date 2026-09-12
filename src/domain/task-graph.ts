import { z } from 'zod';
import {
  ceilingForRole,
  isReviewRole,
  isWriteRole,
  profileForRole,
  resolvePermissionProfile,
  isWithinCeiling,
  type AgentRole,
} from './agent-role';
import {
  satisfiesDependency,
  dependencyIsUnreachable,
  taskProposalSchema,
  type MissionTask,
  type TaskProposal,
  type TaskState,
} from './mission-task';
import { writeSetsOverlap } from './write-set';

/**
 * The mission task graph.
 *
 * A graph is a version, exactly like a plan: it is proposed, the owner reads it, the owner
 * approves *that version*, and a material change produces a new version that needs approving
 * again. Approval is stored against `(missionId, graphVersion)` and re-checked when a worker
 * claims a task, so a graph edited between approval and execution cannot run.
 *
 * Everything in this file is a pure function over the graph's own data. The validator in
 * particular is the piece that makes several of Prompt 3's promises structural rather than
 * procedural: a graph that could reach delivery without an independent review is *rejected at
 * approval time*, not policed at run time by whoever remembers to check.
 */

export const TASK_GRAPH_STATES = [
  /** Being assembled. Not shown to the owner as a decision yet. */
  'draft',
  /** Shown to the owner, waiting for them. */
  'proposed',
  'approved',
  /** Superseded by a later version, or withdrawn. */
  'revoked',
] as const;
export type TaskGraphState = (typeof TASK_GRAPH_STATES)[number];

export interface MissionTaskGraph {
  readonly id: string;
  readonly missionId: string;
  readonly version: number;
  /** The plan version this graph decomposes. A new plan version invalidates the graph. */
  readonly planVersion: number;
  readonly state: TaskGraphState;
  readonly playbookKey: string | null;
  readonly playbookVersion: number | null;
  readonly summary: string;
  readonly notes: readonly string[];
  /** Equal fingerprints mean an edit changed nothing, so no version is created. */
  readonly fingerprint: string;
  readonly maxParallelTasks: number;
  readonly maxWriteTasks: number;
  readonly maxRepairRounds: number;
  readonly proposedBy: 'system' | 'agent' | 'owner' | 'playbook';
  readonly createdAt: string;
  readonly approvedAt: string | null;
  readonly approvedBy: string | null;
  readonly revokedAt: string | null;
  readonly revokedReason: string | null;
}

/* --------------------------------------------------------------- validation */

export interface GraphViolation {
  readonly rule: string;
  readonly message: string;
  readonly taskKeys: readonly string[];
}

export interface GraphValidationResult {
  readonly ok: boolean;
  readonly violations: readonly GraphViolation[];
  /** Sets of task keys that may run at the same time, in dependency order. */
  readonly waves: readonly (readonly string[])[];
  readonly writeTaskKeys: readonly string[];
  readonly reviewTaskKeys: readonly string[];
  readonly verificationTaskKeys: readonly string[];
}

export interface GraphLimits {
  readonly maxTasks: number;
  readonly maxParallelTasks: number;
  readonly maxWriteTasks: number;
  readonly maxRepairRounds: number;
}

export const DEFAULT_GRAPH_LIMITS: GraphLimits = {
  maxTasks: 24,
  maxParallelTasks: 3,
  maxWriteTasks: 1,
  maxRepairRounds: 2,
};

const violation = (
  rule: string,
  message: string,
  taskKeys: readonly string[] = [],
): GraphViolation => ({
  rule,
  message,
  taskKeys,
});

/**
 * Is this graph safe to approve?
 *
 * The rule ids are stable and surfaced to the owner, the same way the risk rules are: a rejection
 * that cannot be explained is indistinguishable from a bug.
 */
export function validateTaskGraph(
  tasks: readonly TaskProposal[],
  options: {
    readonly limits?: Partial<GraphLimits>;
    /** True when this mission will change files at all. A read-only mission needs no reviewer. */
    readonly missionWrites: boolean;
    /** Reviews that deterministic policy says this mission must have. */
    readonly requiredReviewRoles?: readonly AgentRole[];
  },
): GraphValidationResult {
  const limits = { ...DEFAULT_GRAPH_LIMITS, ...options.limits };
  const violations: GraphViolation[] = [];
  const byKey = new Map<string, TaskProposal>();

  for (const task of tasks) {
    if (byKey.has(task.key)) {
      violations.push(violation('R-TG01', `Two tasks share the key ${task.key}.`, [task.key]));
    }
    byKey.set(task.key, task);
  }

  if (tasks.length === 0) {
    violations.push(violation('R-TG02', 'A task graph needs at least one task.'));
  }
  if (tasks.length > limits.maxTasks) {
    violations.push(
      violation(
        'R-TG03',
        `This graph has ${tasks.length} tasks; the configured maximum is ${limits.maxTasks}.`,
      ),
    );
  }

  /* Every dependency must name a task in this graph. */
  for (const task of tasks) {
    for (const dependency of task.dependsOn) {
      if (!byKey.has(dependency)) {
        violations.push(
          violation('R-TG04', `${task.key} depends on ${dependency}, which is not in this graph.`, [
            task.key,
          ]),
        );
      }
      if (dependency === task.key) {
        violations.push(violation('R-TG05', `${task.key} depends on itself.`, [task.key]));
      }
    }
  }

  /* Roles must resolve, and a task may not name a profile wider than its role allows. */
  for (const task of tasks) {
    let ceiling;
    try {
      ceiling = ceilingForRole(task.role);
    } catch {
      violations.push(violation('R-TG06', `${task.key} has an unknown role.`, [task.key]));
      continue;
    }
    if (task.permissionProfileId && task.permissionProfileId !== ceiling.id) {
      let proposed;
      try {
        proposed = resolvePermissionProfile(task.permissionProfileId);
      } catch {
        violations.push(
          violation('R-TG07', `${task.key} names a permission profile that does not exist.`, [
            task.key,
          ]),
        );
        continue;
      }
      if (!isWithinCeiling(proposed, ceiling)) {
        violations.push(
          violation(
            'R-TG08',
            `${task.key} asks for ${proposed.id}, which is wider than ${task.role} is allowed.`,
            [task.key],
          ),
        );
      }
    }
  }

  /* A task that may not write must not declare a write set, and vice versa. */
  const writeTasks = tasks.filter((task) => isWriteRole(task.role));
  for (const task of tasks) {
    const writes = isWriteRole(task.role);
    if (!writes && task.declaredWriteSet.length > 0) {
      violations.push(
        violation('R-TG09', `${task.key} is a ${task.role} and cannot declare a write set.`, [
          task.key,
        ]),
      );
    }
    if (writes && task.declaredWriteSet.length === 0) {
      violations.push(
        violation(
          'R-TG10',
          `${task.key} may change files, so it must say which areas it expects to change.`,
          [task.key],
        ),
      );
    }
    if (writes && task.workspaceRequirement !== 'task_workspace') {
      violations.push(
        violation('R-TG11', `${task.key} may change files, so it needs its own task workspace.`, [
          task.key,
        ]),
      );
    }
    if (!writes && task.workspaceRequirement === 'task_workspace') {
      violations.push(
        violation(
          'R-TG12',
          `${task.key} cannot write, so it must use a read-only clone rather than a task workspace.`,
          [task.key],
        ),
      );
    }
  }

  if (writeTasks.length > limits.maxWriteTasks * 4) {
    violations.push(
      violation(
        'R-TG13',
        `This graph has ${writeTasks.length} write-capable tasks, which is more than Jarvis will schedule.`,
        writeTasks.map((task) => task.key),
      ),
    );
  }

  const cycle = findCycle(tasks);
  if (cycle) {
    violations.push(
      violation(
        'R-TG14',
        `These tasks depend on each other in a loop: ${cycle.join(' → ')}.`,
        cycle,
      ),
    );
  }

  /* Every task must be reachable from something that can actually start. */
  const waves = cycle ? [] : computeWaves(tasks);
  const scheduled = new Set(waves.flat());
  const orphans = tasks.filter((task) => !scheduled.has(task.key));
  if (!cycle && orphans.length > 0) {
    violations.push(
      violation(
        'R-TG15',
        'These tasks can never start, because nothing they depend on can finish.',
        orphans.map((task) => task.key),
      ),
    );
  }

  /* Review coverage. This is the rule that makes review impossible to design around. */
  const reviewTasks = tasks.filter((task) => isReviewRole(task.role));
  if (options.missionWrites && writeTasks.length > 0) {
    if (reviewTasks.length === 0) {
      violations.push(
        violation(
          'R-TG16',
          'This mission changes files, so it needs an independent review before delivery.',
        ),
      );
    }
    for (const writeTask of writeTasks) {
      const reviewed = reviewTasks.some(
        (review) =>
          review.reviewsTaskKey === writeTask.key ||
          dependsTransitively(tasks, review.key, writeTask.key),
      );
      if (!reviewed) {
        violations.push(
          violation('R-TG17', `Nothing reviews the work ${writeTask.key} produces.`, [
            writeTask.key,
          ]),
        );
      }
    }
    for (const review of reviewTasks) {
      if (review.role === 'reviewer' && review.dependsOn.length === 0 && !review.reviewsTaskKey) {
        violations.push(
          violation(
            'R-TG18',
            `${review.key} reviews nothing: a reviewer must depend on the work it reviews.`,
            [review.key],
          ),
        );
      }
    }
  }

  /* Deterministic verification must exist, and must come before the review that follows it. */
  const verificationTasks = tasks.filter((task) => task.taskType === 'verification');
  if (options.missionWrites && writeTasks.length > 0 && verificationTasks.length === 0) {
    violations.push(
      violation(
        'R-TG19',
        'This mission changes files, so the repository’s own checks must run before review.',
      ),
    );
  }
  for (const review of reviewTasks) {
    if (review.repairRound > 0) continue;
    const seesVerification = verificationTasks.some((check) =>
      dependsTransitively(tasks, review.key, check.key),
    );
    if (options.missionWrites && verificationTasks.length > 0 && !seesVerification) {
      violations.push(
        violation(
          'R-TG20',
          `${review.key} would review before verification has run. Verification always comes first.`,
          [review.key],
        ),
      );
    }
  }

  for (const role of options.requiredReviewRoles ?? []) {
    if (!tasks.some((task) => task.role === role)) {
      violations.push(
        violation(
          'R-TG21',
          `This change requires a ${role.replace(/_/g, ' ')} and the graph has none.`,
        ),
      );
    }
  }

  /* Parallel writers must not have overlapping write sets unless they are in different waves. */
  for (const wave of waves) {
    const writersInWave = wave
      .map((key) => byKey.get(key))
      .filter((task): task is TaskProposal => Boolean(task) && isWriteRole(task!.role));
    for (let i = 0; i < writersInWave.length; i += 1) {
      for (let j = i + 1; j < writersInWave.length; j += 1) {
        const left = writersInWave[i]!;
        const right = writersInWave[j]!;
        const overlap = writeSetsOverlap(left.declaredWriteSet, right.declaredWriteSet);
        if (overlap.overlaps) {
          violations.push(
            violation(
              'R-TG22',
              `${left.key} and ${right.key} could run at the same time and both expect to change ${overlap.conflicts[0]?.left}. Make one depend on the other.`,
              [left.key, right.key],
            ),
          );
        }
      }
    }
  }

  for (const wave of waves) {
    if (wave.length > limits.maxParallelTasks) {
      violations.push(
        violation(
          'R-TG23',
          `${wave.length} tasks would be ready at once; Jarvis runs at most ${limits.maxParallelTasks} in parallel.`,
          wave,
        ),
      );
    }
  }

  const maxRepairRound = tasks.reduce((max, task) => Math.max(max, task.repairRound), 0);
  if (maxRepairRound > limits.maxRepairRounds) {
    violations.push(
      violation(
        'R-TG24',
        `This graph plans ${maxRepairRound} repair rounds; the limit is ${limits.maxRepairRounds}.`,
      ),
    );
  }

  /* A repair task must be tied to something it repairs, and must declare a write set. */
  for (const task of tasks.filter((candidate) => candidate.role === 'repairer')) {
    if (task.dependsOn.length === 0) {
      violations.push(
        violation('R-TG25', `${task.key} is a repair task that depends on no review.`, [task.key]),
      );
    }
    if (task.repairRound < 1) {
      violations.push(
        violation('R-TG26', `${task.key} is a repair task but is not in a repair round.`, [
          task.key,
        ]),
      );
    }
  }

  return {
    ok: violations.length === 0,
    violations,
    waves,
    writeTaskKeys: writeTasks.map((task) => task.key),
    reviewTaskKeys: reviewTasks.map((task) => task.key),
    verificationTaskKeys: verificationTasks.map((task) => task.key),
  };
}

/* ------------------------------------------------------------- graph theory */

/** Depth-first cycle detection returning the actual loop, so the message can name it. */
export function findCycle(tasks: readonly TaskProposal[]): readonly string[] | null {
  const edges = new Map<string, readonly string[]>(
    tasks.map((task) => [
      task.key,
      task.dependsOn.filter((key) => tasks.some((t) => t.key === key)),
    ]),
  );
  const state = new Map<string, 'visiting' | 'done'>();
  const stack: string[] = [];

  const visit = (key: string): readonly string[] | null => {
    const current = state.get(key);
    if (current === 'done') return null;
    if (current === 'visiting') {
      const start = stack.indexOf(key);
      return [...stack.slice(start), key];
    }
    state.set(key, 'visiting');
    stack.push(key);
    for (const next of edges.get(key) ?? []) {
      const found = visit(next);
      if (found) return found;
    }
    stack.pop();
    state.set(key, 'done');
    return null;
  };

  for (const task of tasks) {
    const found = visit(task.key);
    if (found) return found;
  }
  return null;
}

/**
 * Group tasks into dependency waves.
 *
 * Wave 0 is everything with no dependencies; wave *n* is everything whose dependencies are all in
 * earlier waves. Tasks left over after no wave can be formed are unreachable, which is how
 * R-TG15 finds orphans. This is scheduling *shape*, not a schedule: capacity decides how many of
 * a wave actually run at once.
 */
export function computeWaves(tasks: readonly TaskProposal[]): readonly (readonly string[])[] {
  const remaining = new Map(tasks.map((task) => [task.key, task]));
  const settled = new Set<string>();
  const waves: string[][] = [];

  while (remaining.size > 0) {
    const wave: string[] = [];
    for (const [key, task] of remaining) {
      const ready = task.dependsOn
        .filter((dependency) => remaining.has(dependency) || settled.has(dependency))
        .every((dependency) => settled.has(dependency));
      if (ready) wave.push(key);
    }
    if (wave.length === 0) break;
    wave.sort();
    for (const key of wave) {
      remaining.delete(key);
      settled.add(key);
    }
    waves.push(wave);
  }
  return waves;
}

/** Does `from` depend on `to`, directly or through any chain? */
export function dependsTransitively(
  tasks: readonly TaskProposal[],
  from: string,
  to: string,
): boolean {
  const edges = new Map(tasks.map((task) => [task.key, task.dependsOn]));
  const seen = new Set<string>();
  const walk = (key: string): boolean => {
    if (seen.has(key)) return false;
    seen.add(key);
    for (const next of edges.get(key) ?? []) {
      if (next === to) return true;
      if (walk(next)) return true;
    }
    return false;
  };
  return walk(from);
}

/* --------------------------------------------------------------- scheduling */

export interface ReadinessResult {
  /** Tasks whose dependencies are all satisfied and which may be claimed now. */
  readonly ready: readonly MissionTask[];
  /** Tasks still waiting on something. */
  readonly blocked: readonly MissionTask[];
  /** Tasks that can never run because a dependency ended badly. */
  readonly unreachable: readonly MissionTask[];
}

/**
 * Which tasks may run next?
 *
 * Deliberately computed from stored task states rather than remembered, so a worker restart, a
 * database retry or a duplicated claim all converge on the same answer.
 */
export function computeReadiness(tasks: readonly MissionTask[]): ReadinessResult {
  const stateByKey = new Map<string, TaskState>(tasks.map((task) => [task.key, task.state]));
  const ready: MissionTask[] = [];
  const blocked: MissionTask[] = [];
  const unreachable: MissionTask[] = [];

  for (const task of tasks) {
    if (task.state !== 'blocked' && task.state !== 'ready') continue;
    const dependencyStates = task.dependsOn.map((key) => stateByKey.get(key));
    if (dependencyStates.some((state) => state !== undefined && dependencyIsUnreachable(state))) {
      unreachable.push(task);
      continue;
    }
    const allSatisfied = dependencyStates.every(
      (state) => state !== undefined && satisfiesDependency(state),
    );
    if (allSatisfied) ready.push(task);
    else blocked.push(task);
  }
  return { ready, blocked, unreachable };
}

/* ------------------------------------------------------------- fingerprints */

/**
 * A stable fingerprint of a graph's *material* content.
 *
 * Deliberately excludes titles and descriptions: rewording a task is not a change that needs
 * re-approval, while changing what may be written, what depends on what, or who does it, is.
 * The caller hashes this string; keeping the serialisation here means both sides agree on what
 * "the same graph" means.
 */
export function graphMaterialContent(tasks: readonly TaskProposal[]): string {
  const rows = [...tasks]
    .sort((a, b) => a.key.localeCompare(b.key))
    .map((task) =>
      [
        task.key,
        task.role,
        task.permissionProfileId ?? profileForRole(task.role).id,
        task.taskType,
        task.workspaceRequirement,
        task.requiresRepository ? 'repo' : 'norepo',
        [...task.dependsOn].sort().join('|'),
        [...task.declaredWriteSet].sort().join('|'),
        [...task.acceptanceCriteria].sort().join('|'),
        String(task.maxAttempts),
        String(task.repairRound),
        task.reviewsTaskKey ?? '',
      ].join(''),
    );
  return rows.join('');
}

/* ------------------------------------------------------------------ schemas */

export const taskGraphProposalSchema = z.object({
  summary: z.string().trim().min(3).max(600),
  notes: z.array(z.string().trim().min(1).max(400)).max(20).default([]),
  tasks: z.array(taskProposalSchema).min(1).max(DEFAULT_GRAPH_LIMITS.maxTasks),
  maxParallelTasks: z.number().int().min(1).max(8).optional(),
  maxWriteTasks: z.number().int().min(1).max(4).optional(),
  maxRepairRounds: z.number().int().min(0).max(3).optional(),
});
export type TaskGraphProposalInput = z.infer<typeof taskGraphProposalSchema>;

export const taskGraphApprovalSchema = z.object({
  graphVersion: z.number().int().min(1),
  /** Repeated back by the UI so an owner cannot approve a graph they were not shown. */
  fingerprint: z.string().trim().min(16).max(128),
  note: z.string().trim().max(2000).nullish(),
  /** The owner may lower concurrency at approval time. They may never raise it past the limits. */
  maxParallelTasks: z.number().int().min(1).max(8).optional(),
});
export type TaskGraphApprovalInput = z.infer<typeof taskGraphApprovalSchema>;

export const taskGraphRevisionSchema = z.object({
  graphVersion: z.number().int().min(1),
  summary: z.string().trim().min(3).max(600).optional(),
  edits: z.array(z.unknown()).max(40).optional(),
  note: z.string().trim().max(2000).nullish(),
});

/** A graph view for the owner: the graph, its tasks and the shape of its schedule. */
export interface TaskGraphView {
  readonly graph: MissionTaskGraph;
  readonly tasks: readonly MissionTask[];
  readonly waves: readonly (readonly string[])[];
  readonly readiness: ReadinessResult;
}
