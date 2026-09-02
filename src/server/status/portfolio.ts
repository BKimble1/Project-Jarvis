import type { Evidence } from '@/domain/evidence';
import type { Project } from '@/domain/project';
import type {
  AttentionReason,
  FocusEntry,
  PortfolioAssessment,
  PortfolioChange,
  PortfolioCounts,
  ProjectAssessment,
} from '@/domain/status';
import { STATUS_WINDOWS } from './constants';

/**
 * Portfolio-level assessment.
 *
 * This is pure aggregation over per-project assessments: no new inference happens here, so a
 * claim can never appear at portfolio level without existing at project level first.
 */

const SEVERITY_RANK: Record<AttentionReason['severity'], number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

const PRIORITY_RANK: Record<Project['priority'], number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

export interface PortfolioInput {
  readonly projects: readonly Project[];
  readonly assessments: ReadonlyMap<string, ProjectAssessment>;
  readonly recentEvidence: readonly Evidence[];
  readonly now: Date;
}

export function assessPortfolio(input: PortfolioInput): PortfolioAssessment {
  const { projects, assessments, now } = input;
  const live = projects.filter((project) => !project.archivedAt);

  const needsAttentionIds: string[] = [];
  const blockedIds: string[] = [];
  const waitingIds: string[] = [];
  const pausedIds: string[] = [];
  const staleIds: string[] = [];
  const progressingIds: string[] = [];
  const decisionsNeeded: AttentionReason[] = [];
  let syncFailing = 0;
  let completed = 0;

  for (const project of live) {
    const assessment = assessments.get(project.id);
    const status = assessment?.status ?? project.status;
    const freshness = assessment?.freshness.state ?? project.freshness;

    if (assessment?.needsAttention ?? project.needsAttention) needsAttentionIds.push(project.id);
    if (status === 'blocked') blockedIds.push(project.id);
    if (status === 'waiting') waitingIds.push(project.id);
    if (status === 'paused') pausedIds.push(project.id);
    if (status === 'completed') completed += 1;
    if (freshness === 'stale' || freshness === 'never') staleIds.push(project.id);
    if (freshness === 'failing') syncFailing += 1;

    if (
      status === 'active' &&
      !(assessment?.needsAttention ?? project.needsAttention) &&
      freshness !== 'stale' &&
      freshness !== 'never' &&
      freshness !== 'failing'
    ) {
      progressingIds.push(project.id);
    }

    for (const reason of assessment?.attention ?? []) {
      if (reason.code === 'decision_required') decisionsNeeded.push(reason);
    }
  }

  const counts: PortfolioCounts = {
    total: projects.length,
    active: live.filter((project) => (assessments.get(project.id)?.status ?? project.status) === 'active').length,
    progressing: progressingIds.length,
    needsAttention: needsAttentionIds.length,
    blocked: blockedIds.length,
    waiting: waitingIds.length,
    paused: pausedIds.length,
    completed,
    stale: staleIds.length,
    archived: projects.length - live.length,
    syncFailing,
  };

  const nameById = new Map(projects.map((project) => [project.id, project.shortName ?? project.name]));

  return {
    generatedAt: now.toISOString(),
    counts,
    progressingProjectIds: progressingIds,
    needsAttentionProjectIds: needsAttentionIds,
    blockedProjectIds: blockedIds,
    waitingProjectIds: waitingIds,
    pausedProjectIds: pausedIds,
    staleProjectIds: staleIds,
    recentChanges: buildRecentChanges(input, nameById),
    decisionsNeeded: [...decisionsNeeded].sort(
      (a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity],
    ),
    focusOrder: buildFocusOrder(live, assessments),
    unknowns: collectPortfolioUnknowns(live, assessments),
  };
}

/**
 * Focus order.
 *
 * Deliberately *not* a score. Projects are ranked by the worst thing true of them — a decision
 * you owe, then a broken build, then a blocker — with the owner's priority breaking ties. The
 * reason for each position is shown so the ordering is auditable rather than magic.
 */
export function buildFocusOrder(
  projects: readonly Project[],
  assessments: ReadonlyMap<string, ProjectAssessment>,
): readonly FocusEntry[] {
  const entries = projects
    .map((project) => {
      const assessment = assessments.get(project.id);
      const worst = [...(assessment?.attention ?? [])].sort(
        (a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity],
      )[0];

      const bucket = (() => {
        if (!worst) return 5;
        switch (worst.code) {
          case 'decision_required':
            return 0;
          case 'failed_workflow':
            return 1;
          case 'active_blocker':
            return 2;
          case 'overdue_action':
          case 'overdue_target_date':
            return 3;
          case 'failed_sync':
          case 'stale_data':
          case 'archived_repository':
            return 4;
          default:
            return 4;
        }
      })();

      const status = assessment?.status ?? project.status;
      /* Terminal states never outrank live work in the focus list. */
      const terminalPenalty = status === 'completed' || status === 'archived' || status === 'paused' ? 10 : 0;

      return {
        project,
        bucket: bucket + terminalPenalty,
        priority: PRIORITY_RANK[project.priority],
        reason: worst?.summary ?? 'Progressing with nothing outstanding.',
        provenance: worst?.provenance ?? assessment?.headline.provenance ?? 'unknown',
      };
    })
    .sort((a, b) => a.bucket - b.bucket || a.priority - b.priority || a.project.name.localeCompare(b.project.name));

  return entries.map((entry, index) => ({
    projectId: entry.project.id,
    projectName: entry.project.shortName ?? entry.project.name,
    reason: entry.reason,
    provenance: entry.provenance,
    rank: index + 1,
  }));
}

function buildRecentChanges(
  input: PortfolioInput,
  nameById: ReadonlyMap<string, string>,
): readonly PortfolioChange[] {
  const cutoff = input.now.getTime() - STATUS_WINDOWS.portfolioChangeDays * 86_400_000;
  const changes: PortfolioChange[] = [];

  for (const item of input.recentEvidence) {
    const observed = new Date(item.observedAt).getTime();
    if (Number.isNaN(observed) || observed < cutoff) continue;
    const projectName = nameById.get(item.projectId);
    if (!projectName) continue;

    const summary = describeEvidenceChange(item);
    if (!summary) continue;

    changes.push({
      projectId: item.projectId,
      projectName,
      summary,
      occurredAt: item.observedAt,
      provenance: item.sourceSystem === 'manual' ? 'manual' : 'verified',
      evidenceIds: [item.id],
    });
  }

  return changes
    .sort((a, b) => new Date(b.occurredAt).getTime() - new Date(a.occurredAt).getTime())
    .slice(0, 20);
}

/** Only genuinely meaningful evidence becomes a portfolio-level "change". */
function describeEvidenceChange(item: Evidence): string | null {
  switch (item.kind) {
    case 'pull_request':
      if (item.metadata.merged === true) return `Merged ${item.title}`;
      if (item.metadata.state === 'open') return `Opened ${item.title}`;
      return null;
    case 'release':
      return `Released ${item.title}`;
    case 'workflow_run': {
      const conclusion = typeof item.metadata.conclusion === 'string' ? item.metadata.conclusion : null;
      if (conclusion === 'failure' || conclusion === 'timed_out') return `Build failed: ${item.title}`;
      return null;
    }
    case 'deployment':
      return `Deployment: ${item.title}`;
    case 'manual_update':
      return item.title;
    default:
      return null;
  }
}

function collectPortfolioUnknowns(
  projects: readonly Project[],
  assessments: ReadonlyMap<string, ProjectAssessment>,
): readonly string[] {
  const unknowns: string[] = [];
  const noAssessment = projects.filter((project) => !assessments.has(project.id));
  if (noAssessment.length > 0) {
    unknowns.push(
      `${noAssessment.length} project${noAssessment.length === 1 ? ' has' : 's have'} not been assessed yet.`,
    );
  }
  const failing = projects.filter((project) => assessments.get(project.id)?.freshness.state === 'failing');
  if (failing.length > 0) {
    unknowns.push(
      `${failing.length} project${failing.length === 1 ? "'s" : "s'"} data could not be refreshed, so recent activity there is unknown.`,
    );
  }
  const noGoal = projects.filter((project) => !project.goal);
  if (noGoal.length > 0) {
    unknowns.push(`${noGoal.length} project${noGoal.length === 1 ? '' : 's'} have no recorded goal.`);
  }
  return unknowns;
}
