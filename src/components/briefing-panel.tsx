import Link from 'next/link';
import { Sparkles } from 'lucide-react';
import type { PortfolioBriefing } from '@/domain/status';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ProvenanceBadge } from '@/components/provenance';

const METHOD_LABEL = {
  deterministic: 'Written by rules',
  ai_narrated: 'Written by AI from verified evidence',
  ai_failed_fallback: 'AI unavailable — written by rules',
} as const;

/** The portfolio briefing: the answer to "where are we?", above everything else. */
export function PortfolioBriefingPanel({ briefing }: { briefing: PortfolioBriefing }) {
  const { narrative, assessment } = briefing;

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-3">
        <div className="min-w-0">
          <CardTitle className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-[var(--color-accent)]" aria-hidden />
            Where we are
          </CardTitle>
          <p className="mt-1 text-sm text-[var(--color-text)]">{narrative.headline}</p>
        </div>
        <Badge tone="outline" title={METHOD_LABEL[briefing.method]}>
          {briefing.method === 'ai_narrated' ? 'AI' : 'Rules'}
        </Badge>
      </CardHeader>

      <CardContent className="grid gap-5 pt-0 sm:grid-cols-2">
        <BriefingList
          title="Important recent changes"
          items={narrative.importantChanges}
          empty="Nothing significant since the last snapshot."
          provenance="verified"
        />
        <BriefingList
          title="Decisions waiting for you"
          items={narrative.decisionsNeeded}
          empty="None."
          provenance="manual"
        />
        <div>
          <SectionTitle>Recommended focus order</SectionTitle>
          {assessment.focusOrder.length === 0 ? (
            <p className="mt-1 text-sm text-[var(--color-text-muted)]">No projects yet.</p>
          ) : (
            <ol className="mt-1 flex flex-col gap-1">
              {assessment.focusOrder.slice(0, 5).map((entry) => (
                <li key={entry.projectId} className="flex items-start gap-2 text-sm">
                  <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded bg-[var(--color-surface-muted)] text-[0.625rem] font-semibold text-[var(--color-text-muted)]">
                    {entry.rank}
                  </span>
                  <span className="min-w-0 flex-1">
                    <Link
                      href={`/projects/${entry.projectId}`}
                      className="font-medium hover:text-[var(--color-accent-text)] hover:underline"
                    >
                      {entry.projectName}
                    </Link>
                    <span className="text-[var(--color-text-muted)]"> — {entry.reason}</span>
                  </span>
                  <ProvenanceBadge level={entry.provenance} showLabel={false} className="mt-0.5" />
                </li>
              ))}
            </ol>
          )}
        </div>
        <BriefingList
          title="Important unknowns"
          items={narrative.unknowns}
          empty="Nothing flagged as unknown."
          provenance="unknown"
        />
      </CardContent>
    </Card>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-xs font-semibold tracking-wide text-[var(--color-text-subtle)] uppercase">
      {children}
    </p>
  );
}

function BriefingList({
  title,
  items,
  empty,
  provenance,
}: {
  title: string;
  items: readonly string[];
  empty: string;
  provenance: 'verified' | 'manual' | 'inferred' | 'unknown';
}) {
  return (
    <div>
      <SectionTitle>{title}</SectionTitle>
      {items.length === 0 ? (
        <p className="mt-1 text-sm text-[var(--color-text-muted)]">{empty}</p>
      ) : (
        <ul className="mt-1">
          {items.slice(0, 6).map((item, index) => (
            <li key={`${title}-${index}`} className="flex items-start gap-2 py-0.5 text-sm">
              <ProvenanceBadge level={provenance} showLabel={false} className="mt-0.5" />
              <span className="min-w-0 flex-1 break-words">{item}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
