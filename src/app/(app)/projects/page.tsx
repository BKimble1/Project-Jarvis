import type { Metadata } from 'next';
import Link from 'next/link';
import { FolderGit2, FolderPlus } from 'lucide-react';
import { PROJECT_PRIORITIES, PROJECT_STATUSES, PROJECT_TYPES } from '@/domain/enums';
import type { ProjectListFilter } from '@/server/repositories/types';
import { getServices } from '@/server/container';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { ProjectCard } from '@/components/project-card';
import { ProjectFilters } from '@/components/project-filters';
import { RestoreButton } from '@/components/archive-actions';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Projects' };

type Search = Record<string, string | string[] | undefined>;

const one = (value: string | string[] | undefined): string | undefined =>
  Array.isArray(value) ? value[0] : value;

const oneOf = <T extends string>(
  value: string | undefined,
  allowed: readonly T[],
): T | undefined =>
  value && (allowed as readonly string[]).includes(value) ? (value as T) : undefined;

export default async function ProjectsPage({ searchParams }: { searchParams: Promise<Search> }) {
  const params = await searchParams;
  const services = await getServices();

  const status = oneOf(one(params.status), PROJECT_STATUSES);
  const type = oneOf(one(params.type), PROJECT_TYPES);
  const priority = oneOf(one(params.priority), PROJECT_PRIORITIES);
  const tag = one(params.tag);
  const sort = oneOf(one(params.sort), [
    'recent_activity',
    'attention',
    'priority',
    'staleness',
    'name',
    'created',
  ] as const);

  const filter: ProjectListFilter = {
    ...(one(params.search) ? { search: one(params.search) as string } : {}),
    ...(status ? { statuses: [status] } : {}),
    ...(type ? { types: [type] } : {}),
    ...(priority ? { priorities: [priority] } : {}),
    ...(tag ? { tags: [tag] } : {}),
    ...(sort ? { sort } : {}),
    includeArchived: one(params.archived) === 'true',
  };

  const [page, tags] = await Promise.all([
    services.projects.list(filter),
    services.projects.allTags(),
  ]);
  const projectIds = page.items.map((project) => project.id);
  const assessments = await services.briefings.assessMany(projectIds);

  /*
   * The same repository signals the dashboard shows. Read from stored evidence in one query, so
   * a card never means something different depending on which screen it appears on.
   */
  const openPullRequests = new Map<string, number>();
  if (projectIds.length > 0) {
    const pullRequests = await services.evidence.list({
      projectIds,
      kinds: ['pull_request'],
      limit: 400,
    });
    for (const item of pullRequests) {
      if (item.metadata.state !== 'open') continue;
      openPullRequests.set(item.projectId, (openPullRequests.get(item.projectId) ?? 0) + 1);
    }
  }
  const failingBuilds = new Map<string, number>();
  for (const [projectId, assessment] of assessments) {
    const failures = assessment.attention.filter(
      (reason) => reason.code === 'failed_workflow',
    ).length;
    if (failures > 0) failingBuilds.set(projectId, failures);
  }
  const hasFilters = Boolean(
    one(params.search) || status || type || priority || tag || one(params.archived),
  );

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold sm:text-xl">Projects</h1>
          <p className="text-sm text-[var(--color-text-muted)]">
            {page.total} project{page.total === 1 ? '' : 's'}
            {hasFilters ? ' matching your filters' : ''}.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button asChild variant="secondary" size="sm">
            <Link href="/projects/import">
              <FolderGit2 className="h-4 w-4" aria-hidden />
              Import repository
            </Link>
          </Button>
          <Button asChild size="sm">
            <Link href="/projects/new">
              <FolderPlus className="h-4 w-4" aria-hidden />
              Add project
            </Link>
          </Button>
        </div>
      </header>

      <ProjectFilters tags={tags} />

      {page.items.length === 0 ? (
        <EmptyState
          title={hasFilters ? 'No projects match those filters' : 'No projects yet'}
          description={
            hasFilters
              ? 'Try widening the search, or clear the filters to see everything.'
              : 'Add a project manually, or import a repository Jarvis can read.'
          }
          action={
            hasFilters ? (
              <Button asChild variant="secondary" size="sm">
                <Link href="/projects">Clear filters</Link>
              </Button>
            ) : (
              <Button asChild size="sm">
                <Link href="/projects/new">Add a project</Link>
              </Button>
            )
          }
        />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {page.items.map((project) => (
            <div key={project.id} className="flex flex-col gap-2">
              <ProjectCard
                project={project}
                assessment={assessments.get(project.id)}
                openPullRequests={openPullRequests.get(project.id) ?? 0}
                failingBuilds={failingBuilds.get(project.id) ?? 0}
              />
              {project.archivedAt ? (
                <RestoreButton projectId={project.id} projectName={project.name} />
              ) : null}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
