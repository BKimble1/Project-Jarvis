import { displayDeviceCreateSchema } from '@/domain/display-device';
import { json, ownerRoute, parseBody } from '@/server/http/handler';

export const dynamic = 'force-dynamic';

export const GET = ownerRoute(async ({ services }) => {
  const devices = await services.displays.list();
  return json({ devices });
});

/**
 * Pair a wallboard.
 *
 * The token comes back exactly once, in this response, and is stored only as a hash. There is no
 * route that returns it again and no field on `DisplayDevice` that could carry it.
 */
export const POST = ownerRoute(async ({ services, request }) => {
  const input = await parseBody(request, displayDeviceCreateSchema);
  const issued = await services.displays.pair(input);
  await services.activity.record({
    kind: 'display_paired',
    summary: `Display "${issued.device.name}" was paired.`,
  });
  return json({ device: issued.device, token: issued.token }, { status: 201 });
});
