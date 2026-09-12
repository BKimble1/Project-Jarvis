import { NotFoundError } from '@/domain/errors';
import { json, ownerRouteWithParams } from '@/server/http/handler';

export const dynamic = 'force-dynamic';

/**
 * One artifact.
 *
 * Owner-only like every other private route, and the artifact must belong to the mission in the
 * path — otherwise an id guessed from one mission would read another's report.
 */
export const GET = ownerRouteWithParams<{ id: string; artifactId: string }>(
  async ({ services, params }) => {
    const artifact = await services.artifacts.findById(params.artifactId);
    if (!artifact || artifact.missionId !== params.id) throw new NotFoundError('Artifact');
    return json({ artifact });
  },
);
