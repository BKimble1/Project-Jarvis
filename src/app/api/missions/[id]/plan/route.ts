import { z } from 'zod';
import { planEditSchema, planRevisionSchema } from '@/domain/mission-plan';
import { json, ownerRouteWithParams, parseBody } from '@/server/http/handler';

export const dynamic = 'force-dynamic';

/** Ask Jarvis to produce a plan — through a worker if one is connected, deterministically if not. */
export const POST = ownerRouteWithParams<{ id: string }>(async ({ services, params }) => {
  const result = await services.missions.requestPlan(params.id);
  return json(result, { status: 201 });
});

const actionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('edit') }).merge(planEditSchema),
  z.object({ action: z.literal('revise') }).merge(planRevisionSchema),
  z.object({ action: z.literal('reject'), reason: z.string().trim().max(1000).nullish() }),
]);

export const PATCH = ownerRouteWithParams<{ id: string }>(async ({ services, request, params }) => {
  const input = await parseBody(request, actionSchema);
  switch (input.action) {
    case 'edit':
      return json({ mission: await services.missions.editPlan(params.id, input.content) });
    case 'revise':
      return json({
        mission: await services.missions.requestRevision(params.id, input.instruction),
      });
    case 'reject':
      return json({ mission: await services.missions.rejectPlan(params.id, input.reason ?? null) });
  }
});
