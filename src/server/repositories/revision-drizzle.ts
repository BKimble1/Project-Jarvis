import { and, asc, desc, eq, inArray, isNull, lte, sql } from 'drizzle-orm';

import { ConflictError, NotFoundError } from '@/domain/errors';
import type { EmbeddingState, EmbeddingVector } from '@/domain/embedding';
import type { CanonicalBlock } from '@/domain/knowledge-parser';
import type { DerivedChunk } from '@/domain/knowledge-chunker';
import {
  EMPTY_PROVENANCE,
  type KnowledgeRevision,
  type RevisionProvenance,
  type RevisionState,
} from '@/domain/knowledge-revision';
import { boundText, redactSecrets } from '@/domain/redaction';
import type { Database } from '@/server/db/client';
import {
  knowledgeBlocks,
  knowledgeChunks,
  knowledgeEmbeddings,
  knowledgeIngestionJobs,
  knowledgeRevisions,
  knowledgeSources,
} from '@/server/db/schema';

import { iso, isoRequired } from './mappers';

/**
 * Persistence for revisions, blocks, chunks and embeddings.
 *
 * The method worth reading is `activate`. Everything else is bookkeeping.
 */

export interface RevisionCreateInput {
  readonly sourceId: string;
  readonly contentHash: string;
  readonly byteHash: string | null;
  readonly byteSize: number;
  readonly charCount: number;
  readonly unitCount: number | null;
  readonly unitKind: 'page' | 'line';
  readonly canonicalText: string;
  readonly parserName: string;
  readonly parserVersion: string;
  readonly chunkerVersion: string;
  readonly truncated: boolean;
  readonly limitations: readonly string[];
  readonly provenance: RevisionProvenance;
}

export class DrizzleRevisionRepository {
  constructor(private readonly db: Database) {}

  /**
   * Start a revision, or return the one that already holds this content.
   *
   * Content-addressed by `(source_id, content_hash)`, so refreshing a page that has not changed
   * finds the existing revision rather than creating a duplicate to extract, chunk and embed all
   * over again. `on conflict do nothing` plus a follow-up read makes that race-free: two refreshes
   * arriving together produce one row and both callers get it.
   */
  async create(
    input: RevisionCreateInput,
  ): Promise<{ readonly revision: KnowledgeRevision; readonly created: boolean }> {
    const existing = await this.findByHash(input.sourceId, input.contentHash);
    if (existing) return { revision: existing, created: false };

    /*
     * The revision number is derived inside the insert, so two concurrent creations cannot both
     * read "2" and then both write it — the unique index on (source_id, revision_number) would
     * reject the loser, and the retry below picks up the winner's row.
     */
    const inserted = await this.db.execute(sql`
      insert into knowledge_revisions (
        source_id, revision_number, state, content_hash, byte_hash, byte_size, char_count,
        unit_count, unit_kind, canonical_text, parser_name, parser_version, chunker_version,
        truncated, limitations, provenance
      )
      select
        ${input.sourceId}::uuid,
        coalesce((select max(revision_number) from knowledge_revisions where source_id = ${input.sourceId}::uuid), 0) + 1,
        'extracting',
        ${input.contentHash},
        ${input.byteHash},
        ${input.byteSize},
        ${input.charCount},
        ${input.unitCount},
        ${input.unitKind},
        ${input.canonicalText},
        ${input.parserName},
        ${input.parserVersion},
        ${input.chunkerVersion},
        ${input.truncated},
        ${JSON.stringify([...input.limitations])}::jsonb,
        ${JSON.stringify(input.provenance)}::jsonb
      on conflict (source_id, content_hash) do nothing
      returning id
    `);

    const rows = extractRows(inserted);
    if (rows.length === 0) {
      const raced = await this.findByHash(input.sourceId, input.contentHash);
      if (!raced) throw new ConflictError('That revision could not be created.');
      return { revision: raced, created: false };
    }

    const revision = await this.findById(String(rows[0]?.id));
    if (!revision) throw new NotFoundError('Revision');
    return { revision, created: true };
  }

  async findById(id: string): Promise<KnowledgeRevision | null> {
    const [row] = await this.db
      .select()
      .from(knowledgeRevisions)
      .where(eq(knowledgeRevisions.id, id))
      .limit(1);
    return row ? toRevision(row) : null;
  }

  async findByHash(sourceId: string, contentHash: string): Promise<KnowledgeRevision | null> {
    const [row] = await this.db
      .select()
      .from(knowledgeRevisions)
      .where(
        and(
          eq(knowledgeRevisions.sourceId, sourceId),
          eq(knowledgeRevisions.contentHash, contentHash),
        ),
      )
      .limit(1);
    return row ? toRevision(row) : null;
  }

  async activeFor(sourceId: string): Promise<KnowledgeRevision | null> {
    const [row] = await this.db
      .select()
      .from(knowledgeRevisions)
      .where(and(eq(knowledgeRevisions.sourceId, sourceId), eq(knowledgeRevisions.isActive, true)))
      .limit(1);
    return row ? toRevision(row) : null;
  }

  async list(sourceId: string, limit = 50): Promise<readonly KnowledgeRevision[]> {
    const rows = await this.db
      .select()
      .from(knowledgeRevisions)
      .where(eq(knowledgeRevisions.sourceId, sourceId))
      .orderBy(desc(knowledgeRevisions.revisionNumber))
      .limit(limit);
    return rows.map((row) => toRevision(row));
  }

  async patch(
    id: string,
    patch: {
      readonly state?: RevisionState;
      readonly blockCount?: number;
      readonly chunkCount?: number;
      readonly embeddedChunkCount?: number;
      readonly failureCode?: string | null;
      readonly failureMessage?: string | null;
      readonly limitations?: readonly string[];
    },
  ): Promise<KnowledgeRevision> {
    const [row] = await this.db
      .update(knowledgeRevisions)
      .set({
        ...(patch.state !== undefined ? { state: patch.state } : {}),
        ...(patch.blockCount !== undefined ? { blockCount: patch.blockCount } : {}),
        ...(patch.chunkCount !== undefined ? { chunkCount: patch.chunkCount } : {}),
        ...(patch.embeddedChunkCount !== undefined
          ? { embeddedChunkCount: patch.embeddedChunkCount }
          : {}),
        ...(patch.failureCode !== undefined ? { failureCode: patch.failureCode } : {}),
        ...(patch.failureMessage !== undefined
          ? {
              failureMessage:
                patch.failureMessage === null
                  ? null
                  : redactSecrets(boundText(patch.failureMessage, 600)),
            }
          : {}),
        ...(patch.limitations !== undefined ? { limitations: [...patch.limitations] } : {}),
      })
      .where(eq(knowledgeRevisions.id, id))
      .returning();
    if (!row) throw new NotFoundError('Revision');
    return toRevision(row);
  }

  /**
   * Make a revision the one retrieval reads, atomically.
   *
   * The whole refresh story lives here. In one transaction:
   *
   *  1. the revision must be in a state that may activate — a half-indexed revision cannot become
   *     active, because a document Jarvis has only partly read is worse than the older one it
   *     would replace;
   *  2. the current active revision is stood down and marked superseded;
   *  3. the new one is stood up.
   *
   * The partial unique index on `(source_id) where is_active` is what makes this safe under
   * concurrency: if two refreshes race, the second one's update violates the index and its
   * transaction rolls back, leaving exactly one active revision. That is a database guarantee, not
   * a hopeful sequence of statements — and a test runs two activations concurrently to prove it.
   */
  async activate(revisionId: string, now: Date): Promise<KnowledgeRevision> {
    return this.db.transaction(async (tx) => {
      const [candidate] = await tx
        .select()
        .from(knowledgeRevisions)
        .where(eq(knowledgeRevisions.id, revisionId))
        .limit(1);
      if (!candidate) throw new NotFoundError('Revision');

      if (candidate.state !== 'ready' && candidate.state !== 'ready_lexical') {
        throw new ConflictError(
          `A revision in state "${candidate.state}" cannot be activated: it has not finished indexing.`,
        );
      }
      if (candidate.isActive) return toRevision(candidate);

      await tx
        .update(knowledgeRevisions)
        .set({ isActive: false, supersededAt: now, state: 'superseded' })
        .where(
          and(
            eq(knowledgeRevisions.sourceId, candidate.sourceId),
            eq(knowledgeRevisions.isActive, true),
          ),
        );

      const [activated] = await tx
        .update(knowledgeRevisions)
        .set({ isActive: true, activatedAt: now, supersededAt: null })
        .where(eq(knowledgeRevisions.id, revisionId))
        .returning();
      if (!activated) throw new NotFoundError('Revision');

      await tx
        .update(knowledgeSources)
        .set({ activeRevisionId: revisionId, updatedAt: now, lastRefreshedAt: now })
        .where(eq(knowledgeSources.id, candidate.sourceId));

      return toRevision(activated);
    });
  }

  /** Destroy a revision's content while keeping the row as a record that it existed. */
  async purge(revisionId: string): Promise<number> {
    const removed = await this.db
      .delete(knowledgeChunks)
      .where(eq(knowledgeChunks.revisionId, revisionId))
      .returning({ id: knowledgeChunks.id });
    await this.db.delete(knowledgeBlocks).where(eq(knowledgeBlocks.revisionId, revisionId));
    await this.db
      .update(knowledgeRevisions)
      .set({ state: 'purged', canonicalText: null, chunkCount: 0, blockCount: 0 })
      .where(eq(knowledgeRevisions.id, revisionId));
    return removed.length;
  }

  async readCanonicalText(revisionId: string): Promise<string | null> {
    const [row] = await this.db
      .select({ canonicalText: knowledgeRevisions.canonicalText })
      .from(knowledgeRevisions)
      .where(eq(knowledgeRevisions.id, revisionId))
      .limit(1);
    return row?.canonicalText ?? null;
  }

  /* ------------------------------------------------------------- blocks */

  async replaceBlocks(revisionId: string, blocks: readonly CanonicalBlock[]): Promise<number> {
    await this.db.delete(knowledgeBlocks).where(eq(knowledgeBlocks.revisionId, revisionId));
    if (blocks.length === 0) return 0;

    await this.db.insert(knowledgeBlocks).values(
      blocks.map((block) => ({
        revisionId,
        ordinal: block.ordinal,
        kind: block.kind,
        text: block.text,
        headingPath: [...block.headingPath],
        depth: block.depth,
        pageNumber: block.pageNumber,
        startLine: block.startLine,
        endLine: block.endLine,
        language: block.language,
        charCount: block.text.length,
      })),
    );
    return blocks.length;
  }

  async listBlocks(revisionId: string): Promise<readonly CanonicalBlock[]> {
    const rows = await this.db
      .select()
      .from(knowledgeBlocks)
      .where(eq(knowledgeBlocks.revisionId, revisionId))
      .orderBy(asc(knowledgeBlocks.ordinal));
    return rows.map((row) => ({
      ordinal: row.ordinal,
      kind: row.kind,
      text: row.text,
      headingPath: row.headingPath ?? [],
      depth: row.depth,
      pageNumber: row.pageNumber,
      startLine: row.startLine,
      endLine: row.endLine,
      language: row.language,
    }));
  }

  /* ------------------------------------------------------------- chunks */

  /**
   * Write a revision's chunks, replacing any previous attempt.
   *
   * Delete-then-insert rather than upsert, so a chunker version that produces *fewer* chunks does
   * not leave the tail of the previous run behind. Identity is the stable key, so a retry that
   * produces identical chunks writes identical rows.
   */
  async replaceChunks(input: {
    readonly revisionId: string;
    readonly sourceId: string;
    readonly projectId: string | null;
    readonly chunkerVersion: string;
    readonly chunks: readonly DerivedChunk[];
  }): Promise<number> {
    await this.db.delete(knowledgeChunks).where(eq(knowledgeChunks.revisionId, input.revisionId));
    if (input.chunks.length === 0) return 0;

    await this.db.insert(knowledgeChunks).values(
      input.chunks.map((chunk) => ({
        sourceId: input.sourceId,
        revisionId: input.revisionId,
        projectId: input.projectId,
        ordinal: chunk.ordinal,
        locator: chunk.locator,
        heading: chunk.headingPath[chunk.headingPath.length - 1] ?? null,
        headingPath: [...chunk.headingPath],
        text: chunk.text,
        charCount: chunk.charCount,
        stableKey: chunk.stableKey,
        chunkerVersion: input.chunkerVersion,
        pageNumber: chunk.pageNumber,
        startLine: chunk.startLine,
        endLine: chunk.endLine,
        blockOrdinals: [...chunk.blockOrdinals],
      })),
    );
    return input.chunks.length;
  }

  async findChunk(id: string): Promise<{
    readonly id: string;
    readonly sourceId: string;
    readonly revisionId: string | null;
    readonly text: string;
    readonly locator: string;
    readonly pageNumber: number | null;
    readonly startLine: number | null;
    readonly endLine: number | null;
  } | null> {
    const [row] = await this.db
      .select()
      .from(knowledgeChunks)
      .where(eq(knowledgeChunks.id, id))
      .limit(1);
    if (!row) return null;
    return {
      id: row.id,
      sourceId: row.sourceId,
      revisionId: row.revisionId,
      text: row.text,
      locator: row.locator,
      pageNumber: row.pageNumber,
      startLine: row.startLine,
      endLine: row.endLine,
    };
  }

  /* --------------------------------------------------------- embeddings */

  /**
   * Chunks in a revision that have no current embedding.
   *
   * Keyed on model and indexing version, so changing either makes every chunk outstanding again —
   * which is correct, because vectors from two models occupy different spaces and comparing across
   * them ranks noise confidently.
   */
  async chunksNeedingEmbedding(input: {
    readonly revisionId: string;
    readonly model: string;
    readonly indexingVersion: string;
    readonly limit?: number;
  }): Promise<readonly { readonly id: string; readonly text: string }[]> {
    const rows = await this.db.execute(sql`
      select c.id, c.text
      from knowledge_chunks c
      left join knowledge_embeddings e
        on e.chunk_id = c.id
       and e.model = ${input.model}
       and e.indexing_version = ${input.indexingVersion}
       and e.state = 'ready'
      where c.revision_id = ${input.revisionId}::uuid
        and e.id is null
      order by c.ordinal asc
      limit ${input.limit ?? 500}
    `);
    return extractRows(rows).map((row) => ({ id: String(row.id), text: String(row.text) }));
  }

  async saveChunkEmbedding(input: {
    readonly chunkId: string;
    readonly provider: string;
    readonly model: string;
    readonly indexingVersion: string;
    readonly vector: EmbeddingVector;
  }): Promise<void> {
    await this.upsertEmbedding({
      chunkId: input.chunkId,
      itemId: null,
      provider: input.provider,
      model: input.model,
      indexingVersion: input.indexingVersion,
      vector: input.vector,
      state: 'ready',
      failureMessage: null,
    });
  }

  async saveMemoryEmbedding(input: {
    readonly itemId: string;
    readonly provider: string;
    readonly model: string;
    readonly indexingVersion: string;
    readonly vector: EmbeddingVector;
  }): Promise<void> {
    await this.upsertEmbedding({
      chunkId: null,
      itemId: input.itemId,
      provider: input.provider,
      model: input.model,
      indexingVersion: input.indexingVersion,
      vector: input.vector,
      state: 'ready',
      failureMessage: null,
    });
  }

  async recordEmbeddingFailure(input: {
    readonly chunkId: string | null;
    readonly itemId: string | null;
    readonly provider: string;
    readonly model: string;
    readonly indexingVersion: string;
    readonly dimensions: number;
    readonly message: string;
  }): Promise<void> {
    const values = {
      chunkId: input.chunkId,
      itemId: input.itemId,
      provider: input.provider,
      model: input.model,
      dimensions: input.dimensions,
      indexingVersion: input.indexingVersion,
      embedding: null,
      state: 'failed' as EmbeddingState,
      failureMessage: redactSecrets(boundText(input.message, 400)),
      updatedAt: new Date(),
    };
    await this.db
      .insert(knowledgeEmbeddings)
      .values(values)
      .onConflictDoUpdate({
        target: input.chunkId
          ? [
              knowledgeEmbeddings.chunkId,
              knowledgeEmbeddings.model,
              knowledgeEmbeddings.indexingVersion,
            ]
          : [
              knowledgeEmbeddings.itemId,
              knowledgeEmbeddings.model,
              knowledgeEmbeddings.indexingVersion,
            ],
        targetWhere: input.chunkId ? sql`chunk_id is not null` : sql`item_id is not null`,
        set: {
          state: 'failed',
          failureMessage: values.failureMessage,
          attempt: sql`${knowledgeEmbeddings.attempt} + 1`,
          updatedAt: values.updatedAt,
        },
      });
  }

  /**
   * Remove every embedding for a memory.
   *
   * Called when a memory is forgotten. Deleting rather than flagging: a vector is a lossy but real
   * encoding of the text it was made from, and "forgotten" has to mean the semantic index cannot
   * return it either.
   */
  async deleteMemoryEmbeddings(itemId: string): Promise<number> {
    const removed = await this.db
      .delete(knowledgeEmbeddings)
      .where(eq(knowledgeEmbeddings.itemId, itemId))
      .returning({ id: knowledgeEmbeddings.id });
    return removed.length;
  }

  async deleteChunkEmbeddingsForRevision(revisionId: string): Promise<number> {
    const removed = await this.db.execute(sql`
      delete from knowledge_embeddings
      where chunk_id in (select id from knowledge_chunks where revision_id = ${revisionId}::uuid)
      returning id
    `);
    return extractRows(removed).length;
  }

  private async upsertEmbedding(input: {
    readonly chunkId: string | null;
    readonly itemId: string | null;
    readonly provider: string;
    readonly model: string;
    readonly indexingVersion: string;
    readonly vector: EmbeddingVector;
    readonly state: EmbeddingState;
    readonly failureMessage: string | null;
  }): Promise<void> {
    const values = {
      chunkId: input.chunkId,
      itemId: input.itemId,
      provider: input.provider,
      model: input.model,
      dimensions: input.vector.dimensions,
      indexingVersion: input.indexingVersion,
      embedding: [...input.vector.values],
      state: input.state,
      failureMessage: input.failureMessage,
      updatedAt: new Date(),
    };

    await this.db
      .insert(knowledgeEmbeddings)
      .values(values)
      .onConflictDoUpdate({
        target: input.chunkId
          ? [
              knowledgeEmbeddings.chunkId,
              knowledgeEmbeddings.model,
              knowledgeEmbeddings.indexingVersion,
            ]
          : [
              knowledgeEmbeddings.itemId,
              knowledgeEmbeddings.model,
              knowledgeEmbeddings.indexingVersion,
            ],
        targetWhere: input.chunkId ? sql`chunk_id is not null` : sql`item_id is not null`,
        set: {
          embedding: values.embedding,
          dimensions: values.dimensions,
          state: values.state,
          failureMessage: values.failureMessage,
          provider: values.provider,
          updatedAt: values.updatedAt,
        },
      });
  }

  /* --------------------------------------------------------------- jobs */

  async enqueue(input: {
    readonly sourceId: string;
    readonly revisionId: string | null;
    readonly kind: 'ingest' | 'refresh' | 'reindex' | 'embed';
    readonly requestedBy: string;
  }): Promise<string> {
    const [row] = await this.db
      .insert(knowledgeIngestionJobs)
      .values({
        sourceId: input.sourceId,
        revisionId: input.revisionId,
        kind: input.kind,
        requestedBy: input.requestedBy,
        state: 'queued',
      })
      .returning({ id: knowledgeIngestionJobs.id });
    return String(row?.id);
  }

  async finishJob(
    id: string,
    outcome: {
      readonly state: 'succeeded' | 'failed' | 'cancelled';
      readonly failureCode?: string | null;
      readonly failureMessage?: string | null;
    },
  ): Promise<void> {
    await this.db
      .update(knowledgeIngestionJobs)
      .set({
        state: outcome.state,
        failureCode: outcome.failureCode ?? null,
        failureMessage: outcome.failureMessage
          ? redactSecrets(boundText(outcome.failureMessage, 600))
          : null,
        finishedAt: new Date(),
      })
      .where(eq(knowledgeIngestionJobs.id, id));
  }

  /** What the Operations screen shows: outstanding and recently failed work. */
  async jobSummary(): Promise<{
    readonly queued: number;
    readonly running: number;
    readonly failed: number;
    readonly recent: readonly {
      readonly id: string;
      readonly sourceId: string;
      readonly kind: string;
      readonly state: string;
      readonly failureMessage: string | null;
      readonly createdAt: string;
    }[];
  }> {
    const counts = await this.db.execute(sql`
      select
        count(*) filter (where state = 'queued')::int  as queued,
        count(*) filter (where state = 'running')::int as running,
        count(*) filter (where state = 'failed')::int  as failed
      from knowledge_ingestion_jobs
    `);
    const summary = extractRows(counts)[0] ?? {};

    const rows = await this.db
      .select()
      .from(knowledgeIngestionJobs)
      .orderBy(desc(knowledgeIngestionJobs.createdAt))
      .limit(20);

    return {
      queued: Number(summary.queued ?? 0),
      running: Number(summary.running ?? 0),
      failed: Number(summary.failed ?? 0),
      recent: rows.map((row) => ({
        id: row.id,
        sourceId: row.sourceId,
        kind: row.kind,
        state: row.state,
        failureMessage: row.failureMessage,
        createdAt: isoRequired(row.createdAt),
      })),
    };
  }

  /** Revisions whose content may be destroyed under the retention policy. */
  async supersededBefore(sourceId: string, keep: number): Promise<readonly string[]> {
    const rows = await this.db
      .select({ id: knowledgeRevisions.id })
      .from(knowledgeRevisions)
      .where(
        and(eq(knowledgeRevisions.sourceId, sourceId), eq(knowledgeRevisions.state, 'superseded')),
      )
      .orderBy(desc(knowledgeRevisions.revisionNumber));
    return rows.slice(keep).map((row) => row.id);
  }

  async countByState(): Promise<Readonly<Record<string, number>>> {
    const rows = await this.db
      .select({ state: knowledgeRevisions.state, count: sql<number>`count(*)::int` })
      .from(knowledgeRevisions)
      .groupBy(knowledgeRevisions.state);
    return Object.fromEntries(rows.map((row) => [row.state, Number(row.count)]));
  }

  /** Sources whose retention window has expired, for the lifecycle sweep. */
  async expiredSources(now: Date): Promise<readonly string[]> {
    const rows = await this.db
      .select({ id: knowledgeSources.id })
      .from(knowledgeSources)
      .where(and(lte(knowledgeSources.retainUntil, now), isNull(knowledgeSources.deletedAt)))
      .limit(100);
    return rows.map((row) => row.id);
  }

  async findChunksByIds(ids: readonly string[]): Promise<readonly { id: string; text: string }[]> {
    if (ids.length === 0) return [];
    const rows = await this.db
      .select({ id: knowledgeChunks.id, text: knowledgeChunks.text })
      .from(knowledgeChunks)
      .where(inArray(knowledgeChunks.id, [...ids]));
    return rows;
  }
}

function toRevision(row: typeof knowledgeRevisions.$inferSelect): KnowledgeRevision {
  return {
    id: row.id,
    sourceId: row.sourceId,
    revisionNumber: row.revisionNumber,
    state: row.state,
    isActive: row.isActive,
    contentHash: row.contentHash,
    byteHash: row.byteHash,
    byteSize: row.byteSize,
    charCount: row.charCount,
    unitCount: row.unitCount,
    blockCount: row.blockCount,
    chunkCount: row.chunkCount,
    embeddedChunkCount: row.embeddedChunkCount,
    parserName: row.parserName,
    parserVersion: row.parserVersion,
    chunkerVersion: row.chunkerVersion,
    truncated: row.truncated,
    provenance: { ...EMPTY_PROVENANCE, ...(row.provenance ?? {}) },
    failureCode: row.failureCode,
    failureMessage: row.failureMessage,
    fetchedAt: isoRequired(row.fetchedAt),
    activatedAt: iso(row.activatedAt),
    supersededAt: iso(row.supersededAt),
    createdAt: isoRequired(row.createdAt),
  };
}

function extractRows(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) return result as Record<string, unknown>[];
  if (result && typeof result === 'object' && 'rows' in result) {
    const rows = (result as { rows: unknown }).rows;
    if (Array.isArray(rows)) return rows as Record<string, unknown>[];
  }
  return [];
}
