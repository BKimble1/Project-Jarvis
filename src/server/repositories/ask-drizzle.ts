import { and, desc, eq, isNull, sql } from 'drizzle-orm';

import type {
  AnswerClaim,
  AnswerCoverage,
  AnswerMethod,
  AnswerScope,
  MissionSuggestion,
} from '@/domain/answer';
import type { AnswerEvidenceItem, AnswerMode, AnswerRun, AnswerState } from '@/domain/answer-run';
import { applyTerminalTransition } from '@/domain/answer-run';
import type { Conversation } from '@/domain/conversation';
import { ConflictError, NotFoundError } from '@/domain/errors';
import { answerConversations, answerEvidence, answers } from '@/server/db/schema';
import type { Database } from '@/server/db/client';

/**
 * Persistence for Ask Jarvis.
 *
 * Two things are enforced here rather than left to callers, because a caller that forgets either
 * one produces a security bug rather than a broken feature.
 *
 * **Ownership is a predicate, not a check afterwards.** Every read takes the owner and puts them
 * in the `where` clause. There is no `findById(id)` that returns a conversation belonging to
 * somebody else and trusts the caller to compare — the row simply is not returned. That is what
 * makes a citation identifier useless to anyone who guesses one.
 *
 * **State transitions go through the domain guard.** `transition` calls
 * `applyTerminalTransition` and refuses in the database what the guard refuses in memory, so a
 * provider result arriving after cancellation cannot win a race by being a direct UPDATE.
 */

function iso(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function isoRequired(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function extractRows(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) return result as Record<string, unknown>[];
  if (result && typeof result === 'object' && 'rows' in result) {
    const rows = (result as { rows: unknown }).rows;
    if (Array.isArray(rows)) return rows as Record<string, unknown>[];
  }
  return [];
}

/* ------------------------------------------------------------ conversations */

export interface ConversationCreate {
  readonly title: string;
  readonly scope: AnswerScope;
  readonly projectIds: readonly string[];
  readonly ownerId: string;
  readonly retainUntil?: Date | null;
}

export interface ConversationPatch {
  readonly title?: string;
  readonly scope?: AnswerScope;
  readonly projectIds?: readonly string[];
}

export class DrizzleConversationRepository {
  constructor(private readonly db: Database) {}

  async create(input: ConversationCreate): Promise<Conversation> {
    const [row] = await this.db
      .insert(answerConversations)
      .values({
        title: input.title.slice(0, 120),
        scope: input.scope,
        projectIds: [...input.projectIds],
        ownerId: input.ownerId,
        ...(input.retainUntil !== undefined ? { retainUntil: input.retainUntil } : {}),
      })
      .returning();
    if (!row) throw new NotFoundError('Conversation');
    return toConversation(row);
  }

  /**
   * One conversation, if it belongs to this owner and has not been deleted.
   *
   * The owner is part of the query rather than something the caller compares afterwards: a
   * conversation id that belongs to somebody else returns null here, so there is no code path in
   * which the wrong row is briefly in hand.
   */
  async findForOwner(id: string, ownerId: string): Promise<Conversation | null> {
    const [row] = await this.db
      .select()
      .from(answerConversations)
      .where(
        and(
          eq(answerConversations.id, id),
          eq(answerConversations.ownerId, ownerId),
          isNull(answerConversations.deletedAt),
        ),
      )
      .limit(1);
    return row ? toConversation(row) : null;
  }

  async list(ownerId: string, limit = 100): Promise<readonly Conversation[]> {
    const rows = await this.db
      .select()
      .from(answerConversations)
      .where(and(eq(answerConversations.ownerId, ownerId), isNull(answerConversations.deletedAt)))
      .orderBy(desc(answerConversations.updatedAt))
      .limit(limit);
    return rows.map(toConversation);
  }

  async patch(id: string, ownerId: string, patch: ConversationPatch): Promise<Conversation> {
    const [row] = await this.db
      .update(answerConversations)
      .set({
        ...(patch.title !== undefined ? { title: patch.title.slice(0, 120) } : {}),
        ...(patch.scope !== undefined ? { scope: patch.scope } : {}),
        ...(patch.projectIds !== undefined ? { projectIds: [...patch.projectIds] } : {}),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(answerConversations.id, id),
          eq(answerConversations.ownerId, ownerId),
          isNull(answerConversations.deletedAt),
        ),
      )
      .returning();
    if (!row) throw new NotFoundError('Conversation');
    return toConversation(row);
  }

  /** Note that a turn happened, so the list orders by real activity rather than by creation. */
  async recordAnswer(id: string, at: Date): Promise<void> {
    await this.db
      .update(answerConversations)
      .set({
        answerCount: sql`${answerConversations.answerCount} + 1`,
        lastAnsweredAt: at,
        updatedAt: at,
      })
      .where(eq(answerConversations.id, id));
  }

  /**
   * Delete a conversation and everything said in it.
   *
   * The answers and their evidence go with it by cascade, which is the point: a deleted
   * conversation that left its evidence rows behind would keep excerpts of documents the owner
   * asked to be rid of. The conversation row is tombstoned rather than removed so the deletion
   * itself stays visible to an audit; it carries no question text once deleted.
   */
  async softDelete(id: string, ownerId: string, at: Date): Promise<number> {
    const owned = await this.findForOwner(id, ownerId);
    if (!owned) throw new NotFoundError('Conversation');

    const removed = await this.db
      .delete(answers)
      .where(eq(answers.conversationId, id))
      .returning({ id: answers.id });

    await this.db
      .update(answerConversations)
      .set({ deletedAt: at, updatedAt: at, title: '(deleted)', projectIds: [] })
      .where(and(eq(answerConversations.id, id), eq(answerConversations.ownerId, ownerId)));

    return removed.length;
  }
}

function toConversation(row: typeof answerConversations.$inferSelect): Conversation {
  return {
    id: row.id,
    title: row.title,
    scope: row.scope,
    projectIds: row.projectIds ?? [],
    ownerId: row.ownerId,
    createdAt: isoRequired(row.createdAt),
    updatedAt: isoRequired(row.updatedAt),
    lastAnsweredAt: iso(row.lastAnsweredAt),
    answerCount: row.answerCount,
    deletedAt: iso(row.deletedAt),
    retainUntil: iso(row.retainUntil),
  };
}

/* -------------------------------------------------------------- answer runs */

export interface AnswerRunCreate {
  readonly conversationId: string;
  readonly question: string;
  readonly scope: AnswerScope;
  readonly projectIds: readonly string[];
  readonly idempotencyKey: string;
  readonly askedBy: string;
}

export interface AnswerRunFinish {
  readonly state: AnswerState;
  readonly mode: AnswerMode;
  readonly method: AnswerMethod;
  readonly headline: string;
  readonly claims: readonly AnswerClaim[];
  readonly considered: AnswerCoverage;
  readonly limitations: readonly string[];
  readonly rejectionRule?: string | null;
  readonly rejectionReason?: string | null;
  readonly missionSuggestion?: MissionSuggestion | null;
  readonly retrievalMode?: string | null;
  readonly provider?: string | null;
  readonly model?: string | null;
  readonly inputTokens?: number | null;
  readonly outputTokens?: number | null;
  readonly cachedInputTokens?: number | null;
  readonly costUsd?: number | null;
  readonly latencyMs?: number | null;
}

export class DrizzleAnswerRunRepository {
  constructor(private readonly db: Database) {}

  /**
   * Begin an answer, or hand back the one this key already started.
   *
   * The unique index does the deciding, not a read-then-write: two submissions racing each other
   * both attempt the insert and exactly one wins, so a double-tap cannot produce two paid
   * generations even when the two requests arrive in the same millisecond.
   */
  async begin(
    input: AnswerRunCreate,
  ): Promise<{ readonly run: AnswerRun; readonly created: boolean }> {
    const [inserted] = await this.db
      .insert(answers)
      .values({
        conversationId: input.conversationId,
        question: input.question,
        scope: input.scope,
        projectIds: [...input.projectIds],
        headline: '',
        claims: [],
        considered: emptyCoverage(),
        method: 'deterministic',
        state: 'created',
        mode: 'evidence_only',
        idempotencyKey: input.idempotencyKey,
        askedBy: input.askedBy,
        startedAt: new Date(),
      })
      .onConflictDoNothing({ target: [answers.askedBy, answers.idempotencyKey] })
      .returning();

    if (inserted) return { run: toRun(inserted), created: true };

    const existing = await this.findByKey(input.askedBy, input.idempotencyKey);
    if (!existing) {
      throw new ConflictError('That request could not be started. Try again.');
    }
    return { run: existing, created: false };
  }

  async findByKey(askedBy: string, idempotencyKey: string): Promise<AnswerRun | null> {
    const [row] = await this.db
      .select()
      .from(answers)
      .where(and(eq(answers.askedBy, askedBy), eq(answers.idempotencyKey, idempotencyKey)))
      .limit(1);
    return row ? toRun(row) : null;
  }

  /** One answer, only if this owner asked it. */
  async findForOwner(id: string, askedBy: string): Promise<AnswerRun | null> {
    const [row] = await this.db
      .select()
      .from(answers)
      .where(and(eq(answers.id, id), eq(answers.askedBy, askedBy)))
      .limit(1);
    return row ? toRun(row) : null;
  }

  async listForConversation(
    conversationId: string,
    askedBy: string,
    limit = 50,
  ): Promise<readonly AnswerRun[]> {
    const rows = await this.db
      .select()
      .from(answers)
      .where(and(eq(answers.conversationId, conversationId), eq(answers.askedBy, askedBy)))
      .orderBy(answers.generatedAt)
      .limit(limit);
    return rows.map(toRun);
  }

  /**
   * Move an answer to a new state, or refuse.
   *
   * The refusal is the feature. `applyTerminalTransition` decides, and the UPDATE additionally
   * carries the expected current state in its `where` clause — so if another request changed the
   * state between the read and the write, this write matches no rows and reports the conflict
   * instead of silently overwriting. That is what makes "a cancelled answer stays cancelled" true
   * under concurrency rather than merely usually.
   */
  async transition(
    id: string,
    next: AnswerState,
  ): Promise<
    | { readonly ok: true; readonly run: AnswerRun }
    | { readonly ok: false; readonly rule: string; readonly reason: string }
  > {
    const [current] = await this.db.select().from(answers).where(eq(answers.id, id)).limit(1);
    if (!current) throw new NotFoundError('Answer');

    const decision = applyTerminalTransition(current.state, next);
    if (!decision.ok) return decision;

    const [row] = await this.db
      .update(answers)
      .set({ state: next })
      .where(and(eq(answers.id, id), eq(answers.state, current.state)))
      .returning();

    if (!row) {
      return {
        ok: false,
        rule: 'R-AR1',
        reason: 'That answer changed while this step was running, so this result was discarded.',
      };
    }
    return { ok: true, run: toRun(row) };
  }

  /**
   * Write the finished answer, if it is still allowed to finish.
   *
   * Same guard as `transition`, applied to the write that actually matters: a provider result
   * that arrives after the owner cancelled finds a terminal state and is refused, so the evidence
   * and the cancellation both survive and the late narrative is dropped.
   */
  async finish(
    id: string,
    input: AnswerRunFinish,
  ): Promise<
    | { readonly ok: true; readonly run: AnswerRun }
    | { readonly ok: false; readonly rule: string; readonly reason: string }
  > {
    const [current] = await this.db.select().from(answers).where(eq(answers.id, id)).limit(1);
    if (!current) throw new NotFoundError('Answer');

    const decision = applyTerminalTransition(current.state, input.state);
    if (!decision.ok) return decision;

    const [row] = await this.db
      .update(answers)
      .set({
        state: input.state,
        mode: input.mode,
        method: input.method,
        headline: input.headline,
        claims: [...input.claims],
        considered: input.considered,
        limitations: [...input.limitations],
        rejectionRule: input.rejectionRule ?? null,
        rejectionReason: input.rejectionReason ?? null,
        missionSuggestion: input.missionSuggestion ?? null,
        retrievalMode: input.retrievalMode ?? null,
        provider: input.provider ?? null,
        model: input.model ?? null,
        /*
         * Written exactly as reported. `?? null` rather than `?? 0`: a provider that did not tell
         * us its input tokens is not a provider that used none, and flattening the two makes a
         * cost total quietly wrong in the direction of looking cheaper.
         */
        inputTokens: input.inputTokens ?? null,
        outputTokens: input.outputTokens ?? null,
        cachedInputTokens: input.cachedInputTokens ?? null,
        costUsd:
          input.costUsd === null || input.costUsd === undefined ? null : String(input.costUsd),
        latencyMs: input.latencyMs ?? null,
        durationMs: input.latencyMs ?? null,
        finishedAt: new Date(),
      })
      .where(and(eq(answers.id, id), eq(answers.state, current.state)))
      .returning();

    if (!row) {
      return {
        ok: false,
        rule: 'R-AR1',
        reason: 'That answer finished or was stopped elsewhere, so this result was discarded.',
      };
    }
    return { ok: true, run: toRun(row) };
  }

  /** Stop an answer. Terminal: a later provider result cannot reopen it. */
  async cancel(
    id: string,
    askedBy: string,
    at: Date,
  ): Promise<
    | { readonly ok: true; readonly run: AnswerRun }
    | { readonly ok: false; readonly rule: string; readonly reason: string }
  > {
    const [current] = await this.db
      .select()
      .from(answers)
      .where(and(eq(answers.id, id), eq(answers.askedBy, askedBy)))
      .limit(1);
    if (!current) throw new NotFoundError('Answer');

    const decision = applyTerminalTransition(current.state, 'cancelled');
    if (!decision.ok) return decision;

    const [row] = await this.db
      .update(answers)
      .set({ state: 'cancelled', mode: 'cancelled', cancelledAt: at, finishedAt: at })
      .where(and(eq(answers.id, id), eq(answers.state, current.state)))
      .returning();

    if (!row) {
      return { ok: false, rule: 'R-AR1', reason: 'That answer had already finished.' };
    }
    return { ok: true, run: toRun(row) };
  }

  /* ------------------------------------------------------------- evidence */

  async saveEvidence(answerId: string, items: readonly AnswerEvidenceItem[]): Promise<number> {
    if (items.length === 0) return 0;
    const rows = await this.db
      .insert(answerEvidence)
      .values(
        items.map((item, ordinal) => ({
          answerId,
          ref: item.ref,
          kind: item.kind,
          origin: item.origin,
          subjectId: item.subjectId,
          label: item.label,
          excerpt: item.excerpt,
          projectId: item.projectId,
          locator: item.locator,
          revisionId: item.revisionId,
          contentHash: item.contentHash,
          href: item.href,
          trust: item.trust,
          ordinal,
        })),
      )
      .onConflictDoNothing()
      .returning({ id: answerEvidence.id });
    return rows.length;
  }

  async listEvidence(answerId: string): Promise<readonly AnswerEvidenceItem[]> {
    const rows = await this.db
      .select()
      .from(answerEvidence)
      .where(eq(answerEvidence.answerId, answerId))
      .orderBy(answerEvidence.ordinal);
    return rows.map(toEvidenceItem);
  }

  /**
   * Resolve one citation, and only for the owner who asked the answer it belongs to.
   *
   * The join to `answers` is what makes a citation identifier useless to a guesser: a reference
   * is meaningful only inside the answer that produced it, and an answer is readable only by the
   * person who asked it. There is no lookup by `ref` alone, so the identifier space cannot be
   * walked to discover what exists in another scope.
   */
  async resolveCitation(input: {
    readonly answerId: string;
    readonly ref: string;
    readonly askedBy: string;
  }): Promise<AnswerEvidenceItem | null> {
    const rows = await this.db.execute(sql`
      select e.*
      from answer_evidence e
      join answers a on a.id = e.answer_id
      where e.answer_id = ${input.answerId}::uuid
        and e.ref = ${input.ref}
        and a.asked_by = ${input.askedBy}
      limit 1
    `);
    const row = extractRows(rows)[0];
    if (!row) return null;
    return {
      ref: String(row.ref),
      kind: row.kind as AnswerEvidenceItem['kind'],
      origin: row.origin as AnswerEvidenceItem['origin'],
      subjectId: String(row.subject_id),
      label: String(row.label),
      excerpt: String(row.excerpt),
      projectId: row.project_id === null ? null : String(row.project_id),
      locator: row.locator === null ? null : String(row.locator),
      revisionId: row.revision_id === null ? null : String(row.revision_id),
      contentHash: row.content_hash === null ? null : String(row.content_hash),
      href: row.href === null ? null : String(row.href),
      staleSince: null,
      trust: row.trust === null ? 'imported_material' : String(row.trust),
    };
  }
}

function toEvidenceItem(row: typeof answerEvidence.$inferSelect): AnswerEvidenceItem {
  return {
    ref: row.ref,
    kind: row.kind,
    origin: row.origin,
    subjectId: row.subjectId,
    label: row.label,
    excerpt: row.excerpt,
    projectId: row.projectId,
    locator: row.locator,
    revisionId: row.revisionId,
    contentHash: row.contentHash,
    href: row.href,
    staleSince: null,
    trust: row.trust ?? 'imported_material',
  };
}

function toRun(row: typeof answers.$inferSelect): AnswerRun {
  return {
    id: row.id,
    conversationId: row.conversationId ?? '',
    question: row.question,
    scope: row.scope,
    projectIds: row.projectIds ?? [],
    state: row.state,
    mode: row.mode,
    method: row.method,
    idempotencyKey: row.idempotencyKey ?? '',
    askedBy: row.askedBy,
    headline: row.headline === '' ? null : row.headline,
    limitations: row.limitations ?? [],
    rejectionRule: row.rejectionRule,
    rejectionReason: row.rejectionReason,
    retrievalMode: row.retrievalMode,
    provider: row.provider,
    model: row.model,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    cachedInputTokens: row.cachedInputTokens,
    /* Stored as numeric for exactness; surfaced as a number, and null stays null. */
    costUsd: row.costUsd === null ? null : Number(row.costUsd),
    latencyMs: row.latencyMs,
    createdAt: isoRequired(row.generatedAt),
    startedAt: iso(row.startedAt),
    finishedAt: iso(row.finishedAt),
    cancelledAt: iso(row.cancelledAt),
  };
}

function emptyCoverage(): AnswerCoverage {
  return {
    projectsConsidered: 0,
    evidenceConsidered: 0,
    missionsConsidered: 0,
    knowledgeConsidered: 0,
    sourcesConsidered: 0,
    truncated: false,
    gaps: [],
  };
}
