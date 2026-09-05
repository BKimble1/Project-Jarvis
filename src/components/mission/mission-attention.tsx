import * as React from 'react';
import Link from 'next/link';
import { ChevronRight, PlugZap } from 'lucide-react';
import { MISSION_STATE_LABELS, type MissionSummary } from '@/domain/mission';
import type { WorkerHealth } from '@/domain/worker';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { RelativeTime } from '@/components/relative-time';

/**
 * Mission decisions on the "What needs me" page.
 *
 * Ordered by how much they are actually blocking: a running agent stopped dead waiting for a
 * permission decision costs more than a plan sitting in a queue, which costs more than a pull
 * request waiting to be read.
 */

export interface MissionAttentionGroups {
  readonly permission: readonly MissionSummary[];
  readonly input: readonly MissionSummary[];
  readonly approval: readonly MissionSummary[];
  readonly clarification: readonly MissionSummary[];
  readonly prReady: readonly MissionSummary[];
  readonly failed: readonly MissionSummary[];
  readonly stopped: readonly MissionSummary[];
  readonly stalled: readonly MissionSummary[];
  readonly total: number;
}

export function groupMissionAttention(
  missions: readonly MissionSummary[],
  stalledIds: ReadonlySet<string>,
): MissionAttentionGroups {
  const by = (state: string) => missions.filter((entry) => entry.mission.state === state);
  const groups = {
    permission: by('waiting_for_permission'),
    input: by('waiting_for_input'),
    approval: by('awaiting_plan_approval'),
    clarification: by('needs_clarification'),
    prReady: by('pull_request_ready'),
    failed: by('failed'),
    stopped: by('stopped'),
    stalled: missions.filter((entry) => stalledIds.has(entry.mission.id)),
  };
  return {
    ...groups,
    total: Object.values(groups).reduce((sum, list) => sum + list.length, 0),
  };
}

const SECTIONS: readonly {
  key: keyof Omit<MissionAttentionGroups, 'total'>;
  title: string;
  description: string;
  severity: 'critical' | 'high' | 'medium';
}[] = [
  {
    key: 'permission',
    title: 'Waiting for permission',
    description: 'A running agent has stopped and cannot continue until you decide.',
    severity: 'critical',
  },
  {
    key: 'input',
    title: 'Waiting for an answer',
    description: 'The agent asked a question mid-run.',
    severity: 'high',
  },
  {
    key: 'approval',
    title: 'Plans to approve',
    description: 'Nothing runs until you approve the current version.',
    severity: 'high',
  },
  {
    key: 'clarification',
    title: 'Questions before planning',
    description: 'Jarvis will not guess these.',
    severity: 'medium',
  },
  {
    key: 'stalled',
    title: 'Workers that stopped reporting',
    description:
      'These missions show as active but their worker has gone quiet. Nothing was marked complete or failed, and the work is preserved.',
    severity: 'high',
  },
  {
    key: 'failed',
    title: 'Failed missions',
    description: 'What was done before the failure is preserved.',
    severity: 'high',
  },
  {
    key: 'prReady',
    title: 'Draft pull requests to review',
    description: 'Open, unmerged, and waiting for you. Jarvis does not merge.',
    severity: 'medium',
  },
  {
    key: 'stopped',
    title: 'Stopped missions',
    description: 'You stopped these. Their branches and workspaces are untouched.',
    severity: 'medium',
  },
];

export function MissionAttention({ groups }: { groups: MissionAttentionGroups }) {
  if (groups.total === 0) return null;

  return (
    <>
      {SECTIONS.filter((section) => groups[section.key].length > 0).map((section) => (
        <Card key={section.key}>
          <CardHeader>
            <CardTitle className="text-sm">
              {section.title}{' '}
              <span className="font-normal text-[var(--color-text-subtle)]">
                ({groups[section.key].length})
              </span>
            </CardTitle>
            <p className="text-xs text-[var(--color-text-muted)]">{section.description}</p>
          </CardHeader>
          <CardContent className="pt-0">
            <ul className="flex flex-col divide-y divide-[var(--color-border)]">
              {groups[section.key].map((entry) => (
                <li key={entry.mission.id}>
                  <Link
                    href={`/missions/${entry.mission.id}`}
                    className="flex items-center gap-2 py-2.5 hover:text-[var(--color-accent-text)]"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{entry.mission.title}</p>
                      <p className="mt-0.5 text-xs text-[var(--color-text-muted)]">
                        {entry.projectName ?? 'No project'} ·{' '}
                        {section.key === 'stalled' ? (
                          <span className="inline-flex items-center gap-1">
                            <PlugZap className="h-3 w-3" aria-hidden />
                            {MISSION_STATE_LABELS[entry.mission.state]}, worker silent
                          </span>
                        ) : (
                          MISSION_STATE_LABELS[entry.mission.state]
                        )}{' '}
                        · <RelativeTime iso={entry.mission.updatedAt} />
                      </p>
                    </div>
                    <Badge
                      tone={
                        section.severity === 'critical'
                          ? 'critical'
                          : section.severity === 'high'
                            ? 'caution'
                            : 'neutral'
                      }
                    >
                      {section.severity}
                    </Badge>
                    <ChevronRight
                      className="h-4 w-4 shrink-0 text-[var(--color-text-subtle)]"
                      aria-hidden
                    />
                  </Link>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      ))}
    </>
  );
}

/** Disconnected workers, shown on the same page because the fix is the owner's. */
export function DisconnectedWorkers({ workers }: { workers: readonly WorkerHealth[] }) {
  const offline = workers.filter(
    (health) => health.effectiveStatus === 'disconnected' || health.effectiveStatus === 'unhealthy',
  );
  if (offline.length === 0) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">
          Workers needing attention{' '}
          <span className="font-normal text-[var(--color-text-subtle)]">({offline.length})</span>
        </CardTitle>
        <p className="text-xs text-[var(--color-text-muted)]">
          Jarvis cannot run a mission without a healthy worker.
        </p>
      </CardHeader>
      <CardContent className="pt-0">
        <ul className="flex flex-col divide-y divide-[var(--color-border)]">
          {offline.map((health) => (
            <li key={health.worker.id}>
              <Link
                href="/workers"
                className="flex items-center gap-2 py-2.5 hover:text-[var(--color-accent-text)]"
              >
                <PlugZap
                  className="h-4 w-4 shrink-0 text-[var(--color-caution-text)]"
                  aria-hidden
                />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{health.worker.name}</p>
                  <p className="mt-0.5 text-xs text-[var(--color-text-muted)]">
                    {health.explanation}
                  </p>
                </div>
                <ChevronRight
                  className="h-4 w-4 shrink-0 text-[var(--color-text-subtle)]"
                  aria-hidden
                />
              </Link>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
