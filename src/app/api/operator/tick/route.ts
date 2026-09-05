import { assertCronAuthorised } from '@/server/auth/guard';
import { getServices } from '@/server/container';
import { errorResponse, json, ownerRoute } from '@/server/http/handler';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * One pass of the operating loop.
 *
 * Bounded and idempotent, so it does not matter who calls it or how often: a lease means two
 * overlapping calls do not both run, and a tick that finds nothing to do records that it found
 * nothing and returns. Which is the point — this endpoint is designed to be driven from more than
 * one place at once.
 *
 * Two callers, deliberately:
 *
 *  - **The worker**, every few seconds, which is what makes Jarvis feel continuous. A control
 *    plane on Netlify cannot hold a loop open; the long-lived worker can, and this is how it
 *    drives one without the control plane ever running an agent.
 *  - **A schedule**, as a backstop, so a stopped worker degrades to a slow Jarvis rather than to a
 *    silent one.
 *
 * The response describes what Jarvis would do, and — for now — deliberately stops short of doing
 * it. Observe, understand, prioritise. The stages after this start real work and each needs its
 * own gate.
 */
function shape(result: Awaited<ReturnType<Services['operatorService']['tick']>>) {
  return {
    outcome: result.outcome,
    summary: result.summary,
    tickId: result.tickId,
    capacity: result.capacity
      ? {
          verdict: result.capacity.verdict,
          mayStartNewWork: result.capacity.mayStartNewWork,
          reason: result.capacity.reason,
          /* Whether the figure behind this was measured, estimated, stale or unknown. */
          quality: result.capacity.quality,
        }
      : null,
    coverage: result.coverage,
    backlog: result.backlog.map((entry) => ({
      key: entry.opportunity.key,
      projectId: entry.opportunity.projectId,
      title: entry.opportunity.title,
      detail: entry.opportunity.detail,
      rule: entry.opportunity.rule,
      severity: entry.opportunity.severity,
      provenance: entry.opportunity.provenance,
      requiresOwner: entry.opportunity.requiresOwner,
      capabilities: entry.opportunity.capabilities,
      band: entry.priority.band,
      /* An ordering device with no units. Never render it as a percentage or an amount. */
      score: entry.priority.score,
      factors: entry.priority.factors,
    })),
    selected: result.selected.map((entry) => entry.opportunity.key),
    /* What it actually started, and — for each one that did not start — the reason. */
    started: result.started,
  };
}

type Services = Awaited<ReturnType<typeof getServices>>;

/** Driven by the worker or a schedule. Authorised by the shared cron secret, never by identity. */
export async function POST(request: Request) {
  try {
    assertCronAuthorised(request);
    const services = await getServices();
    return json(shape(await services.operatorService.tick()));
  } catch (error) {
    return errorResponse(error);
  }
}

/** The same pass, run by the owner from the interface. */
export const PUT = ownerRoute(async ({ services }) => json(shape(await services.operatorService.tick())));
