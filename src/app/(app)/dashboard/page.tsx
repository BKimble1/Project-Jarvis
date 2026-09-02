import type { Metadata } from 'next';
import Link from 'next/link';
import { Suspense } from 'react';
import { FolderPlus, FolderGit2 } from 'lucide-react';
import { getServices } from '@/server/container';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { SkeletonCard } from '@/components/ui/skeleton';
import { CommandBar } from '@/components/command-bar';
import { CountTiles } from '@/components/count-tiles';
import { PortfolioBriefingPanel } from '@/components/briefing-panel';
import { ProjectCard } from '@/components/project-card';
import { SyncButton } from '@/components/sync-controls';
import { RelativeTime } from '@/components/relative-time';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Dashboard' };

export default function DashboardPage() {
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

      <CommandBar />

      <Suspense fallback={<DashboardSkeleton />}>
        <DashboardContent />
      </Suspense>
    </div>
  );
}

async function DashboardContent() {
  const services = await getServices();
  const { briefing, projects, assessments } = await services.briefings.briefPortfolio();
  const lastRuns = await services.runs.listRecent(1);
  const lastRun = lastRuns[0];

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

  /* Attention first, then the owner's priority — the same order the focus list uses. */
  const ordered = [...projects].sort((a, b) => {
    const aAttention = assessments.get(a.id)?.needsAttention ? 0 : 1;
    const bAttention = assessments.get(b.id)?.needsAttention ? 0 : 1;
    if (aAttention !== bAttention) return aAttention - bAttention;
    return a.name.localeCompare(b.name);
  });

  return (
    <>
      <CountTiles counts={briefing.assessment.counts} />
      <PortfolioBriefingPanel briefing={briefing} />

      <section aria-label="Projects" className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-sm font-semibold">Projects</h2>
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
