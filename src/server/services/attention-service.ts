import type { Project } from '@/domain/project';
import type { AttentionReason, ProjectAssessment } from '@/domain/status';
import type { BriefingService } from './briefing-service';
import type { ProjectRepository } from '@/server/repositories/types';

/**
 * "What needs me" — a single, ordered list of situations that genuinely require the owner.
 *
 * Everything here comes from a deterministic attention rule with an explicit provenance label,
 * so nothing lands on this screen because a model felt it was important.
 */

export interface AttentionItem {
  readonly projectId: string;
  readonly projectName: string;
  readonly reason: AttentionReason;
}

export interface AttentionGroups {
  readonly decisions: readonly AttentionItem[];
  readonly blockers: readonly AttentionItem[];
  readonly failedBuilds: readonly AttentionItem[];
  readonly failedSyncs: readonly AttentionItem[];
  readonly stale: readonly AttentionItem[];
  readonly overdue: readonly AttentionItem[];
  readonly other: readonly AttentionItem[];
  readonly total: number;
}

const EMPTY: AttentionGroups = {
  decisions: [],
  blockers: [],
  failedBuilds: [],
  failedSyncs: [],
  stale: [],
  overdue: [],
  other: [],
  total: 0,
};

export class AttentionService {
  constructor(private readonly deps: { projects: ProjectRepository; briefings: BriefingService }) {}

  async collect(): Promise<AttentionGroups> {
    const projects = await this.deps.projects.listAllForAssessment(false);
    if (projects.length === 0) return EMPTY;
    const assessments = await this.deps.briefings.assessMany(projects.map((project) => project.id));
    return groupAttention(projects, assessments);
  }
}

export function groupAttention(
  projects: readonly Project[],
  assessments: ReadonlyMap<string, ProjectAssessment>,
): AttentionGroups {
  const decisions: AttentionItem[] = [];
  const blockers: AttentionItem[] = [];
  const failedBuilds: AttentionItem[] = [];
  const failedSyncs: AttentionItem[] = [];
  const stale: AttentionItem[] = [];
  const overdue: AttentionItem[] = [];
  const other: AttentionItem[] = [];

  for (const project of projects) {
    const assessment = assessments.get(project.id);
    if (!assessment) continue;
    const projectName = project.shortName ?? project.name;
    for (const reason of assessment.attention) {
      const item: AttentionItem = { projectId: project.id, projectName, reason };
      switch (reason.code) {
        case 'decision_required':
          decisions.push(item);
          break;
        case 'active_blocker':
          blockers.push(item);
          break;
        case 'failed_workflow':
          failedBuilds.push(item);
          break;
        case 'failed_sync':
          failedSyncs.push(item);
          break;
        case 'stale_data':
          stale.push(item);
          break;
        case 'overdue_action':
        case 'overdue_target_date':
          overdue.push(item);
          break;
        default:
          other.push(item);
      }
    }
  }

  const total =
    decisions.length +
    blockers.length +
    failedBuilds.length +
    failedSyncs.length +
    stale.length +
    overdue.length +
    other.length;

  return { decisions, blockers, failedBuilds, failedSyncs, stale, overdue, other, total };
}
