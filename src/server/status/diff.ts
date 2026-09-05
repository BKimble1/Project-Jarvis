import type { Evidence } from '@/domain/evidence';
import type { StatusChange, StatusSnapshot } from '@/domain/status';
import { FAILING_CONCLUSIONS } from './constants';

/**
 * Snapshot comparison — the engine behind "What changed".
 *
 * The rule that matters: **a timestamp is not a change.** Two snapshots differ only when the
 * meaningful content differs (status, phase, completed work, blockers, decisions, actions), which
 * is exactly what the fingerprint captures. Regenerating a briefing over unchanged evidence
 * therefore produces no entries at all.
 */

export interface DiffInput {
  readonly previous: StatusSnapshot | null;
  readonly current: StatusSnapshot;
  /** Evidence observed after the previous snapshot; used for PR/build level detail. */
  readonly evidenceSince: readonly Evidence[];
}

const textsOf = (claims: readonly { text: string }[]): Set<string> =>
  new Set(claims.map((item) => item.text.trim()));

export function diffSnapshots(input: DiffInput): readonly StatusChange[] {
  const { previous, current, evidenceSince } = input;
  const changes: StatusChange[] = [];
  const at = current.generatedAt;

  if (!previous) {
    /* The first snapshot is a baseline, not a set of changes. */
    return evidenceChanges(current.projectId, evidenceSince);
  }

  if (previous.fingerprint === current.fingerprint) {
    return evidenceChanges(current.projectId, evidenceSince);
  }

  if (previous.status !== current.status) {
    changes.push({
      kind: 'status_changed',
      projectId: current.projectId,
      summary: `Status changed from ${previous.status} to ${current.status}`,
      detail: null,
      provenance: 'verified',
      evidenceIds: [],
      occurredAt: at,
    });
  }

  if ((previous.phase ?? null) !== (current.phase ?? null)) {
    changes.push({
      kind: 'phase_changed',
      projectId: current.projectId,
      summary: `Phase changed from ${previous.phase ?? 'none'} to ${current.phase ?? 'none'}`,
      detail: null,
      provenance: 'manual',
      evidenceIds: [],
      occurredAt: at,
    });
  }

  const previousCompleted = textsOf(previous.recentlyCompleted);
  for (const item of current.recentlyCompleted) {
    if (previousCompleted.has(item.text.trim())) continue;
    changes.push({
      kind: 'work_completed',
      projectId: current.projectId,
      summary: item.text,
      detail: null,
      provenance: item.provenance,
      evidenceIds: item.evidenceIds,
      occurredAt: at,
    });
  }

  const previousBlockers = textsOf(previous.blockers);
  const currentBlockers = textsOf(current.blockers);
  for (const item of current.blockers) {
    if (previousBlockers.has(item.text.trim())) continue;
    changes.push({
      kind: 'blocker_added',
      projectId: current.projectId,
      summary: `New blocker: ${item.text}`,
      detail: null,
      provenance: item.provenance,
      evidenceIds: item.evidenceIds,
      occurredAt: at,
    });
  }
  for (const item of previous.blockers) {
    if (currentBlockers.has(item.text.trim())) continue;
    changes.push({
      kind: 'blocker_resolved',
      projectId: current.projectId,
      summary: `Blocker cleared: ${item.text}`,
      detail: null,
      provenance: item.provenance,
      evidenceIds: item.evidenceIds,
      occurredAt: at,
    });
  }

  const previousDecisions = textsOf(previous.decisionsNeeded);
  for (const item of current.decisionsNeeded) {
    if (previousDecisions.has(item.text.trim())) continue;
    changes.push({
      kind: 'decision_recorded',
      projectId: current.projectId,
      summary: `Decision needed: ${item.text}`,
      detail: null,
      provenance: item.provenance,
      evidenceIds: item.evidenceIds,
      occurredAt: at,
    });
  }

  const previousActions = new Set(previous.recommendedActions.map((item) => item.action.trim()));
  const currentActions = current.recommendedActions.map((item) => item.action.trim());
  const newActions = currentActions.filter((action) => !previousActions.has(action));
  if (newActions.length > 0) {
    changes.push({
      kind: 'next_actions_changed',
      projectId: current.projectId,
      summary:
        newActions.length === 1
          ? `New recommended action: ${newActions[0]}`
          : `${newActions.length} new recommended actions`,
      detail: newActions.join(' · '),
      provenance: 'inferred',
      evidenceIds: [],
      occurredAt: at,
    });
  }

  return [...changes, ...evidenceChanges(current.projectId, evidenceSince)];
}

/** Evidence-level changes (PR opened/merged, build failed/recovered) with verified provenance. */
export function evidenceChanges(
  projectId: string,
  evidence: readonly Evidence[],
): readonly StatusChange[] {
  const changes: StatusChange[] = [];
  const workflowsSeen = new Set<string>();

  for (const item of [...evidence].sort(
    (a, b) => new Date(b.observedAt).getTime() - new Date(a.observedAt).getTime(),
  )) {
    if (item.kind === 'pull_request') {
      const merged = item.metadata.merged === true;
      const state = typeof item.metadata.state === 'string' ? item.metadata.state : 'open';
      if (merged) {
        changes.push(change('pr_merged', projectId, `Merged ${item.title}`, item));
      } else if (state === 'open') {
        changes.push(change('pr_opened', projectId, `Opened ${item.title}`, item));
      }
      continue;
    }
    if (item.kind === 'workflow_run') {
      const name =
        typeof item.metadata.workflowName === 'string' ? item.metadata.workflowName : item.title;
      if (workflowsSeen.has(name)) continue;
      workflowsSeen.add(name);
      const conclusion =
        typeof item.metadata.conclusion === 'string' ? item.metadata.conclusion : null;
      if (conclusion && FAILING_CONCLUSIONS.has(conclusion)) {
        changes.push(change('workflow_failed', projectId, `${name} failed`, item));
      } else if (conclusion === 'success') {
        changes.push(change('workflow_recovered', projectId, `${name} is green`, item));
      }
    }
  }
  return changes;
}

function change(
  kind: StatusChange['kind'],
  projectId: string,
  summary: string,
  evidence: Evidence,
): StatusChange {
  return {
    kind,
    projectId,
    summary,
    detail: evidence.summary,
    provenance: evidence.sourceSystem === 'manual' ? 'manual' : 'verified',
    evidenceIds: [evidence.id],
    occurredAt: evidence.observedAt,
  };
}
