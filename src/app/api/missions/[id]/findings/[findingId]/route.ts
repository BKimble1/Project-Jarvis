import { z } from 'zod';
import { NotFoundError } from '@/domain/errors';
import { json, ownerRouteWithParams, parseBody } from '@/server/http/handler';

export const dynamic = 'force-dynamic';

const decisionSchema = z.object({
  decision: z.enum(['accept', 'reject', 'defer']),
  note: z.string().trim().max(2000).nullish(),
});

/**
 * The owner's decision on one review finding.
 *
 * Findings that turn on product judgement are routed here rather than decided by Jarvis. An
 * accepted finding becomes repair scope; a rejected one is recorded with the reason, so a later
 * reader can see it was considered rather than missed.
 */
export const POST = ownerRouteWithParams<{ id: string; findingId: string }>(
  async ({ services, request, params }) => {
    const input = await parseBody(request, decisionSchema);
    const findings = await services.reviews.listFindings(params.id);
    const finding = findings.find((candidate) => candidate.id === params.findingId);
    if (!finding) throw new NotFoundError('Finding');

    const state =
      input.decision === 'accept' ? 'accepted' : input.decision === 'reject' ? 'rejected' : 'noted';
    const updated = await services.reviews.setFindingState(finding.id, state, {
      ownerDecision: input.note ?? null,
    });
    await services.missionEvents.record(params.id, {
      type: 'info',
      actor: 'owner',
      summary: `You ${input.decision}ed finding ${finding.key}: ${finding.title}`,
    });
    await services.orchestrator.tick(params.id);
    return json({ finding: updated });
  },
);
