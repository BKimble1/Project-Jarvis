import { z } from 'zod';
import type { NextResponse } from 'next/server';
import { boundText, redactSecrets } from '@/domain/redaction';
import { assertCronAuthorised } from '@/server/auth/guard';
import { getServices } from '@/server/container';
import { errorResponse, json, parseBody } from '@/server/http/handler';

export const dynamic = 'force-dynamic';

/**
 * The supervisor, telling the control plane that it restarted something.
 *
 * ## Why the supervisor reports rather than the control plane inferring
 *
 * Because a restart is invisible from here. A worker that crashes and comes back looks, from the
 * database, exactly like a worker that was busy for ninety seconds and then was not: the same row,
 * the same token, a gap in the heartbeats. So "it has crashed four times since midnight" — the
 * thing Blake actually needs to know before trusting an unattended night — cannot be reconstructed
 * after the fact. Only the process that did the restarting knows, and it has to say so at the time.
 *
 * ## Why `CRON_SECRET` and not a worker token
 *
 * The supervisor is not a worker. It holds a worker token only to hand to its children, and
 * authenticating as one of them would file the restart under the process that died. This is the
 * same shared secret the reclaim sweep uses, compared in constant time, and absent means closed.
 *
 * ## What it will never accept
 *
 * Anything free-form that reaches a screen unredacted. `detail` is bounded and passed through
 * `redactSecrets` before it is stored, because the most likely thing in a crash line is the
 * environment that caused it.
 */

const bodySchema = z.object({
  worker: z.string().trim().min(1).max(80),
  /** How many times this child has been restarted inside the supervisor's backoff window. */
  restarts: z.number().int().nonnegative().max(1_000),
  /** Whether the supervisor is starting it again, or has given up. */
  restarting: z.boolean(),
  reason: z.string().trim().min(1).max(300),
});

export async function POST(request: Request): Promise<NextResponse> {
  try {
    assertCronAuthorised(request);
  } catch (error) {
    return errorResponse(error);
  }

  const body = await parseBody(request, bodySchema);
  const services = await getServices();

  await services.audit.append({
    actor: 'worker-supervisor',
    actorKind: 'system',
    action: body.restarting ? 'worker.restarted' : 'worker.abandoned',
    subjectKind: 'worker',
    subjectId: body.worker,
    outcome: body.restarting ? 'allowed' : 'failed',
    summary: body.restarting
      ? `Restarted ${body.worker} after it exited (${body.restarts} restart${body.restarts === 1 ? '' : 's'} in this window).`
      : `Stopped restarting ${body.worker}. ${boundText(redactSecrets(body.reason), 200)}`,
    detail: {
      worker: body.worker,
      restarts: body.restarts,
      reason: boundText(redactSecrets(body.reason), 200),
    },
  });

  return json({ recorded: true });
}
