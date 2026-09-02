import { z } from 'zod';
import { json, ownerRoute, parseBody } from '@/server/http/handler';

export const dynamic = 'force-dynamic';

const retentionSchema = z.object({
  snapshotDays: z.number().int().min(30).max(3650),
  activityDays: z.number().int().min(30).max(3650),
});

/** Applies the owner's retention window. Evidence is never deleted by this operation. */
export const POST = ownerRoute(async ({ services, request }) => {
  const input = await parseBody(request, retentionSchema);
  const now = Date.now();
  const snapshotsRemoved = await services.snapshots.deleteOlderThan(
    new Date(now - input.snapshotDays * 86_400_000),
  );
  const activityRemoved = await services.activity.deleteOlderThan(
    new Date(now - input.activityDays * 86_400_000),
  );
  await services.settings.set('retention', input);
  await services.activity.record({
    kind: 'data_retention_applied',
    summary: `Removed ${snapshotsRemoved} snapshot(s) and ${activityRemoved} activity record(s).`,
  });
  return json({ snapshotsRemoved, activityRemoved });
});
