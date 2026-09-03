import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { NotFoundError } from '@/domain/errors';
import {
  KNOWLEDGE_CATEGORY_LABELS,
  KNOWLEDGE_ORIGIN_LABELS,
  KNOWLEDGE_STATUS_LABELS,
} from '@/domain/knowledge';
import { requireOwnerPage } from '@/server/auth/guard';
import { getServices } from '@/server/container';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { RelativeTime } from '@/components/relative-time';

export const metadata: Metadata = { title: 'Why Jarvis remembers this' };
export const dynamic = 'force-dynamic';

/**
 * Why Jarvis remembers one thing.
 *
 * Every fact here comes from the record: the rule that decided the status, who confirmed it and
 * when, what it replaced, what it disagrees with, whether it is in the semantic index, how often
 * it has actually been used. Nothing on this page is narrated by a model, because an explanation
 * written by the same kind of thing that proposed the memory is the least trustworthy sentence
 * that could appear here.
 *
 * The one distinction the page insists on is between *retrievable* and *relied upon*. An inferred
 * note that has been approved is findable and quotable, and still is not something to build a
 * recommendation on — so it says so, in a sentence, rather than leaving the reader to infer it
 * from a badge.
 */
export default async function MemoryPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await requireOwnerPage(`/knowledge/memories/${id}`);
  const services = await getServices();

  let explanation;
  try {
    explanation = await services.memoryService.explain(id);
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    throw error;
  }

  const memory = explanation.item;
  const forgotten = memory.status === 'forgotten';

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
      <header className="flex flex-col gap-1">
        <p className="text-xs text-[var(--color-text-subtle)]">
          <Link href="/knowledge" className="hover:underline">
            Knowledge
          </Link>{' '}
          / Note
        </p>
        <h1 className="text-xl font-semibold">
          {forgotten ? 'This was forgotten' : 'Why Jarvis remembers this'}
        </h1>
      </header>

      <Card>
        <CardContent className="flex flex-col gap-2 pt-4">
          <div className="flex flex-wrap gap-1.5">
            <Badge tone={memory.status === 'active' ? 'positive' : 'neutral'}>
              {KNOWLEDGE_STATUS_LABELS[memory.status]}
            </Badge>
            <Badge tone="outline">{KNOWLEDGE_CATEGORY_LABELS[memory.category]}</Badge>
            <Badge tone={memory.origin === 'explicit' ? 'accent' : 'neutral'}>
              {KNOWLEDGE_ORIGIN_LABELS[memory.origin]}
            </Badge>
          </div>

          <p
            className={`text-base ${forgotten ? 'italic text-[var(--color-text-subtle)]' : 'text-[var(--color-text)]'}`}
          >
            {forgotten ? 'The text was removed permanently at your request.' : memory.statement}
          </p>
          {memory.detail && !forgotten ? (
            <p className="text-sm text-[var(--color-text-muted)]">{memory.detail}</p>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Can Jarvis rely on it?</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-2 pt-0">
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge tone={explanation.authoritative ? 'positive' : 'caution'}>
              {explanation.authoritative ? 'Can be relied on' : 'Can be mentioned, not relied on'}
            </Badge>
          </div>
          <p className="text-[0.8125rem] text-[var(--color-text-muted)]">
            {explanation.authorityReason}
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">How it came to be here</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-2 pt-0">
          <dl className="flex flex-col gap-1 text-[0.8125rem]">
            <div className="flex flex-wrap justify-between gap-2">
              <dt className="text-[var(--color-text-subtle)]">Recorded by</dt>
              <dd className="text-[var(--color-text-muted)]">{memory.createdBy}</dd>
            </div>
            <div className="flex flex-wrap justify-between gap-2">
              <dt className="text-[var(--color-text-subtle)]">Recorded</dt>
              <dd className="text-[var(--color-text-muted)]">
                <RelativeTime iso={memory.createdAt} />
              </dd>
            </div>
            {explanation.decidedBy ? (
              <div className="flex flex-wrap justify-between gap-2">
                <dt className="text-[var(--color-text-subtle)]">Confirmed by</dt>
                <dd className="text-[var(--color-text-muted)]">
                  {explanation.decidedBy}
                  {explanation.decidedAt ? (
                    <>
                      {', '}
                      <RelativeTime iso={explanation.decidedAt} />
                    </>
                  ) : null}
                </dd>
              </div>
            ) : null}
            {explanation.statusRule ? (
              <div className="flex flex-wrap justify-between gap-2">
                <dt className="text-[var(--color-text-subtle)]">Rule that decided this</dt>
                <dd className="font-mono text-[var(--color-text-muted)]">
                  {explanation.statusRule}
                </dd>
              </div>
            ) : null}
            <div className="flex flex-wrap justify-between gap-2">
              <dt className="text-[var(--color-text-subtle)]">Used in an answer</dt>
              <dd className="text-[var(--color-text-muted)]">
                {explanation.useCount === 0
                  ? 'never'
                  : `${explanation.useCount} time${explanation.useCount === 1 ? '' : 's'}`}
              </dd>
            </div>
            <div className="flex flex-wrap justify-between gap-2">
              <dt className="text-[var(--color-text-subtle)]">In the semantic index</dt>
              <dd className="text-[var(--color-text-muted)]">
                {explanation.embedded ? 'yes' : 'no — found by text search only'}
              </dd>
            </div>
          </dl>

          {explanation.citation.sourceId ? (
            <p className="text-[0.8125rem]">
              Read from{' '}
              <Link
                href={explanation.citation.href ?? '#'}
                className="underline hover:no-underline"
              >
                a source you gave Jarvis
              </Link>
              {explanation.citation.sourceRef ? ` (${explanation.citation.sourceRef})` : ''}.
            </p>
          ) : null}
        </CardContent>
      </Card>

      {explanation.supersedes || explanation.supersededBy ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">History</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-2 pt-0">
            {explanation.supersedes ? (
              <p className="text-[0.8125rem] text-[var(--color-text-muted)]">
                This replaced:{' '}
                <Link
                  href={`/knowledge/memories/${explanation.supersedes.id}`}
                  className="underline hover:no-underline"
                >
                  “{explanation.supersedes.statement}”
                </Link>
              </p>
            ) : null}
            {explanation.supersededBy ? (
              <p className="text-[0.8125rem] text-[var(--color-text-muted)]">
                This was replaced by:{' '}
                <Link
                  href={`/knowledge/memories/${explanation.supersededBy.id}`}
                  className="underline hover:no-underline"
                >
                  “{explanation.supersededBy.statement}”
                </Link>
              </p>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      {explanation.openConflicts.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Disagreements</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-1.5 pt-0">
            {explanation.openConflicts.map((conflict) => (
              <p key={conflict.id} className="text-[0.8125rem] text-[var(--color-text-muted)]">
                {conflict.summary}
              </p>
            ))}
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
