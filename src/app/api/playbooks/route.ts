import { playbookInstallSchema } from '@/domain/playbook';
import { json, ownerRoute, parseBody } from '@/server/http/handler';

export const dynamic = 'force-dynamic';

export const GET = ownerRoute(async ({ services }) => {
  const playbooks = await services.playbookService.list();
  return json({ playbooks });
});

/**
 * Install or update a playbook.
 *
 * Owner-session only, and there is deliberately no worker-authenticated equivalent: §18 says an
 * agent may *recommend* a playbook and may never install, modify or activate one, and the way to
 * make that true is for the route not to exist rather than for the route to check.
 */
export const POST = ownerRoute(async ({ services, session, request }) => {
  const input = await parseBody(request, playbookInstallSchema);
  const result = await services.playbookService.install(
    input.definition,
    session.githubLogin ?? session.id,
    input.note ?? null,
  );
  await services.activity.record({
    kind: 'playbook_installed',
    summary: `Playbook "${result.playbook.name}" is now at version ${result.version.version}.`,
  });
  return json(result, { status: result.created ? 201 : 200 });
});
