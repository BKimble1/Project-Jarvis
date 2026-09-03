import type {
  ConflictKind,
  ConflictState,
  KnowledgeCategory,
  KnowledgeConfidence,
  KnowledgeConflict,
  KnowledgeExcerpt,
  KnowledgeItem,
  KnowledgeOrigin,
  KnowledgeScope,
  KnowledgeStatus,
} from '@/domain/knowledge';
import type {
  KnowledgeChunk,
  KnowledgeSource,
  ParsedChunk,
  SourceFailureCode,
  SourceKind,
  SourceState,
} from '@/domain/knowledge-source';
import type { AnswerClaim, AnswerCoverage, AnswerMethod, AnswerScope } from '@/domain/answer';
import type { Sensitivity } from '@/domain/retrieval';
import type { MissionSuggestion } from '@/domain/answer';

/**
 * The persistence boundary for personal knowledge and for answers.
 *
 * Two things are deliberately *not* here. There is no `deleteChunks` that leaves the text behind,
 * and no `findAll` that ignores status: forgetting has to be destructive to be honest, and
 * retrieval has to be status-aware or a suggestion becomes a fact by accident.
 */

/* ----------------------------------------------------------------- sources */

export interface SourceCreateInput {
  readonly kind: SourceKind;
  readonly title: string;
  readonly origin: string;
  readonly contentHash: string;
  readonly projectId?: string | null;
  readonly byteSize: number;
  readonly charCount: number;
  readonly contentType?: string | null;
  readonly unitCount?: number | null;
  readonly bodyText?: string | null;
  readonly tags?: readonly string[];
  readonly truncated?: boolean;
  readonly addedBy: string;
  readonly retainUntil?: Date | null;

  /* ---------------------------------------------------------------- 4B */
  /** Who may retrieve from this source. The single authority for authorization. */
  readonly scope?: KnowledgeScope;
  readonly sensitivity?: Sensitivity;
  /** Whether the origin can be read again. A note cannot; a URL or repository file can. */
  readonly refreshable?: boolean;
}

export interface SourcePatch {
  readonly state?: SourceState;
  readonly title?: string;
  readonly chunkCount?: number;
  readonly charCount?: number;
  readonly unitCount?: number | null;
  readonly bodyText?: string | null;
  readonly truncated?: boolean;
  readonly failureCode?: SourceFailureCode | null;
  readonly failureMessage?: string | null;
  readonly retryCount?: number;
  readonly parsedAt?: Date | null;
  readonly deletedAt?: Date | null;
  readonly retainUntil?: Date | null;
  readonly projectId?: string | null;
  readonly tags?: readonly string[];
  readonly scope?: KnowledgeScope;
  readonly sensitivity?: Sensitivity;
  readonly activeRevisionId?: string | null;
  readonly lastRefreshedAt?: Date | null;
}

export interface SourceListFilter {
  readonly projectId?: string | null;
  readonly states?: readonly SourceState[];
  readonly kinds?: readonly SourceKind[];
  readonly includeDeleted?: boolean;
  readonly limit?: number;
}

export interface SourceRepositoryKnowledge {
  create(input: SourceCreateInput): Promise<KnowledgeSource>;
  findById(id: string): Promise<KnowledgeSource | null>;
  /** Only matches a source that still exists, so re-adding a deleted file is allowed. */
  findLiveByHash(contentHash: string): Promise<KnowledgeSource | null>;
  list(filter?: SourceListFilter): Promise<readonly KnowledgeSource[]>;
  patch(id: string, patch: SourcePatch): Promise<KnowledgeSource>;
  /** Text and chunks are destroyed, not flagged. Returns how many chunks went. */
  purge(id: string): Promise<number>;
  /** Sources whose stated retention window has passed. */
  dueForRetention(now: Date): Promise<readonly KnowledgeSource[]>;
  readBody(id: string): Promise<string | null>;
}

/* ------------------------------------------------------------------ chunks */

export interface ChunkRepository {
  replaceForSource(
    sourceId: string,
    projectId: string | null,
    chunks: readonly ParsedChunk[],
  ): Promise<number>;
  findById(id: string): Promise<KnowledgeChunk | null>;
  findByIds(ids: readonly string[]): Promise<readonly KnowledgeChunk[]>;
  listForSource(sourceId: string): Promise<readonly KnowledgeChunk[]>;
  /**
   * Ranked full-text search.
   *
   * Ranking happens in the database against a real index, not in memory over a truncated window:
   * an in-memory scorer that only ever sees the newest N rows silently answers a different
   * question from the one asked.
   */
  search(input: {
    readonly query: string;
    readonly projectIds?: readonly string[];
    readonly limit?: number;
  }): Promise<readonly ScoredChunk[]>;
}

export interface ScoredChunk {
  readonly chunk: KnowledgeChunk;
  readonly score: number;
  readonly sourceTitle: string;
  readonly sourceKind: SourceKind;
}

/* ------------------------------------------------------------------- items */

export interface KnowledgeCreateInput {
  readonly scope: KnowledgeScope;
  readonly category: KnowledgeCategory;
  readonly origin: KnowledgeOrigin;
  readonly status: KnowledgeStatus;
  readonly statusRule: string;
  readonly statement: string;
  readonly detail?: string | null;
  readonly projectId?: string | null;
  readonly missionId?: string | null;
  readonly sourceId?: string | null;
  readonly sourceRef?: string | null;
  readonly excerpts?: readonly KnowledgeExcerpt[];
  readonly tags?: readonly string[];
  readonly createdBy: string;
  readonly confidence?: KnowledgeConfidence | null;
  readonly reviewAt?: Date | null;
  readonly expiresAt?: Date | null;
  readonly supersedesId?: string | null;
  readonly confirmedAt?: Date | null;
  readonly confirmedBy?: string | null;
  readonly sensitivity?: Sensitivity;
}

export interface KnowledgePatch {
  readonly status?: KnowledgeStatus;
  readonly statement?: string;
  readonly detail?: string | null;
  readonly tags?: readonly string[];
  readonly excerpts?: readonly KnowledgeExcerpt[];
  readonly confirmedAt?: Date | null;
  readonly confirmedBy?: string | null;
  readonly rejectedReason?: string | null;
  readonly reviewAt?: Date | null;
  readonly expiresAt?: Date | null;
  readonly supersededById?: string | null;
  readonly supersededReason?: string | null;
  readonly forgottenAt?: Date | null;
  readonly projectId?: string | null;
  readonly category?: KnowledgeCategory;
  readonly scope?: KnowledgeScope;
  readonly sensitivity?: Sensitivity;
}

export interface KnowledgeListFilter {
  readonly scopes?: readonly KnowledgeScope[];
  readonly categories?: readonly KnowledgeCategory[];
  readonly statuses?: readonly KnowledgeStatus[];
  readonly origins?: readonly KnowledgeOrigin[];
  readonly projectId?: string | null;
  readonly sourceId?: string | null;
  readonly search?: string | null;
  readonly limit?: number;
}

export interface ScoredKnowledge {
  readonly item: KnowledgeItem;
  readonly score: number;
}

export interface KnowledgeRepository {
  create(input: KnowledgeCreateInput): Promise<KnowledgeItem>;
  findById(id: string): Promise<KnowledgeItem | null>;
  findByIds(ids: readonly string[]): Promise<readonly KnowledgeItem[]>;
  list(filter?: KnowledgeListFilter): Promise<readonly KnowledgeItem[]>;
  patch(id: string, patch: KnowledgePatch): Promise<KnowledgeItem>;
  /** Ranked search over active items only. Statuses are not a caller's choice here. */
  searchActive(input: {
    readonly query: string;
    readonly scopes?: readonly KnowledgeScope[];
    readonly projectIds?: readonly string[];
    readonly limit?: number;
  }): Promise<readonly ScoredKnowledge[]>;
  /** Active items for a retrieval context, newest and most-used first. */
  activeForContext(input: {
    readonly scopes: readonly KnowledgeScope[];
    readonly projectIds?: readonly string[];
    readonly limit?: number;
  }): Promise<readonly KnowledgeItem[]>;
  countsByStatus(): Promise<Readonly<Record<KnowledgeStatus, number>>>;
  dueForReview(now: Date, limit?: number): Promise<readonly KnowledgeItem[]>;
  /**
   * Destroy the content of an item, keeping the row as a record that it existed.
   *
   * Statement, detail, excerpts and the search vector all go. The generated column is derived
   * from the emptied statement, so there is no separate index to remember to purge — which is
   * exactly why it is a generated column.
   */
  forget(id: string, now: Date): Promise<KnowledgeItem>;
  recordUse(ids: readonly string[], now: Date): Promise<void>;
  /** Items sharing a scope, category and project — the candidate set for conflict detection. */
  siblings(item: KnowledgeItem): Promise<readonly KnowledgeItem[]>;
}

/* --------------------------------------------------------------- conflicts */

export interface ConflictCreateInput {
  readonly kind: ConflictKind;
  readonly leftId: string;
  readonly rightId: string | null;
  readonly projectId?: string | null;
  readonly summary: string;
  readonly detectedRule: string;
}

export interface ConflictRepository {
  /** Idempotent: the same pair and kind cannot be raised twice. */
  record(input: ConflictCreateInput): Promise<KnowledgeConflict>;
  list(state?: ConflictState): Promise<readonly KnowledgeConflict[]>;
  findById(id: string): Promise<KnowledgeConflict | null>;
  resolve(id: string, resolution: string, now: Date): Promise<KnowledgeConflict>;
  openCount(): Promise<number>;
}

/* ----------------------------------------------------------------- answers */

export interface AnswerCreateInput {
  readonly question: string;
  readonly scope: AnswerScope;
  readonly projectIds: readonly string[];
  readonly headline: string;
  readonly claims: readonly AnswerClaim[];
  readonly considered: AnswerCoverage;
  readonly method: AnswerMethod;
  readonly rejectionRule?: string | null;
  readonly rejectionReason?: string | null;
  readonly missionSuggestion?: MissionSuggestion | null;
  readonly savedView?: string | null;
  readonly durationMs?: number | null;
  readonly askedBy: string;
}

export interface StoredAnswer extends AnswerCreateInput {
  readonly id: string;
  readonly generatedAt: string;
}

export interface AnswerRepository {
  record(input: AnswerCreateInput): Promise<StoredAnswer>;
  findById(id: string): Promise<StoredAnswer | null>;
  recent(limit?: number): Promise<readonly StoredAnswer[]>;
}
