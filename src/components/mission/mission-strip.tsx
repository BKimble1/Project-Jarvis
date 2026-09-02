import * as React from 'react';
import Link from 'next/link';
import { ArrowRight, Rocket } from 'lucide-react';
import type { MissionCounts, MissionSummary } from '@/domain/mission';
import { Card, CardContent } from '@/components/ui/card';
import { RelativeTime } from '@/components/relative-time';
import { MissionStatePill } from './mission-pills';

/**
 * The dashboard's mission summary.
 *
 * Shown only when there is something to say. An empty strip on a dashboard is noise, and a
 * "0 missions running" tile trains the eye to skip the row that will one day matter.
 *
 * The counts are careful about one thing in particular: a mission whose worker has gone quiet is
 * reported separately from one that is genuinely running, because Jarvis cannot honestly claim
 * progress it is not being told about.
 */
export function MissionStrip({
  counts,
  missions,
}: {
  counts: MissionCounts;
  missions: readonly MissionSummary[];
}) {
  const notable = missions
    .filter((entry) => entry.mission.state !== 'completed' && entry.mission.state !== 'cancelled')
    .slice(0, 4);

  if (counts.total === 0) return null;

  const tiles = [
    { label: 'Running', value: counts.running, href: '/missions?filter=running' },
    {
      label: 'Need you',
      value: counts.awaitingApproval + counts.needsPermission + counts.needsClarification,
      href: '/missions?filter=needs-me',
    },
    { label: 'Draft PRs', value: counts.prReady, href: '/missions?filter=pr' },
    { label: 'Failed', value: counts.failed, href: '/missions?filter=failed' },
  ].filter((tile) => tile.value > 0);

  return (
    <Card>
      <CardContent className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="flex items-center gap-2 text-sm font-semibold">
            <Rocket className="h-4 w-4" aria-hidden />
            Missions
          </p>
          <Link
            href="/missions"
            className="inline-flex items-center gap-1 text-xs text-[var(--color-accent-text)] hover:underline"
          >
            All missions
            <ArrowRight className="h-3 w-3" aria-hidden />
          </Link>
        </div>

        {counts.stalled > 0 ? (
          <p className="rounded-lg bg-[var(--color-caution-soft)] px-3 py-2 text-xs text-[var(--color-caution-text)]">
            {counts.stalled} mission{counts.stalled === 1 ? '' : 's'} show as active but{' '}
            {counts.stalled === 1 ? 'its worker has' : 'their workers have'} stopped reporting.
            Nothing has been marked complete or failed.
          </p>
        ) : null}

        {tiles.length > 0 ? (
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {tiles.map((tile) => (
              <Link
                key={tile.label}
                href={tile.href}
                className="rounded-lg border border-[var(--color-border)] px-3 py-2 transition-colors hover:border-[var(--color-border-strong)]"
              >
                <p className="text-lg font-semibold tabular-nums">{tile.value}</p>
                <p className="text-xs text-[var(--color-text-muted)]">{tile.label}</p>
              </Link>
            ))}
          </div>
        ) : null}

        {notable.length > 0 ? (
          <ul className="flex flex-col divide-y divide-[var(--color-border)]">
            {notable.map((entry) => (
              <li key={entry.mission.id}>
                <Link
                  href={`/missions/${entry.mission.id}`}
                  className="flex items-center gap-2 py-2 hover:text-[var(--color-accent-text)]"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm">{entry.mission.title}</p>
                    <p className="text-xs text-[var(--color-text-muted)]">
                      {entry.projectName ?? 'No project'} ·{' '}
                      <RelativeTime iso={entry.mission.updatedAt} />
                    </p>
                  </div>
                  <MissionStatePill state={entry.mission.state} />
                </Link>
              </li>
            ))}
          </ul>
        ) : null}
      </CardContent>
    </Card>
  );
}

/** The project-detail version: this project's missions, and a way to start one. */
export function ProjectMissions({
  projectId,
  missions,
}: {
  projectId: string;
  missions: readonly MissionSummary[];
}) {
  return (
    <Card>
      <CardContent className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="flex items-center gap-2 text-sm font-semibold">
            <Rocket className="h-4 w-4" aria-hidden />
            Missions
          </p>
          <Link
            href={`/missions?search=${encodeURIComponent(projectId)}`}
            className="text-xs text-[var(--color-accent-text)] hover:underline"
          >
            Start one
          </Link>
        </div>

        {missions.length === 0 ? (
          <p className="text-sm text-[var(--color-text-muted)]">
            No missions for this project yet. Type what you want done into the Jarvis bar and it
            will plan it before anything runs.
          </p>
        ) : (
          <ul className="flex flex-col divide-y divide-[var(--color-border)]">
            {missions.slice(0, 6).map((entry) => (
              <li key={entry.mission.id}>
                <Link
                  href={`/missions/${entry.mission.id}`}
                  className="flex items-center gap-2 py-2 hover:text-[var(--color-accent-text)]"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm">{entry.mission.title}</p>
                    <p className="text-xs text-[var(--color-text-muted)]">
                      <RelativeTime iso={entry.mission.updatedAt} />
                      {entry.mission.pullRequestNumber
                        ? ` · draft PR #${entry.mission.pullRequestNumber}, not merged`
                        : ''}
                    </p>
                  </div>
                  <MissionStatePill state={entry.mission.state} />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
