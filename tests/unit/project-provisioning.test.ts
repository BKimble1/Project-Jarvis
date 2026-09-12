import { describe, expect, it } from 'vitest';

import type { Project, ProjectSource } from '@/domain/project';
import type {
  ActivityLogService,
  ProjectRepository,
  SourceRepository,
} from '@/server/repositories/types';
import type {
  ProvisionRequest,
  RepositoryHandle,
  RepositoryProvisioner,
} from '@/server/providers/github/provisioner';
import { ProjectProvisioningService } from '@/server/services/project-provisioning';

/**
 * Starting a project without a person visiting three screens.
 *
 * The behaviour under test is not "it creates things" — that part is a handful of calls. It is
 * what happens when the sequence fails halfway and runs again, because that is the case the owner
 * named: *"If GitHub creation succeeds and a subsequent database operation fails, recover the
 * relationship rather than creating another repository."* A retry that produces `rent-tracker-2`
 * is a retry that has quietly cost somebody a deletion they have to do by hand.
 */

/* ------------------------------------------------------------------ fakes */

class FakeProvisioner implements RepositoryProvisioner {
  readonly created: string[] = [];
  private readonly repos = new Map<string, RepositoryHandle>();
  private failNext: Error | null = null;

  constructor(private readonly configured = true) {}

  isConfigured(): boolean {
    return this.configured;
  }
  describeTarget(): string | null {
    return this.configured ? 'blake' : null;
  }
  async find(owner: string, repo: string): Promise<RepositoryHandle | null> {
    return this.repos.get(`${owner}/${repo}`) ?? null;
  }
  async ensure(request: ProvisionRequest): Promise<RepositoryHandle> {
    const key = `blake/${request.name}`;
    const found = this.repos.get(key);
    if (found) return { ...found, created: false };
    if (this.failNext) {
      const error = this.failNext;
      this.failNext = null;
      throw error;
    }
    const handle: RepositoryHandle = {
      owner: 'blake',
      repo: request.name,
      fullName: key,
      url: `https://github.com/${key}`,
      defaultBranch: 'main',
      isPrivate: true,
      created: true,
    };
    this.repos.set(key, handle);
    this.created.push(key);
    return handle;
  }
  failOnce(error: Error): void {
    this.failNext = error;
  }
}

function fakeProject(name: string, id: string): Project {
  return {
    id,
    name,
    shortName: null,
    description: null,
    type: 'software',
    status: 'active',
    phase: 'Starting',
    goal: null,
    priority: 'medium',
    targetDate: null,
    icon: null,
    color: null,
    tags: [],
    links: [],
    archivedAt: null,
    freshness: 'fresh',
    needsAttention: false,
    lastSyncedAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  } as unknown as Project;
}

class FakeProjects {
  readonly rows = new Map<string, Project>();
  private next = 0;
  /** Set to make the write after repository creation fail, exactly once. */
  failCreateOnce: Error | null = null;

  async create(input: { name: string; goal?: string | null }): Promise<Project> {
    if (this.failCreateOnce) {
      const error = this.failCreateOnce;
      this.failCreateOnce = null;
      throw error;
    }
    this.next += 1;
    const project = {
      ...fakeProject(input.name, `p${this.next}`),
      goal: input.goal ?? null,
    } as Project;
    this.rows.set(project.id, project);
    return project;
  }
  async update(id: string, input: { goal?: string | null }): Promise<Project> {
    const current = this.rows.get(id)!;
    const updated = { ...current, goal: input.goal ?? current.goal } as Project;
    this.rows.set(id, updated);
    return updated;
  }
  async findById(id: string): Promise<Project | null> {
    return this.rows.get(id) ?? null;
  }
  async findByName(name: string): Promise<Project | null> {
    return [...this.rows.values()].find((row) => row.name === name) ?? null;
  }
  async listAllForAssessment(): Promise<readonly Project[]> {
    return [...this.rows.values()];
  }
}

class FakeSources {
  readonly rows: ProjectSource[] = [];
  async addGithubSource(
    projectId: string,
    input: { owner: string; repo: string; isPrimary: boolean },
  ): Promise<ProjectSource> {
    const row = {
      id: `s${this.rows.length + 1}`,
      projectId,
      kind: 'github_repo',
      isPrimary: input.isPrimary,
      github: { owner: input.owner, repo: input.repo },
    } as unknown as ProjectSource;
    this.rows.push(row);
    return row;
  }
  async findGithubSource(owner: string, repo: string): Promise<ProjectSource | null> {
    return (
      this.rows.find((row) => row.github?.owner === owner && row.github?.repo === repo) ?? null
    );
  }
  async listAllGithubSources(): Promise<readonly ProjectSource[]> {
    return this.rows;
  }
}

const activity: ActivityLogService = {
  async record() {},
  async listByProject() {
    return [];
  },
  async listRecent() {
    return [];
  },
  async deleteOlderThan() {
    return 0;
  },
};

function build(provisioner = new FakeProvisioner()) {
  const projects = new FakeProjects();
  const sources = new FakeSources();
  const service = new ProjectProvisioningService({
    projects: projects as unknown as ProjectRepository,
    sources: sources as unknown as SourceRepository,
    provisioner,
    activity,
  });
  return { service, projects, sources, provisioner };
}

/* ------------------------------------------------------------------ tests */

describe('starting a project from a decision', () => {
  it('creates the project, a private repository and the link between them', async () => {
    const { service, sources, provisioner } = build();
    const result = await service.provision({
      name: 'Rent Tracker',
      goal: 'Track rent across the flats.',
      description: null,
    });

    expect(result.project.name).toBe('Rent Tracker');
    expect(result.project.goal).toBe('Track rent across the flats.');
    expect(result.repository?.fullName).toBe('blake/rent-tracker');
    expect(result.repository?.isPrivate).toBe(true);
    expect(provisioner.created).toEqual(['blake/rent-tracker']);
    expect(await sources.findGithubSource('blake', 'rent-tracker')).not.toBeNull();
  });

  it('never makes a public repository, whatever it is asked for', async () => {
    /*
     * The visibility is written at the call to GitHub and is not derived from an argument, so
     * there is no argument here to pass. That is the point of the test: the type does not offer
     * one, and a caller cannot ask for a public repository even by mistake.
     */
    const { service } = build();
    const result = await service.provision({ name: 'Anything', goal: null, description: null });
    expect(result.repository?.isPrivate).toBe(true);
  });
});

describe('running the same sequence twice', () => {
  it('adopts the repository it already made instead of making another', async () => {
    /*
     * The failure the owner named, reproduced exactly: GitHub succeeded, the database write after
     * it did not, and the whole thing is running again. One repository must exist at the end.
     */
    const { service, projects, provisioner } = build();
    projects.failCreateOnce = new Error('connection lost');

    await expect(
      service.provision({ name: 'Rent Tracker', goal: null, description: null }),
    ).rejects.toThrow('connection lost');
    expect(provisioner.created).toEqual(['blake/rent-tracker']);

    const recovered = await service.provision({
      name: 'Rent Tracker',
      goal: 'Track rent.',
      description: null,
    });

    expect(provisioner.created).toEqual(['blake/rent-tracker']);
    expect(recovered.repository?.fullName).toBe('blake/rent-tracker');
    expect(recovered.repository?.created).toBe(false);
    expect(recovered.project.goal).toBe('Track rent.');
  });

  it('returns the same project rather than a second one when everything succeeded', async () => {
    const { service, projects, provisioner } = build();
    const first = await service.provision({ name: 'Rent Tracker', goal: null, description: null });
    const second = await service.provision({ name: 'Rent Tracker', goal: null, description: null });

    expect(second.project.id).toBe(first.project.id);
    expect(second.reused).toBe(true);
    expect(provisioner.created).toHaveLength(1);
    expect(projects.rows.size).toBe(1);
  });

  it('adds exactly one source row, however many times it runs', async () => {
    const { service, sources } = build();
    await service.provision({ name: 'Rent Tracker', goal: null, description: null });
    await service.provision({ name: 'Rent Tracker', goal: null, description: null });
    await service.provision({ name: 'Rent Tracker', goal: null, description: null });
    expect(sources.rows).toHaveLength(1);
  });
});

describe('when this installation cannot create repositories', () => {
  it('makes the project and says plainly that there is no repository', async () => {
    /*
     * The alternative — inventing a URL, or failing the whole thing — is worse than a project with
     * a note attached. The note names the variable, because "it did not work" is not something a
     * person can act on.
     */
    const { service, provisioner } = build(new FakeProvisioner(false));
    const result = await service.provision({
      name: 'Rent Tracker',
      goal: null,
      description: null,
    });

    expect(result.project.name).toBe('Rent Tracker');
    expect(result.repository).toBeNull();
    expect(provisioner.created).toEqual([]);
    expect(result.notes.join(' ')).toContain('GITHUB_PROVISION_TOKEN');
  });
});
