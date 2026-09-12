import { z } from 'zod';
import {
  RETRIEVAL_LIMITS,
  RETRIEVAL_MODE_LABELS,
  RETRIEVAL_MODE_MEANING,
  buildScopeFilter,
} from '@/domain/retrieval';
import { json, ownerRoute, parseBody } from '@/server/http/handler';

export const dynamic = 'force-dynamic';

/**
 * The retrieval inspector.
 *
 * Returns evidence *and* the diagnostics behind it: which channels found each result, what the
 * mode was and why, what was excluded and how many. The point is that a search should be
 * explicable rather than magical — if something expected did not come back, this screen says
 * whether it was never indexed, filtered out by scope, or simply ranked below the cut.
 *
 * The scope is built from the signed-in owner here, on the server. A request can *narrow* what it
 * asks for by naming projects; it cannot widen it, because `buildScopeFilter` clamps the audience
 * ceiling and the audience is not a request field.
 */
const searchSchema = z.object({
  query: z.string().trim().min(1).max(RETRIEVAL_LIMITS.maxQueryChars),
  projectIds: z.array(z.string().uuid()).max(50).default([]),
  includeGlobal: z.boolean().default(true),
  includeMemories: z.boolean().default(true),
  includeSources: z.boolean().default(true),
  limit: z
    .number()
    .int()
    .min(1)
    .max(RETRIEVAL_LIMITS.maxLimit)
    .default(RETRIEVAL_LIMITS.defaultLimit),
  asOf: z.string().datetime().nullish(),
});

export const POST = ownerRoute(async ({ services, request }) => {
  const body = await parseBody(request, searchSchema);

  const scopes: ('global' | 'project')[] = [];
  if (body.includeGlobal) scopes.push('global');
  if (body.projectIds.length > 0) scopes.push('project');
  /* An empty scope set is a caller that forgot, so fall back to the owner's global view. */
  if (scopes.length === 0) scopes.push('global');

  const scope = buildScopeFilter({
    /* Fixed. The audience is who is asking, and who is asking is settled by the session. */
    audience: 'owner',
    scopes,
    projectIds: body.projectIds,
  });

  const result = await services.retrieval.retrieve({
    query: body.query,
    scope,
    purpose: 'inspector',
    limit: body.limit,
    charBudget: RETRIEVAL_LIMITS.defaultCharBudget,
    sourceKinds: null,
    includeMemories: body.includeMemories,
    includeSources: body.includeSources,
    asOf: body.asOf ?? null,
  });

  return json({
    evidence: result.evidence,
    diagnostics: {
      ...result.diagnostics,
      modeLabel: RETRIEVAL_MODE_LABELS[result.diagnostics.mode],
      modeMeaning: RETRIEVAL_MODE_MEANING[result.diagnostics.mode],
    },
  });
});
