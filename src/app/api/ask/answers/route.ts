import { ANSWER_STATE_LABELS, isPresentableAnswer } from '@/domain/answer-run';
import { NotFoundError, ValidationError } from '@/domain/errors';
import { json, ownerRoute } from '@/server/http/handler';

export const dynamic = 'force-dynamic';

/**
 * Where an answer has got to, looked up by the key the caller minted.
 *
 * This is how progressive status works without inventing infrastructure. The client generates the
 * idempotency key *before* sending, and `begin()` inserts the row carrying it as its very first
 * act — so the key is a handle on the request from the moment it exists, and the client can poll
 * for state while its own POST is still in flight. It also yields the answer id, which is what a
 * cancel needs.
 *
 * Deliberately not server-sent events: with no provider configured there are no tokens to stream,
 * and streaming state changes through a reconnecting transport would be a much larger mechanism
 * carrying the same information. The persisted state machine is already the right shape for SSE
 * if a later phase wants it.
 */
export const GET = ownerRoute(async ({ services, request, session }) => {
  const key = new URL(request.url).searchParams.get('key');
  if (!key) throw new ValidationError('An answer is looked up by its request key.');

  const ownerId = session.githubLogin ?? session.id;
  /* Scoped to this owner, so a key guessed from elsewhere finds nothing. */
  const run = await services.answerRuns.findByKey(ownerId, key);
  if (!run) throw new NotFoundError('Answer');

  return json({
    id: run.id,
    state: run.state,
    stateLabel: ANSWER_STATE_LABELS[run.state],
    presentable: isPresentableAnswer(run.state),
    mode: run.mode,
  });
});
