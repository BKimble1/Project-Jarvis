import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ExternalLink, Target } from 'lucide-react';
import { getServices } from '@/server/container';
import { CODE_PROJECT_TYPES, PRIORITY_LABELS, PROJECT_TYPE_LABELS } from '@/lib/labels';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { FreshnessPill, StatusPill } from '@/components/status-pills';
import { ProvenanceBadge } from '@/components/provenance';
import { SyncButton } from '@/components/sync-controls';
import { RelativeTime } from '@/components/relative-time';
import { ProjectBriefingPanel } from '@/components/project/briefing';
import {
  BlockersSection,
  DecisionsSection,
  MilestonesSection,
  NextActionsSection,
  UpdatesSection,
} from '@/components/project/entity-manager';
import { NoRepositoryPanel, RepositoryPanels } from '@/components/project/evidence-panels';
import { ProjectActions, ProjectSettingsCard } from '@/components/project/project-actions';
import { ProjectMissions } from '@/components/mission/mission-strip';
import { ACTIVITY_LABELS } from '@/lib/labels';

export const dynamic = 'force-dynamic';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  const services = await getServices();
  const project = await services.projects.findById(id);
  return { title: project?.name ?? 'Project' };
}

export default async function ProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const services = await getServices();

  const aggregate = await services.projects.aggregate(id);
  if (!aggregate) notFound();

  const { project, sources, blockers, decisions, milestones, updates, nextActions, goals } =
    aggregate;

  const [briefing, evidence, syncRuns, activity, changes, projectMissions] = await Promise.all([
    services.briefings.briefProject(id),
    services.evidence.list({ projectId: id, limit: 200 }),
    services.runs.listByProject(id, 10),
    services.activity.listByProject(id, 25),
    services.briefings.changesForProject(id),
    services.missions.list({ projectId: id, limit: 20 }),
  ]);

  const githubSource = sources.find((source) => source.kind === 'github_repo');
  const showRepositoryPanels = Boolean(githubSource);
  const isCodeProject = CODE_PROJECT_TYPES.has(project.type);

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-4">
      <header className="flex flex-col gap-3">
        <nav aria-label="Breadcrumb" className="text-xs text-[var(--color-text-subtle)]">
          <Link href="/projects" className="hover:underline">
            Projects
          </Link>
          <span aria-hidden> / </span>
          <span>{project.name}</span>
        </nav>

        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-lg font-semibold sm:text-xl">
              {project.icon ? <span className="mr-2">{project.icon}</span> : null}
              {project.name}
            </h1>
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
              <StatusPill status={briefing.assessment.status} />
              <ProvenanceBadge level={briefing.assessment.statusProvenance} />
              <Badge tone="neutral">{PROJECT_TYPE_LABELS[project.type]}</Badge>
              {project.phase ? <Badge tone="outline">Phase: {project.phase}</Badge> : null}
              <Badge tone="outline">{PRIORITY_LABELS[project.priority]} priority</Badge>
              <FreshnessPill
                state={briefing.assessment.freshness.state}
                detail={briefing.assessment.freshness.explanation}
              />
              {project.archivedAt ? <Badge tone="caution">Archived</Badge> : null}
            </div>
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            {showRepositoryPanels ? <SyncButton projectId={project.id} /> : null}
            <ProjectActions project={project} />
          </div>
        </div>

        {project.goal || goals.length > 0 ? (
          <p className="flex items-start gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm">
            <Target className="mt-0.5 h-4 w-4 shrink-0 text-[var(--color-accent)]" aria-hidden />
            <span>
              <span className="font-medium">Goal: </span>
              {project.goal ?? goals[0]?.statement}
              {goals[0]?.successDefinition ? (
                <span className="text-[var(--color-text-muted)]">
                  {' '}
                  — success: {goals[0].successDefinition}
                </span>
              ) : null}
            </span>
            <ProvenanceBadge level="manual" showLabel={false} className="mt-0.5" />
          </p>
        ) : null}

        {project.description ? (
          <p className="text-sm text-[var(--color-text-muted)]">{project.description}</p>
        ) : null}

        {project.tags.length > 0 || project.links.length > 0 ? (
          <div className="flex flex-wrap items-center gap-1.5">
            {project.tags.map((tag) => (
              <Badge key={tag} tone="neutral">
                {tag}
              </Badge>
            ))}
            {project.links.map((link) => (
              <a
                key={`${link.label}-${link.url}`}
                href={link.url}
                target="_blank"
                rel="noreferrer noopener"
                className="inline-flex items-center gap-1 rounded-md border border-[var(--color-border-strong)] px-2 py-0.5 text-[0.6875rem] text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
              >
                {link.label}
                <ExternalLink className="h-3 w-3" aria-hidden />
              </a>
            ))}
          </div>
        ) : null}
      </header>

      <ProjectBriefingPanel briefing={briefing} evidence={evidence} projectId={project.id} />

      <ProjectMissions projectId={project.id} missions={projectMissions.items} />

      {changes.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">What changed since the previous snapshot</CardTitle>
          </CardHeader>
          <CardContent className="pt-0">
            <ul className="flex flex-col divide-y divide-[var(--color-border)]">
              {changes.slice(0, 10).map((change, index) => (
                <li key={`${change.kind}-${index}`} className="flex items-start gap-2 py-2 text-sm">
                  <ProvenanceBadge level={change.provenance} showLabel={false} className="mt-0.5" />
                  <span className="min-w-0 flex-1">{change.summary}</span>
                  <span className="shrink-0 text-[0.6875rem] text-[var(--color-text-subtle)]">
                    <RelativeTime iso={change.occurredAt} />
                  </span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2">
        <BlockersSection projectId={project.id} blockers={blockers} />
        <NextActionsSection projectId={project.id} actions={nextActions} />
        <MilestonesSection projectId={project.id} milestones={milestones} />
        <DecisionsSection projectId={project.id} decisions={decisions} />
        <UpdatesSection projectId={project.id} updates={updates} />

        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Project timeline</CardTitle>
          </CardHeader>
          <CardContent className="pt-0">
            {activity.length === 0 ? (
              <p className="text-sm text-[var(--color-text-muted)]">Nothing recorded yet.</p>
            ) : (
              <ul className="flex flex-col divide-y divide-[var(--color-border)]">
                {activity.map((entry) => (
                  <li key={entry.id} className="flex items-start gap-2 py-2 text-sm">
                    <Badge tone="outline">{ACTIVITY_LABELS[entry.kind]}</Badge>
                    <span className="min-w-0 flex-1">{entry.summary}</span>
                    <span className="shrink-0 text-[0.6875rem] text-[var(--color-text-subtle)]">
                      <RelativeTime iso={entry.createdAt} />
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>

      {showRepositoryPanels && githubSource ? (
        <RepositoryPanels evidence={evidence} source={githubSource} syncRuns={syncRuns} />
      ) : isCodeProject ? (
        <NoRepositoryPanel />
      ) : null}

      <ProjectSettingsCard project={project} />
    </div>
  );
}
