import { z } from 'zod';
import { FORGET_CONFIRMATION, knowledgeUpdateSchema } from '@/domain/knowledge';
import { json, ownerRouteWithParams, parseBody } from '@/server/http/handler';

export const dynamic = 'force-dynamic';

/**
 * A decision about one memory.
 *
 * Approve, reject, archive and restore share this route because they share the authority check:
 * `canDecide` runs before any of them, and its refusal is the same refusal whichever was asked
 * for. Forgetting is here too but is gated separately by a typed confirmation, because it is the
 * only one that destroys.
 */
const decisionSchema = z.discriminatedUnion('decision', [
  z.object({
    decision: z.enum(['approve', 'reject', 'archive', 'restore']),
    reason: z.string().trim().max(600).nullish(),
  }),
  z.object({
    decision: z.literal('forget'),
    reason: z.string().trim().max(600).nullish(),
    /* Required, and compared exactly. A missing field is a refusal, not a default. */
    confirmation: z.string(),
  }),
]);

export const POST = ownerRouteWithParams<{ id: string }>(async ({ services, params, request, session }) => {
  const body = await parseBody(request, decisionSchema);
  const actor = { actor: session.githubLogin ?? session.id, actorKind: 'owner' as const };

  if (body.decision === 'forget') {
    const result = await services.memoryService.forget(
      params.id,
      { confirmation: body.confirmation, reason: body.reason ?? null },
      actor,
    );
    return json({
      memory: result.item,
      embeddingsRemoved: result.embeddingsRemoved,
      /* Echoed so the interface can say what was actually done, in the same words each time. */
      confirmationPhrase: FORGET_CONFIRMATION,
    });
  }

  const memory = await services.memoryService.decide(
    params.id,
    { decision: body.decision, reason: body.reason ?? null },
    actor,
  );
  return json({ memory });
});

/** Edit wording, classification, scope or review dates. Never origin, status or authorship. */
export const PATCH = ownerRouteWithParams<{ id: string }>(
  async ({ services, params, request, session }) => {
    const body = await parseBody(request, knowledgeUpdateSchema);
    const memory = await services.memoryService.edit(params.id, body, {
      actor: session.githubLogin ?? session.id,
      actorKind: 'owner',
    });
    return json({ memory });
  },
);
