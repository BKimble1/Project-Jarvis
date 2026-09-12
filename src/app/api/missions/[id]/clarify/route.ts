import { clarificationAnswerSchema } from '@/domain/mission';
import { json, ownerRouteWithParams, parseBody } from '@/server/http/handler';

export const dynamic = 'force-dynamic';

export const POST = ownerRouteWithParams<{ id: string }>(async ({ services, request, params }) => {
  const input = await parseBody(request, clarificationAnswerSchema);
  const result = await services.missions.answerClarification(params.id, input.questionId, {
    ...(input.answer !== undefined ? { answer: input.answer } : {}),
    acceptRecommendation: input.acceptRecommendation,
  });
  return json(result);
});
