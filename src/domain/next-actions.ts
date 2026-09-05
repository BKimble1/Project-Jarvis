import type { MissionRiskLevel } from './mission';
import { OPERATING_MODE_LABELS, type OperatingMode } from './operating-mode';

/**
 * The specific things worth doing next, in order, derived from records rather than from a model.
 *
 * ## Why this is deterministic
 *
 * "What should I do next?" is the question a personal operator exists to answer, and it is exactly
 * the question a model answers most plausibly and least reliably. Every item here is a real row —
 * an unanswered question, a plan awaiting approval, a pull request that exists — so the list can
 * be *acted on* rather than merely read. A generated list would produce suggestions that cannot be
 * clicked, which is the difference between an assistant and a chat window.
 *
 * ## Why the order is what it is
 *
 * Ordered by what is blocking the most, not by what is most interesting:
 *
 *  1. **Nothing can run.** No worker, or Jarvis is paused. Everything below is theoretical until
 *     this is fixed, so it goes first even though it is the least interesting.
 *  2. **Jarvis is waiting for you.** A clarification, a plan, a task graph, a permission request.
 *     These are the items where Jarvis has done its part and stopped.
 *  3. **Work finished and needs a look.** A pull request nobody has read.
 *  4. **Work Jarvis would start.** The top of its own backlog, so "what would you do next?" has an
 *     answer even on a quiet morning.
 *
 * ## Why it is capped
 *
 * Five. A list of thirty next actions is a backlog, and a backlog is what a person came here to
 * avoid reading. The rest stay in Mission Control, where they belong.
 */

export const NEXT_ACTION_KINDS = [
  'start_worker',
  'resume_jarvis',
  'answer_clarification',
  'approve_plan',
  'approve_graph',
  'decide_permission',
  'review_pull_request',
  'start_opportunity',
] as const;
export type NextActionKind = (typeof NEXT_ACTION_KINDS)[number];

export interface NextAction {
  /** Stable within one assembly, so a reply of "do the first one" resolves to a real thing. */
  readonly id: string;
  readonly kind: NextActionKind;
  /** Imperative, one line, no ceremony. What a person would say they are about to do. */
  readonly label: string;
  /** One sentence of why, from the record. Never speculation. */
  readonly detail: string;
  /** Where in Jarvis this is done. Always internal. */
  readonly href: string;
  /** The record this acts on, for the caller that performs it. */
  readonly subjectId: string;
  /**
   * True when only the owner can do this.
   *
   * `start_opportunity` is the interesting case: under standing authority Jarvis starts it itself,
   * so an owner saying "do the first one" is confirming rather than approving, and must not be
   * walked through an approval the charter already granted.
   */
  readonly requiresOwner: boolean;
}

export const MAX_NEXT_ACTIONS = 5;

export interface NextActionInput {
  readonly mode: OperatingMode;
  readonly standingAuthority: boolean;
  readonly workerReady: boolean;
  readonly clarifications: readonly {
    readonly missionId: string;
    readonly missionTitle: string;
    readonly questionId: string;
    readonly question: string;
  }[];
  readonly plansAwaitingApproval: readonly {
    readonly missionId: string;
    readonly missionTitle: string;
    readonly riskLevel: MissionRiskLevel;
  }[];
  readonly graphsAwaitingApproval: readonly {
    readonly missionId: string;
    readonly missionTitle: string;
    readonly taskCount: number;
  }[];
  readonly permissionRequests: readonly {
    readonly missionId: string;
    readonly missionTitle: string;
    readonly requestId: string;
    readonly summary: string;
  }[];
  readonly pullRequests: readonly {
    readonly missionId: string;
    readonly missionTitle: string;
  }[];
  /** The operator's own backlog, already ranked. Only bands it would actually act on. */
  readonly opportunities: readonly {
    readonly key: string;
    readonly title: string;
    readonly projectName: string | null;
    readonly reason: string;
  }[];
}

export function nextActions(input: NextActionInput): readonly NextAction[] {
  const actions: NextAction[] = [];

  if (!input.workerReady) {
    actions.push({
      id: 'start_worker',
      kind: 'start_worker',
      label: 'Start a worker',
      detail:
        'No worker is connected, so nothing can run. Jarvis can still plan and answer questions.',
      href: '/workers',
      subjectId: 'worker',
      requiresOwner: true,
    });
  }

  if (input.mode === 'paused' || input.mode === 'off' || input.mode === 'emergency_stop') {
    actions.push({
      id: 'resume_jarvis',
      kind: 'resume_jarvis',
      label: 'Resume Jarvis',
      detail: `Jarvis is ${OPERATING_MODE_LABELS[input.mode].toLowerCase()}, so it will not start anything on its own.`,
      href: '/operations',
      subjectId: 'mode',
      requiresOwner: true,
    });
  }

  for (const entry of input.clarifications) {
    actions.push({
      id: `clarify:${entry.questionId}`,
      kind: 'answer_clarification',
      label: `Answer a question about ${entry.missionTitle}`,
      detail: entry.question,
      href: `/missions/${entry.missionId}`,
      subjectId: entry.questionId,
      requiresOwner: true,
    });
  }

  for (const entry of input.plansAwaitingApproval) {
    actions.push({
      id: `plan:${entry.missionId}`,
      kind: 'approve_plan',
      label: `Approve the plan for ${entry.missionTitle}`,
      detail: `Jarvis has written a plan and is waiting. Risk: ${entry.riskLevel.replace(/_/g, ' ')}.`,
      href: `/missions/${entry.missionId}`,
      subjectId: entry.missionId,
      requiresOwner: true,
    });
  }

  for (const entry of input.graphsAwaitingApproval) {
    actions.push({
      id: `graph:${entry.missionId}`,
      kind: 'approve_graph',
      label: `Approve how ${entry.missionTitle} will be done`,
      detail: `${entry.taskCount} task${entry.taskCount === 1 ? '' : 's'}, and nothing can be claimed until you agree to them.`,
      href: `/missions/${entry.missionId}`,
      subjectId: entry.missionId,
      requiresOwner: true,
    });
  }

  for (const entry of input.permissionRequests) {
    actions.push({
      id: `permission:${entry.requestId}`,
      kind: 'decide_permission',
      label: `Decide a permission for ${entry.missionTitle}`,
      detail: entry.summary,
      href: `/missions/${entry.missionId}`,
      subjectId: entry.requestId,
      requiresOwner: true,
    });
  }

  for (const entry of input.pullRequests) {
    actions.push({
      id: `pr:${entry.missionId}`,
      kind: 'review_pull_request',
      label: `Read the pull request from ${entry.missionTitle}`,
      detail: 'The work is finished and opened as a draft. Nothing was merged.',
      href: `/missions/${entry.missionId}`,
      subjectId: entry.missionId,
      requiresOwner: true,
    });
  }

  for (const entry of input.opportunities) {
    actions.push({
      id: `opportunity:${entry.key}`,
      kind: 'start_opportunity',
      label: entry.projectName ? `${entry.title} (${entry.projectName})` : entry.title,
      detail: entry.reason,
      href: '/missions',
      subjectId: entry.key,
      /*
       * The one action that may not need the owner. Under standing authority Jarvis starts these
       * itself, so a person saying "do the first one" is confirming a decision the charter already
       * covers — walking them through an approval at that point is the repeated-approval problem
       * this whole design exists to avoid.
       */
      requiresOwner: !input.standingAuthority,
    });
  }

  return actions.slice(0, MAX_NEXT_ACTIONS);
}

/**
 * One line for a person who asked "what is going on?" and wants the answer, not a list.
 *
 * Deliberately says "nothing needs you" rather than nothing at all: silence reads as a failure to
 * look, and the whole value of a deterministic list is that its emptiness means something.
 */
export function summariseNextActions(actions: readonly NextAction[]): string {
  if (actions.length === 0) return 'Nothing needs you right now.';
  const first = actions[0];
  if (!first) return 'Nothing needs you right now.';
  if (actions.length === 1) return first.label;
  return `${first.label}, and ${actions.length - 1} other thing${actions.length === 2 ? '' : 's'}.`;
}
