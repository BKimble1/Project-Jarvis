import type { Metadata } from 'next';
import Link from 'next/link';
import {
  KNOWLEDGE_CATEGORY_LABELS,
  KNOWLEDGE_ORIGIN_LABELS,
  KNOWLEDGE_STATUS_LABELS,
  isContentDestroyed,
} from '@/domain/knowledge';
import { SOURCE_KIND_LABELS } from '@/domain/knowledge-source';
import { requireOwnerPage } from '@/server/auth/guard';
import { getServices } from '@/server/container';
import { AddSource } from '@/components/knowledge/add-source';
import { MemoryReview, type MemoryRow } from '@/components/knowledge/memory-review';
import { RetrievalInspector } from '@/components/knowledge/retrieval-inspector';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { RelativeTime } from '@/components/relative-time';

export const metadata: Metadata = { title: 'Knowledge' };
export const dynamic = 'force-dynamic';

/**
 * What Jarvis has read, and what it remembers.
 *
 * The page is arranged around a distinction rather than around a data model. Sources are material
 * Jarvis was *given*; memories are things it has been *told* or has *guessed*. Those are different
 * kinds of claim and the screen keeps them apart, with the review queue at the top because a
 * suggestion nobody looks at is the failure mode this whole subsystem is built to prevent.
 *
 * Every count here is a real count from the database. There is no "healthy" summary: a source
 * that failed to parse says so, with the reason, next to the ones that worked.
 */
export default async function KnowledgePage() {
  await requireOwnerPage('/knowledge');
  const services = await getServices();

  const [sources, allMemories, conflicts, projectPage] = await Promise.all([
    services.knowledgeSources.list({ limit: 200 }),
    services.knowledge.list({ limit: 300 }),
    services.conflicts.list('open'),
    services.projects.list(),
  ]);

  const projects = projectPage.items.map((project) => ({ id: project.id, name: project.name }));
  const suggestions = allMemories.filter((memory) => memory.status === 'suggested');
  const active = allMemories.filter((memory) => memory.status === 'active');
  const other = allMemories.filter(
    (memory) => memory.status !== 'suggested' && memory.status !== 'active',
  );

  const toRow = (memory: (typeof allMemories)[number]): MemoryRow => ({
    id: memory.id,
    statement: memory.statement,
    detail: memory.detail,
    category: memory.category,
    categoryLabel: KNOWLEDGE_CATEGORY_LABELS[memory.category],
    origin: memory.origin,
    originLabel: KNOWLEDGE_ORIGIN_LABELS[memory.origin],
    status: memory.status,
    statusLabel: KNOWLEDGE_STATUS_LABELS[memory.status],
    statusRule: memory.statusRule,
    sensitivity: memory.sensitivity,
    scope: memory.scope,
    confidence: memory.confidence,
    createdBy: memory.createdBy,
    createdAt: memory.createdAt,
    forgottenAt: memory.forgottenAt,
    useCount: memory.useCount,
  });

  const failed = sources.filter((source) => source.state === 'failed');

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-4">
      <header className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold">What Jarvis knows</h1>
        <p className="text-sm text-[var(--color-text-muted)]">
          Material you gave it to read, and notes about how you work. Anything Jarvis merely
          suggested waits here until you approve it.
        </p>
      </header>

      {suggestions.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">
              Waiting for you
              <Badge tone="caution" className="ml-2">
                {suggestions.length}
              </Badge>
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-0">
            <p className="mb-2 text-[0.8125rem] text-[var(--color-text-muted)]">
              Jarvis proposed these. None of them is used in an answer until you say so, and
              nothing that proposed one can approve it.
            </p>
            <MemoryReview memories={suggestions.map(toRow)} />
          </CardContent>
        </Card>
      ) : null}

      {conflicts.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">
              Things that disagree
              <Badge tone="caution" className="ml-2">
                {conflicts.length}
              </Badge>
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-2 pt-0">
            <p className="text-[0.8125rem] text-[var(--color-text-muted)]">
              Both statements are still in use. Jarvis will not pick a winner on your behalf.
            </p>
            {conflicts.map((conflict) => (
              <p key={conflict.id} className="text-[0.8125rem] text-[var(--color-text)]">
                {conflict.summary}
              </p>
            ))}
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Search what Jarvis knows</CardTitle>
        </CardHeader>
        <CardContent className="pt-0">
          <RetrievalInspector projects={projects} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Give Jarvis something to read</CardTitle>
        </CardHeader>
        <CardContent className="pt-0">
          <AddSource projects={projects} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">
            Sources
            <Badge tone="neutral" className="ml-2">
              {sources.length}
            </Badge>
            {failed.length > 0 ? (
              <Badge tone="critical" className="ml-1">
                {failed.length} failed
              </Badge>
            ) : null}
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-0">
          {sources.length === 0 ? (
            <p className="text-sm text-[var(--color-text-muted)]">
              Nothing yet. Add a note, a file, an approved web page or a file from a
              project&rsquo;s repository.
            </p>
          ) : (
            <ul className="flex flex-col gap-1.5">
              {sources.map((source) => (
                <li key={source.id}>
                  <Link
                    href={`/knowledge/sources/${source.id}`}
                    className="flex flex-col gap-1 rounded-[var(--radius-card)] border border-[var(--color-border)] p-3 transition-colors hover:bg-[var(--color-surface-muted)]"
                  >
                    <span className="flex flex-wrap items-center gap-1.5">
                      <span className="text-sm font-medium">{source.title}</span>
                      <Badge tone="outline">{SOURCE_KIND_LABELS[source.kind]}</Badge>
                      {source.state === 'failed' ? (
                        <Badge tone="critical">Could not be read</Badge>
                      ) : null}
                      {source.sensitivity === 'private' ? (
                        <Badge tone="outline">Only me</Badge>
                      ) : null}
                      {source.scope === 'project' ? <Badge tone="accent">One project</Badge> : null}
                    </span>
                    {source.state === 'failed' ? (
                      <span className="text-[0.8125rem] text-[var(--color-critical-text)]">
                        {source.failureMessage}
                      </span>
                    ) : (
                      <span className="text-xs text-[var(--color-text-subtle)]">
                        {source.chunkCount} passage{source.chunkCount === 1 ? '' : 's'} ·{' '}
                        {source.origin}
                        {source.lastRefreshedAt ? (
                          <>
                            {' '}
                            · re-read <RelativeTime iso={source.lastRefreshedAt} />
                          </>
                        ) : null}
                      </span>
                    )}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">
            Notes in use
            <Badge tone="neutral" className="ml-2">
              {active.length}
            </Badge>
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-0">
          <MemoryReview memories={active.map(toRow)} />
        </CardContent>
      </Card>

      {other.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Not in use</CardTitle>
          </CardHeader>
          <CardContent className="pt-0">
            <p className="mb-2 text-[0.8125rem] text-[var(--color-text-muted)]">
              Archived, rejected, replaced and forgotten notes.{' '}
              {other.filter((memory) => isContentDestroyed(memory.status)).length > 0
                ? 'A forgotten note keeps only the record that it was removed.'
                : ''}
            </p>
            <MemoryReview memories={other.map(toRow)} />
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
