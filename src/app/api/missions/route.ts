import { z } from 'zod';
import { missionDraftSchema } from '@/domain/mission';
import type { MissionState } from '@/domain/mission';
import { json, ownerRoute, parseBody } from '@/server/http/handler';

export const dynamic = 'force-dynamic';

const createSchema = missionDraftSchema.extend({
  /** Free text naming a project, used only when no `projectId` was chosen. */
  projectHint: z.string().trim().max(120).nullish(),
});

export const GET = ownerRoute(async ({ services, request }) => {
  const url = new URL(request.url);
  const states = url.searchParams.getAll('state') as MissionState[];
  const page = await services.missions.list({
    ...(states.length > 0 ? { states } : {}),
    ...(url.searchParams.get('project') ? { projectId: url.searchParams.get('project')! } : {}),
    ...(url.searchParams.get('search') ? { search: url.searchParams.get('search')! } : {}),
    ...(url.searchParams.get('needsMe') === 'true' ? { needsOwner: true } : {}),
    limit: Math.min(200, Number(url.searchParams.get('limit') ?? 100)),
  });
  return json(page);
});

export const POST = ownerRoute(async ({ services, session, request }) => {
  const { projectHint, ...draft } = await parseBody(request, createSchema);
  const result = await services.missions.create(draft, session.githubLogin ?? null, {
    projectHint: projectHint ?? null,
  });
  return json(result, { status: 201 });
});
