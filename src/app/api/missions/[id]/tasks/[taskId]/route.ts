import { z } from 'zod';
import { ConflictError, NotFoundError } from '@/domain/errors';
import { assertTaskTransition } from '@/domain/mission-task';
import { json, ownerRouteWithParams, parseBody } from '@/server/http/handler';

export const dynamic = 'force-dynamic';

export const GET = ownerRouteWithParams<{ id: string; taskId: string }>(
  async ({ services, params }) => {
    const task = await services.tasks.findById(params.taskId);
    if (!task || task.missionId !== params.id) throw new NotFoundError('Task');
    const review = task.latestReviewId
      ? await services.reviews.findById(task.latestReviewId)
      : null;
    const findings = review ? await services.reviews.listFindingsForReview(review.id) : [];
    return json({ task, review, findings });
  },
);

/**
 * Owner actions on one task.
 *
 * Deliberately short: skip and cancel. There is no "mark succeeded", no "approve", and no way to
 * move a task forward — those belong to the worker and the state machine, and an owner override
 * that could declare work finished would undo the point of the review gate.
 */
const taskActionSchema = z.object({
  action: z.enum(['skip', 'cancel', 'retry']),
  reason: z.string().trim().max(600).nullish(),
});

export const POST = ownerRouteWithParams<{ id: string; taskId: string }>(
  async ({ services, request, params }) => {
    const input = await parseBody(request, taskActionSchema);
    const task = await services.tasks.findById(params.taskId);
    if (!task || task.missionId !== params.id) throw new NotFoundError('Task');

    const next =
      input.action === 'skip' ? 'skipped' : input.action === 'cancel' ? 'cancelled' : 'ready';
    assertTaskTransition(task.state, next, 'owner');
    const moved = await services.tasks.transition(
      task.id,
      next,
      input.action === 'retry' ? { failureCode: null, failureMessage: null } : {},
      task.state,
    );
    if (!moved) throw new ConflictError('That task changed while you were looking at it.');

    await services.missionEvents.record(params.id, {
      type: 'info',
      actor: 'owner',
      summary: `You ${input.action === 'retry' ? 'retried' : `${input.action}ped`} ${task.key}.`,
      detail: { taskKey: task.key, reason: input.reason ?? null },
    });
    await services.orchestrator.tick(params.id);
    return json({ task: moved });
  },
);
