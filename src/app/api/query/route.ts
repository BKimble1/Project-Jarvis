import { z } from 'zod';
import { json, ownerRoute, parseBody } from '@/server/http/handler';

export const dynamic = 'force-dynamic';

const querySchema = z.object({ query: z.string().trim().min(1).max(500) });

export const POST = ownerRoute(async ({ services, request }) => {
  const { query } = await parseBody(request, querySchema);
  const answer = await services.router.answer(query);
  return json({ answer });
});

export const GET = ownerRoute(async ({ services }) => {
  const history = await services.queryHistory.recent(12);
  return json({ history });
});
