'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import {
  AlertTriangle,
  Ban,
  CheckCircle2,
  CircleAlert,
  CirclePause,
  CirclePlay,
  FileText,
  GitBranch,
  GitPullRequestDraft,
  Loader2,
  MessageSquare,
  PlugZap,
  Send,
  ShieldQuestion,
  Square,
  Terminal,
  Wrench,
} from 'lucide-react';
import { toast } from 'sonner';
import type { Mission } from '@/domain/mission';
import { MISSION_STATE_LABELS, isTerminalMissionState } from '@/domain/mission';
import type {
  MissionEvent,
  MissionPermissionRequest,
  MissionRun,
  MissionVerification,
} from '@/domain/mission-run';
import type { WorkerHealth } from '@/domain/worker';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Textarea } from '@/components/ui/field';
import { RelativeTime } from '@/components/relative-time';
import { cn } from '@/lib/cn';
import { MissionStatePill } from './mission-pills';

/**
 * The live mission view.
 *
 * Polls a bounded endpoint rather than holding a socket: the control plane is serverless, and
 * polling is the option that is still correct after a refresh, after the phone sleeps, and after
 * the tab has been closed for an hour. **The browser is never required to stay open** — this is a
 * window onto a mission that is running elsewhere, not the thing running it.
 *
 * Polling stops on a terminal state, and backs off when the tab is hidden.
 */

const ACTIVE_INTERVAL_MS = 2500;
const IDLE_INTERVAL_MS = 12_000;

export interface MissionLiveData {
  readonly mission: Mission;
  readonly activeRun: MissionRun | null;
  readonly events: readonly MissionEvent[];
  readonly permissionRequests: readonly MissionPermissionRequest[];
  readonly verifications: readonly MissionVerification[];
  readonly worker: WorkerHealth | null;
  readonly stalled: boolean;
}

export function MissionLive({ initial }: { initial: MissionLiveData }) {
  const router = useRouter();
  const [data, setData] = React.useState(initial);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [message, setMessage] = React.useState('');

  /* Server-rendered data wins on a route refresh, so an action's result shows immediately. */
  React.useEffect(() => setData(initial), [initial]);

  /*
   * The rest of the page is server-rendered: the state pill, the plan and the approval controls.
   * Polling alone would leave those frozen at whatever the mission was when the page loaded — an
   * owner watching a plan being written would see "No plan yet" until they reloaded by hand. So a
   * genuine change asks the server to re-render, and only a genuine change: the poll runs every
   * couple of seconds, and refreshing on each one would be a needless render loop.
   */
  const asked = React.useRef<string | null>(null);
  React.useEffect(() => {
    const polled = `${data.mission.state}:${data.mission.currentPlanVersion}`;
    const onScreen = `${initial.mission.state}:${initial.mission.currentPlanVersion}`;
    if (polled === onScreen) return;
    /* At most one request per distinct change, so a refresh that lands stale cannot spin. */
    if (asked.current === polled) return;
    asked.current = polled;
    router.refresh();
  }, [
    data.mission.state,
    data.mission.currentPlanVersion,
    initial.mission.state,
    initial.mission.currentPlanVersion,
    router,
  ]);

  const live = !isTerminalMissionState(data.mission.state) && data.mission.state !== 'stopped';

  React.useEffect(() => {
    if (!live) return;
    let cancelled = false;

    const tick = async () => {
      if (cancelled) return;
      try {
        const response = await fetch(`/api/missions/${initial.mission.id}/events`, {
          cache: 'no-store',
        });
        if (!response.ok) return;
        const next = (await response.json()) as MissionLiveData;
        if (!cancelled) setData((previous) => ({ ...previous, ...next }));
      } catch {
        /* A dropped poll is not worth a toast; the next one will catch up. */
      }
    };

    const schedule = () =>
      window.setInterval(
        () => void tick(),
        document.visibilityState === 'visible' ? ACTIVE_INTERVAL_MS : IDLE_INTERVAL_MS,
      );

    let timer = schedule();
    const onVisibility = () => {
      window.clearInterval(timer);
      timer = schedule();
      if (document.visibilityState === 'visible') void tick();
    };
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [initial.mission.id, live]);

  const command = React.useCallback(
    async (body: Record<string, unknown>, success: string) => {
      const kind = String(body.command);
      setBusy(kind);
      try {
        const response = await fetch(`/api/missions/${initial.mission.id}/commands`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          /* Generated per click, so a double tap is one command rather than two. */
          body: JSON.stringify({ ...body, idempotencyKey: crypto.randomUUID() }),
        });
        const payload = (await response.json()) as {
          error?: { message: string };
          requiresReplan?: boolean;
          reason?: string | null;
        };
        if (!response.ok) {
          toast.error(payload.error?.message ?? 'That did not work.');
          return;
        }
        if (payload.requiresReplan) {
          toast.warning(
            `Pausing for a revised plan: ${payload.reason ?? 'that message changes the approved scope.'}`,
          );
        } else {
          toast.success(success);
        }
        router.refresh();
      } catch {
        toast.error('Could not reach the server.');
      } finally {
        setBusy(null);
      }
    },
    [initial.mission.id, router],
  );

  const { mission, activeRun } = data;

  return (
    <div className="flex flex-col gap-4">
      {data.stalled ? (
        <p className="flex items-start gap-2 rounded-[var(--radius-card)] border border-[var(--color-caution)]/40 bg-[var(--color-caution-soft)] px-3 py-2.5 text-sm text-[var(--color-caution-text)]">
          <PlugZap className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <span>
            This mission shows as {MISSION_STATE_LABELS[mission.state].toLowerCase()}, but its
            worker has stopped reporting. Jarvis has not marked it complete or failed — the
            workspace and any branch are untouched.
          </span>
        </p>
      ) : null}

      {data.permissionRequests.map((request) => (
        <PermissionCard key={request.id} request={request} onDone={() => router.refresh()} />
      ))}

      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle>Run</CardTitle>
            <MissionStatePill state={mission.state} stalled={data.stalled} />
          </div>
          {activeRun?.currentAction ? (
            <p className="text-sm text-[var(--color-text-muted)]">{activeRun.currentAction}</p>
          ) : null}
        </CardHeader>

        <CardContent className="flex flex-col gap-3 pt-0">
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs sm:grid-cols-3">
            <Fact label="Worker" value={data.worker?.worker.name ?? 'None yet'} />
            <Fact
              label="Attempt"
              value={activeRun ? `${activeRun.attempt}` : `${mission.attemptCount}`}
            />
            <Fact
              label="Started"
              value={<RelativeTime iso={activeRun?.startedAt ?? mission.startedAt} />}
            />
            <Fact
              label="Last activity"
              value={<RelativeTime iso={activeRun?.lastEventAt ?? mission.lastActivityAt} />}
            />
            {mission.workingBranch ? (
              <Fact
                label="Branch"
                value={
                  <span className="inline-flex items-center gap-1 break-all">
                    <GitBranch className="h-3 w-3 shrink-0" aria-hidden />
                    {mission.workingBranch}
                  </span>
                }
              />
            ) : null}
            {activeRun?.usage?.totalCostUsd != null ? (
              <Fact
                label="Estimated cost"
                value={`$${activeRun.usage.totalCostUsd.toFixed(4)}`}
                hint="Reported by the runtime for API-billed work. An estimate, not a bill."
              />
            ) : null}
          </dl>

          {mission.pullRequestUrl ? (
            <a
              href={mission.pullRequestUrl}
              target="_blank"
              rel="noreferrer noopener"
              className="flex items-center gap-2 rounded-lg border border-[var(--color-accent)]/40 bg-[var(--color-accent-soft)] px-3 py-2.5 text-sm text-[var(--color-accent-text)] hover:underline"
            >
              <GitPullRequestDraft className="h-4 w-4 shrink-0" aria-hidden />
              <span>
                Draft pull request #{mission.pullRequestNumber} — ready for your review, not merged
              </span>
            </a>
          ) : null}

          {mission.failureMessage ? (
            <p className="rounded-lg bg-[var(--color-critical-soft)] px-3 py-2 text-sm text-[var(--color-critical-text)]">
              {mission.failureMessage}
            </p>
          ) : null}

          {mission.completionSummary ? (
            <div className="rounded-lg bg-[var(--color-surface-muted)] px-3 py-2.5">
              <p className="text-xs font-semibold tracking-wide text-[var(--color-text-subtle)] uppercase">
                What Jarvis did
              </p>
              <p className="mt-1 text-sm whitespace-pre-wrap">{mission.completionSummary}</p>
            </div>
          ) : null}

          {/* ------------------------------------------------------ controls */}
          <MissionControls
            mission={mission}
            busy={busy}
            onCommand={command}
            message={message}
            setMessage={setMessage}
          />
        </CardContent>
      </Card>

      {data.verifications.length > 0 ? <VerificationTable results={data.verifications} /> : null}

      <EventStream events={data.events} />
    </div>
  );
}

function MissionControls({
  mission,
  busy,
  onCommand,
  message,
  setMessage,
}: {
  mission: Mission;
  busy: string | null;
  onCommand: (body: Record<string, unknown>, success: string) => Promise<void>;
  message: string;
  setMessage: (value: string) => void;
}) {
  const running = [
    'running',
    'verifying',
    'creating_pull_request',
    'waiting_for_permission',
    'waiting_for_input',
    'claimed',
    'preparing_workspace',
  ].includes(mission.state);
  const paused = mission.state === 'paused';
  const stoppable =
    running || paused || mission.state === 'pausing' || mission.state === 'resuming';
  const retryable = mission.state === 'failed' || mission.state === 'stopped';

  if (!running && !paused && !retryable) return null;

  return (
    <div className="flex flex-col gap-3 border-t border-[var(--color-border)] pt-3">
      <div className="flex flex-wrap gap-2">
        {running ? (
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={busy !== null}
            onClick={() => void onCommand({ command: 'pause' }, 'Pause requested.')}
          >
            {busy === 'pause' ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            ) : (
              <CirclePause className="h-4 w-4" aria-hidden />
            )}
            Pause
          </Button>
        ) : null}

        {paused ? (
          <Button
            type="button"
            size="sm"
            disabled={busy !== null}
            onClick={() => void onCommand({ command: 'resume' }, 'Resuming.')}
          >
            {busy === 'resume' ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            ) : (
              <CirclePlay className="h-4 w-4" aria-hidden />
            )}
            Resume
          </Button>
        ) : null}

        {stoppable ? (
          <Button
            type="button"
            variant="danger"
            size="sm"
            disabled={busy !== null}
            onClick={() => {
              /* Stop is the one control that asks first: it ends the run. */
              if (
                !window.confirm(
                  'Stop this mission? The agent is interrupted, and the workspace, branch and any commits are preserved.',
                )
              ) {
                return;
              }
              void onCommand({ command: 'stop', confirm: true, reason: null }, 'Stopping.');
            }}
          >
            {busy === 'stop' ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            ) : (
              <Square className="h-4 w-4" aria-hidden />
            )}
            Stop
          </Button>
        ) : null}

        {retryable ? <RetryButton missionId={mission.id} /> : null}
      </div>

      {running || paused ? (
        <form
          className="flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            const text = message.trim();
            if (text.length === 0) return;
            void onCommand(
              { command: 'message', message: text, expectsScopeChange: false },
              'Message sent to the agent.',
            ).then(() => setMessage(''));
          }}
        >
          <label htmlFor="mission-message" className="sr-only">
            Send a message to the agent
          </label>
          <Textarea
            id="mission-message"
            value={message}
            onChange={(event) => setMessage(event.target.value)}
            placeholder="Tell the agent something — e.g. “don’t change the subscription code”"
            rows={2}
            maxLength={4000}
          />
          <div className="flex items-center gap-2">
            <Button
              type="submit"
              size="sm"
              variant="secondary"
              disabled={busy !== null || message.trim().length === 0}
            >
              {busy === 'message' ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              ) : (
                <Send className="h-4 w-4" aria-hidden />
              )}
              Send
            </Button>
            <p className="text-xs text-[var(--color-text-muted)]">
              A message that changes the approved scope pauses the mission for a revised plan.
            </p>
          </div>
        </form>
      ) : null}
    </div>
  );
}

function RetryButton({ missionId }: { missionId: string }) {
  const router = useRouter();
  const [pending, setPending] = React.useState(false);
  return (
    <Button
      type="button"
      variant="secondary"
      size="sm"
      disabled={pending}
      onClick={async () => {
        setPending(true);
        try {
          const response = await fetch(`/api/missions/${missionId}/retry`, { method: 'POST' });
          const body = (await response.json()) as { error?: { message: string } };
          if (!response.ok) {
            toast.error(body.error?.message ?? 'This mission cannot be retried.');
            return;
          }
          toast.success('Retrying as a new attempt. The earlier attempt is preserved.');
          router.refresh();
        } catch {
          toast.error('Could not reach the server.');
        } finally {
          setPending(false);
        }
      }}
    >
      {pending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
      Retry as a new attempt
    </Button>
  );
}

/**
 * One permission request.
 *
 * The wording is deliberate: approving applies to *this* request and nothing else. There is no
 * "always allow" control here because there is no such capability in the system.
 */
export function PermissionCard({
  request,
  onDone,
}: {
  request: MissionPermissionRequest;
  onDone: () => void;
}) {
  const [pending, setPending] = React.useState<string | null>(null);
  const [answer, setAnswer] = React.useState('');
  const needsAnswer = request.kind === 'clarification' || request.kind === 'scope_decision';

  const decide = async (decision: 'approve' | 'deny' | 'answer') => {
    setPending(decision);
    try {
      const response = await fetch(`/api/permission-requests/${request.id}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          decision,
          answer: decision === 'answer' ? answer.trim() : null,
          note: null,
        }),
      });
      const body = (await response.json()) as { error?: { message: string } };
      if (!response.ok) {
        toast.error(body.error?.message ?? 'That could not be recorded.');
        return;
      }
      toast.success(decision === 'deny' ? 'Denied.' : 'Sent to the agent.');
      onDone();
    } catch {
      toast.error('Could not reach the server.');
    } finally {
      setPending(null);
    }
  };

  return (
    <Card className="border-[var(--color-critical)]/40">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm">
          <ShieldQuestion className="h-4 w-4 text-[var(--color-critical-text)]" aria-hidden />
          Jarvis needs your decision
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 pt-0">
        <div>
          <p className="text-sm font-medium">{request.requestedAction}</p>
          <p className="mt-1 text-sm text-[var(--color-text-muted)]">{request.reason}</p>
        </div>
        <div className="rounded-lg bg-[var(--color-surface-muted)] px-3 py-2 text-xs">
          <p>
            <span className="font-medium">If you approve:</span> {request.ifApproved}
          </p>
          {request.alternatives.length > 0 ? (
            <ul className="mt-1 flex flex-col gap-0.5 text-[var(--color-text-muted)]">
              {request.alternatives.map((alternative, index) => (
                <li key={index}>· {alternative}</li>
              ))}
            </ul>
          ) : null}
        </div>

        {needsAnswer ? (
          <>
            <label htmlFor={`answer-${request.id}`} className="sr-only">
              Your answer
            </label>
            <Textarea
              id={`answer-${request.id}`}
              value={answer}
              onChange={(event) => setAnswer(event.target.value)}
              placeholder="Your answer"
              rows={2}
              maxLength={2000}
            />
          </>
        ) : null}

        <div className="flex flex-wrap gap-2">
          {needsAnswer ? (
            <Button
              type="button"
              size="sm"
              disabled={pending !== null || answer.trim().length === 0}
              onClick={() => void decide('answer')}
            >
              {pending === 'answer' ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              ) : (
                <Send className="h-4 w-4" aria-hidden />
              )}
              Send answer
            </Button>
          ) : (
            <Button
              type="button"
              size="sm"
              disabled={pending !== null}
              onClick={() => void decide('approve')}
            >
              {pending === 'approve' ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              ) : (
                <CheckCircle2 className="h-4 w-4" aria-hidden />
              )}
              Approve this once
            </Button>
          )}
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={pending !== null}
            onClick={() => void decide('deny')}
          >
            <Ban className="h-4 w-4" aria-hidden />
            Deny
          </Button>
        </div>
        <p className="text-xs text-[var(--color-text-subtle)]">
          This applies to this request only. Never paste a credential here — Jarvis never needs one.
        </p>
      </CardContent>
    </Card>
  );
}

function VerificationTable({ results }: { results: readonly MissionVerification[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Verification</CardTitle>
      </CardHeader>
      <CardContent className="pt-0">
        <ul className="flex flex-col gap-2">
          {results.map((result) => (
            <li key={result.id} className="flex items-start gap-2 text-sm">
              <OutcomeIcon outcome={result.outcome} />
              <div className="min-w-0 flex-1">
                <code className="rounded bg-[var(--color-surface-muted)] px-1.5 py-0.5 text-xs break-all">
                  {result.command}
                </code>
                <p className="mt-0.5 text-xs text-[var(--color-text-muted)]">
                  {result.outcome === 'unavailable' || result.outcome === 'skipped'
                    ? (result.reason ?? 'No reason recorded.')
                    : `exit ${result.exitCode ?? '—'}${
                        result.missionRelated === false
                          ? ' · this failure pre-dates the mission'
                          : ''
                      }`}
                </p>
                {result.outputExcerpt ? (
                  <details className="mt-1">
                    <summary className="cursor-pointer text-xs text-[var(--color-text-subtle)]">
                      Output
                    </summary>
                    <pre className="jarvis-scroll-x mt-1 max-h-64 overflow-auto rounded bg-[var(--color-surface-muted)] p-2 text-[0.6875rem] whitespace-pre-wrap">
                      {result.outputExcerpt}
                    </pre>
                  </details>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

function OutcomeIcon({ outcome }: { outcome: MissionVerification['outcome'] }) {
  switch (outcome) {
    case 'passed':
      return (
        <CheckCircle2
          className="mt-0.5 h-4 w-4 shrink-0 text-[var(--color-positive-text)]"
          aria-label="passed"
        />
      );
    case 'failed':
      return (
        <CircleAlert
          className="mt-0.5 h-4 w-4 shrink-0 text-[var(--color-critical-text)]"
          aria-label="failed"
        />
      );
    default:
      return (
        <AlertTriangle
          className="mt-0.5 h-4 w-4 shrink-0 text-[var(--color-caution-text)]"
          aria-label={outcome}
        />
      );
  }
}

const EVENT_ICON: Partial<
  Record<MissionEvent['type'], React.ComponentType<{ className?: string }>>
> = {
  tool_use: Wrench,
  tool_result: Terminal,
  agent_message: MessageSquare,
  owner_message: MessageSquare,
  verification_started: Terminal,
  verification_finished: CheckCircle2,
  permission_requested: ShieldQuestion,
  policy_refusal: Ban,
  error: CircleAlert,
  warning: AlertTriangle,
  pull_request_created: GitPullRequestDraft,
  branch_created: GitBranch,
  branch_pushed: GitBranch,
  artifact_created: FileText,
};

function EventStream({ events }: { events: readonly MissionEvent[] }) {
  /* Newest first: on a phone, the thing that just happened should not be a scroll away. */
  const ordered = [...events].reverse();

  return (
    <Card>
      <CardHeader>
        <CardTitle>Timeline</CardTitle>
        <p className="text-xs text-[var(--color-text-subtle)]">
          {events.length} event{events.length === 1 ? '' : 's'} · you can close this page; the
          mission keeps running
        </p>
      </CardHeader>
      <CardContent className="pt-0">
        <ol className="flex flex-col">
          {ordered.map((event) => {
            const Icon = EVENT_ICON[event.type] ?? null;
            return (
              <li
                key={event.id}
                className="flex items-start gap-2.5 border-b border-[var(--color-border)] py-2 last:border-b-0"
              >
                <span
                  className={cn(
                    'mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full',
                    event.level === 'error'
                      ? 'bg-[var(--color-critical-soft)] text-[var(--color-critical-text)]'
                      : event.level === 'warning'
                        ? 'bg-[var(--color-caution-soft)] text-[var(--color-caution-text)]'
                        : event.level === 'notice'
                          ? 'bg-[var(--color-accent-soft)] text-[var(--color-accent-text)]'
                          : 'bg-[var(--color-surface-muted)] text-[var(--color-text-subtle)]',
                  )}
                >
                  {Icon ? <Icon className="h-3 w-3" aria-hidden /> : null}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm break-words">{event.summary}</p>
                  <p className="text-[0.6875rem] text-[var(--color-text-subtle)]">
                    {event.actor} · <RelativeTime iso={event.occurredAt} />
                  </p>
                </div>
              </li>
            );
          })}
        </ol>
      </CardContent>
    </Card>
  );
}

function Fact({ label, value, hint }: { label: string; value: React.ReactNode; hint?: string }) {
  return (
    <div>
      <dt className="text-[0.6875rem] tracking-wide text-[var(--color-text-subtle)] uppercase">
        {label}
      </dt>
      <dd className="mt-0.5 text-xs font-medium" title={hint}>
        {value}
      </dd>
    </div>
  );
}
