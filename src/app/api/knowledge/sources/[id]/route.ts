import { NotFoundError } from '@/domain/errors';
import { SOURCE_KIND_LABELS } from '@/domain/knowledge-source';
import { citationRef } from '@/domain/knowledge-revision';
import { json, ownerRouteWithParams } from '@/server/http/handler';

export const dynamic = 'force-dynamic';

/**
 * One source and its revision history.
 *
 * The history is the point of the screen: a citation made three months ago names a revision, and
 * this is where a person checks that the revision still exists and what it said. Each entry
 * carries the parser and chunker that produced it, because a change in either is a legitimate
 * reason for the same document to chunk differently.
 */
export const GET = ownerRouteWithParams<{ id: string }>(async ({ services, params }) => {
  const source = await services.knowledgeSources.findById(params.id);
  if (!source || source.deletedAt) throw new NotFoundError('Source');

  const revisions = await services.revisions.list(source.id, 50);

  return json({
    source: {
      id: source.id,
      kind: source.kind,
      kindLabel: SOURCE_KIND_LABELS[source.kind],
      state: source.state,
      title: source.title,
      origin: source.origin,
      scope: source.scope,
      sensitivity: source.sensitivity,
      projectId: source.projectId,
      refreshable: source.refreshable,
      contentType: source.contentType,
      byteSize: source.byteSize,
      charCount: source.charCount,
      chunkCount: source.chunkCount,
      unitCount: source.unitCount,
      truncated: source.truncated,
      failureCode: source.failureCode,
      failureMessage: source.failureMessage,
      addedBy: source.addedBy,
      createdAt: source.createdAt,
      lastRefreshedAt: source.lastRefreshedAt,
      retainUntil: source.retainUntil,
    },
    revisions: revisions.map((revision) => {
      const cited = citationRef(revision.provenance);
      return {
        id: revision.id,
        number: revision.revisionNumber,
        state: revision.state,
        isActive: revision.isActive,
        contentHash: revision.contentHash,
        charCount: revision.charCount,
        blockCount: revision.blockCount,
        chunkCount: revision.chunkCount,
        embeddedChunkCount: revision.embeddedChunkCount,
        parser: `${revision.parserName}@${revision.parserVersion}`,
        chunker: revision.chunkerVersion,
        truncated: revision.truncated,
        failureCode: revision.failureCode,
        failureMessage: revision.failureMessage,
        fetchedAt: revision.fetchedAt,
        activatedAt: revision.activatedAt,
        supersededAt: revision.supersededAt,
        citation: { ref: cited.ref, kind: cited.kind, display: cited.display },
      };
    }),
  });
});

/**
 * Delete a source and everything derived from it.
 *
 * Destructive, and deliberately so: the text, the chunks, the blocks and the embeddings go. What
 * survives is a row saying a source existed and was removed, which is what makes the deletion
 * auditable without keeping the thing that was deleted.
 */
export const DELETE = ownerRouteWithParams<{ id: string }>(
  async ({ services, params, session }) => {
    const source = await services.knowledgeSources.findById(params.id);
    if (!source || source.deletedAt) throw new NotFoundError('Source');

    const result = await services.ingestion.deleteSource(params.id);
    const actor = session.githubLogin ?? session.id;

    await services.deletionReceipts.record({
      subjectKind: 'knowledge_source',
      subjectId: params.id,
      reason: 'Deleted at your request.',
      itemCount: result.chunksRemoved,
      requestedBy: actor,
      scrubbedTargets: [
        'knowledge_sources.body_text',
        'knowledge_chunks',
        'knowledge_blocks',
        'knowledge_embeddings',
        'knowledge_revisions',
      ],
    });

    await services.audit.append({
      actor,
      actorKind: 'owner',
      action: 'source.delete',
      subjectKind: 'knowledge_source',
      subjectId: params.id,
      projectId: source.projectId,
      outcome: 'allowed',
      rule: 'R-SR2',
      /* The title is the owner's own words for it, and is what makes the trail readable. */
      summary: `You deleted the source “${source.title}”.`,
      detail: { kind: source.kind, chunksRemoved: result.chunksRemoved },
    });

    return json({ deleted: true, chunksRemoved: result.chunksRemoved });
  },
);
