import { playbookToggleSchema } from '@/domain/playbook';
import { json, ownerRouteWithParams, parseBody } from '@/server/http/handler';

export const dynamic = 'force-dynamic';

export const GET = ownerRouteWithParams<{ key: string }>(async ({ services, params }) => {
  const version = await services.playbookService.preview(params.key);
  const versions = await services.playbookService.listVersions(params.key);
  return json({ version, versions });
});

/** Enable or disable a playbook. A running mission follows its pinned version regardless. */
export const PATCH = ownerRouteWithParams<{ key: string }>(
  async ({ services, request, params }) => {
    const input = await parseBody(request, playbookToggleSchema);
    const playbook = await services.playbookService.setEnabled(params.key, input.enabled);
    await services.activity.record({
      kind: input.enabled ? 'playbook_installed' : 'playbook_disabled',
      summary: `Playbook "${playbook.name}" was ${input.enabled ? 'enabled' : 'switched off'}.`,
    });
    return json({ playbook });
  },
);
