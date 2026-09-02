import type { SourceCapability } from '@/domain/enums';
import type { EvidenceInput } from '@/domain/evidence';
import type { ProjectSource } from '@/domain/project';
import type {
  FetchContext,
  ProviderHealth,
  RepositorySummary,
  SourceProvider,
  SourceSnapshot,
} from '@/server/providers/types';

/**
 * A scriptable stand-in for a source provider.
 *
 * Integration tests use it to drive the synchronisation service through success, partial success
 * and failure without touching the network.
 */
export class FakeSourceProvider implements SourceProvider {
  readonly kind = 'github_repo' as const;

  configured = true;
  calls = 0;
  repositories: RepositorySummary[] = [];
  /** Queue of snapshots; the last one repeats once the queue is exhausted. */
  snapshots: SourceSnapshot[] = [];
  describeError: Error | null = null;
  listError: Error | null = null;

  isConfigured(): boolean {
    return this.configured;
  }

  async checkHealth(): Promise<ProviderHealth> {
    return {
      configured: this.configured,
      ok: this.configured,
      message: this.configured ? 'Connected with read-only access.' : 'No token configured.',
      account: 'test-owner',
      rateLimit: null,
      readOnly: true,
    };
  }

  async listAvailableRepositories(): Promise<readonly RepositorySummary[]> {
    if (this.listError) throw this.listError;
    return this.repositories;
  }

  async describeRepository(owner: string, repo: string): Promise<RepositorySummary> {
    if (this.describeError) throw this.describeError;
    const found = this.repositories.find(
      (item) => item.owner === owner && item.repo === repo,
    );
    return found ?? makeRepositorySummary({ owner, repo });
  }

  async fetchSnapshot(_source: ProjectSource, _context: FetchContext): Promise<SourceSnapshot> {
    this.calls += 1;
    const next = this.snapshots.length > 1 ? this.snapshots.shift() : this.snapshots[0];
    return next ?? emptySnapshot();
  }
}

export function makeRepositorySummary(overrides: Partial<RepositorySummary> = {}): RepositorySummary {
  const owner = overrides.owner ?? 'test-owner';
  const repo = overrides.repo ?? 'aurora';
  return {
    id: 1001,
    owner,
    repo,
    fullName: `${owner}/${repo}`,
    description: 'A fixture repository.',
    visibility: 'private',
    archived: false,
    primaryLanguage: 'TypeScript',
    updatedAt: new Date().toISOString(),
    url: `https://github.com/${owner}/${repo}`,
    permissions: { admin: false, push: false, pull: true },
    ...overrides,
  };
}

export function okSnapshot(
  evidence: readonly EvidenceInput[],
  overrides: Partial<SourceSnapshot> = {},
): SourceSnapshot {
  const available: SourceCapability[] = ['metadata', 'commits', 'pull_requests'];
  return {
    status: 'ok',
    repo: {
      repoId: 1001,
      owner: 'test-owner',
      repo: 'aurora',
      url: 'https://github.com/test-owner/aurora',
      visibility: 'private',
      defaultBranch: 'main',
      archived: false,
      primaryLanguage: 'TypeScript',
      lastActivityAt: new Date().toISOString(),
    },
    evidence,
    categories: { metadata: { ok: true, count: 1 } },
    available,
    unavailable: [],
    rateLimit: { limit: 5000, remaining: 4990, resetAt: null, resource: 'core' },
    errorCode: null,
    errorMessage: null,
    ...overrides,
  };
}

export function partialSnapshot(evidence: readonly EvidenceInput[]): SourceSnapshot {
  return okSnapshot(evidence, {
    status: 'partial',
    available: ['metadata', 'commits'],
    unavailable: ['issues', 'workflow_runs'],
    errorMessage: 'Some data was unavailable: issues, workflow_runs.',
  });
}

export function failedSnapshot(message = 'GitHub rejected the credential.'): SourceSnapshot {
  return {
    status: 'failed',
    repo: null,
    evidence: [],
    categories: {},
    available: [],
    unavailable: [],
    rateLimit: null,
    errorCode: 'unauthorized',
    errorMessage: message,
  };
}

function emptySnapshot(): SourceSnapshot {
  return okSnapshot([]);
}
