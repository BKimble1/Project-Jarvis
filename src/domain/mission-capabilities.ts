import type { CapabilityClass } from './charter';
import type { CapabilityRequest } from './authorization';
import { isReadOnlyMissionType, type MissionType } from './mission';
import type { MissionPlanContent } from './mission-plan';

/**
 * What a mission would actually need permission to do.
 *
 * The missing link between "the charter authorised a decision for this mission" and "the decision
 * authorised what this mission is going to do". Without it, an operator could ask for permission
 * to update a project's status, be granted it, and then run a mission that rewrites a repository —
 * and every check would pass, because nothing compared the two.
 *
 * ## Two rules
 *
 * **Derived from the plan, not from the request.** The capabilities come from the mission's type
 * and its plan's own content. A caller cannot narrow them by asking for less; `coversPlan` below
 * compares what was granted against what this produces, and a shortfall is a refusal.
 *
 * **Over-request rather than under-request.** Where the mapping is uncertain — a maintenance
 * mission that might update dependencies or might not — the wider set is asked for. Asking for too
 * much makes the owner grant more than strictly necessary, which is annoying. Asking for too
 * little means a mission does something nobody authorised, which is the other kind of problem.
 */

/**
 * Mission types standing authority may run at all.
 *
 * `manual_task` is absent, and its absence is the enforcement. It is work for a *person* — buy the
 * domain, sign the form, phone the accountant — and an operator that "handled" one would be
 * reporting that something happened when nothing did.
 *
 * Note the shape of the refusal below: an unauthorised *type* cannot be fixed by granting more,
 * because there is no capability that means "do a thing only a human can do". That is why it is a
 * separate check rather than an empty capability list — an empty list would mean nothing is
 * missing, which `coversPlan` would read as full coverage.
 */
export function isAutonomousMissionType(type: MissionType): boolean {
  return type !== 'manual_task';
}

/** The capabilities a mission of this type needs, before its plan is consulted. */
const BY_MISSION_TYPE: Readonly<Record<MissionType, readonly CapabilityClass[]>> = {
  code_change: ['code.change'],
  bug_fix: ['bug.diagnose', 'code.change'],
  test_improvement: ['test.add'],
  documentation: ['docs.write'],
  /* Maintenance covers both ordinary edits and dependency bumps, so it asks for both. */
  repository_maintenance: ['code.change', 'dependency.update'],
  investigation: ['bug.diagnose'],
  project_review: ['repository.audit'],
  research_report: ['research.read'],
  planning_only: ['research.read'],
  manual_task: [],
};

/**
 * Everything this mission would need, as a set.
 *
 * A writing mission also needs to create a branch and open a pull request, because that is how
 * every mission delivers — the branch and the draft pull request are not an optional extra the
 * plan might skip. They are added here rather than folded into the per-type list so that the
 * reason they are present stays visible.
 */
export function missionCapabilityClasses(input: {
  readonly type: MissionType;
  readonly plan: MissionPlanContent | null;
}): readonly CapabilityClass[] {
  const classes = new Set<CapabilityClass>(BY_MISSION_TYPE[input.type]);

  if (!isReadOnlyMissionType(input.type)) {
    classes.add('branch.create');
    classes.add('pull_request.open');
  }

  /*
   * A plan that says it will add tests is asking to add tests, whatever the mission is called. The
   * mission type is what the owner asked for; the plan is what Jarvis intends to do, and the second
   * is the one that has to be authorised.
   */
  if (
    input.plan &&
    input.plan.testsToAddOrUpdate.length > 0 &&
    !isReadOnlyMissionType(input.type)
  ) {
    classes.add('test.add');
  }
  if (input.plan && input.plan.dataMigrations.length > 0) {
    classes.add('code.change');
  }

  return [...classes];
}

/**
 * The capability requests to put to the authorisation service.
 *
 * Every request names the project, the repository and the branch, because a scoped capability with
 * nothing named is refused under R-AU4 before the charter is consulted at all — "this plan does not
 * say which project it means" is a gap in the request, and no grant may fill it in.
 *
 * `reason` is carried for the record and is never parsed. It exists so a person reading a refusal
 * can see what the mission thought it was doing, not so anything can be argued into a yes.
 */
export function missionCapabilityRequests(input: {
  readonly type: MissionType;
  readonly plan: MissionPlanContent | null;
  readonly projectId: string | null;
  readonly repository: string | null;
  readonly branch: string | null;
  readonly reason: string;
}): readonly CapabilityRequest[] {
  return missionCapabilityClasses({ type: input.type, plan: input.plan }).map((capability) => ({
    capability,
    projectId: input.projectId,
    repository: input.repository,
    branch: input.branch,
    environment: null,
    releaseChannel: null,
    connectorId: null,
    reason: input.reason,
  }));
}

export interface CoverageGap {
  readonly missing: readonly CapabilityClass[];
  readonly reason: string;
  /**
   * Whether granting the missing capabilities would fix it.
   *
   * False for a mission type standing authority may not run at all: no charter grants the ability
   * to do something only a person can do, and telling the owner to add one would send them looking
   * for a setting that does not exist.
   */
  readonly ownerCanGrant: boolean;
}

/**
 * Whether an authorisation decision actually covers what this mission will do.
 *
 * Called at the approval boundary, against the decision's *recorded* request rather than against
 * whatever the caller says it asked for. A decision authorising `project.status.update` does not
 * become an authorisation to change code because somebody passed its id to a mission that does.
 *
 * Returns the gap rather than a boolean, because the owner's next question is "what would I have
 * to grant?" and answering it one capability per attempt is a bad way to spend an afternoon.
 */
export function coversPlan(input: {
  readonly authorised: readonly CapabilityClass[];
  readonly type: MissionType;
  readonly plan: MissionPlanContent | null;
}): CoverageGap | null {
  if (!isAutonomousMissionType(input.type)) {
    return {
      missing: [],
      reason:
        'This is work for a person, so standing authority cannot run it however the charter is written.',
      ownerCanGrant: false,
    };
  }

  const needed = missionCapabilityClasses({ type: input.type, plan: input.plan });
  const granted = new Set(input.authorised);
  const missing = needed.filter((capability) => !granted.has(capability));
  if (missing.length === 0) return null;
  return {
    missing,
    ownerCanGrant: true,
    reason:
      missing.length === 1
        ? `That authorisation does not cover "${missing[0]}", which this mission needs.`
        : `That authorisation does not cover ${missing.map((entry) => `"${entry}"`).join(', ')}, which this mission needs.`,
  };
}
