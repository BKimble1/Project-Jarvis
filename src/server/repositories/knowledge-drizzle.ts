import { and, desc, eq, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import { NotFoundError } from '@/domain/errors';
import { KNOWLEDGE_STATUSES } from '@/domain/knowledge';
import type {
  ConflictState,
  KnowledgeConflict,
  KnowledgeItem,
  KnowledgeStatus,
} from '@/domain/knowledge';
import type { KnowledgeChunk, KnowledgeSource, SourceKind } from '@/domain/knowledge-source';
import { boundText } from '@/domain/redaction';
import type { Database } from '@/server/db/client';
import {
  answers,
  knowledgeChunks,
  knowledgeConflicts,
  knowledgeItems,
  knowledgeSources,
} from '@/server/db/schema';
import {
  toKnowledgeChunk,
  toKnowledgeConflict,
  toKnowledgeItem,
  toKnowledgeSource,
  toStoredAnswer,
} from './knowledge-mappers';
import type {
  AnswerCreateInput,
  AnswerRepository,
  ChunkRepository,
  ConflictCreateInput,
  ConflictRepository,
  KnowledgeCreateInput,
  KnowledgeListFilter,
  KnowledgePatch,
  KnowledgeRepository,
  ScoredChunk,
  ScoredKnowledge,
  SourceCreateInput,
  SourceListFilter,
  SourcePatch,
  SourceRepositoryKnowledge,
} from './knowledge-types';

/**
 * Persistence for personal knowledge.
 *
 * The two methods worth reading closely are `search` and `forget`.
 *
 * `search` uses `websearch_to_tsquery` rather than `to_tsquery`: the former accepts whatever a
 * person types, including quotes and stray operators, and cannot be made to throw by a badly
 * formed query. `plainto_tsquery` would also be safe but discards phrase quoting, which is the
 * one piece of query syntax worth honouring.
 *
 * `forget` overwrites content rather than deleting rows, and it overwrites *every* copy: the
 * statement, the detail, the excerpts and — because both search vectors are generated columns
 * derived from those — the indexes too. That is why the vectors are generated: there is no
 * separate index for a future change to forget to purge.
 */

const DEFAULT_LIMIT = 200;
const DEFAULT_SEARCH_LIMIT = 20;

export class DrizzleKnowledgeSourceRepository implements SourceRepositoryKnowledge {
  constructor(private readonly db: Database) {}

  async create(input: SourceCreateInput): Promise<KnowledgeSource> {
    const [row] = await this.db
      .insert(knowledgeSources)
      .values({
        kind: input.kind,
        title: boundText(input.title, 200),
        origin: boundText(input.origin, 500),
        contentHash: input.contentHash,
        projectId: input.projectId ?? null,
        byteSize: input.byteSize,
        charCount: input.charCount,
        contentType: input.contentType ?? null,
        unitCount: input.unitCount ?? null,
        bodyText: input.bodyText ?? null,
        tags: [...(input.tags ?? [])],
        truncated: input.truncated ?? false,
        addedBy: input.addedBy,
        retainUntil: input.retainUntil ?? null,
        ...(input.scope !== undefined ? { scope: input.scope } : {}),
        ...(input.sensitivity !== undefined ? { sensitivity: input.sensitivity } : {}),
        ...(input.refreshable !== undefined ? { refreshable: input.refreshable } : {}),
      })
      .returning();
    if (!row) throw new NotFoundError('Knowledge source');
    return toKnowledgeSource(row);
  }

  async findById(id: string): Promise<KnowledgeSource | null> {
    const [row] = await this.db
      .select()
      .from(knowledgeSources)
      .where(eq(knowledgeSources.id, id))
      .limit(1);
    return row ? toKnowledgeSource(row) : null;
  }

  async findLiveByHash(contentHash: string): Promise<KnowledgeSource | null> {
    const [row] = await this.db
      .select()
      .from(knowledgeSources)
      .where(and(eq(knowledgeSources.contentHash, contentHash), isNull(knowledgeSources.deletedAt)))
      .limit(1);
    return row ? toKnowledgeSource(row) : null;
  }

  async list(filter: SourceListFilter = {}): Promise<readonly KnowledgeSource[]> {
    const clauses = [];
    if (filter.projectId !== undefined) {
      clauses.push(
        filter.projectId === null
          ? isNull(knowledgeSources.projectId)
          : eq(knowledgeSources.projectId, filter.projectId),
      );
    }
    if (filter.states && filter.states.length > 0) {
      clauses.push(inArray(knowledgeSources.state, [...filter.states]));
    }
    if (filter.kinds && filter.kinds.length > 0) {
      clauses.push(inArray(knowledgeSources.kind, [...filter.kinds]));
    }
    if (!filter.includeDeleted) clauses.push(isNull(knowledgeSources.deletedAt));

    const rows = await this.db
      .select()
      .from(knowledgeSources)
      .where(clauses.length > 0 ? and(...clauses) : undefined)
      .orderBy(desc(knowledgeSources.createdAt))
      .limit(filter.limit ?? DEFAULT_LIMIT);
    return rows.map((row) => toKnowledgeSource(row));
  }

  async patch(id: string, patch: SourcePatch): Promise<KnowledgeSource> {
    const [row] = await this.db
      .update(knowledgeSources)
      .set({
        ...(patch.state !== undefined ? { state: patch.state } : {}),
        ...(patch.title !== undefined ? { title: boundText(patch.title, 200) } : {}),
        ...(patch.chunkCount !== undefined ? { chunkCount: patch.chunkCount } : {}),
        ...(patch.charCount !== undefined ? { charCount: patch.charCount } : {}),
        ...(patch.unitCount !== undefined ? { unitCount: patch.unitCount } : {}),
        ...(patch.bodyText !== undefined ? { bodyText: patch.bodyText } : {}),
        ...(patch.truncated !== undefined ? { truncated: patch.truncated } : {}),
        ...(patch.failureCode !== undefined ? { failureCode: patch.failureCode } : {}),
        ...(patch.failureMessage !== undefined
          ? { failureMessage: patch.failureMessage && boundText(patch.failureMessage, 500) }
          : {}),
        ...(patch.retryCount !== undefined ? { retryCount: patch.retryCount } : {}),
        ...(patch.parsedAt !== undefined ? { parsedAt: patch.parsedAt } : {}),
        ...(patch.deletedAt !== undefined ? { deletedAt: patch.deletedAt } : {}),
        ...(patch.retainUntil !== undefined ? { retainUntil: patch.retainUntil } : {}),
        ...(patch.projectId !== undefined ? { projectId: patch.projectId } : {}),
        ...(patch.tags !== undefined ? { tags: [...patch.tags] } : {}),
        ...(patch.scope !== undefined ? { scope: patch.scope } : {}),
        ...(patch.sensitivity !== undefined ? { sensitivity: patch.sensitivity } : {}),
        ...(patch.activeRevisionId !== undefined
          ? { activeRevisionId: patch.activeRevisionId }
          : {}),
        ...(patch.lastRefreshedAt !== undefined ? { lastRefreshedAt: patch.lastRefreshedAt } : {}),
        updatedAt: new Date(),
      })
      .where(eq(knowledgeSources.id, id))
      .returning();
    if (!row) throw new NotFoundError('Knowledge source');
    return toKnowledgeSource(row);
  }

  /**
   * Destroy a source's content.
   *
   * The chunks are deleted, the normalised text is nulled, the byte and character counts are
   * zeroed, and the state becomes `deleted`. The row survives so that the fact of the source is
   * still auditable — and so the same file can be added again without tripping the hash index,
   * which the partial index already permits.
   */
  async purge(id: string): Promise<number> {
    const removed = await this.db
      .delete(knowledgeChunks)
      .where(eq(knowledgeChunks.sourceId, id))
      .returning({ id: knowledgeChunks.id });

    await this.db
      .update(knowledgeSources)
      .set({
        state: 'deleted',
        bodyText: null,
        chunkCount: 0,
        charCount: 0,
        byteSize: 0,
        deletedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(knowledgeSources.id, id));

    return removed.length;
  }

  async dueForRetention(now: Date): Promise<readonly KnowledgeSource[]> {
    const rows = await this.db
      .select()
      .from(knowledgeSources)
      .where(and(lte(knowledgeSources.retainUntil, now), isNull(knowledgeSources.deletedAt)))
      .limit(100);
    return rows.map((row) => toKnowledgeSource(row));
  }

  async readBody(id: string): Promise<string | null> {
    const [row] = await this.db
      .select({ bodyText: knowledgeSources.bodyText })
      .from(knowledgeSources)
      .where(eq(knowledgeSources.id, id))
      .limit(1);
    return row?.bodyText ?? null;
  }
}

/** The shape `search` selects. Named so the raw-SQL path is as typed as the builder paths. */
interface ChunkSearchRow {
  readonly id: string;
  readonly source_id: string;
  readonly project_id: string | null;
  readonly ordinal: number;
  readonly locator: string;
  readonly heading: string | null;
  readonly text: string;
  readonly char_count: number;
  readonly created_at: string | Date;
  readonly score: number;
  readonly source_title: string;
  readonly source_kind: string;
}

export class DrizzleChunkRepository implements ChunkRepository {
  constructor(private readonly db: Database) {}

  async replaceForSource(
    sourceId: string,
    projectId: string | null,
    chunks: readonly { ordinal: number; locator: string; heading: string | null; text: string }[],
  ): Promise<number> {
    await this.db.delete(knowledgeChunks).where(eq(knowledgeChunks.sourceId, sourceId));
    if (chunks.length === 0) return 0;

    await this.db.insert(knowledgeChunks).values(
      chunks.map((chunk) => ({
        sourceId,
        projectId,
        ordinal: chunk.ordinal,
        locator: chunk.locator,
        heading: chunk.heading,
        text: chunk.text,
        charCount: chunk.text.length,
      })),
    );
    return chunks.length;
  }

  async findById(id: string): Promise<KnowledgeChunk | null> {
    const [row] = await this.db
      .select()
      .from(knowledgeChunks)
      .where(eq(knowledgeChunks.id, id))
      .limit(1);
    return row ? toKnowledgeChunk(row) : null;
  }

  async findByIds(ids: readonly string[]): Promise<readonly KnowledgeChunk[]> {
    if (ids.length === 0) return [];
    const rows = await this.db
      .select()
      .from(knowledgeChunks)
      .where(inArray(knowledgeChunks.id, [...ids]));
    return rows.map((row) => toKnowledgeChunk(row));
  }

  async listForSource(sourceId: string): Promise<readonly KnowledgeChunk[]> {
    const rows = await this.db
      .select()
      .from(knowledgeChunks)
      .where(eq(knowledgeChunks.sourceId, sourceId))
      .orderBy(knowledgeChunks.ordinal);
    return rows.map((row) => toKnowledgeChunk(row));
  }

  async search(input: {
    readonly query: string;
    readonly projectIds?: readonly string[];
    readonly limit?: number;
  }): Promise<readonly ScoredChunk[]> {
    const query = input.query.trim();
    if (query.length === 0) return [];

    const projectFilter =
      input.projectIds && input.projectIds.length > 0
        ? sql`and (c.project_id is null or c.project_id in (${sql.join(
            input.projectIds.map((id) => sql`${id}::uuid`),
            sql`, `,
          )}))`
        : sql``;

    const rows = await this.db.execute(sql`
      select c.id, c.source_id, c.project_id, c.ordinal, c.locator, c.heading, c.text,
             c.char_count, c.created_at,
             ts_rank_cd(c.search_vector, websearch_to_tsquery('english', ${query})) as score,
             s.title as source_title, s.kind as source_kind
      from ${knowledgeChunks} as c
      join ${knowledgeSources} as s on s.id = c.source_id
      where c.search_vector @@ websearch_to_tsquery('english', ${query})
        and s.deleted_at is null
        ${projectFilter}
      order by score desc, c.created_at desc
      limit ${input.limit ?? DEFAULT_SEARCH_LIMIT}
    `);

    return extractRows<ChunkSearchRow>(rows).map((row) => ({
      chunk: {
        id: String(row.id),
        sourceId: String(row.source_id),
        projectId: row.project_id === null ? null : String(row.project_id),
        ordinal: Number(row.ordinal),
        locator: String(row.locator),
        heading: row.heading === null ? null : String(row.heading),
        text: String(row.text),
        charCount: Number(row.char_count),
        createdAt: new Date(row.created_at).toISOString(),
      },
      score: Number(row.score),
      sourceTitle: String(row.source_title),
      sourceKind: String(row.source_kind) as SourceKind,
    }));
  }
}

export class DrizzleKnowledgeRepository implements KnowledgeRepository {
  constructor(private readonly db: Database) {}

  async create(input: KnowledgeCreateInput): Promise<KnowledgeItem> {
    const [row] = await this.db
      .insert(knowledgeItems)
      .values({
        scope: input.scope,
        category: input.category,
        origin: input.origin,
        status: input.status,
        statusRule: input.statusRule,
        statement: boundText(input.statement, 600),
        detail: input.detail ? boundText(input.detail, 4000) : null,
        projectId: input.projectId ?? null,
        missionId: input.missionId ?? null,
        sourceId: input.sourceId ?? null,
        sourceRef: input.sourceRef ?? null,
        excerpts: [...(input.excerpts ?? [])],
        tags: [...(input.tags ?? [])],
        createdBy: input.createdBy,
        confidence: input.confidence ?? null,
        reviewAt: input.reviewAt ?? null,
        expiresAt: input.expiresAt ?? null,
        supersedesId: input.supersedesId ?? null,
        confirmedAt: input.confirmedAt ?? null,
        confirmedBy: input.confirmedBy ?? null,
        ...(input.sensitivity !== undefined ? { sensitivity: input.sensitivity } : {}),
      })
      .returning();
    if (!row) throw new NotFoundError('Knowledge item');
    return toKnowledgeItem(row);
  }

  async findById(id: string): Promise<KnowledgeItem | null> {
    const [row] = await this.db
      .select()
      .from(knowledgeItems)
      .where(eq(knowledgeItems.id, id))
      .limit(1);
    return row ? toKnowledgeItem(row) : null;
  }

  async findByIds(ids: readonly string[]): Promise<readonly KnowledgeItem[]> {
    if (ids.length === 0) return [];
    const rows = await this.db
      .select()
      .from(knowledgeItems)
      .where(inArray(knowledgeItems.id, [...ids]));
    return rows.map((row) => toKnowledgeItem(row));
  }

  async list(filter: KnowledgeListFilter = {}): Promise<readonly KnowledgeItem[]> {
    const clauses = [];
    if (filter.scopes && filter.scopes.length > 0) {
      clauses.push(inArray(knowledgeItems.scope, [...filter.scopes]));
    }
    if (filter.categories && filter.categories.length > 0) {
      clauses.push(inArray(knowledgeItems.category, [...filter.categories]));
    }
    if (filter.statuses && filter.statuses.length > 0) {
      clauses.push(inArray(knowledgeItems.status, [...filter.statuses]));
    }
    if (filter.origins && filter.origins.length > 0) {
      clauses.push(inArray(knowledgeItems.origin, [...filter.origins]));
    }
    if (filter.projectId !== undefined) {
      clauses.push(
        filter.projectId === null
          ? isNull(knowledgeItems.projectId)
          : eq(knowledgeItems.projectId, filter.projectId),
      );
    }
    if (filter.sourceId !== undefined && filter.sourceId !== null) {
      clauses.push(eq(knowledgeItems.sourceId, filter.sourceId));
    }
    if (filter.search) {
      clauses.push(
        sql`${knowledgeItems.searchVector} @@ websearch_to_tsquery('english', ${filter.search})`,
      );
    }

    const rows = await this.db
      .select()
      .from(knowledgeItems)
      .where(clauses.length > 0 ? and(...clauses) : undefined)
      .orderBy(desc(knowledgeItems.updatedAt))
      .limit(filter.limit ?? DEFAULT_LIMIT);
    return rows.map((row) => toKnowledgeItem(row));
  }

  async patch(id: string, patch: KnowledgePatch): Promise<KnowledgeItem> {
    const [row] = await this.db
      .update(knowledgeItems)
      .set({
        ...(patch.status !== undefined ? { status: patch.status } : {}),
        ...(patch.statement !== undefined ? { statement: boundText(patch.statement, 600) } : {}),
        ...(patch.detail !== undefined
          ? { detail: patch.detail === null ? null : boundText(patch.detail, 4000) }
          : {}),
        ...(patch.tags !== undefined ? { tags: [...patch.tags] } : {}),
        ...(patch.excerpts !== undefined ? { excerpts: [...patch.excerpts] } : {}),
        ...(patch.confirmedAt !== undefined ? { confirmedAt: patch.confirmedAt } : {}),
        ...(patch.confirmedBy !== undefined ? { confirmedBy: patch.confirmedBy } : {}),
        ...(patch.rejectedReason !== undefined
          ? {
              rejectedReason:
                patch.rejectedReason === null ? null : boundText(patch.rejectedReason, 600),
            }
          : {}),
        ...(patch.reviewAt !== undefined ? { reviewAt: patch.reviewAt } : {}),
        ...(patch.expiresAt !== undefined ? { expiresAt: patch.expiresAt } : {}),
        ...(patch.supersededById !== undefined ? { supersededById: patch.supersededById } : {}),
        ...(patch.supersededReason !== undefined
          ? { supersededReason: patch.supersededReason }
          : {}),
        ...(patch.forgottenAt !== undefined ? { forgottenAt: patch.forgottenAt } : {}),
        ...(patch.projectId !== undefined ? { projectId: patch.projectId } : {}),
        ...(patch.category !== undefined ? { category: patch.category } : {}),
        ...(patch.scope !== undefined ? { scope: patch.scope } : {}),
        ...(patch.sensitivity !== undefined ? { sensitivity: patch.sensitivity } : {}),
        updatedAt: new Date(),
      })
      .where(eq(knowledgeItems.id, id))
      .returning();
    if (!row) throw new NotFoundError('Knowledge item');
    return toKnowledgeItem(row);
  }

  async searchActive(input: {
    readonly query: string;
    readonly scopes?: readonly string[];
    readonly projectIds?: readonly string[];
    readonly limit?: number;
  }): Promise<readonly ScoredKnowledge[]> {
    const query = input.query.trim();
    if (query.length === 0) return [];

    const clauses = [
      eq(knowledgeItems.status, 'active'),
      sql`${knowledgeItems.searchVector} @@ websearch_to_tsquery('english', ${query})`,
    ];
    if (input.scopes && input.scopes.length > 0) {
      clauses.push(inArray(knowledgeItems.scope, [...input.scopes] as never));
    }
    if (input.projectIds && input.projectIds.length > 0) {
      clauses.push(
        or(
          isNull(knowledgeItems.projectId),
          inArray(knowledgeItems.projectId, [...input.projectIds]),
        )!,
      );
    }

    const rows = await this.db
      .select({
        item: knowledgeItems,
        score: sql<number>`ts_rank_cd(${knowledgeItems.searchVector}, websearch_to_tsquery('english', ${query}))`,
      })
      .from(knowledgeItems)
      .where(and(...clauses))
      .orderBy(
        desc(
          sql`ts_rank_cd(${knowledgeItems.searchVector}, websearch_to_tsquery('english', ${query}))`,
        ),
      )
      .limit(input.limit ?? DEFAULT_SEARCH_LIMIT);

    return rows.map((row) => ({ item: toKnowledgeItem(row.item), score: Number(row.score) }));
  }

  async activeForContext(input: {
    readonly scopes: readonly string[];
    readonly projectIds?: readonly string[];
    readonly limit?: number;
  }): Promise<readonly KnowledgeItem[]> {
    const clauses = [eq(knowledgeItems.status, 'active')];
    if (input.scopes.length > 0) {
      clauses.push(inArray(knowledgeItems.scope, [...input.scopes] as never));
    }
    if (input.projectIds && input.projectIds.length > 0) {
      clauses.push(
        or(
          isNull(knowledgeItems.projectId),
          inArray(knowledgeItems.projectId, [...input.projectIds]),
        )!,
      );
    }

    const rows = await this.db
      .select()
      .from(knowledgeItems)
      .where(and(...clauses))
      .orderBy(desc(knowledgeItems.useCount), desc(knowledgeItems.updatedAt))
      .limit(input.limit ?? 60);
    return rows.map((row) => toKnowledgeItem(row));
  }

  async countsByStatus(): Promise<Readonly<Record<KnowledgeStatus, number>>> {
    const rows = await this.db
      .select({ status: knowledgeItems.status, count: sql<number>`count(*)::int` })
      .from(knowledgeItems)
      .groupBy(knowledgeItems.status);

    const counts = Object.fromEntries(KNOWLEDGE_STATUSES.map((status) => [status, 0])) as Record<
      KnowledgeStatus,
      number
    >;
    for (const row of rows) counts[row.status] = Number(row.count);
    return counts;
  }

  async dueForReview(now: Date, limit = 50): Promise<readonly KnowledgeItem[]> {
    const rows = await this.db
      .select()
      .from(knowledgeItems)
      .where(
        and(
          eq(knowledgeItems.status, 'active'),
          or(lte(knowledgeItems.reviewAt, now), lte(knowledgeItems.expiresAt, now))!,
        ),
      )
      .orderBy(knowledgeItems.reviewAt)
      .limit(limit);
    return rows.map((row) => toKnowledgeItem(row));
  }

  /**
   * Forget an item, destructively.
   *
   * The statement becomes a fixed placeholder rather than an empty string, so the interface has
   * something honest to render and so the not-null constraint holds. Detail and excerpts are
   * emptied. Both search vectors are generated from these columns, so the indexes follow without
   * a second write — the property that makes "not retrievable through embeddings, indexes,
   * caches or summaries" checkable rather than merely intended.
   */
  async forget(id: string, now: Date): Promise<KnowledgeItem> {
    const [row] = await this.db
      .update(knowledgeItems)
      .set({
        status: 'forgotten',
        statement: FORGOTTEN_PLACEHOLDER,
        detail: null,
        excerpts: [],
        tags: [],
        sourceRef: null,
        forgottenAt: now,
        updatedAt: now,
      })
      .where(eq(knowledgeItems.id, id))
      .returning();
    if (!row) throw new NotFoundError('Knowledge item');
    return toKnowledgeItem(row);
  }

  async recordUse(ids: readonly string[], now: Date): Promise<void> {
    if (ids.length === 0) return;
    await this.db
      .update(knowledgeItems)
      .set({ useCount: sql`${knowledgeItems.useCount} + 1`, lastUsedAt: now })
      .where(inArray(knowledgeItems.id, [...ids]));
  }

  async siblings(item: KnowledgeItem): Promise<readonly KnowledgeItem[]> {
    const clauses = [
      eq(knowledgeItems.scope, item.scope),
      eq(knowledgeItems.category, item.category),
      inArray(knowledgeItems.status, ['active', 'suggested']),
    ];
    clauses.push(
      item.projectId === null
        ? isNull(knowledgeItems.projectId)
        : eq(knowledgeItems.projectId, item.projectId),
    );

    const rows = await this.db
      .select()
      .from(knowledgeItems)
      .where(and(...clauses))
      .orderBy(desc(knowledgeItems.updatedAt))
      .limit(120);
    return rows.map((row) => toKnowledgeItem(row)).filter((row) => row.id !== item.id);
  }
}

export const FORGOTTEN_PLACEHOLDER = '(forgotten)';

export class DrizzleConflictRepository implements ConflictRepository {
  constructor(private readonly db: Database) {}

  async record(input: ConflictCreateInput): Promise<KnowledgeConflict> {
    const [row] = await this.db
      .insert(knowledgeConflicts)
      .values({
        kind: input.kind,
        leftId: input.leftId,
        rightId: input.rightId,
        projectId: input.projectId ?? null,
        summary: boundText(input.summary, 600),
        detectedRule: input.detectedRule,
      })
      .onConflictDoUpdate({
        target: [knowledgeConflicts.leftId, knowledgeConflicts.rightId, knowledgeConflicts.kind],
        set: { summary: boundText(input.summary, 600) },
      })
      .returning();
    if (!row) throw new NotFoundError('Knowledge conflict');
    return toKnowledgeConflict(row);
  }

  async list(state?: ConflictState): Promise<readonly KnowledgeConflict[]> {
    const rows = await this.db
      .select()
      .from(knowledgeConflicts)
      .where(state ? eq(knowledgeConflicts.state, state) : undefined)
      .orderBy(desc(knowledgeConflicts.createdAt))
      .limit(DEFAULT_LIMIT);
    return rows.map((row) => toKnowledgeConflict(row));
  }

  async findById(id: string): Promise<KnowledgeConflict | null> {
    const [row] = await this.db
      .select()
      .from(knowledgeConflicts)
      .where(eq(knowledgeConflicts.id, id))
      .limit(1);
    return row ? toKnowledgeConflict(row) : null;
  }

  async resolve(id: string, resolution: string, now: Date): Promise<KnowledgeConflict> {
    const [row] = await this.db
      .update(knowledgeConflicts)
      .set({
        state: resolution === 'dismiss' ? 'dismissed' : 'resolved',
        resolution,
        resolvedAt: now,
      })
      .where(eq(knowledgeConflicts.id, id))
      .returning();
    if (!row) throw new NotFoundError('Knowledge conflict');
    return toKnowledgeConflict(row);
  }

  async openCount(): Promise<number> {
    const [row] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(knowledgeConflicts)
      .where(eq(knowledgeConflicts.state, 'open'));
    return Number(row?.count ?? 0);
  }
}

export class DrizzleAnswerRepository implements AnswerRepository {
  constructor(private readonly db: Database) {}

  async record(input: AnswerCreateInput) {
    const [row] = await this.db
      .insert(answers)
      .values({
        question: boundText(input.question, 500),
        scope: input.scope,
        projectIds: [...input.projectIds],
        headline: boundText(input.headline, 400),
        claims: [...input.claims],
        considered: input.considered,
        method: input.method,
        rejectionRule: input.rejectionRule ?? null,
        rejectionReason: input.rejectionReason ?? null,
        missionSuggestion: input.missionSuggestion ?? null,
        savedView: input.savedView ?? null,
        durationMs: input.durationMs ?? null,
        askedBy: input.askedBy,
      })
      .returning();
    if (!row) throw new NotFoundError('Answer');
    return toStoredAnswer(row);
  }

  async findById(id: string) {
    const [row] = await this.db.select().from(answers).where(eq(answers.id, id)).limit(1);
    return row ? toStoredAnswer(row) : null;
  }

  async recent(limit = 30) {
    const rows = await this.db
      .select()
      .from(answers)
      .orderBy(desc(answers.generatedAt))
      .limit(limit);
    return rows.map((row) => toStoredAnswer(row));
  }
}

/** The drivers disagree about `execute`'s return shape; normalise once, here. */
function extractRows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  if (result && typeof result === 'object' && 'rows' in result) {
    const rows = (result as { rows: unknown }).rows;
    if (Array.isArray(rows)) return rows as T[];
  }
  return [];
}
