'use client';

import * as React from 'react';
import { CornerDownLeft, Loader2, Search, X } from 'lucide-react';
import type { QueryAnswer } from '@/domain/query';
import { Button } from '@/components/ui/button';
import { AnswerPanel } from '@/components/answer-panel';

const SUGGESTIONS = [
  'Where are we?',
  'What needs me?',
  'What changed?',
  'Which projects are blocked?',
  'What should I focus on?',
  'Show active projects',
] as const;

/**
 * The Jarvis status command bar.
 *
 * Routing is deterministic on the server; this component is purely the surface. It is built for
 * a phone first: a large tap target, a visible submit affordance, an enterKeyHint so the iOS
 * keyboard shows "go", and suggestion chips that scroll horizontally instead of wrapping.
 */
export function CommandBar({ initialHistory = [] }: { initialHistory?: readonly string[] }) {
  const [query, setQuery] = React.useState('');
  const [answer, setAnswer] = React.useState<QueryAnswer | null>(null);
  /* The words that produced the answer on screen, which a work request has to carry onwards. */
  const [asked, setAsked] = React.useState('');

  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [history, setHistory] = React.useState<readonly string[]>(initialHistory);
  const inputRef = React.useRef<HTMLInputElement>(null);
  /*
   * Keep whatever was typed before this component came alive.
   *
   * The field is controlled, so React's own hydration writes its empty initial state into the DOM,
   * and anything typed in the gap between the HTML arriving and the JavaScript attaching is wiped.
   * On a fast machine that gap is imperceptible; on a phone, or on a cold route, it is long enough
   * to lose a sentence somebody has already finished typing — and the failure is silent, because
   * the words simply vanish.
   *
   * Reading the field on mount recovers it where the value survived hydration. Where it did not,
   * the submit path below is what saves the day: it reads the field rather than the state, so what
   * gets asked is what is actually in the box.
   */
  React.useEffect(() => {
    const typedBeforeHydration = inputRef.current?.value ?? '';
    if (typedBeforeHydration.length > 0) setQuery(typedBeforeHydration);
  }, []);

  const ask = React.useCallback(async (text: string) => {
    const trimmed = text.trim();
    if (trimmed.length === 0) return;
    setPending(true);
    setError(null);
    try {
      const response = await fetch('/api/query', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: trimmed }),
      });
      if (!response.ok) throw new Error('Jarvis could not answer that.');
      const data = (await response.json()) as { answer: QueryAnswer };
      setAnswer(data.answer);
      setAsked(trimmed);
      setHistory((previous) =>
        [trimmed, ...previous.filter((item) => item !== trimmed)].slice(0, 8),
      );
    } catch {
      setError('Jarvis could not answer that just now. Check your connection and try again.');
    } finally {
      setPending(false);
    }
  }, []);

  /* "/" focuses the bar from anywhere, the way a search-first tool should behave. */
  React.useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return;
      event.preventDefault();
      inputRef.current?.focus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <section
      aria-label="Ask Jarvis"
      className="rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-surface)] shadow-[var(--shadow-card)]"
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          /*
           * The field, not the state.
           *
           * These agree in every ordinary case, and disagree in exactly one: text that arrived
           * before React attached its listeners. Asking what is in the box removes that whole
           * class of bug rather than narrowing the window in which it happens.
           */
          void ask(inputRef.current?.value ?? query);
        }}
        className="flex items-center gap-2 px-3 py-2.5"
      >
        <Search className="h-4 w-4 shrink-0 text-[var(--color-text-subtle)]" aria-hidden />
        <label htmlFor="jarvis-query" className="sr-only">
          Ask Jarvis about your projects
        </label>
        <input
          id="jarvis-query"
          ref={inputRef}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Ask Jarvis — where are we?"
          enterKeyHint="go"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          className="h-9 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-[var(--color-text-subtle)]"
        />
        {query.length > 0 ? (
          <button
            type="button"
            onClick={() => {
              setQuery('');
              inputRef.current?.focus();
            }}
            aria-label="Clear"
            className="flex h-8 w-8 items-center justify-center rounded-md text-[var(--color-text-subtle)] hover:bg-[var(--color-surface-muted)]"
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        ) : null}
        {/*
         * Disabled only while a question is in flight.
         *
         * It used to be disabled on an empty field as well, which reads as helpful and is the
         * thing that made a lost keystroke unrecoverable: the text was gone *and* the button was
         * dead, so pressing it did nothing and said nothing. Submitting an empty box is already a
         * no-op — `ask` returns immediately — so nothing is gained by refusing the press.
         */}
        <Button type="submit" size="sm" disabled={pending}>
          {pending ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
          ) : (
            <CornerDownLeft className="h-4 w-4" aria-hidden />
          )}
          <span className="sr-only sm:not-sr-only">Ask</span>
        </Button>
      </form>

      <div className="jarvis-scroll-x flex gap-2 border-t border-[var(--color-border)] px-3 py-2">
        {(history.length > 0 ? history : SUGGESTIONS).map((item) => (
          <button
            key={item}
            type="button"
            onClick={() => {
              setQuery(item);
              void ask(item);
            }}
            className="shrink-0 rounded-full border border-[var(--color-border-strong)] px-3 py-1.5 text-xs text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-surface-muted)] hover:text-[var(--color-text)]"
          >
            {item}
          </button>
        ))}
      </div>

      {error ? (
        <p
          role="alert"
          className="border-t border-[var(--color-border)] px-4 py-3 text-sm text-[var(--color-critical-text)]"
        >
          {error}
        </p>
      ) : null}

      {answer ? (
        <AnswerPanel answer={answer} asked={asked} onPick={(text) => void ask(text)} />
      ) : null}
    </section>
  );
}
