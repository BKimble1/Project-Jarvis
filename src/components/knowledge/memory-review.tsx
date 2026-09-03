'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/field';

/**
 * Reviewing what Jarvis has suggested, and managing what it already remembers.
 *
 * Two things this component is careful about.
 *
 * **A suggestion never looks like a memory.** Origin is shown on every row, in words rather than
 * as a colour, and a suggestion carries the sentence explaining why it is waiting. The screen is
 * the place where "a model guessed this" has to stay distinguishable from "I said this", because
 * once they look alike the distinction stops existing in practice.
 *
 * **Forgetting is deliberately awkward.** It asks for a typed phrase, states plainly that there
 * is no undo, and the button stays disabled until the phrase matches exactly. Every other action
 * here is reversible; this one is not, and the interface should feel different for it.
 */
export interface MemoryRow {
  readonly id: string;
  readonly statement: string;
  readonly detail: string | null;
  readonly category: string;
  readonly categoryLabel: string;
  readonly origin: string;
  readonly originLabel: string;
  readonly status: string;
  readonly statusLabel: string;
  readonly statusRule: string | null;
  readonly sensitivity: string;
  readonly scope: string;
  readonly confidence: string | null;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly forgottenAt: string | null;
  readonly useCount: number;
}

const FORGET_PHRASE = 'forget this permanently';

export function MemoryReview({ memories }: { memories: readonly MemoryRow[] }) {
  const router = useRouter();
  const [busy, setBusy] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [forgetting, setForgetting] = React.useState<string | null>(null);
  const [phrase, setPhrase] = React.useState('');

  async function decide(id: string, decision: string, confirmation?: string): Promise<void> {
    setBusy(id);
    setError(null);
    try {
      const response = await fetch(`/api/knowledge/memories/${id}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ decision, ...(confirmation ? { confirmation } : {}) }),
      });
      if (!response.ok) {
        const payload = (await response.json()) as { error?: { message?: string } };
        setError(payload.error?.message ?? 'That did not work.');
        return;
      }
      setForgetting(null);
      setPhrase('');
      router.refresh();
    } catch {
      setError('That did not work. Jarvis may be offline.');
    } finally {
      setBusy(null);
    }
  }

  if (memories.length === 0) {
    return (
      <p className="text-sm text-[var(--color-text-muted)]">
        Nothing here yet. Notes you write appear immediately; anything Jarvis suggests waits for
        you.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {error ? (
        <p role="alert" className="text-[0.8125rem] text-[var(--color-critical-text)]">
          {error}
        </p>
      ) : null}

      {memories.map((memory) => {
        const suggested = memory.status === 'suggested';
        const forgotten = memory.status === 'forgotten';

        return (
          <article
            key={memory.id}
            className="flex flex-col gap-2 rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-surface)] p-3"
          >
            <div className="flex flex-wrap items-center gap-1.5">
              <Badge tone={suggested ? 'caution' : forgotten ? 'neutral' : 'positive'}>
                {memory.statusLabel}
              </Badge>
              <Badge tone="outline">{memory.categoryLabel}</Badge>
              {/*
                Origin in words, always. "You said this" and "Inferred from what you do" are the
                whole distinction, and a colour cannot carry it.
              */}
              <Badge tone={memory.origin === 'explicit' ? 'accent' : 'neutral'}>
                {memory.originLabel}
              </Badge>
              {memory.sensitivity === 'private' ? <Badge tone="outline">Only me</Badge> : null}
              {memory.confidence ? (
                <span className="text-xs text-[var(--color-text-subtle)]">
                  model confidence: {memory.confidence}
                </span>
              ) : null}
            </div>

            <p
              className={`text-sm ${forgotten ? 'text-[var(--color-text-subtle)] italic' : 'text-[var(--color-text)]'}`}
            >
              {forgotten ? 'This was forgotten. The text is gone.' : memory.statement}
            </p>
            {memory.detail && !forgotten ? (
              <p className="text-[0.8125rem] text-[var(--color-text-muted)]">{memory.detail}</p>
            ) : null}

            {suggested ? (
              <p className="text-xs text-[var(--color-text-subtle)]">
                Waiting for you. Jarvis will not use this in an answer until you approve it.
              </p>
            ) : null}

            {!forgotten ? (
              <div className="flex flex-wrap items-center gap-1.5">
                {suggested ? (
                  <>
                    <Button
                      size="sm"
                      disabled={busy === memory.id}
                      onClick={() => decide(memory.id, 'approve')}
                    >
                      Approve
                    </Button>
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={busy === memory.id}
                      onClick={() => decide(memory.id, 'reject')}
                    >
                      Reject
                    </Button>
                  </>
                ) : null}

                {memory.status === 'active' ? (
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={busy === memory.id}
                    onClick={() => decide(memory.id, 'archive')}
                  >
                    Archive
                  </Button>
                ) : null}

                {memory.status === 'archived' || memory.status === 'rejected' ? (
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={busy === memory.id}
                    onClick={() => decide(memory.id, 'restore')}
                  >
                    Restore
                  </Button>
                ) : null}

                <Button size="sm" variant="ghost" asChild>
                  <a href={`/knowledge/memories/${memory.id}`}>Why is this here?</a>
                </Button>

                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setForgetting(forgetting === memory.id ? null : memory.id);
                    setPhrase('');
                  }}
                >
                  Forget
                </Button>
              </div>
            ) : null}

            {forgetting === memory.id ? (
              <div className="flex flex-col gap-2 rounded-lg border border-[var(--color-critical)] bg-[var(--color-critical-soft)] p-3">
                <p className="text-[0.8125rem] text-[var(--color-critical-text)]">
                  This removes the text permanently — from search, from the semantic index and from
                  exports. It cannot be undone. Jarvis keeps only a record that a deletion happened.
                </p>
                <label
                  htmlFor={`forget-${memory.id}`}
                  className="text-[0.8125rem] text-[var(--color-critical-text)]"
                >
                  Type <strong>{FORGET_PHRASE}</strong> to confirm.
                </label>
                <Input
                  id={`forget-${memory.id}`}
                  value={phrase}
                  onChange={(event) => setPhrase(event.target.value)}
                  autoComplete="off"
                />
                <div className="flex gap-1.5">
                  <Button
                    size="sm"
                    variant="danger"
                    /* Disabled until the phrase matches exactly. The server checks it again. */
                    disabled={phrase !== FORGET_PHRASE || busy === memory.id}
                    onClick={() => decide(memory.id, 'forget', phrase)}
                  >
                    Forget it permanently
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setForgetting(null)}>
                    Cancel
                  </Button>
                </div>
              </div>
            ) : null}
          </article>
        );
      })}
    </div>
  );
}
