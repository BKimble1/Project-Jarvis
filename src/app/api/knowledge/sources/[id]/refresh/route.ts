import { NotFoundError, ValidationError } from '@/domain/errors';
import { json, ownerRouteWithParams } from '@/server/http/handler';

export const dynamic = 'force-dynamic';

/**
 * Re-read a source from its origin.
 *
 * Reports `changed: false` honestly when the content hash matches, rather than inventing a
 * revision so the screen has something new to show. An unchanged refresh is a useful answer: it
 * means every existing citation is still current.
 *
 * A failure here leaves the previous revision active and serving, which is the ordering guarantee
 * the ingestion pipeline exists to provide — so a URL that has started returning a login page
 * does not take the last good copy down with it.
 */
export const POST = ownerRouteWithParams<{ id: string }>(async ({ services, params, session }) => {
  const source = await services.knowledgeSources.findById(params.id);
  if (!source || source.deletedAt) throw new NotFoundError('Source');
  if (!source.refreshable) {
    throw new ValidationError(
      'There is nothing to re-read: this was typed in or uploaded rather than fetched from somewhere.',
    );
  }

  const outcome = await services.ingestion.refresh(params.id);
  const actor = session.githubLogin ?? session.id;

  await services.audit.append({
    actor,
    actorKind: 'owner',
    action: 'source.add',
    subjectKind: 'knowledge_source',
    subjectId: params.id,
    projectId: source.projectId,
    outcome: 'allowed',
    rule: 'R-SR3',
    summary: outcome.changed
      ? `“${source.title}” had changed, so Jarvis stored revision ${outcome.revisionNumber}.`
      : `“${source.title}” had not changed since Jarvis last read it.`,
    detail: {
      changed: outcome.changed,
      revisionNumber: outcome.revisionNumber,
      chunkCount: outcome.chunkCount,
    },
  });

  return json(outcome);
});
