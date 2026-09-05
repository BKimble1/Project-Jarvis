import {
  isBlocked,
  READINESS_AREAS,
  READINESS_AREA_LABELS,
  type ReadinessArea,
  type ReadinessCheck,
} from './readiness';

/**
 * First run, in the order somebody would actually do it.
 *
 * ## Why this is not the readiness report with a different heading
 *
 * The readiness report answers "what is wrong?" — an unordered set of facts, correct at any moment,
 * useful when something breaks. Setting a thing up for the first time is a different question:
 * "what do I do next, and how many of these are there?" A list of eleven amber rows answers the
 * first question well and the second not at all, and the difference is why people abandon setup.
 *
 * So the same checks are grouped into steps, ordered by what depends on what, and each step knows
 * whether it is done, blocked, or waiting on the one before it. Nothing new is measured.
 *
 * ## Why nothing here shows a value
 *
 * Not one field carries a credential, a connection string, a token or an environment value — and
 * the reason is not caution, it is that this page is the single most likely thing to be
 * screen-shared while somebody asks for help. It says configured, missing, invalid or unverified,
 * and the check's own `nextAction` says what to do. That is enough to finish setup and not enough
 * to leak anything.
 */

export const SETUP_STEP_IDS = [
  'runtime',
  'database',
  'access',
  'model',
  'worker',
  'github',
  'sandbox',
  'connectors',
  'supervisor',
  'display',
  'qualification',
  'authority',
] as const;
export type SetupStepId = (typeof SETUP_STEP_IDS)[number];

export const SETUP_STEP_STATES = [
  /** Everything in it is verified. */
  'done',
  /** Something in it needs doing, and it is reachable now. */
  'todo',
  /** Something in it needs doing, and it cannot operate at all until it is. */
  'blocking',
  /** Set but unproved. Reachable, and the state most often mistaken for finished. */
  'unverified',
  /** Nothing to do here, and not because it was completed. */
  'not_applicable',
] as const;
export type SetupStepState = (typeof SETUP_STEP_STATES)[number];

export interface SetupStep {
  readonly id: SetupStepId;
  readonly title: string;
  /** One line saying why this step exists. Read before the checks, so it has to stand alone. */
  readonly why: string;
  readonly state: SetupStepState;
  readonly checks: readonly ReadinessCheck[];
  /** The next thing to actually do, taken from the first unfinished check. */
  readonly nextAction: string | null;
}

const TITLES: Record<SetupStepId, { readonly title: string; readonly why: string }> = {
  runtime: {
    title: 'The machine',
    why: 'Node has to be new enough, or nothing else here will behave predictably.',
  },
  database: {
    title: 'Somewhere to remember things',
    why: 'Everything Jarvis knows lives here. A local file is fine; it just has to survive a restart.',
  },
  access: {
    title: 'Signing in',
    why: 'Only you get in, and Jarvis needs to know which address it is reachable at so a phone on the same network can change things rather than only read them.',
  },
  model: {
    title: 'Claude',
    why: 'Without a model Jarvis can still show you everything it knows. It cannot answer in its own words, and it cannot run a mission.',
  },
  worker: {
    title: 'A worker',
    why: 'The control plane never runs an agent. A worker on a machine you own does the work and reports back, which is also what keeps the loop running.',
  },
  github: {
    title: 'GitHub',
    why: 'Reading a repository is how Jarvis knows what is happening. Writing is separate, and separately granted.',
  },
  sandbox: {
    title: 'A repository to practise on',
    why: 'Before Jarvis writes to anything of yours it proves it can, on a repository where being wrong costs nothing.',
  },
  connectors: {
    title: 'What Jarvis can see',
    why: 'Nothing to configure yet beyond repositories. This is here so you can read what it cannot see, which is most things.',
  },
  supervisor: {
    title: 'Keeping it running',
    why: 'One command starts both halves. This says whether anything is actually driving the loop right now.',
  },
  display: {
    title: 'A wallboard',
    why: 'Optional. A screen in another room, with a credential of its own that can only read.',
  },
  qualification: {
    title: 'What it has proved',
    why: 'Jarvis unlocks what it can do by demonstrating it, not by being configured. This is the ladder and where you are on it.',
  },
  authority: {
    title: 'What it may do without asking',
    why: 'A charter you write once, rather than an approval you give every time. Until this exists Jarvis proposes and waits — which is a perfectly good way to run it.',
  },
};

/** Which readiness areas roll up into which step. `authority` has no checks; see below. */
const AREAS: Record<SetupStepId, readonly ReadinessArea[]> = {
  runtime: ['runtime'],
  database: ['database'],
  access: ['access'],
  model: ['model'],
  worker: ['worker'],
  github: ['github'],
  sandbox: ['sandbox'],
  connectors: ['connectors'],
  supervisor: ['supervisor'],
  display: ['display'],
  qualification: ['qualification'],
  authority: [],
};

export interface SetupInput {
  readonly checks: readonly ReadinessCheck[];
  /** Whether a charter is in force. The last step has no readiness check of its own. */
  readonly charterActive: boolean;
  /** What Jarvis is currently allowed to do, for the last step's wording. */
  readonly modeLabel: string;
}

export function buildSetupSteps(input: SetupInput): readonly SetupStep[] {
  return SETUP_STEP_IDS.map((id) => {
    const areas = new Set<ReadinessArea>(AREAS[id]);
    const checks = input.checks.filter((check) => areas.has(check.area));

    if (id === 'authority') {
      return {
        id,
        ...TITLES[id],
        state: input.charterActive ? 'done' : 'todo',
        checks: [],
        nextAction: input.charterActive
          ? null
          : `Jarvis is ${input.modeLabel.toLowerCase()}. Write a charter to let it start work inside limits you set, or leave this and approve each mission yourself.`,
      };
    }

    if (checks.length === 0) {
      return { id, ...TITLES[id], state: 'not_applicable', checks: [], nextAction: null };
    }

    const blocking = checks.find(isBlocked);
    const broken = checks.find((check) => check.state === 'missing' || check.state === 'failed');
    const unproved = checks.find((check) => check.state === 'configured');

    const state: SetupStepState = blocking
      ? 'blocking'
      : broken
        ? 'todo'
        : unproved
          ? 'unverified'
          : 'done';

    return {
      id,
      ...TITLES[id],
      state,
      checks,
      nextAction: (blocking ?? broken ?? unproved)?.nextAction ?? null,
    };
  });
}

/**
 * One line at the top: how far through this is.
 *
 * Counts blocking separately from the rest, because they are not the same kind of unfinished. Four
 * outstanding steps of which none block is a Jarvis you can use today; one outstanding step that
 * blocks is a Jarvis that cannot do anything, and a single "8 of 12" would hide the difference.
 */
export function summariseSetup(steps: readonly SetupStep[]): string {
  const done = steps.filter((step) => step.state === 'done').length;
  const applicable = steps.filter((step) => step.state !== 'not_applicable').length;
  const blocking = steps.filter((step) => step.state === 'blocking').length;

  if (blocking > 0) {
    return `${done} of ${applicable} done. ${blocking} ${blocking === 1 ? 'step stops' : 'steps stop'} Jarvis from doing anything at all — start there.`;
  }
  if (done === applicable) return 'Everything is set up. Nothing here needs you.';
  return `${done} of ${applicable} done. Nothing outstanding stops Jarvis working; each one just lets it do more.`;
}

/** The area label, for a step that shows its checks. Re-exported so the page imports one module. */
export { READINESS_AREA_LABELS, READINESS_AREAS };
