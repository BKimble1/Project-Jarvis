import type { Evidence } from '@/domain/evidence';
import type { Project } from '@/domain/project';
import type {
  PortfolioBriefing,
  ProjectAssessment,
  ProjectBriefing,
  StatusChange,
  StatusSnapshot,
} from '@/domain/status';
import { NotFoundError } from '@/domain/errors';
import { assessProject } from '@/server/status/engine';
import { assessPortfolio } from '@/server/status/portfolio';
import { diffSnapshots } from '@/server/status/diff';
import { buildPortfolioNarrative } from '@/server/briefing/deterministic';
import { buildNarrationPayload, type BriefingNarrator } from '@/server/briefing/types';
import type {
  ActivityLogService,
  EvidenceRepository,
  ProjectRepository,
  SnapshotRepository,
} from '@/server/repositories/types';
import type { MissionRepository, WorkerRepository } from '@/server/repositories/mission-types';
import type { TaskRepository } from '@/server/repositories/factory-types';
import { buildMissionSignals } from '@/server/status/missions';
import { deriveWorkerHealth } from '@/domain/worker';
import type { ProjectAssessment as Assessment } from '@/domain/status';

/**
 * The Status Brain's public entry point.
 *
 * Responsibilities:
 *  - run the deterministic engine over stored evidence,
 *  - persist a historical snapshot whenever the meaningful state changes,
 *  - narrate (deterministically, or with AI when configured), and
 *  - reuse the stored narrative when the evidence fingerprint is unchanged, so a briefing is
 *    never re-generated — or re-charged for — without a reason.
 */
export interface BriefingServiceDeps {
  readonly projects: ProjectRepository;
  readonly evidence: EvidenceRepository;
  readonly snapshots: SnapshotRepository;
  readonly activity: ActivityLogService;
  readonly narrator: BriefingNarrator;
  /**
   * Missions and their tasks, folded into every project assessment.
   *
   * Optional, because a briefing of a project with no missions is a complete briefing, and
   * because the unit tests for the deterministic engine construct this service without a mission
   * store. When they are present, what Jarvis is *doing* to a project becomes part of what Jarvis
   * *says* about it — which is the point of §25: a project with three agents working on it should
   * not read as though nothing is happening.
   */
  readonly missions?: MissionRepository;
  readonly tasks?: TaskRepository;
  readonly workers?: WorkerRepository;
  readonly clock?: () => Date;
  /** How much evidence the engine considers. Bounded so a large project stays fast. */
  readonly evidenceWindowDays?: number;
  readonly evidenceLimit?: number;
}

/** How far back "what changed" looks when a project has only ever produced one snapshot. */
const FIRST_VIEW_WINDOW_DAYS = 14;

export class BriefingService {
  private readonly clock: () => Date;

  constructor(private readonly deps: BriefingServiceDeps) {
    this.clock = deps.clock ?? (() => new Date());
  }

  private get windowDays(): number {
    return this.deps.evidenceWindowDays ?? 120;
  }

  private get evidenceLimit(): number {
    return this.deps.evidenceLimit ?? 300;
  }

  async loadEvidence(projectId: string): Promise<readonly Evidence[]> {
    const since = new Date(this.clock().getTime() - this.windowDays * 86_400_000);
    return this.deps.evidence.list({ projectId, since, limit: this.evidenceLimit });
  }

  /** Deterministic assessment only — used by list screens where narration is unnecessary. */
  async assess(projectId: string): Promise<ProjectAssessment> {
    const aggregate = await this.deps.projects.aggregate(projectId);
    if (!aggregate) throw new NotFoundError('Project');
    const evidence = await this.loadEvidence(projectId);
    const assessment = assessProject({ aggregate, evidence, now: this.clock() });
    return this.withMissions(projectId, assessment);
  }

  /**
   * Fold what Jarvis is doing to a project into what Jarvis says about it.
   *
   * Missions are deliberately merged *after* the deterministic engine rather than fed into it.
   * The engine's job is to assess evidence about the project; a mission is Jarvis's own activity,
   * which is a different kind of fact with a different provenance story — it is Verified because
   * Jarvis wrote the row, not because a source reported it. Keeping them separate means the
   * engine's rules stay about evidence, and mission claims keep their own rule ids.
   *
   * A no-op when no mission store is configured, and a no-op when the project has no missions.
   */
  private async withMissions(
    projectId: string,
    assessment: ProjectAssessment,
  ): Promise<ProjectAssessment> {
    if (!this.deps.missions) return assessment;

    const missions = await this.deps.missions.listByProject(projectId, 25);
    const open = missions.filter(
      (mission) => mission.finishedAt === null || mission.state === 'pull_request_ready',
    );
    const recent = missions.filter((mission) => mission.finishedAt !== null);
    const relevant = [...open, ...recent].slice(0, 20);
    if (relevant.length === 0) return assessment;

    const workerHealth = new Map(
      (this.deps.workers ? await this.deps.workers.list() : []).map((worker) => [
        worker.id,
        deriveWorkerHealth(worker, this.clock()),
      ]),
    );

    const tasks = new Map<
      string,
      readonly Awaited<ReturnType<TaskRepository['listByMission']>>[number][]
    >();
    if (this.deps.tasks) {
      for (const mission of relevant) {
        const list = await this.deps.tasks.listByMission(mission.id);
        if (list.length > 0) tasks.set(mission.id, [...list]);
      }
    }

    const signals = buildMissionSignals({
      missions: relevant,
      workers: workerHealth,
      tasks,
      now: this.clock(),
    });

    const merged: Assessment = {
      ...assessment,
      currentWork: [...assessment.currentWork, ...signals.currentWork],
      recentlyCompleted: [...assessment.recentlyCompleted, ...signals.recentlyCompleted],
      decisionsNeeded: [
        ...assessment.decisionsNeeded,
        ...signals.attention.map((reason) => ({
          text: reason.summary,
          provenance: reason.provenance,
          evidenceIds: reason.evidenceIds,
          rule: reason.rule,
        })),
      ],
      attention: [...assessment.attention, ...signals.attention],
      needsAttention: assessment.needsAttention || signals.attention.length > 0,
      unknowns: [...assessment.unknowns, ...signals.unknowns],
    };
    return merged;
  }

  async assessMany(projectIds: readonly string[]): Promise<ReadonlyMap<string, ProjectAssessment>> {
    const result = new Map<string, ProjectAssessment>();
    if (projectIds.length === 0) return result;

    const aggregates = await this.deps.projects.aggregateMany(projectIds);
    const since = new Date(this.clock().getTime() - this.windowDays * 86_400_000);
    const evidence = await this.deps.evidence.list({
      projectIds,
      since,
      limit: Math.min(this.evidenceLimit * Math.max(projectIds.length, 1), 1000),
    });

    const byProject = new Map<string, Evidence[]>();
    for (const item of evidence) {
      const list = byProject.get(item.projectId);
      if (list) list.push(item);
      else byProject.set(item.projectId, [item]);
    }

    const now = this.clock();
    for (const [id, aggregate] of aggregates) {
      result.set(
        id,
        await this.withMissions(
          id,
          assessProject({ aggregate, evidence: byProject.get(id) ?? [], now }),
        ),
      );
    }
    return result;
  }

  /**
   * Full project briefing. Persists a snapshot when the fingerprint changes (or when the owner
   * explicitly regenerates), and refreshes the project's denormalised freshness/attention flags.
   */
  async briefProject(
    projectId: string,
    options: { regenerate?: boolean } = {},
  ): Promise<ProjectBriefing> {
    const aggregate = await this.deps.projects.aggregate(projectId);
    if (!aggregate) throw new NotFoundError('Project');
    const evidence = await this.loadEvidence(projectId);
    const now = this.clock();
    const assessment = await this.withMissions(
      projectId,
      assessProject({ aggregate, evidence, now }),
    );

    await this.deps.projects.setDerivedState(projectId, {
      freshness: assessment.freshness.state,
      needsAttention: assessment.needsAttention,
    });

    const latest = await this.deps.snapshots.latest(projectId);
    const unchanged = latest?.fingerprint === assessment.evidenceFingerprint;

    if (unchanged && !options.regenerate && latest) {
      const cached = extractNarrative(latest);
      if (cached) {
        return {
          assessment,
          narrative: cached,
          method: latest.summaryMethod,
          generatedAt: latest.generatedAt,
          narratorError: null,
        };
      }
    }

    const payload = buildNarrationPayload(aggregate.project, assessment, evidence);
    const narration = await this.deps.narrator.narrateProject(payload);

    await this.deps.snapshots.save({
      projectId,
      generatedAt: assessment.generatedAt,
      status: assessment.status,
      phase: assessment.phase,
      headline: narration.narrative.currentState,
      recentlyCompleted: assessment.recentlyCompleted,
      currentWork: assessment.currentWork,
      blockers: assessment.activeBlockers,
      decisionsNeeded: assessment.decisionsNeeded,
      recommendedActions: assessment.recommendedActions,
      evidenceIds: assessment.keyEvidenceIds,
      freshness: assessment.freshness,
      unknowns: assessment.unknowns,
      summaryMethod: narration.method,
      fingerprint: assessment.evidenceFingerprint,
      narrative: narration.narrative,
    });

    await this.deps.activity.record({
      projectId,
      kind: 'briefing_generated',
      summary: `Briefing generated (${narration.method}).`,
      detail: { method: narration.method, fingerprint: assessment.evidenceFingerprint },
    });

    return {
      assessment,
      narrative: narration.narrative,
      method: narration.method,
      generatedAt: assessment.generatedAt,
      narratorError: narration.error,
    };
  }

  /** Portfolio briefing. Uses per-project deterministic assessments; never invents cross-project facts. */
  async briefPortfolio(options: { includeArchived?: boolean } = {}): Promise<{
    briefing: PortfolioBriefing;
    projects: readonly Project[];
    assessments: ReadonlyMap<string, ProjectAssessment>;
  }> {
    const projects = await this.deps.projects.listAllForAssessment(
      options.includeArchived ?? false,
    );
    const assessments = await this.assessMany(projects.map((project) => project.id));
    const now = this.clock();

    const recentEvidence =
      projects.length === 0
        ? []
        : await this.deps.evidence.list({
            projectIds: projects.map((project) => project.id),
            since: new Date(now.getTime() - 30 * 86_400_000),
            limit: 400,
          });

    const assessment = assessPortfolio({ projects, assessments, recentEvidence, now });
    const payload = {
      assessment,
      projects: projects.map((project) => ({
        id: project.id,
        name: project.shortName ?? project.name,
        status: assessments.get(project.id)?.status ?? project.status,
        headline: assessments.get(project.id)?.headline.text ?? '',
        needsAttention: assessments.get(project.id)?.needsAttention ?? project.needsAttention,
        freshness: assessments.get(project.id)?.freshness.state ?? project.freshness,
      })),
    };

    const narration =
      projects.length === 0
        ? {
            narrative: buildPortfolioNarrative(payload),
            method: 'deterministic' as const,
            error: null,
          }
        : await this.deps.narrator.narratePortfolio(payload);

    return {
      briefing: {
        assessment,
        narrative: narration.narrative,
        method: narration.method,
        generatedAt: assessment.generatedAt,
        narratorError: narration.error,
      },
      projects,
      assessments,
    };
  }

  /** Meaningful changes for one project, comparing the last two *distinct* snapshots. */
  async changesForProject(projectId: string): Promise<readonly StatusChange[]> {
    const current = await this.deps.snapshots.latest(projectId);
    if (!current) return [];
    const previous = await this.deps.snapshots.previousDistinct(projectId);
    /*
     * With no previous snapshot there is no baseline to diff against, so "since the last snapshot"
     * would mean "since a moment ago" and the screen would be empty despite real recent activity.
     * The first view therefore falls back to a fixed recent window of verified evidence.
     */
    const since = previous
      ? new Date(previous.generatedAt)
      : new Date(this.clock().getTime() - FIRST_VIEW_WINDOW_DAYS * 86_400_000);
    const evidenceSince = await this.deps.evidence.list({ projectId, since, limit: 100 });
    return diffSnapshots({ previous, current, evidenceSince });
  }

  async changesForPortfolio(): Promise<readonly (StatusChange & { projectName: string })[]> {
    const projects = await this.deps.projects.listAllForAssessment(false);
    const all: (StatusChange & { projectName: string })[] = [];
    for (const project of projects) {
      const changes = await this.changesForProject(project.id);
      for (const change of changes) {
        all.push({ ...change, projectName: project.shortName ?? project.name });
      }
    }
    return all
      .sort((a, b) => new Date(b.occurredAt).getTime() - new Date(a.occurredAt).getTime())
      .slice(0, 100);
  }
}

function extractNarrative(snapshot: StatusSnapshot): ProjectBriefing['narrative'] | null {
  const raw = snapshot.narrative;
  if (!raw || typeof raw !== 'object') return null;
  const candidate = raw as Record<string, unknown>;
  if (typeof candidate.currentState !== 'string') return null;
  return {
    currentState: candidate.currentState,
    recentlyCompleted: toStringArray(candidate.recentlyCompleted),
    inProgress: toStringArray(candidate.inProgress),
    blockers: toStringArray(candidate.blockers),
    decisionsNeeded: toStringArray(candidate.decisionsNeeded),
    nextActions: toStringArray(candidate.nextActions),
    unknowns: toStringArray(candidate.unknowns),
    citedEvidenceIds: toStringArray(candidate.citedEvidenceIds),
  };
}

function toStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}
