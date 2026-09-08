import type { Metadata } from 'next';
import Link from 'next/link';
import { FolderGit2, LayoutGrid } from 'lucide-react';
import { requireOwnerPage } from '@/server/auth/guard';
import { getServices } from '@/server/container';
import { MissionList } from '@/components/mission/mission-list';
import { ProjectCard } from '@/components/project-card';
import { MISSION_FILTERS } from '@/lib/mission-filters';
import { cn } from '@/lib/cn';

export const metadata: Metadata = { title: 'Work' };
export const dynamic = 'force-dynamic';

/**
 * Portfolio, projects and missions in one place.
 *
 * ## Why this page exists
 *
 * The rail used to carry thirteen destinations, four of which were different views of the same
 * question — what is Jarvis doing, and what is waiting for me. Portfolio, Projects, Missions,
 * "What needs me" and "What changed" were five separate answers that had to be visited in turn.
 *
 * This is one workspace with those views as filters, which is what the owner asked for. Nothing was
 * removed to build it: every page it gathers is still its own route, still guarded by the same
 * layout, and still reachable — from here, from the dashboard, and from a bookmark. A destination
 * leaving the rail must not take a feature with it.
 *
 * ## Why the filters are in the URL
 *
 * Because a view worth looking at is worth linking to, and because the mission list already reads
 * its filter from there. One mechanism, not two.
 */

/** The three questions the owner actually asks, in the order they get asked. */
const VIEWS = [
  {
    id: 'active',
    label: 'Active',
    missionFilter: 'open',
    blurb: 'Everything unfinished, newest first.',
  },
  {
    id: 'needs-me',
    label: 'Needs me',
    missionFilter: 'needs-me',
    blurb: 'Work that has stopped and is waiting on a decision from you.',
  },
  {
    id: 'history',
    label: 'History',
    missionFilter: 'completed',
    blurb: 'Finished work, with what it produced.',
  },
  {
    id: 'projects',
    label: 'Projects',
    missionFilter: null,
    blurb: 'The things Jarvis is keeping track of.',
  },
] as const;

type ViewId = (typeof VIEWS)[number]['id'];

export default async function WorkPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string; search?: string }>;
}) {
  await requireOwnerPage('/work');
  const params = await searchParams;

  const view = VIEWS.find((entry) => entry.id === params.view) ?? VIEWS[0];
  const search = params.search ?? '';

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-4">
      <header>
        <h1 className="text-xl font-semibold">Work</h1>
        <p className="mt-0.5 text-sm text-[var(--color-text-muted)]">{view.blurb}</p>
      </header>

      <nav aria-label="Work views" className="flex flex-wrap gap-1.5">
        {VIEWS.map((entry) => (
          <Link
            key={entry.id}
            href={entry.id === 'active' ? '/work' : `/work?view=${entry.id}`}
            aria-current={entry.id === view.id ? 'page' : undefined}
            className={cn(
              'rounded-full border px-3 py-1.5 text-sm transition-colors',
              entry.id === view.id
                ? 'border-[var(--color-accent)] bg-[var(--color-accent-soft)] font-medium text-[var(--color-accent-text)]'
                : 'border-[var(--color-border)] text-[var(--color-text-muted)] hover:border-[var(--color-border-strong)] hover:text-[var(--color-text)]',
            )}
          >
            {entry.label}
          </Link>
        ))}
      </nav>

      {view.missionFilter ? (
        <Missions filterId={view.missionFilter} search={search} viewId={view.id} />
      ) : (
        <Projects />
      )}

      {/*
        Every screen this destination absorbed, named and linked.

        Not decoration: the rail no longer carries these, so this is the navigation to them. A
        destination that leaves the rail must not take its feature with it, and the way that rots
        silently is by nobody linking to it once the tab is gone.
      */}
      <nav
        aria-label="Related screens"
        className="flex flex-wrap gap-x-4 gap-y-1.5 border-t border-[var(--color-border)] pt-3 text-xs text-[var(--color-text-subtle)]"
      >
        <Link
          href="/portfolio"
          className="underline underline-offset-2 hover:text-[var(--color-text)]"
        >
          Portfolio
        </Link>
        <Link
          href="/projects"
          className="underline underline-offset-2 hover:text-[var(--color-text)]"
        >
          Projects
        </Link>
        <Link
          href="/missions"
          className="underline underline-offset-2 hover:text-[var(--color-text)]"
        >
          Missions
        </Link>
        <Link
          href="/attention"
          className="underline underline-offset-2 hover:text-[var(--color-text)]"
        >
          What needs me
        </Link>
        <Link
          href="/changes"
          className="underline underline-offset-2 hover:text-[var(--color-text)]"
        >
          What changed
        </Link>
      </nav>
    </div>
  );
}

async function Missions({
  filterId,
  search,
  viewId,
}: {
  filterId: string;
  search: string;
  viewId: ViewId;
}) {
  const services = await getServices();
  const filter = MISSION_FILTERS.find((entry) => entry.id === filterId) ?? MISSION_FILTERS[0];

  const page = await services.missions.list({
    ...(filter && filter.states.length > 0 ? { states: filter.states } : {}),
    ...(search.length > 0 ? { search } : {}),
    limit: 100,
  });

  /*
   * "Open" is the absence of finished work rather than a list of states to enumerate, and history
   * is its complement. Both are computed here rather than added to MISSION_FILTERS, because the
   * mission inbox's own filter list is a contract its tests pin.
   */
  const items =
    viewId === 'active'
      ? page.items.filter(
          (entry) => entry.mission.state !== 'completed' && entry.mission.state !== 'cancelled',
        )
      : viewId === 'history'
        ? page.items.filter(
            (entry) => entry.mission.state === 'completed' || entry.mission.state === 'cancelled',
          )
        : page.items;

  return <MissionList missions={items} activeFilter={filterId} search={search} />;
}

async function Projects() {
  const services = await getServices();
  const page = await services.projects.list({ limit: 60, sort: 'recent_activity' });
  const assessments = await services.briefings.assessMany(page.items.map((project) => project.id));

  if (page.items.length === 0) {
    return (
      <p className="rounded-[var(--radius-card)] border border-dashed border-[var(--color-border)] px-4 py-6 text-sm text-[var(--color-text-muted)]">
        No projects yet. Describe an idea on the Jarvis screen and agree to it — the project and its
        repository are made for you.
      </p>
    );
  }

  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2">
        {page.items.map((project) => (
          <ProjectCard
            key={project.id}
            project={project}
            assessment={assessments.get(project.id)}
          />
        ))}
      </div>
      <div className="flex flex-wrap gap-3 text-sm">
        <Link
          href="/projects"
          className="inline-flex items-center gap-1.5 text-[var(--color-accent-text)] underline underline-offset-2"
        >
          <FolderGit2 className="h-4 w-4" aria-hidden />
          All projects and filters
        </Link>
        <Link
          href="/portfolio"
          className="inline-flex items-center gap-1.5 text-[var(--color-accent-text)] underline underline-offset-2"
        >
          <LayoutGrid className="h-4 w-4" aria-hidden />
          Portfolio
        </Link>
      </div>
    </>
  );
}
