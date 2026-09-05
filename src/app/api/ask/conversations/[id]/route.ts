import { conversationPatchSchema } from '@/domain/conversation';
import { presentAnswer } from '@/server/ask/present';
import { json, ownerRouteWithParams, parseBody } from '@/server/http/handler';

export const dynamic = 'force-dynamic';

/**
 * One conversation and every turn in it.
 *
 * The evidence is deliberately not included: an answer's snapshot can be large, and a history
 * view needs the questions and headlines rather than every excerpt again. Evidence is fetched per
 * answer, by an owner-scoped route, when somebody actually opens it.
 */
export const GET = ownerRouteWithParams<{ id: string }>(async ({ services, params, session }) => {
  const ownerId = session.githubLogin ?? session.id;
  const runs = await services.answerService.history(params.id, ownerId);

  return json({
    answers: runs.map((run) =>
      presentAnswer({
        run,
        conversation: {
          id: run.conversationId,
          title: '',
          scope: run.scope,
          projectIds: run.projectIds,
          ownerId,
          createdAt: run.createdAt,
          updatedAt: run.createdAt,
          lastAnsweredAt: null,
          answerCount: 0,
          deletedAt: null,
          retainUntil: null,
        },
        snapshot: {
          items: [],
          allowedCitations: new Set<string>(),
          allowedProjectIds: new Set<string>(),
          retrievalMode: run.retrievalMode ?? 'unavailable',
          retrievalApiVersion: '1.0.0',
          rankingVersion: '1.0.0',
          charCount: 0,
          truncated: false,
          gaps: [],
        },
        claims: [],
        headline: run.headline ?? '',
        coverage: {
          projectsConsidered: 0,
          evidenceConsidered: 0,
          missionsConsidered: 0,
          knowledgeConsidered: 0,
          sourcesConsidered: 0,
          truncated: false,
          gaps: [],
        },
        missionSuggestion: null,
        reused: false,
      }),
    ),
  });
});

/**
 * Rename, or change what the conversation may look at.
 *
 * A scope change takes effect on the very next turn, because every turn re-reads this row rather
 * than inheriting a filter. Narrowing also drops out-of-scope turns from the history a follow-up
 * may use, so material discussed under a wider scope is not carried forward as prose.
 */
export const PATCH = ownerRouteWithParams<{ id: string }>(
  async ({ services, params, request, session }) => {
    const body = await parseBody(request, conversationPatchSchema);
    const ownerId = session.githubLogin ?? session.id;

    let conversation;
    if (body.scope !== undefined || body.projectIds !== undefined) {
      const current = await services.answerService.listConversations(ownerId);
      const existing = current.find((entry) => entry.id === params.id);
      conversation = await services.answerService.rescopeConversation(
        params.id,
        {
          scope: body.scope ?? existing?.scope ?? 'portfolio',
          projectIds: body.projectIds ?? existing?.projectIds ?? [],
        },
        ownerId,
      );
    }
    if (body.title !== undefined) {
      conversation = await services.answerService.renameConversation(
        params.id,
        body.title,
        ownerId,
      );
    }

    return json({ conversation });
  },
);

/** Delete it, and every answer and excerpt in it. */
export const DELETE = ownerRouteWithParams<{ id: string }>(
  async ({ services, params, session }) => {
    const ownerId = session.githubLogin ?? session.id;
    const result = await services.answerService.deleteConversation(params.id, ownerId);
    return json({ deleted: true, answersRemoved: result.removed });
  },
);
