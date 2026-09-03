import { NotFoundError, ValidationError } from '@/domain/errors';
import type { EmbeddingProvider } from '@/domain/embedding';
import { batchTexts, normaliseVector } from '@/domain/embedding';
import type { KnowledgeScope } from '@/domain/knowledge';
import { CHUNKER_VERSION, deriveChunks } from '@/domain/knowledge-chunker';
import { ParseError, PARSER_LIMITS, canonicaliseText } from '@/domain/knowledge-parser';
import {
  EMPTY_PROVENANCE,
  assertRevisionDescribable,
  byteHash,
  revisionContentHash,
  REVISION_LIMITS,
  type KnowledgeRevision,
  type RevisionProvenance,
} from '@/domain/knowledge-revision';
import type { SourceFailureCode, SourceKind } from '@/domain/knowledge-source';
import { safeFilename } from '@/domain/knowledge-source';
import type { Sensitivity } from '@/domain/retrieval';
import type { AppConfig } from '@/server/config/env';
import type { SourceProvider } from '@/server/providers/types';
import type { DrizzleRevisionRepository } from '@/server/repositories/revision-drizzle';
import type { SourceRepositoryKnowledge } from '@/server/repositories/knowledge-types';
import type { SourceRepository as ProjectSourceRepository } from '@/server/repositories/types';

import type { ParserRegistry } from './parsers/registry';
import type { UrlFetcher } from './url-fetcher';

/**
 * Ingestion: origin → revision → blocks → chunks → index → active.
 *
 * The shape that matters is that **activation is last and atomic**. Content is fetched, parsed,
 * chunked and indexed against a *new* revision while the previous one keeps serving retrieval;
 * only when all of that has succeeded does the new revision become active, in one transaction
 * guarded by a partial unique index. Three consequences fall out of that ordering:
 *
 *  - A failed refresh leaves the last good revision serving. Nothing goes dark because a page
 *    moved or a parser choked.
 *  - A half-indexed revision can never answer a question, because it can never be active.
 *  - Two refreshes racing produce one active revision, decided by the database rather than by
 *    whichever callback happened to run second.
 *
 * Embeddings are deliberately outside that guarantee. A revision indexes lexically and becomes
 * `ready_lexical`, and embedding happens after; if the provider is down, the source is searchable
 * by text and the interface says so. Making semantic indexing a precondition would mean an
 * external outage could stop the owner adding a note.
 */

export interface IngestionServiceOptions {
  readonly sources: SourceRepositoryKnowledge;
  readonly revisions: DrizzleRevisionRepository;
  readonly parsers: ParserRegistry;
  readonly urlFetcher: UrlFetcher;
  readonly provider: SourceProvider;
  readonly projectSources: ProjectSourceRepository;
  readonly embeddings: EmbeddingProvider | null;
  readonly config: AppConfig;
  readonly clock?: () => Date;
}

export interface AddSourceInput {
  readonly kind: SourceKind;
  readonly title: string;
  readonly scope: KnowledgeScope;
  readonly projectId: string | null;
  readonly sensitivity: Sensitivity;
  readonly addedBy: string;
  readonly tags?: readonly string[];
}

export interface IngestionOutcome {
  readonly sourceId: string;
  readonly revisionId: string;
  readonly revisionNumber: number;
  readonly created: boolean;
  readonly changed: boolean;
  readonly chunkCount: number;
  readonly state: KnowledgeRevision['state'];
  readonly limitations: readonly string[];
}

export class IngestionService {
  private readonly clock: () => Date;

  constructor(private readonly options: IngestionServiceOptions) {
    this.clock = options.clock ?? (() => new Date());
  }

  /* ------------------------------------------------------------- adding */

  /** A note the owner typed. Never refreshable — there is no origin to re-read. */
  async addNote(input: AddSourceInput & { readonly text: string }): Promise<IngestionOutcome> {
    assertScope(input.scope, input.projectId);
    const source = await this.createSource({
      ...input,
      kind: 'note',
      origin: input.title,
      refreshable: false,
    });
    return this.ingestBytes({
      sourceId: source.id,
      bytes: new TextEncoder().encode(input.text),
      contentType: 'text/markdown',
      filename: `${safeFilename(input.title)}.md`,
      provenance: { ...EMPTY_PROVENANCE, filename: safeFilename(input.title) },
    });
  }

  /** An uploaded file. The kind is decided by the parser registry, not by the filename. */
  async addUpload(
    input: AddSourceInput & {
      readonly bytes: Uint8Array;
      readonly filename: string;
      readonly contentType: string | null;
    },
  ): Promise<IngestionOutcome> {
    assertScope(input.scope, input.projectId);
    if (input.bytes.byteLength > this.options.config.limits.maxUploadBytes) {
      throw new ValidationError(
        `That file is larger than the ${Math.round(this.options.config.limits.maxUploadBytes / 1024 / 1024)} MB Jarvis accepts.`,
      );
    }

    const filename = safeFilename(input.filename);
    const source = await this.createSource({ ...input, origin: filename, refreshable: false });
    return this.ingestBytes({
      sourceId: source.id,
      bytes: input.bytes,
      contentType: input.contentType,
      filename,
      provenance: { ...EMPTY_PROVENANCE, filename, contentType: input.contentType },
    });
  }

  /**
   * A page at an approved URL.
   *
   * The allow-list comes from configuration, never from the request, so a caller cannot widen
   * where Jarvis will fetch from by asking nicely.
   */
  async addUrl(input: AddSourceInput & { readonly url: string }): Promise<IngestionOutcome> {
    assertScope(input.scope, input.projectId);

    const fetched = await this.options.urlFetcher.fetch(input.url, {
      policy: { allowedHosts: this.options.config.knowledge.urlAllowList },
    });

    const source = await this.createSource({
      ...input,
      kind: 'web_url',
      origin: fetched.finalUrl,
      refreshable: true,
    });

    return this.ingestBytes({
      sourceId: source.id,
      bytes: fetched.bytes,
      contentType: fetched.contentType,
      filename: null,
      provenance: {
        ...EMPTY_PROVENANCE,
        requestedUrl: fetched.requestedUrl,
        finalUrl: fetched.finalUrl,
        httpStatus: fetched.status,
        contentType: fetched.contentType,
        etag: fetched.etag,
        lastModified: fetched.lastModified,
      },
    });
  }

  /**
   * A documentation file from a repository the project is already connected to.
   *
   * The repository is **resolved from the project's own sources**, never taken from the request.
   * Accepting an owner/repo pair from a body would let a caller point ingestion at any repository
   * the read credential can see, which is a different and much larger permission than "read this
   * project's documentation".
   */
  async addRepositoryFile(
    input: AddSourceInput & {
      readonly projectId: string;
      readonly path: string;
      readonly ref?: string | null;
    },
  ): Promise<IngestionOutcome> {
    assertScope(input.scope, input.projectId);

    const sources = await this.options.projectSources.listByProject(input.projectId);
    const repository = sources.find((entry) => entry.kind === 'github_repo' && entry.github);
    if (!repository?.github) {
      throw new ValidationError(
        'That project has no connected repository, so there is no documentation to read.',
      );
    }

    const file = await this.options.provider.fetchFile({
      owner: repository.github.owner,
      repo: repository.github.repo,
      path: input.path,
      ...(input.ref ? { ref: input.ref } : {}),
    });
    if (!file) {
      throw new NotFoundError(
        `${input.path} in ${repository.github.owner}/${repository.github.repo}`,
      );
    }

    const source = await this.createSource({
      ...input,
      kind: 'repository_doc',
      origin: `${file.owner}/${file.repo}:${file.path}`,
      refreshable: true,
    });

    return this.ingestBytes({
      sourceId: source.id,
      bytes: new TextEncoder().encode(file.text),
      contentType: 'text/markdown',
      filename: file.path,
      provenance: {
        ...EMPTY_PROVENANCE,
        repositoryFullName: `${file.owner}/${file.repo}`,
        filePath: file.path,
        requestedRef: file.requestedRef,
        commitSha: file.commitSha,
        blobSha: file.blobSha,
      },
    });
  }

  /* ---------------------------------------------------------- refreshing */

  /**
   * Re-read a refreshable source.
   *
   * Unchanged content costs nothing: the revision is content-addressed, so an identical fetch
   * finds the existing revision and returns `changed: false` without re-parsing, re-chunking or
   * re-embedding anything.
   */
  async refresh(sourceId: string): Promise<IngestionOutcome> {
    const source = await this.options.sources.findById(sourceId);
    if (!source) throw new NotFoundError('Source');

    const active = await this.options.revisions.activeFor(sourceId);
    const provenance = active?.provenance ?? EMPTY_PROVENANCE;

    if (source.kind === 'web_url') {
      const url = provenance.requestedUrl ?? provenance.finalUrl ?? source.origin;
      const fetched = await this.options.urlFetcher.fetch(url, {
        policy: { allowedHosts: this.options.config.knowledge.urlAllowList },
      });
      return this.ingestBytes({
        sourceId,
        bytes: fetched.bytes,
        contentType: fetched.contentType,
        filename: null,
        provenance: {
          ...EMPTY_PROVENANCE,
          requestedUrl: fetched.requestedUrl,
          finalUrl: fetched.finalUrl,
          httpStatus: fetched.status,
          contentType: fetched.contentType,
          etag: fetched.etag,
          lastModified: fetched.lastModified,
        },
      });
    }

    if (source.kind === 'repository_doc') {
      const [owner, repo] = (provenance.repositoryFullName ?? '/').split('/');
      if (!owner || !repo || !provenance.filePath) {
        throw new ValidationError(
          'That source does not record which repository file it came from.',
        );
      }
      const file = await this.options.provider.fetchFile({
        owner,
        repo,
        path: provenance.filePath,
        ...(provenance.requestedRef ? { ref: provenance.requestedRef } : {}),
      });
      if (!file) throw new NotFoundError(`${provenance.filePath} in ${owner}/${repo}`);

      return this.ingestBytes({
        sourceId,
        bytes: new TextEncoder().encode(file.text),
        contentType: 'text/markdown',
        filename: file.path,
        provenance: {
          ...EMPTY_PROVENANCE,
          repositoryFullName: `${file.owner}/${file.repo}`,
          filePath: file.path,
          requestedRef: file.requestedRef,
          commitSha: file.commitSha,
          blobSha: file.blobSha,
        },
      });
    }

    throw new ValidationError(
      'That source has no origin Jarvis can re-read. Notes and uploaded files are refreshed by replacing them.',
    );
  }

  /* ------------------------------------------------------------ pipeline */

  /**
   * The pipeline itself, from bytes to an active revision.
   *
   * Every failure marks the revision failed with a code and leaves the previous active revision
   * exactly where it was. The job row makes the attempt visible on the Operations screen whether
   * it succeeded or not — a failure nobody can see is a failure nobody fixes.
   */
  private async ingestBytes(input: {
    readonly sourceId: string;
    readonly bytes: Uint8Array;
    readonly contentType: string | null;
    readonly filename: string | null;
    readonly provenance: RevisionProvenance;
  }): Promise<IngestionOutcome> {
    const source = await this.options.sources.findById(input.sourceId);
    if (!source) throw new NotFoundError('Source');

    const jobId = await this.options.revisions.enqueue({
      sourceId: input.sourceId,
      revisionId: null,
      kind: 'ingest',
      requestedBy: source.addedBy,
    });

    try {
      const { document, parser } = await this.options.parsers.parse({
        bytes: input.bytes,
        contentType: input.contentType,
        filename: input.filename,
        maxChars: PARSER_LIMITS.maxChars,
      });

      assertRevisionDescribable({
        parserName: parser.name,
        parserVersion: parser.version,
        chunkerVersion: CHUNKER_VERSION,
      });

      const canonicalText = canonicaliseText(document.canonicalText);
      const contentHash = revisionContentHash({
        canonicalText,
        parserName: parser.name,
        parserVersion: parser.version,
      });

      const active = await this.options.revisions.activeFor(input.sourceId);
      const { revision, created } = await this.options.revisions.create({
        sourceId: input.sourceId,
        contentHash,
        byteHash: byteHash(input.bytes),
        byteSize: input.bytes.byteLength,
        charCount: canonicalText.length,
        unitCount: document.unitCount,
        unitKind: document.unitKind,
        canonicalText,
        parserName: parser.name,
        parserVersion: parser.version,
        chunkerVersion: CHUNKER_VERSION,
        truncated: document.truncated,
        limitations: document.limitations,
        provenance: input.provenance,
      });

      /*
       * Unchanged content, already active: nothing to do. Returning early here is what makes
       * refreshing a stable document free rather than a full reindex every time.
       */
      if (!created && active?.id === revision.id) {
        await this.options.revisions.finishJob(jobId, { state: 'succeeded' });
        await this.options.sources.patch(input.sourceId, { state: 'ready' });
        return {
          sourceId: input.sourceId,
          revisionId: revision.id,
          revisionNumber: revision.revisionNumber,
          created: false,
          changed: false,
          chunkCount: revision.chunkCount,
          state: revision.state,
          limitations: document.limitations,
        };
      }

      await this.options.sources.patch(input.sourceId, { state: 'parsing' });
      const blockCount = await this.options.revisions.replaceBlocks(revision.id, document.blocks);

      const chunked = deriveChunks({
        blocks: document.blocks,
        filePath: input.provenance.filePath,
      });
      const chunkCount = await this.options.revisions.replaceChunks({
        revisionId: revision.id,
        sourceId: input.sourceId,
        projectId: source.projectId,
        chunkerVersion: chunked.chunkerVersion,
        chunks: chunked.chunks,
      });

      const limitations = [...document.limitations];
      if (chunked.droppedDuplicates > 0) {
        limitations.push(
          `${chunked.droppedDuplicates} repeated passages (page furniture) were not indexed.`,
        );
      }

      await this.options.revisions.patch(revision.id, {
        state: 'ready_lexical',
        blockCount,
        chunkCount,
        limitations,
      });

      /* Lexically searchable from here. Activation happens now; embeddings follow. */
      const activated = await this.options.revisions.activate(revision.id, this.clock());
      await this.options.sources.patch(input.sourceId, {
        state: 'ready',
        chunkCount,
        charCount: canonicalText.length,
        unitCount: document.unitCount,
        truncated: document.truncated,
        parsedAt: this.clock(),
        failureCode: null,
        failureMessage: null,
      });

      const embedded = await this.embedRevision(revision.id);
      await this.options.revisions.finishJob(jobId, { state: 'succeeded' });

      /* Retire content that retention no longer requires, keeping the citation window. */
      await this.pruneRevisions(input.sourceId);

      return {
        sourceId: input.sourceId,
        revisionId: activated.id,
        revisionNumber: activated.revisionNumber,
        created,
        changed: true,
        chunkCount,
        state: embedded ? 'ready' : 'ready_lexical',
        limitations,
      };
    } catch (error) {
      const code = error instanceof ParseError ? error.code : 'ingest_failed';
      const message = error instanceof Error ? error.message : 'Ingestion failed.';

      await this.options.sources.patch(input.sourceId, {
        state: 'failed',
        failureCode: parseFailureToSourceFailure(code),
        failureMessage: message,
      });
      await this.options.revisions.finishJob(jobId, {
        state: 'failed',
        failureCode: code,
        failureMessage: message,
      });
      throw error;
    }
  }

  /**
   * Embed a revision's chunks, best effort.
   *
   * Returns whether the revision is now fully embedded. A failure is recorded per chunk and the
   * revision stays `ready_lexical`, so retrieval reports `hybrid_degraded` rather than pretending
   * the semantic index covers this document.
   */
  async embedRevision(revisionId: string): Promise<boolean> {
    const provider = this.options.embeddings;
    if (!provider || !provider.isConfigured()) return false;

    const outstanding = await this.options.revisions.chunksNeedingEmbedding({
      revisionId,
      model: provider.model,
      indexingVersion: provider.indexingVersion,
    });
    if (outstanding.length === 0) {
      await this.options.revisions.patch(revisionId, { state: 'ready' });
      return true;
    }

    let embedded = 0;
    let failed = 0;

    for (const batch of batchTexts(outstanding.map((chunk) => chunk.text))) {
      const slice = outstanding.slice(embedded + failed, embedded + failed + batch.length);
      try {
        const result = await provider.embed(batch);
        for (const [index, vector] of result.vectors.entries()) {
          const chunk = slice[index];
          if (!chunk) continue;
          /* Re-validated here as well as in the provider: a wrong-width vector must not be stored. */
          const checked = normaliseVector([...vector.values], provider.dimensions);
          await this.options.revisions.saveChunkEmbedding({
            chunkId: chunk.id,
            provider: provider.name,
            model: provider.model,
            indexingVersion: provider.indexingVersion,
            vector: checked,
          });
          embedded += 1;
        }
      } catch (error) {
        for (const chunk of slice) {
          await this.options.revisions.recordEmbeddingFailure({
            chunkId: chunk.id,
            itemId: null,
            provider: provider.name,
            model: provider.model,
            indexingVersion: provider.indexingVersion,
            dimensions: provider.dimensions,
            message: error instanceof Error ? error.message : 'Embedding failed.',
          });
          failed += 1;
        }
      }
    }

    await this.options.revisions.patch(revisionId, {
      state: failed === 0 ? 'ready' : 'ready_lexical',
      embeddedChunkCount: embedded,
    });
    return failed === 0;
  }

  /* ------------------------------------------------------------ lifecycle */

  /**
   * Delete a source and everything derived from it.
   *
   * Destructive on purpose. Chunks go, embeddings go with them by cascade, canonical text goes,
   * and the source row survives holding no content — so the fact that it existed stays auditable
   * while nothing it contained can be retrieved, exported or placed in a model context.
   */
  async deleteSource(sourceId: string): Promise<{ readonly chunksRemoved: number }> {
    const revisions = await this.options.revisions.list(sourceId, 500);
    let removed = 0;
    for (const revision of revisions) {
      removed += await this.options.revisions.purge(revision.id);
    }
    removed += await this.options.sources.purge(sourceId);
    return { chunksRemoved: removed };
  }

  /** Keep the citation window, destroy the rest. */
  private async pruneRevisions(sourceId: string): Promise<void> {
    const stale = await this.options.revisions.supersededBefore(
      sourceId,
      REVISION_LIMITS.keepSuperseded,
    );
    for (const revisionId of stale) {
      await this.options.revisions.purge(revisionId);
    }
  }

  private async createSource(
    input: AddSourceInput & {
      readonly kind: SourceKind;
      readonly origin: string;
      readonly refreshable: boolean;
    },
  ) {
    return this.options.sources.create({
      kind: input.kind,
      title: input.title,
      origin: input.origin,
      /* A placeholder until the first revision decides it; the source-level hash is a lookup aid. */
      contentHash: `pending:${input.origin}:${Date.now()}`,
      projectId: input.projectId,
      byteSize: 0,
      charCount: 0,
      addedBy: input.addedBy,
      tags: input.tags ?? [],
      scope: input.scope,
      sensitivity: input.sensitivity,
      refreshable: input.refreshable,
    });
  }
}

/** A project-scoped source has to say which project, and a global one must not name one. */
function assertScope(scope: KnowledgeScope, projectId: string | null): void {
  if (scope === 'project' && !projectId) {
    throw new ValidationError('A project-scoped source has to say which project it belongs to.');
  }
  if (scope !== 'project' && projectId) {
    throw new ValidationError(
      `A ${scope} source applies everywhere, so it cannot also belong to one project.`,
    );
  }
}

/**
 * Map a parser failure onto the source-level code the interface already knows how to show.
 *
 * Every parser code has a source code, and the mapping keeps the distinctions that matter to the
 * owner: `no_text_layer` stays itself rather than collapsing into a generic parse error, because
 * "this is a scan" and "this file is broken" call for different responses.
 */
function parseFailureToSourceFailure(code: string): SourceFailureCode {
  switch (code) {
    case 'too_large':
      return 'too_large';
    case 'unsupported_type':
      return 'unsupported_type';
    case 'encrypted':
      return 'encrypted';
    case 'no_text_layer':
      return 'no_text_layer';
    case 'empty':
      return 'empty';
    case 'timeout':
      return 'timeout';
    default:
      return 'parse_error';
  }
}
