import type { SourceCapability } from '@/domain/enums';
import type { EvidenceInput } from '@/domain/evidence';
import type { ProjectSource } from '@/domain/project';
import type {
  FetchContext,
  ProviderHealth,
  RepositoryFile,
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
  /**
   * Responses keyed by `owner/repo`, checked before the queue.
   *
   * Tests that care *which* repository fails should use this rather than the positional queue,
   * so the assertion does not silently depend on the order `syncAll` happens to visit sources in.
   */
  snapshotsByRepo = new Map<string, SourceSnapshot>();
  /** Every `owner/repo` asked for, in order, so a test can assert what was and was not called. */
  requested: string[] = [];
  /**
   * Files keyed by `owner/repo:path`, checked by `fetchFile`.
   *
   * An unknown key returns null, the same way the real provider answers for a path that does not
   * exist, so a test that forgets to script a file sees the missing-file path rather than a throw.
   */
  files = new Map<string, RepositoryFile>();
  /** Every `owner/repo:path` asked for, in order. */
  requestedFiles: string[] = [];
  describeError: Error | null = null;
  listError: Error | null = null;
  fileError: Error | null = null;

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
    const found = this.repositories.find((item) => item.owner === owner && item.repo === repo);
    return found ?? makeRepositorySummary({ owner, repo });
  }

  /** Scripts one file. The key is the same `owner/repo:path` shape `fetchFile` looks up. */
  setFile(key: string, file: RepositoryFile): void {
    this.files.set(key, file);
  }

  async fetchFile(input: {
    readonly owner: string;
    readonly repo: string;
    readonly path: string;
    readonly ref?: string;
    readonly maxBytes?: number;
  }): Promise<RepositoryFile | null> {
    if (this.fileError) throw this.fileError;
    const key = `${input.owner}/${input.repo}:${input.path}`;
    this.requestedFiles.push(key);
    return this.files.get(key) ?? null;
  }

  async fetchSnapshot(source: ProjectSource, _context: FetchContext): Promise<SourceSnapshot> {
    this.calls += 1;
    const key = source.github ? `${source.github.owner}/${source.github.repo}` : '';
    this.requested.push(key);

    const keyed = this.snapshotsByRepo.get(key);
    if (keyed) return keyed;

    const next = this.snapshots.length > 1 ? this.snapshots.shift() : this.snapshots[0];
    return next ?? emptySnapshot();
  }
}

export function makeRepositorySummary(
  overrides: Partial<RepositorySummary> = {},
): RepositorySummary {
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

export function makeRepositoryFile(overrides: Partial<RepositoryFile> = {}): RepositoryFile {
  const owner = overrides.owner ?? 'test-owner';
  const repo = overrides.repo ?? 'aurora';
  const path = overrides.path ?? 'docs/architecture.md';
  const commitSha = overrides.commitSha ?? 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
  const text = overrides.text ?? '# Architecture\n\nAurora is a fixture.\n';
  return {
    owner,
    repo,
    path,
    requestedRef: 'main',
    commitSha,
    blobSha: 'b7e23ec29af22b0b4e41da31e868d57226121c84',
    text,
    byteSize: Buffer.byteLength(text, 'utf8'),
    lineCount: text.split('\n').length,
    truncated: false,
    htmlUrl: `https://github.com/${owner}/${repo}/blob/${commitSha}/${path}`,
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
