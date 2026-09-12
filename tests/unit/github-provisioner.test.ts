import { describe, expect, it, vi } from 'vitest';
import { RequestError } from '@octokit/request-error';

import type { AppConfig } from '@/server/config/env';
import { GithubRepositoryProvisioner, type Octokit } from '@/server/providers/github/provisioner';

/**
 * The only writing GitHub client in Jarvis.
 *
 * Everything else reaches GitHub through a client whose fetch wrapper throws on any method that is
 * not GET or HEAD. This one can create a repository, so what it does — and more importantly what
 * it cannot be made to do — is worth pinning down rather than trusting to the token's scopes.
 */

const config = (over: Partial<AppConfig> = {}) =>
  ({
    githubProvisionToken: 'a-token',
    githubProvisionOwner: null,
    githubApiBaseUrl: 'https://api.github.com',
    ...over,
  }) as unknown as AppConfig;

interface Repo {
  name: string;
  full_name: string;
  html_url: string;
  private: boolean;
  default_branch?: string;
  owner: { login: string } | null;
}

function fakeOctokit(existing: readonly Repo[] = []) {
  const repos = new Map(existing.map((repo) => [repo.full_name, repo]));
  const createCalls: Record<string, unknown>[] = [];

  const notFound = () =>
    new RequestError('Not Found', 404, {
      request: { method: 'GET', url: 'https://api.github.com', headers: {} },
    });

  const octokit = {
    rest: {
      users: {
        getAuthenticated: vi.fn(async () => ({ data: { login: 'blake' } })),
      },
      repos: {
        get: vi.fn(async ({ owner, repo }: { owner: string; repo: string }) => {
          const found = repos.get(`${owner}/${repo}`);
          if (!found) throw notFound();
          return { data: found };
        }),
        createForAuthenticatedUser: vi.fn(async (input: Record<string, unknown>) => {
          createCalls.push(input);
          const repo: Repo = {
            name: String(input.name),
            full_name: `blake/${String(input.name)}`,
            html_url: `https://github.com/blake/${String(input.name)}`,
            private: input.private === true,
            default_branch: 'main',
            owner: { login: 'blake' },
          };
          repos.set(repo.full_name, repo);
          return { data: repo };
        }),
        createInOrg: vi.fn(async (input: Record<string, unknown>) => {
          createCalls.push(input);
          const repo: Repo = {
            name: String(input.name),
            full_name: `${String(input.org)}/${String(input.name)}`,
            html_url: `https://github.com/${String(input.org)}/${String(input.name)}`,
            private: input.private === true,
            default_branch: 'main',
            owner: { login: String(input.org) },
          };
          repos.set(repo.full_name, repo);
          return { data: repo };
        }),
      },
    },
  };

  return { octokit: octokit as unknown as Octokit, createCalls, repos };
}

describe('creating a repository', () => {
  it('always asks for a private one, and for an initial commit', async () => {
    /*
     * `auto_init` matters more than it looks. Without it the repository has no commits and no
     * default branch, and the worker clones with `--single-branch --branch <defaultBranch>`, which
     * fails — with no way out, because `git init` is not on the worker's allow-list.
     */
    const { octokit, createCalls } = fakeOctokit();
    const provisioner = new GithubRepositoryProvisioner({
      config: config(),
      clientFactory: () => octokit,
    });

    const handle = await provisioner.ensure({ name: 'rent-tracker', description: 'Track rent.' });

    expect(createCalls).toHaveLength(1);
    expect(createCalls[0]).toMatchObject({ private: true, auto_init: true, name: 'rent-tracker' });
    expect(handle.isPrivate).toBe(true);
    expect(handle.created).toBe(true);
    expect(handle.defaultBranch).toBe('main');
  });

  it('uses a repository that is already there rather than creating a second', async () => {
    const { octokit, createCalls } = fakeOctokit([
      {
        name: 'rent-tracker',
        full_name: 'blake/rent-tracker',
        html_url: 'https://github.com/blake/rent-tracker',
        private: true,
        default_branch: 'main',
        owner: { login: 'blake' },
      },
    ]);
    const provisioner = new GithubRepositoryProvisioner({
      config: config(),
      clientFactory: () => octokit,
    });

    const handle = await provisioner.ensure({ name: 'rent-tracker', description: null });

    expect(createCalls).toHaveLength(0);
    expect(handle.created).toBe(false);
    expect(handle.fullName).toBe('blake/rent-tracker');
  });

  it('adopts the winner when two callers raced and GitHub refused the loser', async () => {
    /*
     * Two ticks close enough together that both looked, both saw nothing, and both tried. GitHub
     * answers the loser with a 422 naming the collision — which is not a failure here, it is the
     * other caller's success.
     */
    const { octokit } = fakeOctokit();
    let looked = 0;
    const raced = {
      name: 'rent-tracker',
      full_name: 'blake/rent-tracker',
      html_url: 'https://github.com/blake/rent-tracker',
      private: true,
      default_branch: 'main',
      owner: { login: 'blake' },
    };
    octokit.rest.repos.get = vi.fn(async () => {
      looked += 1;
      /* Absent on the first look, present on the second — the other caller landed in between. */
      if (looked === 1) {
        throw new RequestError('Not Found', 404, {
          request: { method: 'GET', url: 'https://api.github.com', headers: {} },
        });
      }
      return { data: raced };
    }) as unknown as typeof octokit.rest.repos.get;
    octokit.rest.repos.createForAuthenticatedUser = vi.fn(async () => {
      throw new RequestError('Repository creation failed.', 422, {
        request: { method: 'POST', url: 'https://api.github.com', headers: {} },
        response: {
          status: 422,
          url: 'https://api.github.com',
          headers: {},
          data: { errors: [{ message: 'name already exists on this account' }] },
        },
      });
    }) as unknown as typeof octokit.rest.repos.createForAuthenticatedUser;

    const provisioner = new GithubRepositoryProvisioner({
      config: config(),
      clientFactory: () => octokit,
    });

    const handle = await provisioner.ensure({ name: 'rent-tracker', description: null });
    expect(handle.fullName).toBe('blake/rent-tracker');
    expect(handle.created).toBe(false);
  });

  it('creates under the configured organisation when there is one', async () => {
    const { octokit, createCalls } = fakeOctokit();
    const provisioner = new GithubRepositoryProvisioner({
      config: config({ githubProvisionOwner: 'kimble-labs' }),
      clientFactory: () => octokit,
    });

    const handle = await provisioner.ensure({ name: 'rent-tracker', description: null });
    expect(createCalls[0]).toMatchObject({ org: 'kimble-labs', private: true });
    expect(handle.owner).toBe('kimble-labs');
    /* And it never asked who the token belongs to, because it did not need to. */
    expect(octokit.rest.users.getAuthenticated).not.toHaveBeenCalled();
  });
});

describe('when nothing is configured', () => {
  it('says so instead of pretending it could', async () => {
    const provisioner = new GithubRepositoryProvisioner({
      config: config({ githubProvisionToken: null }),
    });
    expect(provisioner.isConfigured()).toBe(false);
    expect(provisioner.describeTarget()).toBeNull();
    await expect(provisioner.ensure({ name: 'x', description: null })).rejects.toThrow(
      /GITHUB_PROVISION_TOKEN/,
    );
  });
});

describe('a repository that is not there', () => {
  it('is null rather than an error, because not existing is the normal case', async () => {
    const { octokit } = fakeOctokit();
    const provisioner = new GithubRepositoryProvisioner({
      config: config(),
      clientFactory: () => octokit,
    });
    expect(await provisioner.find('blake', 'nothing-here')).toBeNull();
  });
});
