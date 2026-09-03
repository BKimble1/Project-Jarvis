'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';

/**
 * Refresh and delete, for one source.
 *
 * The refresh result is reported honestly, including the unchanged case: "it had not changed" is
 * useful news, because it means every citation made against this source is still current. An
 * interface that only reported success would leave that unsaid.
 */
export function SourceActions({
  sourceId,
  refreshable,
  title,
}: {
  sourceId: string;
  refreshable: boolean;
  title: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [confirming, setConfirming] = React.useState(false);

  async function refresh(): Promise<void> {
    setBusy('refresh');
    setError(null);
    setNotice(null);
    try {
      const response = await fetch(`/api/knowledge/sources/${sourceId}/refresh`, {
        method: 'POST',
      });
      const payload = (await response.json()) as {
        error?: { message?: string };
        changed?: boolean;
        revisionNumber?: number;
      };
      if (!response.ok) {
        setError(payload.error?.message ?? 'That could not be re-read.');
        return;
      }
      setNotice(
        payload.changed
          ? `It had changed. This is now revision ${payload.revisionNumber}.`
          : 'It had not changed since Jarvis last read it, so every existing citation is still current.',
      );
      router.refresh();
    } catch {
      setError('That could not be re-read. Jarvis may be offline.');
    } finally {
      setBusy(null);
    }
  }

  async function remove(): Promise<void> {
    setBusy('delete');
    setError(null);
    try {
      const response = await fetch(`/api/knowledge/sources/${sourceId}`, { method: 'DELETE' });
      if (!response.ok) {
        const payload = (await response.json()) as { error?: { message?: string } };
        setError(payload.error?.message ?? 'That could not be deleted.');
        return;
      }
      router.push('/knowledge');
      router.refresh();
    } catch {
      setError('That could not be deleted. Jarvis may be offline.');
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-1.5">
        {refreshable ? (
          <Button size="sm" variant="secondary" disabled={busy !== null} onClick={refresh}>
            {busy === 'refresh' ? 'Re-reading…' : 'Re-read it now'}
          </Button>
        ) : null}
        <Button size="sm" variant="ghost" onClick={() => setConfirming(!confirming)}>
          Delete
        </Button>
      </div>

      {notice ? (
        <p role="status" className="text-[0.8125rem] text-[var(--color-text-muted)]">
          {notice}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-[0.8125rem] text-[var(--color-critical-text)]">
          {error}
        </p>
      ) : null}

      {confirming ? (
        <div className="flex flex-col gap-2 rounded-lg border border-[var(--color-critical)] bg-[var(--color-critical-soft)] p-3">
          <p className="text-[0.8125rem] text-[var(--color-critical-text)]">
            Deleting “{title}” removes its text, every revision and everything indexed from it.
            Citations pointing at it will stop resolving. Jarvis keeps a record that it existed and
            was deleted.
          </p>
          <div className="flex gap-1.5">
            <Button size="sm" variant="danger" disabled={busy !== null} onClick={remove}>
              {busy === 'delete' ? 'Deleting…' : 'Delete it'}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
