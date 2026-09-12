import { z } from 'zod';

import { json, workerRoute } from '@/server/http/worker-handler';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * One pass of the operating loop, driven by the worker.
 *
 * ## Why the worker is the caller
 *
 * The control plane runs on Netlify, where nothing holds a loop open: a request arrives, is
 * answered, and the process goes away. The operating loop needs something that keeps existing, and
 * the only thing in this system that does is the worker. So the worker asks the control plane to
 * take a pass, on its own timer.
 *
 * The alternative — a scheduled function — is the backstop, not the driver. A schedule that fires
 * every couple of hours makes Jarvis a thing that notices your project twice a day; the worker
 * makes it a thing that is paying attention. Both callers are safe together because the tick takes
 * a lease, so an overlapping pair does not both run.
 *
 * ## Why this exists rather than the worker calling the cron endpoint
 *
 * `POST /api/operator/tick` is authorised by the shared cron secret, and giving that secret to
 * every worker would spread a control-plane credential across every machine an owner runs one on —
 * for no gain, since the worker already holds an identity the control plane issued and can revoke.
 * Worse, the worker's client treats a 403 as fatal and exits, so a worker with a stale cron secret
 * would not merely fail to drive the loop: it would shut itself down and stop taking missions.
 *
 * ## What this does not grant
 *
 * Nothing a worker could not already cause. The tick is idempotent, lease-guarded, and everything
 * it may do is bounded by the operating mode and the charter — a worker driving it cannot start
 * work the charter does not authorise, and a worker that wanted to misbehave could simply claim a
 * mission instead. What it grants is timing, not authority.
 */
const schema = z.object({});

export const POST = workerRoute(schema, { name: 'worker.operatorTick' }, async ({ services }) => {
  const result = await services.operatorService.tick();
  /*
   * Deliberately thin. The worker does not act on any of this — it drives the loop and the
   * control plane does the deciding — so sending it the backlog, the coverage and every
   * opportunity would be shipping the owner's project data to a machine that has no use for it.
   */
  return json({
    outcome: result.outcome,
    summary: result.summary,
    tickId: result.tickId,
    missionsStarted: result.started.length,
    capacity: result.capacity
      ? { verdict: result.capacity.verdict, reason: result.capacity.reason }
      : null,
  });
});
