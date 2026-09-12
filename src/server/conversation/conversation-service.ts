import {
  EMPTY_CONTEXT,
  interpretMessage,
  type ConversationContext,
  type Interpretation,
} from '@/domain/interpretation';
import { buildBrief } from '@/domain/build-brief';
import { boundText } from '@/domain/redaction';
import { MISSION_LIST_ENTRY_MAX_CHARS } from '@/domain/mission';
import { finalisedV1, readRefinement } from '@/domain/refinement';
import type { OperatingEventKind, OperatingState } from '@/domain/operating-state';
import {
  deriveProjectName,
  describesNewProject,
  statedProductName,
  UNNAMED,
} from '@/domain/new-project';
import type { Project } from '@/domain/project';
import type { QueryAnswer } from '@/domain/query';
import { resolveProjectName } from '@/server/query/parser';
import type { StatusQueryRouter } from '@/server/query/router';
import type { MissionService } from '@/server/missions/mission-service';
import type { ProjectRepository } from '@/server/repositories/types';
import type { ProjectProvisioningService } from '@/server/services/project-provisioning';
import type { ProposalRepository } from '@/server/repositories/proposal-types';
import {
  NO_RESEARCH_NOTICE,
  proposalSubjectKey,
  type IdeaEvaluation,
  type Proposal,
} from '@/domain/proposal';
import { MATERIAL_V1_QUESTIONS } from './idea-evaluator';
import type { ReasoningService, ThinkingState } from './reasoning-service';

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
  /** The structured assessment behind an `idea` turn, for the dashboard to lay out. */
  readonly evaluation: IdeaEvaluation | null;
  /**
   * Where the worker has got to with this question.
   *
   * Present on an `idea` turn and null everywhere else. `thinking` means somebody is running it on
   * the owner's Claude subscription right now; `blocked` names the exact condition and whether the
   * question survives for a retry. The dashboard shows this rather than a spinner with no cause.
   */
  readonly thinking: ThinkingState | null;
  /** True when the message forbade building. Nothing is created on such a turn, ever. */
  readonly noBuildYet: boolean;
  /** Everything that was created, in plain sentences. Empty when nothing was. */
  readonly notes: readonly string[];
}

export interface ConversationDeps {
  readonly router: StatusQueryRouter;
  readonly proposals: ProposalRepository;
  readonly reasoning: ReasoningService;
  readonly clock?: () => Date;
  readonly missions: MissionService;
  readonly projects: ProjectRepository;
  readonly provisioning: ProjectProvisioningService;
  /** Whether standing authority is in force, and the sentence saying why it is not. */
  readonly authority: () => Promise<{
    readonly standingAuthority: boolean;
    readonly blockedReason: string | null;
  }>;
  /**
   * Where each idea has got to.
   *
   * Optional so that every existing caller — and every test that builds this service by hand —
   * keeps working untouched. When it is absent the conversation behaves exactly as it did; when it
   * is present each turn also records the idea's progress as events the screen can read back by
   * proposal and speak exactly once.
   */
  readonly operating?: OperatingRecorder;
}

/**
 * The narrow slice of the operating repository this service needs.
 *
 * An interface rather than the class, so the conversation does not depend on Drizzle and a test can
 * hand it something that records into an array.
 */
export interface OperatingRecorder {
  transition(
    proposalId: string,
    input: {
      readonly to: OperatingState;
      readonly kind: OperatingEventKind;
      readonly message: string;
      readonly projectId?: string | null;
      readonly missionId?: string | null;
      readonly detail?: string | null;
      readonly now: Date;
    },
  ): Promise<unknown>;
}

export interface ConversationInput {
  readonly message: string;
  readonly context?: ConversationContext;
  readonly ownerLogin?: string | null;
}

/**
 * Is this sentence somebody answering, rather than somebody asking?
 *
 * Asked only of a message that already reads as `question`, and only to decide whether the name
 * inside it may bind a reply to a waiting mission. The browser's own "I had just asked something"
 * flag does not need this — there, Jarvis genuinely had just asked — but a name in a sentence is
 * not consent to file it, and the sentences that name a project most often are the ones asking
 * about it.
 *
 * Two tests, both about the shape of the sentence rather than its topic. `recognisedQuestion` is
 * true when `interpretMessage` matched one of its status phrasings — "how is X going", "what is the
 * status of X", "has X started". A trailing question mark catches the rest. Measured against those
 * phrasings the pair excludes every one of them, and admits "Continue work on the existing
 * CampusCountdown project. The definition of done is…".
 */
function readsAsAnAnswer(raw: string, interpretation: Interpretation): boolean {
  return !interpretation.recognisedQuestion && !raw.trim().endsWith('?');
}

/**
 * Enough of an answer to record, a deferral, or nothing at all.
 *
 * "Ask again only if the answer is genuinely insufficient" cannot be done by recording the answer
 * and re-asking: the clarification row is unique on (mission, question) and
 * `buildClarificationQuestions` filters out every id already asked, so an answered question can
 * never come back. The only honest way to ask twice is not to record it, which leaves the question
 * open and shows it again.
 *
 * So the bar is deliberately at the floor. `insufficient` is for a reply that says *nothing* — an
 * acknowledgement, a filler, an empty string. Everything with any content at all is recorded as
 * written, because Jarvis is not the judge of whether the owner's definition of done is a good one.
 *
 * `defer` is separate and is not insufficient. "Whatever you think" is a real answer: it says *use
 * your judgement*, which `answerClarification` already records by taking its own recommendation and
 * marking it `inferred` rather than `manual` — an assumption Jarvis made, never a decision the
 * owner took. Without this, the one reply that most obviously means "carry on" would be the one
 * that asked the same question for ever.
 */
export function judgeAnswer(
  raw: string,
  recommendation: string | null,
): { readonly kind: 'record' | 'defer' | 'insufficient' } {
  const text = raw
    .trim()
    .toLowerCase()
    .replace(/[.!?]+$/, '');
  if (text.length === 0) return { kind: 'insufficient' };

  if (DEFERS.test(text) && recommendation) return { kind: 'defer' };
  /* A deferral with nothing to defer to is not an answer; asking again is the only honest reply. */
  if (DEFERS.test(text)) return { kind: 'insufficient' };

  if (EMPTY_REPLY.has(text)) return { kind: 'insufficient' };
  return { kind: 'record' };
}

/**
 * "Use your judgement", in the handful of ways people write it.
 *
 * Kept to phrasings that hand the decision over explicitly. A vague answer is not a deferral — "it
 * should look nice" is a poor definition of done and still the owner's, and Jarvis substituting its
 * own recommendation for it would be overruling them rather than helping.
 */
const DEFERS =
  /^(?:whatever|anything)\b.*\b(?:you (?:think|like|want|prefer)|is sensible|works|suits)\b|\b(?:you|your) (?:decide|call|choice|judgement|judgment)\b|\bup to you\b|\buse your (?:judgement|judgment|discretion)\b|\bi (?:don'?t|do not) mind\b/;

/**
 * Replies that acknowledge without answering.
 *
 * A closed set, matched whole rather than by substring, because a reply *containing* "ok" — "ok, it
 * is done when the board shows every event" — is an answer with an "ok" on the front.
 */
const EMPTY_REPLY = new Set([
  'ok',
  'okay',
  'k',
  'sure',
  'yes',
  'yep',
  'yeah',
  'fine',
  'good',
  'great',
  'got it',
  'sounds good',
  'thanks',
  'thank you',
  'no',
  'nope',
  'idk',
  'dunno',
  'not sure',
  'n/a',
  'na',
  '-',
]);

export class ConversationService {
  constructor(private readonly deps: ConversationDeps) {}

  private now(): Date {
    return this.deps.clock?.() ?? new Date();
  }

  async handle(input: ConversationInput): Promise<ConversationTurn> {
    const context = input.context ?? EMPTY_CONTEXT;
    const interpretation = interpretMessage(input.message, context);

    /*
     * A reply to the question I asked, before anything else reads it as something new.
     *
     * Jarvis asks one question before it plans — "how will you know this is done and right?" — and
     * asks it in the conversation, where the reply is typed straight back. That reply used to be
     * classified as an ordinary question and handed to the status router, which looked for a
     * project by that name and answered "no matching project". So the one question Jarvis itself
     * had just asked was the one sentence it could not hear, and the only way to answer it was to
     * leave the conversation for the mission screen.
     *
     * `question` alone, and deliberately. Every other kind has its own case below with its own
     * meaning — a reply that arrived as `work` would be filed here *and* never reach `startWork`.
     *
     * Which replies are admitted, and on what evidence, is decided inside the method, where the
     * database is in reach. See `answerTheQuestionIAsked`.
     */
    if (interpretation.kind === 'question') {
      const answered = await this.answerTheQuestionIAsked(input.message, interpretation, context);
      if (answered) return answered;
    }

    switch (interpretation.kind) {
      case 'work':
        return this.startWork(interpretation, input.message, input.ownerLogin ?? null, context);
      case 'idea':
        return this.proposeIdea(interpretation, input.message);
      case 'follow_up':
        return this.followUp(interpretation, context, input.ownerLogin ?? null);
      case 'refine':
        return this.refine(interpretation, input.message, context);
      case 'acknowledge':
        return this.acknowledge(interpretation, context);
      default:
        return this.answer(interpretation, input.message, context);
    }
  }

  /* ------------------------------------------------------ answering my own question */

  /**
   * Put a reply against the question a mission is waiting on.
   *
   * Returns null rather than an apology whenever this is not that: nothing to answer, nothing that
   * admits the reply, or a reply that is plainly not an answer. The caller then carries on exactly
   * as it did, so the worst this can do is nothing.
   *
   * ## The two ways in, and why one of them is not enough
   *
   * **The browser said I had just asked something.** `context.awaitingAnswer` is computed on the
   * Jarvis screen from the last turn Jarvis took. It is the only thing that can bind a reply which
   * names nothing — "it is done when a quotation shows on load" is an answer and could be about
   * anything — so it stays.
   *
   * It is also gone the moment the page reloads. `turns` is React state that starts empty and is
   * restored from nowhere, so after F5 the flag is false, and the owner's answer fell through to
   * the status router: *"I could not find a project matching that name."* The definition of done
   * they had just typed was discarded, and the mission went on waiting for it.
   *
   * **The message names the project.** That survives a reload by definition — it is in the sentence
   * — and it is what the owner actually writes when they come back to something: *"Continue work
   * on the existing CampusCountdown project. The definition of done is…"*. The name is resolved
   * against the real project list, and only a mission on **that** project is admitted.
   *
   * The second route needs a guard, because a name in a sentence is not consent to file it. Every
   * one of *"How is the CampusCountdown project going?"*, *"What is the status of the
   * CampusCountdown project?"*, *"Has the CampusCountdown project started?"* names the project and
   * none of them is an answer — filed as one, each becomes a requirement the planner reads back as
   * a specification. So route two admits only a sentence that this module did **not** recognise as
   * an enquiry and that does not end in a question mark. Measured over those phrasings, the pair
   * excludes all of them and admits the owner's reply.
   *
   * ## Which mission, and why the name decides it
   *
   * It used to be "the only one waiting", which is wrong in a way that is worse than refusing: with
   * two missions waiting, a reply that named the second was written into the first, where whatever
   * plans it reads the owner's words as its requirements. The name in the sentence is the binding.
   * Only when the reply names nothing does "the only one waiting" apply, and more than one waiting
   * is still a question rather than a guess.
   *
   * ## What it does not do
   *
   * Approve anything. `requestPlan` produces a plan that still waits for the owner unless the
   * charter says otherwise. This is the same act as typing the answer into the mission screen, in
   * the place the question was asked.
   */
  private async answerTheQuestionIAsked(
    raw: string,
    interpretation: Interpretation,
    context: ConversationContext,
  ): Promise<ConversationTurn | null> {
    /*
     * The named-project route, computed before any query.
     *
     * `statedProductName` reads the name out of the sentence — "the existing CampusCountdown
     * project" — and `resolveProject` matches it against the real rows, case-insensitively and
     * refusing anything ambiguous. Doing it first means a message that names nothing and arrives
     * with no flag costs no database round trip at all, which is the common case: every ordinary
     * question typed while a mission happens to be waiting.
     */
    const named = readsAsAnAnswer(raw, interpretation) ? statedProductName(raw) : null;
    const namedProject = named ? await this.resolveProject(named) : null;
    if (!context.awaitingAnswer && !namedProject) return null;

    const waiting = await this.deps.missions.list({
      states: ['needs_clarification'],
      limit: 10,
    });
    /*
     * `openClarifications`, never the state alone. `refreshClarifications` can leave a mission in
     * `needs_clarification` with nothing open, and selecting one of those would bind an answer to a
     * question that does not exist.
     */
    const anyWaiting = waiting.items.filter((summary) => summary.openClarifications > 0);
    if (anyWaiting.length === 0) return null;

    const open = namedProject
      ? anyWaiting.filter((summary) => summary.mission.projectId === namedProject.id)
      : anyWaiting;
    /*
     * The sentence named a project, and nothing on it is waiting. Not an answer to anything here,
     * so it goes back to being an ordinary message rather than being filed against something else.
     */
    if (open.length === 0) return null;

    if (open.length > 1) {
      const names = open
        .slice(0, 3)
        .map((summary) => summary.mission.title)
        .join(', ');
      return this.plainly(
        interpretation,
        `I have questions open on more than one thing — ${names}. Say which one that answers.`,
        null,
      );
    }

    const only = open[0]!;
    const detail = await this.deps.missions.detail(only.mission.id);
    const question = detail.clarifications.find((record) => record.answeredAt === null);
    if (!question) return null;

    /*
     * Ask again only when the reply genuinely says nothing.
     *
     * There is no way to re-ask a question once it is answered — the row is unique on
     * (mission, question) and `buildClarificationQuestions` filters out anything already asked — so
     * "ask again" has to mean *do not record it*. Leaving the question open is the only honest way
     * to ask twice, and it costs nothing: the owner sees the question again and answers it.
     *
     * Deliberately narrow. A deferral is not an absence of an answer — "whatever you think" means
     * *use your judgement*, which is what `acceptRecommendation` already exists to record, and
     * treating it as insufficient would ask the same question for ever.
     */
    const verdict = judgeAnswer(raw, question.recommendation);
    if (verdict.kind === 'insufficient') {
      return this.plainly(
        interpretation,
        `I still need this one before I can plan ${only.mission.title}: ${question.question}`,
        `/missions/${only.mission.id}`,
      );
    }

    try {
      const settled = await this.deps.missions.answerClarification(only.mission.id, question.id, {
        /*
         * Bounded to what the mission schema accepts. `applyStructuralAnswer` writes this straight
         * into `acceptanceCriteria`, whose own validator caps an entry at
         * `MISSION_LIST_ENTRY_MAX_CHARS` — so an unbounded write here stores a value that
         * `PATCH /api/missions/:id` would refuse, and the two paths disagree about the same field.
         */
        /*
         * The owner's words as written, including any sentence that only said which project this
         * is about. Trimming the message before recording it would make `manual` provenance a
         * lie — that flag means "the owner decided this", and it has to be what they decided.
         */
        ...(verdict.kind === 'defer'
          ? { acceptRecommendation: true }
          : { answer: boundText(raw, MISSION_LIST_ENTRY_MAX_CHARS), acceptRecommendation: false }),
      });
      const remaining = settled.questions.filter((record) => record.answeredAt === null);
      if (remaining.length > 0) {
        return this.plainly(
          interpretation,
          `Noted. One more before I plan: ${remaining[0]!.question}`,
          `/missions/${only.mission.id}`,
        );
      }

      await this.deps.missions.requestPlan(only.mission.id);
      const authority = await this.deps.authority();
      /*
       * A mission title is the owner's own sentence, punctuation and all, so dropping it into the
       * middle of another one gives "I am planning Build a project called CampusCountdown. now".
       */
      const title = only.mission.title.replace(/[.!?,;:]+$/, '');
      return this.plainly(
        interpretation,
        authority.standingAuthority
          ? `Noted. I am planning ${title} now, and I will tell you when there is something to see.`
          : `Noted. I am planning ${title} now, and I will bring you the plan before anything is built.`,
        `/missions/${only.mission.id}`,
        /*
         * Named as started, because it is. The screen refreshes the dashboard on a turn that
         * carries this, which is how the mission appears as planning without the owner going to
         * find it — the whole point of answering in the conversation rather than on a form.
         *
         * Only on this branch. A turn that still owes an answer, or one that failed, has not
         * started anything and must not read as though it had.
         */
        {
          missionId: only.mission.id,
          title: only.mission.title,
          projectId: only.mission.projectId,
          projectName: only.projectName,
          repositoryUrl: null,
          planning: true,
        },
      );
    } catch (error) {
      /*
       * The service refuses an answer that looks like a credential, and refuses an empty one. Both
       * are worth saying in its own words rather than swallowing — and neither is a reason to fall
       * through to the status router, which would answer a question nobody asked.
       */
      return this.plainly(
        interpretation,
        error instanceof Error ? error.message : 'I could not record that answer.',
        `/missions/${only.mission.id}`,
      );
    }
  }

  /** A turn that is only words: no answer panel, no proposal, nothing started. */
  private plainly(
    interpretation: Interpretation,
    said: string,
    href: string | null,
    started: StartedWorkSummary | null = null,
  ): ConversationTurn {
    return {
      kind: interpretation.kind,
      understanding: interpretation.understanding,
      said,
      href,
      answer: null,
      started,
      proposal: null,
      evaluation: null,
      thinking: null,
      noBuildYet: interpretation.noBuildYet,
      notes: [],
    };
  }

  /* -------------------------------------------------------------- refining */

  /**
   * Answering the questions I asked, and settling the scope.
   *
   * ## What this must not do
   *
   * Go anywhere near `proposals.open`. That method rewrites `title`, `idea` and `summary`
   * unconditionally, so routing a refinement through the idea path would replace the idea with the
   * answers — "Use US dollars. Look ahead until…" would *become* the idea, and `deriveProjectName`
   * would name the project from it. That is the "Yet" bug's exact shape, one turn later in the
   * conversation.
   *
   * It also creates nothing. Not a project, not a repository, not a mission. Refining is deciding
   * what would be built, which is the opposite of building it, and `noBuildYet` is usually set on
   * these messages besides.
   *
   * ## What happens with nothing standing
   *
   * It cannot get here — `refinesStandingWork` returns false without a proposal in the caller's
   * snapshot. But the snapshot is the *browser's* and the row is the truth, so the proposal is
   * re-read here and a miss is answered honestly rather than guessed at.
   */
  private async refine(
    interpretation: Interpretation,
    raw: string,
    context: ConversationContext,
  ): Promise<ConversationTurn> {
    const standing = context.proposal
      ? ((await this.deps.proposals.findById(context.proposal.id)) ??
        (await this.deps.proposals.latestOpen()))
      : await this.deps.proposals.latestOpen();

    if (!standing || standing.state !== 'open') {
      return {
        kind: 'refine',
        understanding: interpretation.understanding,
        said: "I am not sure what that refers to — nothing is open for me to change. Describe the idea and I'll pick it up from there.",
        href: null,
        answer: null,
        started: null,
        proposal: null,
        evaluation: null,
        thinking: null,
        noBuildYet: interpretation.noBuildYet,
        notes: [],
      };
    }

    const refinement = readRefinement(raw);
    const updated =
      refinement.answers.length > 0 || refinement.locksScope
        ? ((await this.deps.proposals.recordAnswers(standing.id, {
            answers: refinement.answers,
            lockScope: refinement.locksScope,
            now: this.now(),
          })) ?? standing)
        : standing;

    const v1 = finalisedV1(updated);

    /*
     * Recorded on the idea's own timeline, so a reload shows the scope being settled rather than a
     * gap between "evaluating" and "approved".
     */
    await this.record(updated.id, {
      to: 'waiting_for_input',
      kind: 'progress',
      message: refinement.locksScope
        ? `I have settled the first version of ${updated.title} with what you decided.`
        : `I have noted what you decided about ${updated.title}.`,
    });

    return {
      kind: 'refine',
      understanding: interpretation.understanding,
      said: `${v1.sentence}${interpretation.noBuildYet ? ' Nothing has been built.' : ''}`,
      href: null,
      answer: null,
      started: null,
      /* Still standing, so a later "Go ahead" accepts exactly this — with the decisions on it. */
      proposal: { id: updated.id, summary: updated.summary },
      evaluation: updated.evaluation,
      thinking: null,
      noBuildYet: interpretation.noBuildYet,
      notes: [],
    };
  }

  /**
   * A constraint on what happens next, and nothing else.
   *
   * "Do not build it yet." on its own. Nothing is created, nothing is changed, and — the part that
   * matters — nothing is discarded: whatever was standing is handed back so the next "go ahead"
   * still has something to accept. This used to answer "Nothing, then", which read as agreement
   * that the whole conversation was off.
   */
  private async acknowledge(
    interpretation: Interpretation,
    context: ConversationContext,
  ): Promise<ConversationTurn> {
    const standing = context.proposal
      ? ((await this.deps.proposals.findById(context.proposal.id)) ?? null)
      : await this.deps.proposals.latestOpen();
    const open = standing?.state === 'open' ? standing : null;

    return {
      kind: 'acknowledge',
      understanding: interpretation.understanding,
      said: open
        ? `Understood — I will not build anything yet. ${open.title} is still here whenever you want it.`
        : 'Understood — I will not build anything yet.',
      href: null,
      answer: null,
      started: null,
      proposal: open ? { id: open.id, summary: open.summary } : null,
      evaluation: open?.evaluation ?? null,
      thinking: null,
      noBuildYet: true,
      notes: [],
    };
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
    context: ConversationContext,
  ): Promise<ConversationTurn> {
    const notes: string[] = [];
    let project = await this.resolveProject(interpretation.subject);
    let repositoryUrl: string | null = null;

    /*
     * The project the owner was looking at, when the sentence did not name one.
     *
     * `focusedProjectId` has been on the context type since it was written, described there as
     * "used only to resolve a bare 'it' or 'that'", and until now nothing read it. The cost of that
     * showed up as a second project: "now build a dark mode app for QuickPick" resolves its subject
     * to "quickpick", and when that name does not match a row — an ambiguous name counts as no
     * match — `describesNewProject` is true and `deriveProjectName` returns "Dark Mode", so the next
     * few lines provision a project called Dark Mode with a repository of its own, beside the one
     * the owner was working in.
     *
     * Reading the focus first makes a change to work in flight land on that work. It is only ever a
     * fallback: a sentence that names a project it can find still goes to the project it named,
     * because the person said so. And it is verified against the repository rather than trusted,
     * since the id arrives from the browser.
     */
    if (!project && context.focusedProjectId) {
      project = await this.deps.projects.findById(context.focusedProjectId);
      if (project) notes.push(`Continued in ${project.name}, which you had open.`);
    }

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
        evaluation: null,
        thinking: null,
        noBuildYet: interpretation.noBuildYet,
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
        evaluation: null,
        thinking: null,
        noBuildYet: interpretation.noBuildYet,
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
        evaluation: null,
        thinking: null,
        noBuildYet: interpretation.noBuildYet,
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
      evaluation: null,
      thinking: null,
      noBuildYet: interpretation.noBuildYet,
      notes,
    };
  }

  /* ------------------------------------------------------------------ ideas */

  /**
   * An idea, assessed and offered — never built.
   *
   * ## What changed here, and why
   *
   * This used to return one sentence and a proposal that lived in the browser tab. The owner asked
   * whether QuickPick was worth building and got "Nothing, then." — and when he asked again, in
   * plainer words, he got a "Prepare this mission" button. Both failures came from the same place:
   * an idea had no representation of its own, so it fell through to something that did.
   *
   * Now an idea produces an assessment and a row. The assessment says who would use it, what
   * problem it solves, whether it looks worth doing, the smallest V1, what is being assumed, and
   * only the questions that would change that V1 — or says honestly that nothing judged it. The
   * row is what "go ahead" attaches to, and it outlives the page that produced it.
   *
   * ## What it must never do
   *
   * Create anything. Not a project, not a repository, not a mission. `noBuildYet` makes that
   * explicit in the reply when the owner said so, but it is true on this path either way.
   */
  private async proposeIdea(
    interpretation: Interpretation,
    raw: string,
  ): Promise<ConversationTurn> {
    const title = deriveProjectName(raw);

    /*
     * The proposal is written first, before anything has judged the idea.
     *
     * That ordering is the whole reason "go ahead" works an hour later. The assessment now comes
     * from the worker and arrives seconds or minutes after this turn returns, so a proposal that
     * waited for it would not exist while the owner was reading the reply — and a page refresh in
     * that window would lose the thing he was about to agree to.
     *
     * `evaluation: null` means "nothing to say about it yet", not "forget what you knew": the
     * store keeps whatever it already had, so re-describing an idea while its answer is in flight
     * does not erase the answer that is about to land.
     */
    const proposal = await this.deps.proposals.open({
      fingerprint: proposalSubjectKey(raw),
      title,
      idea: raw.trim(),
      summary: `Start ${title} and build the smallest useful version.`,
      evaluation: null,
      openQuestions: [],
      recommendedV1: [],
      assumptions: [],
      now: this.now(),
    });

    /*
     * An idea described again after it was already built. Saying so is the useful answer; opening a
     * second proposal for it would be how the owner ends up with two of everything.
     */
    if (proposal.state === 'accepted') {
      return {
        kind: 'idea',
        understanding: interpretation.understanding,
        said: `You already asked me to build ${proposal.title}, and I did — nothing new has been created.`,
        href: proposal.projectId ? `/projects/${proposal.projectId}` : null,
        answer: null,
        started: null,
        proposal: null,
        evaluation: proposal.evaluation,
        thinking: null,
        noBuildYet: interpretation.noBuildYet,
        notes: [],
      };
    }

    /*
     * Ask the worker. Idempotent on the proposal, so describing the same idea twice — or a double
     * submit, or a retry — costs one answer rather than three.
     */
    const thinking = await this.deps.reasoning.requestIdeaEvaluation({
      proposalId: proposal.id,
      conversationId: null,
      idea: raw.trim(),
      title,
      existing: proposal.evaluation,
    });

    /*
     * Captured, then evaluating — two events rather than one, because they are two different
     * things the owner would want to hear and the second can take minutes to follow the first.
     */
    await this.record(proposal.id, {
      to: 'captured',
      kind: 'transition',
      message: `I understood the goal: ${title}.`,
    });
    if (thinking.state === 'thinking') {
      await this.record(proposal.id, {
        to: 'evaluating',
        kind: 'progress',
        message: `I'm evaluating the smallest useful version of ${title}.`,
      });
    } else if (thinking.state === 'blocked') {
      await this.record(proposal.id, {
        to: 'blocked',
        kind: 'progress',
        message: thinking.detail,
        detail: thinking.detail,
      });
    }

    return {
      kind: 'idea',
      understanding: interpretation.understanding,
      said: spokenIdea(proposal, thinking, interpretation.noBuildYet),
      href: null,
      answer: null,
      started: null,
      proposal: { id: proposal.id, summary: proposal.summary },
      evaluation: thinking.state === 'ready' ? thinking.evaluation : null,
      thinking,
      noBuildYet: interpretation.noBuildYet,
      notes: [],
    };
  }

  /**
   * Record where an idea has got to, in the words the owner will read and hear.
   *
   * Never throws into the conversation. A failure to record progress must not fail the turn that
   * made the progress — the owner would lose the answer to protect the note about the answer.
   */
  private async record(
    proposalId: string,
    input: {
      readonly to: OperatingState;
      readonly kind: OperatingEventKind;
      readonly message: string;
      readonly projectId?: string | null;
      readonly missionId?: string | null;
      readonly detail?: string | null;
    },
  ): Promise<void> {
    if (!this.deps.operating) return;
    try {
      await this.deps.operating.transition(proposalId, { ...input, now: this.now() });
    } catch {
      /* Progress is a narration of the work, not the work. */
    }
  }

  /* ------------------------------------------------------------ follow-ups */

  private async followUp(
    interpretation: Interpretation,
    context: ConversationContext,
    ownerLogin: string | null,
  ): Promise<ConversationTurn> {
    const followUp = interpretation.followUp;

    /*
     * A reply that pointed at a list which is no longer there.
     *
     * This is not agreement and must never be treated as it. "The second option", typed after the
     * list scrolled away, used to fall into the branch below and accept whatever proposal happened
     * to be open — provisioning a repository for a message that named no subject. The honest answer
     * is the one the domain type already prescribes: say the list moved, and show it again.
     */
    if (followUp?.kind === 'stale' && followUp.was === 'selection') {
      return {
        kind: 'follow_up',
        understanding: interpretation.understanding,
        said: `${followUp.reason} Tell me which one you meant and I will do it.`,
        href: null,
        answer: null,
        started: null,
        proposal: null,
        evaluation: null,
        thinking: null,
        noBuildYet: interpretation.noBuildYet,
        notes: [],
      };
    }

    if (followUp?.kind === 'accept' || followUp?.kind === 'stale') {
      /*
       * Bound to the proposal the page was showing when the owner answered, and to the newest open
       * one when it was not showing any — which is what makes "go ahead" work after a refresh, from
       * a phone, or the morning after. `stale` reaches here too, but only the `acceptance` kind:
       * the interpreter calls a bare "yes" stale because it has no *page* context, and a stored
       * proposal is context enough for that. A stale *selection* is handled above and never binds.
       */
      const bound =
        (followUp.kind === 'accept'
          ? await this.deps.proposals.findById(followUp.proposalId)
          : null) ??
        (context.proposal ? await this.deps.proposals.findById(context.proposal.id) : null) ??
        (await this.deps.proposals.latestOpen());

      if (!bound) {
        /* Requirement, and the right instinct: ask, never guess which thing was meant. */
        return {
          kind: 'follow_up',
          understanding: interpretation.understanding,
          said: 'I do not have anything waiting for a yes. What would you like me to go ahead with?',
          href: null,
          answer: null,
          started: null,
          proposal: null,
          evaluation: null,
          thinking: null,
          noBuildYet: interpretation.noBuildYet,
          notes: [],
        };
      }

      return this.acceptProposal(bound, interpretation, ownerLogin);
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
      evaluation: null,
      thinking: null,
      noBuildYet: interpretation.noBuildYet,
      notes: [],
    };
  }

  /**
   * Turn an agreed proposal into exactly one project, repository, goal and mission.
   *
   * ## Why acceptance is idempotent at three levels
   *
   * Because it is retried in ordinary use, not only in failure: the owner says "go ahead" twice
   * because the first looked like nothing happened, the browser resubmits, a worker retries. The
   * proposal row records what it produced and is stamped conditionally, the provisioning service
   * adopts an existing repository rather than making a second, and the row is re-read after
   * provisioning to close the window between the two.
   */
  private async acceptProposal(
    proposal: Proposal,
    interpretation: Interpretation,
    ownerLogin: string | null,
  ): Promise<ConversationTurn> {
    /* Already done. Return what it produced rather than producing it again. */
    if (proposal.state === 'accepted') return this.alreadyBuilt(proposal, interpretation);

    /*
     * What was agreed, composed rather than quoted.
     *
     * `proposal.idea` is the sentence the owner typed, and it is kept on the row for audit — but it
     * describes a *request*, not a product. Handing it on as the objective is what produced a
     * mission to "Re-evaluate my QuickPick idea … Do not build anything yet", and then a question
     * about whether that should be researched or implemented. The brief is built from the parts
     * that describe the thing: its name, its assessed problem, and the smallest version agreed to.
     */
    const brief = buildBrief(proposal);

    const provisioned = await this.deps.provisioning.provision({
      name: brief.name,
      goal: brief.goal,
      description: brief.description,
    });

    /*
     * Re-read after the slow part. A concurrent "go ahead" that got here first has stamped the row
     * by now, and its project is the one to report — provisioning was idempotent, so both calls
     * resolved to the same project anyway.
     */
    const current = await this.deps.proposals.findById(proposal.id);
    if (current?.state === 'accepted') return this.alreadyBuilt(current, interpretation);

    const created = await this.deps.missions.create(
      {
        rawRequest: brief.objective,
        title: `Build the first version of ${brief.name}`,
        description: brief.description,
        /*
         * Stated, not inferred. Saying yes to a build proposal decides the mode; leaving the type
         * to be guessed from prose is what let a sentence containing both "evaluate" and "build"
         * reopen a question the owner had already answered.
         */
        type: 'code_change',
        projectId: provisioned.project.id,
        priority: 'medium',
        /*
         * What Blake decided while we were settling the scope, carried into the mission.
         *
         * This was `[]`, and every answer he gave — the currency, the horizon, whether tax was in
         * scope, how long an override lasts — was dropped at exactly the moment it started to
         * matter. He answered the questions I asked and then watched something get built that did
         * not honour them, which is the "it forgot what we agreed" failure arriving one step later
         * than the last time.
         */
        constraints: [...brief.constraints],
        doNotTouch: [],
        /*
         * Stated, so the result card on the dashboard has something true to show.
         *
         * The column was never written on this path, and the deliverable card reads it — a mission
         * that finished would have shown its title and nothing about what it produced. The brief
         * already knows the answer; it just was not being written down.
         */
        deliverable: `A working first version of ${brief.name} in its repository.`,
        acceptanceCriteria: [...brief.acceptanceCriteria],
      },
      ownerLogin,
      { createdBy: 'owner' },
    );

    if (!created.refusal && created.questions.length === 0) {
      await this.deps.missions.requestPlan(created.mission.id);
    }

    const accepted = await this.deps.proposals.accept(proposal.id, {
      projectId: provisioned.project.id,
      missionId: created.refusal ? null : created.mission.id,
      repositoryFullName: provisioned.repository?.fullName ?? null,
      now: this.now(),
    });

    const authority = await this.deps.authority();
    const projectName = provisioned.project.shortName ?? provisioned.project.name;
    const planning = !created.refusal && created.questions.length === 0;

    /*
     * Approved, and then what actually happened next.
     *
     * Both carry the project and mission ids, which is what lets the screen show this idea's
     * progress rather than the newest progress of anything — and what lets a reload find the same
     * two rows rather than re-deriving a sentence from whatever is current.
     */
    await this.record(proposal.id, {
      to: 'approved',
      kind: 'transition',
      message: `You agreed to ${brief.name}. I'm creating the project and workspace.`,
      projectId: provisioned.project.id,
      missionId: created.mission.id,
    });
    if (created.questions.length > 0) {
      const first = created.questions[0]?.question;
      await this.record(proposal.id, {
        to: 'waiting_for_input',
        kind: 'question',
        /* The same sentence the transcript shows, so what is heard and what is read cannot drift. */
        message: first
          ? `I need one decision before I can continue: ${first}`
          : 'I need one decision before I can continue.',
        projectId: provisioned.project.id,
        missionId: created.mission.id,
        detail: first ?? null,
      });
    } else if (planning) {
      await this.record(proposal.id, {
        to: 'planning',
        kind: 'progress',
        message: `I'm planning the first version of ${brief.name}.`,
        projectId: provisioned.project.id,
        missionId: created.mission.id,
      });
    } else {
      await this.record(proposal.id, {
        to: 'needs_decision',
        kind: 'question',
        message: `${brief.name} is set up and waiting for you to approve the plan${
          authority.blockedReason ? ` — ${authority.blockedReason}` : ''
        }.`,
        projectId: provisioned.project.id,
        missionId: created.mission.id,
        detail: authority.blockedReason,
      });
    }

    return {
      kind: 'follow_up',
      understanding: `Going ahead with ${brief.name}.`,
      said: created.refusal ?? outcomeSentence(brief.name, created.questions, authority, planning),
      href: `/missions/${created.mission.id}`,
      answer: null,
      started: {
        missionId: created.mission.id,
        title: created.mission.title,
        projectId: provisioned.project.id,
        projectName,
        repositoryUrl: provisioned.repository?.url ?? null,
        planning,
      },
      proposal: null,
      evaluation: accepted.evaluation,
      thinking: null,
      noBuildYet: false,
      notes: [...provisioned.notes],
    };
  }

  /** What a repeated acceptance says: what already exists, and that nothing was added. */
  private alreadyBuilt(proposal: Proposal, interpretation: Interpretation): ConversationTurn {
    return {
      kind: 'follow_up',
      understanding: interpretation.understanding,
      said: `${proposal.title} is already under way — nothing new was created.`,
      href: proposal.missionId ? `/missions/${proposal.missionId}` : null,
      answer: null,
      started: proposal.missionId
        ? {
            missionId: proposal.missionId,
            title: proposal.title,
            projectId: proposal.projectId,
            projectName: proposal.title,
            repositoryUrl: null,
            planning: false,
          }
        : null,
      proposal: null,
      evaluation: proposal.evaluation,
      thinking: null,
      noBuildYet: false,
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
      evaluation: null,
      thinking: null,
      noBuildYet: interpretation.noBuildYet,
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
 * What Jarvis says out loud about an idea.
 *
 * Short, because it is spoken and because the structured evaluation is on screen beside it. It
 * always ends by saying that nothing was created — the owner asked for that in as many words, and
 * it is the sentence that makes the difference between "we discussed it" and "what did you just
 * do to my GitHub account".
 *
 * ## The three states, and why none of them is a paragraph that sounds like an assessment
 *
 * An assessment now comes from the worker, which means there is a real moment where the idea has
 * been heard and not yet judged. That moment has to sound like what it is. Filling it with
 * confident prose derived from keywords would be the single worst thing this function could do:
 * it would be indistinguishable, to a reader, from the answer that arrives a minute later.
 *
 * So: `ready` speaks the verdict. `thinking` says it is thinking, and offers the questions that
 * never needed a model anyway. `blocked` names the exact condition — no worker, no runtime, no
 * capacity — and says whether the question is still waiting. All three end the same way, because
 * the guarantee they share is the important one: nothing was created.
 */
function spokenIdea(proposal: Proposal, thinking: ThinkingState, noBuildYet: boolean): string {
  const parts: string[] = [];

  /*
   * What to call it in a sentence.
   *
   * `deriveProjectName` answers `UNNAMED` when the owner named nothing and nothing in the words
   * suggests a name — which is the right label for a row in the projects list and the wrong thing
   * to put in a sentence: "I have not judged whether New project is worth building" reads as a
   * project called New project. "that" is what a person would say, and it is what the owner just
   * described, so nothing is lost.
   */
  const subject = proposal.title === UNNAMED ? 'that' : proposal.title;

  if (thinking.state === 'ready') {
    const evaluation = thinking.evaluation;
    parts.push(evaluation.verdict);
    if (evaluation.smallestV1.length > 0) {
      parts.push(`The smallest useful version: ${evaluation.smallestV1.slice(0, 3).join('; ')}.`);
    }
    if (evaluation.questions.length > 0) {
      parts.push(
        `${evaluation.questions.length} question${evaluation.questions.length === 1 ? '' : 's'} would change that answer — they are on screen.`,
      );
    }
    parts.push(NO_RESEARCH_NOTICE);
  } else if (thinking.state === 'thinking') {
    parts.push(`I am thinking about whether ${subject} is worth building. ${thinking.detail}`);
    parts.push(`In the meantime: ${MATERIAL_V1_QUESTIONS[0]}`);
  } else {
    parts.push(`I have not judged whether ${subject} is worth building. ${thinking.detail}`);
    parts.push(`What I can ask without one: ${MATERIAL_V1_QUESTIONS[0]}`);
  }

  parts.push(
    noBuildYet
      ? 'Nothing has been created, and I will not build it until you say so.'
      : 'No project, repository or mission has been created. Say go ahead and I will start it.',
  );

  return parts.join(' ');
}

/**
 * What actually happened, said without overstating it.
 *
 * "Started" was printed whether or not anything had started — including when the mission was
 * sitting on a clarifying question, and including when the deployment's own mode meant nothing
 * would run until the owner approved a plan. Three different situations, one sentence, and the one
 * word in it that mattered was wrong in two of them.
 *
 * Each branch below says the thing that is true, and names the actual blocker when there is one.
 * The project and the repository really were created in every branch, so that part is stated
 * plainly; what varies is whether any work is under way, which is the part that was being fudged.
 */
function outcomeSentence(
  name: string,
  questions: readonly { readonly question: string }[],
  authority: { standingAuthority: boolean; blockedReason: string | null },
  planning: boolean,
): string {
  if (questions.length > 0) {
    const first = questions[0]?.question;
    const count = questions.length === 1 ? 'one question' : `${questions.length} questions`;
    return `${name} is set up and the mission is written. Nothing is being planned yet — I have ${count} first${first ? `: ${first}` : '.'}`;
  }

  if (!planning) {
    return `${name} is set up and the mission is written. Nothing is running yet.`;
  }

  if (authority.standingAuthority) {
    return `${name} is set up and I am planning the first version now. I will tell you when there is something to see.`;
  }

  return `${name} is set up and the plan is being prepared. Nothing will run until you approve it${
    authority.blockedReason ? ` — ${authority.blockedReason}` : ''
  }.`;
}
