import { Octokit } from '@octokit/rest';
import { RequestError } from '@octokit/request-error';
import { ConfigurationError } from '@/domain/errors';
import type { AppConfig } from '@/server/config/env';
import { getConfig } from '@/server/config/env';
import { GithubApiError, translateGithubError } from './client';

/**
 * Making a repository that does not exist yet.
 *
 * ## Why this is not the GitHub client
 *
 * Because that client cannot do it, on purpose. `assertReadOnlyRequest` sits in its fetch wrapper
 * and throws on any method that is not GET or HEAD, so a coding mistake anywhere in the provider
 * cannot turn into a write. That guarantee is worth keeping exactly as it is, which means the one
 * thing Jarvis needs to write is a separate object with a separate credential — not a flag on the
 * old one. A boolean that switches a read-only client into a writing client is a read-only client
 * that isn't.
 *
 * ## What it can and cannot do
 *
 * Exactly two operations: look a repository up, and create one. It cannot push, delete, rename,
 * change visibility, or touch a repository that already exists — not because the token forbids it
 * (it may not) but because there is no method here that does any of those things. Everything after
 * creation is the worker's job, with the worker's own credential, inside a repository that by then
 * exists.
 *
 * ## Private, and not configurably private
 *
 * `private: true` is written at the call to GitHub and is not derived from an argument. The owner
 * said new repositories default to private; making that a parameter would mean a caller somewhere
 * could pass `false`, and the failure mode of that mistake is source code on the public internet,
 * discovered by somebody else. Publishing a repository is a deliberate act on GitHub, where the
 * confirmation dialog belongs.
 *
 * ## Why `auto_init` matters more than it looks
 *
 * A repository created without it has no commits and therefore no default branch, and the worker
 * clones with `--single-branch --branch <defaultBranch>`, which fails against an empty repository.
 * `git init` is not on the worker's command allow-list, so there would be no way out from there.
 * One commit at creation is what makes the repository usable by everything downstream.
 */

export interface RepositoryHandle {
  readonly owner: string;
  readonly repo: string;
  readonly fullName: string;
  readonly url: string;
  readonly defaultBranch: string;
  readonly isPrivate: boolean;
  /**
   * Whether this call is what brought it into existence.
   *
   * The caller needs to tell the two apart: "I made you a repository" and "you already had one and
   * I used it" are different sentences, and only one of them should be said.
   */
  readonly created: boolean;
}

export interface ProvisionRequest {
  /** The repository name. Already a slug — see `repositorySlug`. */
  readonly name: string;
  readonly description: string | null;
}

export interface RepositoryProvisioner {
  /** False when no provisioning credential is configured, which is the default. */
  isConfigured(): boolean;
  /** Where new repositories would be created, for saying so before creating one. */
  describeTarget(): string | null;
  /** Null when there is no such repository. Not an error: not existing is the normal case. */
  find(owner: string, repo: string): Promise<RepositoryHandle | null>;
  /**
   * A private repository with this name, creating it only if it is not already there.
   *
   * Idempotent by design, and the design matters: this is called from a sequence that can fail
   * halfway and be retried, and a retry that makes `thing-2` because `thing` already existed is
   * how an account ends up with four repositories for one idea.
   */
  ensure(request: ProvisionRequest): Promise<RepositoryHandle>;
}

export class GithubRepositoryProvisioner implements RepositoryProvisioner {
  private readonly config: AppConfig;
  private readonly clientFactory: () => Octokit;

  constructor(options: { config?: AppConfig; clientFactory?: () => Octokit } = {}) {
    this.config = options.config ?? getConfig();
    this.clientFactory =
      options.clientFactory ??
      (() => {
        const token = this.config.githubProvisionToken;
        if (!token) {
          throw new ConfigurationError(
            'GITHUB_PROVISION_TOKEN is not configured, so Jarvis cannot create a repository. Everything else still works; set it if you want new projects to get one automatically.',
          );
        }
        return new Octokit({ auth: token, baseUrl: this.config.githubApiBaseUrl });
      });
  }

  isConfigured(): boolean {
    return this.config.githubProvisionToken !== null;
  }

  describeTarget(): string | null {
    if (!this.isConfigured()) return null;
    return this.config.githubProvisionOwner ?? 'your own GitHub account';
  }

  async find(owner: string, repo: string): Promise<RepositoryHandle | null> {
    const octokit = this.clientFactory();
    try {
      const response = await octokit.rest.repos.get({ owner, repo });
      return handleFrom(response.data, false);
    } catch (error) {
      if (error instanceof RequestError && error.status === 404) return null;
      throw translateGithubError(error, null);
    }
  }

  async ensure(request: ProvisionRequest): Promise<RepositoryHandle> {
    const octokit = this.clientFactory();
    const org = this.config.githubProvisionOwner;

    /*
     * Look before creating, and look again after a name collision.
     *
     * The first check catches the ordinary retry — the repository was made, the database write
     * that followed it failed, and the whole sequence is running again. The second catches the
     * race that the first cannot: two ticks arriving close enough together that both looked, both
     * saw nothing, and both tried. GitHub answers the loser with a 422 naming the collision, which
     * is not a failure here — it is the other caller's success, and adopting it is right.
     */
    const owner = org ?? (await this.authenticatedLogin(octokit));
    const existing = await this.find(owner, request.name);
    if (existing) return existing;

    try {
      const response = org
        ? await octokit.rest.repos.createInOrg({
            org,
            name: request.name,
            ...(request.description ? { description: request.description } : {}),
            private: true,
            auto_init: true,
          })
        : await octokit.rest.repos.createForAuthenticatedUser({
            name: request.name,
            ...(request.description ? { description: request.description } : {}),
            private: true,
            auto_init: true,
          });
      return handleFrom(response.data, true);
    } catch (error) {
      if (error instanceof RequestError && error.status === 422 && isNameTaken(error)) {
        const raced = await this.find(owner, request.name);
        if (raced) return raced;
      }
      throw translateGithubError(error, null);
    }
  }

  private async authenticatedLogin(octokit: Octokit): Promise<string> {
    try {
      const response = await octokit.rest.users.getAuthenticated();
      return response.data.login;
    } catch (error) {
      throw translateGithubError(error, null);
    }
  }
}

interface RepositoryPayload {
  readonly name: string;
  readonly full_name: string;
  readonly html_url: string;
  readonly private: boolean;
  readonly default_branch?: string | undefined;
  readonly owner: { readonly login: string } | null;
}

function handleFrom(data: RepositoryPayload, created: boolean): RepositoryHandle {
  /*
   * `default_branch` is absent from the response to a *creation* often enough to matter — GitHub
   * fills it in once the initial commit lands. `main` is what `auto_init` produces on every account
   * created since 2020, and a wrong guess here surfaces immediately as a clone failure rather than
   * silently, so the fallback is safe to state.
   */
  return {
    owner: data.owner?.login ?? data.full_name.split('/')[0] ?? '',
    repo: data.name,
    fullName: data.full_name,
    url: data.html_url,
    defaultBranch: data.default_branch ?? 'main',
    isPrivate: data.private,
    created,
  };
}

/** GitHub's 422 for a name collision, told apart from its 422 for everything else. */
function isNameTaken(error: RequestError): boolean {
  const body = error.response?.data;
  const errors =
    body && typeof body === 'object' && 'errors' in body
      ? (body as { errors?: readonly { message?: string; field?: string }[] }).errors
      : undefined;
  if (errors?.some((entry) => /already exists/i.test(entry.message ?? ''))) return true;
  return /name already exists/i.test(error.message);
}

/** Thrown rather than returned, so a caller cannot mistake "not configured" for "no repository". */
export { GithubApiError };

/**
 * Re-exported so a test can build a fake without importing `@octokit/rest` itself.
 *
 * `no-restricted-imports` keeps every direct Octokit import inside `src/server/providers/github`,
 * which is the rule that makes "GitHub access goes through here" checkable rather than a
 * convention. A test that needed the type had two ways out — an eslint exception, or this line —
 * and this one keeps the rule intact and unqualified.
 */
export type { Octokit };
