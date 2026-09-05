import {
  RATE_WINDOWS,
  RATE_WINDOW_LABELS,
  OBSERVATION_QUALITY_LABELS,
  decideCapacity,
  hasSubscriptionWindows,
  mergeAccountLimits,
  type AccountCapacity,
  type CapacityView,
  type CapacityWindowView,
} from '@/domain/claude-capacity';
import type { Services } from '@/server/container';

/**
 * What an owner is shown about their Claude capacity.
 *
 * Assembled once, here, rather than in each page that wants it. Two surfaces render this — the
 * operations page and the wallboard — and a second assembly would eventually round differently,
 * age against a different clock, or forget the provenance label, and the two screens would quietly
 * disagree about the same account.
 *
 * ## The rules this view exists to keep
 *
 * **A percentage always arrives with how it was known.** "Five-hour window: 42% used" and
 * "Five-hour window: 42% used, last known twenty minutes ago" are different statements, and only
 * one of them is a basis for deciding to start something. Every window carries its quality label,
 * and a window with no figure says so in words rather than rendering as an empty bar.
 *
 * **There is no token allowance, because there is no published one.** Anthropic does not expose
 * "tokens remaining on your subscription", so this shows the real percentages and the real
 * per-session token counts and never multiplies one by a guess at the other.
 *
 * **Session context is never account capacity.** It is carried in its own field, labelled as one
 * session, because a session 90% through its context window says nothing about how much
 * subscription is left.
 */

const AUTH_MODE_LABELS: Record<string, string> = {
  subscription: 'Claude subscription',
  api_key: 'Anthropic API key',
  bedrock: 'Amazon Bedrock',
  vertex: 'Google Vertex AI',
  foundry: 'Microsoft Foundry',
  gateway: 'An enterprise gateway',
  unknown: 'Not yet established',
};

export async function buildCapacityView(
  services: Services,
  now = new Date(),
): Promise<CapacityView> {
  const [observations, authority, ticks] = await Promise.all([
    services.workerRepo.capacityObservations(),
    services.charterService.authority(),
    services.operatorService.recentTicks(1),
  ]);

  const account: AccountCapacity = mergeAccountLimits(observations, now);
  const reserve = {
    fiveHourPercent: authority.charter?.content.limits.reserveFiveHourPercent ?? 25,
    sevenDayPercent: authority.charter?.content.limits.reserveSevenDayPercent ?? 20,
  };

  const lastFinished =
    ticks.find((tick) => tick.finishedAt !== null && tick.capacityVerdict) ?? null;

  const decision = decideCapacity(account, reserve, {
    previous: lastFinished?.capacityVerdict ?? null,
  });

  const windows: CapacityWindowView[] = RATE_WINDOWS.map((window) => {
    const observed = account.windows[window].utilisationPercent;
    const resets = account.windows[window].resetsAt;
    return {
      window,
      label: RATE_WINDOW_LABELS[window],
      percentUsed: observed.value,
      /* Computed here rather than in the template, so both surfaces round the same way. */
      remainingPercent: observed.value === null ? null : Math.max(0, 100 - observed.value),
      resetsAt: resets.value,
      quality: observed.quality,
      qualityLabel: OBSERVATION_QUALITY_LABELS[observed.quality],
    };
  });

  return {
    applicable: hasSubscriptionWindows(account.authMode),
    authModeLabel: AUTH_MODE_LABELS[account.authMode] ?? AUTH_MODE_LABELS.unknown!,
    subscriptionType: account.subscriptionType.value,
    windows,
    decision,
    reportingWorkers: account.workerIds.length,
    lastPass:
      lastFinished && lastFinished.capacityVerdict && lastFinished.capacityReason
        ? {
            verdict: lastFinished.capacityVerdict,
            reason: lastFinished.capacityReason,
            at: lastFinished.finishedAt ?? lastFinished.startedAt,
          }
        : null,
  };
}
