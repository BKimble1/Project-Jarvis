import Link from 'next/link';
import { AlertTriangle, GitPullRequest, OctagonAlert, Target } from 'lucide-react';
import type { Project } from '@/domain/project';
import type { ProjectAssessment } from '@/domain/status';
import { PROJECT_TYPE_LABELS } from '@/lib/labels';
import { Badge } from '@/components/ui/badge';
import { FreshnessPill, StatusPill } from '@/components/status-pills';
import { ProvenanceBadge } from '@/components/provenance';
import { RelativeTime } from '@/components/relative-time';

/**
 * One project, summarised.
 *
 * The card answers, in order: what is it, where is it, is anything wrong, what happens next.
 * There are no decorative metrics and no invented progress bars — only signals backed by a rule.
 */
export function ProjectCard({
  project,
  assessment,
  openPullRequests = 0,
  failingBuilds = 0,
}: {
  project: Project;
  assessment: ProjectAssessment | undefined;
  openPullRequests?: number;
  failingBuilds?: number;
}) {
  const headline = assessment?.headline;
  const nextAction = assessment?.recommendedActions[0];
  const blockerCount = assessment?.activeBlockers.length ?? 0;
  const lastActivity =
    assessment?.freshness.observedAt ?? project.lastSyncedAt ?? project.lastManualUpdateAt;

  return (
    <Link
      href={`/projects/${project.id}`}
      className="group flex flex-col rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-surface)] p-4 shadow-[var(--shadow-card)] transition-colors hover:border-[var(--color-border-strong)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-accent)]"
    >
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-sm font-semibold group-hover:text-[var(--color-accent-text)]">
            {project.icon ? <span className="mr-1.5">{project.icon}</span> : null}
            {project.name}
          </h3>
          <p className="mt-0.5 truncate text-xs text-[var(--color-text-subtle)]">
            {PROJECT_TYPE_LABELS[project.type]}
            {project.phase ? ` · ${project.phase}` : ''}
          </p>
        </div>
        {(assessment?.needsAttention ?? project.needsAttention) ? (
          <span
            title="Needs your attention"
            className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[var(--color-critical-soft)]"
          >
            <AlertTriangle className="h-3 w-3 text-[var(--color-critical-text)]" aria-hidden />
            <span className="sr-only">Needs your attention</span>
          </span>
        ) : null}
      </div>

      <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
        <StatusPill status={assessment?.status ?? project.status} />
        <FreshnessPill
          state={assessment?.freshness.state ?? project.freshness}
          detail={assessment?.freshness.explanation}
        />
        {blockerCount > 0 ? (
          <Badge tone="critical">
            <OctagonAlert className="h-3 w-3" aria-hidden />
            {blockerCount} blocker{blockerCount === 1 ? '' : 's'}
          </Badge>
        ) : null}
        {failingBuilds > 0 ? (
          <Badge tone="critical">
            <AlertTriangle className="h-3 w-3" aria-hidden />
            Build failing
          </Badge>
        ) : null}
        {openPullRequests > 0 ? (
          <Badge tone="neutral">
            <GitPullRequest className="h-3 w-3" aria-hidden />
            {openPullRequests} open PR{openPullRequests === 1 ? '' : 's'}
          </Badge>
        ) : null}
      </div>

      {project.goal ? (
        <p className="mt-2.5 flex items-start gap-1.5 text-xs text-[var(--color-text-muted)]">
          <Target className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
          <span className="line-clamp-2">{project.goal}</span>
        </p>
      ) : null}

      {headline ? (
        <p className="mt-2.5 flex items-start gap-1.5 text-sm">
          <ProvenanceBadge level={headline.provenance} showLabel={false} className="mt-0.5" />
          <span className="line-clamp-2 text-[var(--color-text)]">{headline.text}</span>
        </p>
      ) : null}

      <div className="mt-auto pt-3">
        {nextAction ? (
          <p className="flex items-start gap-1.5 text-xs text-[var(--color-text-muted)]">
            <span className="font-medium text-[var(--color-text-subtle)]">Next:</span>
            <span className="line-clamp-1">{nextAction.action}</span>
          </p>
        ) : null}
        <p className="mt-1 text-[0.6875rem] text-[var(--color-text-subtle)]">
          Last activity <RelativeTime iso={lastActivity} />
        </p>
      </div>
    </Link>
  );
}
