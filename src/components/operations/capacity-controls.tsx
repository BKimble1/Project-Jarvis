'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import type { CapacityLimits, CapacityPosture } from '@/domain/capacity';
import { Button } from '@/components/ui/button';

/**
 * The two controls an owner actually needs in a hurry.
 *
 * Both only ever go **down**. Draining and stopping reduce what may start; the concurrency slider
 * lowers a ceiling and cannot raise one past what the configuration allows. Raising a limit is a
 * configuration change made deliberately and restarted into.
 *
 * That asymmetry is on purpose. The direction that matters under pressure is down, and a control
 * that can go both ways is a control that can go the wrong way at exactly the wrong moment.
 */
export function CapacityControls({
  posture,
  limits,
}: {
  posture: CapacityPosture;
  limits: CapacityLimits;
}) {
  const router = useRouter();
  const [busy, setBusy] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  async function send(body: unknown, key: string) {
    setBusy(key);
    setError(null);
    try {
      const response = await fetch('/api/capacity', {
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
      router.refresh();
    } catch {
      setError('Could not reach Jarvis.');
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex flex-col gap-2 border-t border-[var(--color-border)] pt-3">
      <p className="text-xs font-semibold tracking-wide text-[var(--color-text-subtle)] uppercase">
        Slow Jarvis down
      </p>
      <div className="flex flex-wrap gap-2">
        <Button
          variant="secondary"
          disabled={busy !== null || posture === 'open'}
          onClick={() => void send({ kind: 'posture', posture: 'open' }, 'open')}
        >
          Accept new work
        </Button>
        <Button
          variant="secondary"
          disabled={busy !== null || posture === 'draining'}
          onClick={() =>
            void send(
              { kind: 'posture', posture: 'draining', reason: 'Drained from operations.' },
              'drain',
            )
          }
        >
          {busy === 'drain' ? 'Draining…' : 'Finish what is running'}
        </Button>
        <Button
          variant="danger"
          disabled={busy !== null || posture === 'stopped'}
          onClick={() =>
            void send(
              { kind: 'posture', posture: 'stopped', reason: 'Stopped from operations.' },
              'stop',
            )
          }
        >
          {busy === 'stop' ? 'Stopping…' : 'Stop starting anything'}
        </Button>
        {limits.maxActiveRuns > 1 ? (
          <Button
            variant="secondary"
            disabled={busy !== null}
            onClick={() => void send({ kind: 'limits', maxActiveRuns: 1 }, 'one')}
          >
            {busy === 'one' ? 'Reducing…' : 'One agent at a time'}
          </Button>
        ) : null}
      </div>
      <p className="text-xs text-[var(--color-text-muted)]">
        Draining lets running agents finish and starts nothing new. Neither of these kills work in
        progress or deletes a workspace — whatever an agent has done stays on its branch.
      </p>
      {error ? <p className="text-xs text-[var(--color-critical-text)]">{error}</p> : null}
    </div>
  );
}
