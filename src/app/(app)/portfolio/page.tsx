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
import { ReadinessStrip } from '@/components/readiness-strip';
import { MissionStrip } from '@/components/mission/mission-strip';
import { TERMINAL_MISSION_STATES, type MissionSummary } from '@/domain/mission';
import { countMissions } from '@/server/status/missions';
import { quickReadiness } from '@/server/ops/readiness';
import { buildOperatingPicture } from '@/server/ops/operating-picture';
import { NowPanel } from '@/components/home/now-panel';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Portfolio' };

type Search = Record<string, string | string[] | undefined>;

const one = (value: string | string[] | undefined): string | undefined =>
  Array.isArray(value) ? value[0] : value;

export default async function PortfolioPage({ searchParams }: { searchParams: Promise<Search> }) {
  const params = await searchParams;
  const services = await getServices();
  const [history, readiness, picture] = await Promise.all([
    services.queryHistory.recent(6),
    quickReadiness({ services }),
    /*
     * The same assembly the answer pipeline and the briefing use. One picture, so the screen, the
     * answer and the morning summary cannot disagree about what Jarvis is doing.
     */
    buildOperatingPicture(services),
  ]);

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold sm:text-xl">Portfolio</h1>
          <p className="text-sm text-[var(--color-text-muted)]">
            Every project, every mission, in full detail.
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

      {/*
       * Above the command bar, and above the Suspense boundary, on purpose.
       *
       * Above the bar because it qualifies it: the bar is where the next mission is typed, and
       * approving work on a deployment with no worker connected is the failure this row exists to
       * prevent. The bar also grows to hold an answer, so anything placed under it can be pushed
       * off a phone screen exactly when someone is using it. Above Suspense because a skeleton
       * cannot say whether a worker is connected, and this is cheap enough to block the first
       * paint — `quickReadiness` reads the database and nothing else, unlike the full readiness
       * report, which walks the ladder and reaches GitHub.
       */}
      <ReadinessStrip readiness={readiness} />

      {/*
       * Above the command bar, because it is the answer to the question somebody opened this page
       * to ask. The bar is for typing a new thing; this is for the things that already exist.
       */}
      <NowPanel
        headline={picture.headline}
        modeLabel={picture.modeLabel}
        loopExplanation={picture.loop.explanation}
        capacity={picture.capacity ? picture.capacity.reason : null}
        running={picture.running.map((entry) => ({
          missionId: entry.missionId,
          title: entry.title,
          state: entry.state,
        }))}
        actions={picture.actions}
        standingAuthority={picture.standingAuthority}
      />

      <CommandBar initialHistory={history.map((entry) => entry.queryText)} />

      <Elsewhere />

      <Suspense fallback={<PortfolioSkeleton />}>
        <PortfolioContent
          search={one(params.q)}
          status={one(params.status)}
          sort={one(params.sort)}
        />
      </Suspense>
    </div>
  );
}

async function PortfolioContent({
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

  /*
   * Finished missions are read separately rather than sieved out of the page above: on a busy
   * portfolio the forty newest missions can all still be open, and finished work would then
   * disappear from the landing page exactly when there is most of it to report.
   */
  const [pages, workers] = await Promise.all([
    /*
     * One call, two listings. Each summary needs a project name and a worker name, and both come
     * from reads that do not depend on the filter — so asking twice fetched every project and
     * every worker twice, on the one screen that always renders.
     */
    services.missions.listMany([{ limit: 40 }, { states: TERMINAL_MISSION_STATES, limit: 8 }]),
    services.missions.workerHealth(),
  ]);
  /*
   * Indexed rather than destructured: `noUncheckedIndexedAccess` is on, and the alternative is
   * three non-null assertions on a value the call above guarantees.
   */
  const missionPage = pages[0] ?? { items: [], total: 0 };
  const finishedPage = pages[1] ?? { items: [], total: 0 };

  /*
   * Ordered by when the work ended, which the query cannot do — mission listing sorts by creation.
   * Reading more than the strip shows and ordering them here is what stops the rows appearing with
   * "2 days ago" above "an hour ago".
   */
  const endedAt = (entry: MissionSummary) =>
    new Date(entry.mission.finishedAt ?? entry.mission.updatedAt).getTime();
  const recentlyFinished = [...finishedPage.items].sort((a, b) => endedAt(b) - endedAt(a));

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
      <MissionStrip
        counts={missionCounts}
        missions={missionPage.items}
        finished={recentlyFinished}
      />
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
            )}
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

/**
 * The rest of Jarvis, from the portfolio.
 *
 * The OFF_THE_TAB_BAR contract now lives on the immersive dashboard, which is the screen a phone
 * lands on; this row is the same courtesy from the other detailed screen, so somebody who came
 * here from a tab is not one dead end away from Operations. It sits above the Suspense boundary
 * rather than beside the project count, because that count is inside `PortfolioContent`, after
 * the "No projects yet" early return — which is how a first-run owner on a phone was once left
 * with no way to reach Ask at all.
 */
const ELSEWHERE = [
  ['/dashboard', 'Jarvis'],
  ['/ask', 'Ask Jarvis'],
  ['/changes', 'What changed'],
  ['/knowledge', 'What Jarvis knows'],
  ['/operations', 'Operations'],
  ['/workers', 'Workers'],
] as const;

function Elsewhere() {
  return (
    <nav aria-label="Elsewhere in Jarvis" className="flex flex-wrap gap-1.5">
      {ELSEWHERE.map(([href, label]) => (
        <Link
          key={href}
          href={href}
          className="rounded-lg border border-[var(--color-border)] px-2.5 py-1.5 text-xs text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-surface-muted)]"
        >
          {label}
        </Link>
      ))}
    </nav>
  );
}

function PortfolioSkeleton() {
  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {[0, 1, 2, 3, 4, 5].map((index) => (
        <SkeletonCard key={index} />
      ))}
    </div>
  );
}
