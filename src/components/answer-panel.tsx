'use client';

import Link from 'next/link';
import { ArrowRight } from 'lucide-react';

import type { QueryAnswer } from '@/domain/query';
import { Button } from '@/components/ui/button';
import { ProvenanceBadge } from '@/components/provenance';
import { cn } from '@/lib/cn';

/**
 * An answer from the deterministic status router, rendered the same way everywhere it appears.
 *
 * Extracted from the command bar rather than copied, because two of the things it renders are
 * safety behaviour rather than presentation: the mission preview that stops at "prepare" and never
 * creates, and the disambiguation list that carries the owner's own words to whichever project
 * they pick. A second implementation of either would be a second place for those to drift, and
 * the drift would not look like a bug — it would look like a slightly different screen.
 */

const OPTION_CLASS =
  'flex w-full items-center justify-between rounded-lg border border-[var(--color-border-strong)] ' +
  'px-3 py-2 text-left text-sm hover:bg-[var(--color-surface-muted)]';

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

export function AnswerPanel({
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
