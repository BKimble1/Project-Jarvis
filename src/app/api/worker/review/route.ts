import { reviewSubmissionSchema } from '@/domain/mission-review';
import { json, workerRoute } from '@/server/http/worker-handler';

export const dynamic = 'force-dynamic';

/**
 * Submit a review verdict.
 *
 * The response says only that the verdict was recorded. It deliberately does **not** say what
 * Jarvis decided to do about it — whether a repair was scheduled, whether the verdict was
 * overridden by policy, whether delivery is going ahead. A reviewing worker has no business
 * knowing, and a fresh reviewer in the next round must not be able to find out.
 */
export const POST = workerRoute(
  reviewSubmissionSchema,
  { name: 'worker.review', idempotent: true },
  async ({ services, workerId, body }) => {
    await services.taskWorkerService.submitReview(workerId, body);
    return json({ ok: true });
  },
);
