'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';

import {
  OPERATING_MODE_LABELS,
  OPERATING_MODE_MEANING,
  type OperatingMode,
} from '@/domain/operating-mode';
import type { SupervisorHealth } from '@/domain/supervisor-health';
import { Button } from '@/components/ui/button';
import { RelativeTime } from '@/components/relative-time';

/**
 * Is Jarvis running, when did it last look, and the one switch that stops it.
 *
 * ## Why the pause lives here and not on the charter page
 *
 * The charter answers "what is Jarvis allowed to do", which is a decision somebody makes once and
 * revisits occasionally. This answers "is it doing it right now", which is the question somebody
 * asks in a hurry — and the switch has to be next to the answer, because a person reaching for
 * the brake should not first have to find the page it is on.
 *
 * ## Why resuming is one button
 *
 * It returns to exactly the mode the pause was entered from, which the control plane recorded when
 * the pause was made. Offering a menu at that moment would be asking somebody to re-decide
 * something they already decided, at the worst time to be asked.
 */
export function SupervisorPanel({
  health,
  mode,
  pausedFrom,
  changedAt,
}: {
  health: SupervisorHealth;
  mode: OperatingMode;
  pausedFrom: OperatingMode | null;
  changedAt: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const paused = mode === 'paused' || mode === 'emergency_stop' || mode === 'off';
  const resumeTo: OperatingMode = pausedFrom ?? 'supervised';

  async function setMode(next: OperatingMode, reason: string) {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch('/api/operator/mode', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mode: next, reason }),
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as {
          error?: { message?: string };
        };
        setError(payload.error?.message ?? 'That did not work.');
        return;
      }
      router.refresh();
    } catch {
      setError('Could not reach Jarvis.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className={`text-sm font-medium ${toneClass(health.state)}`}>
          {STATE_LABELS[health.state]}
        </span>
        <span className="text-xs text-[var(--color-text-muted)]">{health.explanation}</span>
      </div>

      <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs sm:grid-cols-3">
        <Field label="Mode">
          {OPERATING_MODE_LABELS[mode]} · <RelativeTime iso={changedAt} />
        </Field>
        <Field label="Last pass">
          {health.lastTickAt ? <RelativeTime iso={health.lastTickAt} /> : 'never'}
        </Field>
        <Field label="Next pass due">
          {health.nextExpectedAt ? (
            <RelativeTime iso={health.nextExpectedAt} />
          ) : (
            'not enough passes to say'
          )}
        </Field>
      </dl>

      {health.lastSummary ? (
        <p className="text-xs text-[var(--color-text-muted)]">
          Last pass said: {health.lastSummary}
        </p>
      ) : null}

      {health.lastError ? (
        <p className="rounded-[var(--radius-card)] bg-[var(--color-critical-soft)] px-3 py-2 text-xs text-[var(--color-critical-text)]">
          Last error (<RelativeTime iso={health.lastError.at} />
          ): {health.lastError.summary}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-2 border-t border-[var(--color-border)] pt-3">
        {paused ? (
          <>
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() => void setMode(resumeTo, 'Resumed from Operations.')}
            >
              {busy ? 'Resuming…' : `Resume ${OPERATING_MODE_LABELS[resumeTo].toLowerCase()}`}
            </Button>
            <span className="text-xs text-[var(--color-text-muted)]">
              {OPERATING_MODE_MEANING[mode]}
            </span>
          </>
        ) : (
          <>
            <Button
              variant="danger"
              disabled={busy}
              onClick={() => void setMode('paused', 'Paused from Operations.')}
            >
              {busy ? 'Pausing…' : 'Pause Jarvis'}
            </Button>
            <span className="text-xs text-[var(--color-text-muted)]">
              Work already running finishes or stops safely. Nothing new begins, and you can still
              ask it things.
            </span>
          </>
        )}
      </div>

      {error ? <p className="text-xs text-[var(--color-critical-text)]">{error}</p> : null}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col">
      <dt className="text-[var(--color-text-subtle)]">{label}</dt>
      <dd className="text-[var(--color-text)]">{children}</dd>
    </div>
  );
}

const STATE_LABELS: Record<SupervisorHealth['state'], string> = {
  never_run: 'Never run',
  healthy: 'Running',
  late: 'Late',
  stalled: 'Not running',
  failing: 'Failing',
};

function toneClass(state: SupervisorHealth['state']): string {
  if (state === 'healthy') return 'text-[var(--color-text)]';
  if (state === 'late') return 'text-[var(--color-caution-text)]';
  return 'text-[var(--color-critical-text)]';
}
