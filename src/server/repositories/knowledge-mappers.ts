import type { KnowledgeConflict, KnowledgeItem } from '@/domain/knowledge';
import type { KnowledgeChunk, KnowledgeSource } from '@/domain/knowledge-source';
import type {
  answers,
  knowledgeChunks,
  knowledgeConflicts,
  knowledgeItems,
  knowledgeSources,
} from '@/server/db/schema';
import type { StoredAnswer } from './knowledge-types';
import { iso, isoRequired } from './mappers';

/**
 * Row → domain mapping for knowledge.
 *
 * `toKnowledgeSource` has no `bodyText` field. The full text is deliberately unreachable through
 * the ordinary read path — a caller that wants it asks `readBody` and says so — so a listing
 * cannot accidentally ship a private document into a response.
 */

type Row<T extends { $inferSelect: unknown }> = T['$inferSelect'];

export function toKnowledgeSource(row: Row<typeof knowledgeSources>): KnowledgeSource {
  return {
    id: row.id,
    kind: row.kind,
    state: row.state,
    title: row.title,
    origin: row.origin,
    projectId: row.projectId,
    scope: row.scope,
    sensitivity: row.sensitivity,
    refreshable: row.refreshable,
    activeRevisionId: row.activeRevisionId,
    lastRefreshedAt: iso(row.lastRefreshedAt),
    contentHash: row.contentHash,
    byteSize: row.byteSize,
    charCount: row.charCount,
    chunkCount: row.chunkCount,
    version: row.version,
    contentType: row.contentType,
    unitCount: row.unitCount,
    failureCode: row.failureCode,
    failureMessage: row.failureMessage,
    retryCount: row.retryCount,
    truncated: row.truncated,
    addedBy: row.addedBy,
    createdAt: isoRequired(row.createdAt),
    updatedAt: isoRequired(row.updatedAt),
    parsedAt: iso(row.parsedAt),
    deletedAt: iso(row.deletedAt),
    retainUntil: iso(row.retainUntil),
  };
}

export function toKnowledgeChunk(row: Row<typeof knowledgeChunks>): KnowledgeChunk {
  return {
    id: row.id,
    sourceId: row.sourceId,
    projectId: row.projectId,
    ordinal: row.ordinal,
    locator: row.locator,
    heading: row.heading,
    text: row.text,
    charCount: row.charCount,
    createdAt: isoRequired(row.createdAt),
  };
}

export function toKnowledgeItem(row: Row<typeof knowledgeItems>): KnowledgeItem {
  return {
    id: row.id,
    scope: row.scope,
    category: row.category,
    origin: row.origin,
    status: row.status,
    statusRule: row.statusRule,
    sensitivity: row.sensitivity,
    statement: row.statement,
    detail: row.detail,
    projectId: row.projectId,
    missionId: row.missionId,
    sourceId: row.sourceId,
    sourceRef: row.sourceRef,
    excerpts: row.excerpts ?? [],
    tags: row.tags ?? [],
    createdBy: row.createdBy,
    createdAt: isoRequired(row.createdAt),
    updatedAt: isoRequired(row.updatedAt),
    confirmedAt: iso(row.confirmedAt),
    confirmedBy: row.confirmedBy,
    reviewAt: iso(row.reviewAt),
    expiresAt: iso(row.expiresAt),
    supersedesId: row.supersedesId,
    supersededById: row.supersededById,
    supersededReason: row.supersededReason,
    rejectedReason: row.rejectedReason,
    forgottenAt: iso(row.forgottenAt),
    useCount: row.useCount,
    lastUsedAt: iso(row.lastUsedAt),
    confidence: row.confidence,
  };
}

export function toKnowledgeConflict(row: Row<typeof knowledgeConflicts>): KnowledgeConflict {
  return {
    id: row.id,
    kind: row.kind,
    state: row.state,
    leftId: row.leftId,
    rightId: row.rightId,
    projectId: row.projectId,
    summary: row.summary,
    detectedRule: row.detectedRule,
    resolution: row.resolution,
    resolvedAt: iso(row.resolvedAt),
    createdAt: isoRequired(row.createdAt),
  };
}

export function toStoredAnswer(row: Row<typeof answers>): StoredAnswer {
  return {
    id: row.id,
    question: row.question,
    scope: row.scope,
    projectIds: row.projectIds ?? [],
    headline: row.headline,
    claims: row.claims ?? [],
    considered: row.considered,
    method: row.method,
    rejectionRule: row.rejectionRule,
    rejectionReason: row.rejectionReason,
    missionSuggestion: row.missionSuggestion ?? null,
    savedView: row.savedView,
    durationMs: row.durationMs,
    askedBy: row.askedBy,
    generatedAt: isoRequired(row.generatedAt),
  };
}
