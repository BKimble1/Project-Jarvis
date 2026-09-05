'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Copy, Monitor } from 'lucide-react';
import {
  DISPLAY_SCOPES,
  DISPLAY_SCOPE_LABELS,
  type DisplayDevice,
  type DisplayScope,
} from '@/domain/display-device';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { RelativeTime } from '@/components/relative-time';

/**
 * Pairing and revoking wall displays.
 *
 * The token appears exactly once, here, immediately after pairing. There is no route that returns
 * it again and no field on `DisplayDevice` that could carry it, so "show it once" is a property of
 * the data model rather than a decision this component makes. Which means the honest thing to do
 * is say so on screen, and make revoking the obvious remedy for a lost one.
 */
export function DisplayManager({ devices }: { devices: readonly DisplayDevice[] }) {
  const router = useRouter();
  const [issued, setIssued] = React.useState<{ name: string; token: string } | null>(null);
  const [name, setName] = React.useState('');
  const [scopes, setScopes] = React.useState<readonly DisplayScope[]>([
    'portfolio',
    'missions',
    'agents',
    'attention',
  ]);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [copied, setCopied] = React.useState(false);

  async function pair(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const response = await fetch('/api/displays', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), scopes, rotationSeconds: 20 }),
      });
      const payload = (await response.json()) as {
        token?: string;
        device?: { name: string };
        error?: { message?: string };
      };
      if (!response.ok || !payload.token || !payload.device) {
        setError(payload.error?.message ?? 'That display could not be paired.');
        return;
      }
      setIssued({ name: payload.device.name, token: payload.token });
      setName('');
      router.refresh();
    } catch {
      setError('Could not reach Jarvis.');
    } finally {
      setBusy(false);
    }
  }

  async function revoke(id: string) {
    setBusy(true);
    try {
      await fetch(`/api/displays/${id}`, {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reason: 'Revoked from settings.' }),
      });
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-[var(--color-text-muted)]">
        A paired screen shows a summary and nothing else: no repository, no branch, no diff, no
        transcript, no links. It cannot approve, pause, stop, retry, merge or send a build. Open{' '}
        <code className="font-mono text-xs">/display</code> on the device and type its token once.
      </p>

      {issued ? (
        <div className="flex flex-col gap-2 rounded-[var(--radius-card)] bg-[var(--color-caution-soft)] px-3 py-2.5">
          <p className="text-sm font-medium text-[var(--color-caution-text)]">
            “{issued.name}” is paired. This is the only time the token is shown.
          </p>
          <div className="flex items-center gap-2">
            <code className="jarvis-scroll-x min-w-0 flex-1 rounded bg-[var(--color-surface)] px-2 py-1.5 font-mono text-xs whitespace-nowrap">
              {issued.token}
            </code>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                void navigator.clipboard?.writeText(issued.token);
                setCopied(true);
              }}
            >
              <Copy className="h-3.5 w-3.5" aria-hidden />
              {copied ? 'Copied' : 'Copy'}
            </Button>
          </div>
          <Button size="sm" variant="ghost" onClick={() => setIssued(null)}>
            I have saved it
          </Button>
        </div>
      ) : null}

      <form onSubmit={pair} className="flex flex-col gap-2">
        <div className="flex flex-wrap items-end gap-2">
          <div className="flex min-w-48 flex-1 flex-col gap-1">
            <label htmlFor="display-name" className="text-xs text-[var(--color-text-subtle)]">
              Where is it?
            </label>
            <input
              id="display-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Kitchen tablet"
              className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-2 text-sm"
            />
          </div>
          <Button type="submit" disabled={busy || name.trim().length < 2}>
            {busy ? 'Pairing…' : 'Pair a display'}
          </Button>
        </div>
        <fieldset className="flex flex-wrap gap-1.5">
          <legend className="sr-only">What this display may show</legend>
          {DISPLAY_SCOPES.map((scope) => {
            const on = scopes.includes(scope);
            return (
              <button
                key={scope}
                type="button"
                aria-pressed={on}
                onClick={() =>
                  setScopes((current) =>
                    current.includes(scope)
                      ? current.filter((entry) => entry !== scope)
                      : [...current, scope],
                  )
                }
                className={
                  on
                    ? 'rounded-full bg-[var(--color-accent-soft)] px-2.5 py-1 text-xs font-medium text-[var(--color-accent-text)]'
                    : 'rounded-full border border-[var(--color-border)] px-2.5 py-1 text-xs text-[var(--color-text-muted)]'
                }
              >
                {DISPLAY_SCOPE_LABELS[scope]}
              </button>
            );
          })}
        </fieldset>
      </form>

      {error ? <p className="text-xs text-[var(--color-critical-text)]">{error}</p> : null}

      {devices.length > 0 ? (
        <ul className="flex flex-col gap-1.5">
          {devices.map((device) => (
            <li
              key={device.id}
              className="flex flex-wrap items-center gap-2 rounded-lg border border-[var(--color-border)] px-2.5 py-2 text-sm"
            >
              <Monitor className="h-4 w-4 shrink-0 text-[var(--color-text-subtle)]" aria-hidden />
              <span className="font-medium">{device.name}</span>
              <span className="font-mono text-xs text-[var(--color-text-subtle)]">
                {device.tokenPrefix}…
              </span>
              {device.revokedAt ? (
                <Badge tone="critical">Revoked</Badge>
              ) : device.lastSeenAt ? (
                <span className="text-xs text-[var(--color-text-subtle)]">
                  seen <RelativeTime iso={device.lastSeenAt} />
                </span>
              ) : (
                <span className="text-xs text-[var(--color-text-subtle)]">never connected</span>
              )}
              {!device.revokedAt ? (
                <Button
                  size="sm"
                  variant="ghost"
                  className="ml-auto"
                  disabled={busy}
                  onClick={() => void revoke(device.id)}
                >
                  Revoke
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
