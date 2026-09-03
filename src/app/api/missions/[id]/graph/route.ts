import { z } from 'zod';
import { json, ownerRouteWithParams, parseBody } from '@/server/http/handler';

export const dynamic = 'force-dynamic';

/** The current task graph, its tasks and the shape of its schedule. */
export const GET = ownerRouteWithParams<{ id: string }>(async ({ services, params }) => {
  const view = await services.orchestrator.tryView(params.id);
  return json({ graph: view });
});

const proposeSchema = z.object({
  playbookKey: z.string().trim().max(60).nullish(),
  playbookVersion: z.number().int().min(1).nullish(),
  inputs: z.record(z.string().max(48), z.string().max(2000)).default({}),
});

/**
 * Propose a task graph for the approved plan.
 *
 * Owner-authenticated only. An agent may suggest a playbook in its output; it has no route by
 * which it could ask for a graph to be proposed, let alone approved.
 */
export const POST = ownerRouteWithParams<{ id: string }>(async ({ services, request, params }) => {
  const input = await parseBody(request, proposeSchema);
  const proposal = await services.orchestrator.proposeGraph(params.id, {
    playbookKey: input.playbookKey ?? null,
    playbookVersion: input.playbookVersion ?? null,
    inputs: input.inputs,
  });
  return json({ proposal }, { status: 201 });
});
