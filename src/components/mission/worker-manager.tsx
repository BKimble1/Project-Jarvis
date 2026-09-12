'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Copy, KeyRound, Loader2, Plus, ShieldOff, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import type { WorkerEnrolment, WorkerHealth } from '@/domain/worker';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Field, Input } from '@/components/ui/field';
import { RelativeTime } from '@/components/relative-time';
import { WorkerStatusPill } from './mission-pills';

/**
 * Worker enrolment and health.
 *
 * The enrolment token is shown once, immediately after it is created, and never again — the
 * server keeps only a SHA-256 hash and an eight-character prefix, so there is nothing left to
 * show. The panel says so plainly rather than leaving the owner to discover it.
 */
export function WorkerManager({ workers }: { workers: readonly WorkerHealth[] }) {
  const router = useRouter();
  const [issued, setIssued] = React.useState<WorkerEnrolment | null>(null);
  const [name, setName] = React.useState('');
  const [pending, setPending] = React.useState<string | null>(null);

  const enrol = async (event: React.FormEvent) => {
    event.preventDefault();
    if (name.trim().length < 2) return;
    setPending('enrol');
    try {
      const response = await fetch('/api/workers', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), maxConcurrency: 1 }),
      });
      const body = (await response.json()) as WorkerEnrolment & { error?: { message: string } };
      if (!response.ok) {
        toast.error(body.error?.message ?? 'That worker could not be enrolled.');
        return;
      }
      setIssued(body);
      setName('');
      router.refresh();
    } catch {
      toast.error('Could not reach the server.');
    } finally {
      setPending(null);
    }
  };

  const act = async (id: string, action: 'rotate' | 'revoke' | 'delete') => {
    if (
      action === 'revoke' &&
      !window.confirm(
        'Revoke this worker? Its token stops working immediately. Any mission it holds is preserved, not failed.',
      )
    )
      return;
    if (action === 'delete' && !window.confirm('Remove this worker from the list entirely?'))
      return;

    setPending(`${action}-${id}`);
    try {
      const response = await fetch(
        action === 'delete' ? `/api/workers/${id}` : `/api/workers/${id}/${action}`,
        {
          method: action === 'delete' ? 'DELETE' : 'POST',
          headers: { 'content-type': 'application/json' },
          ...(action === 'revoke'
            ? { body: JSON.stringify({ reason: 'Revoked from the workers page.' }) }
            : {}),
        },
      );
      const body = (await response.json()) as WorkerEnrolment & { error?: { message: string } };
      if (!response.ok) {
        toast.error(body.error?.message ?? 'That did not work.');
        return;
      }
      if (action === 'rotate') {
        setIssued(body);
        toast.success('New token issued. The old one no longer works.');
      } else {
        toast.success(action === 'revoke' ? 'Worker revoked.' : 'Worker removed.');
      }
      router.refresh();
    } catch {
      toast.error('Could not reach the server.');
    } finally {
      setPending(null);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      {issued ? <TokenPanel enrolment={issued} onDismiss={() => setIssued(null)} /> : null}

      <Card>
        <CardHeader>
          <CardTitle>Connected workers</CardTitle>
          <p className="text-sm text-[var(--color-text-muted)]">
            A worker is the long-lived process that actually runs missions. Jarvis itself cannot — a
            serverless request is over in seconds and a mission takes minutes.
          </p>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 pt-0">
          {workers.length === 0 ? (
            <EmptyState
              title="No workers enrolled"
              description="Enrol one below, then start it with the token on your own machine, in Docker, or on a small VM. Setup is in docs/WORKER.md."
            />
          ) : (
            <ul className="flex flex-col gap-2">
              {workers.map((health) => (
                <li
                  key={health.worker.id}
                  className="rounded-[var(--radius-card)] border border-[var(--color-border)] px-3 py-3"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="min-w-0">
                      <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                        {health.worker.name}
                        <WorkerStatusPill status={health.effectiveStatus} />
                      </p>
                      <p className="mt-0.5 text-xs text-[var(--color-text-muted)]">
                        {health.explanation}
                      </p>
                    </div>
                  </div>

                  <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-[0.6875rem] sm:grid-cols-4">
                    <Fact label="Token" value={`${health.worker.tokenPrefix}…`} />
                    <Fact label="Version" value={health.worker.version ?? '—'} />
                    <Fact
                      label="Last heartbeat"
                      value={<RelativeTime iso={health.worker.lastHeartbeatAt} />}
                    />
                    <Fact
                      label="Concurrency"
                      value={`${health.worker.maxConcurrency} mission at a time`}
                    />
                    <Fact
                      label="Claude runtime"
                      value={health.worker.runtimeAvailable ? 'Available' : 'Unavailable'}
                    />
                    <Fact
                      label="GitHub delivery"
                      value={
                        health.worker.githubDeliveryConfigured ? 'Configured' : 'Not configured'
                      }
                    />
                    <Fact label="Platform" value={health.worker.platform ?? '—'} />
                    <Fact label="Workspaces" value={health.worker.workspaceRootLabel ?? '—'} />
                  </dl>

                  {health.worker.diagnostics.length > 0 ? (
                    <ul className="mt-2 flex flex-col gap-1">
                      {health.worker.diagnostics.map((note, index) => (
                        <li
                          key={index}
                          className="rounded bg-[var(--color-caution-soft)] px-2 py-1 text-[0.6875rem] text-[var(--color-caution-text)]"
                        >
                          {note}
                        </li>
                      ))}
                    </ul>
                  ) : null}

                  <div className="mt-3 flex flex-wrap gap-2">
                    <Button
                      type="button"
                      size="sm"
                      variant="secondary"
                      disabled={pending !== null}
                      onClick={() => void act(health.worker.id, 'rotate')}
                    >
                      {pending === `rotate-${health.worker.id}` ? (
                        <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                      ) : (
                        <KeyRound className="h-4 w-4" aria-hidden />
                      )}
                      Rotate token
                    </Button>
                    {health.worker.revokedAt ? null : (
                      <Button
                        type="button"
                        size="sm"
                        variant="secondary"
                        disabled={pending !== null}
                        onClick={() => void act(health.worker.id, 'revoke')}
                      >
                        <ShieldOff className="h-4 w-4" aria-hidden />
                        Revoke
                      </Button>
                    )}
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      disabled={pending !== null}
                      onClick={() => void act(health.worker.id, 'delete')}
                    >
                      <Trash2 className="h-4 w-4" aria-hidden />
                      Remove
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}

          <form
            className="flex flex-col gap-2 border-t border-[var(--color-border)] pt-3"
            onSubmit={enrol}
          >
            <Field
              label="Enrol a new worker"
              htmlFor="worker-name"
              hint="A name you will recognise, like “macbook” or “home-server”."
            >
              <Input
                id="worker-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="macbook"
                minLength={2}
                maxLength={80}
              />
            </Field>
            <Button
              type="submit"
              size="sm"
              className="self-start"
              disabled={pending !== null || name.trim().length < 2}
            >
              {pending === 'enrol' ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              ) : (
                <Plus className="h-4 w-4" aria-hidden />
              )}
              Enrol worker
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}

function TokenPanel({
  enrolment,
  onDismiss,
}: {
  enrolment: WorkerEnrolment;
  onDismiss: () => void;
}) {
  return (
    <Card className="border-[var(--color-accent)]/50">
      <CardHeader>
        <CardTitle className="text-sm">Token for {enrolment.worker.name}</CardTitle>
        <p className="text-xs text-[var(--color-caution-text)]">
          This is the only time this value is ever shown. Jarvis stores a hash of it and cannot
          display it again — if you lose it, rotate the token.
        </p>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 pt-0">
        <code className="jarvis-scroll-x block rounded-lg bg-[var(--color-surface-muted)] px-3 py-2.5 font-mono text-xs break-all">
          {enrolment.token}
        </code>
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            size="sm"
            variant="secondary"
            onClick={() => {
              void navigator.clipboard
                .writeText(enrolment.token)
                .then(() => toast.success('Copied.'))
                .catch(() => toast.error('Could not copy. Select it and copy manually.'));
            }}
          >
            <Copy className="h-4 w-4" aria-hidden />
            Copy
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={onDismiss}>
            I have saved it
          </Button>
        </div>
        <div>
          <p className="text-xs font-medium">Then, on the machine that will run missions:</p>
          <pre className="jarvis-scroll-x mt-1 rounded-lg bg-[var(--color-surface-muted)] p-3 text-[0.6875rem]">
            {`export JARVIS_CONTROL_PLANE_URL=<this Jarvis URL>
export JARVIS_WORKER_TOKEN=<the token above>
export ANTHROPIC_API_KEY=<your Anthropic key>
export JARVIS_WORKER_GITHUB_TOKEN=<a fine-grained token: Contents + Pull requests, read and write>
npm run worker`}
          </pre>
          <p className="mt-1 text-xs text-[var(--color-text-muted)]">
            Windows, WSL and Docker instructions are in docs/WORKER.md.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

function Fact({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <dt className="tracking-wide text-[var(--color-text-subtle)] uppercase">{label}</dt>
      <dd
        className="mt-0.5 truncate font-medium"
        title={typeof value === 'string' ? value : undefined}
      >
        {value}
      </dd>
    </div>
  );
}
