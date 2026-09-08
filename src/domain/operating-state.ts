/**
 * What Jarvis is doing about one idea, from the sentence that captured it to the thing it produced.
 *
 * ## Why this exists beside the mission state machine
 *
 * Because they answer different questions and one of them was never asked. `MissionState` describes
 * a *mission* — a unit of work that already has a project, a repository and an approved plan. It
 * begins at `draft`, which is already past the point where the interesting failures happen.
 *
 * The owner's question is about an *idea*: he says something, and wants to know where that sentence
 * got to. Between the sentence and the mission there is an evaluation, a question he may have to
 * answer, an approval, and the creation of the project and repository the mission needs — none of
 * which a mission state can express, because the mission does not exist yet for most of it.
 *
 * So this is the outer machine. One row per proposal, from `captured` to `delivered`, carrying the
 * project and mission ids as they come into existence rather than requiring them up front.
 *
 * ## Why every transition is an event with an id
 *
 * Because the dashboard has to read *the record for this idea* rather than the newest record of
 * anything. Two ideas in flight at once — QuickPick and Pomodoro — must never show each other's
 * progress, and "the latest evaluation" is exactly the query that lets them. Every event therefore
 * carries the proposal it belongs to, and the screen asks by proposal.
 *
 * It also makes speaking safe. A spoken update must happen once: not again on the next poll, and
 * not again after a refresh. An event with a stable id and a `spokenAt` watermark can be spoken
 * exactly once by construction; a message derived from current state cannot, because current state
 * is re-derived on every render.
 */

/**
 * The states an idea passes through.
 *
 * The first eight are the ordinary path, in order. The rest are where an idea can stop, and every
 * one of them names a different reason — because "not finished" covers a machine that is waiting
 * for a person, one that has run out of capacity, one the owner paused, and one that failed, and
 * those need four different sentences and four different remedies.
 */
export const OPERATING_STATES = [
  /** The owner said something and it was written down. Nothing has judged it yet. */
  'captured',
  /** A model is deciding what it is and what the smallest useful version would be. */
  'evaluating',
  /** A question was asked whose answer would change the result. Nothing proceeds until it lands. */
  'waiting_for_input',
  /** The owner agreed. This is the state "Go ahead" produces. */
  'approved',
  /** Working out how to build it, and auditing that plan before acting on it. */
  'planning',
  /** Building: workspace, code, tests. */
  'executing',
  /** Checking what was built. */
  'verifying',
  /** Finished, with something to open. */
  'delivered',

  /** Something outside Jarvis is in the way — no worker, no capacity, a failing dependency. */
  'blocked',
  /** A decision only the owner may take: a merge, a deploy, a deletion, a payment. */
  'needs_decision',
  /** The owner stopped it. Deliberate, and not a fault. */
  'paused',
  /** It ended badly and has not been dealt with. */
  'failed',
  /** The owner called it off. */
  'cancelled',
] as const;
export type OperatingState = (typeof OPERATING_STATES)[number];

/** States from which nothing further happens without the owner. */
export const OPERATING_TERMINAL_STATES = ['delivered', 'cancelled'] as const;

/** True when the idea has stopped and is waiting on a person rather than on the machine. */
export function operatingNeedsOwner(state: OperatingState): boolean {
  return state === 'waiting_for_input' || state === 'needs_decision';
}

/** True when the machine is actively carrying the idea forward. */
export function operatingIsActive(state: OperatingState): boolean {
  return (
    state === 'evaluating' || state === 'planning' || state === 'executing' || state === 'verifying'
  );
}

/** A short label for a state, for the screen and for anything spoken. */
export const OPERATING_STATE_LABELS: Record<OperatingState, string> = {
  captured: 'Captured',
  evaluating: 'Evaluating',
  waiting_for_input: 'Waiting for you',
  approved: 'Approved',
  planning: 'Planning',
  executing: 'Building',
  verifying: 'Checking',
  delivered: 'Delivered',
  blocked: 'Blocked',
  needs_decision: 'Needs a decision',
  paused: 'Paused',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

/**
 * What may follow what.
 *
 * Deliberately permissive in one direction and strict in the other: an idea may fall out of the
 * happy path into `blocked`, `needs_decision`, `paused`, `failed` or `cancelled` from anywhere it
 * is still live, because those are things that happen *to* it. Coming back is narrower — a blocked
 * idea resumes where it was blocked, and a failed one is retried rather than continued.
 *
 * The table exists so a wrong move is a caught error rather than a state nobody can explain later.
 */
const INTERRUPTIONS: readonly OperatingState[] = [
  'blocked',
  'needs_decision',
  'paused',
  'failed',
  'cancelled',
];

const FORWARD: Record<OperatingState, readonly OperatingState[]> = {
  captured: ['evaluating', 'waiting_for_input', 'approved'],
  /* An evaluation can end in a question, in agreement, or in nothing more being needed. */
  evaluating: ['waiting_for_input', 'captured', 'approved'],
  waiting_for_input: ['evaluating', 'approved', 'captured'],
  approved: ['planning'],
  planning: ['executing', 'approved'],
  executing: ['verifying', 'planning'],
  verifying: ['delivered', 'executing'],
  delivered: [],
  /* Coming back from an interruption returns to the phase that was interrupted. */
  blocked: ['evaluating', 'planning', 'executing', 'verifying', 'approved', 'captured'],
  needs_decision: ['approved', 'planning', 'executing', 'verifying', 'evaluating'],
  paused: ['evaluating', 'planning', 'executing', 'verifying', 'approved', 'captured'],
  failed: ['planning', 'executing', 'verifying', 'evaluating', 'captured'],
  cancelled: [],
};

/** Every state this one may move to, interruptions included. */
export function allowedOperatingStates(from: OperatingState): readonly OperatingState[] {
  if (from === 'delivered' || from === 'cancelled') return [];
  const forward = FORWARD[from] ?? [];
  return [...forward, ...INTERRUPTIONS.filter((state) => state !== from)];
}

export function canMoveOperatingState(from: OperatingState, to: OperatingState): boolean {
  /* Re-entering the state you are in is a no-op rather than an error: a repeated report is not a bug. */
  if (from === to) return true;
  return allowedOperatingStates(from).includes(to);
}

/**
 * What an event is for.
 *
 * `transition` is the machine moving. `progress` is a sentence about work inside a state that the
 * owner would want to hear without the state changing. `question` needs him. `result` is the thing
 * he was waiting for. They are separated because they are spoken with different urgency and the
 * screen groups them differently — not because the message is built differently.
 */
export const OPERATING_EVENT_KINDS = ['transition', 'progress', 'question', 'result'] as const;
export type OperatingEventKind = (typeof OPERATING_EVENT_KINDS)[number];

export interface OperatingEvent {
  /** Stable, and the thing "speak this once" is keyed on. */
  readonly id: string;
  readonly proposalId: string;
  readonly projectId: string | null;
  readonly missionId: string | null;
  readonly kind: OperatingEventKind;
  readonly fromState: OperatingState | null;
  readonly toState: OperatingState;
  /**
   * The exact words.
   *
   * One string, shown in the transcript and spoken aloud unchanged. The requirement that the
   * question the owner hears is the question he reads is met by there being nothing to keep in
   * step: there is one sentence, stored once.
   */
  readonly message: string;
  /** Set the moment it is spoken, so a reload does not say it again. */
  readonly spokenAt: string | null;
  readonly createdAt: string;
}

export interface OperatingSnapshot {
  readonly id: string;
  readonly proposalId: string;
  readonly state: OperatingState;
  readonly projectId: string | null;
  readonly missionId: string | null;
  /** Why it stopped, when it has. One sentence, the owner's words for it. */
  readonly detail: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}
