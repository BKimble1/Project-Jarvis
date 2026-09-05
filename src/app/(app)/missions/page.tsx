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
 *
 * `request` and `projectId` are how the command bar hands work over: the owner typed the request
 * on the dashboard, and it arrives here written into the start bar rather than asking them to
 * type it again. Nothing is created by arriving — the two presses on the start bar still apply.
 */
export default async function MissionsPage({
  searchParams,
}: {
  searchParams: Promise<{
    filter?: string;
    search?: string;
    request?: string;
    projectId?: string;
  }>;
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
  const projectOptions = projects.items.map((project) => ({
    id: project.id,
    name: project.shortName ?? project.name,
  }));

  /*
   * A project handed over in the URL is only honoured when it is one the select can show. An
   * unknown id would leave the field displaying the first project while holding a different one,
   * and the mission would be created against a project the owner never saw named.
   */
  const handedProject = projectOptions.find((option) => option.id === params.projectId);

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
        projects={projectOptions}
        {...(params.request ? { initialRequest: params.request } : {})}
        {...(handedProject ? { defaultProjectId: handedProject.id } : {})}
      />

      <MissionList missions={items} activeFilter={filterId} search={search} />
    </div>
  );
}
