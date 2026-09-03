'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { ChevronDown } from 'lucide-react';
import {
  AGENT_ROLE_LABELS,
  describeProfile,
  resolvePermissionProfile,
  type AgentRole,
} from '@/domain/agent-role';
import { describeWriteSet } from '@/domain/write-set';
import { TASK_STATE_LABELS, TASK_TYPE_LABELS, type MissionTask } from '@/domain/mission-task';
import type { TaskGraphView } from '@/domain/task-graph';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

/**
 * The task graph, and the approval that gates it.
 *
 * The panel exists to answer one question before an owner presses the button: *what is about to
 * happen, by how many agents, with what permission, and where may each one write?* Every one of
 * those is shown per task, because "approve this plan" and "approve six agents, two of which may
 * change anything in the repository" are different decisions and only the second one is honest.
 *
 * The fingerprint the owner is shown is sent back with the approval, so a graph that changed
 * between rendering and approving cannot inherit the approval.
 */

interface Playbook {
  readonly key: string;
  readonly name: string;
  readonly description: string;
  readonly enabled: boolean;
}

export function TaskGraphPanel({
  missionId,
  initial,
  playbooks,
  planApproved,
  approvedGraphVersion,
}: {
  missionId: string;
  initial: TaskGraphView | null;
  playbooks: readonly Playbook[];
  planApproved: boolean;
  approvedGraphVersion: number | null;
}) {
  const router = useRouter();
  const [busy, setBusy] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [playbookKey, setPlaybookKey] = React.useState<string>('');

  const view = initial;
  const approved = view !== null && approvedGraphVersion === view.graph.version;

  async function call(path: string, body: unknown, key: string) {
    setBusy(key);
    setError(null);
    try {
      const response = await fetch(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as {
          error?: { message?: string };
        };
        setError(payload.error?.message ?? 'That did not work.');
        return;
      }
      router.refresh();
    } catch {
      setError('Could not reach Jarvis.');
    } finally {
      setBusy(null);
    }
  }

  if (!planApproved) return null;

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between gap-2">
        <CardTitle className="text-sm">
          How Jarvis will do it{view ? ` · version ${view.graph.version}` : ''}
        </CardTitle>
        {approved ? (
          <Badge tone="positive">Approved</Badge>
        ) : view ? (
          <Badge tone="caution">Waiting for you</Badge>
        ) : null}
      </CardHeader>

      <CardContent className="flex flex-col gap-3 pt-0">
        {!view ? (
          <>
            <p className="text-sm text-[var(--color-text-muted)]">
              Jarvis has an approved plan. Next it proposes the agents that would carry it out —
              what each one does, what it may read, and where it may write. Nothing starts until you
              approve that.
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <label htmlFor="playbook" className="text-xs text-[var(--color-text-subtle)]">
                Playbook
              </label>
              <select
                id="playbook"
                value={playbookKey}
                onChange={(event) => setPlaybookKey(event.target.value)}
                className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 text-sm"
              >
                <option value="">Work it out from the plan</option>
                {playbooks
                  .filter((playbook) => playbook.enabled)
                  .map((playbook) => (
                    <option key={playbook.key} value={playbook.key}>
                      {playbook.name}
                    </option>
                  ))}
              </select>
              <Button
                disabled={busy !== null}
                onClick={() =>
                  void call(
                    `/api/missions/${missionId}/graph`,
                    playbookKey ? { playbookKey } : {},
                    'propose',
                  )
                }
              >
                {busy === 'propose' ? 'Working it out…' : 'Propose the agents'}
              </Button>
            </div>
          </>
        ) : (
          <>
            <p className="text-sm">{view.graph.summary}</p>

            {view.graph.notes.length > 0 ? (
              <div>
                <p className="text-xs font-semibold tracking-wide text-[var(--color-text-subtle)] uppercase">
                  You approve
                </p>
                <ul className="mt-1 flex list-disc flex-col gap-0.5 pl-4">
                  {view.graph.notes.map((note, index) => (
                    <li key={index} className="text-xs text-[var(--color-text-muted)]">
                      {note}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            <div className="flex flex-col gap-2">
              {view.waves.map((wave, index) => (
                <div key={index} className="flex flex-col gap-1.5">
                  <p className="text-xs font-semibold tracking-wide text-[var(--color-text-subtle)] uppercase">
                    {wave.length > 1
                      ? `Step ${index + 1} · ${wave.length} at once`
                      : `Step ${index + 1}`}
                  </p>
                  {wave.map((key) => {
                    const task = view.tasks.find((candidate) => candidate.key === key);
                    return task ? <TaskCard key={key} missionId={missionId} task={task} /> : null;
                  })}
                </div>
              ))}
            </div>

            <p className="text-xs text-[var(--color-text-muted)]">
              Up to {view.graph.maxRepairRounds} repair round
              {view.graph.maxRepairRounds === 1 ? '' : 's'} if review finds something blocking.
              After that Jarvis stops and asks you rather than trying again.
            </p>

            {!approved ? (
              <div className="flex flex-wrap gap-2">
                <Button
                  disabled={busy !== null}
                  onClick={() =>
                    void call(
                      `/api/missions/${missionId}/graph/approve`,
                      {
                        graphVersion: view.graph.version,
                        fingerprint: view.graph.fingerprint,
                      },
                      'approve',
                    )
                  }
                >
                  {busy === 'approve' ? 'Approving…' : `Approve these ${view.tasks.length} agents`}
                </Button>
                <Button
                  variant="secondary"
                  disabled={busy !== null}
                  onClick={() => void call(`/api/missions/${missionId}/graph`, {}, 'repropose')}
                >
                  {busy === 'repropose' ? 'Rethinking…' : 'Propose a different shape'}
                </Button>
              </div>
            ) : null}
          </>
        )}

        {error ? <p className="text-xs text-[var(--color-critical-text)]">{error}</p> : null}
      </CardContent>
    </Card>
  );
}

/**
 * One task, with the three things that decide whether it is safe.
 *
 * Role, permission profile and write set are on the collapsed row rather than hidden behind the
 * disclosure, because they are what an approval is *of*. The description is what can be folded
 * away, not the permission.
 */
function TaskCard({ missionId, task }: { missionId: string; task: MissionTask }) {
  const writes = task.declaredWriteSet.length > 0;
  return (
    <details className="rounded-lg border border-[var(--color-border)] px-2.5 py-2">
      <summary className="flex cursor-pointer flex-wrap items-center gap-x-2 gap-y-1 text-sm">
        <ChevronDown className="h-3.5 w-3.5 shrink-0 text-[var(--color-text-subtle)]" aria-hidden />
        <span className="font-mono text-xs text-[var(--color-text-subtle)]">{task.key}</span>
        <span className="font-medium">
          {AGENT_ROLE_LABELS[task.role as AgentRole] ?? task.role}
        </span>
        <span className="min-w-0 flex-1 truncate text-[var(--color-text-muted)]">{task.title}</span>
        <Badge tone={writes ? 'caution' : 'neutral'}>
          {writes ? describeWriteSet(task.declaredWriteSet) : 'Read-only'}
        </Badge>
        <span className="text-xs text-[var(--color-text-subtle)]">
          {TASK_STATE_LABELS[task.state] ?? task.state}
        </span>
      </summary>

      <div className="mt-2 flex flex-col gap-1.5 pl-5">
        <p className="text-xs whitespace-pre-wrap text-[var(--color-text-muted)]">
          {task.description}
        </p>
        <p className="text-xs text-[var(--color-text-subtle)]">
          {TASK_TYPE_LABELS[task.taskType] ?? task.taskType} ·{' '}
          {describeProfile(resolvePermissionProfile(task.permissionProfileId))}
        </p>
        {task.acceptanceCriteria.length > 0 ? (
          <ul className="flex list-disc flex-col gap-0.5 pl-4">
            {task.acceptanceCriteria.map((criterion, index) => (
              <li key={index} className="text-xs text-[var(--color-text-muted)]">
                {criterion}
              </li>
            ))}
          </ul>
        ) : null}
        {task.failureMessage ? (
          <p className="rounded bg-[var(--color-critical-soft)] px-2 py-1 text-xs text-[var(--color-critical-text)]">
            {task.failureMessage}
          </p>
        ) : null}
        {task.branchName ? (
          <p className="font-mono text-xs text-[var(--color-text-subtle)]">{task.branchName}</p>
        ) : null}
        <TaskActions missionId={missionId} task={task} />
      </div>
    </details>
  );
}

/**
 * What an owner may do to one task.
 *
 * Deliberately three verbs and no fourth: skip it, cancel it, or put a failed one back in the
 * queue. There is no "mark succeeded" and no "approve", because a task reaching `succeeded` means
 * it was verified and reviewed — and an owner override that could declare work finished would undo
 * the entire point of the review gate. The state machine refuses those moves anyway; not offering
 * them is how the interface stays honest about it.
 */
function TaskActions({ missionId, task }: { missionId: string; task: MissionTask }) {
  const router = useRouter();
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const canSkip = task.state === 'blocked' || task.state === 'ready' || task.state === 'draft';
  const canCancel = canSkip || task.state === 'paused';
  const canRetry = task.state === 'failed';
  if (!canSkip && !canCancel && !canRetry) return null;

  async function act(action: 'skip' | 'cancel' | 'retry') {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/missions/${missionId}/tasks/${task.id}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as {
          error?: { message?: string };
        };
        setError(payload.error?.message ?? 'That did not work.');
        return;
      }
      router.refresh();
    } catch {
      setError('Could not reach Jarvis.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {canSkip ? (
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => void act('skip')}>
          Skip this
        </Button>
      ) : null}
      {canRetry ? (
        <Button size="sm" variant="secondary" disabled={busy} onClick={() => void act('retry')}>
          Try again
        </Button>
      ) : null}
      {canCancel ? (
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => void act('cancel')}>
          Cancel
        </Button>
      ) : null}
      {error ? <span className="text-xs text-[var(--color-critical-text)]">{error}</span> : null}
    </div>
  );
}
