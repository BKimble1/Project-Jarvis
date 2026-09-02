'use client';

import * as React from 'react';
import Link from 'next/link';
import { ArrowRight, CornerDownLeft, Loader2, Search, X } from 'lucide-react';
import type { QueryAnswer } from '@/domain/query';
import { Button } from '@/components/ui/button';
import { ProvenanceBadge } from '@/components/provenance';
import { cn } from '@/lib/cn';

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
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [history, setHistory] = React.useState<readonly string[]>(initialHistory);
  const inputRef = React.useRef<HTMLInputElement>(null);

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
          void ask(query);
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
        <Button type="submit" size="sm" disabled={pending || query.trim().length === 0}>
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

      {answer ? <AnswerPanel answer={answer} onPick={(text) => void ask(text)} /> : null}
    </section>
  );
}

function AnswerPanel({ answer, onPick }: { answer: QueryAnswer; onPick: (text: string) => void }) {
  return (
    <div className="border-t border-[var(--color-border)] px-4 py-4">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-semibold">{answer.title}</h3>
        <ProvenanceBadge level={answer.summaryProvenance} />
      </div>
      <p className="mt-1 text-sm text-[var(--color-text-muted)]">{answer.summary}</p>

      {answer.notice ? (
        <p className="mt-3 rounded-lg bg-[var(--color-caution-soft)] px-3 py-2 text-xs text-[var(--color-caution-text)]">
          {answer.notice}
        </p>
      ) : null}

      {answer.disambiguation ? (
        <ul className="mt-3 flex flex-col gap-1.5">
          {answer.disambiguation.map((option) => (
            <li key={option.id}>
              <button
                type="button"
                onClick={() => onPick(`Where are we on ${option.name}?`)}
                className="flex w-full items-center justify-between rounded-lg border border-[var(--color-border-strong)] px-3 py-2 text-left text-sm hover:bg-[var(--color-surface-muted)]"
              >
                {option.name}
                <ArrowRight className="h-4 w-4 text-[var(--color-text-subtle)]" aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      <div className="mt-3 grid gap-4 sm:grid-cols-2">
        {answer.sections
          .filter((section) => section.items.length > 0)
          .map((section) => (
            <div key={section.label}>
              <p className="text-xs font-semibold tracking-wide text-[var(--color-text-subtle)] uppercase">
                {section.label}
              </p>
              <ul className="mt-1">
                {section.items.map((item, index) => (
                  <li
                    key={`${section.label}-${index}`}
                    className="flex items-start gap-2 py-1 text-sm"
                  >
                    <ProvenanceBadge level={item.provenance} showLabel={false} className="mt-0.5" />
                    <span className="min-w-0 flex-1 break-words">
                      {item.href ? (
                        <Link href={item.href} className="hover:underline">
                          {item.text}
                        </Link>
                      ) : (
                        item.text
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
      </div>

      {answer.href ? (
        <Link
          href={answer.href}
          className={cn(
            'mt-3 inline-flex items-center gap-1 text-sm font-medium text-[var(--color-accent-text)] hover:underline',
          )}
        >
          Open full view
          <ArrowRight className="h-3.5 w-3.5" aria-hidden />
        </Link>
      ) : null}
    </div>
  );
}
