import type { NextResponse } from 'next/server';
import { assertCronAuthorised } from '@/server/auth/guard';
import { getServices } from '@/server/container';
import { errorResponse, json, ownerRoute } from '@/server/http/handler';
import { logger } from '@/server/logging/logger';
import type { ScheduleTickReport } from '@/server/schedules/schedule-service';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

type Services = Awaited<ReturnType<typeof getServices>>;

/**
 * The tick that makes schedules happen.
 *
 * ## Why a route and not a timer inside the process
 *
 * Because there is no process guaranteed to be running. The control plane serves a browser and may
 * be cold between requests; the worker is a separate machine that may be off. A timer in either
 * would mean "your morning briefing arrives if something happened to be awake at seven", which is
 * not a schedule. So the tick is a route, and whatever wakes it — the worker supervisor's own
 * timer, a Windows scheduled task, a platform cron — only has to be able to make an HTTP request.
 *
 * ## Why this route is not, on its own, enough
 *
 * It was written and nothing called it. No timer, no worker loop, no scheduled function anywhere
 * in the repository named it, so on the documented single-machine deployment every reminder was
 * accepted, stored, and never delivered — while the interface told the owner it had been set. A
 * route with no caller is not a backstop, it is a comment.
 *
 * The caller that fixes that is the operating loop, because the enrolled worker already drives it
 * on a timer and is the only thing on a single-machine install that reliably runs at all. This
 * route stays for the deployments where something else can do the waking, and gains the owner
 * below so the tick is reachable from a signed-in session too — the same pair, and for the same
 * reason, as `/api/operator/tick`.
 *
 * ## Why calling it too often is harmless
 *
 * Every occurrence is claimed by a key derived from its *local wall-clock time*. A tick every
 * minute, two ticks at once, a restart in the middle of one, and the 01:30 that happens twice when
 * the clocks go back all converge on a single row and a single delivery. Calling this once a
 * minute is the intended usage.
 *
 * Protected by `CRON_SECRET`, compared in constant time, and closed when that secret is absent.
 */
async function tick(services: Services): Promise<ScheduleTickReport> {
  const report = await services.scheduleService.tick();

  /*
   * Logged only when something happened. A tick that finds nothing due is the common case and by
   * far the most frequent one; a log line for each would bury the mornings that mattered.
   */
  if (report.delivered > 0 || report.failed > 0 || report.missed > 0) {
    logger().info('schedules ticked', {
      delivered: report.delivered,
      failed: report.failed,
      missed: report.missed,
      skipped: report.skipped,
    });
  }

  return report;
}

export async function POST(request: Request): Promise<NextResponse> {
  try {
    assertCronAuthorised(request);
    /*
     * The tick is inside the `try` deliberately. It used to sit outside it, so anything the pass
     * could not swallow — a database that went away between two schedules — left this handler as a
     * thrown exception rather than an error response, and the caller most likely to meet that is a
     * timer with nobody watching it.
     */
    const services = await getServices();
    return json(await tick(services));
  } catch (error) {
    return errorResponse(error);
  }
}

/** The same pass, run by the owner from the interface. */
export const PUT = ownerRoute(async ({ services }) => json(await tick(services)));
