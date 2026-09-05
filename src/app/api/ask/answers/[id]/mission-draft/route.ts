import { z } from 'zod';
import { ForbiddenError, NotFoundError, ValidationError } from '@/domain/errors';
import { json, ownerRouteWithParams, parseBody } from '@/server/http/handler';

export const dynamic = 'force-dynamic';

const draftSchema = z.object({
  /* Editable before it is created — a proposal is a starting point, not a decision. */
  rawRequest: z.string().trim().min(10).max(2000),
  projectId: z.string().uuid().nullish(),
  title: z.string().trim().min(3).max(160).optional(),
});

/**
 * Turn a proposal into a mission draft.
 *
 * ## The boundary, and where it actually lives
 *
 * `AnswerService` has no mission service, no orchestrator, no delivery client and no CI
 * dispatcher — not as policy but as a fact about its constructor. So an answer physically cannot
 * create a mission; the most it can produce is a `MissionSuggestion`, which is a description.
 *
 * This route is the separate, owner-initiated act that turns one into a draft, and it does so
 * through the same `missions.create` every other caller uses — which means it lands wherever
 * intake decides: `draft`, or `needs_clarification` when the request is vague enough to be worth
 * a question first. Neither is work: no worker is enrolled, no repository is cloned, no branch is
 * created, no task is queued, no CI is dispatched and no pull request exists. Starting requires
 * plan approval through the existing route, by a person, afterwards.
 *
 * The suggestion is re-read from the stored answer rather than trusted from the request body, so
 * a caller cannot post an arbitrary mission through this path and have it look like something
 * Jarvis proposed. The owner may edit the text — that is the point of a review step — but the
 * proposal has to exist first.
 */
export const POST = ownerRouteWithParams<{ id: string }>(
  async ({ services, params, request, session }) => {
    const body = await parseBody(request, draftSchema);
    const ownerId = session.githubLogin ?? session.id;

    const run = await services.answerRuns.findForOwner(params.id, ownerId);
    if (!run) throw new NotFoundError('Answer');

    const stored = await services.answers.findById(params.id);
    if (!stored?.missionSuggestion) {
      throw new ValidationError('That answer did not propose anything to do.');
    }

    /*
     * The project must be one the answer was actually allowed to look at. Without this an action
     * proposal would be a way to reach a project the question's scope excluded.
     */
    const projectId = body.projectId ?? stored.missionSuggestion.projectId ?? null;
    if (projectId && !run.projectIds.includes(projectId)) {
      throw new ForbiddenError('That project was not in the scope of the question.');
    }

    const result = await services.missions.create(
      {
        rawRequest: body.rawRequest,
        projectId,
        ...(body.title ? { title: body.title } : {}),
        description: stored.missionSuggestion.rationale,
        priority: 'medium',
        constraints: [],
        doNotTouch: [],
        acceptanceCriteria: [],
      },
      session.githubLogin ?? null,
      {},
    );

    await services.audit.append({
      actor: ownerId,
      actorKind: 'owner',
      action: 'answer.ask',
      subjectKind: 'mission',
      subjectId: result.mission.id,
      projectId,
      outcome: 'allowed',
      rule: 'R-AP1',
      summary: 'You turned a suggestion from an answer into a mission draft.',
      detail: { answerId: params.id, state: result.mission.state },
    });

    return json(
      {
        mission: result.mission,
        questions: result.questions,
        /* Stated in the response so a client cannot present a draft as started work. */
        started: false,
        needsApproval: true,
      },
      { status: 201 },
    );
  },
);
