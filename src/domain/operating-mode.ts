import { ConflictError } from './errors';

/**
 * How much Jarvis is currently allowed to do on its own.
 *
 * The charter says *what* Jarvis may do. The mode says *whether it is doing anything at all right
 * now*. They are separate because they change on different timescales and for different reasons: a
 * charter is written once and reviewed occasionally, whereas the mode is the switch you reach for
 * when you are about to demo something, or go on holiday, or watch a deployment go wrong.
 *
 * Making the mode part of the charter would mean pausing Jarvis produced a new charter version,
 * which would make the version history — the thing an audit reads to answer "what was it allowed
 * to do in March?" — mostly a record of somebody flicking a switch.
 *
 * ## The modes are ordered, and the order is the meaning
 *
 * Each mode below permits everything the modes above it permit and a little more, with two
 * exceptions that are not on the ladder at all: `paused` and `emergency_stop` are *states you
 * enter from anywhere*, and what they do to work already running is the whole point of them.
 */

export const OPERATING_MODES = [
  /** Nothing at all. Jarvis does not even look. */
  'off',
  /** Look and recommend. Never creates a mission. */
  'observer',
  /** Create mission drafts and wait for the owner on each one. This is Phase 2–4 behaviour. */
  'supervised',
  /** Create and run missions inside the charter, without asking again. */
  'operator',
  /** Finish or safely stop what is running. Begin nothing new. */
  'paused',
  /** Stop everything that can be safely stopped, and revoke autonomous leases. */
  'emergency_stop',
] as const;
export type OperatingMode = (typeof OPERATING_MODES)[number];

export const OPERATING_MODE_LABELS: Record<OperatingMode, string> = {
  off: 'Off',
  observer: 'Observing',
  supervised: 'Supervised',
  operator: 'Operating',
  paused: 'Paused',
  emergency_stop: 'Emergency stop',
};

export const OPERATING_MODE_MEANING: Record<OperatingMode, string> = {
  off: 'Jarvis is not watching anything and will not start work.',
  observer: 'Jarvis watches and tells you what it would do. It creates nothing.',
  supervised: 'Jarvis proposes missions and waits for you to approve each one.',
  operator: 'Jarvis creates and runs missions on its own, inside the charter you authorised.',
  paused: 'Work already running continues or stops safely. Nothing new begins.',
  emergency_stop: 'Everything that can be stopped safely is being stopped.',
};

/** Modes in which the operator loop observes at all. */
export function modeObserves(mode: OperatingMode): boolean {
  return mode === 'observer' || mode === 'supervised' || mode === 'operator';
}

/** Modes in which the operator loop may create a mission — as a draft or to run. */
export function modeMayPropose(mode: OperatingMode): boolean {
  return mode === 'supervised' || mode === 'operator';
}

/**
 * The one mode in which the charter can stand in for an owner's approval.
 *
 * Written as a function rather than an equality check at each call site, so the answer to "when
 * does standing authority apply?" has exactly one definition and a test can pin it there.
 */
export function modeGrantsStandingAuthority(mode: OperatingMode): boolean {
  return mode === 'operator';
}

/** Modes in which work already in flight should be brought to a stop rather than continued. */
export function modeStopsRunningWork(mode: OperatingMode): boolean {
  return mode === 'emergency_stop';
}

/* ------------------------------------------------------------- transitions */

export type ModeActor = 'owner' | 'system';

export interface ModeTransition {
  readonly from: OperatingMode;
  readonly to: OperatingMode;
  readonly actors: readonly ModeActor[];
  /**
   * True when the move increases what Jarvis may do on its own.
   *
   * These are the moves that require a deliberate, authenticated owner action — never a schedule,
   * never a recovery path, and never a model. Everything that *reduces* autonomy is available to
   * the system as well, because a system that cannot stop itself is worse than one that cannot
   * start itself.
   */
  readonly widens: boolean;
  readonly summary: string;
}

const T = (
  from: OperatingMode,
  to: OperatingMode,
  actors: readonly ModeActor[],
  widens: boolean,
  summary: string,
): ModeTransition => ({ from, to, actors, widens, summary });

/**
 * Which moves exist, and who may make them.
 *
 * The asymmetry is deliberate and is the safety property of this table: **every** move toward less
 * autonomy is available from anywhere and to the system; every move toward more autonomy is
 * owner-only. So a stuck, confused or failing Jarvis can always be brought down, and can never
 * bring itself up.
 */
export const MODE_TRANSITIONS: readonly ModeTransition[] = [
  /* Widening. Owner only, every time. */
  T('off', 'observer', ['owner'], true, 'Started watching'),
  T('off', 'supervised', ['owner'], true, 'Started proposing work'),
  T('observer', 'supervised', ['owner'], true, 'Started proposing work'),
  T('supervised', 'operator', ['owner'], true, 'Standing authority granted'),
  T('observer', 'operator', ['owner'], true, 'Standing authority granted'),
  T('paused', 'operator', ['owner'], true, 'Resumed operating'),
  T('paused', 'supervised', ['owner'], true, 'Resumed, supervised'),
  T('paused', 'observer', ['owner'], true, 'Resumed, watching only'),
  T('emergency_stop', 'off', ['owner'], true, 'Cleared the emergency stop'),

  /* Narrowing. Available to the system too, from wherever it is. */
  T('operator', 'supervised', ['owner', 'system'], false, 'Standing authority withdrawn'),
  T('operator', 'observer', ['owner', 'system'], false, 'Reduced to watching'),
  T('operator', 'paused', ['owner', 'system'], false, 'Paused'),
  T('operator', 'off', ['owner', 'system'], false, 'Switched off'),
  T('supervised', 'observer', ['owner', 'system'], false, 'Reduced to watching'),
  T('supervised', 'paused', ['owner', 'system'], false, 'Paused'),
  T('supervised', 'off', ['owner', 'system'], false, 'Switched off'),
  T('observer', 'paused', ['owner', 'system'], false, 'Paused'),
  T('observer', 'off', ['owner', 'system'], false, 'Switched off'),
  T('paused', 'off', ['owner', 'system'], false, 'Switched off'),

  /*
   * The emergency stop, from every mode including itself.
   *
   * Reachable from `emergency_stop` on purpose: pressing it twice is something a worried person
   * does, and it must be a no-op that succeeds rather than an error that makes them wonder whether
   * the first one worked.
   */
  T('off', 'emergency_stop', ['owner', 'system'], false, 'Emergency stop'),
  T('observer', 'emergency_stop', ['owner', 'system'], false, 'Emergency stop'),
  T('supervised', 'emergency_stop', ['owner', 'system'], false, 'Emergency stop'),
  T('operator', 'emergency_stop', ['owner', 'system'], false, 'Emergency stop'),
  T('paused', 'emergency_stop', ['owner', 'system'], false, 'Emergency stop'),
  T('emergency_stop', 'emergency_stop', ['owner', 'system'], false, 'Emergency stop'),
];

const INDEX = new Map<string, ModeTransition>(
  MODE_TRANSITIONS.map((transition) => [`${transition.from}→${transition.to}`, transition]),
);

export function findModeTransition(from: OperatingMode, to: OperatingMode): ModeTransition | null {
  return INDEX.get(`${from}→${to}`) ?? null;
}

export function allowedModeChanges(
  from: OperatingMode,
  actor?: ModeActor,
): readonly OperatingMode[] {
  return MODE_TRANSITIONS.filter(
    (transition) =>
      transition.from === from && (actor === undefined || transition.actors.includes(actor)),
  ).map((transition) => transition.to);
}

/**
 * Validate a mode change.
 *
 * Same shape as `assertTransition` for missions, and the same reasoning: a move that is not in the
 * table cannot happen, and that is a property of the data rather than of whichever caller happened
 * to be careful. Unlike the mission machine there is no same-state no-op exemption except for the
 * emergency stop, because "set it to the mode it is already in" is otherwise a sign the caller has
 * lost track of the state rather than a request worth honouring.
 */
export function assertModeChange(
  from: OperatingMode,
  to: OperatingMode,
  actor: ModeActor,
): ModeTransition {
  const transition = findModeTransition(from, to);
  if (!transition) {
    throw new ConflictError(`Jarvis cannot go from ${from} to ${to}.`, {
      from,
      to,
      allowed: allowedModeChanges(from, actor),
    });
  }
  if (!transition.actors.includes(actor)) {
    throw new ConflictError(
      transition.widens
        ? `Only you can grant Jarvis more autonomy. Going from ${from} to ${to} needs a signed-in owner.`
        : `A ${actor} cannot move Jarvis from ${from} to ${to}.`,
      { from, to, actor },
    );
  }
  return transition;
}
