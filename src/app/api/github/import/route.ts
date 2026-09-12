import { importRequestSchema } from '@/server/services/import-service';
import { json, ownerRoute, parseBody } from '@/server/http/handler';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export const POST = ownerRoute(async ({ services, request }) => {
  const input = await parseBody(request, importRequestSchema);
  const result = await services.imports.import(input);
  await services.briefings.briefProject(result.project.id, { regenerate: true }).catch(() => {});
  return json(result, { status: 201 });
});
