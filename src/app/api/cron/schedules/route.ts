import type { NextResponse } from 'next/server';
import { assertCronAuthorised } from '@/server/auth/guard';
import { getServices } from '@/server/container';
import { errorResponse, json } from '@/server/http/handler';
import { logger } from '@/server/logging/logger';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

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
 * ## Why calling it too often is harmless
 *
 * Every occurrence is claimed by a key derived from its *local wall-clock time*. A tick every
 * minute, two ticks at once, a restart in the middle of one, and the 01:30 that happens twice when
 * the clocks go back all converge on a single row and a single delivery. Calling this once a
 * minute is the intended usage.
 *
 * Protected by `CRON_SECRET`, compared in constant time, and closed when that secret is absent.
 */
export async function POST(request: Request): Promise<NextResponse> {
  try {
    assertCronAuthorised(request);
  } catch (error) {
    return errorResponse(error);
  }

  const services = await getServices();
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

  return json(report);
}
