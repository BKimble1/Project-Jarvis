import * as React from 'react';
import {
  Archive,
  CheckCircle2,
  CircleDashed,
  CircleDot,
  CirclePause,
  Hourglass,
  OctagonAlert,
  RefreshCwOff,
  Signal,
  SignalLow,
  SignalZero,
} from 'lucide-react';
import type { FreshnessState, ProjectStatus } from '@/domain/enums';
import { FRESHNESS_LABELS, PROJECT_STATUS_LABELS } from '@/lib/labels';
import { Badge } from '@/components/ui/badge';

const STATUS_TONE: Record<
  ProjectStatus,
  'positive' | 'accent' | 'caution' | 'critical' | 'neutral'
> = {
  active: 'positive',
  waiting: 'caution',
  blocked: 'critical',
  paused: 'neutral',
  completed: 'accent',
  archived: 'neutral',
  unknown: 'neutral',
};

const STATUS_ICON: Record<ProjectStatus, React.ComponentType<{ className?: string }>> = {
  active: CircleDot,
  waiting: Hourglass,
  blocked: OctagonAlert,
  paused: CirclePause,
  completed: CheckCircle2,
  archived: Archive,
  unknown: CircleDashed,
};

export function StatusPill({ status }: { status: ProjectStatus }) {
  const Icon = STATUS_ICON[status];
  return (
    <Badge tone={STATUS_TONE[status]}>
      <Icon className="h-3 w-3" aria-hidden />
      {PROJECT_STATUS_LABELS[status]}
    </Badge>
  );
}

const FRESHNESS_TONE: Record<FreshnessState, 'positive' | 'neutral' | 'caution' | 'critical'> = {
  live: 'positive',
  recent: 'neutral',
  stale: 'caution',
  failing: 'critical',
  never: 'caution',
};

const FRESHNESS_ICON: Record<FreshnessState, React.ComponentType<{ className?: string }>> = {
  live: Signal,
  recent: Signal,
  stale: SignalLow,
  failing: RefreshCwOff,
  never: SignalZero,
};

export function FreshnessPill({ state, detail }: { state: FreshnessState; detail?: string }) {
  const Icon = FRESHNESS_ICON[state];
  return (
    <Badge tone={FRESHNESS_TONE[state]} title={detail}>
      <Icon className="h-3 w-3" aria-hidden />
      {FRESHNESS_LABELS[state]}
    </Badge>
  );
}
