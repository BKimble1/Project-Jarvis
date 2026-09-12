import type {
  ProvisionRequest,
  RepositoryHandle,
  RepositoryProvisioner,
} from '@/server/providers/github/provisioner';

/**
 * A repository provisioner that records instead of reaching GitHub.
 *
 * It is a stand-in for the network and for nothing else: it adopts a name it has already made,
 * exactly as the real one does, so a test can prove that saying "go ahead" twice produces one
 * repository rather than two — through the real provisioning sequence, with only the HTTP replaced.
 *
 * What it deliberately cannot prove is that GitHub itself behaves this way. That question is a
 * different kind of question and is answered in `tests/live`, against a real account, opt-in.
 */
export class RecordingProvisioner implements RepositoryProvisioner {
  /** Every repository this provisioner actually created, in order. Duplicates are the bug. */
  readonly created: string[] = [];
  /** Every name it was asked for, including the ones it adopted rather than created. */
  readonly requested: string[] = [];
  private readonly made = new Map<string, RepositoryHandle>();

  constructor(private readonly owner = 'blake') {}

  isConfigured(): boolean {
    return true;
  }

  describeTarget(): string {
    return this.owner;
  }

  async find(owner: string, repo: string): Promise<RepositoryHandle | null> {
    return this.made.get(`${owner}/${repo}`) ?? null;
  }

  async ensure(request: ProvisionRequest): Promise<RepositoryHandle> {
    this.requested.push(request.name);
    const key = `${this.owner}/${request.name}`;
    const existing = this.made.get(key);
    if (existing) return { ...existing, created: false };

    const handle: RepositoryHandle = {
      owner: this.owner,
      repo: request.name,
      fullName: key,
      url: `https://github.com/${key}`,
      defaultBranch: 'main',
      isPrivate: true,
      created: true,
    };
    this.made.set(key, handle);
    this.created.push(key);
    return handle;
  }
}
