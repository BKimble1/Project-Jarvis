'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';

import { APPROVAL_CATEGORY_INFO, type ApprovalCategory } from '@/domain/approval-policy';
import { Button } from '@/components/ui/button';

/**
 * The one switch that says whether Blake is in the loop for ordinary work.
 *
 * ## Why this is one switch and not two
 *
 * Underneath it is two records — standing authority, and whether routine plans approve themselves.
 * Either on its own produces the arrangement he complained about: Jarvis starts work by itself and
 * then stops at a plan screen overnight, or it never starts at all. Presenting them separately
 * would make "why did nothing happen" a question about which of two switches was off, so they move
 * together and the server writes both.
 *
 * ## Why the list of exceptions is on the screen
 *
 * Because "hands-off" is exactly the phrase that should make somebody ask "hands off *what*". The
 * answer has to be visible at the moment of turning it on rather than in a document, and it has to
 * be the real list rather than a paraphrase — so it is rendered from the same catalogue the
 * decision is made against, and cannot drift from it.
 */

const ALWAYS_ASKS: readonly ApprovalCategory[] = [
  'destructive_delete',
  'merge',
  'release',
  'deploy',
  'spend',
  'external_message',
  'credential_change',
  'outside_boundary',
];

export function HandsOffPanel({
  on,
  gaps,
  canEnable,
  blockedReason,
  preAuthorised,
}: {
  on: boolean;
  gaps: readonly string[];
  canEnable: boolean;
  blockedReason: string | null;
  preAuthorised: readonly ApprovalCategory[];
}) {
  const router = useRouter();
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function change(next: boolean) {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch('/api/operating/hands-off', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ on: next }),
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

  /* What still stops, said as the list it is rather than as a reassuring sentence. */
  const stillAsks = ALWAYS_ASKS.filter((category) => !preAuthorised.includes(category));

  return (
    <div className="flex flex-col gap-3" data-testid="hands-off-panel">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="text-sm font-medium" data-testid="hands-off-state">
          {on ? 'Hands-off' : 'Supervised'}
        </span>
        <span className="text-xs text-[var(--color-text-muted)]">
          {on
            ? 'I carry routine work through on my own and ask you only about the things below.'
            : 'I propose the work and wait for you to approve it before building anything.'}
        </span>
      </div>

      {!on && gaps.length > 0 ? (
        <ul className="list-disc space-y-0.5 pl-4 text-xs text-[var(--color-text-muted)]">
          {gaps.map((gap) => (
            <li key={gap}>{gap}</li>
          ))}
        </ul>
      ) : null}

      <div>
        <p className="text-xs text-[var(--color-text-subtle)]">
          {on
            ? 'I still stop and ask you before I would:'
            : 'Even with this on, I would still ask before I:'}
        </p>
        <ul className="mt-1 space-y-0.5 text-xs text-[var(--color-text-muted)]">
          {stillAsks.map((category) => (
            <li key={category}>
              {APPROVAL_CATEGORY_INFO[category].label}
              {APPROVAL_CATEGORY_INFO[category].irreversible ? ' — cannot be undone' : ''}
            </li>
          ))}
        </ul>
        {preAuthorised.length > 0 ? (
          <p className="mt-1 text-xs text-[var(--color-caution-text)]">
            You have pre-authorised{' '}
            {preAuthorised
              .map((category) => APPROVAL_CATEGORY_INFO[category].label.toLowerCase())
              .join(', ')}
            , so I would not ask about those.
          </p>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center gap-2 border-t border-[var(--color-border)] pt-3">
        <Button
          variant={on ? 'danger' : 'primary'}
          disabled={busy || (!on && !canEnable)}
          onClick={() => void change(!on)}
        >
          {busy ? 'Saving…' : on ? 'Turn Hands-off off' : 'Turn Hands-off on'}
        </Button>
        {!on && !canEnable && blockedReason ? (
          <span className="text-xs text-[var(--color-caution-text)]">{blockedReason}</span>
        ) : null}
      </div>

      {error ? <p className="text-xs text-[var(--color-critical-text)]">{error}</p> : null}
    </div>
  );
}
