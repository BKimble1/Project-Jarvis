import type { NextResponse } from 'next/server';
import { assertCronAuthorised } from '@/server/auth/guard';
import { getServices } from '@/server/container';
import { errorResponse, json } from '@/server/http/handler';
import { logger } from '@/server/logging/logger';

export const dynamic = 'force-dynamic';

/**
 * Take back what a departed worker was holding.
 *
 * ## Why this is a route rather than a loop inside the supervisor
 *
 * Because the supervisor runs beside the worker, not beside the database. It is a process manager:
 * it knows which children are alive and restarts the ones that are not, and giving it a database
 * connection would make it a second control plane with its own copy of the rules about which
 * missions are safe to hand on. Those rules are subtle enough to be worth having once.
 *
 * So the supervisor asks, on a timer, and the control plane decides. `CRON_SECRET` is the same
 * shared secret the scheduled sync uses, compared in constant time, and absent means closed.
 *
 * ## What it does not do
 *
 * Fail anything. `reclaimExpiredMissions` requeues only work that had not begun, and releases the
 * claim on anything further along without touching its state — see the reasoning there. A sweep
 * that ran every minute for an hour would change nothing after the first pass.
 */
export async function POST(request: Request): Promise<NextResponse> {
  try {
    assertCronAuthorised(request);
  } catch (error) {
    return errorResponse(error);
  }

  const services = await getServices();
  const reclaimed = await services.missions.reclaimExpiredMissions();
  const lost = await services.missions.reconcileLostWorkers();

  if (reclaimed.requeued > 0 || reclaimed.released > 0) {
    logger().warn('reclaimed missions from workers that stopped reporting', {
      requeued: reclaimed.requeued,
      released: reclaimed.released,
    });
  }

  return json({ reclaimed, lost });
}
