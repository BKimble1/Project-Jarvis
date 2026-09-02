import type { Metadata } from 'next';
import { requireOwnerPage } from '@/server/auth/guard';
import { getServices } from '@/server/container';
import { MissionList } from '@/components/mission/mission-list';
import { MISSION_FILTERS } from '@/lib/mission-filters';
import { MissionStartBar } from '@/components/mission/mission-start-bar';

export const metadata: Metadata = { title: 'Missions' };
export const dynamic = 'force-dynamic';

/**
 * The mission inbox.
 *
 * The default view is everything unfinished. Filters live in the URL, so a view is shareable and
 * survives a refresh.
 */
export default async function MissionsPage({
  searchParams,
}: {
  searchParams: Promise<{ filter?: string; search?: string }>;
}) {
  await requireOwnerPage('/missions');
  const params = await searchParams;
  const services = await getServices();

  const filterId = params.filter ?? 'open';
  const filter = MISSION_FILTERS.find((entry) => entry.id === filterId) ?? MISSION_FILTERS[0];
  const search = params.search ?? '';

  const page = await services.missions.list({
    ...(filter && filter.states.length > 0 ? { states: filter.states } : {}),
    ...(search.length > 0 ? { search } : {}),
    limit: 100,
  });

  /* The "open" filter is the absence of finished work rather than a list of states to enumerate. */
  const items =
    filterId === 'open'
      ? page.items.filter(
          (entry) => entry.mission.state !== 'completed' && entry.mission.state !== 'cancelled',
        )
      : page.items;

  const projects = await services.projects.list({ limit: 200 });

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-4">
      <header>
        <h1 className="text-xl font-semibold">Missions</h1>
        <p className="mt-0.5 text-sm text-[var(--color-text-muted)]">
          Jarvis plans before it acts, and every plan is yours to approve. Nothing merges, publishes
          or deploys.
        </p>
      </header>

      <MissionStartBar
        projects={projects.items.map((project) => ({
          id: project.id,
          name: project.shortName ?? project.name,
        }))}
      />

      <MissionList missions={items} activeFilter={filterId} search={search} />
    </div>
  );
}
