import type { CapacityView } from '@/domain/claude-capacity';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { RelativeTime } from '@/components/relative-time';

/**
 * How much Claude is left, and how sure Jarvis is about it.
 *
 * The whole design problem here is a number that looks more certain than it is. A bar at 42% reads
 * as a measurement whatever the caption says, so a window Jarvis could not read renders as a
 * sentence rather than as an empty bar, and every figure that *is* rendered carries how it was
 * known — measured, last known, or a guess.
 *
 * There is no "tokens remaining" figure anywhere on this card, because Anthropic does not publish
 * one. Multiplying a percentage by a guess at a plan size would produce the most convincing number
 * on the page and the only entirely invented one.
 */
export function ClaudeCapacity({ view }: { view: CapacityView }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">Claude capacity</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 pt-0">
        {view.applicable ? (
          <dl className="flex flex-col gap-2">
            {view.windows.map((window) => (
              <div key={window.window} className="flex flex-col gap-1">
                <div className="flex items-baseline justify-between gap-2 text-sm">
                  <dt className="text-[var(--color-text-muted)]">{window.label}</dt>
                  <dd className="font-medium tabular-nums">
                    {window.percentUsed === null ? (
                      /* Words, not an empty bar. An unread window must not look like an empty one. */
                      <span className="text-[var(--color-text-muted)]">Not readable</span>
                    ) : (
                      `${Math.round(window.remainingPercent ?? 0)}% left`
                    )}
                  </dd>
                </div>
                {window.percentUsed === null ? null : (
                  <div
                    className="h-1.5 w-full overflow-hidden rounded-full bg-[var(--color-surface-muted)]"
                    role="img"
                    aria-label={`${window.label}: ${Math.round(window.percentUsed)}% used`}
                  >
                    <div
                      className="h-full rounded-full bg-[var(--color-accent-text)]"
                      style={{ width: `${Math.min(100, Math.max(0, window.percentUsed))}%` }}
                    />
                  </div>
                )}
                <p className="text-xs text-[var(--color-text-muted)]">
                  {window.qualityLabel}
                  {window.resetsAt ? (
                    <>
                      {' · resets '}
                      <RelativeTime iso={window.resetsAt} />
                    </>
                  ) : null}
                </p>
              </div>
            ))}
          </dl>
        ) : (
          <p className="text-sm text-[var(--color-text-muted)]">
            {view.authModeLabel === 'Not yet established'
              ? 'No worker has reported which Claude credential it uses yet, so Jarvis is not applying subscription limits it may not have.'
              : `Model work runs on ${view.authModeLabel.toLowerCase()}, which has no shared five-hour or weekly window. Spending limits apply instead.`}
          </p>
        )}

        {/*
         * The sentence an owner is actually looking for on a quiet day: not what the windows say,
         * but what Jarvis decided to do about them.
         */}
        <p className="text-sm">{view.decision.reason}</p>

        {view.lastPass ? (
          <p className="text-xs text-[var(--color-text-muted)]">
            Last pass of the operating loop, <RelativeTime iso={view.lastPass.at} />:{' '}
            {view.lastPass.reason}
          </p>
        ) : (
          <p className="text-xs text-[var(--color-text-muted)]">
            The operating loop has not completed a pass yet. A running worker drives one about once
            a minute.
          </p>
        )}

        <p className="text-xs text-[var(--color-text-muted)]">
          {view.subscriptionType ? `${view.subscriptionType} plan · ` : ''}
          {view.reportingWorkers === 0
            ? 'No worker has managed to read capacity yet.'
            : `Reported by ${view.reportingWorkers} worker${view.reportingWorkers === 1 ? '' : 's'}.`}{' '}
          These are account-wide percentages shared across every machine you are signed in on.
          Jarvis cannot see a token allowance, because Anthropic does not publish one.
        </p>
      </CardContent>
    </Card>
  );
}
