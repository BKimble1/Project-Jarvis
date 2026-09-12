'use client';

import * as React from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/field';

/**
 * Search, with the reasoning shown.
 *
 * The mode banner is the part that matters. "Hybrid ready" and "Full-text only" are different
 * claims about what a search actually did, and the phase this belongs to exists partly to stop
 * the second being displayed as the first. So the mode is always shown, in words, with the
 * sentence explaining it — and when a semantic index is present the panel names the model and its
 * similarity floor, because "semantic" means something different for a language model than for a
 * hashing scheme and a reader deserves to know which one answered.
 *
 * Each result shows which channels found it. A result that only the exact-match channel found is
 * a different kind of hit from one all three agreed on, and that is worth being able to see.
 */
interface Evidence {
  readonly id: string;
  readonly kind: string;
  readonly trust: string;
  readonly title: string;
  readonly excerpt: string;
  readonly sensitivity: string;
  readonly citation: {
    readonly href: string | null;
    readonly locator: string;
    readonly ref: string | null;
    readonly refKind: string;
    readonly pageNumber: number | null;
  };
  readonly ranking: {
    readonly channels: readonly string[];
    readonly fusedScore: number;
    readonly semanticScore: number | null;
  };
}

interface Diagnostics {
  readonly mode: string;
  readonly modeLabel: string;
  readonly modeMeaning: string;
  readonly modeReason: string;
  readonly lexicalCandidates: number;
  readonly exactCandidates: number;
  readonly semanticCandidates: number;
  readonly fusedCandidates: number;
  readonly excluded: Record<string, number>;
  readonly durationMs: number;
  readonly rankingVersion: string;
  readonly semanticIndex: {
    readonly provider: string;
    readonly model: string;
    readonly dimensions: number;
    readonly minSimilarity: number;
  } | null;
}

const CHANNEL_LABELS: Record<string, string> = {
  lexical: 'text',
  lexical_exact: 'exact match',
  semantic: 'similar meaning',
};

export function RetrievalInspector({
  projects,
}: {
  projects: readonly { readonly id: string; readonly name: string }[];
}) {
  const [query, setQuery] = React.useState('');
  const [projectId, setProjectId] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [result, setResult] = React.useState<{
    evidence: readonly Evidence[];
    diagnostics: Diagnostics;
  } | null>(null);

  async function search(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (!query.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch('/api/knowledge/search', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          query,
          projectIds: projectId ? [projectId] : [],
        }),
      });
      const payload = (await response.json()) as {
        error?: { message?: string };
        evidence?: Evidence[];
        diagnostics?: Diagnostics;
      };
      if (!response.ok || !payload.diagnostics) {
        setError(payload.error?.message ?? 'That search did not run.');
        return;
      }
      setResult({ evidence: payload.evidence ?? [], diagnostics: payload.diagnostics });
    } catch {
      setError('That search did not run. Jarvis may be offline.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <form onSubmit={search} className="flex flex-col gap-2 sm:flex-row">
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="What do you want to find?"
          aria-label="Search Jarvis's knowledge"
          className="sm:flex-1"
        />
        <select
          value={projectId}
          onChange={(event) => setProjectId(event.target.value)}
          aria-label="Limit to a project"
          className="h-10 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-3 text-sm"
        >
          <option value="">Everywhere</option>
          {projects.map((project) => (
            <option key={project.id} value={project.id}>
              {project.name}
            </option>
          ))}
        </select>
        <Button type="submit" disabled={busy || !query.trim()}>
          {busy ? 'Searching…' : 'Search'}
        </Button>
      </form>

      {error ? (
        <p role="alert" className="text-[0.8125rem] text-[var(--color-critical-text)]">
          {error}
        </p>
      ) : null}

      {result ? (
        <>
          <section
            aria-label="How this search ran"
            className="flex flex-col gap-1.5 rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-surface-muted)] p-3"
          >
            <div className="flex flex-wrap items-center gap-1.5">
              <Badge tone={result.diagnostics.mode === 'hybrid_ready' ? 'positive' : 'neutral'}>
                {result.diagnostics.modeLabel}
              </Badge>
              <span className="text-xs text-[var(--color-text-muted)]">
                {result.diagnostics.durationMs} ms · ranking {result.diagnostics.rankingVersion}
              </span>
            </div>
            <p className="text-[0.8125rem] text-[var(--color-text-muted)]">
              {result.diagnostics.modeMeaning}
            </p>
            {result.diagnostics.modeReason ? (
              <p className="text-xs text-[var(--color-text-subtle)]">
                {result.diagnostics.modeReason}
              </p>
            ) : null}

            <dl className="mt-1 grid grid-cols-2 gap-x-4 gap-y-0.5 text-xs sm:grid-cols-4">
              {(
                [
                  ['Text matches', result.diagnostics.lexicalCandidates],
                  ['Exact matches', result.diagnostics.exactCandidates],
                  ['Similar meaning', result.diagnostics.semanticCandidates],
                  ['After merging', result.diagnostics.fusedCandidates],
                ] as const
              ).map(([label, value]) => (
                <div key={label} className="flex justify-between gap-2">
                  <dt className="text-[var(--color-text-subtle)]">{label}</dt>
                  <dd className="text-[var(--color-text-muted)] tabular-nums">{value}</dd>
                </div>
              ))}
            </dl>

            {/*
              Naming the index rather than just saying "hybrid". A trigram hash and a language
              model are both "semantic search" by label and are not remotely the same claim.
            */}
            {result.diagnostics.semanticIndex ? (
              <p className="text-xs text-[var(--color-text-subtle)]">
                Similar-meaning search used {result.diagnostics.semanticIndex.model} at{' '}
                {result.diagnostics.semanticIndex.dimensions} dimensions, ignoring anything scoring
                below {result.diagnostics.semanticIndex.minSimilarity}.
              </p>
            ) : (
              <p className="text-xs text-[var(--color-text-subtle)]">
                No semantic index is configured, so nothing here claims to understand meaning.
              </p>
            )}

            {Object.keys(result.diagnostics.excluded).length > 0 ? (
              <p className="text-xs text-[var(--color-text-subtle)]">
                Left out:{' '}
                {Object.entries(result.diagnostics.excluded)
                  .map(([reason, count]) => `${count} (${reason.replace(/_/g, ' ')})`)
                  .join(', ')}
                .
              </p>
            ) : null}
          </section>

          {result.evidence.length === 0 ? (
            <p className="text-sm text-[var(--color-text-muted)]">
              Nothing matched. The panel above says what was searched, so this is a real absence
              rather than a silent one.
            </p>
          ) : (
            <ol className="flex flex-col gap-2">
              {result.evidence.map((item) => (
                <li
                  key={item.id}
                  className="flex flex-col gap-1.5 rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-surface)] p-3"
                >
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Badge tone={item.kind === 'memory' ? 'accent' : 'neutral'}>
                      {item.kind === 'memory' ? 'Note' : 'Document'}
                    </Badge>
                    <Badge tone="outline">{item.trust.replace(/_/g, ' ')}</Badge>
                    {item.ranking.channels.map((channel) => (
                      <span key={channel} className="text-xs text-[var(--color-text-subtle)]">
                        {CHANNEL_LABELS[channel] ?? channel}
                      </span>
                    ))}
                  </div>

                  <p className="text-sm text-[var(--color-text)]">{item.excerpt}</p>

                  <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--color-text-subtle)]">
                    <span>{item.citation.locator}</span>
                    {item.citation.refKind === 'commit' && item.citation.ref ? (
                      <span className="font-mono">{item.citation.ref.slice(0, 7)}</span>
                    ) : null}
                    {item.citation.href ? (
                      /* Always an internal path. A citation is never an outbound link. */
                      <a href={item.citation.href} className="underline hover:no-underline">
                        Open it
                      </a>
                    ) : null}
                  </div>
                </li>
              ))}
            </ol>
          )}
        </>
      ) : null}
    </div>
  );
}
