'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import {
  CheckCircle2,
  ClipboardCheck,
  Loader2,
  Pencil,
  RotateCcw,
  ShieldAlert,
  X,
} from 'lucide-react';
import { toast } from 'sonner';
import type { Mission } from '@/domain/mission';
import { MISSION_RISK_LABELS } from '@/domain/mission';
import type { MissionApproval, MissionPlan } from '@/domain/mission-plan';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Field, Input, Textarea } from '@/components/ui/field';
import { RelativeTime } from '@/components/relative-time';
import { ProvenanceBadge } from '@/components/provenance';
import { MissionRiskPill } from './mission-pills';

/**
 * Plan review and approval.
 *
 * Two things are load-bearing in this component.
 *
 * First, **the approve button sends the plan version and the risk level the owner was shown.**
 * If either changed since the page loaded, the server refuses and says so, so approval can never
 * apply to a plan the owner did not read.
 *
 * Second, **a paused or completed project requires a separate, explicit override checkbox.** It
 * is not folded into the approve action, because "yes, run this" and "yes, run this even though I
 * paused the project" are different decisions.
 */

export function PlanReview({
  mission,
  plan,
  approval,
  canQueue,
  requiresOverride,
  overrideNotice,
}: {
  mission: Mission;
  plan: MissionPlan | null;
  approval: MissionApproval | null;
  canQueue: { ok: boolean; reason: string | null };
  requiresOverride: boolean;
  overrideNotice: string | null;
}) {
  const router = useRouter();
  const [pending, setPending] = React.useState<string | null>(null);
  const [editing, setEditing] = React.useState(false);
  const [override, setOverride] = React.useState(false);
  const [note, setNote] = React.useState('');

  if (!plan) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>No plan yet</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-[var(--color-text-muted)]">
            Jarvis plans before it does anything. Ask it to plan this mission and it will inspect
            the repository read-only first.
          </p>
          <Button
            className="mt-3"
            disabled={pending !== null}
            onClick={() => void act('plan')}
            type="button"
          >
            {pending === 'plan' ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            ) : (
              <ClipboardCheck className="h-4 w-4" aria-hidden />
            )}
            Plan this mission
          </Button>
        </CardContent>
      </Card>
    );
  }

  /* Bound to a const so the closures below keep the narrowing from the early return above. */
  const current = plan;
  const content = current.content;
  const isApproved = approval !== null && approval.planVersion === mission.currentPlanVersion;

  async function act(kind: string, body?: unknown, url?: string) {
    setPending(kind);
    try {
      const response = await fetch(url ?? `/api/missions/${mission.id}/plan`, {
        method: kind === 'plan' ? 'POST' : 'PATCH',
        headers: { 'content-type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const data = (await response.json()) as { error?: { message: string } };
      if (!response.ok) {
        toast.error(data.error?.message ?? 'That did not work.');
        return;
      }
      toast.success(SUCCESS[kind] ?? 'Done.');
      setEditing(false);
      router.refresh();
    } catch {
      toast.error('Could not reach the server.');
    } finally {
      setPending(null);
    }
  }

  async function approve() {
    setPending('approve');
    try {
      const response = await fetch(`/api/missions/${mission.id}/approve`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          /* Both are what this page rendered; the server rejects a mismatch. */
          planVersion: current.version,
          acknowledgedRiskLevel: mission.riskLevel,
          pausedProjectOverride: override,
          note: note.trim().length > 0 ? note.trim() : null,
        }),
      });
      const data = (await response.json()) as { error?: { message: string } };
      if (!response.ok) {
        toast.error(data.error?.message ?? 'The plan could not be approved.');
        return;
      }
      toast.success('Approved and queued. A worker will pick it up.');
      router.refresh();
    } catch {
      toast.error('Could not reach the server.');
    } finally {
      setPending(null);
    }
  }

  if (editing) {
    return (
      <PlanEditor
        plan={plan}
        pending={pending === 'edit'}
        onCancel={() => setEditing(false)}
        onSave={(next) => void act('edit', { action: 'edit', content: next })}
      />
    );
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle>Plan · version {plan.version}</CardTitle>
          <div className="flex flex-wrap items-center gap-1.5">
            <MissionRiskPill risk={mission.riskLevel} />
            <ProvenanceBadge level={plan.provenance} />
          </div>
        </div>
        <p className="text-xs text-[var(--color-text-subtle)]">
          {plan.author === 'worker_inspection'
            ? 'Built by a worker that read the repository'
            : plan.author === 'owner_edit'
              ? 'Edited by you'
              : 'Drafted by Jarvis from the project record, without inspecting the repository'}{' '}
          · <RelativeTime iso={plan.createdAt} />
        </p>
      </CardHeader>

      <CardContent className="flex flex-col gap-4 pt-0">
        <Section title="Proposed outcome">
          <p className="text-sm">{content.proposedOutcome}</p>
        </Section>
        <Section title="Summary">
          <p className="text-sm text-[var(--color-text-muted)]">{content.summary}</p>
        </Section>
        <Section title="Approach">
          <pre className="jarvis-scroll-x rounded-lg bg-[var(--color-surface-muted)] p-3 text-xs whitespace-pre-wrap">
            {content.approach}
          </pre>
        </Section>

        <div className="grid gap-4 sm:grid-cols-2">
          <ListSection title="In scope" items={content.scope} />
          <ListSection title="Out of scope" items={content.outOfScope} tone="muted" />
          <ListSection title="Assumptions" items={content.assumptions} tone="muted" />
          <ListSection title="Likely affected" items={content.affectedAreas} mono />
          <ListSection title="Tests" items={content.testsToAddOrUpdate} />
          <ListSection title="Acceptance criteria" items={content.acceptanceCriteria} />
          <ListSection title="Data migrations" items={content.dataMigrations} />
          <ListSection title="UI validation" items={content.uiValidation} />
        </div>

        {content.verification.length > 0 ? (
          <Section title="Verification">
            <ul className="flex flex-col gap-1">
              {content.verification.map((entry) => (
                <li key={entry.command} className="text-sm">
                  <code className="rounded bg-[var(--color-surface-muted)] px-1.5 py-0.5 text-xs">
                    {entry.command}
                  </code>
                  <span className="ml-2 text-xs text-[var(--color-text-muted)]">
                    {entry.purpose} · found in {entry.source.replace(/_/g, ' ')}
                  </span>
                  {entry.expectedUnavailableReason ? (
                    <p className="mt-0.5 text-xs text-[var(--color-caution-text)]">
                      {entry.expectedUnavailableReason}
                    </p>
                  ) : null}
                </li>
              ))}
            </ul>
          </Section>
        ) : null}

        {content.risks.length > 0 ? (
          <Section title="Risks">
            <ul className="flex flex-col gap-1.5">
              {content.risks.map((risk, index) => (
                <li key={index} className="text-sm">
                  <span className="font-medium">{risk.description}</span>
                  <p className="text-xs text-[var(--color-text-muted)]">
                    Mitigation: {risk.mitigation}
                  </p>
                </li>
              ))}
            </ul>
          </Section>
        ) : null}

        <Section title="Rollback">
          <p className="text-sm text-[var(--color-text-muted)]">{content.rollback}</p>
        </Section>

        {content.openQuestions.length > 0 ? (
          <ListSection title="Still unresolved" items={content.openQuestions} tone="caution" />
        ) : null}

        {!content.withinRequestedScope ? (
          <p className="rounded-lg bg-[var(--color-caution-soft)] px-3 py-2 text-xs text-[var(--color-caution-text)]">
            This plan says it goes beyond what you asked for. {content.scopeNotes ?? ''}
          </p>
        ) : null}

        {/* ------------------------------------------------------- approval */}

        {isApproved ? (
          <div className="rounded-lg bg-[var(--color-positive-soft)] px-3 py-2.5 text-sm text-[var(--color-positive-text)]">
            <p className="flex items-center gap-1.5 font-medium">
              <CheckCircle2 className="h-4 w-4" aria-hidden />
              You approved version {approval.planVersion}
            </p>
            <p className="mt-0.5 text-xs">
              Approved as {MISSION_RISK_LABELS[approval.approvedRiskLevel].toLowerCase()} by{' '}
              {approval.approvedBy} · <RelativeTime iso={approval.approvedAt} />
              {approval.note ? ` — “${approval.note}”` : ''}
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-3 border-t border-[var(--color-border)] pt-4">
            {!canQueue.ok && canQueue.reason ? (
              <p className="flex items-start gap-2 rounded-lg bg-[var(--color-caution-soft)] px-3 py-2 text-xs text-[var(--color-caution-text)]">
                <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
                <span>{canQueue.reason}</span>
              </p>
            ) : null}

            {requiresOverride ? (
              <label className="flex items-start gap-2 rounded-lg border border-[var(--color-caution)]/40 bg-[var(--color-caution-soft)]/50 px-3 py-2.5 text-xs">
                <input
                  type="checkbox"
                  checked={override}
                  onChange={(event) => setOverride(event.target.checked)}
                  className="mt-0.5 h-4 w-4 shrink-0"
                />
                <span>
                  <span className="font-medium">Run this once anyway.</span>{' '}
                  {overrideNotice ?? 'This project’s state normally stops work from running.'}
                </span>
              </label>
            ) : null}

            <Field label="Note (optional)" htmlFor="approval-note">
              <Input
                id="approval-note"
                value={note}
                onChange={(event) => setNote(event.target.value)}
                placeholder="Anything to record with this approval"
                maxLength={1000}
              />
            </Field>

            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                onClick={() => void approve()}
                disabled={pending !== null || (requiresOverride && !override)}
              >
                {pending === 'approve' ? (
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                ) : (
                  <CheckCircle2 className="h-4 w-4" aria-hidden />
                )}
                Approve version {plan.version} and queue
              </Button>
              <Button
                type="button"
                variant="secondary"
                onClick={() => setEditing(true)}
                disabled={pending !== null}
              >
                <Pencil className="h-4 w-4" aria-hidden />
                Edit
              </Button>
              <Button
                type="button"
                variant="secondary"
                onClick={() => {
                  const instruction = window.prompt('What should the revised plan do differently?');
                  if (instruction && instruction.trim().length > 0) {
                    void act('revise', { action: 'revise', instruction: instruction.trim() });
                  }
                }}
                disabled={pending !== null}
              >
                <RotateCcw className="h-4 w-4" aria-hidden />
                Request revision
              </Button>
              <Button
                type="button"
                variant="ghost"
                onClick={() => void act('reject', { action: 'reject', reason: null })}
                disabled={pending !== null}
              >
                <X className="h-4 w-4" aria-hidden />
                Reject
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

const SUCCESS: Record<string, string> = {
  plan: 'Planning started.',
  edit: 'Saved as a new plan version. It needs approving again.',
  revise: 'Revision requested.',
  reject: 'Plan rejected.',
};

/**
 * The plan editor.
 *
 * Deliberately edits the fields an owner actually wants to constrain — scope, out of scope,
 * acceptance, do-not-touch — rather than offering a raw JSON box. Saving creates a new version,
 * which is stated on the button so nobody is surprised when their approval is revoked.
 */
function PlanEditor({
  plan,
  pending,
  onCancel,
  onSave,
}: {
  plan: MissionPlan;
  pending: boolean;
  onCancel: () => void;
  onSave: (content: MissionPlan['content']) => void;
}) {
  const [scope, setScope] = React.useState(plan.content.scope.join('\n'));
  const [outOfScope, setOutOfScope] = React.useState(plan.content.outOfScope.join('\n'));
  const [acceptance, setAcceptance] = React.useState(plan.content.acceptanceCriteria.join('\n'));
  const [approach, setApproach] = React.useState(plan.content.approach);

  const lines = (value: string) =>
    value
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .slice(0, 30);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Edit plan · creates version {plan.version + 1}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 pt-0">
        <Field label="Approach" htmlFor="plan-approach">
          <Textarea
            id="plan-approach"
            value={approach}
            onChange={(event) => setApproach(event.target.value)}
            rows={8}
            maxLength={6000}
          />
        </Field>
        <Field label="In scope (one per line)" htmlFor="plan-scope">
          <Textarea
            id="plan-scope"
            value={scope}
            onChange={(event) => setScope(event.target.value)}
            rows={4}
          />
        </Field>
        <Field label="Out of scope (one per line)" htmlFor="plan-out">
          <Textarea
            id="plan-out"
            value={outOfScope}
            onChange={(event) => setOutOfScope(event.target.value)}
            rows={4}
          />
        </Field>
        <Field label="Acceptance criteria (one per line)" htmlFor="plan-acceptance">
          <Textarea
            id="plan-acceptance"
            value={acceptance}
            onChange={(event) => setAcceptance(event.target.value)}
            rows={4}
          />
        </Field>
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            disabled={pending}
            onClick={() =>
              onSave({
                ...plan.content,
                approach: approach.trim() || plan.content.approach,
                scope: lines(scope),
                outOfScope: lines(outOfScope),
                acceptanceCriteria: lines(acceptance),
              })
            }
          >
            {pending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
            Save as version {plan.version + 1}
          </Button>
          <Button type="button" variant="ghost" onClick={onCancel} disabled={pending}>
            Cancel
          </Button>
        </div>
        <p className="text-xs text-[var(--color-text-muted)]">
          Saving creates a new version and revokes any approval on the current one — nothing runs
          until you approve the new version.
        </p>
      </CardContent>
    </Card>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="text-xs font-semibold tracking-wide text-[var(--color-text-subtle)] uppercase">
        {title}
      </p>
      <div className="mt-1">{children}</div>
    </div>
  );
}

function ListSection({
  title,
  items,
  tone = 'default',
  mono = false,
}: {
  title: string;
  items: readonly string[];
  tone?: 'default' | 'muted' | 'caution';
  mono?: boolean;
}) {
  if (items.length === 0) return null;
  return (
    <div>
      <p className="text-xs font-semibold tracking-wide text-[var(--color-text-subtle)] uppercase">
        {title}
      </p>
      <ul className="mt-1 flex flex-col gap-1">
        {items.map((item, index) => (
          <li
            key={`${title}-${index}`}
            className={
              tone === 'caution'
                ? 'text-sm text-[var(--color-caution-text)]'
                : tone === 'muted'
                  ? 'text-sm text-[var(--color-text-muted)]'
                  : 'text-sm'
            }
          >
            {mono ? (
              <code className="rounded bg-[var(--color-surface-muted)] px-1 py-0.5 text-xs break-all">
                {item}
              </code>
            ) : (
              item
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
