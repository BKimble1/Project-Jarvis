import { workerClaimSchema } from '@/domain/worker-protocol';
import { json, workerRoute } from '@/server/http/worker-handler';

export const dynamic = 'force-dynamic';

/**
 * Claim the next runnable mission.
 *
 * Idempotent because the claim itself changes state: a retried claim after a timeout must not
 * consume a second mission. The underlying `claimNext` is a single atomic statement, so two
 * different workers racing here still produce at most one claim.
 */
export const POST = workerRoute(
  workerClaimSchema,
  { name: 'worker.claim', idempotent: true },
  async ({ services, workerId, body }) => {
    const assignment = await services.workerService.claim(workerId, body);
    return json({ assignment });
  },
);
