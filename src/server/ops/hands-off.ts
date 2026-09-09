import {
  APPROVAL_POLICY_KEY,
  parseApprovalPolicy,
  type ApprovalPolicy,
} from '@/domain/approval-policy';
import { ConflictError } from '@/domain/errors';
import { modeGrantsStandingAuthority, type OperatingMode } from '@/domain/operating-mode';
import { handsOffGaps, isHandsOff } from '@/domain/operating-posture';
import type { Services } from '@/server/container';

/**
 * One switch, two records.
 *
 * ## Why this is a module rather than two calls from a route
 *
 * Hands-off is standing authority *and* automatic plan approval — see `operating-posture.ts` for
 * why either alone is the half-delegated arrangement the owner complained about. That means the
 * interface has one switch and the database has two rows, and the moment those two are written by
 * whichever caller remembered to do both, they will come apart. When they do, the dashboard says
 * Hands-off and the work stops at a plan screen overnight, which is the exact failure this is
 * meant to end.
 *
 * So both writes live here, in one function, with one audit entry that says what the owner
 * actually asked for.
 *
 * ## What it deliberately does not do
 *
 * Widen anything else. Turning Hands-off on pre-authorises **no** category: deleting, merging,
 * releasing, deploying, spending, messaging people, changing credentials and leaving the workspace
 * all still stop and ask, and this function does not touch that list in either direction. An owner
 * who wants one of those pre-authorised chooses it deliberately on the policy screen, having read
 * the sentence that says what it permits.
 *
 * Turning it *off* likewise leaves the categories alone. It narrows the mode and stops automatic
 * plan approval; anything else the owner set stays set, because a switch that quietly reset his
 * other choices would be one he stopped trusting.
 */

export interface HandsOffStatus {
  readonly on: boolean;
  readonly mode: OperatingMode;
  readonly policy: ApprovalPolicy;
  /** What is missing, in the owner's words. Empty when Hands-off is on. */
  readonly gaps: readonly string[];
  /**
   * Whether the owner could turn it on right now, and what is wrong if not.
   *
   * Separate from `gaps`: a gap is a switch that is off, and this is a precondition the owner
   * cannot satisfy by pressing the switch. Standing authority needs a charter in force, and a
   * button that failed with a validation error would be a worse way to learn that.
   */
  readonly canEnable: boolean;
  readonly blockedReason: string | null;
}

type HandsOffServices = Pick<Services, 'charterService' | 'settings'>;

export async function handsOffStatus(services: HandsOffServices): Promise<HandsOffStatus> {
  const [authority, stored] = await Promise.all([
    services.charterService.authority(),
    services.settings.get(APPROVAL_POLICY_KEY),
  ]);
  const policy = parseApprovalPolicy(stored);

  /*
   * A charter in force is the precondition, and it is the charter service that decides what "in
   * force" means — active, unexpired, and pointed at by the operator row. Re-deciding it here
   * would produce a second answer to a question with a correct one.
   */
  const hasCharter = authority.charter !== null;

  return {
    on: isHandsOff(authority.mode, policy),
    mode: authority.mode,
    policy,
    gaps: handsOffGaps(authority.mode, policy),
    canEnable: hasCharter,
    blockedReason: hasCharter
      ? null
      : 'Jarvis needs a charter in force before it can act on its own. Write one in Operations, activate it, and this becomes available.',
  };
}

/**
 * Turn Hands-off on or off, as one owner decision.
 *
 * The mode moves first and the policy second, because that ordering is the safe one in both
 * directions. Turning **on**, a failure between the two leaves standing authority granted and
 * plans still stopping for approval — cautious. Turning **off**, the mode narrows first, so a
 * failure leaves Jarvis unable to start anything new regardless of what the policy says. Neither
 * half-applied state is one where Jarvis does more than the owner asked for.
 */
export async function setHandsOff(
  services: HandsOffServices,
  input: { readonly on: boolean; readonly changedBy: string; readonly reason?: string },
): Promise<HandsOffStatus> {
  const before = await handsOffStatus(services);
  const reason =
    input.reason ?? (input.on ? 'Hands-off mode turned on.' : 'Hands-off mode turned off.');

  const move = async (to: OperatingMode): Promise<void> => {
    await services.charterService.setMode({
      to,
      actor: 'owner',
      changedBy: input.changedBy,
      reason,
    });
  };

  if (input.on) {
    if (!before.canEnable) {
      throw new ConflictError(before.blockedReason ?? 'Hands-off is not available yet.', {
        mode: before.mode,
      });
    }

    /*
     * The emergency stop is not something a settings switch may lift.
     *
     * It exists to be the one control an alarmed person can rely on, and a control that a
     * different screen can undo is not that. Clearing it is its own deliberate act, in the place
     * where it was pressed.
     */
    if (before.mode === 'emergency_stop') {
      throw new ConflictError(
        'Jarvis is under an emergency stop. Clear it in Operations before turning Hands-off on.',
        { mode: before.mode },
      );
    }

    /*
     * `off → operator` is not a move the transition table has, and deliberately: it is two
     * decisions — start watching at all, and then act without asking — and the table refuses to
     * let one click be read as both. Walking through `supervised` makes the same two decisions
     * explicitly, and each is recorded, so the audit shows what actually happened rather than a
     * jump that never existed.
     */
    if (before.mode === 'off') await move('supervised');
    if (!modeGrantsStandingAuthority(before.mode) || before.mode === 'off') await move('operator');
  } else if (modeGrantsStandingAuthority(before.mode)) {
    /*
     * Narrow only when there is something to narrow.
     *
     * Turning Hands-off off while Jarvis is already paused, off or emergency-stopped must not
     * *widen* it back up to supervised — the owner asked for less, and giving him more because a
     * switch had one target mode written into it would be a genuinely dangerous convenience.
     */
    await move('supervised');
  }

  await services.settings.set(APPROVAL_POLICY_KEY, {
    ...before.policy,
    autoApproveRoutinePlans: input.on,
  } satisfies ApprovalPolicy);

  return handsOffStatus(services);
}
