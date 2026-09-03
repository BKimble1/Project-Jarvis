import { sql } from 'drizzle-orm';

import type { EmbeddingVector } from '@/domain/embedding';
import type { KnowledgeScope } from '@/domain/knowledge';
import type { RevisionProvenance } from '@/domain/knowledge-revision';
import { SENSITIVITY_RANK, type ScopeFilter, type Sensitivity } from '@/domain/retrieval';
import type { Database } from '@/server/db/client';

/**
 * The retrieval queries.
 *
 * ## Filtering happens before ranking, and here is where that is true
 *
 * Every query below joins `chunks → active revision → source` and applies the scope, project and
 * sensitivity predicates **in the same statement that ranks**. Nothing is fetched broadly and
 * filtered in TypeScript afterwards. That is not a performance preference: a query that reads rows
 * the caller may not see has already leaked them into the query plan, the slow-query log, the
 * result buffer and any cache in between, and the filter that runs afterwards protects none of
 * those.
 *
 * The scope predicate is built by `scopePredicate` from a `ScopeFilter`, which can only be
 * produced by `buildScopeFilter` — and that refuses an empty scope set, a project scope with no
 * projects, and a display audience asking for anything private. There is no code path that
 * reaches these queries without one.
 *
 * ## Authorization reads the source, never the chunk
 *
 * `knowledge_chunks` carries a denormalised `project_id`. These queries deliberately do **not**
 * use it. Authorization joins through to `knowledge_sources.scope` and `.project_id`, so moving a
 * source between projects moves its content immediately and cannot leave stale rows readable
 * under the old scope. A test asserts exactly that.
 *
 * ## Only the active revision is searchable
 *
 * `r.is_active` is part of the join, not a filter applied later, so a superseded revision cannot
 * appear even though its chunks are still stored for older citations to resolve against.
 */

export interface RetrievalCandidateRow {
  readonly id: string;
  readonly chunkId: string | null;
  readonly itemId: string | null;
  readonly sourceId: string | null;
  readonly revisionId: string | null;
  readonly title: string;
  readonly text: string;
  readonly locator: string;
  readonly headingPath: readonly string[];
  readonly pageNumber: number | null;
  readonly startLine: number | null;
  readonly endLine: number | null;
  readonly scope: KnowledgeScope;
  readonly projectId: string | null;
  readonly sensitivity: Sensitivity;
  readonly sourceKind: string | null;
  readonly contentHash: string | null;
  readonly provenance: RevisionProvenance | null;
  readonly origin: string | null;
  readonly category: string | null;
  readonly score: number;
  readonly rank: number;
}

export interface LexicalQuery {
  readonly query: string;
  readonly scope: ScopeFilter;
  readonly limit: number;
  /** `english` stems for recall; `simple` keeps identifiers literal. */
  readonly config: 'english' | 'simple';
  readonly asOf: string | null;
}

export interface SemanticQuery {
  readonly vector: EmbeddingVector;
  readonly model: string;
  readonly indexingVersion: string;
  readonly scope: ScopeFilter;
  readonly limit: number;
  readonly asOf: string | null;
}

export class DrizzleRetrievalRepository {
  constructor(private readonly db: Database) {}

  /**
   * Full-text candidates from source chunks.
   *
   * `websearch_to_tsquery` rather than `to_tsquery`: it accepts whatever a person types, quotes
   * and stray operators included, and cannot be made to throw by a badly formed query. Ties break
   * on the chunk id so an ordering is reproducible.
   */
  async lexicalChunks(query: LexicalQuery): Promise<readonly RetrievalCandidateRow[]> {
    const vectorColumn =
      query.config === 'english' ? sql`c.search_vector` : sql`c.search_vector_exact`;
    const config = sql.raw(`'${query.config}'`);

    const rows = await this.db.execute(sql`
      select
        c.id                                        as id,
        c.id                                        as chunk_id,
        null::uuid                                  as item_id,
        s.id                                        as source_id,
        r.id                                        as revision_id,
        s.title                                     as title,
        c.text                                      as text,
        c.locator                                   as locator,
        c.heading_path                              as heading_path,
        c.page_number                               as page_number,
        c.start_line                                as start_line,
        c.end_line                                  as end_line,
        s.scope                                     as scope,
        s.project_id                                as project_id,
        s.sensitivity                               as sensitivity,
        s.kind                                      as source_kind,
        r.content_hash                              as content_hash,
        r.provenance                                as provenance,
        null::text                                  as origin,
        null::text                                  as category,
        ts_rank_cd(${vectorColumn}, websearch_to_tsquery(${config}, ${query.query}))::float8 as score
      from knowledge_chunks c
      join knowledge_revisions r
        on r.id = c.revision_id
       and r.is_active
      join knowledge_sources s
        on s.id = r.source_id
      where ${vectorColumn} @@ websearch_to_tsquery(${config}, ${query.query})
        and ${sourceVisible(query.scope, query.asOf)}
      order by score desc, c.id asc
      limit ${query.limit}
    `);

    return rank(extractRows(rows));
  }

  /**
   * Full-text candidates from memories.
   *
   * Only `active` memories, and the status test is inside this statement rather than applied
   * afterwards: a suggestion the owner has not confirmed must not be able to influence an answer,
   * and a filter that runs after the query has already put it in the result buffer.
   */
  async lexicalMemories(query: LexicalQuery): Promise<readonly RetrievalCandidateRow[]> {
    const rows = await this.db.execute(sql`
      select
        i.id                                        as id,
        null::uuid                                  as chunk_id,
        i.id                                        as item_id,
        null::uuid                                  as source_id,
        null::uuid                                  as revision_id,
        i.category                                  as title,
        i.statement || coalesce(' ' || i.detail, '') as text,
        'memory'                                    as locator,
        '[]'::jsonb                                 as heading_path,
        null::integer                               as page_number,
        null::integer                               as start_line,
        null::integer                               as end_line,
        i.scope                                     as scope,
        i.project_id                                as project_id,
        i.sensitivity                               as sensitivity,
        null::text                                  as source_kind,
        null::text                                  as content_hash,
        null::jsonb                                 as provenance,
        i.origin                                    as origin,
        i.category                                  as category,
        ts_rank_cd(i.search_vector, websearch_to_tsquery('english', ${query.query}))::float8 as score
      from knowledge_items i
      where i.search_vector @@ websearch_to_tsquery('english', ${query.query})
        and i.status = 'active'
        and i.forgotten_at is null
        and ${memoryVisible(query.scope)}
      order by score desc, i.id asc
      limit ${query.limit}
    `);

    return rank(extractRows(rows));
  }

  /**
   * Semantic candidates over unit-normalised vectors.
   *
   * Cosine similarity is the dot product because every stored vector is unit length, computed with
   * `unnest(embedding, $query)`. No database extension, so neon, node-postgres and PGlite share
   * one code path.
   *
   * **The dimension predicate is load-bearing.** Postgres `unnest` over arrays of different
   * lengths zips to the longer one and pads with NULL, and `sum()` skips NULLs — so without
   * `e.dimensions = $n` a mismatched vector returns a plausible score rather than an error. It
   * was measured returning `0.6` for a two-dimension query against a three-dimension row. The
   * `array_length` check is the same guarantee against a row whose stored `dimensions` disagrees
   * with the array beside it.
   *
   * The model and indexing version are matched too: vectors produced by different models occupy
   * different spaces, and comparing across them ranks noise confidently.
   */
  async semanticChunks(query: SemanticQuery): Promise<readonly RetrievalCandidateRow[]> {
    const literal = `{${query.vector.values.join(',')}}`;

    const rows = await this.db.execute(sql`
      select
        c.id                                        as id,
        c.id                                        as chunk_id,
        null::uuid                                  as item_id,
        s.id                                        as source_id,
        r.id                                        as revision_id,
        s.title                                     as title,
        c.text                                      as text,
        c.locator                                   as locator,
        c.heading_path                              as heading_path,
        c.page_number                               as page_number,
        c.start_line                                as start_line,
        c.end_line                                  as end_line,
        s.scope                                     as scope,
        s.project_id                                as project_id,
        s.sensitivity                               as sensitivity,
        s.kind                                      as source_kind,
        r.content_hash                              as content_hash,
        r.provenance                                as provenance,
        null::text                                  as origin,
        null::text                                  as category,
        (
          select coalesce(sum(a * b), 0)
          from unnest(e.embedding, ${literal}::real[]) as t(a, b)
        )::float8                                   as score
      from knowledge_embeddings e
      join knowledge_chunks c
        on c.id = e.chunk_id
      join knowledge_revisions r
        on r.id = c.revision_id
       and r.is_active
      join knowledge_sources s
        on s.id = r.source_id
      where e.state = 'ready'
        and e.model = ${query.model}
        and e.indexing_version = ${query.indexingVersion}
        and e.dimensions = ${query.vector.dimensions}
        and array_length(e.embedding, 1) = ${query.vector.dimensions}
        and ${sourceVisible(query.scope, query.asOf)}
      order by score desc, c.id asc
      limit ${query.limit}
    `);

    return rank(extractRows(rows));
  }

  /** The same, over memories. */
  async semanticMemories(query: SemanticQuery): Promise<readonly RetrievalCandidateRow[]> {
    const literal = `{${query.vector.values.join(',')}}`;

    const rows = await this.db.execute(sql`
      select
        i.id                                        as id,
        null::uuid                                  as chunk_id,
        i.id                                        as item_id,
        null::uuid                                  as source_id,
        null::uuid                                  as revision_id,
        i.category                                  as title,
        i.statement || coalesce(' ' || i.detail, '') as text,
        'memory'                                    as locator,
        '[]'::jsonb                                 as heading_path,
        null::integer                               as page_number,
        null::integer                               as start_line,
        null::integer                               as end_line,
        i.scope                                     as scope,
        i.project_id                                as project_id,
        i.sensitivity                               as sensitivity,
        null::text                                  as source_kind,
        null::text                                  as content_hash,
        null::jsonb                                 as provenance,
        i.origin                                    as origin,
        i.category                                  as category,
        (
          select coalesce(sum(a * b), 0)
          from unnest(e.embedding, ${literal}::real[]) as t(a, b)
        )::float8                                   as score
      from knowledge_embeddings e
      join knowledge_items i
        on i.id = e.item_id
      where e.state = 'ready'
        and e.model = ${query.model}
        and e.indexing_version = ${query.indexingVersion}
        and e.dimensions = ${query.vector.dimensions}
        and array_length(e.embedding, 1) = ${query.vector.dimensions}
        and i.status = 'active'
        and i.forgotten_at is null
        and ${memoryVisible(query.scope)}
      order by score desc, i.id asc
      limit ${query.limit}
    `);

    return rank(extractRows(rows));
  }

  /**
   * How many chunks could be searched, and how many actually carry a current embedding.
   *
   * Feeds the honest retrieval-mode report. Scoped exactly like a search, so the mode describes
   * what *this caller* would be searching rather than the whole database.
   */
  async coverage(input: {
    readonly scope: ScopeFilter;
    readonly model: string;
    readonly indexingVersion: string;
  }): Promise<{
    readonly total: number;
    readonly ready: number;
    readonly pending: number;
    readonly failed: number;
  }> {
    const rows = await this.db.execute(sql`
      select
        count(*)::int                                                    as total,
        count(e.id) filter (where e.state = 'ready')::int                as ready,
        count(e.id) filter (where e.state = 'pending')::int              as pending,
        count(e.id) filter (where e.state = 'failed')::int               as failed
      from knowledge_chunks c
      join knowledge_revisions r
        on r.id = c.revision_id
       and r.is_active
      join knowledge_sources s
        on s.id = r.source_id
      left join knowledge_embeddings e
        on e.chunk_id = c.id
       and e.model = ${input.model}
       and e.indexing_version = ${input.indexingVersion}
      where ${sourceVisible(input.scope, null)}
    `);

    const row = extractRows(rows)[0] as Record<string, unknown> | undefined;
    return {
      total: Number(row?.total ?? 0),
      ready: Number(row?.ready ?? 0),
      pending: Number(row?.pending ?? 0),
      failed: Number(row?.failed ?? 0),
    };
  }

  /** Whether anything at all is searchable in this scope. Distinguishes empty from unavailable. */
  async hasReadyRevision(scope: ScopeFilter): Promise<boolean> {
    const rows = await this.db.execute(sql`
      select 1 as present
      from knowledge_revisions r
      join knowledge_sources s on s.id = r.source_id
      where r.is_active
        and r.state in ('ready', 'ready_lexical')
        and ${sourceVisible(scope, null)}
      limit 1
    `);
    return extractRows(rows).length > 0;
  }
}

/* ------------------------------------------------------------- predicates */

/**
 * The authorization predicate for source-backed content.
 *
 * Built as SQL rather than as a post-filter, and reading it is the point:
 *
 *  - the source still exists and is not deleted;
 *  - its scope is one the caller asked for and is allowed;
 *  - if that scope is `project`, its project is one of the caller's — and `projectIds` cannot be
 *    empty for a project-scoped request, because `buildScopeFilter` refuses that;
 *  - its sensitivity is at or below the caller's ceiling, which the display audience cannot raise.
 *
 * `asOf` restricts to revisions activated at or before an instant, so an older answer can be
 * reproduced against the evidence it actually saw.
 */
function sourceVisible(scope: ScopeFilter, asOf: string | null) {
  const scopes = scope.scopes.map((value) => sql`${value}`);
  const projects = scope.projectIds.map((value) => sql`${value}::uuid`);

  /*
   * An empty project list makes this `false`, which is correct and deliberate: a caller allowed
   * no projects retrieves no project-scoped content. `buildScopeFilter` has already refused the
   * dangerous case — a project scope with no projects named — so this can never silently widen.
   */
  const projectClause =
    projects.length > 0 ? sql`s.project_id in (${sql.join(projects, sql`, `)})` : sql`false`;

  const ceiling = SENSITIVITY_RANK[scope.sensitivityCeiling];

  return sql`(
    s.deleted_at is null
    and s.state <> 'deleted'
    and s.scope in (${sql.join(scopes, sql`, `)})
    and (s.scope <> 'project' or ${projectClause})
    and ${sensitivityRank(sql`s.sensitivity`)} <= ${ceiling}
    ${asOf ? sql`and r.activated_at is not null and r.activated_at <= ${asOf}::timestamptz` : sql``}
  )`;
}

/** The same, for memories. Adds the mission constraint, which sources do not have. */
function memoryVisible(scope: ScopeFilter) {
  const scopes = scope.scopes.map((value) => sql`${value}`);
  const projects = scope.projectIds.map((value) => sql`${value}::uuid`);

  const projectClause =
    projects.length > 0 ? sql`i.project_id in (${sql.join(projects, sql`, `)})` : sql`false`;

  const missionClause = scope.missionId ? sql`i.mission_id = ${scope.missionId}::uuid` : sql`false`;

  const ceiling = SENSITIVITY_RANK[scope.sensitivityCeiling];

  return sql`(
    i.scope in (${sql.join(scopes, sql`, `)})
    and (i.scope <> 'project' or ${projectClause})
    and (i.scope <> 'mission' or ${missionClause})
    and ${sensitivityRank(sql`i.sensitivity`)} <= ${ceiling}
  )`;
}

/**
 * Map a sensitivity to its rank inside SQL.
 *
 * Written as a CASE rather than stored as an integer so the column stays readable in a database
 * client, and defaulting to the *most* restrictive rank for an unrecognised value — a row written
 * by a future version with a sensitivity this build does not know is excluded, not included.
 */
function sensitivityRank(column: ReturnType<typeof sql>) {
  return sql`(case ${column}
    when 'public' then 0
    when 'internal' then 1
    when 'private' then 2
    else 99 end)`;
}

/* ---------------------------------------------------------------- shaping */

/** Attach a 1-based rank within the channel, which is what fusion combines. */
function rank(rows: readonly Record<string, unknown>[]): readonly RetrievalCandidateRow[] {
  return rows.map((row, index) => ({
    id: String(row.id),
    chunkId: row.chunk_id === null || row.chunk_id === undefined ? null : String(row.chunk_id),
    itemId: row.item_id === null || row.item_id === undefined ? null : String(row.item_id),
    sourceId: row.source_id === null || row.source_id === undefined ? null : String(row.source_id),
    revisionId:
      row.revision_id === null || row.revision_id === undefined ? null : String(row.revision_id),
    title: String(row.title ?? ''),
    text: String(row.text ?? ''),
    locator: String(row.locator ?? ''),
    headingPath: Array.isArray(row.heading_path) ? (row.heading_path as string[]) : [],
    pageNumber:
      row.page_number === null || row.page_number === undefined ? null : Number(row.page_number),
    startLine:
      row.start_line === null || row.start_line === undefined ? null : Number(row.start_line),
    endLine: row.end_line === null || row.end_line === undefined ? null : Number(row.end_line),
    scope: String(row.scope) as KnowledgeScope,
    projectId:
      row.project_id === null || row.project_id === undefined ? null : String(row.project_id),
    sensitivity: String(row.sensitivity ?? 'private') as Sensitivity,
    sourceKind:
      row.source_kind === null || row.source_kind === undefined ? null : String(row.source_kind),
    contentHash:
      row.content_hash === null || row.content_hash === undefined ? null : String(row.content_hash),
    provenance: (row.provenance as RevisionProvenance | null) ?? null,
    origin: row.origin === null || row.origin === undefined ? null : String(row.origin),
    category: row.category === null || row.category === undefined ? null : String(row.category),
    score: Number(row.score ?? 0),
    rank: index + 1,
  }));
}

/** The drivers disagree about `execute`'s shape; normalise once. */
function extractRows(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) return result as Record<string, unknown>[];
  if (result && typeof result === 'object' && 'rows' in result) {
    const rows = (result as { rows: unknown }).rows;
    if (Array.isArray(rows)) return rows as Record<string, unknown>[];
  }
  return [];
}
