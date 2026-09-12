import { z } from 'zod';
import { capacityAdjustmentSchema, capacityPostureSchema } from '@/domain/capacity';
import { json, ownerRoute, parseBody } from '@/server/http/handler';

export const dynamic = 'force-dynamic';

export const GET = ownerRoute(async ({ services }) => {
  const [posture, limits, activeRuns, activeMissions] = await Promise.all([
    services.orchestrator.posture(),
    services.orchestrator.limits(),
    services.tasks.countActive(),
    services.tasks.countActiveMissions(),
  ]);
  return json({ posture, limits, activeRuns, activeMissions });
});

const bodySchema = z.union([
  capacityPostureSchema.extend({ kind: z.literal('posture') }),
  capacityAdjustmentSchema.extend({ kind: z.literal('limits') }),
]);

/**
 * Change how much Jarvis may be doing.
 *
 * Two shapes, both of which only ever *reduce*. `posture` drains or stops the instance
 * immediately; `limits` lowers concurrency. Raising a limit is a configuration change made
 * deliberately and restarted into — because the direction that matters in an emergency is down,
 * and a slider that can go both ways is one that can go the wrong way under pressure.
 */
export const POST = ownerRoute(async ({ services, request }) => {
  const input = await parseBody(request, bodySchema);
  if (input.kind === 'posture') {
    await services.orchestrator.setPosture(input.posture, input.reason ?? null);
    await services.activity.record({
      kind: 'capacity_changed',
      summary: `Jarvis is now ${input.posture}.`,
    });
    return json({ posture: input.posture });
  }
  const current = await services.orchestrator.limits();
  const next = {
    maxActiveRuns: Math.min(current.maxActiveRuns, input.maxActiveRuns ?? current.maxActiveRuns),
    maxRunsPerMission: Math.min(
      current.maxRunsPerMission,
      input.maxRunsPerMission ?? current.maxRunsPerMission,
    ),
    maxParallelReadOnly: Math.min(
      current.maxParallelReadOnly,
      input.maxParallelReadOnly ?? current.maxParallelReadOnly,
    ),
  };
  await services.settings.set('jarvis.capacity.limits', next);
  await services.activity.record({
    kind: 'capacity_changed',
    summary: `Concurrency reduced to ${next.maxActiveRuns} agent(s) across all missions.`,
  });
  return json({ limits: await services.orchestrator.limits() });
});
