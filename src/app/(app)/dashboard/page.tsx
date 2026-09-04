import type { Metadata } from 'next';
import Link from 'next/link';
import { Suspense } from 'react';
import { FolderPlus, FolderGit2 } from 'lucide-react';
import { getServices } from '@/server/container';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { SkeletonCard } from '@/components/ui/skeleton';
import { CommandBar } from '@/components/command-bar';
import { DashboardFilters } from '@/components/dashboard-filters';
import { CountTiles } from '@/components/count-tiles';
import { PortfolioBriefingPanel } from '@/components/briefing-panel';
import { ProjectCard } from '@/components/project-card';
import { SyncButton } from '@/components/sync-controls';
import { RelativeTime } from '@/components/relative-time';
import { MissionStrip } from '@/components/mission/mission-strip';
import { countMissions } from '@/server/status/missions';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Dashboard' };

type Search = Record<string, string | string[] | undefined>;

const one = (value: string | string[] | undefined): string | undefined =>
  Array.isArray(value) ? value[0] : value;

export default async function DashboardPage({ searchParams }: { searchParams: Promise<Search> }) {
  const params = await searchParams;
  const services = await getServices();
  const history = await services.queryHistory.recent(6);

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold sm:text-xl">Dashboard</h1>
          <p className="text-sm text-[var(--color-text-muted)]">
            Where everything stands right now.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <SyncButton label="Synchronise all" />
          <Button asChild size="sm">
            <Link href="/projects/new">
              <FolderPlus className="h-4 w-4" aria-hidden />
              Add project
            </Link>
          </Button>
        </div>
      </header>

      <CommandBar initialHistory={history.map((entry) => entry.queryText)} />

      <Suspense fallback={<DashboardSkeleton />}>
        <DashboardContent
          search={one(params.q)}
          status={one(params.status)}
          sort={one(params.sort)}
        />
      </Suspense>
    </div>
  );
}

async function DashboardContent({
  search,
  status,
  sort,
}: {
  search?: string | undefined;
  status?: string | undefined;
  sort?: string | undefined;
}) {
  const services = await getServices();
  const { briefing, projects, assessments } = await services.briefings.briefPortfolio();
  const lastRuns = await services.runs.listRecent(1);
  const lastRun = lastRuns[0];

  const [missionPage, workers] = await Promise.all([
    services.missions.list({ limit: 40 }),
    services.missions.workerHealth(),
  ]);
  const missionCounts = countMissions(
    missionPage.items.map((entry) => entry.mission),
    new Map(workers.map((health) => [health.worker.id, health] as const)),
  );

  if (projects.length === 0) {
    return (
      <EmptyState
        title="No projects yet"
        description="Jarvis tracks anything you are working on — a repository, an app, a business idea, a research project or a piece of coursework. Add the first one and it will start building an evidence trail."
        action={
          <div className="flex flex-wrap justify-center gap-2">
            <Button asChild>
              <Link href="/projects/new">
                <FolderPlus className="h-4 w-4" aria-hidden />
                Add a project
              </Link>
            </Button>
            <Button asChild variant="secondary">
              <Link href="/projects/import">
                <FolderGit2 className="h-4 w-4" aria-hidden />
                Import from GitHub
              </Link>
            </Button>
          </div>
        }
      />
    );
  }

  const evidenceCounts = await services.evidence.list({
    projectIds: projects.map((project) => project.id),
    kinds: ['pull_request', 'workflow_run'],
    limit: 400,
  });

  const openPrs = new Map<string, number>();
  const failingBuilds = new Map<string, number>();
  for (const item of evidenceCounts) {
    if (item.kind === 'pull_request' && item.metadata.state === 'open') {
      openPrs.set(item.projectId, (openPrs.get(item.projectId) ?? 0) + 1);
    }
  }
  for (const [projectId, assessment] of assessments) {
    const failures = assessment.attention.filter(
      (reason) => reason.code === 'failed_workflow',
    ).length;
    if (failures > 0) failingBuilds.set(projectId, failures);
  }

  /*
   * The briefing and the counts above always describe the whole portfolio; only the card list
   * below responds to the filter, so a narrowed view can never misrepresent "where are we?".
   */
  const needle = search?.trim().toLowerCase() ?? '';
  const visible = projects.filter((project) => {
    if (status && (assessments.get(project.id)?.status ?? project.status) !== status) return false;
    if (needle.length === 0) return true;
    return [project.name, project.shortName, project.goal, project.description, ...project.tags]
      .filter((value): value is string => typeof value === 'string')
      .some((value) => value.toLowerCase().includes(needle));
  });

  const priorityRank: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
  const freshnessRank: Record<string, number> = {
    failing: 0,
    never: 1,
    stale: 2,
    recent: 3,
    live: 4,
  };
  const activityOf = (project: (typeof projects)[number]) =>
    new Date(project.lastSyncedAt ?? project.lastManualUpdateAt ?? project.updatedAt).getTime();

  const ordered = [...visible].sort((a, b) => {
    switch (sort) {
      case 'recent_activity':
        return activityOf(b) - activityOf(a);
      case 'priority':
        return (
          priorityRank[a.priority]! - priorityRank[b.priority]! || a.name.localeCompare(b.name)
        );
      case 'staleness':
        return (
          freshnessRank[assessments.get(a.id)?.freshness.state ?? a.freshness]! -
            freshnessRank[assessments.get(b.id)?.freshness.state ?? b.freshness]! ||
          activityOf(a) - activityOf(b)
        );
      case 'name':
        return a.name.localeCompare(b.name);
      default: {
        /* Attention first, then the owner's priority — the same order the focus list uses. */
        const aAttention = assessments.get(a.id)?.needsAttention ? 0 : 1;
        const bAttention = assessments.get(b.id)?.needsAttention ? 0 : 1;
        if (aAttention !== bAttention) return aAttention - bAttention;
        return (
          priorityRank[a.priority]! - priorityRank[b.priority]! || a.name.localeCompare(b.name)
        );
      }
    }
  });

  return (
    <>
      <CountTiles counts={briefing.assessment.counts} />
      <MissionStrip counts={missionCounts} missions={missionPage.items} />
      <PortfolioBriefingPanel briefing={briefing} />

      <section aria-label="Projects" className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-sm font-semibold">
            Projects{' '}
            <span className="font-normal text-[var(--color-text-subtle)]">
              ({ordered.length}
              {ordered.length === projects.length ? '' : ` of ${projects.length}`})
            </span>
          </h2>
          <p className="text-xs text-[var(--color-text-subtle)]">
            {lastRun ? (
              <>
                Last synchronisation <RelativeTime iso={lastRun.startedAt} /> · {lastRun.status}
              </>
            ) : (
              'No synchronisation has run yet.'
            )}{' '}
            {/* Neither of these is on the phone's bottom bar, so the dashboard carries the way
                in — see OFF_THE_TAB_BAR in the app shell. */}
            ·{' '}
            <Link
              href="/changes"
              className="underline-offset-2 hover:text-[var(--color-text)] hover:underline"
            >
              What changed
            </Link>{' '}
            ·{' '}
            <Link
              href="/knowledge"
              className="underline-offset-2 hover:text-[var(--color-text)] hover:underline"
            >
              What Jarvis knows
            </Link>{' '}
            ·{' '}
            <Link
              href="/ask"
              className="underline-offset-2 hover:text-[var(--color-text)] hover:underline"
            >
              Ask Jarvis
            </Link>
          </p>
        </div>

        <DashboardFilters />

        {ordered.length === 0 ? (
          <EmptyState
            title="No projects match that filter"
            description="Clear the filter to see the whole portfolio again."
          />
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {ordered.map((project) => (
              <ProjectCard
                key={project.id}
                project={project}
                assessment={assessments.get(project.id)}
                openPullRequests={openPrs.get(project.id) ?? 0}
                failingBuilds={failingBuilds.get(project.id) ?? 0}
              />
            ))}
          </div>
        )}
      </section>
    </>
  );
}

function DashboardSkeleton() {
  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {[0, 1, 2, 3, 4, 5].map((index) => (
        <SkeletonCard key={index} />
      ))}
    </div>
  );
}
