'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Check, Loader2, Plus, RotateCcw, Trash2, X } from 'lucide-react';
import { toast } from 'sonner';
import { BLOCKER_SEVERITIES, MILESTONE_STATES, NEXT_ACTION_PRIORITIES } from '@/domain/enums';
import type { Blocker, Decision, ManualUpdate, Milestone, NextAction } from '@/domain/project';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Field, Input, Select, Textarea } from '@/components/ui/field';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ProvenanceBadge } from '@/components/provenance';
import { RelativeTime } from '@/components/relative-time';

type Kind = 'blockers' | 'decisions' | 'milestones' | 'updates' | 'actions';

/**
 * Adding and resolving the owner-managed parts of a project.
 *
 * Everything created here is stored as `manual` provenance and stays manual — a milestone the
 * owner ticks never becomes "verified" just because they ticked it.
 */
function useMutation(projectId: string) {
  const router = useRouter();
  const [pending, setPending] = React.useState(false);

  const call = React.useCallback(
    async (input: RequestInfo, init: RequestInit, successMessage: string): Promise<boolean> => {
      setPending(true);
      try {
        const response = await fetch(input, init);
        if (!response.ok) {
          const body = (await response.json().catch(() => ({}))) as { error?: { message: string } };
          toast.error(body.error?.message ?? 'That did not work.');
          return false;
        }
        toast.success(successMessage);
        router.refresh();
        return true;
      } catch {
        toast.error('Could not reach the server.');
        return false;
      } finally {
        setPending(false);
      }
    },
    [router],
  );

  const create = React.useCallback(
    (kind: Kind, payload: unknown, message: string) =>
      call(
        `/api/projects/${projectId}/items/${kind}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        },
        message,
      ),
    [call, projectId],
  );

  const patch = React.useCallback(
    (kind: Kind, id: string, payload: unknown, message: string) =>
      call(
        `/api/items/${kind}/${id}`,
        {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        },
        message,
      ),
    [call],
  );

  const remove = React.useCallback(
    (kind: Kind, id: string, message: string) =>
      call(`/api/items/${kind}/${id}`, { method: 'DELETE' }, message),
    [call],
  );

  return { pending, create, patch, remove };
}

function SectionCard({
  title,
  description,
  count,
  addLabel,
  form,
  children,
}: {
  title: string;
  description?: string;
  count: number;
  addLabel: string;
  form: (close: () => void) => React.ReactNode;
  children: React.ReactNode;
}) {
  const [open, setOpen] = React.useState(false);
  return (
    <Card>
      <CardHeader className="flex-row flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <CardTitle>
            {title}{' '}
            <span className="text-sm font-normal text-[var(--color-text-subtle)]">({count})</span>
          </CardTitle>
          {description ? (
            <p className="mt-0.5 text-xs text-[var(--color-text-muted)]">{description}</p>
          ) : null}
        </div>
        <Button
          type="button"
          variant={open ? 'ghost' : 'secondary'}
          size="sm"
          onClick={() => setOpen((value) => !value)}
        >
          {open ? <X className="h-4 w-4" aria-hidden /> : <Plus className="h-4 w-4" aria-hidden />}
          {open ? 'Cancel' : addLabel}
        </Button>
      </CardHeader>
      <CardContent className="pt-0">
        {open ? (
          <div className="mb-4 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface-muted)]/40 p-3">
            {form(() => setOpen(false))}
          </div>
        ) : null}
        {children}
      </CardContent>
    </Card>
  );
}

function EmptyLine({ text }: { text: string }) {
  return <p className="text-sm text-[var(--color-text-muted)]">{text}</p>;
}

/* ------------------------------------------------------------------ blockers */

export function BlockersSection({
  projectId,
  blockers,
}: {
  projectId: string;
  blockers: readonly Blocker[];
}) {
  const { pending, create, patch, remove } = useMutation(projectId);
  const active = blockers.filter((blocker) => blocker.isActive);
  const resolved = blockers.filter((blocker) => !blocker.isActive);

  return (
    <SectionCard
      title="Blockers"
      description="Anything stopping progress. Mark the ones that need your decision."
      count={active.length}
      addLabel="Add blocker"
      form={(close) => (
        <form
          className="flex flex-col gap-3"
          onSubmit={async (event) => {
            event.preventDefault();
            const data = new FormData(event.currentTarget);
            const ok = await create(
              'blockers',
              {
                title: String(data.get('title') ?? ''),
                description: String(data.get('description') ?? '') || null,
                severity: data.get('severity'),
                resolutionRequirement: String(data.get('resolutionRequirement') ?? '') || null,
                requiresOwnerDecision: data.get('requiresOwnerDecision') === 'on',
              },
              'Blocker added.',
            );
            if (ok) close();
          }}
        >
          <Field label="What is blocked?" htmlFor="blocker-title">
            <Input id="blocker-title" name="title" required maxLength={160} />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Severity" htmlFor="blocker-severity">
              <Select id="blocker-severity" name="severity" defaultValue="medium">
                {BLOCKER_SEVERITIES.map((severity) => (
                  <option key={severity} value={severity}>
                    {severity}
                  </option>
                ))}
              </Select>
            </Field>
            <label className="flex items-end gap-2 pb-2 text-sm">
              <input
                type="checkbox"
                name="requiresOwnerDecision"
                className="h-4 w-4 accent-[var(--color-accent)]"
              />
              Needs my decision
            </label>
          </div>
          <Field label="What would unblock it?" htmlFor="blocker-resolution">
            <Textarea
              id="blocker-resolution"
              name="resolutionRequirement"
              rows={2}
              maxLength={1000}
            />
          </Field>
          <Field label="Detail" htmlFor="blocker-description">
            <Textarea id="blocker-description" name="description" rows={2} maxLength={2000} />
          </Field>
          <Button type="submit" size="sm" disabled={pending}>
            {pending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
            Add blocker
          </Button>
        </form>
      )}
    >
      {active.length === 0 && resolved.length === 0 ? (
        <EmptyLine text="Nothing is blocked." />
      ) : (
        <ul className="flex flex-col divide-y divide-[var(--color-border)]">
          {[...active, ...resolved].map((blocker) => (
            <li key={blocker.id} className="flex items-start gap-2 py-2.5">
              <div className="min-w-0 flex-1">
                <p
                  className={
                    blocker.isActive
                      ? 'text-sm font-medium'
                      : 'text-sm font-medium text-[var(--color-text-subtle)] line-through'
                  }
                >
                  {blocker.title}
                </p>
                {blocker.description ? (
                  <p className="mt-0.5 text-xs text-[var(--color-text-muted)]">
                    {blocker.description}
                  </p>
                ) : null}
                {blocker.resolutionRequirement ? (
                  <p className="mt-0.5 text-xs text-[var(--color-text-subtle)]">
                    To clear: {blocker.resolutionRequirement}
                  </p>
                ) : null}
                <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                  <Badge tone={blocker.severity === 'critical' ? 'critical' : 'caution'}>
                    {blocker.severity}
                  </Badge>
                  {blocker.requiresOwnerDecision ? (
                    <Badge tone="accent">Needs your decision</Badge>
                  ) : null}
                  <ProvenanceBadge level={blocker.provenance} />
                  <span className="text-[0.6875rem] text-[var(--color-text-subtle)]">
                    added <RelativeTime iso={blocker.createdAt} />
                  </span>
                </div>
              </div>
              <div className="flex shrink-0 gap-1">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={pending}
                  aria-label={blocker.isActive ? 'Resolve blocker' : 'Reopen blocker'}
                  onClick={() =>
                    void patch(
                      'blockers',
                      blocker.id,
                      { isActive: !blocker.isActive },
                      blocker.isActive ? 'Blocker resolved.' : 'Blocker reopened.',
                    )
                  }
                >
                  {blocker.isActive ? (
                    <Check className="h-4 w-4" aria-hidden />
                  ) : (
                    <RotateCcw className="h-4 w-4" aria-hidden />
                  )}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={pending}
                  aria-label="Delete blocker"
                  onClick={() => void remove('blockers', blocker.id, 'Blocker deleted.')}
                >
                  <Trash2 className="h-4 w-4" aria-hidden />
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </SectionCard>
  );
}

/* ------------------------------------------------------------- next actions */

export function NextActionsSection({
  projectId,
  actions,
}: {
  projectId: string;
  actions: readonly NextAction[];
}) {
  const { pending, create, patch, remove } = useMutation(projectId);
  const open = actions.filter((action) => action.status !== 'done' && action.status !== 'dropped');
  const done = actions.filter((action) => action.status === 'done');

  return (
    <SectionCard
      title="Next actions"
      description="Your list. Jarvis puts these ahead of anything it would suggest itself."
      count={open.length}
      addLabel="Add action"
      form={(close) => (
        <form
          className="flex flex-col gap-3"
          onSubmit={async (event) => {
            event.preventDefault();
            const data = new FormData(event.currentTarget);
            const due = String(data.get('dueDate') ?? '');
            const ok = await create(
              'actions',
              {
                action: String(data.get('action') ?? ''),
                priority: data.get('priority'),
                dueDate: due.length > 0 ? due : null,
                requiresOwner: data.get('requiresOwner') === 'on',
                position: open.length,
              },
              'Next action added.',
            );
            if (ok) close();
          }}
        >
          <Field label="Action" htmlFor="action-text">
            <Input id="action-text" name="action" required maxLength={400} />
          </Field>
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Priority" htmlFor="action-priority">
              <Select id="action-priority" name="priority" defaultValue="medium">
                {NEXT_ACTION_PRIORITIES.map((priority) => (
                  <option key={priority} value={priority}>
                    {priority}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Due date" htmlFor="action-due">
              <Input id="action-due" name="dueDate" type="date" />
            </Field>
            <label className="flex items-end gap-2 pb-2 text-sm">
              <input
                type="checkbox"
                name="requiresOwner"
                className="h-4 w-4 accent-[var(--color-accent)]"
              />
              Only I can do it
            </label>
          </div>
          <Button type="submit" size="sm" disabled={pending}>
            {pending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
            Add action
          </Button>
        </form>
      )}
    >
      {actions.length === 0 ? (
        <EmptyLine text="No actions recorded." />
      ) : (
        <ul className="flex flex-col divide-y divide-[var(--color-border)]">
          {[...open, ...done].map((action) => (
            <li key={action.id} className="flex items-start gap-2 py-2.5">
              <input
                type="checkbox"
                checked={action.status === 'done'}
                aria-label={`Mark "${action.action}" as done`}
                disabled={pending}
                onChange={(event) =>
                  void patch(
                    'actions',
                    action.id,
                    { status: event.target.checked ? 'done' : 'open' },
                    event.target.checked ? 'Action completed.' : 'Action reopened.',
                  )
                }
                className="mt-1 h-4 w-4 shrink-0 accent-[var(--color-accent)]"
              />
              <div className="min-w-0 flex-1">
                <p
                  className={
                    action.status === 'done'
                      ? 'text-sm text-[var(--color-text-subtle)] line-through'
                      : 'text-sm'
                  }
                >
                  {action.action}
                </p>
                <div className="mt-1 flex flex-wrap items-center gap-1.5">
                  <Badge tone={action.priority === 'critical' ? 'critical' : 'neutral'}>
                    {action.priority}
                  </Badge>
                  {action.requiresOwner ? <Badge tone="accent">You</Badge> : null}
                  {action.dueDate ? <Badge tone="outline">due {action.dueDate}</Badge> : null}
                  <ProvenanceBadge level={action.provenance} showLabel={false} />
                </div>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={pending}
                aria-label="Delete action"
                onClick={() => void remove('actions', action.id, 'Action deleted.')}
              >
                <Trash2 className="h-4 w-4" aria-hidden />
              </Button>
            </li>
          ))}
        </ul>
      )}
    </SectionCard>
  );
}

/* -------------------------------------------------------------- milestones */

export function MilestonesSection({
  projectId,
  milestones,
}: {
  projectId: string;
  milestones: readonly Milestone[];
}) {
  const { pending, create, patch, remove } = useMutation(projectId);

  return (
    <SectionCard
      title="Milestones"
      description="Marked complete by you. Jarvis keeps them labelled Manual unless a source verifies them."
      count={milestones.filter((milestone) => milestone.state !== 'done').length}
      addLabel="Add milestone"
      form={(close) => (
        <form
          className="flex flex-col gap-3"
          onSubmit={async (event) => {
            event.preventDefault();
            const data = new FormData(event.currentTarget);
            const target = String(data.get('targetDate') ?? '');
            const ok = await create(
              'milestones',
              {
                title: String(data.get('title') ?? ''),
                description: String(data.get('description') ?? '') || null,
                state: data.get('state'),
                targetDate: target.length > 0 ? target : null,
                position: milestones.length,
              },
              'Milestone added.',
            );
            if (ok) close();
          }}
        >
          <Field label="Title" htmlFor="milestone-title">
            <Input id="milestone-title" name="title" required maxLength={160} />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="State" htmlFor="milestone-state">
              <Select id="milestone-state" name="state" defaultValue="planned">
                {MILESTONE_STATES.map((state) => (
                  <option key={state} value={state}>
                    {state.replace('_', ' ')}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Target date" htmlFor="milestone-target">
              <Input id="milestone-target" name="targetDate" type="date" />
            </Field>
          </div>
          <Field label="Description" htmlFor="milestone-description">
            <Textarea id="milestone-description" name="description" rows={2} maxLength={2000} />
          </Field>
          <Button type="submit" size="sm" disabled={pending}>
            {pending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
            Add milestone
          </Button>
        </form>
      )}
    >
      {milestones.length === 0 ? (
        <EmptyLine text="No milestones recorded." />
      ) : (
        <ol className="flex flex-col divide-y divide-[var(--color-border)]">
          {milestones.map((milestone) => (
            <li key={milestone.id} className="flex items-start gap-2 py-2.5">
              <div className="min-w-0 flex-1">
                <p
                  className={
                    milestone.state === 'done'
                      ? 'text-sm font-medium text-[var(--color-text-subtle)] line-through'
                      : 'text-sm font-medium'
                  }
                >
                  {milestone.title}
                </p>
                {milestone.description ? (
                  <p className="mt-0.5 text-xs text-[var(--color-text-muted)]">
                    {milestone.description}
                  </p>
                ) : null}
                <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                  <Badge tone={milestone.state === 'done' ? 'positive' : 'neutral'}>
                    {milestone.state.replace('_', ' ')}
                  </Badge>
                  {milestone.targetDate ? (
                    <Badge tone="outline">target {milestone.targetDate}</Badge>
                  ) : null}
                  <ProvenanceBadge level={milestone.provenance} />
                </div>
              </div>
              <div className="flex shrink-0 gap-1">
                <Select
                  aria-label={`State for ${milestone.title}`}
                  value={milestone.state}
                  disabled={pending}
                  onChange={(event) =>
                    void patch(
                      'milestones',
                      milestone.id,
                      { state: event.target.value },
                      'Milestone updated.',
                    )
                  }
                  className="h-9 w-32 text-xs"
                >
                  {MILESTONE_STATES.map((state) => (
                    <option key={state} value={state}>
                      {state.replace('_', ' ')}
                    </option>
                  ))}
                </Select>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={pending}
                  aria-label="Delete milestone"
                  onClick={() => void remove('milestones', milestone.id, 'Milestone deleted.')}
                >
                  <Trash2 className="h-4 w-4" aria-hidden />
                </Button>
              </div>
            </li>
          ))}
        </ol>
      )}
    </SectionCard>
  );
}

/* --------------------------------------------------------------- decisions */

export function DecisionsSection({
  projectId,
  decisions,
}: {
  projectId: string;
  decisions: readonly Decision[];
}) {
  const { pending, create, remove } = useMutation(projectId);

  return (
    <SectionCard
      title="Decisions"
      description="What you decided, and why — so future-you does not relitigate it."
      count={decisions.length}
      addLabel="Record decision"
      form={(close) => (
        <form
          className="flex flex-col gap-3"
          onSubmit={async (event) => {
            event.preventDefault();
            const data = new FormData(event.currentTarget);
            const decidedOn = String(data.get('decidedOn') ?? '');
            const supersedes = String(data.get('supersedesDecisionId') ?? '');
            const ok = await create(
              'decisions',
              {
                title: String(data.get('title') ?? ''),
                decision: String(data.get('decision') ?? ''),
                reasoning: String(data.get('reasoning') ?? '') || null,
                decidedOn: decidedOn.length > 0 ? decidedOn : null,
                supersedesDecisionId: supersedes.length > 0 ? supersedes : null,
              },
              'Decision recorded.',
            );
            if (ok) close();
          }}
        >
          <Field label="Question" htmlFor="decision-title">
            <Input id="decision-title" name="title" required maxLength={160} />
          </Field>
          <Field label="Decision" htmlFor="decision-decision">
            <Textarea id="decision-decision" name="decision" required rows={2} maxLength={2000} />
          </Field>
          <Field label="Reasoning" htmlFor="decision-reasoning">
            <Textarea id="decision-reasoning" name="reasoning" rows={2} maxLength={4000} />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Decided on" htmlFor="decision-date">
              <Input id="decision-date" name="decidedOn" type="date" />
            </Field>
            <Field label="Supersedes" htmlFor="decision-supersedes">
              <Select id="decision-supersedes" name="supersedesDecisionId" defaultValue="">
                <option value="">Nothing</option>
                {decisions.map((decision) => (
                  <option key={decision.id} value={decision.id}>
                    {decision.title}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <Button type="submit" size="sm" disabled={pending}>
            {pending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
            Record decision
          </Button>
        </form>
      )}
    >
      {decisions.length === 0 ? (
        <EmptyLine text="No decisions recorded." />
      ) : (
        <ul className="flex flex-col divide-y divide-[var(--color-border)]">
          {decisions.map((decision) => {
            const superseded = decisions.find((item) => item.id === decision.supersedesDecisionId);
            return (
              <li key={decision.id} className="flex items-start gap-2 py-2.5">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">{decision.title}</p>
                  <p className="mt-0.5 text-sm">{decision.decision}</p>
                  {decision.reasoning ? (
                    <p className="mt-0.5 text-xs text-[var(--color-text-muted)]">
                      {decision.reasoning}
                    </p>
                  ) : null}
                  <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                    <ProvenanceBadge level={decision.provenance} />
                    {decision.decidedOn ? <Badge tone="outline">{decision.decidedOn}</Badge> : null}
                    {superseded ? (
                      <Badge tone="caution">supersedes “{superseded.title}”</Badge>
                    ) : null}
                  </div>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={pending}
                  aria-label="Delete decision"
                  onClick={() => void remove('decisions', decision.id, 'Decision deleted.')}
                >
                  <Trash2 className="h-4 w-4" aria-hidden />
                </Button>
              </li>
            );
          })}
        </ul>
      )}
    </SectionCard>
  );
}

/* ----------------------------------------------------------------- updates */

export function UpdatesSection({
  projectId,
  updates,
}: {
  projectId: string;
  updates: readonly ManualUpdate[];
}) {
  const { pending, create, remove } = useMutation(projectId);

  return (
    <SectionCard
      title="Your updates"
      description="What changed, what you are doing, what is worrying you."
      count={updates.length}
      addLabel="Record update"
      form={(close) => (
        <form
          className="flex flex-col gap-3"
          onSubmit={async (event) => {
            event.preventDefault();
            const data = new FormData(event.currentTarget);
            const occurred = String(data.get('occurredOn') ?? '');
            const ok = await create(
              'updates',
              {
                whatChanged: String(data.get('whatChanged') ?? ''),
                currentWork: String(data.get('currentWork') ?? '') || null,
                problemsOrRisks: String(data.get('problemsOrRisks') ?? '') || null,
                proposedNextAction: String(data.get('proposedNextAction') ?? '') || null,
                occurredOn: occurred.length > 0 ? occurred : null,
              },
              'Update recorded.',
            );
            if (ok) close();
          }}
        >
          <Field label="What changed?" htmlFor="update-changed">
            <Textarea id="update-changed" name="whatChanged" required rows={2} maxLength={2000} />
          </Field>
          <Field label="What are you working on now?" htmlFor="update-current">
            <Textarea id="update-current" name="currentWork" rows={2} maxLength={2000} />
          </Field>
          <Field label="Problems or risks" htmlFor="update-problems">
            <Textarea id="update-problems" name="problemsOrRisks" rows={2} maxLength={2000} />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Proposed next action" htmlFor="update-next">
              <Input id="update-next" name="proposedNextAction" maxLength={1000} />
            </Field>
            <Field label="Date" htmlFor="update-date">
              <Input id="update-date" name="occurredOn" type="date" />
            </Field>
          </div>
          <Button type="submit" size="sm" disabled={pending}>
            {pending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
            Record update
          </Button>
        </form>
      )}
    >
      {updates.length === 0 ? (
        <EmptyLine text="No updates recorded yet." />
      ) : (
        <ul className="flex flex-col divide-y divide-[var(--color-border)]">
          {updates.slice(0, 20).map((update) => (
            <li key={update.id} className="flex items-start gap-2 py-2.5">
              <div className="min-w-0 flex-1">
                <p className="text-sm">{update.whatChanged}</p>
                {update.currentWork ? (
                  <p className="mt-0.5 text-xs text-[var(--color-text-muted)]">
                    Now: {update.currentWork}
                  </p>
                ) : null}
                {update.problemsOrRisks ? (
                  <p className="mt-0.5 text-xs text-[var(--color-caution-text)]">
                    Risk: {update.problemsOrRisks}
                  </p>
                ) : null}
                {update.proposedNextAction ? (
                  <p className="mt-0.5 text-xs text-[var(--color-text-muted)]">
                    Next: {update.proposedNextAction}
                  </p>
                ) : null}
                <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                  <ProvenanceBadge level="manual" />
                  <span className="text-[0.6875rem] text-[var(--color-text-subtle)]">
                    <RelativeTime iso={update.createdAt} />
                  </span>
                </div>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={pending}
                aria-label="Delete update"
                onClick={() => void remove('updates', update.id, 'Update deleted.')}
              >
                <Trash2 className="h-4 w-4" aria-hidden />
              </Button>
            </li>
          ))}
        </ul>
      )}
    </SectionCard>
  );
}
