import {
  EMPTY_CONTEXT,
  interpretMessage,
  type ConversationContext,
  type Interpretation,
} from '@/domain/interpretation';
import { deriveProjectName, describesNewProject } from '@/domain/new-project';
import type { Project } from '@/domain/project';
import type { QueryAnswer } from '@/domain/query';
import { resolveProjectName } from '@/server/query/parser';
import type { StatusQueryRouter } from '@/server/query/router';
import type { MissionService } from '@/server/missions/mission-service';
import type { ProjectRepository } from '@/server/repositories/types';
import type { ProjectProvisioningService } from '@/server/services/project-provisioning';

/**
 * The one place a sentence from the owner turns into whatever it turns into.
 *
 * ## Why this exists
 *
 * Because the path from "I have an idea" to a repository with work in it ran through three
 * screens, and the owner said it should run through a conversation. Every step of it already
 * existed — the interpreter, the mission service, the charter, the operating loop — and none of
 * them was reachable by saying a sentence. This is the joining, and deliberately nothing more: it
 * owns no state machine, no queue, no scheduler and no second opinion about what work is. It calls
 * the services that already do those things, in the order a person would expect.
 *
 * ## What it does not do
 *
 * It does not decide whether Jarvis is *allowed* to do something. That belongs to the charter, and
 * routing round it would make the charter advisory. What this decides is only whether a sentence
 * warrants asking. When standing authority is not in force the same sentence still creates the
 * mission — it simply waits for the owner at the plan, which is the design the charter already
 * has and not a special case invented here.
 *
 * It also does not create a repository from a bare work request. "Fix the login bug" with no
 * project matched would become a project called "login bug" and a repository to go with it, which
 * is worse than saying "which project?". Provisioning happens on a sentence that describes
 * something new — see `describesNewProject` for exactly which — or on a yes to a proposal that
 * already said what would be made.
 *
 * ## The proposal, and why accepting one is safe
 *
 * A proposal comes back from the browser, in the snapshot the owner was looking at. That is worth
 * being clear about: it is owner-supplied, not owner-*authored*, and it is not trusted as an
 * authorisation. Accepting one re-interprets its text through the same gates every other sentence
 * goes through — the risk classifier, the mission service, the charter. A tampered proposal can
 * therefore ask for nothing the owner could not have asked for by typing it, which is the property
 * that matters. What the proposal supplies is the *subject*, not the permission.
 */

export interface StartedWorkSummary {
  readonly missionId: string;
  readonly title: string;
  readonly projectId: string | null;
  readonly projectName: string | null;
  readonly repositoryUrl: string | null;
  /** True when the mission is planning now; false when it is waiting on a question. */
  readonly planning: boolean;
}

export interface ConversationTurn {
  readonly kind: Interpretation['kind'];
  /** One line, in Jarvis's own words, of what it took the message to mean. */
  readonly understanding: string;
  /** What Jarvis says — spoken aloud when the message was spoken. */
  readonly said: string;
  readonly href: string | null;
  /** The structured answer, for the panel. Null when the turn was not a question. */
  readonly answer: QueryAnswer | null;
  /** Set only when this turn actually started something. */
  readonly started: StartedWorkSummary | null;
  /** Set when Jarvis is waiting for a yes. Echoed back by the browser on the next turn. */
  readonly proposal: { readonly id: string; readonly summary: string } | null;
  /** Everything that was created, in plain sentences. Empty when nothing was. */
  readonly notes: readonly string[];
}

export interface ConversationDeps {
  readonly router: StatusQueryRouter;
  readonly missions: MissionService;
  readonly projects: ProjectRepository;
  readonly provisioning: ProjectProvisioningService;
  /** Whether standing authority is in force, and the sentence saying why it is not. */
  readonly authority: () => Promise<{
    readonly standingAuthority: boolean;
    readonly blockedReason: string | null;
  }>;
}

export interface ConversationInput {
  readonly message: string;
  readonly context?: ConversationContext;
  readonly ownerLogin?: string | null;
}

export class ConversationService {
  constructor(private readonly deps: ConversationDeps) {}

  async handle(input: ConversationInput): Promise<ConversationTurn> {
    const context = input.context ?? EMPTY_CONTEXT;
    const interpretation = interpretMessage(input.message, context);

    switch (interpretation.kind) {
      case 'work':
        return this.startWork(interpretation, input.message, input.ownerLogin ?? null);
      case 'idea':
        return this.proposeIdea(interpretation, input.message, context);
      case 'follow_up':
        return this.followUp(interpretation, context, input.ownerLogin ?? null);
      default:
        return this.answer(interpretation, input.message, context);
    }
  }

  /* ------------------------------------------------------------------ work */

  /**
   * A request to do something, turned into a mission.
   *
   * The mission is created and asked to plan, which is where standing authority takes over: the
   * operating loop finds it waiting at `awaiting_plan_approval` and puts it to the charter. This
   * method deliberately does not approve anything itself. Two paths to an approval would be two
   * places to get it wrong, and the charter's is the one with the audit trail.
   */
  private async startWork(
    interpretation: Interpretation,
    raw: string,
    ownerLogin: string | null,
  ): Promise<ConversationTurn> {
    const notes: string[] = [];
    let project = await this.resolveProject(interpretation.subject);
    let repositoryUrl: string | null = null;

    /*
     * Nothing matched, and the sentence describes something that does not exist yet. This is the
     * only path on which a repository is created from a single message, and the guard is narrow on
     * purpose — see `describesNewProject`.
     */
    if (!project && describesNewProject(raw)) {
      const provisioned = await this.deps.provisioning.provision({
        name: deriveProjectName(raw),
        goal: raw.trim(),
        description: null,
      });
      project = provisioned.project;
      repositoryUrl = provisioned.repository?.url ?? null;
      notes.push(...provisioned.notes);
    }

    if (!project) {
      const answer = await this.deps.router.answer(raw);
      return {
        kind: 'work',
        understanding: interpretation.understanding,
        said: answer.summary,
        href: answer.href,
        answer,
        started: null,
        proposal: null,
        notes,
      };
    }

    const created = await this.deps.missions.create(
      {
        rawRequest: raw,
        projectId: project.id,
        ...(interpretation.missionType ? { type: interpretation.missionType } : {}),
        priority: 'medium',
        constraints: [],
        doNotTouch: [],
        acceptanceCriteria: [],
      },
      ownerLogin,
      { createdBy: 'owner' },
    );

    if (created.refusal) {
      return {
        kind: 'work',
        understanding: interpretation.understanding,
        said: created.refusal,
        href: null,
        answer: null,
        started: null,
        proposal: null,
        notes,
      };
    }

    /*
     * A question that has to be answered before there is anything to plan. Saying so and stopping
     * is the honest outcome; guessing at the answer to keep the momentum is how a mission ends up
     * building the wrong thing convincingly.
     */
    if (created.questions.length > 0) {
      const question = created.questions[0]?.question ?? 'One thing needs answering first.';
      return {
        kind: 'work',
        understanding: interpretation.understanding,
        said: `Before I start: ${question}`,
        href: `/missions/${created.mission.id}`,
        answer: null,
        started: {
          missionId: created.mission.id,
          title: created.mission.title,
          projectId: project.id,
          projectName: project.shortName ?? project.name,
          repositoryUrl,
          planning: false,
        },
        proposal: null,
        notes,
      };
    }

    await this.deps.missions.requestPlan(created.mission.id);
    const authority = await this.deps.authority();

    return {
      kind: 'work',
      understanding: interpretation.understanding,
      said: authority.standingAuthority
        ? `Started. I am planning ${created.mission.title} on ${project.shortName ?? project.name} now, and I will tell you when there is something to see.`
        : `Planning ${created.mission.title} on ${project.shortName ?? project.name}. ${authority.blockedReason ?? ''} It will wait for you at the plan.`.trim(),
      href: `/missions/${created.mission.id}`,
      answer: null,
      started: {
        missionId: created.mission.id,
        title: created.mission.title,
        projectId: project.id,
        projectName: project.shortName ?? project.name,
        repositoryUrl,
        planning: true,
      },
      proposal: null,
      notes,
    };
  }

  /* ------------------------------------------------------------------ ideas */

  /**
   * An idea, answered and offered — never built.
   *
   * The proposal it returns is what makes "go ahead" mean something on the next turn. Its id is
   * derived from the message so that saying the same thing twice does not produce two proposals
   * the owner would have to tell apart.
   */
  private async proposeIdea(
    interpretation: Interpretation,
    raw: string,
    context: ConversationContext,
  ): Promise<ConversationTurn> {
    const answer = await this.deps.router.answer(raw, context);
    const name = deriveProjectName(raw);
    return {
      kind: 'idea',
      understanding: interpretation.understanding,
      said: `${answer.summary} If you want it, say go ahead and I will start ${name} — a private repository, a goal, and a first pass at the smallest useful version.`,
      href: answer.href,
      answer,
      started: null,
      proposal: {
        id: proposalId(raw),
        summary: `Start ${name} and build the smallest useful version.`,
      },
      notes: [],
    };
  }

  /* ------------------------------------------------------------ follow-ups */

  private async followUp(
    interpretation: Interpretation,
    context: ConversationContext,
    ownerLogin: string | null,
  ): Promise<ConversationTurn> {
    const followUp = interpretation.followUp;

    if (followUp?.kind === 'accept' && context.proposal) {
      /*
       * Re-interpreted from the proposal's own words rather than acted on as a decision already
       * made. Everything that would have refused the original sentence refuses it here too.
       */
      return this.startWork(
        interpretMessage(context.proposal.summary),
        context.proposal.summary,
        ownerLogin,
      );
    }

    const answer = await this.deps.router.answer(interpretation.raw, context);
    return {
      kind: 'follow_up',
      understanding: interpretation.understanding,
      said: answer.summary,
      href: answer.href,
      answer,
      started: null,
      proposal: null,
      notes: [],
    };
  }

  /* --------------------------------------------------------------- the rest */

  private async answer(
    interpretation: Interpretation,
    raw: string,
    context: ConversationContext,
  ): Promise<ConversationTurn> {
    const answer = await this.deps.router.answer(raw, context);
    return {
      kind: interpretation.kind,
      understanding: interpretation.understanding,
      said: answer.summary,
      href: answer.href,
      answer,
      started: null,
      proposal: null,
      notes: [],
    };
  }

  private async resolveProject(subject: string | null): Promise<Project | null> {
    if (!subject) return null;
    const projects = await this.deps.projects.listAllForAssessment(false);
    const match = resolveProjectName(
      subject,
      projects.map((project) => ({
        id: project.id,
        name: project.name,
        shortName: project.shortName,
      })),
    );
    /* An ambiguous name is not a match. Picking the first would pick somebody's other project. */
    if (match.kind === 'ambiguous' || match.matches.length !== 1) return null;
    return projects.find((project) => project.id === match.matches[0]?.id) ?? null;
  }
}

/**
 * A stable id for a proposal, from the words it was made of.
 *
 * Not random, so the same idea said twice is the same proposal rather than two the owner has to
 * distinguish between. Not a hash of anything secret — this is a conversation key, and it is only
 * ever compared to itself.
 */
function proposalId(raw: string): string {
  let hash = 0;
  const text = raw.trim().toLowerCase();
  for (let index = 0; index < text.length; index += 1) {
    hash = (hash * 31 + text.charCodeAt(index)) | 0;
  }
  return `proposal-${(hash >>> 0).toString(36)}`;
}
