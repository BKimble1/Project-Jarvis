import { transcriptConfirmSchema } from '@/domain/voice';
import { json, ownerRouteWithParams, parseBody } from '@/server/http/handler';

export const dynamic = 'force-dynamic';

/**
 * Act on what was said, having shown exactly what acting means.
 *
 * The interpretation is re-derived from the final text server-side and compared with the one the
 * person was shown. An edit that turns a question into a request for work is a different decision
 * and needs a different confirmation — otherwise the confirmation is a field the client fills in,
 * which is not a gate.
 *
 * Nothing spoken is ever an approval. That refusal is in the domain, checked twice, and there is
 * no flag anywhere that turns it off.
 */
export const POST = ownerRouteWithParams<{ id: string }>(
  async ({ services, session, request, params }) => {
    const body = await parseBody(request, transcriptConfirmSchema);
    const { capture, outcome } = await services.voiceService.confirm(
      params.id,
      { text: body.text, shownIntent: body.shownIntent },
      { actor: session.githubLogin ?? 'owner', actorKind: 'owner' },
    );
    return json({ id: capture.id, state: capture.state, outcome });
  },
);
