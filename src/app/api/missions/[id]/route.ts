import { z } from 'zod';
import { missionUpdateSchema } from '@/domain/mission';
import { json, ownerRouteWithParams, parseBody } from '@/server/http/handler';

export const dynamic = 'force-dynamic';

export const GET = ownerRouteWithParams<{ id: string }>(async ({ services, params }) => {
  return json(await services.missions.detail(params.id));
});

export const PATCH = ownerRouteWithParams<{ id: string }>(async ({ services, request, params }) => {
  const input = await parseBody(request, missionUpdateSchema);
  return json(await services.missions.update(params.id, input));
});

const deleteSchema = z.object({ reason: z.string().trim().max(500).nullish() });

/**
 * Cancels rather than deletes.
 *
 * A mission is an audit record of something that was asked for and decided on; removing the row
 * would remove the explanation of whatever it produced.
 */
export const DELETE = ownerRouteWithParams<{ id: string }>(
  async ({ services, request, params }) => {
    const url = new URL(request.url);
    const reason = deleteSchema.parse({ reason: url.searchParams.get('reason') }).reason ?? null;
    return json({ mission: await services.missions.cancel(params.id, reason) });
  },
);
