import type { EvidenceInput } from '@/domain/evidence';
import type { SourceCapability } from '@/domain/enums';
import type { GithubSourceState, ProjectSource } from '@/domain/project';
import { ConfigurationError } from '@/domain/errors';
import type { AppConfig } from '@/server/config/env';
import { getConfig } from '@/server/config/env';
import { logger as rootLogger, type Logger } from '@/server/logging/logger';
import type {
  CategoryOutcome,
  FetchContext,
  ProviderHealth,
  RateLimitState,
  RepositorySummary,
  SourceProvider,
  SourceSnapshot,
} from '../types';
import {
  createGithubClient,
  GithubApiError,
  translateGithubError,
  type GithubClient,
} from './client';
import {
  checkRunEvidence,
  commitEvidence,
  deploymentEvidence,
  isMeaningfulCommit,
  issueEvidence,
  normalizeRepository,
  pullRequestEvidence,
  releaseEvidence,
  repositoryEvidence,
  workflowRunEvidence,
} from './normalize';

/**
 * The read-only GitHub source provider.
 *
 * Design rules
 * ------------
 * - **Category isolation.** Each data category (commits, PRs, issues, workflows, checks,
 *   releases, deployments) is fetched independently. A repository with Actions disabled, Issues
 *   disabled, or a credential without a particular permission produces a *partial* snapshot,
 *   never a failed one.
 * - **Metadata is the only hard requirement.** If repository metadata cannot be read, the
 *   repository is genuinely unreachable and the snapshot fails — and even then the caller keeps
 *   the previously stored evidence and marks it stale.
 * - **Bounded history.** Every category is limited by both a row count and a time window, so a
 *   single synchronisation can never walk years of history.
 */
export class GitHubSourceProvider implements SourceProvider {
  readonly kind = 'github_repo' as const;

  private readonly config: AppConfig;
  private readonly log: Logger;
  private readonly clientFactory: () => GithubClient;

  constructor(
    options: { config?: AppConfig; logger?: Logger; clientFactory?: () => GithubClient } = {},
  ) {
    this.config = options.config ?? getConfig();
    this.log = (options.logger ?? rootLogger()).child({ provider: 'github' });
    this.clientFactory =
      options.clientFactory ??
      (() => {
        if (!this.config.githubReadToken) {
          throw new ConfigurationError('GITHUB_READ_TOKEN is not configured.');
        }
        return createGithubClient({
          token: this.config.githubReadToken,
          baseUrl: this.config.githubApiBaseUrl,
          timeoutMs: this.config.sync.timeoutMs,
        });
      });
  }

  isConfigured(): boolean {
    try {
      if (this.config.githubReadToken) return true;
      /* A factory injected by tests counts as configured even without an env token. */
      this.clientFactory();
      return true;
    } catch {
      return false;
    }
  }

  async checkHealth(): Promise<ProviderHealth> {
    if (!this.isConfigured()) {
      return {
        configured: false,
        ok: false,
        message: 'No GitHub token is configured. Add GITHUB_READ_TOKEN to connect repositories.',
        account: null,
        rateLimit: null,
        readOnly: true,
      };
    }
    const client = this.clientFactory();
    try {
      const me = await client.octokit.rest.users.getAuthenticated();
      return {
        configured: true,
        ok: true,
        message: 'Connected with read-only access.',
        account: typeof me.data?.login === 'string' ? me.data.login : null,
        rateLimit: client.rateLimit(),
        readOnly: true,
      };
    } catch (error) {
      const translated = translateGithubError(error, client.rateLimit());
      return {
        configured: true,
        ok: false,
        message: translated.message,
        account: null,
        rateLimit: translated.rateLimit ?? client.rateLimit(),
        readOnly: true,
      };
    }
  }

  async listAvailableRepositories(
    options: { search?: string; limit?: number } = {},
  ): Promise<readonly RepositorySummary[]> {
    const client = this.clientFactory();
    const limit = Math.min(options.limit ?? 100, 300);
    const collected: RepositorySummary[] = [];
    try {
      for (let page = 1; page <= 3 && collected.length < limit; page += 1) {
        const response = await client.octokit.rest.repos.listForAuthenticatedUser({
          per_page: 100,
          page,
          sort: 'pushed',
          direction: 'desc',
        });
        const items = Array.isArray(response.data) ? response.data : [];
        for (const item of items) collected.push(toSummary(item));
        if (items.length < 100) break;
      }
    } catch (error) {
      throw translateGithubError(error, client.rateLimit());
    }

    const search = options.search?.trim().toLowerCase();
    const filtered = search
      ? collected.filter(
          (repo) =>
            repo.fullName.toLowerCase().includes(search) ||
            (repo.description ?? '').toLowerCase().includes(search),
        )
      : collected;
    return filtered.slice(0, limit);
  }

  async describeRepository(owner: string, repo: string): Promise<RepositorySummary> {
    const client = this.clientFactory();
    try {
      const response = await client.octokit.rest.repos.get({ owner, repo });
      return toSummary(response.data);
    } catch (error) {
      throw translateGithubError(error, client.rateLimit());
    }
  }

  async fetchSnapshot(source: ProjectSource, context: FetchContext): Promise<SourceSnapshot> {
    const github = source.github;
    if (!github) {
      return failedSnapshot('malformed', 'This source is not a GitHub repository.', null);
    }

    let client: GithubClient;
    try {
      client = this.clientFactory();
    } catch {
      return failedSnapshot(
        'configuration_error',
        'No GitHub token is configured, so this repository cannot be synchronised.',
        null,
      );
    }

    const categories: Partial<Record<SourceCapability, CategoryOutcome>> = {};
    const evidence: EvidenceInput[] = [];
    const fallbackObservedAt = context.now.toISOString();
    const normalizeContext = {
      projectId: context.projectId,
      sourceId: context.sourceId,
      fallbackObservedAt,
    };
    const since = new Date(context.now.getTime() - context.limits.historyDays * 86_400_000);

    /* ------------------------------------------------------ metadata (required) */
    let repoState: GithubSourceState;
    let repoPayload: unknown;
    try {
      const response = await client.octokit.rest.repos.get({
        owner: github.owner,
        repo: github.repo,
      });
      repoPayload = response.data;
      const normalized = normalizeRepository(response.data);
      if (!normalized) {
        return failedSnapshot(
          'malformed',
          'GitHub returned a repository record Jarvis could not read.',
          client.rateLimit(),
        );
      }
      repoState = normalized;
      categories.metadata = { ok: true, count: 1 };
      evidence.push(repositoryEvidence(repoState, repoPayload, normalizeContext));
    } catch (error) {
      const translated = translateGithubError(error, client.rateLimit());
      this.log.warn('github metadata fetch failed', {
        owner: github.owner,
        repo: github.repo,
        kind: translated.kind,
      });
      return failedSnapshot(
        translated.kind,
        translated.message,
        translated.rateLimit ?? client.rateLimit(),
      );
    }

    /* A renamed repository is followed transparently by GitHub; record the new coordinates. */
    const owner = repoState.owner;
    const repo = repoState.repo;
    const emptyRepository =
      (num(repoPayload, 'size') ?? 0) === 0 && repoState.lastActivityAt === null;

    /* --------------------------------------------------------------- commits */
    await this.category(categories, 'commits', async () => {
      if (repoState.defaultBranch === null && emptyRepository) {
        return { ok: true, count: 0, note: 'The repository has no commits yet.' };
      }
      const response = await client.octokit.rest.repos.listCommits({
        owner,
        repo,
        per_page: Math.min(context.limits.commitLimit, 100),
        since: since.toISOString(),
      });
      const items = Array.isArray(response.data) ? response.data : [];
      let written = 0;
      for (const item of items.slice(0, context.limits.commitLimit)) {
        const normalized = commitEvidence(item, normalizeContext);
        if (!normalized) continue;
        if (!isMeaningfulCommit(normalized.title)) continue;
        evidence.push(normalized);
        written += 1;
      }
      return { ok: true, count: written };
    });

    /* --------------------------------------------------------- pull requests */
    await this.category(categories, 'pull_requests', async () => {
      const [open, recent] = await Promise.all([
        client.octokit.rest.pulls.list({
          owner,
          repo,
          state: 'open',
          per_page: Math.min(context.limits.prLimit, 100),
          sort: 'updated',
          direction: 'desc',
        }),
        client.octokit.rest.pulls.list({
          owner,
          repo,
          state: 'closed',
          per_page: Math.min(context.limits.prLimit, 100),
          sort: 'updated',
          direction: 'desc',
        }),
      ]);
      const items = [
        ...(Array.isArray(open.data) ? open.data : []),
        ...(Array.isArray(recent.data) ? recent.data : []),
      ];
      let written = 0;
      for (const item of items.slice(0, context.limits.prLimit * 2)) {
        const normalized = pullRequestEvidence(item, normalizeContext);
        if (!normalized) continue;
        if (new Date(normalized.observedAt) < since && normalized.metadata.state !== 'open')
          continue;
        evidence.push(normalized);
        written += 1;
      }
      return { ok: true, count: written };
    });

    /* ---------------------------------------------------------------- issues */
    await this.category(categories, 'issues', async () => {
      if (bool(repoPayload, 'has_issues') === false) {
        return { ok: true, count: 0, note: 'Issues are disabled for this repository.' };
      }
      const response = await client.octokit.rest.issues.listForRepo({
        owner,
        repo,
        state: 'all',
        per_page: Math.min(context.limits.issueLimit, 100),
        sort: 'updated',
        direction: 'desc',
        since: since.toISOString(),
      });
      const items = Array.isArray(response.data) ? response.data : [];
      let written = 0;
      for (const item of items.slice(0, context.limits.issueLimit)) {
        const normalized = issueEvidence(item, normalizeContext);
        if (!normalized) continue;
        evidence.push(normalized);
        written += 1;
      }
      return { ok: true, count: written };
    });

    /* --------------------------------------------------------- workflow runs */
    let latestHeadSha: string | null = null;
    await this.category(categories, 'workflow_runs', async () => {
      const response = await client.octokit.rest.actions.listWorkflowRunsForRepo({
        owner,
        repo,
        per_page: Math.min(context.limits.workflowLimit, 100),
      });
      const data = obj(response.data);
      const items = Array.isArray(data.workflow_runs) ? data.workflow_runs : [];
      if (items.length === 0) {
        return { ok: true, count: 0, note: 'No workflow runs found.' };
      }
      let written = 0;
      for (const item of items.slice(0, context.limits.workflowLimit)) {
        const enriched =
          item && typeof item === 'object'
            ? {
                ...(item as Record<string, unknown>),
                repository: { default_branch: repoState.defaultBranch },
              }
            : item;
        const normalized = workflowRunEvidence(enriched, normalizeContext);
        if (!normalized) continue;
        if (latestHeadSha === null && typeof normalized.metadata.headSha === 'string') {
          latestHeadSha = normalized.metadata.headSha;
        }
        evidence.push(normalized);
        written += 1;
      }
      return { ok: true, count: written };
    });

    /* ---------------------------------------------------------------- checks */
    await this.category(categories, 'checks', async () => {
      const ref = latestHeadSha ?? repoState.defaultBranch;
      if (!ref) return { ok: true, count: 0, note: 'No commit to inspect checks for.' };
      const response = await client.octokit.rest.checks.listForRef({
        owner,
        repo,
        ref,
        per_page: 30,
      });
      const data = obj(response.data);
      const items = Array.isArray(data.check_runs) ? data.check_runs : [];
      let written = 0;
      for (const item of items) {
        const normalized = checkRunEvidence(item, normalizeContext);
        if (!normalized) continue;
        evidence.push(normalized);
        written += 1;
      }
      return { ok: true, count: written };
    });

    /* -------------------------------------------------------------- releases */
    await this.category(categories, 'releases', async () => {
      const response = await client.octokit.rest.repos.listReleases({
        owner,
        repo,
        per_page: Math.min(context.limits.releaseLimit, 100),
      });
      const items = Array.isArray(response.data) ? response.data : [];
      let written = 0;
      for (const item of items.slice(0, context.limits.releaseLimit)) {
        const normalized = releaseEvidence(item, normalizeContext);
        if (!normalized) continue;
        evidence.push(normalized);
        written += 1;
      }
      return { ok: true, count: written };
    });

    /* ----------------------------------------------------------- deployments */
    await this.category(categories, 'deployments', async () => {
      const response = await client.octokit.rest.repos.listDeployments({
        owner,
        repo,
        per_page: Math.min(context.limits.deploymentLimit, 100),
      });
      const items = Array.isArray(response.data) ? response.data : [];
      if (items.length === 0) return { ok: true, count: 0, note: 'No deployments recorded.' };
      let written = 0;
      for (const item of items.slice(0, context.limits.deploymentLimit)) {
        const deploymentId = num(item, 'id');
        let statusPayload: unknown = null;
        if (deploymentId !== null) {
          try {
            const statuses = await client.octokit.rest.repos.listDeploymentStatuses({
              owner,
              repo,
              deployment_id: deploymentId,
              per_page: 1,
            });
            statusPayload = Array.isArray(statuses.data) ? statuses.data[0] : null;
          } catch {
            /* Deployment statuses need an extra permission; the deployment itself still counts. */
            statusPayload = null;
          }
        }
        const normalized = deploymentEvidence(item, statusPayload, normalizeContext);
        if (!normalized) continue;
        evidence.push(normalized);
        written += 1;
      }
      return { ok: true, count: written };
    });

    const available = (Object.keys(categories) as SourceCapability[]).filter(
      (key) => categories[key]?.ok,
    );
    const unavailable = (Object.keys(categories) as SourceCapability[]).filter(
      (key) => !categories[key]?.ok,
    );

    return {
      status: unavailable.length === 0 ? 'ok' : 'partial',
      repo: repoState,
      evidence,
      categories,
      available,
      unavailable,
      rateLimit: client.rateLimit(),
      errorCode: null,
      errorMessage:
        unavailable.length === 0 ? null : `Some data was unavailable: ${unavailable.join(', ')}.`,
    };
  }

  /** Runs one category, converting any failure into a recorded outcome rather than a throw. */
  private async category(
    into: Partial<Record<SourceCapability, CategoryOutcome>>,
    capability: SourceCapability,
    run: () => Promise<{ ok: true; count: number; note?: string }>,
  ): Promise<void> {
    try {
      const result = await run();
      into[capability] = {
        ok: true,
        count: result.count,
        ...(result.note ? { reason: result.note } : {}),
      };
    } catch (error) {
      const translated =
        error instanceof GithubApiError ? error : translateGithubError(error, null);
      /* An empty repository is a legitimate state, not a failure of the category. */
      if (translated.kind === 'empty_repository') {
        into[capability] = { ok: true, count: 0, reason: 'The repository has no commits yet.' };
        return;
      }
      into[capability] = { ok: false, reason: translated.message };
      this.log.warn('github category unavailable', { capability, kind: translated.kind });
      /* Rate limiting and revoked credentials affect every remaining category; surface loudly. */
      if (translated.kind === 'rate_limited' || translated.kind === 'unauthorized')
        throw translated;
    }
  }
}

function failedSnapshot(
  code: string,
  message: string,
  rateLimit: RateLimitState | null,
): SourceSnapshot {
  return {
    status: 'failed',
    repo: null,
    evidence: [],
    categories: {},
    available: [],
    unavailable: [],
    rateLimit,
    errorCode: code,
    errorMessage: message,
  };
}

function obj(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function num(payload: unknown, key: string): number | null {
  const value = obj(payload)[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function bool(payload: unknown, key: string): boolean | null {
  const value = obj(payload)[key];
  return typeof value === 'boolean' ? value : null;
}

function toSummary(payload: unknown): RepositorySummary {
  const repo = obj(payload);
  const owner = obj(repo.owner);
  const permissions = obj(repo.permissions);
  const login = typeof owner.login === 'string' ? owner.login : '';
  const name = typeof repo.name === 'string' ? repo.name : '';
  const visibilityRaw = typeof repo.visibility === 'string' ? repo.visibility : null;
  return {
    id: typeof repo.id === 'number' ? repo.id : 0,
    owner: login,
    repo: name,
    fullName: typeof repo.full_name === 'string' ? repo.full_name : `${login}/${name}`,
    description: typeof repo.description === 'string' ? repo.description : null,
    visibility:
      visibilityRaw === 'public' || visibilityRaw === 'private' || visibilityRaw === 'internal'
        ? visibilityRaw
        : repo.private === true
          ? 'private'
          : repo.private === false
            ? 'public'
            : null,
    archived: repo.archived === true,
    primaryLanguage: typeof repo.language === 'string' ? repo.language : null,
    updatedAt:
      typeof repo.pushed_at === 'string'
        ? repo.pushed_at
        : typeof repo.updated_at === 'string'
          ? repo.updated_at
          : null,
    url: typeof repo.html_url === 'string' ? repo.html_url : `https://github.com/${login}/${name}`,
    permissions: {
      admin: permissions.admin === true,
      push: permissions.push === true,
      pull: permissions.pull !== false,
    },
  };
}
