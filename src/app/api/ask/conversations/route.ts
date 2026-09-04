import { ANSWER_SCOPE_LABELS } from '@/domain/answer';
import { conversationCreateSchema } from '@/domain/conversation';
import { json, ownerRoute, parseBody } from '@/server/http/handler';

export const dynamic = 'force-dynamic';

/** Every conversation this owner has. Ownership is a predicate in the query, not a check after. */
export const GET = ownerRoute(async ({ services, session }) => {
  const ownerId = session.githubLogin ?? session.id;
  const conversations = await services.answerService.listConversations(ownerId);
  return json({
    conversations: conversations.map((conversation) => ({
      id: conversation.id,
      title: conversation.title,
      scope: conversation.scope,
      scopeLabel: ANSWER_SCOPE_LABELS[conversation.scope],
      projectIds: conversation.projectIds,
      answerCount: conversation.answerCount,
      lastAnsweredAt: conversation.lastAnsweredAt,
      updatedAt: conversation.updatedAt,
    })),
  });
});

/** Start one. The scope is validated now, so a conversation cannot exist in an impossible state. */
export const POST = ownerRoute(async ({ services, request, session }) => {
  const body = await parseBody(request, conversationCreateSchema);
  const ownerId = session.githubLogin ?? session.id;

  const conversation = await services.answerService.startConversation(
    {
      ...(body.title ? { title: body.title } : {}),
      scope: body.scope,
      projectIds: body.projectIds,
    },
    ownerId,
  );

  return json({ conversation }, { status: 201 });
});
