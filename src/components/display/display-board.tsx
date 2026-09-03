'use client';

import * as React from 'react';
import {
  DISPLAY_ACTIVITY_LABELS,
  DISPLAY_SCOPE_LABELS,
  type DisplayActivity,
  type DisplayMissionCard,
  type DisplayPayload,
} from '@/domain/display-device';
import { cn } from '@/lib/cn';

/**
 * The wallboard, as seen from across a room.
 *
 * Three constraints shape everything here:
 *
 *  - **It is read at a distance.** Type is large, contrast is high, and the most important number
 *    on the screen — how many agents are running, what needs the owner — is the biggest thing.
 *  - **Nobody is sitting at it.** There are no controls at all: nothing to click, nothing to
 *    approve, nothing to stop. A wallboard that can act is a wallboard anyone walking past can
 *    act with.
 *  - **It must be honest when it is broken.** A failed refresh says so, with the age of what is
 *    on screen. A board silently showing five-minute-old work as current is worse than a blank
 *    one, because it is trusted.
 */
export function DisplayBoard() {
  const [payload, setPayload] = React.useState<DisplayPayload | null>(null);
  const [status, setStatus] = React.useState<'loading' | 'ok' | 'unpaired' | 'error'>('loading');
  const [fetchedAt, setFetchedAt] = React.useState<number | null>(null);
  const [tick, setTick] = React.useState(0);

  const refresh = React.useCallback(async () => {
    try {
      const response = await fetch('/api/display', { cache: 'no-store' });
      if (response.status === 401 || response.status === 403) {
        setStatus('unpaired');
        return;
      }
      if (!response.ok) {
        setStatus('error');
        return;
      }
      setPayload((await response.json()) as DisplayPayload);
      setFetchedAt(Date.now());
      setStatus('ok');
    } catch {
      setStatus('error');
    }
  }, []);

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  /* Poll at the device's own rotation interval, floored so a misconfigured device cannot spin. */
  React.useEffect(() => {
    const seconds = Math.max(10, payload?.rotationSeconds ?? 20);
    const timer = setInterval(() => void refresh(), seconds * 1000);
    return () => clearInterval(timer);
  }, [payload?.rotationSeconds, refresh]);

  /* A second timer purely so "as of 40s ago" keeps counting while a refresh is failing. */
  React.useEffect(() => {
    const timer = setInterval(() => setTick((value) => value + 1), 5000);
    return () => clearInterval(timer);
  }, []);
  void tick;

  if (status === 'unpaired') return <PairScreen onPaired={refresh} />;

  if (!payload) {
    return (
      <Screen>
        <p className="text-2xl text-[var(--color-text-muted)]">
          {status === 'error' ? 'Cannot reach Jarvis.' : 'Loading…'}
        </p>
      </Screen>
    );
  }

  const ageSeconds = fetchedAt ? Math.round((Date.now() - fetchedAt) / 1000) : null;
  const stale = ageSeconds !== null && ageSeconds > Math.max(60, payload.rotationSeconds * 3);

  return (
    <Screen>
      <header className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
        <div className="flex items-baseline gap-4">
          <h1 className="text-3xl font-semibold tracking-tight xl:text-4xl">Jarvis</h1>
          <p className="text-lg text-[var(--color-text-subtle)] xl:text-xl">{payload.deviceName}</p>
        </div>
        <div className="flex items-center gap-4 text-lg xl:text-xl">
          <HealthDot
            ok={payload.health.controlPlane === 'ok' && payload.health.workers.stale === 0}
          />
          <span className="text-[var(--color-text-muted)]">
            {payload.health.workers.healthy}/{payload.health.workers.total} worker
            {payload.health.workers.total === 1 ? '' : 's'}
            {payload.health.posture !== 'open' ? ` · ${payload.health.posture}` : ''}
          </span>
          <span
            className={cn(
              stale ? 'text-[var(--color-critical-text)]' : 'text-[var(--color-text-subtle)]',
            )}
          >
            {status === 'error'
              ? 'Refresh failed'
              : ageSeconds === null
                ? ''
                : `as of ${ageSeconds}s ago`}
          </span>
        </div>
      </header>

      <section className="grid grid-cols-2 gap-4 xl:grid-cols-5" aria-label="Counts">
        <BigCount label="Missions running" value={payload.counts.activeMissions} />
        <BigCount label="Agents working" value={payload.counts.activeAgents} />
        <BigCount
          label="Draft PRs ready"
          value={payload.counts.prsReady}
          tone={payload.counts.prsReady > 0 ? 'good' : 'plain'}
        />
        <BigCount
          label="Needs you"
          value={payload.counts.awaitingOwner}
          tone={payload.counts.awaitingOwner > 0 ? 'attention' : 'plain'}
        />
        <BigCount
          label="Failing checks"
          value={payload.counts.failingChecks}
          tone={payload.counts.failingChecks > 0 ? 'bad' : 'plain'}
        />
      </section>

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 xl:grid-cols-3">
        <section className="flex min-h-0 flex-col gap-3 xl:col-span-2" aria-label="Missions">
          <h2 className="text-xl font-semibold text-[var(--color-text-muted)] xl:text-2xl">
            In flight
          </h2>
          {payload.missions.length === 0 ? (
            <p className="text-xl text-[var(--color-text-subtle)]">Nothing running.</p>
          ) : (
            <div className="jarvis-scroll-y flex min-h-0 flex-col gap-3 overflow-y-auto pr-1">
              {payload.missions.map((mission) => (
                <MissionRow key={mission.id} mission={mission} />
              ))}
            </div>
          )}
        </section>

        <section className="flex min-h-0 flex-col gap-3" aria-label="Attention and results">
          <h2 className="text-xl font-semibold text-[var(--color-text-muted)] xl:text-2xl">
            Needs a person
          </h2>
          {payload.attention.length === 0 ? (
            <p className="text-lg text-[var(--color-text-subtle)]">Nothing waiting on you.</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {payload.attention.map((item, index) => (
                <li
                  key={index}
                  className="rounded-xl bg-[var(--color-surface-muted)] px-4 py-3 text-lg"
                >
                  <p className="font-medium">{item.title}</p>
                  <p className="text-[var(--color-text-muted)]">{item.detail}</p>
                </li>
              ))}
            </ul>
          )}

          {payload.recentResults.length > 0 ? (
            <>
              <h2 className="mt-2 text-xl font-semibold text-[var(--color-text-muted)] xl:text-2xl">
                Just finished
              </h2>
              <ul className="flex flex-col gap-1.5">
                {payload.recentResults.map((item, index) => (
                  <li key={index} className="text-lg">
                    <span className="font-medium">{item.title}</span>{' '}
                    <span className="text-[var(--color-text-subtle)]">— {item.detail}</span>
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </section>
      </div>

      <footer className="text-base text-[var(--color-text-subtle)]">
        Read-only display · {payload.scopes.map((scope) => DISPLAY_SCOPE_LABELS[scope]).join(' · ')}
      </footer>
    </Screen>
  );
}

function Screen({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex min-h-dvh flex-col gap-5 bg-[var(--color-canvas)] p-6 text-[var(--color-text)] xl:gap-6 xl:p-10">
      {children}
    </main>
  );
}

function HealthDot({ ok }: { ok: boolean }) {
  return (
    <span
      className={cn(
        'inline-block h-3.5 w-3.5 rounded-full',
        ok ? 'bg-[var(--color-positive-text)]' : 'bg-[var(--color-caution-text)]',
      )}
      aria-label={ok ? 'Healthy' : 'Degraded'}
    />
  );
}

function BigCount({
  label,
  value,
  tone = 'plain',
}: {
  label: string;
  value: number;
  tone?: 'plain' | 'good' | 'bad' | 'attention';
}) {
  return (
    <div className="rounded-2xl bg-[var(--color-surface)] px-5 py-4">
      <p
        className={cn(
          'text-5xl font-semibold tabular-nums xl:text-6xl',
          tone === 'good' && 'text-[var(--color-positive-text)]',
          tone === 'bad' && 'text-[var(--color-critical-text)]',
          tone === 'attention' && 'text-[var(--color-caution-text)]',
        )}
      >
        {value}
      </p>
      <p className="mt-1 text-base text-[var(--color-text-muted)] xl:text-lg">{label}</p>
    </div>
  );
}

const ACTIVITY_TONE: Record<DisplayActivity, string> = {
  running: 'bg-[var(--color-accent-soft)] text-[var(--color-accent-text)]',
  reviewing: 'bg-[var(--color-accent-soft)] text-[var(--color-accent-text)]',
  repairing: 'bg-[var(--color-caution-soft)] text-[var(--color-caution-text)]',
  waiting: 'bg-[var(--color-surface-muted)] text-[var(--color-text-muted)]',
  paused: 'bg-[var(--color-surface-muted)] text-[var(--color-text-muted)]',
  blocked: 'bg-[var(--color-caution-soft)] text-[var(--color-caution-text)]',
  stalled: 'bg-[var(--color-critical-soft)] text-[var(--color-critical-text)]',
  pr_ready: 'bg-[var(--color-positive-soft)] text-[var(--color-positive-text)]',
  done: 'bg-[var(--color-positive-soft)] text-[var(--color-positive-text)]',
  failed: 'bg-[var(--color-critical-soft)] text-[var(--color-critical-text)]',
};

function MissionRow({ mission }: { mission: DisplayMissionCard }) {
  return (
    <article className="rounded-2xl bg-[var(--color-surface)] px-5 py-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <span
          className={cn(
            'rounded-full px-3 py-0.5 text-base font-medium',
            ACTIVITY_TONE[mission.activity],
          )}
        >
          {DISPLAY_ACTIVITY_LABELS[mission.activity]}
        </span>
        <h3 className="text-xl font-medium xl:text-2xl">{mission.title}</h3>
        {mission.projectName ? (
          <span className="text-lg text-[var(--color-text-subtle)]">{mission.projectName}</span>
        ) : null}
        {mission.needsOwner ? (
          <span className="ml-auto text-lg font-medium text-[var(--color-caution-text)]">
            Waiting for you
          </span>
        ) : null}
      </div>

      <p className="mt-1 text-lg text-[var(--color-text-muted)]">
        {mission.taskSummary.done}/{mission.taskSummary.total} tasks done
        {mission.taskSummary.running > 0 ? ` · ${mission.taskSummary.running} running` : ''}
        {mission.taskSummary.blocked > 0 ? ` · ${mission.taskSummary.blocked} blocked` : ''}
      </p>

      {mission.agents.length > 0 ? (
        <ul className="mt-2 flex flex-col gap-1">
          {mission.agents.map((agent) => (
            <li key={agent.taskKey} className="flex flex-wrap items-baseline gap-2 text-lg">
              <span className="font-medium">{agent.roleLabel}</span>
              <span className="text-[var(--color-text-subtle)]">
                {agent.readOnly ? 'read-only' : 'writing'}
              </span>
              <span className="text-[var(--color-text-muted)]">{agent.title}</span>
              {agent.stale ? (
                <span className="text-[var(--color-critical-text)]">not reporting</span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </article>
  );
}

/**
 * First-run pairing.
 *
 * The token is typed once, in front of the screen, and exchanged for an `httpOnly` cookie. It is
 * never stored anywhere the page itself can read, so a passer-by with devtools gets nothing.
 */
function PairScreen({ onPaired }: { onPaired: () => void }) {
  const [token, setToken] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const response = await fetch('/api/display/session', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: token.trim() }),
      });
      if (!response.ok) {
        setError('That token was not accepted. Pair the display again from Settings.');
        return;
      }
      setToken('');
      onPaired();
    } catch {
      setError('Could not reach Jarvis.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen>
      <div className="m-auto flex w-full max-w-xl flex-col gap-4">
        <h1 className="text-3xl font-semibold">Pair this display</h1>
        <p className="text-lg text-[var(--color-text-muted)]">
          In Jarvis, open Settings, pair a new display, and type its token here. The token is shown
          once. This screen will only ever show summaries — it cannot approve, stop or change
          anything.
        </p>
        <form onSubmit={submit} className="flex flex-col gap-3">
          <label htmlFor="display-token" className="text-base font-medium">
            Display token
          </label>
          <input
            id="display-token"
            value={token}
            onChange={(event) => setToken(event.target.value)}
            autoComplete="off"
            spellCheck={false}
            placeholder="jarvisd_…"
            className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-3 font-mono text-lg"
          />
          {error ? <p className="text-lg text-[var(--color-critical-text)]">{error}</p> : null}
          <button
            type="submit"
            disabled={busy || token.trim().length === 0}
            className="rounded-xl bg-[var(--color-accent)] px-5 py-3 text-lg font-medium text-[var(--color-text-inverse)] disabled:opacity-50"
          >
            {busy ? 'Pairing…' : 'Pair'}
          </button>
        </form>
      </div>
    </Screen>
  );
}
