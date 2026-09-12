import { SOURCE_KIND_LABELS, addSourceSchema } from '@/domain/knowledge-source';
import { json, ownerRoute, parseBody } from '@/server/http/handler';

export const dynamic = 'force-dynamic';

/**
 * The sources Jarvis has read.
 *
 * Every row says what state its ingestion is in and why, because "it is in there somewhere" is
 * the thing this screen exists to replace. A failure is reported with its code and the sentence
 * that explains it, not swallowed into an empty list.
 *
 * `bodyText` is not in the response and cannot be: `toKnowledgeSource` has no such field, so a
 * listing physically cannot ship a private document's contents.
 */
export const GET = ownerRoute(async ({ services, request }) => {
  const url = new URL(request.url);
  const projectId = url.searchParams.get('projectId');

  const sources = await services.knowledgeSources.list({
    ...(projectId ? { projectId } : {}),
    limit: 200,
  });

  const withRevisions = await Promise.all(
    sources.map(async (source) => {
      const revisions = await services.revisions.list(source.id, 10);
      const active = revisions.find((revision) => revision.isActive) ?? null;
      return {
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
        chunkCount: source.chunkCount,
        charCount: source.charCount,
        byteSize: source.byteSize,
        unitCount: source.unitCount,
        truncated: source.truncated,
        failureCode: source.failureCode,
        failureMessage: source.failureMessage,
        addedBy: source.addedBy,
        createdAt: source.createdAt,
        lastRefreshedAt: source.lastRefreshedAt,
        revisionCount: revisions.length,
        activeRevision: active
          ? {
              id: active.id,
              number: active.revisionNumber,
              state: active.state,
              parser: `${active.parserName}@${active.parserVersion}`,
              chunkCount: active.chunkCount,
              embeddedChunkCount: active.embeddedChunkCount,
              activatedAt: active.activatedAt,
            }
          : null,
      };
    }),
  );

  return json({ sources: withRevisions });
});

/**
 * Add a source.
 *
 * The three origins are separate variants rather than one shape with optional fields, and each
 * one dispatches to the ingestion method that carries its own guarantees: a URL through the SSRF
 * boundary, a repository file through the project's existing connection. The audit event is
 * written by the route because adding a source is an owner action with a request behind it.
 */
export const POST = ownerRoute(async ({ services, request, session }) => {
  const body = await parseBody(request, addSourceSchema);
  const actor = session.githubLogin ?? session.id;

  const common = {
    title: body.title,
    scope: body.scope,
    projectId: body.projectId ?? null,
    sensitivity: body.sensitivity,
    addedBy: actor,
    tags: body.tags,
  };

  try {
    const outcome =
      body.kind === 'note'
        ? await services.ingestion.addNote({ ...common, kind: 'note', text: body.text })
        : body.kind === 'web_url'
          ? await services.ingestion.addUrl({ ...common, kind: 'web_url', url: body.url })
          : await services.ingestion.addRepositoryFile({
              ...common,
              kind: 'repository_doc',
              /* Narrowed by the schema: a repository source always names its project. */
              projectId: body.projectId,
              path: body.path,
              ...(body.ref ? { ref: body.ref } : {}),
            });

    await services.audit.append({
      actor,
      actorKind: 'owner',
      action: 'source.add',
      subjectKind: 'knowledge_source',
      subjectId: outcome.sourceId,
      projectId: body.projectId ?? null,
      outcome: 'allowed',
      rule: 'R-SR1',
      summary: `You added a ${SOURCE_KIND_LABELS[body.kind].toLowerCase()} to Jarvis's knowledge.`,
      /* Classification and counts. Never the document's text. */
      detail: {
        kind: body.kind,
        scope: body.scope,
        sensitivity: body.sensitivity,
        chunkCount: outcome.chunkCount,
        revisionState: outcome.state,
      },
    });

    return json({ ...outcome, limitations: outcome.limitations }, { status: 201 });
  } catch (error) {
    /*
     * A refused fetch is worth auditing on its own. This is the record that says Jarvis was asked
     * to reach an address and declined — the message only, never a resolved address, because the
     * refusal reason is for me and the address is what the attacker wanted confirmed.
     */
    if (body.kind === 'web_url') {
      await services.audit.append({
        actor,
        actorKind: 'owner',
        action: 'source.fetch_refused',
        subjectKind: 'knowledge_source',
        subjectId: null,
        projectId: body.projectId ?? null,
        outcome: 'refused',
        rule: 'R-NG1',
        summary: 'A URL import was refused.',
        detail: { reason: error instanceof Error ? error.message : 'Refused.' },
      });
    }
    throw error;
  }
});
