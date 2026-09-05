import { z } from 'zod';
import { NotFoundError, ValidationError } from '@/domain/errors';
import {
  blockerInputSchema,
  decisionInputSchema,
  goalInputSchema,
  milestoneInputSchema,
  nextActionInputSchema,
} from '@/domain/project';
import { json, ownerRouteWithParams, parseBody } from '@/server/http/handler';

export const dynamic = 'force-dynamic';

/**
 * Updates and deletes for a project's sub-entities.
 *
 * One route with an explicit allow-list keeps the surface small; `kind` is validated against a
 * closed set, so a client cannot address anything that is not listed here.
 */
const KINDS = ['goals', 'milestones', 'blockers', 'decisions', 'updates', 'actions'] as const;
type Kind = (typeof KINDS)[number];

const patchSchemas: Record<Kind, z.ZodType> = {
  goals: goalInputSchema.partial(),
  milestones: milestoneInputSchema.partial(),
  blockers: blockerInputSchema.partial().extend({ isActive: z.boolean().optional() }),
  decisions: decisionInputSchema.partial(),
  updates: z.object({}),
  actions: nextActionInputSchema.partial(),
};

function assertKind(value: string): Kind {
  if ((KINDS as readonly string[]).includes(value)) return value as Kind;
  throw new NotFoundError('Item type');
}

export const PATCH = ownerRouteWithParams<{ kind: string; itemId: string }>(
  async ({ services, request, params }) => {
    const kind = assertKind(params.kind);
    const schema = patchSchemas[kind];
    const input = (await parseBody(request, schema)) as Record<string, unknown>;

    switch (kind) {
      case 'goals':
        return json({ item: await services.projects.updateGoal(params.itemId, input) });
      case 'milestones':
        return json({ item: await services.projects.updateMilestone(params.itemId, input) });
      case 'blockers': {
        if (typeof input.isActive === 'boolean') {
          const item = input.isActive
            ? await services.projects.reopenBlocker(params.itemId)
            : await services.projects.resolveBlocker(params.itemId, new Date());
          await services.activity.record({
            projectId: item.projectId,
            kind: input.isActive ? 'blocker_added' : 'blocker_resolved',
            summary: input.isActive
              ? `Reopened blocker: ${item.title}`
              : `Resolved blocker: ${item.title}`,
          });
          return json({ item });
        }
        return json({ item: await services.projects.updateBlocker(params.itemId, input) });
      }
      case 'decisions':
        return json({ item: await services.projects.updateDecision(params.itemId, input) });
      case 'actions':
        return json({ item: await services.projects.updateNextAction(params.itemId, input) });
      default:
        throw new ValidationError('This item type cannot be edited.');
    }
  },
);

export const DELETE = ownerRouteWithParams<{ kind: string; itemId: string }>(
  async ({ services, params }) => {
    const kind = assertKind(params.kind);
    switch (kind) {
      case 'goals':
        await services.projects.removeGoal(params.itemId);
        break;
      case 'milestones':
        await services.projects.removeMilestone(params.itemId);
        break;
      case 'blockers':
        await services.projects.removeBlocker(params.itemId);
        break;
      case 'decisions':
        await services.projects.removeDecision(params.itemId);
        break;
      case 'updates':
        await services.projects.removeUpdate(params.itemId);
        break;
      case 'actions':
        await services.projects.removeNextAction(params.itemId);
        break;
    }
    return json({ deleted: true });
  },
);
