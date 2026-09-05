'use client';

import * as React from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/cn';
import {
  READINESS_AREAS,
  READINESS_AREA_LABELS,
  READINESS_STATE_LABELS,
  type ReadinessCheck,
  type ReadinessReport,
  type ReadinessState,
} from '@/domain/readiness';

/**
 * The same report `npm run doctor` prints, on the screen.
 *
 * ## Why it is a button rather than part of the page
 *
 * The full report walks the qualification ladder, which reaches GitHub and asks every worker what
 * it can do. That is the right cost for a diagnostic somebody deliberately runs and the wrong cost
 * for a page that renders on every visit — an Operations page that took thirty seconds to load
 * would be an Operations page nobody opens when something is wrong. So the expensive answer is
 * asked for, and the cheap facts an owner needs constantly (is a worker connected, what rung is
 * this) are already above.
 *
 * ## The one thing this must not do
 *
 * Round `configured` up to a tick. It means a value is present and *nothing has confirmed it
 * works* — the state most likely to be mistaken for readiness, and the reason it is drawn in its
 * own colour with its own label rather than sharing the green. Everything not working keeps its
 * next action visible, including `configured`, because "it is set but unproved" is precisely the
 * state whose next step someone needs.
 */

const STATE_STYLE: Record<ReadinessState, { chip: string; text: string }> = {
  verified: {
    chip: 'bg-[var(--color-positive-soft)] text-[var(--color-positive-text)]',
    text: 'text-[var(--color-text)]',
  },
  configured: {
    chip: 'bg-[var(--color-caution-soft)] text-[var(--color-caution-text)]',
    text: 'text-[var(--color-text)]',
  },
  missing: {
    chip: 'bg-[var(--color-surface-strong)] text-[var(--color-text-muted)]',
    text: 'text-[var(--color-text-muted)]',
  },
  failed: {
    chip: 'bg-[var(--color-critical-soft)] text-[var(--color-critical-text)]',
    text: 'text-[var(--color-critical-text)]',
  },
};

export function ReadinessPanel() {
  const [report, setReport] = React.useState<ReadinessReport | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function run() {
    setBusy(true);
    setError(null);
    try {
      /* POST, not GET: the unauthenticated GET on this route answers one fact and nothing else. */
      const response = await fetch('/api/health', { method: 'POST' });
      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as {
          error?: { message?: string };
        };
        setError(payload.error?.message ?? 'The checks could not run.');
        return;
      }
      const payload = (await response.json()) as { readiness: ReadinessReport };
      setReport(payload.readiness);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The checks could not run.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-[var(--color-text-muted)]">
          {report
            ? report.summary
            : 'Every setting Jarvis needs, checked against what actually answers. The same checks as npm run doctor.'}
        </p>
        <Button size="sm" variant="secondary" onClick={() => void run()} disabled={busy}>
          {busy ? 'Checking…' : report ? 'Check again' : 'Run the checks'}
        </Button>
      </div>

      {error ? (
        <p className="rounded-[var(--radius-card)] bg-[var(--color-critical-soft)] px-3 py-2 text-sm text-[var(--color-critical-text)]">
          {error}
        </p>
      ) : null}

      {report ? (
        <>
          {READINESS_AREAS.map((area) => {
            const checks = report.checks.filter((check) => check.area === area);
            if (checks.length === 0) return null;
            return (
              <section key={area} className="flex flex-col gap-1.5">
                <h3 className="text-xs font-medium tracking-wide text-[var(--color-text-muted)] uppercase">
                  {READINESS_AREA_LABELS[area]}
                </h3>
                {checks.map((check) => (
                  <Row key={check.id} check={check} />
                ))}
              </section>
            );
          })}
          <p className="text-xs text-[var(--color-text-muted)]">
            “{READINESS_STATE_LABELS.configured}” means a value is present and nothing has confirmed
            it works. Only “{READINESS_STATE_LABELS.verified}” means something actually happened.
          </p>
        </>
      ) : null}
    </div>
  );
}

function Row({ check }: { check: ReadinessCheck }) {
  const style = STATE_STYLE[check.state];
  return (
    <div className="flex flex-col gap-1 rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className={cn('text-sm font-medium', style.text)}>{check.title}</span>
        <span className={cn('rounded-full px-2 py-0.5 text-[11px] font-medium', style.chip)}>
          {READINESS_STATE_LABELS[check.state]}
        </span>
        {check.blocking && check.state !== 'verified' ? (
          <span className="text-[11px] text-[var(--color-critical-text)]">
            Jarvis cannot run without this
          </span>
        ) : null}
      </div>
      <p className="text-xs text-[var(--color-text-muted)]">{check.detail}</p>
      {check.nextAction ? (
        <p className="text-xs text-[var(--color-accent-text)]">{check.nextAction}</p>
      ) : null}
    </div>
  );
}
