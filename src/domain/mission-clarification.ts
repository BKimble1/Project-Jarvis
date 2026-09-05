import { MISSION_RISK_RANK, isReadOnlyMissionType } from './mission';
import type { ClarificationQuestion, Mission, MissionRiskLevel, MissionType } from './mission';
import type { ProjectStatus, ProjectType } from './enums';

/**
 * Which questions are worth the owner's time?
 *
 * The rule is deliberately strict: ask only when a different answer would produce a different
 * implementation, a different safety posture, or a different definition of done. A generic
 * questionnaire is worse than no questions at all — it trains the owner to skim past the one
 * question that mattered.
 *
 * At most `MAX_QUESTIONS` are asked at a time, highest priority first.
 */

export const MAX_QUESTIONS = 3;

export interface ClarificationInput {
  readonly mission: Pick<
    Mission,
    | 'rawRequest'
    | 'type'
    | 'riskLevel'
    | 'projectId'
    | 'deliverable'
    | 'acceptanceCriteria'
    | 'constraints'
    | 'doNotTouch'
    | 'sourceId'
  >;
  readonly project: {
    readonly name: string;
    readonly status: ProjectStatus;
    readonly type: ProjectType;
    readonly archived: boolean;
    readonly goal: string | null;
  } | null;
  /** Repository sources on the project, so "which repository?" is only asked when it is real. */
  readonly repositoryChoices: readonly { readonly id: string; readonly fullName: string }[];
  /** Questions already asked, so Jarvis never asks the same thing twice. */
  readonly alreadyAsked: readonly string[];
}

interface Candidate extends ClarificationQuestion {
  readonly priority: number;
}

export function buildClarificationQuestions(
  input: ClarificationInput,
): readonly ClarificationQuestion[] {
  const { mission, project } = input;
  const text = mission.rawRequest;
  const asked = new Set(input.alreadyAsked);
  const candidates: Candidate[] = [];

  /* 1 — no project at all. Nothing else can be decided without this. */
  if (!mission.projectId || !project) {
    candidates.push({
      id: 'project',
      topic: 'project',
      priority: 0,
      question: 'Which project is this for?',
      why: 'Jarvis will not guess between projects — the wrong repository is the one mistake that is expensive to undo.',
      options: [],
      recommendation: null,
      rule: 'R-CL1',
    });
  }

  /* 2 — the project is paused, archived or complete: the owner must decide before anything else. */
  if (project && project.archived) {
    candidates.push({
      id: 'archived_project',
      topic: 'project',
      priority: 1,
      question: `${project.name} is archived. Restore it first, or point this mission at a different project?`,
      why: 'Jarvis does no work on an archived project.',
      options: [`Restore ${project.name}`, 'Choose a different project', 'Cancel this mission'],
      recommendation: null,
      rule: 'R-CL2',
    });
  } else if (project?.status === 'paused') {
    candidates.push({
      id: 'paused_project',
      topic: 'project',
      priority: 1,
      question: `${project.name} is paused. Is this a deliberate one-off, or are you restarting the project?`,
      why: 'A paused project does not queue ordinary development work without you saying so.',
      options: [
        'One-time mission, leave the project paused',
        `Reactivate ${project.name}`,
        'Cancel this mission',
      ],
      recommendation: null,
      rule: 'R-CL3',
    });
  } else if (project?.status === 'completed') {
    candidates.push({
      id: 'completed_project',
      topic: 'project',
      priority: 1,
      question: `${project.name} is marked complete. Reopen work on it?`,
      why: 'Reopening a finished project should be a decision, not a side effect.',
      options: ['Yes, reopen it', 'No, cancel this mission'],
      recommendation: null,
      rule: 'R-CL4',
    });
  }

  /* 3 — research or implementation? The two produce completely different work. */
  if (isAmbiguousMode(text, mission.type)) {
    candidates.push({
      id: 'mode',
      topic: 'mode',
      priority: 2,
      question: 'Do you want this researched and reported, or actually implemented?',
      why: 'One produces a report and changes nothing; the other produces a branch and a draft pull request.',
      options: ['Research and report only', 'Implement it'],
      recommendation: 'Research and report first, then decide.',
      rule: 'R-CL5',
    });
  }

  /* 4 — which repository, when the project genuinely has more than one. */
  if (
    input.repositoryChoices.length > 1 &&
    !mission.sourceId &&
    !isReadOnlyMissionType(mission.type)
  ) {
    candidates.push({
      id: 'repository',
      topic: 'repository',
      priority: 3,
      question: 'Which repository should the change go in?',
      why: `${project?.name ?? 'This project'} has ${input.repositoryChoices.length} connected repositories.`,
      options: input.repositoryChoices.map((choice) => choice.fullName),
      recommendation: input.repositoryChoices[0]?.fullName ?? null,
      rule: 'R-CL6',
    });
  }

  /* 5 — what does done look like? Only worth asking when there is something to get wrong. */
  if (
    mission.acceptanceCriteria.length === 0 &&
    MISSION_RISK_RANK[mission.riskLevel] >= MISSION_RISK_RANK.moderate &&
    !isReadOnlyMissionType(mission.type)
  ) {
    candidates.push({
      id: 'acceptance',
      topic: 'acceptance',
      priority: 4,
      question: 'How will you know this is done and right?',
      why: 'Jarvis needs a definition of done it can verify, rather than deciding for itself when to stop.',
      options: [],
      recommendation: deriveAcceptanceRecommendation(mission.type),
      rule: 'R-CL7',
    });
  }

  /* 6 — anything that must not change. Asked only where a wrong answer is expensive. */
  if (
    mission.doNotTouch.length === 0 &&
    MISSION_RISK_RANK[mission.riskLevel] >= MISSION_RISK_RANK.high
  ) {
    candidates.push({
      id: 'do_not_touch',
      topic: 'do_not_touch',
      priority: 5,
      question: 'Is there anything in this area Jarvis must not change?',
      why: 'This mission touches something sensitive, so the boundary is worth stating before it runs rather than reviewing afterwards.',
      options: [],
      recommendation: 'Nothing beyond the plan’s stated scope.',
      rule: 'R-CL8',
    });
  }

  /* 7 — a request too short to act on. */
  if (isTooVague(text) && mission.projectId) {
    candidates.push({
      id: 'outcome',
      topic: 'outcome',
      priority: 6,
      question: 'What should be different once this is finished?',
      why: 'The request is short enough that Jarvis would be inventing most of it.',
      options: [],
      recommendation: null,
      rule: 'R-CL9',
    });
  }

  /* 8 — platform, only for an app where it genuinely changes the implementation. */
  if (
    project?.type === 'ios_app' &&
    !isReadOnlyMissionType(mission.type) &&
    !/\b(?:ios|iphone|ipad|swiftui|uikit|watchos|macos)\b/i.test(text)
  ) {
    candidates.push({
      id: 'platform',
      topic: 'platform',
      priority: 7,
      question: 'Which platform target does this apply to?',
      why: 'The worker cannot build an iOS archive on Linux, so Jarvis needs to know what it will honestly be able to verify.',
      options: ['iOS app', 'Shared code only', 'Both'],
      recommendation: 'iOS app',
      rule: 'R-CL10',
    });
  }

  return candidates
    .filter((candidate) => !asked.has(candidate.id))
    .sort((a, b) => a.priority - b.priority)
    .slice(0, MAX_QUESTIONS)
    .map(({ priority: _priority, ...question }) => question);
}

function isAmbiguousMode(text: string, type: MissionType): boolean {
  if (isReadOnlyMissionType(type)) return false;
  const researchy =
    /\b(?:research|investigate|explore|look into|find out|see whether|evaluate|compare)\b/i;
  const buildy = /\b(?:add|implement|build|create|write|fix|ship)\b/i;
  return researchy.test(text) && buildy.test(text);
}

function isTooVague(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length >= 40) return false;
  const words = trimmed.split(/\s+/).filter(Boolean);
  return words.length <= 5;
}

function deriveAcceptanceRecommendation(type: MissionType): string {
  switch (type) {
    case 'bug_fix':
      return 'A test that fails before the change and passes after it, with the existing suite still green.';
    case 'test_improvement':
      return 'New tests covering the described behaviour, with the whole suite green.';
    case 'documentation':
      return 'The documentation describes the current behaviour accurately, and existing checks still pass.';
    case 'repository_maintenance':
      return 'Dependencies updated with the build, lint and test suite all green.';
    default:
      return 'The described behaviour works end to end, with tests covering it and the existing suite still green.';
  }
}

/** Is the mission ready to plan? */
export function isReadyToPlan(questions: readonly ClarificationQuestion[]): boolean {
  return questions.length === 0;
}

/**
 * How the project's own state changes what Jarvis will do with a mission.
 *
 * Returned as data so the same verdict drives the API, the UI copy and the tests.
 */
export interface ProjectGate {
  readonly canPlan: boolean;
  readonly canExecute: boolean;
  readonly requiresOverride: boolean;
  readonly notice: string | null;
  readonly rule: string | null;
}

export function assessProjectGate(
  project: { status: ProjectStatus; archived: boolean; name: string } | null,
  riskLevel: MissionRiskLevel,
): ProjectGate {
  if (!project) {
    return {
      canPlan: false,
      canExecute: false,
      requiresOverride: false,
      notice: 'Choose a project before Jarvis plans anything.',
      rule: 'R-PG0',
    };
  }
  if (project.archived || project.status === 'archived') {
    return {
      canPlan: false,
      canExecute: false,
      requiresOverride: false,
      notice: `${project.name} is archived. Restore it before Jarvis works on it.`,
      rule: 'R-PG1',
    };
  }
  if (riskLevel === 'prohibited') {
    return {
      canPlan: false,
      canExecute: false,
      requiresOverride: false,
      notice: 'This request is prohibited, so Jarvis will not plan it either.',
      rule: 'R-PG2',
    };
  }
  if (project.status === 'paused') {
    return {
      canPlan: true,
      canExecute: false,
      requiresOverride: true,
      notice: `${project.name} is paused. Jarvis can plan this, but running it needs a deliberate one-time override or reactivating the project.`,
      rule: 'R-PG3',
    };
  }
  if (project.status === 'completed') {
    return {
      canPlan: true,
      canExecute: false,
      requiresOverride: true,
      notice: `${project.name} is marked complete. Confirm you want to reopen work on it before this runs.`,
      rule: 'R-PG4',
    };
  }
  if (project.status === 'blocked') {
    return {
      canPlan: true,
      canExecute: true,
      requiresOverride: false,
      notice: `${project.name} has an active blocker. Jarvis will plan this mission, but it does not assume the mission resolves the blocker.`,
      rule: 'R-PG5',
    };
  }
  if (project.status === 'unknown') {
    return {
      canPlan: true,
      canExecute: true,
      requiresOverride: false,
      notice: `Jarvis has no recorded status for ${project.name}, so it is planning with less context than usual.`,
      rule: 'R-PG6',
    };
  }
  return { canPlan: true, canExecute: true, requiresOverride: false, notice: null, rule: null };
}
