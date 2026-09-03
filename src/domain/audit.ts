/**
 * Audit integrity.
 *
 * The audit trail answers "what happened, who asked for it, and what did the system decide?".
 * That is only useful if the answer cannot be quietly changed afterwards, so each record's hash
 * covers both its own content and the hash of the record before it. Removing a row, editing a
 * summary or reordering two events all break the chain at a nameable point.
 *
 * What this is **not**: secrecy, or protection against someone with database access. Anyone who
 * can write to the table can rewrite the whole chain from the break onwards. What it prevents is
 * doing so *undetectably* — and a tamper-evident log with a modest threat model is far better
 * than an append-only log with none, because it makes silent editing a thing that shows.
 *
 * Two decisions worth stating:
 *
 *  - The canonical form is built field by field, in a fixed order, with lengths prefixed. It is
 *    not `JSON.stringify`, whose key order is insertion order and therefore not canonical at all.
 *    Length prefixing is the same fix the CI dispatch identity needed: without it, moving a
 *    character across a separator produces a different record with the same hash.
 *  - `detail` is hashed as canonical JSON with sorted keys, so a re-serialised object hashes the
 *    same.
 */
import { createHash } from 'node:crypto';

export const AUDIT_ACTOR_KINDS = [
  'owner',
  'system',
  'worker',
  'agent',
  'schedule',
  'display',
] as const;
export type AuditActorKind = (typeof AUDIT_ACTOR_KINDS)[number];

export const AUDIT_OUTCOMES = ['allowed', 'refused', 'failed'] as const;
export type AuditOutcome = (typeof AUDIT_OUTCOMES)[number];

/** Everything the hash covers. Anything not in here is not protected, so nothing is left out. */
export interface AuditHashInput {
  readonly sequence: number;
  readonly id: string;
  readonly actor: string;
  readonly actorKind: string;
  readonly action: string;
  readonly subjectKind: string | null;
  readonly subjectId: string | null;
  readonly projectId: string | null;
  readonly missionId: string | null;
  readonly outcome: string;
  readonly rule: string | null;
  readonly summary: string;
  readonly detail: Record<string, unknown>;
  readonly occurredAt: string;
  readonly previousHash: string | null;
}

/**
 * The token that stands in for an absent value.
 *
 * A leading space makes it unrepresentable as a real identifier — every field that can be null
 * here is trimmed before storage — so "no rule" and "a rule literally called null" cannot hash
 * alike. Using the empty string instead would collide with a field that is present but blank.
 */
const ABSENT = ' (null)';

/**
 * The exact bytes a record's hash is taken over.
 *
 * Every part is length-prefixed, so no arrangement of content can imitate a different record's
 * canonical form.
 */
export function canonicalAuditForm(input: AuditHashInput): string {
  const parts: readonly string[] = [
    String(input.sequence),
    input.id,
    input.actor,
    input.actorKind,
    input.action,
    nullable(input.subjectKind),
    nullable(input.subjectId),
    nullable(input.projectId),
    nullable(input.missionId),
    input.outcome,
    nullable(input.rule),
    input.summary,
    canonicalJson(input.detail),
    input.occurredAt,
    nullable(input.previousHash),
  ];
  return parts.map((part) => `${part.length}:${part}`).join('|');
}

function nullable(value: string | null): string {
  return value === null ? ABSENT : value;
}

/** JSON with keys sorted at every depth, so an equal object always produces equal text. */
export function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'null';
  if (typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(',')}}`;
  }
  return 'null';
}

export function auditHash(input: AuditHashInput): string {
  return createHash('sha256').update(canonicalAuditForm(input), 'utf8').digest('hex');
}

export interface ChainLink extends AuditHashInput {
  readonly hash: string;
}

export interface ChainVerdict {
  readonly ok: boolean;
  readonly checked: number;
  readonly brokenAt: number | null;
  readonly reason: string | null;
}

/**
 * Walk a chain and say whether it reconciles.
 *
 * Two failures are distinguished on purpose, because they mean different things:
 *
 *  - **R-AU1** — a record's own hash does not match its content. The record was edited.
 *  - **R-AU2** — a record's `previousHash` does not match the hash of the record before it. A
 *    record was removed, inserted or reordered.
 *
 * Records must arrive in ascending sequence order; a caller reading a page of the newest events
 * reverses them first. Verifying a suffix is meaningful — it proves that part is internally
 * consistent — and the verdict reports how many links were actually checked so a partial
 * verification cannot be mistaken for a whole one.
 */
export function verifyChain(links: readonly ChainLink[]): ChainVerdict {
  let previous: ChainLink | null = null;

  for (const link of links) {
    const expected = auditHash(link);
    if (expected !== link.hash) {
      return {
        ok: false,
        checked: links.length,
        brokenAt: link.sequence,
        reason: `Record ${link.sequence} does not match its own hash (R-AU1).`,
      };
    }
    if (previous && link.previousHash !== previous.hash) {
      return {
        ok: false,
        checked: links.length,
        brokenAt: link.sequence,
        reason: `Record ${link.sequence} does not follow record ${previous.sequence} (R-AU2).`,
      };
    }
    previous = link;
  }

  return { ok: true, checked: links.length, brokenAt: null, reason: null };
}

/**
 * Actions worth auditing, named once so a caller cannot invent a near-duplicate.
 *
 * A free-form string would drift into `mission_approve`, `approve_mission` and `missionApproved`
 * within a month, and a trail nobody can query is a trail nobody reads.
 */
export const AUDIT_ACTIONS = [
  'qualification.run',
  'qualification.activate',
  'qualification.waive',
  'activation.refused',
  'knowledge.create',
  'knowledge.confirm',
  'knowledge.reject',
  'knowledge.supersede',
  'knowledge.forget',
  'knowledge.conflict_resolved',
  'source.add',
  'source.delete',
  'source.fetch_refused',
  'answer.ask',
  'answer.rejected',
  'schedule.create',
  'schedule.update',
  'schedule.delete',
  'schedule.run',
  'schedule.skipped',
  'briefing.generate',
  'notification.send',
  'notification.suppressed',
  'push.register',
  'push.revoke',
  'voice.confirm',
  'voice.refused',
  'budget.create',
  'budget.override',
  'budget.refused',
  'connector.enable',
  'connector.disable',
  'connector.revoke',
  'connector.refused',
  'export.create',
  'retention.purge',
  'ratelimit.refused',
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];
