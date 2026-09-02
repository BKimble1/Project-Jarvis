import { z } from 'zod';
import { EVIDENCE_KINDS, SOURCE_SYSTEMS } from './enums';
import { externalUrl, isoDateTime } from './project';

export const evidenceKindSchema = z.enum(EVIDENCE_KINDS);
export const sourceSystemSchema = z.enum(SOURCE_SYSTEMS);

/**
 * Structured, provider-specific detail attached to a piece of evidence.
 *
 * Kept as an open record because each provider contributes different keys, but the values are
 * restricted to JSON primitives/arrays so nothing accidentally serialises a client object,
 * a token or an Error with a request header on it.
 */
export const evidenceMetadataSchema = z.record(
  z.string().max(64),
  z.union([
    z.string().max(4000),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(z.union([z.string().max(500), z.number(), z.boolean()])).max(50),
  ]),
);
export type EvidenceMetadata = z.infer<typeof evidenceMetadataSchema>;

/**
 * A single observed fact.
 *
 * `externalId` is the provider's stable identifier; together with (projectId, sourceSystem, kind)
 * it forms the idempotency key for synchronisation, so re-syncing never duplicates rows.
 */
export const evidenceInputSchema = z.object({
  projectId: z.uuid(),
  sourceId: z.uuid().nullable().optional(),
  kind: evidenceKindSchema,
  sourceSystem: sourceSystemSchema,
  externalId: z.string().trim().min(1).max(200),
  title: z.string().trim().min(1).max(500),
  summary: z.string().trim().max(2000).nullable().optional(),
  url: externalUrl.nullable().optional(),
  observedAt: isoDateTime,
  metadata: evidenceMetadataSchema.default({}),
});
export type EvidenceInput = z.infer<typeof evidenceInputSchema>;

export interface Evidence {
  readonly id: string;
  readonly projectId: string;
  readonly sourceId: string | null;
  readonly kind: z.infer<typeof evidenceKindSchema>;
  readonly sourceSystem: z.infer<typeof sourceSystemSchema>;
  readonly externalId: string;
  readonly title: string;
  readonly summary: string | null;
  readonly url: string | null;
  /** When the underlying event happened, according to the source. */
  readonly observedAt: string;
  /** When Jarvis last saw it. Distinguishes "old event" from "stale observation". */
  readonly fetchedAt: string;
  readonly metadata: EvidenceMetadata;
}

/**
 * A statement Jarvis displays, together with why it believes it.
 *
 * Nothing reaches the UI as bare prose: every claim carries a provenance label and, where the
 * source exposes one, the evidence rows (and therefore URLs) that back it.
 */
export interface Claim {
  readonly text: string;
  readonly provenance: 'verified' | 'manual' | 'inferred' | 'unknown';
  readonly evidenceIds: readonly string[];
  /** Machine-readable reason, used by tests and by the "why does it say that?" affordance. */
  readonly rule?: string;
}

export function claim(
  text: string,
  provenance: Claim['provenance'],
  evidenceIds: readonly string[] = [],
  rule?: string,
): Claim {
  return { text, provenance, evidenceIds, ...(rule ? { rule } : {}) };
}

/** Evidence kinds that are produced by the owner rather than observed from a system. */
export const MANUAL_EVIDENCE_KINDS = new Set<z.infer<typeof evidenceKindSchema>>([
  'manual_update',
  'goal',
  'milestone',
  'blocker',
  'decision',
  'next_action',
]);

/**
 * Classify a piece of evidence into a provenance level.
 *
 * Observed provider data is `verified`; owner-entered data is `manual`. Nothing here ever
 * returns `inferred` — inference is the status engine's job, not the evidence store's.
 */
export function classifyEvidence(evidence: Pick<Evidence, 'kind' | 'sourceSystem'>): 'verified' | 'manual' {
  if (evidence.sourceSystem === 'manual') return 'manual';
  if (MANUAL_EVIDENCE_KINDS.has(evidence.kind)) return 'manual';
  return 'verified';
}
