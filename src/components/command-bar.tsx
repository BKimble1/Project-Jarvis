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

const OPTION_CLASS =
  'flex w-full items-center justify-between rounded-lg border border-[var(--color-border-strong)] ' +
  'px-3 py-2 text-left text-sm hover:bg-[var(--color-surface-muted)]';

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
   * The field is controlled, so React's first render after hydration writes its own state into the
   * DOM — and anything typed in the gap between the HTML arriving and the JavaScript attaching is
   * silently wiped. On a fast machine that gap is imperceptible; on a slow one, on a cold route, or
   * on a phone, it is long enough to lose a sentence somebody has already finished typing, and the
   * failure is invisible: the words vanish and the button stays disabled, so pressing it does
   * nothing at all.
   *
   * Reading the field once on mount closes it. The dashboard grew heavier when the operating
   * picture moved above this bar, which is what turned a race that was theoretically lost into one
   * that was reliably lost.
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

      {answer ? (
        <AnswerPanel answer={answer} asked={asked} onPick={(text) => void ask(text)} />
      ) : null}
    </section>
  );
}

/**
 * The missions screen, carrying the request that produced this answer.
 *
 * The command bar cannot create a mission and must not try — a mission the owner has not reviewed
 * is the one thing this product refuses to produce. So it hands the raw words, and the project
 * when one is settled, to MissionStartBar, which prepares the draft and asks for the second press.
 */
const missionHref = (request: string, projectId: string | null): string =>
  `/missions?request=${encodeURIComponent(request)}` +
  (projectId ? `&projectId=${encodeURIComponent(projectId)}` : '');

function AnswerPanel({
  answer,
  asked,
  onPick,
}: {
  answer: QueryAnswer;
  asked: string;
  onPick: (text: string) => void;
}) {
  /*
   * An ambiguous project name is answered before any preview is built, so the request has to be
   * recovered from what was typed in that case. Either way the owner's own words travel on: a
   * work request narrowed to a project is still that request, not a status question about it.
   */
  const workRequest =
    answer.intent === 'execution_request' ? (answer.missionPreview?.rawRequest ?? asked) : null;

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
              {workRequest ? (
                <Link href={missionHref(workRequest, option.id)} className={OPTION_CLASS}>
                  {option.name}
                  <ArrowRight className="h-4 w-4 text-[var(--color-text-subtle)]" aria-hidden />
                </Link>
              ) : (
                <button
                  type="button"
                  onClick={() => onPick(`Where are we on ${option.name}?`)}
                  className={OPTION_CLASS}
                >
                  {option.name}
                  <ArrowRight className="h-4 w-4 text-[var(--color-text-subtle)]" aria-hidden />
                </button>
              )}
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

      {answer.missionPreview ? (
        <div className="mt-3 border-t border-[var(--color-border)] pt-3">
          <Button asChild size="sm">
            <Link
              href={missionHref(answer.missionPreview.rawRequest, answer.missionPreview.projectId)}
            >
              Prepare this mission
              <ArrowRight className="h-4 w-4" aria-hidden />
            </Link>
          </Button>
          <p className="mt-2 text-xs text-[var(--color-text-subtle)]">
            Opens the missions screen with these words already in it.{' '}
            {answer.missionPreview.projectId ? null : 'You choose the project there. '}Nothing is
            created until you confirm it.
          </p>
        </div>
      ) : null}

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
