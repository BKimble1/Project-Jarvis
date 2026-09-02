import type { SyncStatus } from './enums';

/** View-facing types describing an external source connection. */

export interface RateLimitState {
  readonly limit: number | null;
  readonly remaining: number | null;
  readonly resetAt: string | null;
  readonly resource: string | null;
}

export interface RepositorySummary {
  readonly id: number;
  readonly owner: string;
  readonly repo: string;
  readonly fullName: string;
  readonly description: string | null;
  readonly visibility: 'public' | 'private' | 'internal' | null;
  readonly archived: boolean;
  readonly primaryLanguage: string | null;
  readonly updatedAt: string | null;
  readonly url: string;
  readonly permissions: { readonly admin: boolean; readonly push: boolean; readonly pull: boolean };
}

export interface ImportableRepository extends RepositorySummary {
  readonly alreadyImported: boolean;
  readonly importedProjectId: string | null;
}

export interface ProviderHealth {
  readonly configured: boolean;
  readonly ok: boolean;
  readonly message: string;
  readonly account: string | null;
  readonly rateLimit: RateLimitState | null;
  /** Always true: Jarvis has no write client. Rendered on the Settings screen. */
  readonly readOnly: true;
}

export interface SyncRunRecord {
  readonly id: string;
  readonly projectId: string | null;
  readonly sourceId: string | null;
  readonly trigger: 'manual' | 'scheduled' | 'import';
  readonly status: SyncStatus;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly evidenceWritten: number;
  readonly categoryResults: Record<string, { ok: boolean; reason?: string; count?: number }>;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
  readonly rateLimitRemaining: number | null;
  readonly rateLimitLimit: number | null;
  readonly rateLimitResetAt: string | null;
}

export interface SyncOutcome {
  readonly projectId: string;
  readonly projectName: string;
  readonly status: SyncStatus;
  readonly evidenceWritten: number;
  readonly message: string;
  readonly runId: string | null;
  readonly skipped?: 'locked' | 'no_source' | 'not_configured';
}

export interface ActivityRecordView {
  readonly id: string;
  readonly projectId: string | null;
  readonly kind: string;
  readonly summary: string;
  readonly detail: Record<string, unknown>;
  readonly createdAt: string;
}
