import { projectInputSchema } from '@/domain/project';
import type { Project } from '@/domain/project';
import { repositorySlug } from '@/domain/repository-name';
import { ConfigurationError } from '@/domain/errors';
import type {
  ActivityLogService,
  ProjectRepository,
  SourceRepository,
} from '@/server/repositories/types';
import type {
  RepositoryHandle,
  RepositoryProvisioner,
} from '@/server/providers/github/provisioner';

/**
 * Turning a decision into somewhere for the work to live.
 *
 * The owner said: "I should not normally create a project, create a mission, select a playbook,
 * approve a task graph, or navigate to an administration screen." This is the first half of making
 * that true. When a conversation reaches "go ahead", something has to make the project record, the
 * repository and the link between them, and it has to do it without a person visiting three
 * screens.
 *
 * ## Why the order is what it is
 *
 * Every step here can fail, and the sequence can be run again afterwards. The requirement is not
 * that it never fails — it is that running it twice leaves one repository and one project rather
 * than two. So each step asks whether its own work is already done before doing it:
 *
 * 1. **Is a project already linked to this repository name?** If it is, this whole sequence has
 *    already run to at least that point, and the answer is that project. This is the check that
 *    catches the exact failure the owner named: GitHub succeeded, the database write after it did
 *    not, and the retry must adopt the repository rather than make another.
 * 2. **Does the repository exist?** `ensure` looks before creating and adopts a name collision.
 * 3. **Does the project exist?** By name, which the database also enforces as unique.
 * 4. **Is the source row there?** Added if not.
 * 5. **The goal**, which is a plain column and safe to overwrite with the same value.
 *
 * The steps are ordered so the irreversible one — creating a repository on somebody's GitHub
 * account — happens after everything that could tell us it is unnecessary and before everything
 * that only needs a database. If it did happen last, a database failure would have to be undone by
 * deleting a repository, and Jarvis has no method that deletes one.
 *
 * ## What it will not do
 *
 * It will not create a repository when no provisioning credential is configured, and it will not
 * quietly carry on as though it had. An installation with no `GITHUB_PROVISION_TOKEN` gets a
 * project with no repository and a note saying exactly that, which is a true statement about a
 * usable outcome. Inventing a repository URL would not be.
 */

export interface ProvisionProjectRequest {
  /** What the owner called it, in their words. Slugged for GitHub, kept as-is for the project. */
  readonly name: string;
  /** One sentence on what "done" means. Stored as the project's goal. */
  readonly goal: string | null;
  readonly description: string | null;
  /** False only when the owner explicitly asked for no repository. */
  readonly withRepository?: boolean;
}

export interface ProvisionedProject {
  readonly project: Project;
  /** Null when no repository was made — either not asked for, or not possible here. */
  readonly repository: RepositoryHandle | null;
  /** True when nothing new was created because it was all already there. */
  readonly reused: boolean;
  /** Plain sentences about what happened, including what did not. Shown to the owner verbatim. */
  readonly notes: readonly string[];
}

export interface ProjectProvisioningDeps {
  readonly projects: ProjectRepository;
  readonly sources: SourceRepository;
  readonly provisioner: RepositoryProvisioner;
  readonly activity: ActivityLogService;
}

export class ProjectProvisioningService {
  constructor(private readonly deps: ProjectProvisioningDeps) {}

  async provision(request: ProvisionProjectRequest): Promise<ProvisionedProject> {
    const slug = repositorySlug(request.name);
    const notes: string[] = [];
    const wantsRepository = request.withRepository ?? true;

    /*
     * Step 1. Somebody — probably this same sequence, a moment ago — may already have linked a
     * repository of this name to a project. Adopting it is the whole recovery path.
     */
    const linked = await this.findLinkedProject(slug);
    if (linked) {
      const repository = wantsRepository ? await this.describeLinked(slug, linked.owner) : null;
      const project = await this.applyGoal(linked.project, request.goal);
      return {
        project,
        repository,
        reused: true,
        notes: [
          `${project.name} already exists and is connected to ${linked.owner}/${slug}. Nothing new was created.`,
        ],
      };
    }

    /* Step 2. The repository, before anything that only touches the database. */
    let repository: RepositoryHandle | null = null;
    if (wantsRepository) {
      if (!this.deps.provisioner.isConfigured()) {
        notes.push(
          'No repository was created: this installation has no GitHub provisioning credential. Set GITHUB_PROVISION_TOKEN, or make the repository yourself and connect it from the project screen.',
        );
      } else {
        repository = await this.deps.provisioner.ensure({
          name: slug,
          description: request.description ?? request.goal,
        });
        notes.push(
          repository.created
            ? `Created the private repository ${repository.fullName}.`
            : `${repository.fullName} already existed, so it was used rather than creating another.`,
        );
      }
    }

    /* Step 3. The project record. Found by name first, because the name is unique in the table. */
    const existing = await this.deps.projects.findByName(request.name);
    const project =
      existing ??
      (await this.deps.projects.create(
        projectInputSchema.parse({
          name: request.name,
          shortName: null,
          description: request.description,
          type: 'software',
          status: 'active',
          phase: 'Starting',
          goal: request.goal,
          priority: 'medium',
          tags: [],
          links: repository ? [{ label: 'Repository', url: repository.url }] : [],
        }),
      ));
    if (!existing) notes.push(`Created the project ${project.name}.`);

    /* Step 4. The link, which is what makes the repository show up as this project's evidence. */
    if (repository) {
      const source = await this.deps.sources.findGithubSource(repository.owner, repository.repo);
      if (!source) {
        await this.deps.sources.addGithubSource(project.id, {
          owner: repository.owner,
          repo: repository.repo,
          isPrimary: true,
        });
      }
    }

    const withGoal = await this.applyGoal(project, request.goal);

    await this.deps.activity.record({
      projectId: withGoal.id,
      kind: 'project_created',
      summary: repository
        ? `Jarvis started ${withGoal.name} and ${repository.created ? 'created' : 'connected'} ${repository.fullName}.`
        : `Jarvis started ${withGoal.name}.`,
      detail: {
        repository: repository?.fullName ?? null,
        /* Recorded so "was it private?" is answerable from the log rather than from GitHub. */
        private: repository?.isPrivate ?? null,
        createdRepository: repository?.created ?? false,
      },
    });

    return { project: withGoal, repository, reused: false, notes };
  }

  /**
   * The project a repository of this name is already attached to.
   *
   * Searched across every GitHub source rather than by a guessed owner, because the owner depends
   * on configuration that may have changed since the first attempt, and the repository name is the
   * part that does not.
   */
  private async findLinkedProject(
    slug: string,
  ): Promise<{ readonly project: Project; readonly owner: string } | null> {
    const sources = await this.deps.sources.listAllGithubSources();
    const match = sources.find((source) => source.github?.repo.toLowerCase() === slug);
    if (!match?.github) return null;
    const project = await this.deps.projects.findById(match.projectId);
    if (!project) return null;
    return { project, owner: match.github.owner };
  }

  private async describeLinked(slug: string, owner: string): Promise<RepositoryHandle | null> {
    if (!this.deps.provisioner.isConfigured()) return null;
    try {
      return await this.deps.provisioner.find(owner, slug);
    } catch {
      /*
       * The link is what matters here, and it is already in the database. Failing the whole
       * recovery because GitHub was briefly unreachable would turn a transient error into a
       * duplicate repository on the next attempt, which is the one outcome this method exists to
       * prevent.
       */
      return null;
    }
  }

  /** Set the goal if there is one and it is not already what it should be. */
  private async applyGoal(project: Project, goal: string | null): Promise<Project> {
    if (!goal || project.goal === goal) return project;
    return this.deps.projects.update(project.id, { goal });
  }
}

export { ConfigurationError };
