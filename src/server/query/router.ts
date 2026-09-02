import type { ProvenanceLevel } from '@/domain/enums';
import type { AnswerItem, AnswerSection, QueryAnswer } from '@/domain/query';
import type { Project } from '@/domain/project';
import type { ProjectAssessment } from '@/domain/status';
import type { BriefingService } from '@/server/services/briefing-service';
import { groupAttention } from '@/server/services/attention-service';
import type { ProjectRepository, QueryHistoryRepository } from '@/server/repositories/types';
import type { MissionRepository, WorkerRepository } from '@/server/repositories/mission-types';
import { classifyIntake, extractProjectHint } from '@/domain/mission-intake';
import { parseQuery, resolveProjectName, type QueryIntent } from './parser';
import {
  answerExecutionRequest,
  answerFinishedToday,
  answerMissionCommand,
  answerMissionDetail,
  answerMissionsFailed,
  answerMissionsNeedingMe,
  answerMissionsRunning,
  answerPlansAwaitingApproval,
  answerPullRequestsReady,
  type MissionAnswerContext,
} from './mission-answers';

/**
 * The Jarvis command bar.
 *
 * It answers questions about state, and — since Prompt 2 — recognises a request that is actually
 * *work* and shows what it understood so the owner can start a mission from it. Answering a
 * question never creates anything: the mission is created by the owner confirming the preview.
 *
 * Mission data is an optional dependency so the status half of the router keeps working (and
 * keeps being testable) without Mission Control wired in.
 */

export type { AnswerItem, AnswerSection, QueryAnswer };

/** Intents that need Mission Control wired in to answer at all. */
const MISSION_INTENTS: readonly QueryIntent[] = [
  'missions_running',
  'missions_needing_me',
  'plans_awaiting_approval',
  'pull_requests_ready',
  'missions_failed',
  'missions_finished_today',
  'mission_detail',
  'mission_command',
];

export class StatusQueryRouter {
  constructor(
    private readonly deps: {
      projects: ProjectRepository;
      briefings: BriefingService;
      history?: QueryHistoryRepository;
      missions?: MissionRepository;
      workers?: WorkerRepository;
      clock?: () => Date;
    },
  ) {}

  async answer(rawQuery: string): Promise<QueryAnswer> {
    const parsed = parseQuery(rawQuery);
    const projects = await this.deps.projects.listAllForAssessment(false);

    let scoped: Project | null = null;
    let disambiguation: QueryAnswer['disambiguation'] = null;

    if (parsed.projectQuery) {
      const match = resolveProjectName(
        parsed.projectQuery,
        projects.map((project) => ({
          id: project.id,
          name: project.name,
          shortName: project.shortName,
        })),
      );
      if (match.kind === 'ambiguous') {
        disambiguation = match.matches.map((candidate) => ({
          id: candidate.id,
          name: candidate.name,
        }));
      } else if (match.matches.length === 1) {
        scoped = projects.find((project) => project.id === match.matches[0]?.id) ?? null;
      }
    }

    const answer = await this.route(
      parsed.intent,
      parsed.raw,
      projects,
      scoped,
      disambiguation,
      parsed.projectQuery,
    );

    await this.deps.history?.record({
      queryText: rawQuery,
      intent: answer.intent,
      projectId: scoped?.id ?? null,
    });

    return answer;
  }

  /**
   * Mission data for the answer layer.
   *
   * Returns `null` when Mission Control is not wired in, which is what lets the status half of
   * the router be constructed and tested on its own.
   */
  private async missionContext(projects: readonly Project[]): Promise<MissionAnswerContext | null> {
    if (!this.deps.missions) return null;
    const [missions, workers] = await Promise.all([
      this.deps.missions.listOpen(),
      this.deps.workers?.list() ?? Promise.resolve([]),
    ]);
    return { missions, workers, projects, now: this.deps.clock?.() ?? new Date() };
  }

  /**
   * Mission Control is not available in this configuration.
   *
   * Stated honestly rather than answered vaguely: the question was understood, the data simply is
   * not there to answer it.
   */
  private missionsUnavailableAnswer(intent: QueryIntent, scoped: Project | null): QueryAnswer {
    return {
      intent,
      title: 'Mission Control is not available here',
      summary:
        'This Jarvis instance is running without Mission Control, so it cannot answer questions about missions or start one.',
      summaryProvenance: 'verified',
      sections: [],
      projectIds: scoped ? [scoped.id] : [],
      disambiguation: null,
      notice: 'Nothing was started.',
      href: scoped ? `/projects/${scoped.id}` : null,
      missionPreview: null,
    };
  }

  private async route(
    intent: QueryIntent,
    raw: string,
    projects: readonly Project[],
    scoped: Project | null,
    disambiguation: QueryAnswer['disambiguation'],
    projectQuery: string | null,
  ): Promise<QueryAnswer> {
    if (disambiguation && disambiguation.length > 0) {
      return {
        intent,
        title: 'Which project did you mean?',
        summary: `Several projects match that name.`,
        summaryProvenance: 'verified',
        sections: [],
        projectIds: disambiguation.map((entry) => entry.id),
        disambiguation,
        notice: null,
        href: null,
      };
    }

    /*
     * A mission-control phrase, a request that reads as work, or something prohibited. All three
     * are answered without changing anything: the owner confirms on the mission screen.
     */
    const intake = classifyIntake(raw);
    if (intent === 'execution_request' || intake.kind === 'prohibited') {
      const context = await this.missionContext(projects);
      if (!context) return this.missionsUnavailableAnswer(intent, scoped);
      return answerExecutionRequest(
        context,
        raw,
        scoped,
        projectQuery ?? extractProjectHint(raw.toLowerCase()),
      );
    }
    if (intake.kind === 'mission_command') {
      const context = await this.missionContext(projects);
      if (!context) return this.missionsUnavailableAnswer('mission_command', scoped);
      return answerMissionCommand(context, raw);
    }

    if (MISSION_INTENTS.includes(intent)) {
      const context = await this.missionContext(projects);
      if (!context) return this.missionsUnavailableAnswer(intent, scoped);
      switch (intent) {
        case 'missions_running':
          return answerMissionsRunning(context);
        case 'missions_needing_me':
          return answerMissionsNeedingMe(context);
        case 'plans_awaiting_approval':
          return answerPlansAwaitingApproval(context);
        case 'pull_requests_ready':
          return answerPullRequestsReady(context);
        case 'missions_failed':
          return answerMissionsFailed(context);
        case 'missions_finished_today':
          return answerFinishedToday(context);
        case 'mission_detail':
          return answerMissionDetail(context, projectQuery);
        default:
          break;
      }
    }

    switch (intent) {
      case 'project_status':
      case 'project_changes':
        return scoped
          ? this.projectAnswer(intent, scoped)
          : this.notFoundAnswer(intent, raw, projects);
      case 'portfolio_changes':
        return this.portfolioChangesAnswer();
      case 'needs_attention':
        return this.attentionAnswer(projects);
      case 'blocked_projects':
        return this.filteredAnswer(
          'blocked_projects',
          'Blocked projects',
          projects,
          (assessment) => assessment.status === 'blocked',
        );
      case 'stale_projects':
        return this.filteredAnswer(
          'stale_projects',
          'Projects with stale data',
          projects,
          (assessment) =>
            assessment.freshness.state === 'stale' || assessment.freshness.state === 'never',
        );
      case 'list_waiting':
        return this.filteredAnswer(
          'list_waiting',
          'Waiting projects',
          projects,
          (assessment) => assessment.status === 'waiting',
        );
      case 'list_paused':
        return this.filteredAnswer(
          'list_paused',
          'Paused projects',
          projects,
          (assessment) => assessment.status === 'paused',
        );
      case 'list_active':
        return this.filteredAnswer(
          'list_active',
          'Active projects',
          projects,
          (assessment) => assessment.status === 'active',
        );
      case 'list_in_progress':
        return this.filteredAnswer(
          'list_in_progress',
          'Projects with work in progress',
          projects,
          (assessment) => assessment.currentWork.length > 0,
        );
      case 'focus':
        return this.focusAnswer();
      case 'portfolio_status':
        return this.portfolioAnswer();
      default:
        return {
          intent: 'unsupported',
          title: 'Jarvis did not understand that',
          summary:
            'Try "Where are we?", "Where are we on <project>?", "What changed?", "What needs me?", "Which projects are blocked?" or "What should I focus on?".',
          summaryProvenance: 'verified',
          sections: [],
          projectIds: [],
          disambiguation: null,
          notice: null,
          href: null,
        };
    }
  }

  private async projectAnswer(intent: QueryIntent, project: Project): Promise<QueryAnswer> {
    const briefing = await this.deps.briefings.briefProject(project.id);
    const { assessment, narrative } = briefing;
    const href = `/projects/${project.id}`;

    if (intent === 'project_changes') {
      const changes = await this.deps.briefings.changesForProject(project.id);
      return {
        intent,
        title: `What changed on ${project.shortName ?? project.name}`,
        summary:
          changes.length === 0
            ? 'Nothing meaningful has changed since the previous snapshot.'
            : `${changes.length} meaningful change${changes.length === 1 ? '' : 's'} since the previous snapshot.`,
        summaryProvenance: 'verified',
        sections: [
          {
            label: 'Changes',
            items: changes.map((change) => ({
              text: change.summary,
              provenance: change.provenance,
              projectId: project.id,
              href,
              evidenceIds: change.evidenceIds,
            })),
            emptyText: 'No changes recorded.',
          },
        ],
        projectIds: [project.id],
        disambiguation: null,
        notice: null,
        href,
      };
    }

    return {
      intent,
      title: project.shortName ?? project.name,
      summary: narrative.currentState,
      summaryProvenance: assessment.headline.provenance,
      sections: [
        section(
          'Recently completed',
          assessment.recentlyCompleted,
          project.id,
          href,
          'Nothing verified recently.',
        ),
        section(
          'In progress',
          assessment.currentWork,
          project.id,
          href,
          'No evidence of work in progress.',
        ),
        section('Blockers', assessment.activeBlockers, project.id, href, 'No active blockers.'),
        section('Decisions needed', assessment.decisionsNeeded, project.id, href, 'None.'),
        {
          label: 'Next actions',
          items: assessment.recommendedActions.slice(0, 3).map((action) => ({
            text: action.action,
            provenance: action.provenance,
            projectId: project.id,
            href,
            evidenceIds: action.evidenceIds,
          })),
          emptyText: 'Nothing recommended.',
        },
        {
          label: 'Unknowns',
          items: assessment.unknowns.map((text) => ({ text, provenance: 'unknown' as const })),
          emptyText: 'Nothing flagged as unknown.',
        },
      ],
      projectIds: [project.id],
      disambiguation: null,
      notice: null,
      href,
    };
  }

  private async portfolioAnswer(): Promise<QueryAnswer> {
    const { briefing } = await this.deps.briefings.briefPortfolio();
    const { counts } = briefing.assessment;
    return {
      intent: 'portfolio_status',
      title: 'Where we are',
      summary: briefing.narrative.headline,
      summaryProvenance: 'verified',
      sections: [
        {
          label: 'Focus order',
          items: briefing.assessment.focusOrder.slice(0, 6).map((entry) => ({
            text: `${entry.projectName} — ${entry.reason}`,
            provenance: entry.provenance,
            projectId: entry.projectId,
            href: `/projects/${entry.projectId}`,
          })),
          emptyText: 'No projects yet.',
        },
        {
          label: 'Counts',
          items: [
            { text: `${counts.active} active`, provenance: 'verified' as const },
            { text: `${counts.needsAttention} need attention`, provenance: 'verified' as const },
            { text: `${counts.blocked} blocked`, provenance: 'verified' as const },
            { text: `${counts.waiting} waiting`, provenance: 'verified' as const },
            { text: `${counts.paused} paused`, provenance: 'verified' as const },
            { text: `${counts.stale} with stale data`, provenance: 'verified' as const },
          ],
        },
        {
          label: 'Unknowns',
          items: briefing.assessment.unknowns.map((text) => ({
            text,
            provenance: 'unknown' as const,
          })),
          emptyText: 'Nothing flagged as unknown.',
        },
      ],
      projectIds: briefing.assessment.focusOrder.map((entry) => entry.projectId),
      disambiguation: null,
      notice: null,
      href: '/dashboard',
    };
  }

  private async portfolioChangesAnswer(): Promise<QueryAnswer> {
    const changes = await this.deps.briefings.changesForPortfolio();
    return {
      intent: 'portfolio_changes',
      title: 'What changed',
      summary:
        changes.length === 0
          ? 'Nothing meaningful has changed since the previous snapshots.'
          : `${changes.length} meaningful change${changes.length === 1 ? '' : 's'} across the portfolio.`,
      summaryProvenance: 'verified',
      sections: [
        {
          label: 'Changes',
          items: changes.slice(0, 25).map((change) => ({
            text: `${change.projectName}: ${change.summary}`,
            provenance: change.provenance,
            projectId: change.projectId,
            href: `/projects/${change.projectId}`,
            evidenceIds: change.evidenceIds,
          })),
          emptyText: 'No changes recorded.',
        },
      ],
      projectIds: [...new Set(changes.map((change) => change.projectId))],
      disambiguation: null,
      notice: null,
      href: '/changes',
    };
  }

  private async attentionAnswer(projects: readonly Project[]): Promise<QueryAnswer> {
    const assessments = await this.deps.briefings.assessMany(projects.map((project) => project.id));
    const groups = groupAttention(projects, assessments);
    const toItems = (items: typeof groups.decisions) =>
      items.map((item) => ({
        text: `${item.projectName}: ${item.reason.summary}`,
        provenance: item.reason.provenance,
        projectId: item.projectId,
        href: `/projects/${item.projectId}`,
        evidenceIds: item.reason.evidenceIds,
      }));

    return {
      intent: 'needs_attention',
      title: 'What needs you',
      summary:
        groups.total === 0
          ? 'Nothing needs you right now.'
          : `${groups.total} item${groups.total === 1 ? '' : 's'} need you.`,
      summaryProvenance: 'verified',
      sections: [
        { label: 'Decisions required', items: toItems(groups.decisions), emptyText: 'None.' },
        { label: 'Active blockers', items: toItems(groups.blockers), emptyText: 'None.' },
        { label: 'Failed builds', items: toItems(groups.failedBuilds), emptyText: 'None.' },
        {
          label: 'Failed synchronisations',
          items: toItems(groups.failedSyncs),
          emptyText: 'None.',
        },
        { label: 'Overdue', items: toItems(groups.overdue), emptyText: 'None.' },
        { label: 'Stale projects', items: toItems(groups.stale), emptyText: 'None.' },
      ],
      projectIds: [
        ...new Set([...groups.decisions, ...groups.blockers].map((item) => item.projectId)),
      ],
      disambiguation: null,
      notice: null,
      href: '/attention',
    };
  }

  private async focusAnswer(): Promise<QueryAnswer> {
    const { briefing } = await this.deps.briefings.briefPortfolio();
    return {
      intent: 'focus',
      title: 'Suggested focus order',
      summary:
        briefing.assessment.focusOrder.length === 0
          ? 'There is nothing to focus on yet.'
          : 'Ordered by the most serious thing true of each project, then by your priority.',
      summaryProvenance: 'inferred',
      sections: [
        {
          label: 'In order',
          items: briefing.assessment.focusOrder.slice(0, 8).map((entry) => ({
            text: `${entry.rank}. ${entry.projectName} — ${entry.reason}`,
            provenance: entry.provenance,
            projectId: entry.projectId,
            href: `/projects/${entry.projectId}`,
          })),
          emptyText: 'No projects yet.',
        },
      ],
      projectIds: briefing.assessment.focusOrder.map((entry) => entry.projectId),
      disambiguation: null,
      notice: null,
      href: '/dashboard',
    };
  }

  private async filteredAnswer(
    intent: QueryIntent,
    title: string,
    projects: readonly Project[],
    predicate: (assessment: ProjectAssessment) => boolean,
  ): Promise<QueryAnswer> {
    const assessments = await this.deps.briefings.assessMany(projects.map((project) => project.id));
    const matched = projects.filter((project) => {
      const assessment = assessments.get(project.id);
      return assessment ? predicate(assessment) : false;
    });

    return {
      intent,
      title,
      summary:
        matched.length === 0
          ? `No projects match "${title.toLowerCase()}".`
          : `${matched.length} project${matched.length === 1 ? '' : 's'}.`,
      summaryProvenance: 'verified',
      sections: [
        {
          label: title,
          items: matched.map((project) => {
            const assessment = assessments.get(project.id);
            return {
              text: `${project.shortName ?? project.name} — ${assessment?.headline.text ?? 'No assessment yet.'}`,
              provenance: assessment?.headline.provenance ?? 'unknown',
              projectId: project.id,
              href: `/projects/${project.id}`,
            };
          }),
          emptyText: 'Nothing matches.',
        },
      ],
      projectIds: matched.map((project) => project.id),
      disambiguation: null,
      notice: null,
      href: '/projects',
    };
  }

  private notFoundAnswer(
    intent: QueryIntent,
    raw: string,
    projects: readonly Project[],
  ): QueryAnswer {
    return {
      intent,
      title: 'No matching project',
      summary: `Jarvis could not find a project matching that name.`,
      summaryProvenance: 'verified',
      sections: [
        {
          label: 'Projects you have',
          items: projects.slice(0, 10).map((project) => ({
            text: project.shortName ?? project.name,
            provenance: 'verified' as const,
            projectId: project.id,
            href: `/projects/${project.id}`,
          })),
          emptyText: 'You have no projects yet.',
        },
      ],
      projectIds: [],
      disambiguation: null,
      notice: null,
      href: '/projects',
    };
  }
}

function section(
  label: string,
  claims: readonly { text: string; provenance: ProvenanceLevel; evidenceIds: readonly string[] }[],
  projectId: string,
  href: string,
  emptyText: string,
): AnswerSection {
  return {
    label,
    items: claims.map((item) => ({
      text: item.text,
      provenance: item.provenance,
      projectId,
      href,
      evidenceIds: item.evidenceIds,
    })),
    emptyText,
  };
}
