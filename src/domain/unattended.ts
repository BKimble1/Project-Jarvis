import { AGENT_ROLES, isDeterministicRole, isWriteRole, type AgentRole } from './agent-role';
import { ForbiddenError } from './errors';
import { isReadOnlyMissionType, MISSION_TYPES, type MissionType } from './mission';
import { TASK_TYPES, type TaskType } from './mission-task';
import {
  CAPABILITY_LABELS,
  CAPABILITY_REQUIRED_LEVEL,
  meetsLevel,
  QUALIFICATION_LEVEL_LABELS,
  type ActivationCapability,
  type QualificationLevel,
} from './qualification';

/**
 * The activation lock, applied to the work Jarvis actually does.
 *
 * Phase 4A built the lock — levels, capabilities, `assertActivationAllowed` — and then wired it to
 * exactly one caller. That was survivable for as long as a person approved every mission, because
 * the person *was* the gate. Standing authority removes the person, and the moment it does, an
 * unenforced lock is not a control at all.
 *
 * This module is the missing half: it maps the concrete things a worker is about to be handed — a
 * mission of some type, a task of some role and type — onto the capabilities they consume, so a
 * gate can be placed where the work is handed out rather than where somebody remembered to check.
 *
 * ## Attended work is not gated here, and that is the point
 *
 * `CAPABILITY_REQUIRED_LEVEL` is documented as the rung each capability needs *before it may run
 * unattended*. Every function here honours that word. A mission a person approved is attended: the
 * owner looked at the plan, and a qualification ladder is not entitled to overrule them. A mission
 * standing authority queued is unattended by definition, and it is the only kind these gates stop.
 *
 * Conflating the two would make the ladder either useless (if it never stopped anything) or
 * intolerable (if it stopped the owner's own work on a fresh install), and a control nobody can
 * live with is a control somebody deletes.
 *
 * ## Why this is a separate question from the charter
 *
 * The charter asks *has the owner permitted this?* This asks *has this deployment demonstrated it
 * can do this safely?* A charter that grants `code.change` across every repository still cannot
 * make an unqualified deployment safe to write, and a deployment qualified to `production` still
 * may not touch a repository the owner never granted. Both must be asked, in either order, and
 * neither answer implies the other.
 */

/* ---------------------------------------------------------------- missions */

/**
 * What a mission of this type consumes if it runs with nobody watching.
 *
 * Every mission runs a real model session, so `model_task_readonly` is unconditional. A mission
 * type that is not read-only both writes files and ends in a draft pull request, so it takes the
 * two write capabilities as well — listed separately rather than collapsed, because "the agent may
 * edit files" and "Jarvis may push to GitHub" are different questions that happen to sit on the
 * same rung today.
 */
export function missionUnattendedCapabilities(type: MissionType): readonly ActivationCapability[] {
  if (isReadOnlyMissionType(type)) return ['model_task_readonly'];
  return ['model_task_readonly', 'model_task_write', 'github_write'];
}

/** Mission types a worker may be handed unattended at this rung. */
export function unattendedMissionTypes(level: QualificationLevel): readonly MissionType[] {
  return MISSION_TYPES.filter((type) => allows(missionUnattendedCapabilities(type), level));
}

/* ------------------------------------------------------------------- tasks */

/**
 * What a task of this role and type consumes if it runs with nobody watching.
 *
 * Two independent axes, unioned:
 *
 * - **The role** decides whether a model runs and whether it may edit files. `verifier` and
 *   `integrator` run no model at all — they execute the repository's own checks and merge branches
 *   with deterministic git — so they contribute nothing. That is not a loophole: whatever they are
 *   operating on was produced by a `builder` whose own claim was gated.
 * - **The task type** decides where the result goes. `delivery` pushes a branch and opens a pull
 *   request; `ci_dispatch` starts a workflow on somebody else's infrastructure. Both reach outside
 *   this machine regardless of how little model latitude they involve, which is exactly why they
 *   are keyed on the type rather than on the role.
 */
export function taskUnattendedCapabilities(
  role: AgentRole,
  type: TaskType,
): readonly ActivationCapability[] {
  const capabilities = new Set<ActivationCapability>();
  if (isWriteRole(role)) {
    capabilities.add('model_task_readonly');
    capabilities.add('model_task_write');
  } else if (!isDeterministicRole(role)) {
    capabilities.add('model_task_readonly');
  }
  if (type === 'delivery') capabilities.add('github_write');
  if (type === 'ci_dispatch') capabilities.add('ci_dispatch');
  return [...capabilities];
}

/**
 * Roles a worker may be handed unattended at this rung, ignoring the task's type.
 *
 * Used to narrow a claim query, which can filter on role cheaply. It is deliberately the *looser*
 * of the two filters: a role that passes here may still be refused once its task type is known,
 * and `assertUnattended` on the claimed task is what makes that true. A filter that is loose in
 * the query and exact at the boundary is safe; the reverse is not.
 */
export function unattendedTaskRoles(level: QualificationLevel): readonly AgentRole[] {
  return AGENT_ROLES.filter((role) =>
    TASK_TYPES.some((type) => allows(taskUnattendedCapabilities(role, type), level)),
  );
}

/** Task types a worker may be handed unattended at this rung, ignoring the task's role. */
export function unattendedTaskTypes(level: QualificationLevel): readonly TaskType[] {
  return TASK_TYPES.filter((type) =>
    AGENT_ROLES.some((role) => allows(taskUnattendedCapabilities(role, type), level)),
  );
}

/* ------------------------------------------------------------- the verdict */

export interface UnattendedVerdict {
  readonly allowed: boolean;
  readonly level: QualificationLevel;
  /** Capabilities this work needs that the deployment has not earned. Empty when allowed. */
  readonly missing: readonly {
    readonly capability: ActivationCapability;
    readonly required: QualificationLevel;
  }[];
  readonly reason: string | null;
}

function allows(capabilities: readonly ActivationCapability[], level: QualificationLevel): boolean {
  return capabilities.every((capability) =>
    meetsLevel(level, CAPABILITY_REQUIRED_LEVEL[capability]),
  );
}

/**
 * Whether this deployment may run this work unattended, and what is missing if it may not.
 *
 * Returns every missing capability rather than the first, because the owner's next question is
 * always "what would I have to qualify?" and answering it one rung per attempt is a bad way to
 * spend somebody's afternoon.
 */
export function unattendedVerdict(
  capabilities: readonly ActivationCapability[],
  level: QualificationLevel,
): UnattendedVerdict {
  const missing = capabilities
    .filter((capability) => !meetsLevel(level, CAPABILITY_REQUIRED_LEVEL[capability]))
    .map((capability) => ({ capability, required: CAPABILITY_REQUIRED_LEVEL[capability] }));
  if (missing.length === 0) return { allowed: true, level, missing: [], reason: null };
  return {
    allowed: false,
    level,
    missing,
    reason: `Jarvis is at "${QUALIFICATION_LEVEL_LABELS[level]}", so it will not ${missing
      .map((entry) => CAPABILITY_LABELS[entry.capability])
      .join(', nor ')} without you watching. Qualify to ${QUALIFICATION_LEVEL_LABELS[
      highest(missing.map((entry) => entry.required))
    ].toLowerCase()} first, or approve this yourself.`,
  };
}

/**
 * The choke point, for callers that already hold the work.
 *
 * Throws for the same reason `assertActivationAllowed` does: past this line the work is running,
 * and a boolean at that boundary is a boolean somebody eventually forgets to read.
 */
export function assertUnattended(
  capabilities: readonly ActivationCapability[],
  level: QualificationLevel,
): void {
  const verdict = unattendedVerdict(capabilities, level);
  if (!verdict.allowed) {
    throw new ForbiddenError(verdict.reason ?? 'That is not qualified to run unattended.', {
      level,
      missing: verdict.missing.map((entry) => entry.capability),
    });
  }
}

function highest(levels: readonly QualificationLevel[]): QualificationLevel {
  return levels.reduce<QualificationLevel>(
    (worst, level) => (meetsLevel(level, worst) ? level : worst),
    'built',
  );
}
