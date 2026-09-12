import { z } from 'zod';
import { OPERATING_MODES, OPERATING_MODE_LABELS } from '@/domain/operating-mode';
import { json, ownerRoute, parseBody } from '@/server/http/handler';

export const dynamic = 'force-dynamic';

const modeSchema = z.object({
  mode: z.enum(OPERATING_MODES),
  reason: z.string().trim().max(400).nullish(),
  /** For a temporary pause. "Until this evening" is a thing people say. */
  until: z.string().datetime().nullish(),
  /**
   * Typed acknowledgement, required only for the one move that hands Jarvis standing authority.
   *
   * A confirmation phrase is not authentication — the session already provided that — and it is
   * not pretending to be. It is there so the move that stops a person approving each mission
   * cannot be made by a mis-click on a page somebody was skimming.
   */
  confirmation: z.literal('let Jarvis operate on its own').optional(),
});

/**
 * Change how much autonomy Jarvis has.
 *
 * The transition table decides what is possible and who may do it; this handler adds one thing on
 * top, which is the typed confirmation for `operator`. Everything that *reduces* autonomy is
 * accepted without ceremony, because a person reaching for the brake should never be asked to
 * type a sentence first.
 */
export const POST = ownerRoute(async ({ services, session, request }) => {
  const input = await parseBody(request, modeSchema);

  /*
   * Lifting a pause is not granting authority.
   *
   * The confirmation gate below exists for the move that stops a person approving each mission.
   * Returning to the mode a pause was entered from is not that move — the charter has not changed
   * and neither has the owner's decision — and asking for a typed sentence every time somebody
   * unpauses is how a master pause becomes a control nobody uses.
   */
  const current = await services.charterService.state();
  const liftingOwnPause =
    current.mode === 'paused' && current.pausedFrom === input.mode && input.mode === 'operator';

  if (input.mode === 'operator' && input.confirmation === undefined && !liftingOwnPause) {
    return json(
      {
        error: {
          code: 'confirmation_required',
          message:
            'Operator mode lets Jarvis start and run missions without asking you each time. Type the confirmation phrase to continue.',
          phrase: 'let Jarvis operate on its own',
        },
      },
      { status: 422 },
    );
  }

  const state = await services.charterService.setMode({
    to: input.mode,
    actor: 'owner',
    changedBy: session.githubLogin ?? 'owner',
    reason: input.reason ?? null,
    until: input.until ? new Date(input.until) : null,
  });

  const authority = await services.charterService.authority();
  return json({
    mode: state.mode,
    label: OPERATING_MODE_LABELS[state.mode],
    changedAt: state.changedAt,
    until: state.until,
    standingAuthority: authority.standingAuthority,
    blockedReason: authority.blockedReason,
  });
});
