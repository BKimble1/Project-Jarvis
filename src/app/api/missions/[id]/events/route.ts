import { json, ownerRouteWithParams } from '@/server/http/handler';

export const dynamic = 'force-dynamic';

/**
 * Incremental event feed for the live mission view.
 *
 * Bounded polling rather than a socket: a serverless control plane cannot hold a connection open,
 * and polling is correct after a refresh, on a phone that slept, and when the browser was closed
 * for an hour. `after` is the last sequence the client already has.
 */
export const GET = ownerRouteWithParams<{ id: string }>(async ({ services, request, params }) => {
  const url = new URL(request.url);
  const runId = url.searchParams.get('run');
  const after = Number(url.searchParams.get('after') ?? -1);
  const detail = await services.missions.detail(params.id);

  const events = runId
    ? await services.missionEvents.listForRun(runId, Number.isFinite(after) ? after : -1, 200)
    : detail.events;

  return json({
    events,
    mission: detail.mission,
    activeRun: detail.activeRun,
    worker: detail.worker,
    stalled: detail.stalled,
    permissionRequests: detail.permissionRequests.filter((request) => request.state === 'pending'),
    verifications: detail.verifications,
  });
});
