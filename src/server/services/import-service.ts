import { z } from 'zod';
import { ConflictError, ValidationError } from '@/domain/errors';
import { githubSourceConfigSchema, projectInputSchema, tagSchema } from '@/domain/project';
import type { Project } from '@/domain/project';
import type { RepositorySummary, SourceProvider } from '@/server/providers/types';
import type { ActivityLogService, ProjectRepository, SourceRepository } from '@/server/repositories/types';
import type { ProjectSyncService, SyncOutcome } from './sync-service';

/**
 * Importing a GitHub repository as a project.
 *
 * The import is deliberately explicit: Jarvis shows only what the configured credential can see,
 * the owner picks a repository, and the first synchronisation runs immediately so the import
 * screen can report honestly whether the result was full, partial or failed.
 */

export const importRequestSchema = githubSourceConfigSchema.extend({
  name: z.string().trim().min(1).max(120).optional(),
  type: projectInputSchema.shape.type.default('software'),
  goal: z.string().trim().max(600).optional(),
  phase: z.string().trim().max(60).optional(),
  priority: projectInputSchema.shape.priority,
  tags: z.array(tagSchema).max(20).default([]),
});
export type ImportRequest = z.infer<typeof importRequestSchema>;

export interface ImportableRepository extends RepositorySummary {
  readonly alreadyImported: boolean;
  readonly importedProjectId: string | null;
}

export interface ImportResult {
  readonly project: Project;
  readonly sync: SyncOutcome;
  readonly outcome: 'full' | 'partial' | 'failed';
  readonly message: string;
}

export interface ImportServiceDeps {
  readonly projects: ProjectRepository;
  readonly sources: SourceRepository;
  readonly provider: SourceProvider;
  readonly sync: ProjectSyncService;
  readonly activity: ActivityLogService;
}

export class GithubImportService {
  constructor(private readonly deps: ImportServiceDeps) {}

  async listImportable(search?: string): Promise<readonly ImportableRepository[]> {
    const repos = await this.deps.provider.listAvailableRepositories(search ? { search } : {});
    const existing = await this.deps.sources.listAllGithubSources();
    const index = new Map(
      existing
        .filter((source) => source.github)
        .map((source) => [
          `${source.github?.owner.toLowerCase()}/${source.github?.repo.toLowerCase()}`,
          source.projectId,
        ]),
    );

    return repos.map((repo) => {
      const key = `${repo.owner.toLowerCase()}/${repo.repo.toLowerCase()}`;
      const projectId = index.get(key) ?? null;
      return { ...repo, alreadyImported: projectId !== null, importedProjectId: projectId };
    });
  }

  async import(request: ImportRequest): Promise<ImportResult> {
    const parsed = importRequestSchema.safeParse(request);
    if (!parsed.success) {
      throw new ValidationError('That repository could not be imported.', {
        issues: parsed.error.issues.map((issue) => issue.message),
      });
    }
    const input = parsed.data;

    /* Duplicate-import prevention happens before anything is written. */
    const existing = await this.deps.sources.findGithubSource(input.owner, input.repo);
    if (existing) {
      throw new ConflictError(`${input.owner}/${input.repo} is already connected to a project.`, {
        projectId: existing.projectId,
      });
    }

    /* Confirm the repository is genuinely reachable before creating anything. */
    const summary = await this.deps.provider.describeRepository(input.owner, input.repo);

    const project = await this.deps.projects.create(
      projectInputSchema.parse({
        name: input.name ?? summary.repo,
        shortName: null,
        description: summary.description,
        type: input.type,
        status: summary.archived ? 'archived' : 'active',
        phase: input.phase ?? null,
        goal: input.goal ?? null,
        priority: input.priority,
        tags: input.tags,
        links: [{ label: 'Repository', url: summary.url }],
      }),
    );

    await this.deps.sources.addGithubSource(project.id, {
      owner: summary.owner,
      repo: summary.repo,
      isPrimary: true,
    });

    await this.deps.activity.record({
      projectId: project.id,
      kind: 'project_created',
      summary: `Imported ${summary.fullName} from GitHub.`,
      detail: { visibility: summary.visibility, archived: summary.archived },
    });

    const sync = await this.deps.sync.syncProject(project.id, 'import');
    const refreshed = (await this.deps.projects.findById(project.id)) ?? project;

    const outcome = sync.status === 'ok' ? 'full' : sync.status === 'partial' ? 'partial' : 'failed';
    const message =
      outcome === 'full'
        ? `Imported ${summary.fullName} and synchronised ${sync.evidenceWritten} record${sync.evidenceWritten === 1 ? '' : 's'}.`
        : outcome === 'partial'
          ? `Imported ${summary.fullName}, but some data could not be read. ${sync.message}`
          : `Imported ${summary.fullName}, but the first synchronisation failed. ${sync.message}`;

    return { project: refreshed, sync, outcome, message };
  }
}
