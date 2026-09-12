import { displayDeviceRevokeSchema } from '@/domain/display-device';
import { json, ownerRouteWithParams, parseBody } from '@/server/http/handler';

export const dynamic = 'force-dynamic';

/** Revoke a display. Checked per request, so it takes effect on the wallboard's next refresh. */
export const DELETE = ownerRouteWithParams<{ id: string }>(
  async ({ services, request, params }) => {
    const input = await parseBody(request, displayDeviceRevokeSchema).catch(() => ({
      reason: null,
    }));
    const device = await services.displays.revoke(params.id, input.reason ?? null);
    await services.activity.record({
      kind: 'display_revoked',
      summary: `Display "${device.name}" was revoked.`,
    });
    return json({ device });
  },
);
