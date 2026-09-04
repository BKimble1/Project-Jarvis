import { ANSWER_STATE_LABELS } from '@/domain/answer-run';
import { json, ownerRouteWithParams } from '@/server/http/handler';

export const dynamic = 'force-dynamic';

/**
 * Stop an answer.
 *
 * Terminal, and guarded twice. The row moves to `cancelled` through the state machine, which
 * refuses every later transition — so a provider result that arrives afterwards is discarded
 * rather than racing. Separately the in-flight request is aborted, so cancelling also stops
 * spending where the provider supports it. Only the first guard has to be correct for the
 * guarantee to hold; the second is what makes it cheap.
 */
export const POST = ownerRouteWithParams<{ id: string }>(async ({ services, params, session }) => {
  const ownerId = session.githubLogin ?? session.id;
  const run = await services.answerService.cancel(params.id, ownerId);
  return json({
    id: run.id,
    state: run.state,
    stateLabel: ANSWER_STATE_LABELS[run.state],
    cancelledAt: run.cancelledAt,
  });
});
