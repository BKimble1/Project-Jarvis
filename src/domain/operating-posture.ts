import {
  modeGrantsStandingAuthority,
  OPERATING_MODE_LABELS,
  type OperatingMode,
} from './operating-mode';
import type { ApprovalPolicy } from './approval-policy';

/**
 * The one word the dashboard uses for what Jarvis is doing with itself.
 *
 * ## Why a fifth vocabulary is not what this is
 *
 * There are already four true things in the record — the operating mode, the approval policy, what
 * is running, and what is in the way — and the screen was showing all four. That is honest and
 * unreadable: the owner's question is "is it getting on with it, or is it waiting for me", and
 * answering it with four pills makes the reader do the join.
 *
 * So this is a *projection*, not a new state. It stores nothing, decides nothing, and can be
 * recomputed from records at any moment. Every posture below is a fact about rows that already
 * exist, and the ordering — which fact wins when several are true — is the only thing this module
 * adds. That ordering is the design, and it is argued for in `derivePosture`.
 *
 * ## Why "Hands-off" is not simply the operator mode
 *
 * Because the owner's complaint was that granting standing authority still left ordinary work
 * parked at a plan screen. Standing authority answers "may Jarvis start work without asking"; the
 * approval policy answers "may it get past the plan without asking". A deployment with the first
 * and not the second is exactly the half-delegated thing that prompted this, and calling it
 * Hands-off on the dashboard would be a lie the owner would only discover the next morning.
 *
 * Hands-off is therefore both, and `handsOffGaps` names each half that is missing so the interface
 * can say which switch is still off rather than merely refusing.
 */

export const OPERATING_POSTURES = [
  'paused',
  'blocked',
  'running',
  'hands_off',
  'supervised',
] as const;
export type OperatingPosture = (typeof OPERATING_POSTURES)[number];

export const POSTURE_LABELS: Record<OperatingPosture, string> = {
  paused: 'Paused',
  blocked: 'Blocked',
  running: 'Running',
  hands_off: 'Hands-off',
  supervised: 'Supervised',
};

/** The colour each posture is drawn in. Green means proceeding, not means healthy. */
export const POSTURE_TONES: Record<OperatingPosture, 'green' | 'amber' | 'red' | 'blue'> = {
  paused: 'amber',
  blocked: 'red',
  running: 'blue',
  hands_off: 'green',
  supervised: 'amber',
};

export interface PostureView {
  readonly posture: OperatingPosture;
  readonly label: string;
  /** One sentence, safe to read aloud, saying what this means for the owner right now. */
  readonly sentence: string;
  readonly tone: 'green' | 'amber' | 'red' | 'blue';
  /**
   * Whether Hands-off is switched on, independently of what the posture is showing.
   *
   * The two come apart constantly and both matter: a Hands-off deployment that is momentarily
   * `running` or `blocked` has not stopped being Hands-off, and an interface that forgot that
   * would tell the owner his setting had been turned off by a failing test.
   */
  readonly handsOff: boolean;
  /** Everything standing in the way, most urgent first. Empty unless the posture is `blocked`. */
  readonly blockers: readonly string[];
}

/**
 * Is Hands-off on?
 *
 * Both halves, deliberately. See the note at the top of this file: either half alone produces a
 * deployment that stops somewhere the owner was told it would not.
 */
export function isHandsOff(mode: OperatingMode, policy: ApprovalPolicy): boolean {
  return modeGrantsStandingAuthority(mode) && policy.autoApproveRoutinePlans;
}

/**
 * What is missing before Hands-off is genuinely on, in the owner's words.
 *
 * Returned as sentences rather than flags because the only caller is a screen explaining a switch,
 * and a screen that says "handsOff: false" has told the owner nothing he can act on.
 */
export function handsOffGaps(mode: OperatingMode, policy: ApprovalPolicy): readonly string[] {
  const gaps: string[] = [];
  if (!modeGrantsStandingAuthority(mode)) {
    gaps.push(
      `I am ${OPERATING_MODE_LABELS[mode].toLowerCase()}, so I wait for you before starting work.`,
    );
  }
  if (!policy.autoApproveRoutinePlans) {
    gaps.push('Routine plans still stop for your approval before I build anything.');
  }
  return gaps;
}

/**
 * The posture, and the sentence that explains it.
 *
 * ## The ordering, and why it is this one
 *
 * Several of these are true at once almost always — a Hands-off deployment with a mission running
 * and a stalled loop is all three — so the ordering decides what the owner reads. It goes:
 *
 * 1. **Paused** first, because it is the owner's own deliberate choice. Reporting a paused Jarvis
 *    as `blocked` because no worker is running would be technically true and useless: of course
 *    nothing is running, he stopped it. His own decision outranks a consequence of it.
 * 2. **Blocked** next, because it is the only posture that is a request for help. A screen that
 *    said `running` while the loop had stalled would be the specific failure this redesign exists
 *    to remove — a green light over a broken thing.
 * 3. **Running** next, because "something is happening" is a better answer than "the setting is
 *    Hands-off" to a person looking at the screen to find out what is happening.
 * 4. **Hands-off** or **Supervised** last: the resting posture, shown when there is nothing more
 *    specific to say.
 *
 * ## Why `blockers` is passed in
 *
 * Because what counts as blocked is a question about the whole deployment — workers, the loop,
 * capacity, decisions awaiting the owner — and every one of those already has a module that
 * decides it honestly. Re-deriving them here would produce a second opinion, and the failure mode
 * of a second opinion about "is anything wrong" is that the cheerful one wins.
 */
export function derivePosture(input: {
  readonly mode: OperatingMode;
  readonly policy: ApprovalPolicy;
  readonly runningCount: number;
  /** Sentences describing what is stopping work. Owner choices do not belong here. */
  readonly blockers: readonly string[];
  /** Decisions the owner has to make before something can continue. */
  readonly waitingOnOwner: number;
}): PostureView {
  const handsOff = isHandsOff(input.mode, input.policy);
  const view = (
    posture: OperatingPosture,
    sentence: string,
    blockers: readonly string[] = [],
  ): PostureView => ({
    posture,
    label: POSTURE_LABELS[posture],
    sentence,
    tone: POSTURE_TONES[posture],
    handsOff,
    blockers,
  });

  if (input.mode === 'paused' || input.mode === 'off' || input.mode === 'emergency_stop') {
    return view(
      'paused',
      input.mode === 'emergency_stop'
        ? 'Everything that can be stopped safely is stopped. You cleared it, and only you can start it again.'
        : `I am ${OPERATING_MODE_LABELS[input.mode].toLowerCase()} and will not begin anything new.`,
    );
  }

  if (input.blockers.length > 0) {
    return view(
      'blocked',
      input.blockers.length === 1
        ? input.blockers[0]!
        : `${input.blockers[0]!} There ${input.blockers.length === 2 ? 'is one other thing' : `are ${input.blockers.length - 1} other things`} in the way.`,
      input.blockers,
    );
  }

  if (input.waitingOnOwner > 0 && input.runningCount === 0) {
    /*
     * Waiting for a person is a block, but a different kind: nothing is wrong, and the thing that
     * fixes it is the owner reading one screen. It only takes precedence when nothing else is
     * happening — a decision waiting alongside three running missions is not what "blocked" means.
     */
    return view(
      'blocked',
      input.waitingOnOwner === 1
        ? 'One decision is waiting for you.'
        : `${input.waitingOnOwner} decisions are waiting for you.`,
      [
        input.waitingOnOwner === 1
          ? 'One decision is waiting for you.'
          : `${input.waitingOnOwner} decisions are waiting for you.`,
      ],
    );
  }

  if (input.runningCount > 0) {
    return view(
      'running',
      input.runningCount === 1
        ? 'One piece of work is running.'
        : `${input.runningCount} pieces of work are running.`,
    );
  }

  if (handsOff) {
    return view(
      'hands_off',
      'I carry routine work through on my own and ask you only about the things you kept.',
    );
  }

  return view(
    'supervised',
    'I propose the work and wait for you to approve it before building anything.',
  );
}
