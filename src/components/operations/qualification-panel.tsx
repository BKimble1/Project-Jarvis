'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';

/**
 * The controls that move qualification forward.
 *
 * Every one of them *records* something. None of them grants a level: running the checks records
 * what was found, choosing a sandbox records where a rehearsal may happen, attesting records what
 * was actually done, and recording a live run reads a finished mission and refuses if the mission
 * does not show what is claimed.
 *
 * There is deliberately no "mark as qualified" button. A level that a person can simply assert is
 * a level that means nothing, and the whole point of the ladder is that each rung costs something
 * real to climb.
 */
export function QualificationPanel({
  sandboxAllowed,
  sandboxSelected,
}: {
  sandboxAllowed: readonly string[];
  sandboxSelected: string | null;
}) {
  const router = useRouter();
  const [busy, setBusy] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);

  const [sandbox, setSandbox] = React.useState(sandboxSelected ?? sandboxAllowed[0] ?? '');
  const [attestKind, setAttestKind] = React.useState<'recoveryDrill' | 'securityReview'>(
    'recoveryDrill',
  );
  const [attestNote, setAttestNote] = React.useState('');
  const [missionId, setMissionId] = React.useState('');
  const [liveKind, setLiveKind] = React.useState<'live_read' | 'live_write'>('live_read');

  async function send(body: unknown, key: string, success: string) {
    setBusy(key);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch('/api/qualification', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as {
          error?: { message?: string };
        };
        setError(payload.error?.message ?? 'That did not work.');
        return;
      }
      setNotice(success);
      router.refresh();
    } catch {
      setError('Could not reach Jarvis.');
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {error ? (
        <p
          role="alert"
          className="rounded-[var(--radius-card)] bg-[var(--color-critical-soft)] px-3 py-2 text-sm text-[var(--color-critical-text)]"
        >
          {error}
        </p>
      ) : null}
      {notice ? (
        <p className="rounded-[var(--radius-card)] bg-[var(--color-positive-soft)] px-3 py-2 text-sm text-[var(--color-positive-text)]">
          {notice}
        </p>
      ) : null}

      <section className="flex flex-col gap-2 border-t border-[var(--color-border)] pt-3">
        <h3 className="text-xs font-semibold tracking-wide text-[var(--color-text-subtle)] uppercase">
          Run the checks
        </h3>
        <p className="text-xs text-[var(--color-text-muted)]">
          Runs every check this deployment can decide for itself. Checks that need a real
          credential, a real repository or a real model session are recorded as unavailable with
          what would fix them — never as a pass.
        </p>
        <div>
          <Button
            disabled={busy !== null}
            onClick={() => void send({ action: 'run' }, 'run', 'The checks have been re-run.')}
          >
            {busy === 'run' ? 'Running…' : 'Run every check'}
          </Button>
        </div>
      </section>

      <section className="flex flex-col gap-2 border-t border-[var(--color-border)] pt-3">
        <h3 className="text-xs font-semibold tracking-wide text-[var(--color-text-subtle)] uppercase">
          Sandbox repository
        </h3>
        {sandboxAllowed.length === 0 ? (
          <p className="text-xs text-[var(--color-text-muted)]">
            Nothing is allow-listed. Set <code>JARVIS_QUALIFICATION_REPOS</code> to the repositories
            where a live rehearsal may happen. Jarvis having read access to a repository is not the
            same as that repository being somewhere to practise writing.
          </p>
        ) : (
          <>
            <p className="text-xs text-[var(--color-text-muted)]">
              A real model will write here during live write qualification. It produces a branch and
              a draft pull request, and merges nothing.
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <label className="sr-only" htmlFor="qualification-sandbox">
                Sandbox repository
              </label>
              <select
                id="qualification-sandbox"
                value={sandbox}
                onChange={(event) => setSandbox(event.target.value)}
                className="rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-1.5 text-sm"
              >
                {sandboxAllowed.map((repository) => (
                  <option key={repository} value={repository}>
                    {repository}
                  </option>
                ))}
              </select>
              <Button
                variant="secondary"
                disabled={busy !== null || sandbox.length === 0 || sandbox === sandboxSelected}
                onClick={() =>
                  void send(
                    {
                      action: 'sandbox',
                      repositoryFullName: sandbox,
                      confirmation: 'use this repository for qualification',
                    },
                    'sandbox',
                    `Live qualification will use ${sandbox}.`,
                  )
                }
              >
                {busy === 'sandbox' ? 'Saving…' : 'Use this repository'}
              </Button>
            </div>
          </>
        )}
      </section>

      <section className="flex flex-col gap-2 border-t border-[var(--color-border)] pt-3">
        <h3 className="text-xs font-semibold tracking-wide text-[var(--color-text-subtle)] uppercase">
          Record a live run
        </h3>
        <p className="text-xs text-[var(--color-text-muted)]">
          Point at a mission that finished against the sandbox. Jarvis reads what it actually
          produced: a read qualification is refused if the mission opened a pull request, and a
          write qualification is refused if it did not.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <label className="sr-only" htmlFor="qualification-mission">
            Mission id
          </label>
          <input
            id="qualification-mission"
            value={missionId}
            onChange={(event) => setMissionId(event.target.value)}
            placeholder="Mission id"
            className="min-w-[18rem] flex-1 rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-1.5 font-mono text-xs"
          />
          <label className="sr-only" htmlFor="qualification-live-kind">
            What it proves
          </label>
          <select
            id="qualification-live-kind"
            value={liveKind}
            onChange={(event) => setLiveKind(event.target.value as 'live_read' | 'live_write')}
            className="rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-1.5 text-sm"
          >
            <option value="live_read">Read-only audit</option>
            <option value="live_write">Draft pull request</option>
          </select>
          <Button
            variant="secondary"
            disabled={busy !== null || missionId.trim().length === 0}
            onClick={() =>
              void send(
                { action: 'record-live', missionId: missionId.trim(), kind: liveKind },
                'live',
                'Recorded.',
              )
            }
          >
            {busy === 'live' ? 'Checking…' : 'Record it'}
          </Button>
        </div>
      </section>

      <section className="flex flex-col gap-2 border-t border-[var(--color-border)] pt-3">
        <h3 className="text-xs font-semibold tracking-wide text-[var(--color-text-subtle)] uppercase">
          Record a drill or a review
        </h3>
        <p className="text-xs text-[var(--color-text-muted)]">
          Write what you actually did. A security review is recorded against this build and stops
          counting when the build changes, because a review of an older commit is not a review of
          this one.
        </p>
        <div className="flex flex-wrap items-start gap-2">
          <label className="sr-only" htmlFor="qualification-attest-kind">
            What was done
          </label>
          <select
            id="qualification-attest-kind"
            value={attestKind}
            onChange={(event) =>
              setAttestKind(event.target.value as 'recoveryDrill' | 'securityReview')
            }
            className="rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-1.5 text-sm"
          >
            <option value="recoveryDrill">Recovery drill</option>
            <option value="securityReview">Security review</option>
          </select>
          <label className="sr-only" htmlFor="qualification-attest-note">
            What was done
          </label>
          <textarea
            id="qualification-attest-note"
            value={attestNote}
            onChange={(event) => setAttestNote(event.target.value)}
            rows={2}
            placeholder="Restored last night's backup into a scratch database and ran the migrations."
            className="min-w-[18rem] flex-1 rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-1.5 text-sm"
          />
          <Button
            variant="secondary"
            disabled={busy !== null || attestNote.trim().length < 10}
            onClick={() =>
              void send(
                { action: 'attest', kind: attestKind, note: attestNote.trim() },
                'attest',
                'Recorded.',
              )
            }
          >
            {busy === 'attest' ? 'Saving…' : 'Record it'}
          </Button>
        </div>
      </section>
    </div>
  );
}
