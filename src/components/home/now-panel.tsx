'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';

import { interpretReply } from '@/domain/reply-intent';
import type { NextAction } from '@/domain/next-actions';
import { Button } from '@/components/ui/button';

/**
 * What Jarvis is doing, what it would do next, and a place to reply in one line.
 *
 * ## Why the actions are numbered
 *
 * Because "do the first one" has to mean something. A numbered list of real records is what makes
 * a one-word reply safe: the reply resolves against a list the person can see, deterministically,
 * and every item is a row that can actually be acted on. A prose list of suggestions would read
 * the same and could not be replied to at all.
 *
 * ## Why the reply is interpreted here and not by a model
 *
 * `interpretReply` is a pure function over a handful of phrases. A model would be right almost
 * always, and the one time it was wrong it would have approved something the owner was declining.
 * Anything it does not recognise is not guessed at — it becomes a question, and questions go to
 * Ask, which is where questions are answered properly with evidence.
 *
 * ## Why "no" is never a click
 *
 * Declining does nothing at all except say so. There is no "dismissed" state to write, because the
 * situation has not changed: the pull request is still unread tomorrow, and pretending otherwise
 * would quietly lose things a person meant to come back to.
 */
export function NowPanel({
  headline,
  modeLabel,
  loopExplanation,
  capacity,
  running,
  actions,
  standingAuthority,
}: {
  headline: string;
  modeLabel: string;
  loopExplanation: string;
  capacity: string | null;
  running: readonly { missionId: string; title: string; state: string }[];
  actions: readonly NextAction[];
  standingAuthority: boolean;
}) {
  const router = useRouter();
  const [reply, setReply] = React.useState('');
  const [said, setSaid] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  async function runPass() {
    setBusy(true);
    setSaid(null);
    try {
      const response = await fetch('/api/operator/tick', { method: 'PUT' });
      const payload = (await response.json().catch(() => ({}))) as {
        summary?: string;
        error?: { message?: string };
      };
      setSaid(
        response.ok
          ? (payload.summary ?? 'Done — Jarvis has had a look.')
          : (payload.error?.message ?? 'That did not work.'),
      );
      router.refresh();
    } catch {
      setSaid('Could not reach Jarvis.');
    } finally {
      setBusy(false);
    }
  }

  async function capture(text: string) {
    setBusy(true);
    setSaid(null);
    try {
      const response = await fetch('/api/knowledge/memories/capture', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      const payload = (await response.json().catch(() => ({}))) as {
        said?: string;
        error?: { message?: string };
      };
      if (response.ok) setReply('');
      setSaid(payload.said ?? payload.error?.message ?? 'That did not work.');
    } catch {
      setSaid('Could not reach Jarvis.');
    } finally {
      setBusy(false);
    }
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const text = reply.trim();
    if (text.length === 0) return;

    /*
     * Remembering first, because "remember that I always squash commits" contains no ordinal, no
     * negation and no affirmation — it would fall through to Ask, which would search for it
     * instead of keeping it. Checked here rather than server-side so the panel can say what
     * happened without a page change.
     */
    if (
      /^(?:please\s+)?(?:remember|note|make a note|keep in mind|jot down|forget|stop remembering)\b/i.test(
        text,
      )
    ) {
      await capture(text);
      return;
    }

    const intent = interpretReply(text, actions.length);

    if (intent.kind === 'decline') {
      setReply('');
      setSaid('Alright. Nothing from me, then — it will all still be here.');
      return;
    }

    if (intent.kind === 'ambiguous') {
      setSaid(`${intent.reason} Say which number, or name it.`);
      return;
    }

    if (intent.kind === 'select') {
      const chosen = actions[intent.index];
      if (!chosen) {
        setSaid('There is nothing at that number.');
        return;
      }
      setReply('');
      if (chosen.kind === 'start_opportunity' && !chosen.requiresOwner) {
        /*
         * The one case that must not become an approval screen. Under standing authority Jarvis is
         * already allowed to start this, so sending the owner to a form asking them to approve it
         * would be inventing a permission step the charter already settled. Running a pass now
         * simply asks Jarvis to get on with what it was going to do anyway.
         */
        await runPass();
        return;
      }
      router.push(chosen.href);
      return;
    }

    if (intent.kind === 'continue') {
      setReply('');
      const first = running[0];
      if (first) {
        router.push(`/missions/${first.missionId}`);
        return;
      }
      if (standingAuthority) {
        await runPass();
        return;
      }
      setSaid(
        'There is nothing running to continue. Pick one of the things above, or ask me something.',
      );
      return;
    }

    /* Not a reply to this list. It is a question, and questions belong to Ask. */
    router.push(`/ask?q=${encodeURIComponent(text)}`);
  }

  return (
    <section
      aria-label="What Jarvis is doing"
      className="flex flex-col gap-3 rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-surface)] p-4"
    >
      <div className="flex flex-col gap-1">
        <p className="text-sm font-medium">{headline}</p>
        <p className="text-xs text-[var(--color-text-muted)]">
          {modeLabel} · {loopExplanation}
          {capacity ? ` · ${capacity}` : ''}
        </p>
      </div>

      {running.length > 0 ? (
        <ul className="flex flex-col gap-1 text-sm">
          {running.map((entry) => (
            <li key={entry.missionId}>
              <Link href={`/missions/${entry.missionId}`} className="hover:underline">
                {entry.title}
              </Link>{' '}
              <span className="text-xs text-[var(--color-text-muted)]">
                {entry.state.replace(/_/g, ' ')}
              </span>
            </li>
          ))}
        </ul>
      ) : null}

      {actions.length > 0 ? (
        <ol className="flex flex-col gap-1.5">
          {actions.map((action, index) => (
            <li key={action.id} className="flex gap-2 text-sm">
              <span className="text-[var(--color-text-subtle)] tabular-nums">{index + 1}.</span>
              <span className="flex min-w-0 flex-col">
                <Link href={action.href} className="hover:underline">
                  {action.label}
                </Link>
                <span className="text-xs text-[var(--color-text-muted)]">{action.detail}</span>
              </span>
            </li>
          ))}
        </ol>
      ) : (
        <p className="text-sm text-[var(--color-text-muted)]">Nothing needs you right now.</p>
      )}

      <form onSubmit={(event) => void submit(event)} className="flex gap-2">
        <input
          value={reply}
          onChange={(event) => setReply(event.target.value)}
          placeholder={
            actions.length > 0
              ? 'Do the first one · Continue · Remember that… · Not tonight'
              : 'Ask me anything, or say “remember that…”'
          }
          aria-label="Reply to Jarvis"
          className="min-w-0 flex-1 rounded-[var(--radius-control)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm"
        />
        <Button type="submit" disabled={busy}>
          {busy ? 'Working…' : 'Send'}
        </Button>
      </form>

      {said ? <p className="text-xs text-[var(--color-text-muted)]">{said}</p> : null}
    </section>
  );
}
