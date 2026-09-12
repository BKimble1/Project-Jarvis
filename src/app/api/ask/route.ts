import { askTurnSchema } from '@/domain/answer-run';
import { presentAnswer } from '@/server/ask/present';
import { json, ownerRoute, parseBody } from '@/server/http/handler';

export const dynamic = 'force-dynamic';

/**
 * Ask a question.
 *
 * The only thing the caller supplies that changes the answer is the question and, within the
 * conversation's stored ceiling, a narrower scope. There is no audience field, no sensitivity
 * field and no way to widen the projects — the service refuses each rather than honouring it, so
 * this handler has nothing to get right beyond passing the session through.
 */
export const POST = ownerRoute(async ({ services, request, session }) => {
  const body = await parseBody(request, askTurnSchema);
  const ownerId = session.githubLogin ?? session.id;

  const result = await services.answerService.ask(body, ownerId);

  return json(
    {
      answer: presentAnswer(result),
      conversation: {
        id: result.conversation.id,
        title: result.conversation.title,
        scope: result.conversation.scope,
        projectIds: result.conversation.projectIds,
      },
      /* True when a retry found the request already in hand rather than generating again. */
      reused: result.reused,
    },
    { status: result.reused ? 200 : 201 },
  );
});
