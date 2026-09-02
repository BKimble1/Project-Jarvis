import type { EvidenceInput } from '@/domain/evidence';
import type { GithubSourceState, ProjectSource } from '@/domain/project';
import type { SourceCapability, SourceKind } from '@/domain/enums';
import type { ProviderHealth, RateLimitState, RepositorySummary } from '@/domain/integrations';

export type { ProviderHealth, RateLimitState, RepositorySummary };

export interface CategoryOutcome {
  readonly ok: boolean;
  /** Owner-readable explanation when `ok` is false — never a raw provider payload. */
  readonly reason?: string;
  readonly count?: number;
}

/** The complete result of asking a provider "what do you know about this source right now?". */
export interface SourceSnapshot {
  /** `ok` — everything requested was retrieved. `partial` — some categories were unavailable. */
  readonly status: 'ok' | 'partial' | 'failed';
  readonly repo: GithubSourceState | null;
  readonly evidence: readonly EvidenceInput[];
  readonly categories: Readonly<Partial<Record<SourceCapability, CategoryOutcome>>>;
  readonly available: readonly SourceCapability[];
  readonly unavailable: readonly SourceCapability[];
  readonly rateLimit: RateLimitState | null;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
}

export interface FetchLimits {
  readonly commitLimit: number;
  readonly prLimit: number;
  readonly issueLimit: number;
  readonly workflowLimit: number;
  readonly releaseLimit: number;
  readonly deploymentLimit: number;
  readonly historyDays: number;
  readonly timeoutMs: number;
}

export interface FetchContext {
  readonly projectId: string;
  readonly sourceId: string;
  readonly now: Date;
  readonly limits: FetchLimits;
}

/**
 * A read-only integration with an external system.
 *
 * Phase 1 ships a single implementation (`GitHubSourceProvider`). Everything above this
 * interface — synchronisation, evidence storage, the status engine — is provider-agnostic,
 * so later phases can add App Store Connect, Netlify or Linear without touching them.
 */
export interface SourceProvider {
  readonly kind: SourceKind;
  /** False when the credential is missing; callers surface this instead of failing a sync. */
  isConfigured(): boolean;
  fetchSnapshot(source: ProjectSource, context: FetchContext): Promise<SourceSnapshot>;
  /** Repositories the configured credential can see. Used by the import screen. */
  listAvailableRepositories(options?: {
    search?: string;
    limit?: number;
  }): Promise<readonly RepositorySummary[]>;
  /** Confirms a specific repository is reachable before it is imported. */
  describeRepository(owner: string, repo: string): Promise<RepositorySummary>;
  checkHealth(): Promise<ProviderHealth>;
}
