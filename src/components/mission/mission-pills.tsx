import * as React from 'react';
import {
  Ban,
  CheckCircle2,
  CircleDashed,
  CirclePause,
  CircleSlash,
  ClipboardCheck,
  Cpu,
  FileSearch,
  GitPullRequestDraft,
  Hourglass,
  LoaderCircle,
  MessageCircleQuestion,
  OctagonAlert,
  Pencil,
  PlugZap,
  ShieldQuestion,
  Square,
  TriangleAlert,
} from 'lucide-react';
import {
  MISSION_RISK_LABELS,
  MISSION_STATE_LABELS,
  MISSION_TYPE_LABELS,
  type MissionRiskLevel,
  type MissionState,
  type MissionType,
} from '@/domain/mission';
import { WORKER_STATUS_LABELS, type WorkerStatus } from '@/domain/worker';
import { Badge } from '@/components/ui/badge';

/**
 * State, risk and worker badges.
 *
 * The tones carry meaning rather than decoration: anything waiting on the owner is `caution`,
 * anything that needs a decision *now* is `critical`, and finished work is `positive` — except a
 * draft pull request, which is `accent`, because "ready for you to review" is not "done".
 */

type Tone = 'positive' | 'accent' | 'caution' | 'critical' | 'neutral' | 'outline';

const STATE_TONE: Record<MissionState, Tone> = {
  draft: 'neutral',
  resolving_project: 'neutral',
  needs_clarification: 'caution',
  inspecting: 'accent',
  planning: 'accent',
  awaiting_plan_approval: 'caution',
  queued: 'accent',
  claimed: 'accent',
  preparing_workspace: 'accent',
  running: 'accent',
  waiting_for_permission: 'critical',
  waiting_for_input: 'caution',
  pausing: 'caution',
  paused: 'neutral',
  resuming: 'accent',
  verifying: 'accent',
  creating_pull_request: 'accent',
  pull_request_ready: 'accent',
  completed: 'positive',
  failed: 'critical',
  stopping: 'caution',
  stopped: 'neutral',
  cancelled: 'neutral',
};

const STATE_ICON: Record<MissionState, React.ComponentType<{ className?: string }>> = {
  draft: Pencil,
  resolving_project: CircleDashed,
  needs_clarification: MessageCircleQuestion,
  inspecting: FileSearch,
  planning: ClipboardCheck,
  awaiting_plan_approval: ClipboardCheck,
  queued: Hourglass,
  claimed: Cpu,
  preparing_workspace: Cpu,
  running: LoaderCircle,
  waiting_for_permission: ShieldQuestion,
  waiting_for_input: MessageCircleQuestion,
  pausing: CirclePause,
  paused: CirclePause,
  resuming: LoaderCircle,
  verifying: ClipboardCheck,
  creating_pull_request: GitPullRequestDraft,
  pull_request_ready: GitPullRequestDraft,
  completed: CheckCircle2,
  failed: OctagonAlert,
  stopping: Square,
  stopped: Square,
  cancelled: CircleSlash,
};

/** States where the spinner is honest — something really is happening right now. */
const SPINNING: readonly MissionState[] = ['running', 'resuming', 'verifying', 'inspecting'];

export function MissionStatePill({
  state,
  stalled = false,
}: {
  state: MissionState;
  /** The worker holding this mission has stopped reporting. */
  stalled?: boolean;
}) {
  const Icon = stalled ? PlugZap : STATE_ICON[state];
  return (
    <Badge tone={stalled ? 'caution' : STATE_TONE[state]}>
      <Icon
        className={`h-3 w-3 ${!stalled && SPINNING.includes(state) ? 'animate-spin' : ''}`}
        aria-hidden
      />
      {stalled ? `${MISSION_STATE_LABELS[state]} · not reporting` : MISSION_STATE_LABELS[state]}
    </Badge>
  );
}

const RISK_TONE: Record<MissionRiskLevel, Tone> = {
  read_only: 'positive',
  low: 'neutral',
  moderate: 'accent',
  high: 'caution',
  prohibited: 'critical',
};

export function MissionRiskPill({ risk }: { risk: MissionRiskLevel }) {
  return (
    <Badge tone={RISK_TONE[risk]}>
      {risk === 'prohibited' ? <Ban className="h-3 w-3" aria-hidden /> : null}
      {risk === 'high' ? <TriangleAlert className="h-3 w-3" aria-hidden /> : null}
      {MISSION_RISK_LABELS[risk]}
    </Badge>
  );
}

export function MissionTypePill({ type }: { type: MissionType }) {
  return <Badge tone="outline">{MISSION_TYPE_LABELS[type]}</Badge>;
}

const WORKER_TONE: Record<WorkerStatus, Tone> = {
  registered: 'neutral',
  idle: 'positive',
  busy: 'accent',
  draining: 'caution',
  unhealthy: 'caution',
  disconnected: 'critical',
  revoked: 'critical',
};

export function WorkerStatusPill({ status }: { status: WorkerStatus }) {
  return (
    <Badge tone={WORKER_TONE[status]}>
      <PlugZap className="h-3 w-3" aria-hidden />
      {WORKER_STATUS_LABELS[status]}
    </Badge>
  );
}
