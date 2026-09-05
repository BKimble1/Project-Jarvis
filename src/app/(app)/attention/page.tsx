import type { Metadata } from 'next';
import Link from 'next/link';
import { CheckCircle2 } from 'lucide-react';
import { getServices } from '@/server/container';
import type { AttentionItem } from '@/server/services/attention-service';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Badge } from '@/components/ui/badge';
import { ProvenanceBadge } from '@/components/provenance';
import {
  DisconnectedWorkers,
  MissionAttention,
  groupMissionAttention,
} from '@/components/mission/mission-attention';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'What needs me' };

/**
 * The attention view.
 *
 * Only actionable, rule-backed situations appear here. If a project is simply quiet, it is not
 * on this page — silence is not an alarm.
 *
 * Since Prompt 2 it also carries mission decisions, and they come first: an agent stopped dead
 * waiting for a permission decision is more urgent than anything the status engine flags.
 */
export default async function AttentionPage() {
  const services = await getServices();
  const groups = await services.attention.collect();

  const [missionPage, stalled, workers] = await Promise.all([
    services.missions.list({ limit: 100 }),
    services.missions.listStalled(),
    services.missions.workerHealth(),
  ]);
  const missionGroups = groupMissionAttention(
    missionPage.items,
    new Set(stalled.map((mission) => mission.id)),
  );

  /* The sidebar badge counts projects; this page counts items. Saying both keeps them reconciled. */
  const projectCount = new Set(
    [
      ...groups.decisions,
      ...groups.blockers,
      ...groups.failedBuilds,
      ...groups.failedSyncs,
      ...groups.stale,
      ...groups.overdue,
      ...groups.other,
    ].map((item) => item.projectId),
  ).size;

  const sections: readonly {
    title: string;
    description: string;
    items: readonly AttentionItem[];
  }[] = [
    {
      title: 'Decisions required',
      description: 'Nothing can move until you decide.',
      items: groups.decisions,
    },
    {
      title: 'Active blockers',
      description: 'Recorded as blocking progress.',
      items: groups.blockers,
    },
    {
      title: 'Failed builds',
      description: 'The most recent run of these workflows failed.',
      items: groups.failedBuilds,
    },
    {
      title: 'Failed synchronisations',
      description: 'Jarvis could not refresh these. The data shown elsewhere is last-known-good.',
      items: groups.failedSyncs,
    },
    { title: 'Overdue', description: 'Past a date you set.', items: groups.overdue },
    {
      title: 'Stale projects',
      description: 'No new evidence for a while. Their current state is unknown.',
      items: groups.stale,
    },
    { title: 'Other', description: 'Everything else Jarvis flagged.', items: groups.other },
  ];

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-4">
      <header>
        <h1 className="text-lg font-semibold sm:text-xl">What needs me</h1>
        <p className="text-sm text-[var(--color-text-muted)]">
          {groups.total === 0 && missionGroups.total === 0
            ? 'Nothing is waiting on you.'
            : [
                missionGroups.total > 0
                  ? `${missionGroups.total} mission decision${missionGroups.total === 1 ? '' : 's'}`
                  : null,
                groups.total > 0
                  ? `${groups.total} project item${groups.total === 1 ? '' : 's'} across ${projectCount} project${projectCount === 1 ? '' : 's'}`
                  : null,
              ]
                .filter(Boolean)
                .join(' and ') + ', most serious first.'}
        </p>
      </header>

      <MissionAttention groups={missionGroups} />
      <DisconnectedWorkers workers={workers} />

      {groups.total === 0 && missionGroups.total === 0 ? (
        <EmptyState
          tone="positive"
          icon={<CheckCircle2 className="h-6 w-6 text-[var(--color-positive)]" aria-hidden />}
          title="Nothing needs you right now"
          description="No decisions are outstanding, no blockers are open, no builds are failing and every source synchronised successfully."
        />
      ) : (
        sections
          .filter((section) => section.items.length > 0)
          .map((section) => (
            <Card key={section.title}>
              <CardHeader>
                <CardTitle className="text-sm">
                  {section.title}{' '}
                  <span className="font-normal text-[var(--color-text-subtle)]">
                    ({section.items.length})
                  </span>
                </CardTitle>
                <p className="text-xs text-[var(--color-text-muted)]">{section.description}</p>
              </CardHeader>
              <CardContent className="pt-0">
                <ul className="flex flex-col divide-y divide-[var(--color-border)]">
                  {section.items.map((item, index) => (
                    <li
                      key={`${item.projectId}-${index}`}
                      className="flex items-start gap-2 py-2.5"
                    >
                      <ProvenanceBadge
                        level={item.reason.provenance}
                        showLabel={false}
                        className="mt-0.5"
                      />
                      <div className="min-w-0 flex-1">
                        <Link
                          href={`/projects/${item.projectId}`}
                          className="text-sm font-medium hover:text-[var(--color-accent-text)] hover:underline"
                        >
                          {item.projectName}
                        </Link>
                        <p className="mt-0.5 text-sm text-[var(--color-text-muted)]">
                          {item.reason.summary}
                        </p>
                      </div>
                      <Badge
                        tone={
                          item.reason.severity === 'critical'
                            ? 'critical'
                            : item.reason.severity === 'high'
                              ? 'caution'
                              : 'neutral'
                        }
                      >
                        {item.reason.severity}
                      </Badge>
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
