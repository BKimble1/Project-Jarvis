import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { citationRef } from '@/domain/knowledge-revision';
import { SOURCE_KIND_LABELS } from '@/domain/knowledge-source';
import { requireOwnerPage } from '@/server/auth/guard';
import { getServices } from '@/server/container';
import { SourceActions } from '@/components/knowledge/source-actions';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { RelativeTime } from '@/components/relative-time';

export const metadata: Metadata = { title: 'Source' };
export const dynamic = 'force-dynamic';

/**
 * One source, and every revision of it.
 *
 * The revision list is why this page exists. A citation made in March names a revision, and this
 * is where a person checks that the revision is still there and what produced it — which parser,
 * at which version, from which commit or URL. A source that has been re-read three times shows
 * three revisions with the active one marked, so "has this changed since I cited it?" is a
 * question the screen answers rather than one you have to trust an answer about.
 */
export default async function SourcePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await requireOwnerPage(`/knowledge/sources/${id}`);
  const services = await getServices();

  const source = await services.knowledgeSources.findById(id);
  if (!source || source.deletedAt) notFound();

  const revisions = await services.revisions.list(source.id, 50);

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
      <header className="flex flex-col gap-1">
        <p className="text-xs text-[var(--color-text-subtle)]">
          <Link href="/knowledge" className="hover:underline">
            Knowledge
          </Link>{' '}
          / {SOURCE_KIND_LABELS[source.kind]}
        </p>
        <h1 className="text-xl font-semibold">{source.title}</h1>
        <p className="break-all text-sm text-[var(--color-text-muted)]">{source.origin}</p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">What Jarvis made of it</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-2 pt-0">
          <div className="flex flex-wrap gap-1.5">
            <Badge tone={source.state === 'failed' ? 'critical' : 'positive'}>{source.state}</Badge>
            <Badge tone="outline">{SOURCE_KIND_LABELS[source.kind]}</Badge>
            <Badge tone={source.sensitivity === 'private' ? 'caution' : 'neutral'}>
              {source.sensitivity === 'private'
                ? 'Only me'
                : source.sensitivity === 'internal'
                  ? 'Jarvis and its agents'
                  : 'Anyone'}
            </Badge>
            {source.scope === 'project' ? <Badge tone="accent">One project</Badge> : null}
          </div>

          {source.state === 'failed' ? (
            <p className="text-[0.8125rem] text-[var(--color-critical-text)]">
              {source.failureMessage}
            </p>
          ) : null}

          <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-[0.8125rem] sm:grid-cols-3">
            {(
              [
                ['Passages', String(source.chunkCount)],
                ['Characters', source.charCount.toLocaleString()],
                [
                  source.kind === 'pdf' ? 'Pages' : 'Lines',
                  source.unitCount === null ? '—' : String(source.unitCount),
                ],
                ['Revisions', String(revisions.length)],
              ] as const
            ).map(([label, value]) => (
              <div key={label} className="flex justify-between gap-2">
                <dt className="text-[var(--color-text-subtle)]">{label}</dt>
                <dd className="tabular-nums text-[var(--color-text-muted)]">{value}</dd>
              </div>
            ))}
          </dl>

          {source.truncated ? (
            <p className="text-[0.8125rem] text-[var(--color-caution-text)]">
              This was longer than Jarvis reads, so it was stored truncated. Anything past the cut
              is not searchable.
            </p>
          ) : null}

          <SourceActions
            sourceId={source.id}
            refreshable={source.refreshable}
            title={source.title}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Revisions</CardTitle>
        </CardHeader>
        <CardContent className="pt-0">
          <p className="mb-2 text-[0.8125rem] text-[var(--color-text-muted)]">
            Each revision is the exact content at one moment. Citations resolve to a revision, so
            re-reading a page never silently changes what an older answer pointed at.
          </p>
          <ol className="flex flex-col gap-1.5">
            {revisions.map((revision) => {
              const cited = citationRef(revision.provenance);
              return (
                <li
                  key={revision.id}
                  className="flex flex-col gap-1 rounded-[var(--radius-card)] border border-[var(--color-border)] p-3"
                >
                  <span className="flex flex-wrap items-center gap-1.5">
                    <span className="text-sm font-medium">Revision {revision.revisionNumber}</span>
                    {revision.isActive ? <Badge tone="positive">In use</Badge> : null}
                    {revision.state === 'failed' ? (
                      <Badge tone="critical">Failed</Badge>
                    ) : revision.state === 'superseded' ? (
                      <Badge tone="neutral">Replaced</Badge>
                    ) : null}
                  </span>
                  <span className="text-xs text-[var(--color-text-subtle)]">
                    {revision.chunkCount} passage{revision.chunkCount === 1 ? '' : 's'} ·{' '}
                    {revision.parserName}@{revision.parserVersion} · chunker{' '}
                    {revision.chunkerVersion} · read <RelativeTime iso={revision.fetchedAt} />
                  </span>
                  {cited.display ? (
                    <span className="break-all font-mono text-xs text-[var(--color-text-subtle)]">
                      {cited.display}
                    </span>
                  ) : null}
                  {revision.failureMessage ? (
                    <span className="text-xs text-[var(--color-critical-text)]">
                      {revision.failureMessage}
                    </span>
                  ) : null}
                </li>
              );
            })}
          </ol>
        </CardContent>
      </Card>
    </div>
  );
}
