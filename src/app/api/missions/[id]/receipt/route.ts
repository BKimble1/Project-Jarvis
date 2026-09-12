import { json, ownerRouteWithParams } from '@/server/http/handler';

export const dynamic = 'force-dynamic';

/**
 * The completion receipt.
 *
 * Rebuilt on read rather than served from the stored copy, so it always reflects what is true
 * now: a mission whose checks were re-run, or whose findings were decided since, has a receipt
 * that says so.
 */
export const GET = ownerRouteWithParams<{ id: string }>(async ({ services, params }) => {
  const content = await services.orchestrator.buildReceipt(params.id);
  return json({ receipt: content });
});
