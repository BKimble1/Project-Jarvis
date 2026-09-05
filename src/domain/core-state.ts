/**
 * What the intelligence core is doing, and what that is allowed to mean.
 *
 * ## Why this is a domain module
 *
 * Because the core is the most persuasive thing on the screen, and a persuasive animation that
 * says "working" when nothing is working is a lie told beautifully. The mapping from real system
 * state to visual state therefore lives here, next to the rest of the deterministic layer, with
 * its own tests — not inside a canvas renderer where nobody would ever look for it.
 *
 * ## The two axes that must not collapse
 *
 * Conversation and background work are independent. Jarvis can be speaking while three agents run,
 * and it can be silent while nothing runs. A single enum would force one to erase the other, so
 * `coreState` takes both and resolves them by *precedence* — and the precedence is chosen so the
 * thing a person most needs to know wins:
 *
 *  1. **Disconnected** beats everything. A beautiful idle animation on a deployment that cannot run
 *     anything is the single most misleading thing this screen could do.
 *  2. **Conversation** beats background work, because it is the thing the person is doing *right
 *     now* and they are waiting on its feedback. Background work does not disappear — it keeps its
 *     own accent ring and its own count, which is why the renderer takes `activity` separately.
 *  3. **Attention** beats routine working, because it is the state that needs a person.
 *  4. Everything else is the calm case.
 */

export const CORE_STATES = [
  /** Idle and available. Slow movement, gentle breathing glow. */
  'ready',
  /** The microphone is genuinely open. Never shown otherwise. */
  'listening',
  /** A real request is in flight. */
  'thinking',
  /** Speech synthesis is genuinely playing. */
  'speaking',
  /** Agents are actually running work. */
  'working',
  /** Something needs the owner. */
  'attention',
  /** Capacity withheld, or Jarvis paused. Quieter motion. */
  'limited',
  /** Nothing can run. Unmistakable. */
  'disconnected',
  /** One brief accent after something finished, then back to the truth. */
  'complete',
] as const;
export type CoreState = (typeof CORE_STATES)[number];

/** The short line under the core. Must be true of the state it accompanies. */
export const CORE_STATE_LABELS: Record<CoreState, string> = {
  ready: 'Ready when you are.',
  listening: 'Listening.',
  thinking: 'Thinking.',
  speaking: 'Speaking.',
  working: 'Working.',
  attention: 'Waiting for you.',
  limited: 'Holding back.',
  disconnected: 'Not connected.',
  complete: 'Done.',
};

/**
 * Which accent colour a state carries.
 *
 * Colour is never the only carrier — every state also changes the label and the motion — but it is
 * the one that reads from across a room, so it is defined once rather than per component.
 */
export const CORE_STATE_TONE: Record<CoreState, 'blue' | 'cyan' | 'amber' | 'red' | 'green'> = {
  ready: 'blue',
  listening: 'cyan',
  thinking: 'blue',
  speaking: 'cyan',
  working: 'blue',
  attention: 'amber',
  limited: 'amber',
  disconnected: 'red',
  complete: 'green',
};

export interface CoreInput {
  /** True only while the microphone is genuinely open. */
  readonly listening: boolean;
  /** True only while a real request is in flight. */
  readonly thinking: boolean;
  /** True only while speech synthesis is genuinely playing. */
  readonly speaking: boolean;
  /** How many missions are actually running. Zero is zero, never "probably something". */
  readonly workingCount: number;
  /** True when something is genuinely waiting on the owner. */
  readonly needsOwner: boolean;
  /** True when the governor is withholding capacity, or Jarvis is paused or off. */
  readonly limited: boolean;
  /** True when nothing can run: no worker, or the loop has stopped. */
  readonly disconnected: boolean;
  /** Set briefly after something really finished. */
  readonly justCompleted: boolean;
}

/**
 * Resolve the one state the core should show.
 *
 * Ordered by what a person most needs to know, not by what looks best. See the header for why
 * disconnected wins outright and why conversation outranks background work.
 */
export function coreState(input: CoreInput): CoreState {
  if (input.disconnected) return 'disconnected';
  if (input.listening) return 'listening';
  if (input.thinking) return 'thinking';
  if (input.speaking) return 'speaking';
  if (input.justCompleted) return 'complete';
  if (input.limited) return 'limited';
  if (input.needsOwner) return 'attention';
  if (input.workingCount > 0) return 'working';
  return 'ready';
}

/**
 * The sentence beside the core.
 *
 * Prefers the specific truth over the generic label: "Working on 2 missions" says more than
 * "Working", and "Waiting for Claude capacity" says more than "Holding back". Falls back to the
 * label only when there is nothing more specific that is also true.
 */
export function coreStatusLine(
  state: CoreState,
  input: {
    readonly workingCount: number;
    readonly waitingCount: number;
    readonly limitReason: string | null;
    readonly disconnectedReason: string | null;
  },
): string {
  switch (state) {
    case 'disconnected':
      return input.disconnectedReason ?? CORE_STATE_LABELS.disconnected;
    case 'limited':
      return input.limitReason ?? CORE_STATE_LABELS.limited;
    case 'working':
      return `Working on ${input.workingCount} mission${input.workingCount === 1 ? '' : 's'}.`;
    case 'attention':
      return input.waitingCount > 0
        ? `${input.waitingCount} thing${input.waitingCount === 1 ? '' : 's'} waiting for you.`
        : CORE_STATE_LABELS.attention;
    default:
      return CORE_STATE_LABELS[state];
  }
}

/**
 * How the core moves in each state.
 *
 * Numbers rather than class names, because the renderer interpolates between them — a state change
 * that snapped would look like a bug rather than like a response. `spin` is revolutions per second
 * for the outermost ring; everything else is derived from it so the rings never desynchronise into
 * a mess.
 *
 * `agitation` is how much the particle field departs from its resting sphere. It is the one knob
 * that must stay small: a core that boils looks broken, not busy.
 */
export interface CoreMotion {
  readonly spin: number;
  readonly glow: number;
  readonly agitation: number;
  /** How much a real level signal is allowed to move the core, 0 when there is none to trust. */
  readonly reactivity: number;
}

/*
 * The quiet states are quiet, not dark.
 *
 * An earlier pass had `disconnected` at 0.18 and it looked like a rendering fault rather than a
 * state: the core all but vanished, which reads as "this screen is broken", not as "nothing can
 * run". A deployment with no worker is still Jarvis, still on the wall, and still has to say what
 * is wrong legibly from across the room — so the floor is set where the geometry stays readable
 * and the *difference* between states is carried by how much the core moves and by its colour.
 */
export const CORE_MOTION: Record<CoreState, CoreMotion> = {
  ready: { spin: 0.012, glow: 0.7, agitation: 0.05, reactivity: 0 },
  listening: { spin: 0.02, glow: 0.95, agitation: 0.14, reactivity: 1 },
  thinking: { spin: 0.055, glow: 0.85, agitation: 0.22, reactivity: 0 },
  speaking: { spin: 0.024, glow: 1, agitation: 0.16, reactivity: 0.8 },
  working: { spin: 0.018, glow: 0.8, agitation: 0.09, reactivity: 0 },
  attention: { spin: 0.01, glow: 0.75, agitation: 0.06, reactivity: 0 },
  limited: { spin: 0.005, glow: 0.5, agitation: 0.03, reactivity: 0 },
  disconnected: { spin: 0.002, glow: 0.42, agitation: 0.01, reactivity: 0 },
  complete: { spin: 0.016, glow: 1, agitation: 0.12, reactivity: 0 },
};
