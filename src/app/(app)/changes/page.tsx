import type { Metadata } from 'next';
import Link from 'next/link';
import { getServices } from '@/server/container';
import type { ChangeKind } from '@/domain/status';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Badge } from '@/components/ui/badge';
import { ProvenanceBadge } from '@/components/provenance';
import { RelativeTime } from '@/components/relative-time';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'What changed' };

const CHANGE_LABELS: Record<ChangeKind, string> = {
  work_completed: 'Completed',
  blocker_added: 'New blocker',
  blocker_resolved: 'Blocker cleared',
  status_changed: 'Status',
  phase_changed: 'Phase',
  workflow_failed: 'Build failed',
  workflow_recovered: 'Build recovered',
  pr_opened: 'PR opened',
  pr_merged: 'PR merged',
  decision_recorded: 'Decision',
  next_actions_changed: 'Next actions',
};

const CHANGE_TONE: Record<ChangeKind, 'positive' | 'critical' | 'caution' | 'neutral' | 'accent'> =
  {
    work_completed: 'positive',
    blocker_added: 'critical',
    blocker_resolved: 'positive',
    status_changed: 'accent',
    phase_changed: 'accent',
    workflow_failed: 'critical',
    workflow_recovered: 'positive',
    pr_opened: 'neutral',
    pr_merged: 'positive',
    decision_recorded: 'accent',
    next_actions_changed: 'neutral',
  };

/**
 * "What changed" compares meaningful snapshots.
 *
 * A project whose only difference is a newer timestamp does not appear here — the comparison is
 * driven by the assessment fingerprint, not by row modification times.
 */
export default async function ChangesPage() {
  const services = await getServices();
  const changes = await services.briefings.changesForPortfolio();

  type Change = (typeof changes)[number];
  const byDay = new Map<string, Change[]>();
  for (const change of changes) {
    const day = change.occurredAt.slice(0, 10);
    const bucket = byDay.get(day);
    if (bucket) bucket.push(change);
    else byDay.set(day, [change]);
  }

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-4">
      <header>
        <h1 className="text-lg font-semibold sm:text-xl">What changed</h1>
        <p className="text-sm text-[var(--color-text-muted)]">
          Meaningful differences between snapshots — not every timestamp update.
        </p>
      </header>

      {changes.length === 0 ? (
        <EmptyState
          title="Nothing meaningful has changed"
          description="Jarvis compares each project against its previous snapshot. When work merges, a build breaks, a blocker appears or a status moves, it will show up here."
        />
      ) : (
        [...byDay.entries()].map(([day, entries]) => (
          <Card key={day}>
            <CardHeader>
              <CardTitle className="text-sm">
                <RelativeTime iso={`${day}T12:00:00.000Z`} />
              </CardTitle>
            </CardHeader>
            <CardContent className="pt-0">
              <ul className="flex flex-col divide-y divide-[var(--color-border)]">
                {entries.map((change, index) => (
                  <li
                    key={`${change.projectId}-${index}`}
                    className="flex items-start gap-2 py-2.5"
                  >
                    <Badge tone={CHANGE_TONE[change.kind]}>{CHANGE_LABELS[change.kind]}</Badge>
                    <div className="min-w-0 flex-1">
                      <Link
                        href={`/projects/${change.projectId}`}
                        className="text-sm font-medium hover:text-[var(--color-accent-text)] hover:underline"
                      >
                        {change.projectName}
                      </Link>
                      <p className="mt-0.5 text-sm text-[var(--color-text-muted)]">
                        {change.summary}
                      </p>
                      {change.detail ? (
                        <p className="mt-0.5 text-xs text-[var(--color-text-subtle)]">
                          {change.detail}
                        </p>
                      ) : null}
                    </div>
                    <ProvenanceBadge
                      level={change.provenance}
                      showLabel={false}
                      className="mt-0.5"
                    />
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        ))
      )}
    </div>
  );
}
