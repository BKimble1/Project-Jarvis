import { createHash } from 'node:crypto';
import { assessFreshness, formatAge, isUntrustworthy } from '@/domain/freshness';
import { claim, type Claim, type Evidence } from '@/domain/evidence';
import type { ProjectAggregate, ProjectSource } from '@/domain/project';
import type { ProjectStatus, ProvenanceLevel } from '@/domain/enums';
import type {
  AttentionReason,
  FreshnessAssessment,
  ProjectAssessment,
  RecommendedAction,
} from '@/domain/status';
import { FAILING_CONCLUSIONS, STATUS_WINDOWS } from './constants';

/**
 * Layer 1 of the Status Brain: a pure, deterministic status engine.
 *
 * Every conclusion below is produced by a named rule (`R-*`) that is individually unit-tested.
 * Nothing here calls a network, a database or a language model, and nothing here invents a
 * completion percentage or a health score — Jarvis reports what the evidence supports and
 * labels everything else Unknown.
 */

export interface AssessmentInput {
  readonly aggregate: ProjectAggregate;
  readonly evidence: readonly Evidence[];
  readonly now: Date;
}

const DAY_MS = 86_400_000;

const withinDays = (iso: string, now: Date, days: number): boolean =>
  now.getTime() - new Date(iso).getTime() <= days * DAY_MS;

const byObservedDesc = (a: Evidence, b: Evidence) =>
  new Date(b.observedAt).getTime() - new Date(a.observedAt).getTime();

/* ------------------------------------------------------------------ helpers */

export interface WorkflowState {
  readonly name: string;
  readonly conclusion: string | null;
  readonly status: string;
  readonly observedAt: string;
  readonly evidenceId: string;
  readonly url: string | null;
  readonly onDefaultBranch: boolean;
}

/**
 * R-WF1 — Reduce the workflow-run history to the latest run per workflow name.
 * A workflow that failed and later succeeded is *not* a failing build.
 */
export function latestWorkflowStates(evidence: readonly Evidence[]): readonly WorkflowState[] {
  const byName = new Map<string, WorkflowState>();
  for (const item of [...evidence].sort(byObservedDesc)) {
    if (item.kind !== 'workflow_run') continue;
    const name =
      typeof item.metadata.workflowName === 'string' ? item.metadata.workflowName : item.title;
    if (byName.has(name)) continue;
    byName.set(name, {
      name,
      conclusion: typeof item.metadata.conclusion === 'string' ? item.metadata.conclusion : null,
      status: typeof item.metadata.status === 'string' ? item.metadata.status : 'unknown',
      observedAt: item.observedAt,
      evidenceId: item.id,
      url: item.url,
      onDefaultBranch: item.metadata.isDefaultBranch === true,
    });
  }
  return [...byName.values()];
}

/** R-WF2 — A build is "failing" only if the newest run for that workflow failed, recently. */
export function failingWorkflows(
  evidence: readonly Evidence[],
  now: Date,
): readonly WorkflowState[] {
  return latestWorkflowStates(evidence).filter(
    (state) =>
      state.conclusion !== null &&
      FAILING_CONCLUSIONS.has(state.conclusion) &&
      withinDays(state.observedAt, now, STATUS_WINDOWS.failedWorkflowDays),
  );
}

/** R-PR1 — Merged pull requests inside the recent window are verified completed work. */
export function recentlyMergedPullRequests(
  evidence: readonly Evidence[],
  now: Date,
): readonly Evidence[] {
  return evidence
    .filter(
      (item) =>
        item.kind === 'pull_request' &&
        item.metadata.merged === true &&
        withinDays(item.observedAt, now, STATUS_WINDOWS.recentlyCompletedDays),
    )
    .sort(byObservedDesc);
}

/**
 * R-PR2 — An open pull request only evidences *active* work while it is still moving.
 * A draft or long-untouched PR is reported as an open thread, not as work in progress.
 */
export function activeOpenPullRequests(
  evidence: readonly Evidence[],
  now: Date,
): readonly Evidence[] {
  return evidence
    .filter(
      (item) =>
        item.kind === 'pull_request' &&
        item.metadata.state === 'open' &&
        item.metadata.draft !== true &&
        withinDays(item.observedAt, now, STATUS_WINDOWS.openPrActiveDays),
    )
    .sort(byObservedDesc);
}

export function staleOpenPullRequests(
  evidence: readonly Evidence[],
  now: Date,
): readonly Evidence[] {
  return evidence
    .filter(
      (item) =>
        item.kind === 'pull_request' &&
        item.metadata.state === 'open' &&
        !withinDays(item.observedAt, now, STATUS_WINDOWS.openPrActiveDays),
    )
    .sort(byObservedDesc);
}

export function recentCommits(evidence: readonly Evidence[], now: Date): readonly Evidence[] {
  return evidence
    .filter(
      (item) =>
        item.kind === 'git_commit' &&
        withinDays(item.observedAt, now, STATUS_WINDOWS.activeCommitDays),
    )
    .sort(byObservedDesc);
}

export function recentReleases(evidence: readonly Evidence[], now: Date): readonly Evidence[] {
  return evidence
    .filter(
      (item) =>
        item.kind === 'release' &&
        item.metadata.draft !== true &&
        withinDays(item.observedAt, now, STATUS_WINDOWS.recentlyCompletedDays),
    )
    .sort(byObservedDesc);
}

/* ---------------------------------------------------------------- freshness */

export function computeFreshness(input: AssessmentInput): FreshnessAssessment {
  const { aggregate, evidence, now } = input;
  const { project, sources } = aggregate;

  /*
   * R-FR1 — a source is failing when its own most recent *attempt* failed. Comparing a failure
   * against a project-wide observation time would let a healthy source (or a manual edit) mask a
   * broken one, so the comparison is made per source against that same source's last success.
   */
  const failingSources = sources.filter((source) => {
    if (!source.lastSyncFailedAt) return false;
    const failedAt = new Date(source.lastSyncFailedAt).getTime();
    if (Number.isNaN(failedAt)) return false;
    const okAt = source.lastSyncOkAt
      ? new Date(source.lastSyncOkAt).getTime()
      : Number.NEGATIVE_INFINITY;
    return failedAt > okAt;
  });
  const failingSourceIds = new Set(failingSources.map((source) => source.id));

  const observedCandidates: number[] = [];
  for (const item of evidence) {
    /* Evidence from a failing source cannot vouch for how current the picture is. */
    if (item.sourceId !== null && failingSourceIds.has(item.sourceId)) continue;
    const time = new Date(item.fetchedAt).getTime();
    if (!Number.isNaN(time)) observedCandidates.push(time);
  }
  for (const source of sources) {
    if (!source.lastSyncOkAt) continue;
    const time = new Date(source.lastSyncOkAt).getTime();
    if (!Number.isNaN(time)) observedCandidates.push(time);
  }
  /* A manual edit only counts as an observation on a project Jarvis is not otherwise watching. */
  if (project.lastManualUpdateAt && failingSources.length === 0) {
    const time = new Date(project.lastManualUpdateAt).getTime();
    if (!Number.isNaN(time)) observedCandidates.push(time);
  }

  const lastObservedAt =
    observedCandidates.length > 0 ? new Date(Math.max(...observedCandidates)).toISOString() : null;

  const worst = [...failingSources].sort(
    (a, b) =>
      new Date(b.lastSyncFailedAt ?? 0).getTime() - new Date(a.lastSyncFailedAt ?? 0).getTime(),
  )[0];

  return assessFreshness({
    type: project.type,
    lastObservedAt,
    lastSyncFailedAt: worst?.lastSyncFailedAt ?? null,
    lastSyncError: worst?.lastSyncError ?? null,
    hasSources: sources.some((source) => source.kind !== 'manual'),
    syncFailing: failingSources.length > 0,
    now,
  });
}

/* ------------------------------------------------------------------- status */

export interface DerivedStatus {
  readonly status: ProjectStatus;
  readonly provenance: ProvenanceLevel;
  readonly rule: string;
}

/**
 * R-ST1..R-ST4 — Derive the status Jarvis will display.
 *
 * The owner's explicit choice always wins for the terminal states (completed, paused, archived):
 * Jarvis must never describe a paused project as progressing, and must never quietly "un-pause"
 * a project because a stray commit arrived. Only `active`, `waiting` and `unknown` are refined
 * by evidence, and any refinement is labelled `inferred`.
 */
export function deriveStatus(input: AssessmentInput): DerivedStatus {
  const { aggregate } = input;
  const { project, sources, blockers } = aggregate;

  if (project.archivedAt) {
    return { status: 'archived', provenance: 'manual', rule: 'R-ST1-archived-project' };
  }
  const archivedRepo = sources.some((source) => source.github?.archived === true);
  if (archivedRepo && project.status !== 'completed') {
    return { status: 'archived', provenance: 'verified', rule: 'R-ST2-archived-repository' };
  }
  if (
    project.status === 'completed' ||
    project.status === 'paused' ||
    project.status === 'archived'
  ) {
    return {
      status: project.status,
      provenance: 'manual',
      rule: 'R-ST3-owner-declared-terminal-state',
    };
  }
  const activeBlockers = blockers.filter((blocker) => blocker.isActive);
  if (activeBlockers.length > 0 && project.status !== 'blocked') {
    return {
      status: 'blocked',
      provenance: 'inferred',
      rule: 'R-ST4-active-blocker-implies-blocked',
    };
  }
  if (project.status === 'unknown') {
    return { status: 'unknown', provenance: 'unknown', rule: 'R-ST5-no-status-recorded' };
  }
  return { status: project.status, provenance: 'manual', rule: 'R-ST6-owner-declared-status' };
}

/* ---------------------------------------------------------------- attention */

export function attentionReasons(
  input: AssessmentInput,
  freshness: FreshnessAssessment,
): readonly AttentionReason[] {
  const { aggregate, evidence, now } = input;
  const { project, blockers, nextActions, sources } = aggregate;
  const reasons: AttentionReason[] = [];

  /* R-AT1 — a blocker that needs the owner's decision is the highest-priority signal. */
  for (const blocker of blockers) {
    if (!blocker.isActive) continue;
    if (blocker.requiresOwnerDecision) {
      reasons.push({
        code: 'decision_required',
        severity: 'critical',
        summary: `Decision needed: ${blocker.title}`,
        provenance: 'manual',
        evidenceIds: blocker.evidenceIds,
        rule: 'R-AT1-blocker-requires-owner-decision',
      });
    } else {
      reasons.push({
        code: 'active_blocker',
        severity: blocker.severity === 'critical' ? 'critical' : blocker.severity,
        summary: `Blocked: ${blocker.title}`,
        provenance: 'manual',
        evidenceIds: blocker.evidenceIds,
        rule: 'R-AT2-active-blocker',
      });
    }
  }

  /* R-AT3 — a recently failed build is verified evidence that something needs fixing. */
  for (const workflow of failingWorkflows(evidence, now)) {
    reasons.push({
      code: 'failed_workflow',
      severity: workflow.onDefaultBranch ? 'high' : 'medium',
      summary: `${workflow.name} failed ${formatAge(hoursSince(workflow.observedAt, now))} ago`,
      provenance: 'verified',
      evidenceIds: [workflow.evidenceId],
      rule: 'R-AT3-recent-failed-workflow',
    });
  }

  /* R-AT4 — a failed synchronisation is an operational warning about Jarvis, not the project. */
  for (const source of sources) {
    if (source.syncStatus !== 'failed') continue;
    reasons.push({
      code: 'failed_sync',
      severity: 'medium',
      summary: `Could not synchronise ${describeSource(source)}. The information below may be out of date.`,
      provenance: 'verified',
      evidenceIds: [],
      rule: 'R-AT4-source-sync-failed',
    });
  }

  /* R-AT5 — stale evidence on a project the owner still considers active. */
  if (
    (freshness.state === 'stale' || freshness.state === 'never') &&
    project.status !== 'completed' &&
    project.status !== 'paused' &&
    project.status !== 'archived' &&
    !project.archivedAt
  ) {
    reasons.push({
      code: 'stale_data',
      severity: 'low',
      summary:
        freshness.state === 'never'
          ? 'Nothing has been recorded for this project yet.'
          : `No new evidence for ${formatAge(freshness.ageHours)}.`,
      provenance: 'verified',
      evidenceIds: [],
      rule: 'R-AT5-stale-project',
    });
  }

  /* R-AT6 — overdue next actions the owner has to do personally. */
  const today = now.toISOString().slice(0, 10);
  for (const action of nextActions) {
    if (action.status === 'done' || action.status === 'dropped') continue;
    if (!action.dueDate || action.dueDate >= today) continue;
    reasons.push({
      code: 'overdue_action',
      severity: action.priority === 'critical' ? 'high' : 'medium',
      summary: `Overdue since ${action.dueDate}: ${action.action}`,
      provenance: 'manual',
      evidenceIds: [],
      rule: 'R-AT6-overdue-next-action',
    });
  }

  /* R-AT7 — a target date that has passed on a project that is not finished. */
  if (
    project.targetDate &&
    project.targetDate < today &&
    project.status !== 'completed' &&
    project.status !== 'archived' &&
    !project.archivedAt
  ) {
    reasons.push({
      code: 'overdue_target_date',
      severity: 'medium',
      summary: `Target date ${project.targetDate} has passed and the project is not marked complete.`,
      provenance: 'manual',
      evidenceIds: [],
      rule: 'R-AT7-target-date-passed',
    });
  }

  /* R-AT8 — an archived repository behind a project the owner still treats as live. */
  for (const source of sources) {
    if (source.github?.archived !== true) continue;
    if (project.status === 'completed' || project.status === 'archived' || project.archivedAt)
      continue;
    reasons.push({
      code: 'archived_repository',
      severity: 'low',
      summary: `${describeSource(source)} is archived on GitHub, but this project is not marked complete.`,
      provenance: 'verified',
      evidenceIds: [],
      rule: 'R-AT8-archived-repository',
    });
  }

  return reasons;
}

function describeSource(source: ProjectSource): string {
  if (source.github) return `${source.github.owner}/${source.github.repo}`;
  return source.label ?? 'this source';
}

function hoursSince(iso: string, now: Date): number {
  return Math.max(0, (now.getTime() - new Date(iso).getTime()) / 3_600_000);
}

/* --------------------------------------------------------- recommendations */

/**
 * R-RC1..R-RC7 — Recommended actions.
 *
 * Recommendations are derived only from evidence that is actually present. A completed or
 * archived project never receives ordinary development suggestions (R-RC6/R-RC7).
 */
export function recommendActions(
  input: AssessmentInput,
  derived: DerivedStatus,
  freshness: FreshnessAssessment,
  reasons: readonly AttentionReason[],
): readonly RecommendedAction[] {
  const { aggregate, evidence, now } = input;
  const { project, blockers, nextActions, goals } = aggregate;
  const actions: RecommendedAction[] = [];

  if (derived.status === 'archived') {
    actions.push({
      action: 'Confirm this project is finished, or restore it if work is resuming.',
      rationale: 'The project or its repository is archived.',
      provenance: derived.provenance,
      evidenceIds: [],
      requiresOwner: true,
      rule: 'R-RC7-archived-no-development-advice',
    });
    return actions;
  }

  if (derived.status === 'completed') {
    const openActions = nextActions.filter(
      (action) => action.status === 'open' || action.status === 'in_progress',
    );
    if (openActions.length > 0) {
      actions.push({
        action: `Close out ${openActions.length} remaining action${openActions.length === 1 ? '' : 's'} or archive the project.`,
        rationale: 'The project is marked complete but still has open actions.',
        provenance: 'manual',
        evidenceIds: [],
        requiresOwner: true,
        rule: 'R-RC6-completed-project-wrap-up-only',
      });
    } else {
      actions.push({
        action: 'Archive this project to keep the portfolio focused.',
        rationale: 'The project is complete with nothing outstanding.',
        provenance: 'manual',
        evidenceIds: [],
        requiresOwner: true,
        rule: 'R-RC6-completed-project-wrap-up-only',
      });
    }
    return actions;
  }

  /* Decisions first — nothing else can move while the owner is the bottleneck. */
  for (const blocker of blockers.filter((item) => item.isActive && item.requiresOwnerDecision)) {
    actions.push({
      action: `Decide: ${blocker.title}`,
      rationale: blocker.resolutionRequirement ?? 'This blocker is waiting on your decision.',
      provenance: 'manual',
      evidenceIds: blocker.evidenceIds,
      requiresOwner: true,
      rule: 'R-RC1-decision-blocker-first',
    });
  }

  for (const workflow of failingWorkflows(evidence, now)) {
    actions.push({
      action: `Fix the failing ${workflow.name} workflow.`,
      rationale: `The most recent ${workflow.name} run concluded "${workflow.conclusion}".`,
      provenance: 'verified',
      evidenceIds: [workflow.evidenceId],
      requiresOwner: false,
      rule: 'R-RC2-fix-failing-build',
    });
  }

  for (const blocker of blockers
    .filter((item) => item.isActive && !item.requiresOwnerDecision)
    .slice(0, 2)) {
    actions.push({
      action: `Clear the blocker: ${blocker.title}`,
      rationale: blocker.resolutionRequirement ?? 'This blocker is still open.',
      provenance: 'manual',
      evidenceIds: blocker.evidenceIds,
      requiresOwner: false,
      rule: 'R-RC3-clear-active-blocker',
    });
  }

  /* The owner's own list outranks anything Jarvis would invent. */
  for (const action of nextActions
    .filter((item) => item.status === 'open' || item.status === 'in_progress')
    .slice(0, 3)) {
    actions.push({
      action: action.action,
      rationale: action.dueDate
        ? `You planned this for ${action.dueDate}.`
        : 'On your next-action list.',
      provenance: 'manual',
      evidenceIds: [],
      requiresOwner: action.requiresOwner,
      rule: 'R-RC4-owner-next-action',
    });
  }

  const stalePrs = staleOpenPullRequests(evidence, now);
  if (stalePrs.length > 0) {
    const first = stalePrs[0];
    actions.push({
      action:
        stalePrs.length === 1
          ? `Review or close the stalled pull request ${first?.title ?? ''}`.trim()
          : `Review ${stalePrs.length} stalled pull requests.`,
      rationale: `Open for more than ${STATUS_WINDOWS.openPrActiveDays} days with no update.`,
      provenance: 'verified',
      evidenceIds: stalePrs.slice(0, 5).map((item) => item.id),
      requiresOwner: false,
      rule: 'R-RC5-stalled-pull-requests',
    });
  }

  if (reasons.some((reason) => reason.code === 'failed_sync')) {
    actions.push({
      action: 'Re-run synchronisation and check the GitHub credential.',
      rationale:
        'The most recent synchronisation failed, so the information here may be out of date.',
      provenance: 'verified',
      evidenceIds: [],
      requiresOwner: true,
      rule: 'R-RC8-recover-sync',
    });
  }

  if (isUntrustworthy(freshness.state) && freshness.state !== 'failing' && actions.length < 3) {
    actions.push({
      action:
        project.type === 'software' || project.type === 'ios_app' || project.type === 'website'
          ? 'Synchronise this project, or record what is actually happening.'
          : 'Record a short update so Jarvis knows where this stands.',
      rationale: freshness.explanation,
      provenance: 'verified',
      evidenceIds: [],
      requiresOwner: true,
      rule: 'R-RC9-stale-needs-update',
    });
  }

  if (actions.length === 0 && goals.length === 0 && !project.goal) {
    actions.push({
      action: 'Write down the goal for this project.',
      rationale: 'Jarvis has no recorded goal, so it cannot judge progress.',
      provenance: 'unknown',
      evidenceIds: [],
      requiresOwner: true,
      rule: 'R-RC10-missing-goal',
    });
  }

  return actions.slice(0, 6);
}

/* --------------------------------------------------------------- assessment */

export function assessProject(input: AssessmentInput): ProjectAssessment {
  const { aggregate, evidence, now } = input;
  const { project, blockers, milestones, updates } = aggregate;

  const freshness = computeFreshness(input);
  const derived = deriveStatus(input);
  const reasons = attentionReasons(input, freshness);
  const recommended = recommendActions(input, derived, freshness, reasons);

  const merged = recentlyMergedPullRequests(evidence, now);
  const releases = recentReleases(evidence, now);
  const commits = recentCommits(evidence, now);
  const activePrs = activeOpenPullRequests(evidence, now);

  /* ------------------------------------------------ recently completed work */
  const recentlyCompleted: Claim[] = [];
  for (const pr of merged.slice(0, 5)) {
    recentlyCompleted.push(
      claim(`Merged ${pr.title}`, 'verified', [pr.id], 'R-PR1-merged-pr-is-completed-work'),
    );
  }
  for (const release of releases.slice(0, 3)) {
    recentlyCompleted.push(
      claim(
        `Released ${release.title}`,
        'verified',
        [release.id],
        'R-RL1-release-is-completed-work',
      ),
    );
  }
  /* R-MS1 — a milestone the owner ticked stays Manual until another source verifies it. */
  for (const milestone of milestones) {
    if (milestone.state !== 'done' || !milestone.completedAt) continue;
    if (!withinDays(milestone.completedAt, now, STATUS_WINDOWS.recentlyCompletedDays)) continue;
    recentlyCompleted.push(
      claim(
        `Milestone completed: ${milestone.title}`,
        milestone.evidenceIds.length > 0 ? 'verified' : 'manual',
        milestone.evidenceIds,
        'R-MS1-manual-milestone-stays-manual',
      ),
    );
  }
  for (const update of updates.slice(0, 3)) {
    if (!withinDays(update.createdAt, now, STATUS_WINDOWS.recentlyCompletedDays)) continue;
    recentlyCompleted.push(
      claim(update.whatChanged, 'manual', [], 'R-MU1-manual-update-is-manual'),
    );
  }

  /* ------------------------------------------------------------ current work */
  const currentWork: Claim[] = [];
  if (derived.status === 'paused') {
    /* R-ST3 — a paused project is never described as progressing. */
    currentWork.push(
      claim(
        'Paused — no work is expected until you resume it.',
        'manual',
        [],
        'R-CW0-paused-not-progressing',
      ),
    );
  } else {
    for (const pr of activePrs.slice(0, 4)) {
      currentWork.push(
        claim(`Open pull request ${pr.title}`, 'verified', [pr.id], 'R-PR2-active-open-pr'),
      );
    }
    if (commits.length > 0) {
      const latest = commits[0];
      currentWork.push(
        claim(
          `${commits.length} commit${commits.length === 1 ? '' : 's'} in the last ${STATUS_WINDOWS.activeCommitDays} days, most recently "${latest?.title ?? ''}"`,
          'verified',
          commits.slice(0, 5).map((item) => item.id),
          'R-CW1-recent-commits',
        ),
      );
    }
    for (const milestone of milestones.filter((item) => item.state === 'in_progress').slice(0, 3)) {
      currentWork.push(
        claim(
          `Working on milestone: ${milestone.title}`,
          'manual',
          milestone.evidenceIds,
          'R-CW2-in-progress-milestone',
        ),
      );
    }
    const latestUpdate = updates[0];
    if (
      latestUpdate?.currentWork &&
      withinDays(latestUpdate.createdAt, now, STATUS_WINDOWS.recentlyCompletedDays)
    ) {
      currentWork.push(
        claim(latestUpdate.currentWork, 'manual', [], 'R-CW3-owner-reported-current-work'),
      );
    }
  }

  /* ----------------------------------------------------------------- blockers */
  const blockerClaims: Claim[] = blockers
    .filter((blocker) => blocker.isActive)
    .map((blocker) =>
      claim(
        blocker.description ? `${blocker.title} — ${blocker.description}` : blocker.title,
        'manual',
        blocker.evidenceIds,
        'R-BL1-active-blocker',
      ),
    );
  for (const workflow of failingWorkflows(evidence, now)) {
    blockerClaims.push(
      claim(
        `${workflow.name} is failing on GitHub Actions.`,
        'verified',
        [workflow.evidenceId],
        'R-BL2-failing-workflow-as-blocker',
      ),
    );
  }

  /* -------------------------------------------------------- decisions needed */
  const decisionsNeeded: Claim[] = blockers
    .filter((blocker) => blocker.isActive && blocker.requiresOwnerDecision)
    .map((blocker) =>
      claim(
        blocker.resolutionRequirement
          ? `${blocker.title} — ${blocker.resolutionRequirement}`
          : blocker.title,
        'manual',
        blocker.evidenceIds,
        'R-DC1-decision-blocker',
      ),
    );

  /* ----------------------------------------------------------------- unknowns */
  const unknowns = collectUnknowns(input, freshness, derived);

  /* ----------------------------------------------------------------- headline */
  const headline = buildHeadline({
    project,
    derived,
    freshness,
    blockerCount: blockerClaims.length,
    completedCount: recentlyCompleted.length,
    currentWorkCount: currentWork.length,
  });

  const keyEvidenceIds = [
    ...new Set(
      [
        ...recentlyCompleted.flatMap((item) => item.evidenceIds),
        ...currentWork.flatMap((item) => item.evidenceIds),
        ...blockerClaims.flatMap((item) => item.evidenceIds),
        ...recommended.flatMap((item) => item.evidenceIds),
      ].filter(Boolean),
    ),
  ];

  const needsAttention = reasons.length > 0;

  const assessment: Omit<ProjectAssessment, 'evidenceFingerprint'> = {
    projectId: project.id,
    generatedAt: now.toISOString(),
    status: derived.status,
    statusProvenance: derived.provenance,
    phase: project.phase,
    phaseProvenance: project.phase ? 'manual' : 'unknown',
    headline,
    recentlyCompleted,
    currentWork,
    activeBlockers: blockerClaims,
    decisionsNeeded,
    recommendedActions: recommended,
    attention: reasons,
    needsAttention,
    freshness,
    unknowns,
    keyEvidenceIds,
  };

  return { ...assessment, evidenceFingerprint: fingerprint(assessment) };
}

function buildHeadline(input: {
  project: ProjectAggregate['project'];
  derived: DerivedStatus;
  freshness: FreshnessAssessment;
  blockerCount: number;
  completedCount: number;
  currentWorkCount: number;
}): Claim {
  const { project, derived, freshness, blockerCount, completedCount, currentWorkCount } = input;
  const name = project.shortName ?? project.name;

  if (derived.status === 'archived') {
    return claim(`${name} is archived.`, derived.provenance, [], 'R-HL1-archived');
  }
  if (derived.status === 'completed') {
    return claim(`${name} is complete.`, 'manual', [], 'R-HL2-completed');
  }
  if (derived.status === 'paused') {
    return claim(`${name} is paused; no work is expected right now.`, 'manual', [], 'R-HL3-paused');
  }
  if (blockerCount > 0) {
    return claim(
      `${name} is blocked by ${blockerCount} open item${blockerCount === 1 ? '' : 's'}.`,
      'inferred',
      [],
      'R-HL4-blocked',
    );
  }
  if (freshness.state === 'failing') {
    return claim(
      `${name}: synchronisation is failing, so this is the last information Jarvis could verify.`,
      'verified',
      [],
      'R-HL5-sync-failing',
    );
  }
  if (freshness.state === 'never') {
    return claim(
      `${name} has no recorded evidence yet, so its current state is unknown.`,
      'unknown',
      [],
      'R-HL6-no-evidence',
    );
  }
  if (freshness.state === 'stale') {
    return claim(
      `${name} has had no new evidence for ${formatAge(freshness.ageHours)}; its current state is unknown.`,
      'unknown',
      [],
      'R-HL7-stale',
    );
  }
  /* A waiting project is waiting even when work is visible, so this is checked before progress. */
  if (derived.status === 'waiting') {
    return claim(`${name} is waiting on something external.`, 'manual', [], 'R-HL10-waiting');
  }
  if (currentWorkCount > 0) {
    return claim(`${name} is progressing normally.`, 'inferred', [], 'R-HL8-progressing');
  }
  if (completedCount > 0) {
    return claim(
      `${name} shipped work recently but has nothing obviously in flight.`,
      'inferred',
      [],
      'R-HL9-recent-completion-no-current-work',
    );
  }
  return claim(
    `${name} is active, but Jarvis has no evidence of work in progress.`,
    'unknown',
    [],
    'R-HL11-active-without-evidence',
  );
}

/** R-UK1..R-UK5 — Everything Jarvis explicitly does not know. */
function collectUnknowns(
  input: AssessmentInput,
  freshness: FreshnessAssessment,
  derived: DerivedStatus,
): readonly string[] {
  const { aggregate, evidence } = input;
  const { project, sources, goals } = aggregate;
  const unknowns: string[] = [];

  if (!project.goal && goals.length === 0) {
    unknowns.push(
      'No goal has been recorded, so Jarvis cannot judge whether the project is on track.',
    );
  }
  if (!project.phase) {
    unknowns.push('No phase has been recorded.');
  }
  if (derived.status === 'unknown') {
    unknowns.push('The project status has not been set and no evidence implies one.');
  }
  if (freshness.state === 'failing') {
    unknowns.push(
      `Anything that happened since the last successful synchronisation is unknown${freshness.lastError ? ` (${freshness.lastError})` : ''}.`,
    );
  }
  if (freshness.state === 'stale') {
    unknowns.push('Whether work has continued since the last observed evidence is unknown.');
  }
  const partial = sources.filter((source) => source.unavailableCapabilities.length > 0);
  for (const source of partial) {
    unknowns.push(
      `Jarvis could not read ${source.unavailableCapabilities.join(', ')} for ${describeSource(source)}.`,
    );
  }
  if (
    sources.some((source) => source.kind === 'github_repo') &&
    !evidence.some((item) => item.kind === 'workflow_run')
  ) {
    unknowns.push('No GitHub Actions runs were found, so build health is unknown.');
  }
  if (evidence.length === 0 && sources.some((source) => source.kind === 'github_repo')) {
    unknowns.push('No repository activity has been observed yet.');
  }
  return unknowns;
}

/**
 * A stable fingerprint of everything the owner would consider meaningful.
 *
 * Generated timestamps are deliberately excluded so that regenerating a briefing with unchanged
 * evidence produces the same fingerprint — that is what lets Jarvis skip a model call and what
 * lets "What changed" ignore noise.
 */
export function fingerprint(assessment: Omit<ProjectAssessment, 'evidenceFingerprint'>): string {
  const material = {
    status: assessment.status,
    phase: assessment.phase,
    headline: assessment.headline.text,
    recentlyCompleted: assessment.recentlyCompleted.map((item) => item.text),
    currentWork: assessment.currentWork.map((item) => item.text),
    blockers: assessment.activeBlockers.map((item) => item.text),
    decisions: assessment.decisionsNeeded.map((item) => item.text),
    actions: assessment.recommendedActions.map((item) => item.action),
    attention: assessment.attention.map((item) => `${item.code}:${item.summary}`),
    freshness: assessment.freshness.state,
    unknowns: assessment.unknowns,
  };
  return createHash('sha256').update(JSON.stringify(material)).digest('hex').slice(0, 32);
}
