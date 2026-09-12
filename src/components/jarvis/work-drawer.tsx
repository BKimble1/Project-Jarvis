'use client';

import * as React from 'react';
import Link from 'next/link';
import { ExternalLink, Loader2, X } from 'lucide-react';
import {
  MISSION_STATE_LABELS,
  RETRYABLE_MISSION_STATES,
  type Mission,
  type MissionState,
} from '@/domain/mission';
import { allowedNextStates } from '@/domain/mission-state';
import { RelativeTime } from '@/components/relative-time';
import { cn } from '@/lib/cn';

/**
 * What one piece of work is actually doing, and the controls that genuinely exist for it.
 *
 * ## Why the controls are derived rather than listed
 *
 * Because the alternative is a row of buttons that look the same whatever the mission is doing,
 * and the owner asked for the opposite: a control that exists, or a sentence saying why it does
 * not. `allowedNextStates` is the same table the server validates against, so a button is shown
 * here exactly when pressing it would be accepted there — and when none can be, the drawer says
 * what the mission is waiting for instead of offering something that would fail.
 *
 * ## What is deliberately absent
 *
 * Per-agent pause and resume. The task API accepts `skip`, `cancel` and `retry` and nothing else,
 * so a per-agent pause control would be a button that changes its own label and nothing else.
 * Pausing is a mission-level fact here because that is the only level at which it is real.
 */

/** The subset of a mission detail this drawer reads. The endpoint returns a great deal more. */
interface MissionDetailResponse {
  readonly mission: Mission;
  readonly project: { readonly id: string; readonly name: string } | null;
  readonly events: readonly {
    readonly id: string;
    readonly type: string;
    readonly level: string;
    readonly summary: string;
    readonly createdAt: string;
  }[];
  readonly currentPlan: { readonly version: number; readonly content: string } | null;
  readonly artifacts: readonly {
    readonly id: string;
    readonly kind: string;
    readonly title: string;
  }[];
}

/**
 * Events worth putting in front of a person.
 *
 * A run produces hundreds of `tool_use` and `agent_message` rows. They are the record and they
 * belong on the mission page; what belongs here is the handful that changed something.
 */
const MEANINGFUL_LEVELS = new Set(['notice', 'warning', 'error']);

type Command = 'pause' | 'resume' | 'stop' | 'retry' | 'cancel';

export function WorkDrawer({ missionId, onClose }: { missionId: string; onClose: () => void }) {
  const [detail, setDetail] = React.useState<MissionDetailResponse | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState<Command | null>(null);
  const [note, setNote] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    try {
      const response = await fetch(`/api/missions/${missionId}`);
      if (!response.ok) {
        setError('That mission could not be read.');
        return;
      }
      setDetail((await response.json()) as MissionDetailResponse);
      setError(null);
    } catch {
      setError('That mission could not be read.');
    }
  }, [missionId]);

  React.useEffect(() => {
    void load();
  }, [load]);

  /*
   * The key is the mission, the command and the state it was issued from — never a fresh random
   * value per click. A random key makes a double-tap two commands, which is how one press of Stop
   * becomes two stop requests against the same run.
   */
  async function run(command: Command, state: MissionState) {
    setBusy(command);
    setNote(null);
    try {
      const response =
        command === 'retry'
          ? await fetch(`/api/missions/${missionId}/retry`, { method: 'POST' })
          : command === 'cancel'
            ? await fetch(
                `/api/missions/${missionId}?reason=${encodeURIComponent('Cancelled from the dashboard.')}`,
                {
                  method: 'DELETE',
                },
              )
            : await fetch(`/api/missions/${missionId}/commands`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                  command,
                  idempotencyKey: `dash-${missionId}-${command}-${state}`,
                  ...(command === 'stop' ? { confirm: true } : {}),
                }),
              });

      if (!response.ok) {
        setNote(
          response.status === 409
            ? 'The mission moved on before that reached it. This is now showing where it actually is.'
            : 'That could not be done just now.',
        );
      }
      await load();
    } catch {
      setNote('That could not be sent.');
    } finally {
      setBusy(null);
    }
  }

  const mission = detail?.mission ?? null;
  const state = mission?.state ?? null;
  const next = state ? allowedNextStates(state, 'owner') : [];

  /* A control appears only where the server's own table would accept the move behind it. */
  const can = {
    pause: next.includes('pausing') || next.includes('paused'),
    resume: state === 'paused',
    stop: next.includes('stopping') || next.includes('stopped'),
    retry: state !== null && (RETRYABLE_MISSION_STATES as readonly string[]).includes(state),
    cancel: next.includes('cancelled'),
  };
  const anyControl = Object.values(can).some(Boolean);

  const events = (detail?.events ?? [])
    .filter((event) => MEANINGFUL_LEVELS.has(event.level))
    .slice(-6)
    .reverse();

  return (
    <section
      aria-label="Work detail"
      className="flex min-h-0 flex-col gap-3 rounded-sm border border-[color-mix(in_srgb,var(--jx-blue)_45%,transparent)] bg-[color-mix(in_srgb,var(--jx-panel)_75%,transparent)] p-3"
    >
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <p className="jx-label truncate text-[var(--jx-cyan)]">
            {detail?.project?.name ?? 'Work in progress'}
          </p>
          <h3 className="truncate text-sm font-medium text-[var(--jx-ink)]">
            {mission?.title ?? 'Loading…'}
          </h3>
          {state ? (
            <p className="jx-label mt-0.5">
              {MISSION_STATE_LABELS[state] ?? state}
              {mission?.lastActivityAt ? (
                <>
                  {' · '}
                  <RelativeTime iso={mission.lastActivityAt} />
                </>
              ) : null}
            </p>
          ) : null}
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close work detail"
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-sm border border-[color-mix(in_srgb,var(--jx-line)_70%,transparent)] text-[var(--jx-ink-dim)] hover:text-[var(--jx-ink)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--jx-cyan)]"
        >
          <X className="h-4 w-4" aria-hidden />
        </button>
      </div>

      {error ? <p className="text-sm text-[var(--jx-red)]">{error}</p> : null}

      {mission?.deliverable ? (
        <p className="text-xs text-[var(--jx-ink-dim)]">{mission.deliverable}</p>
      ) : null}

      {mission && mission.acceptanceCriteria.length > 0 ? (
        <div>
          <p className="jx-label text-[var(--jx-ink-faint)]">What done looks like</p>
          <ul className="mt-1 flex flex-col gap-1">
            {mission.acceptanceCriteria.slice(0, 5).map((criterion) => (
              <li key={criterion} className="text-xs text-[var(--jx-ink-dim)]">
                • {criterion}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {events.length > 0 ? (
        <div>
          <p className="jx-label text-[var(--jx-ink-faint)]">What happened</p>
          <ul className="mt-1 flex flex-col gap-1">
            {events.map((event) => (
              <li key={event.id} className="text-xs">
                <span
                  className={cn(
                    event.level === 'error'
                      ? 'text-[var(--jx-red)]'
                      : event.level === 'warning'
                        ? 'text-[var(--jx-amber)]'
                        : 'text-[var(--jx-ink-dim)]',
                  )}
                >
                  {event.summary}
                </span>{' '}
                <span className="text-[var(--jx-ink-faint)]">
                  <RelativeTime iso={event.createdAt} />
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {/* ------------------------------------------------------------ real controls only */}
      <div className="flex flex-wrap items-center gap-2">
        {state && can.pause ? (
          <Control busy={busy === 'pause'} onClick={() => void run('pause', state)}>
            Pause
          </Control>
        ) : null}
        {state && can.resume ? (
          <Control busy={busy === 'resume'} onClick={() => void run('resume', state)}>
            Resume
          </Control>
        ) : null}
        {state && can.retry ? (
          <Control busy={busy === 'retry'} onClick={() => void run('retry', state)}>
            Try again
          </Control>
        ) : null}
        {state && can.stop ? (
          <Control busy={busy === 'stop'} onClick={() => void run('stop', state)}>
            Stop
          </Control>
        ) : null}
        {state && can.cancel ? (
          <Control busy={busy === 'cancel'} onClick={() => void run('cancel', state)}>
            Cancel
          </Control>
        ) : null}

        {mission ? (
          <Link
            href={`/missions/${mission.id}`}
            className="inline-flex min-h-11 items-center gap-1 text-xs text-[var(--jx-cyan)] hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--jx-cyan)]"
          >
            Full mission
          </Link>
        ) : null}

        {mission?.pullRequestUrl ? (
          <a
            href={mission.pullRequestUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex min-h-11 items-center gap-1 text-xs text-[var(--jx-cyan)] hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--jx-cyan)]"
          >
            View pull request
            <ExternalLink className="h-3 w-3" aria-hidden />
          </a>
        ) : null}
      </div>

      {/*
        No control, and why.

        The owner asked that a missing backend operation be described rather than dressed up as a
        disabled button. A mission in `draft` or `completed` genuinely has nothing to pause.
      */}
      {mission && !anyControl ? (
        <p className="text-xs text-[var(--jx-ink-faint)]">
          Nothing to pause, stop or retry from here while it is{' '}
          {(MISSION_STATE_LABELS[mission.state] ?? mission.state).toLowerCase()}.
        </p>
      ) : null}

      {note ? (
        <p role="status" className="text-xs text-[var(--jx-amber)]">
          {note}
        </p>
      ) : null}
    </section>
  );
}

function Control({
  children,
  onClick,
  busy,
}: {
  children: React.ReactNode;
  onClick: () => void;
  busy: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      className="inline-flex min-h-11 items-center gap-1.5 rounded-sm border border-[color-mix(in_srgb,var(--jx-line)_75%,transparent)] px-2.5 text-xs text-[var(--jx-ink-dim)] transition-colors hover:border-[var(--jx-blue)] hover:text-[var(--jx-ink)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--jx-cyan)] disabled:opacity-60"
    >
      {busy ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> : null}
      {children}
    </button>
  );
}
