import { NotFoundError } from '@/domain/errors';
import {
  blockerInputSchema,
  decisionInputSchema,
  goalInputSchema,
  manualUpdateInputSchema,
  milestoneInputSchema,
  nextActionInputSchema,
} from '@/domain/project';
import { json, ownerRouteWithParams, parseBody } from '@/server/http/handler';

export const dynamic = 'force-dynamic';

/** Creates a sub-entity on a project. Each kind validates against its own schema. */
export const POST = ownerRouteWithParams<{ id: string; kind: string }>(
  async ({ services, request, params }) => {
    const projectId = params.id;
    switch (params.kind) {
      case 'goals': {
        const input = await parseBody(request, goalInputSchema);
        const item = await services.projects.addGoal(projectId, input);
        await services.activity.record({
          projectId,
          kind: 'goal_changed',
          summary: `Goal recorded: ${item.statement}`,
        });
        return json({ item }, { status: 201 });
      }
      case 'milestones': {
        const input = await parseBody(request, milestoneInputSchema);
        const item = await services.projects.addMilestone(projectId, input);
        await services.activity.record({
          projectId,
          kind: 'milestone_changed',
          summary: `Milestone added: ${item.title}`,
        });
        return json({ item }, { status: 201 });
      }
      case 'blockers': {
        const input = await parseBody(request, blockerInputSchema);
        const item = await services.projects.addBlocker(projectId, input);
        await services.activity.record({
          projectId,
          kind: 'blocker_added',
          summary: `Blocker added: ${item.title}`,
          detail: { severity: item.severity, requiresOwnerDecision: item.requiresOwnerDecision },
        });
        return json({ item }, { status: 201 });
      }
      case 'decisions': {
        const input = await parseBody(request, decisionInputSchema);
        const item = await services.projects.addDecision(projectId, input);
        await services.activity.record({
          projectId,
          kind: 'decision_recorded',
          summary: `Decision recorded: ${item.title}`,
        });
        return json({ item }, { status: 201 });
      }
      case 'updates': {
        const input = await parseBody(request, manualUpdateInputSchema);
        const item = await services.projects.addUpdate(projectId, input);
        await services.activity.record({
          projectId,
          kind: 'update_recorded',
          summary: item.whatChanged.slice(0, 200),
        });
        return json({ item }, { status: 201 });
      }
      case 'actions': {
        const input = await parseBody(request, nextActionInputSchema);
        const item = await services.projects.addNextAction(projectId, input);
        await services.activity.record({
          projectId,
          kind: 'next_action_changed',
          summary: `Next action added: ${item.action}`,
        });
        return json({ item }, { status: 201 });
      }
      default:
        throw new NotFoundError('Item type');
    }
  },
);
