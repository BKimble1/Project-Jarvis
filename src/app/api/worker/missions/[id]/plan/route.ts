import { workerPlanSubmissionSchema } from '@/domain/worker-protocol';
import { json, workerRouteWithParams } from '@/server/http/worker-handler';

export const dynamic = 'force-dynamic';

/**
 * A plan produced by a read-only inspection run.
 *
 * The control plane re-classifies the risk from the plan's own text rather than trusting the
 * worker's opinion of it, so a plan describing a prohibited operation is rejected here.
 */
export const POST = workerRouteWithParams<typeof workerPlanSubmissionSchema, { id: string }>(
  workerPlanSubmissionSchema,
  { name: 'worker.plan', idempotent: true },
  async ({ services, workerId, body, params }) => {
    const mission = await services.workerService.submitPlan(workerId, params.id, body);
    return json({ ok: true, missionState: mission.state, planVersion: mission.currentPlanVersion });
  },
);
