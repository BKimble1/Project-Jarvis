import { coverageRatio, type EmbeddingProvider, type EmbeddingVector } from '@/domain/embedding';
import { boundExcerpt } from '@/domain/knowledge-chunker';
import { citationRef, type RevisionProvenance } from '@/domain/knowledge-revision';
import {
  RANKING_VERSION,
  RETRIEVAL_API_VERSION,
  RETRIEVAL_LIMITS,
  applyCharBudget,
  assertEvidenceIsInert,
  capPerSource,
  fuseRankings,
  resolveRetrievalMode,
  type Evidence,
  type EvidenceCitation,
  type FusionCandidate,
  type RetrievalChannel,
  type RetrievalRequest,
  type RetrievalResponse,
  type TrustClass,
} from '@/domain/retrieval';
import type {
  DrizzleRetrievalRepository,
  RetrievalCandidateRow,
} from '@/server/repositories/retrieval-drizzle';

/**
 * The retrieval API Phase 4C consumes.
 *
 * Everything a caller can express goes through `RetrievalRequest`, and everything it gets back is
 * bounded `Evidence` — never an ORM row, never a raw chunk, never a database handle. That is the
 * point of the layer: 4C should not be able to query knowledge tables even if it wanted to, so it
 * cannot accidentally skip the scope filter.
 *
 * ## The order of operations, and why it is this order
 *
 * 1. **Authorization**, in SQL, in the same statement that ranks. Not here.
 * 2. **Two lexical channels** — stemmed for recall, unstemmed so an exact identifier survives.
 * 3. **A semantic channel**, only if a provider is configured *and* an embedding of the query can
 *    actually be produced. A failure here degrades the mode; it never fails the search.
 * 4. **Rank fusion**, combining ranks rather than scores from incomparable scales.
 * 5. **Diversity cap**, so one repetitive document cannot take every slot.
 * 6. **Character budget**, applied last so the best results survive it.
 *
 * Steps 5 and 6 only ever remove. Neither can promote a worse result above a better one.
 */

export interface RetrievalServiceOptions {
  readonly repository: DrizzleRetrievalRepository;
  readonly embeddings: EmbeddingProvider | null;
  readonly clock?: () => Date;
}

export class RetrievalService {
  private readonly clock: () => Date;

  constructor(private readonly options: RetrievalServiceOptions) {
    this.clock = options.clock ?? (() => new Date());
  }

  async retrieve(request: RetrievalRequest): Promise<RetrievalResponse> {
    const started = Date.now();
    const limit = Math.min(request.limit, RETRIEVAL_LIMITS.maxLimit);
    /* Over-fetch per channel so fusion and the diversity cap have something to work with. */
    const perChannel = Math.min(limit * 4, RETRIEVAL_LIMITS.maxLimit * 4);
    const excluded: Record<string, number> = {};

    const [stemmed, exact, memoriesLexical] = await Promise.all([
      request.includeSources
        ? this.options.repository.lexicalChunks({
            query: request.query,
            scope: request.scope,
            limit: perChannel,
            config: 'english',
            asOf: request.asOf,
          })
        : Promise.resolve([]),
      request.includeSources
        ? this.options.repository.lexicalChunks({
            query: request.query,
            scope: request.scope,
            limit: perChannel,
            config: 'simple',
            asOf: request.asOf,
          })
        : Promise.resolve([]),
      request.includeMemories
        ? this.options.repository.lexicalMemories({
            query: request.query,
            scope: request.scope,
            limit: perChannel,
            config: 'english',
            asOf: request.asOf,
          })
        : Promise.resolve([]),
    ]);

    /*
     * Semantic is attempted, not required. A provider that is absent, misconfigured or failing
     * leaves the lexical results untouched and changes only what the mode is called — a knowledge
     * base that stops working because an external service is down is worse than one that finds
     * slightly less.
     */
    const semantic = await this.semanticCandidates(request, perChannel, excluded);

    const rowsById = new Map<string, RetrievalCandidateRow>();
    const candidates: FusionCandidate[] = [];

    const collect = (rows: readonly RetrievalCandidateRow[], channel: RetrievalChannel): void => {
      for (const row of rows) {
        rowsById.set(row.id, rowsById.get(row.id) ?? row);
        candidates.push({ id: row.id, channel, rank: row.rank, score: row.score });
      }
    };

    collect(stemmed, 'lexical');
    collect(memoriesLexical, 'lexical');
    collect(exact, 'lexical_exact');
    collect(semantic.chunks, 'semantic');
    collect(semantic.memories, 'semantic');

    const fused = fuseRankings(candidates);

    const capped = capPerSource(
      fused,
      (result) => rowsById.get(result.id)?.sourceId ?? null,
      limit,
    );
    if (capped.dropped > 0) excluded.one_source_dominating = capped.dropped;

    const evidence: Evidence[] = [];
    for (const result of capped.kept.slice(0, limit)) {
      const row = rowsById.get(result.id);
      if (!row) continue;
      const item = toEvidence(row, result);
      /* A shape check, not a content check: content may say anything, the object may not act. */
      assertEvidenceIsInert(item);
      evidence.push(item);
    }

    const budgeted = applyCharBudget(evidence, request.charBudget);

    const coverage = this.options.embeddings
      ? await this.options.repository.coverage({
          scope: request.scope,
          model: this.options.embeddings.model,
          indexingVersion: this.options.embeddings.indexingVersion,
        })
      : { total: 0, ready: 0, pending: 0, failed: 0 };

    const hasReady = await this.options.repository.hasReadyRevision(request.scope);

    const mode = resolveRetrievalMode({
      providerConfigured: Boolean(this.options.embeddings?.isConfigured()),
      coverageRatio: coverageRatio({ ...coverage, stale: 0 }),
      pendingEmbeddings: coverage.pending,
      hasReadyRevision: hasReady,
    });

    return {
      evidence: budgeted.kept,
      diagnostics: {
        mode: semantic.degraded ? degrade(mode.mode) : mode.mode,
        modeReason: semantic.degraded ? (semantic.reason ?? mode.reason) : mode.reason,
        lexicalCandidates: stemmed.length + memoriesLexical.length,
        exactCandidates: exact.length,
        semanticCandidates: semantic.chunks.length + semantic.memories.length,
        fusedCandidates: fused.length,
        excluded,
        truncatedByCharBudget: budgeted.truncated,
        durationMs: Date.now() - started,
        rankingVersion: RANKING_VERSION,
        apiVersion: RETRIEVAL_API_VERSION,
      },
    };
  }

  /**
   * Embed the query and search the vector index, or explain why not.
   *
   * Never throws. Every failure path returns empty candidates plus a reason, because the caller's
   * search should still return its lexical results and the interface should say the semantic half
   * did not happen — rather than the whole request failing because an embedding call timed out.
   */
  private async semanticCandidates(
    request: RetrievalRequest,
    limit: number,
    excluded: Record<string, number>,
  ): Promise<{
    readonly chunks: readonly RetrievalCandidateRow[];
    readonly memories: readonly RetrievalCandidateRow[];
    readonly degraded: boolean;
    readonly reason: string | null;
  }> {
    const provider = this.options.embeddings;
    if (!provider || !provider.isConfigured()) {
      return { chunks: [], memories: [], degraded: false, reason: null };
    }

    let vector: EmbeddingVector | undefined;
    try {
      const result = await provider.embed([request.query]);
      vector = result.vectors[0];
    } catch {
      excluded.semantic_provider_failed = 1;
      return {
        chunks: [],
        memories: [],
        degraded: true,
        reason:
          'The embedding provider could not be reached, so this search used the text index only.',
      };
    }
    if (!vector) {
      excluded.semantic_provider_failed = 1;
      return {
        chunks: [],
        memories: [],
        degraded: true,
        reason: 'The embedding provider returned nothing for this query.',
      };
    }

    const [chunks, memories] = await Promise.all([
      request.includeSources
        ? this.options.repository.semanticChunks({
            vector,
            model: provider.model,
            indexingVersion: provider.indexingVersion,
            scope: request.scope,
            limit,
            asOf: request.asOf,
          })
        : Promise.resolve([]),
      request.includeMemories
        ? this.options.repository.semanticMemories({
            vector,
            model: provider.model,
            indexingVersion: provider.indexingVersion,
            scope: request.scope,
            limit,
            asOf: request.asOf,
          })
        : Promise.resolve([]),
    ]);

    return { chunks, memories, degraded: false, reason: null };
  }
}

/** A provider failure downgrades an otherwise-ready mode; it never upgrades one. */
function degrade(
  mode: RetrievalResponse['diagnostics']['mode'],
): RetrievalResponse['diagnostics']['mode'] {
  if (mode === 'hybrid_ready' || mode === 'hybrid_degraded') return 'hybrid_degraded';
  return mode;
}

/**
 * Turn a database row into bounded evidence.
 *
 * Note what does not survive this function: the storage key, the canonical text, the raw
 * provenance object's internals beyond a citable ref, and anything else that would let a caller
 * reach past the excerpt. `href` is always a Jarvis path — a citation can never become an
 * outbound link, so a hostile document cannot get a click routed anywhere it chose.
 */
function toEvidence(
  row: RetrievalCandidateRow,
  ranking: {
    readonly fusedScore: number;
    readonly channels: readonly RetrievalChannel[];
    readonly lexicalRank: number | null;
    readonly lexicalScore: number | null;
    readonly exactRank: number | null;
    readonly semanticRank: number | null;
    readonly semanticScore: number | null;
    readonly boosts: readonly string[];
  },
): Evidence {
  const isMemory = row.itemId !== null;
  const cited = citationRef(row.provenance ?? emptyProvenance());

  const citation: EvidenceCitation = {
    sourceId: row.sourceId,
    revisionId: row.revisionId,
    memoryId: row.itemId,
    locator: row.locator,
    href: isMemory
      ? `/knowledge/memories/${row.itemId}`
      : row.sourceId
        ? `/knowledge/sources/${row.sourceId}${row.revisionId ? `?revision=${row.revisionId}` : ''}`
        : null,
    ref: cited.ref,
    refKind: cited.kind,
    pageNumber: row.pageNumber,
    startLine: row.startLine,
    endLine: row.endLine,
  };

  return {
    id: row.id,
    kind: isMemory ? 'memory' : 'source_chunk',
    trust: trustFor(row),
    sensitivity: row.sensitivity,
    scope: row.scope,
    projectId: row.projectId,
    title: boundExcerpt(row.title, 160),
    excerpt: boundExcerpt(row.text, 900),
    citation,
    ranking: {
      channels: ranking.channels,
      lexicalRank: ranking.lexicalRank,
      lexicalScore: ranking.lexicalScore,
      exactRank: ranking.exactRank,
      semanticRank: ranking.semanticRank,
      semanticScore: ranking.semanticScore,
      fusedScore: ranking.fusedScore,
      boosts: ranking.boosts,
    },
    contentHash: row.contentHash,
    staleSince: null,
    retrievedFrom: isMemory ? 'memory' : 'source',
  };
}

/**
 * How far this piece of evidence can be trusted, as a fact about where it came from.
 *
 * A memory the owner typed is `owner_authored`; one a model proposed is `agent_suggested` even
 * though only confirmed memories are retrievable, because the *origin* stays true after
 * confirmation and a reader deserves to know a machine drafted it. Everything read out of a
 * document is `imported_material`, which is the classification the prompt fence leans on.
 */
function trustFor(row: RetrievalCandidateRow): TrustClass {
  if (row.itemId !== null) {
    if (row.origin === 'explicit') return 'owner_authored';
    if (row.origin === 'model_suggested' || row.origin === 'inferred') return 'agent_suggested';
    return 'imported_material';
  }
  if (row.sourceKind === 'repository_doc') return 'repository_evidence';
  if (row.sourceKind === 'note') return 'owner_authored';
  return 'imported_material';
}

function emptyProvenance(): RevisionProvenance {
  return {
    requestedUrl: null,
    finalUrl: null,
    httpStatus: null,
    contentType: null,
    etag: null,
    lastModified: null,
    repositoryFullName: null,
    filePath: null,
    requestedRef: null,
    commitSha: null,
    blobSha: null,
    filename: null,
  };
}
