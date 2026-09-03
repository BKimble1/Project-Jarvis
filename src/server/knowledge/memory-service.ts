import { ForbiddenError, NotFoundError, ValidationError } from '@/domain/errors';
import type { EmbeddingProvider } from '@/domain/embedding';
import { normaliseVector } from '@/domain/embedding';
import {
  FORGET_CONFIRMATION,
  ORIGIN_PROVENANCE,
  assertScopeConsistency,
  canDecide,
  canSupersede,
  defaultSensitivity,
  detectConflicts,
  isCitableAuthority,
  resolveInitialStatus,
  type KnowledgeConflict,
  type KnowledgeItem,
  type MemoryActorKind,
} from '@/domain/knowledge';
import type {
  ConflictResolutionInput,
  KnowledgeCreateInput,
  KnowledgeProposalInput,
  KnowledgeUpdateInput,
} from '@/domain/knowledge';
import type { Sensitivity } from '@/domain/retrieval';
import type {
  AuditRepository,
  DeletionReceiptRepository,
} from '@/server/repositories/accounting-types';
import type {
  ConflictRepository,
  KnowledgeRepository,
} from '@/server/repositories/knowledge-types';
import type { DrizzleRevisionRepository } from '@/server/repositories/revision-drizzle';

/**
 * What Jarvis remembers, and how a thing becomes something it remembers.
 *
 * Three properties this service exists to hold, none of which the repository can hold on its own:
 *
 * **A proposal cannot approve itself.** A mission may finish and say "you always deploy on a
 * Friday". It may write that down as a *suggestion*. Turning it into memory is a separate act by
 * a different actor, and `canDecide` refuses the same actor doing both. Without that separation
 * an agent that hallucinates confidently enough eventually teaches Jarvis the hallucination.
 *
 * **Forgetting destroys, and destruction is not best-effort.** `forget` removes the statement,
 * the detail, the excerpts, the tags and the source reference, deletes every embedding of the
 * item so the vector index cannot answer from it, and writes a receipt saying a deletion happened
 * — a receipt that deliberately does not contain what was deleted. A receipt holding the
 * forgotten sentence is not an audit trail, it is a copy.
 *
 * **Conflicts are raised, never settled.** Two statements that disagree both stay. The service
 * records a question; I answer it. An automatic winner means the newest thing silently overwrites
 * what I said, which is the failure this whole subsystem is built to avoid.
 *
 * Audit lives here rather than in the route because these are domain actions, not HTTP actions:
 * a memory forgotten by a scheduled retention pass has to leave the same trail as one forgotten
 * by a click, and putting the append next to the destruction is what makes that true regardless
 * of caller.
 */

export interface MemoryActor {
  readonly actor: string;
  readonly actorKind: MemoryActorKind;
}

export interface MemoryServiceOptions {
  readonly memories: KnowledgeRepository;
  readonly conflicts: ConflictRepository;
  readonly revisions: DrizzleRevisionRepository;
  readonly audit: AuditRepository;
  readonly deletionReceipts: DeletionReceiptRepository;
  readonly embeddings: EmbeddingProvider | null;
  readonly clock?: () => Date;
}

export interface MemoryOutcome {
  readonly item: KnowledgeItem;
  readonly rule: string;
  readonly reason: string;
  readonly needsConfirmation: boolean;
  /** Conflicts raised by this write. Reported, not resolved. */
  readonly conflicts: readonly KnowledgeConflict[];
}

/**
 * Why a memory is in play, assembled for a person rather than for a machine.
 *
 * Every field here answers a question someone actually asks when a system tells them something
 * surprising: where did this come from, who decided it counts, what does it disagree with, and is
 * it being used. `provenance` and `authoritative` are the two that matter most — an item may be
 * retrievable and still not be something to build an answer on.
 */
export interface MemoryExplanation {
  readonly item: KnowledgeItem;
  readonly originLabel: string;
  readonly provenance: string;
  readonly authoritative: boolean;
  readonly authorityReason: string;
  readonly statusRule: string | null;
  readonly decidedBy: string | null;
  readonly decidedAt: string | null;
  readonly supersedes: KnowledgeItem | null;
  readonly supersededBy: KnowledgeItem | null;
  readonly openConflicts: readonly KnowledgeConflict[];
  readonly citation: {
    readonly sourceId: string | null;
    readonly sourceRef: string | null;
    readonly href: string | null;
  };
  readonly useCount: number;
  readonly lastUsedAt: string | null;
  readonly embedded: boolean;
}

export class MemoryService {
  private readonly clock: () => Date;

  constructor(private readonly options: MemoryServiceOptions) {
    this.clock = options.clock ?? (() => new Date());
  }

  /* ------------------------------------------------------------- writing */

  /**
   * Record something the owner stated.
   *
   * Active on arrival, by R-KN1. The origin is not a parameter — this method is the only way to
   * produce an `explicit` item, so no caller can dress a model's output as mine by passing a
   * field.
   */
  async remember(
    input: KnowledgeCreateInput & { readonly sensitivity?: Sensitivity },
    actor: MemoryActor,
  ): Promise<MemoryOutcome> {
    this.assertOwner(actor, 'record a memory');
    assertScopeConsistency({
      scope: input.scope,
      projectId: input.projectId ?? null,
      missionId: input.missionId ?? null,
    });

    const decision = resolveInitialStatus({ origin: 'explicit', category: input.category });
    const now = this.clock();

    if (input.supersedesId) await this.assertMaySupersede(input, input.supersedesId);

    const item = await this.options.memories.create({
      scope: input.scope,
      category: input.category,
      origin: 'explicit',
      status: decision.status,
      statusRule: decision.rule,
      statement: input.statement,
      detail: input.detail ?? null,
      projectId: input.projectId ?? null,
      missionId: input.missionId ?? null,
      sourceId: null,
      sourceRef: null,
      excerpts: [],
      tags: input.tags,
      createdBy: actor.actor,
      confidence: null,
      reviewAt: input.reviewAt ? new Date(input.reviewAt) : null,
      expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
      supersedesId: input.supersedesId ?? null,
      confirmedAt: now,
      confirmedBy: actor.actor,
      sensitivity: input.sensitivity ?? defaultSensitivity(input.category),
    });

    if (input.supersedesId) {
      await this.applySupersession(input.supersedesId, item, 'Replaced by a newer note.', actor);
    }

    await this.record(actor, 'knowledge.create', item, 'allowed', decision.rule, 'You recorded a note.');
    await this.embedItem(item);
    const conflicts = await this.raiseConflicts(item);

    return {
      item,
      rule: decision.rule,
      reason: decision.reason,
      needsConfirmation: decision.needsConfirmation,
      conflicts,
    };
  }

  /**
   * Record something a model, an import or Jarvis itself proposed.
   *
   * `resolveInitialStatus` decides the status; the caller may not. The single narrow path to
   * `active` for a non-owner origin is R-KN4 — a definition taken from a document the owner
   * supplied — and even that requires `sourceOwnerSupplied` to be true, which a proposer cannot
   * assert about itself because it is derived from the source row rather than from the request.
   */
  async propose(
    input: KnowledgeProposalInput & {
      readonly sourceOwnerSupplied?: boolean;
      readonly sensitivity?: Sensitivity;
    },
    actor: MemoryActor,
  ): Promise<MemoryOutcome> {
    assertScopeConsistency({
      scope: input.scope,
      projectId: input.projectId ?? null,
      missionId: input.missionId ?? null,
    });

    const decision = resolveInitialStatus({
      origin: input.origin,
      category: input.category,
      ...(input.sourceOwnerSupplied === undefined
        ? {}
        : { sourceOwnerSupplied: input.sourceOwnerSupplied }),
    });

    const item = await this.options.memories.create({
      scope: input.scope,
      category: input.category,
      origin: input.origin,
      status: decision.status,
      statusRule: decision.rule,
      statement: input.statement,
      detail: input.detail ?? null,
      projectId: input.projectId ?? null,
      missionId: input.missionId ?? null,
      sourceId: input.sourceId ?? null,
      sourceRef: input.sourceRef ?? null,
      excerpts: input.excerpts.map((excerpt) => ({
        text: excerpt.text,
        locator: excerpt.locator ?? null,
      })),
      tags: input.tags,
      createdBy: actor.actor,
      confidence: input.confidence ?? null,
      reviewAt: null,
      expiresAt: null,
      supersedesId: null,
      /* A proposal is never pre-confirmed, including the R-KN4 auto-accept: nobody confirmed it. */
      confirmedAt: null,
      confirmedBy: null,
      sensitivity: input.sensitivity ?? defaultSensitivity(input.category),
    });

    await this.record(
      actor,
      'knowledge.create',
      item,
      'allowed',
      decision.rule,
      decision.status === 'active'
        ? 'A definition was taken from a document you supplied.'
        : 'A suggestion was proposed and is waiting for you.',
    );

    if (decision.status === 'active') await this.embedItem(item);
    const conflicts = await this.raiseConflicts(item);

    return {
      item,
      rule: decision.rule,
      reason: decision.reason,
      needsConfirmation: decision.needsConfirmation,
      conflicts,
    };
  }

  /** Edit wording or classification. Never changes origin, status or who proposed it. */
  async edit(
    id: string,
    patch: KnowledgeUpdateInput & { readonly sensitivity?: Sensitivity },
    actor: MemoryActor,
  ): Promise<KnowledgeItem> {
    this.assertOwner(actor, 'edit a memory');
    const existing = await this.require(id);
    if (existing.status === 'forgotten') {
      throw new ValidationError('That was forgotten. There is nothing left to edit.');
    }

    const scope = patch.scope ?? existing.scope;
    assertScopeConsistency({
      scope,
      projectId: existing.projectId,
      missionId: existing.missionId,
    });

    const updated = await this.options.memories.patch(id, {
      ...(patch.statement !== undefined ? { statement: patch.statement } : {}),
      ...(patch.detail !== undefined ? { detail: patch.detail ?? null } : {}),
      ...(patch.category !== undefined ? { category: patch.category } : {}),
      ...(patch.scope !== undefined ? { scope: patch.scope } : {}),
      ...(patch.tags !== undefined ? { tags: patch.tags } : {}),
      ...(patch.reviewAt !== undefined
        ? { reviewAt: patch.reviewAt ? new Date(patch.reviewAt) : null }
        : {}),
      ...(patch.expiresAt !== undefined
        ? { expiresAt: patch.expiresAt ? new Date(patch.expiresAt) : null }
        : {}),
      ...(patch.sensitivity !== undefined ? { sensitivity: patch.sensitivity } : {}),
    });

    /*
     * The stored vector describes the old wording. Deleting it rather than leaving it is the
     * conservative choice: a stale vector answers a semantic query with text that no longer
     * exists, which is worse than the item briefly falling back to lexical retrieval.
     */
    if (patch.statement !== undefined || patch.detail !== undefined) {
      await this.options.revisions.deleteMemoryEmbeddings(id);
      if (updated.status === 'active') await this.embedItem(updated);
    }

    await this.record(actor, 'knowledge.edit', updated, 'allowed', 'R-KM1', 'You edited a note.');
    return updated;
  }

  /* ------------------------------------------------------------- deciding */

  /**
   * Approve, reject, archive or restore a memory.
   *
   * `canDecide` is consulted before anything is written, and its refusal is a `ForbiddenError`
   * carrying the rule — so a caller that is not allowed to approve gets told which rule stopped
   * it rather than a generic denial it cannot act on.
   */
  async decide(
    id: string,
    input: {
      readonly decision: 'approve' | 'reject' | 'archive' | 'restore';
      readonly reason?: string | null;
    },
    actor: MemoryActor,
  ): Promise<KnowledgeItem> {
    const item = await this.require(id);
    const check = canDecide({
      actor: actor.actor,
      actorKind: actor.actorKind,
      item,
      decision: input.decision,
    });

    if (!check.allowed) {
      await this.record(
        actor,
        DECISION_ACTION[input.decision],
        item,
        'refused',
        check.rule,
        check.reason ?? 'Refused.',
      );
      throw new ForbiddenError(check.reason ?? 'That decision is not yours to make.');
    }

    const now = this.clock();
    const updated = await this.options.memories.patch(id, {
      status:
        input.decision === 'approve'
          ? 'active'
          : input.decision === 'reject'
            ? 'rejected'
            : input.decision === 'archive'
              ? 'archived'
              : 'active',
      ...(input.decision === 'approve' || input.decision === 'restore'
        ? { confirmedAt: now, confirmedBy: actor.actor }
        : {}),
      ...(input.decision === 'reject' ? { rejectedReason: input.reason ?? null } : {}),
    });

    /* Only active memories may be retrieved, so only active memories keep a vector. */
    if (updated.status === 'active') await this.embedItem(updated);
    else await this.options.revisions.deleteMemoryEmbeddings(id);

    await this.record(
      actor,
      DECISION_ACTION[input.decision],
      updated,
      'allowed',
      'R-KA1',
      DECISION_SUMMARY[input.decision],
    );

    if (updated.status === 'active') await this.raiseConflicts(updated);
    return updated;
  }

  /** Replace one memory with another, keeping both and the link between them. */
  async supersede(
    previousId: string,
    next: KnowledgeCreateInput & { readonly sensitivity?: Sensitivity },
    actor: MemoryActor,
    reason?: string,
  ): Promise<MemoryOutcome> {
    return this.remember({ ...next, supersedesId: previousId }, actor).then(async (outcome) => {
      if (reason) {
        await this.options.memories.patch(previousId, { supersededReason: reason });
      }
      return outcome;
    });
  }

  /* ----------------------------------------------------------- forgetting */

  /**
   * Destroy a memory's content, permanently.
   *
   * Order matters and is deliberate. The item is read *before* destruction so the receipt can
   * record how many excerpts existed and which indexes had to be cleared; the vectors go next,
   * because a vector that survives the row is a semantic index that still answers from deleted
   * text; the row is scrubbed last. The receipt and the audit event are written from facts about
   * the deletion — counts, scope, category, id — and never from the statement itself.
   *
   * `confirmation` must match exactly. Forgetting is the one action here with no undo, so it does
   * not happen on a mis-click or on a request body that merely reached the right route.
   */
  async forget(
    id: string,
    input: { readonly confirmation: string; readonly reason?: string | null },
    actor: MemoryActor,
  ): Promise<{ readonly item: KnowledgeItem; readonly embeddingsRemoved: number }> {
    const item = await this.require(id);
    const check = canDecide({
      actor: actor.actor,
      actorKind: actor.actorKind,
      item,
      decision: 'forget',
    });
    if (!check.allowed) {
      await this.record(actor, 'knowledge.forget', item, 'refused', check.rule, check.reason ?? '');
      throw new ForbiddenError(check.reason ?? 'That is not yours to forget.');
    }

    if (input.confirmation !== FORGET_CONFIRMATION) {
      await this.record(
        actor,
        'knowledge.forget',
        item,
        'refused',
        'R-KF1',
        'Forgetting was not confirmed.',
      );
      throw new ValidationError(
        `Type “${FORGET_CONFIRMATION}” to confirm. This removes the note permanently.`,
      );
    }

    const excerptCount = item.excerpts.length;
    const embeddingsRemoved = await this.options.revisions.deleteMemoryEmbeddings(id);
    const forgotten = await this.options.memories.forget(id, this.clock());

    /*
     * A receipt describing the deletion, not the deleted thing. `scrubbedTargets` names the places
     * content was removed from so a later audit can check each one, which is a different kind of
     * useful from keeping a copy of the sentence.
     */
    await this.options.deletionReceipts.record({
      subjectKind: 'knowledge_item',
      subjectId: id,
      reason: boundReason(input.reason) ?? 'Forgotten at your request.',
      itemCount: 1,
      requestedBy: actor.actor,
      scrubbedTargets: [
        'knowledge_items.statement',
        'knowledge_items.detail',
        'knowledge_items.excerpts',
        'knowledge_items.tags',
        'knowledge_items.source_ref',
        'knowledge_items.search_vector',
        'knowledge_embeddings',
      ],
    });

    await this.options.audit.append({
      actor: actor.actor,
      actorKind: actor.actorKind,
      action: 'knowledge.forget',
      subjectKind: 'knowledge_item',
      subjectId: id,
      projectId: item.projectId,
      missionId: item.missionId,
      outcome: 'allowed',
      rule: 'R-KF2',
      /* Deliberately describes the act. The statement is not in the summary or the detail. */
      summary: `A ${item.category} note was forgotten permanently.`,
      detail: {
        category: item.category,
        scope: item.scope,
        origin: item.origin,
        excerptsRemoved: excerptCount,
        embeddingsRemoved,
      },
    });

    return { item: forgotten, embeddingsRemoved };
  }

  /* ------------------------------------------------------------ conflicts */

  /**
   * Look for statements that disagree with this one and record the question.
   *
   * Only ever records; a conflict row changes neither side. Duplicate detection is by pair, so
   * re-saving an item does not stack twenty copies of the same question in the review queue.
   */
  async raiseConflicts(item: KnowledgeItem): Promise<readonly KnowledgeConflict[]> {
    if (item.status !== 'active') return [];
    const siblings = await this.options.memories.siblings(item);
    if (siblings.length === 0) return [];

    const found = detectConflicts([item, ...siblings]).filter(
      (conflict) => conflict.leftId === item.id || conflict.rightId === item.id,
    );
    if (found.length === 0) return [];

    const open = await this.options.conflicts.list('open');
    const seen = new Set(open.map((conflict) => pairKey(conflict.leftId, conflict.rightId)));

    const recorded: KnowledgeConflict[] = [];
    for (const conflict of found) {
      const key = pairKey(conflict.leftId, conflict.rightId);
      if (seen.has(key)) continue;
      seen.add(key);
      recorded.push(await this.options.conflicts.record(conflict));
    }
    return recorded;
  }

  /**
   * Answer a conflict.
   *
   * `keep_both` is a real answer, not a way of declining to answer — two things can be true in
   * different circumstances, and forcing a winner would lose that. Nothing is deleted by any
   * resolution; the losing side is archived at most, and only when asked for explicitly.
   */
  async resolveConflict(
    id: string,
    input: ConflictResolutionInput,
    actor: MemoryActor,
  ): Promise<KnowledgeConflict> {
    this.assertOwner(actor, 'resolve a conflict');
    const conflict = await this.options.conflicts.findById(id);
    if (!conflict) throw new NotFoundError('Conflict');
    if (conflict.state !== 'open') {
      throw new ValidationError('That question has already been answered.');
    }

    const now = this.clock();
    if (input.resolution === 'keep_left' && conflict.rightId) {
      await this.archiveLoser(conflict.rightId, conflict.leftId);
    }
    if (input.resolution === 'keep_right' && conflict.rightId) {
      await this.archiveLoser(conflict.leftId, conflict.rightId);
    }

    const resolved = await this.options.conflicts.resolve(
      id,
      `${input.resolution}${input.note ? `: ${boundReason(input.note)}` : ''}`,
      now,
    );

    await this.options.audit.append({
      actor: actor.actor,
      actorKind: actor.actorKind,
      action: 'knowledge.conflict_resolved',
      subjectKind: 'knowledge_conflict',
      subjectId: id,
      projectId: conflict.projectId,
      outcome: 'allowed',
      rule: conflict.detectedRule,
      summary: `You answered a ${conflict.kind.replace(/_/g, ' ')} question.`,
      detail: { resolution: input.resolution },
    });

    return resolved;
  }

  /* ---------------------------------------------------------- explaining */

  /** Why Jarvis remembers this, assembled from the record rather than narrated by a model. */
  async explain(id: string): Promise<MemoryExplanation> {
    const item = await this.require(id);
    const [supersedes, supersededBy, openConflicts] = await Promise.all([
      item.supersedesId ? this.options.memories.findById(item.supersedesId) : Promise.resolve(null),
      item.supersededById
        ? this.options.memories.findById(item.supersededById)
        : Promise.resolve(null),
      this.options.conflicts.list('open'),
    ]);

    const nowIso = this.clock().toISOString();
    const authoritative = isCitableAuthority(item, nowIso);

    return {
      item,
      originLabel: item.origin,
      provenance: ORIGIN_PROVENANCE[item.origin],
      authoritative,
      authorityReason: authorityReason(item, authoritative, nowIso),
      statusRule: item.statusRule ?? null,
      decidedBy: item.confirmedBy,
      decidedAt: item.confirmedAt,
      supersedes,
      supersededBy,
      openConflicts: openConflicts.filter(
        (conflict) => conflict.leftId === id || conflict.rightId === id,
      ),
      citation: {
        sourceId: item.sourceId,
        sourceRef: item.sourceRef,
        href: item.sourceId ? `/knowledge/sources/${item.sourceId}` : null,
      },
      useCount: item.useCount,
      lastUsedAt: item.lastUsedAt,
      embedded: await this.options.revisions.memoryHasEmbedding(id),
    };
  }

  /* ------------------------------------------------------------ indexing */

  /**
   * Embed one memory, if a provider is configured.
   *
   * Best effort by design. A memory that cannot be embedded is still findable by text, so an
   * embedding failure records itself and returns rather than failing the write that caused it —
   * refusing to save a note because a vector service is down would be the wrong trade.
   */
  async embedItem(item: KnowledgeItem): Promise<boolean> {
    const provider = this.options.embeddings;
    if (!provider?.isConfigured()) return false;
    if (item.status !== 'active') return false;

    const text = `${item.statement}${item.detail ? `\n${item.detail}` : ''}`;
    try {
      const result = await provider.embed([text]);
      const vector = result.vectors[0];
      if (!vector) return false;
      await this.options.revisions.saveMemoryEmbedding({
        itemId: item.id,
        provider: provider.name,
        model: provider.model,
        indexingVersion: provider.indexingVersion,
        /* Re-validated here as well as in the provider: a wrong-width vector must not be stored. */
        vector: normaliseVector([...vector.values], provider.dimensions),
      });
      return true;
    } catch (error) {
      await this.options.revisions.recordEmbeddingFailure({
        chunkId: null,
        itemId: item.id,
        provider: provider.name,
        model: provider.model,
        indexingVersion: provider.indexingVersion,
        dimensions: provider.dimensions,
        /* The provider's message, never the memory's text. */
        message: error instanceof Error ? error.message : 'Embedding failed.',
      });
      return false;
    }
  }

  /** Embed active memories that have no current vector. Idempotent; safe to run repeatedly. */
  async embedPending(limit = 100): Promise<{ readonly embedded: number; readonly failed: number }> {
    const provider = this.options.embeddings;
    if (!provider?.isConfigured()) return { embedded: 0, failed: 0 };

    const pending = await this.options.revisions.memoriesNeedingEmbedding({
      model: provider.model,
      indexingVersion: provider.indexingVersion,
      limit,
    });

    let embedded = 0;
    let failed = 0;
    for (const row of pending) {
      const item = await this.options.memories.findById(row.id);
      if (!item) continue;
      if (await this.embedItem(item)) embedded += 1;
      else failed += 1;
    }
    return { embedded, failed };
  }

  /* ------------------------------------------------------------- helpers */

  private assertOwner(actor: MemoryActor, what: string): void {
    if (actor.actorKind !== 'owner') {
      throw new ForbiddenError(`Only you can ${what}.`);
    }
  }

  private async require(id: string): Promise<KnowledgeItem> {
    const item = await this.options.memories.findById(id);
    if (!item) throw new NotFoundError('Knowledge item');
    return item;
  }

  private async assertMaySupersede(
    next: { readonly scope: KnowledgeCreateInput['scope']; readonly projectId?: string | null },
    previousId: string,
  ): Promise<void> {
    const previous = await this.options.memories.findById(previousId);
    if (!previous) throw new NotFoundError('Knowledge item');
    const check = canSupersede(
      { id: '', scope: next.scope, projectId: next.projectId ?? null },
      previous,
    );
    if (!check.allowed) throw new ValidationError(check.reason ?? 'That cannot be replaced.');
  }

  private async applySupersession(
    previousId: string,
    next: KnowledgeItem,
    reason: string,
    actor: MemoryActor,
  ): Promise<void> {
    await this.options.memories.patch(previousId, {
      status: 'superseded',
      supersededById: next.id,
      supersededReason: reason,
    });
    /* A superseded memory is not retrievable, so its vector goes with its status. */
    await this.options.revisions.deleteMemoryEmbeddings(previousId);
    await this.options.audit.append({
      actor: actor.actor,
      actorKind: actor.actorKind,
      action: 'knowledge.supersede',
      subjectKind: 'knowledge_item',
      subjectId: previousId,
      projectId: next.projectId,
      outcome: 'allowed',
      rule: 'R-KS0',
      summary: 'A note was replaced by a newer one. Both were kept.',
      detail: { replacedBy: next.id },
    });
  }

  /**
   * Retire the side the owner did not choose.
   *
   * `superseded`, not `forgotten`: the words stay readable and the link to the winner is
   * recorded. Choosing between two statements is not the same act as deleting one, and a
   * conflict resolution that quietly destroyed the loser would make answering a conflict
   * something to be nervous about.
   */
  private async archiveLoser(loserId: string, winnerId: string): Promise<void> {
    const loser = await this.options.memories.findById(loserId);
    if (!loser || loser.status !== 'active') return;
    await this.options.memories.patch(loserId, {
      status: 'superseded',
      supersededById: winnerId,
      supersededReason: 'You chose the other statement when they disagreed.',
    });
    /* Not retrievable any more, so its vector goes with its status. */
    await this.options.revisions.deleteMemoryEmbeddings(loserId);
  }

  /** One audit append, shaped so no call site has to remember which fields matter. */
  private async record(
    actor: MemoryActor,
    action: string,
    item: KnowledgeItem,
    outcome: 'allowed' | 'refused' | 'failed',
    rule: string | null,
    summary: string,
  ): Promise<void> {
    await this.options.audit.append({
      actor: actor.actor,
      actorKind: actor.actorKind,
      action,
      subjectKind: 'knowledge_item',
      subjectId: item.id,
      projectId: item.projectId,
      missionId: item.missionId,
      outcome,
      rule,
      summary,
      /*
       * Classification only. The statement is never copied into an audit payload — a trail
       * holding every memory's text would defeat forgetting, because forgetting cannot rewrite a
       * hash-chained log without breaking the chain.
       */
      detail: {
        category: item.category,
        scope: item.scope,
        origin: item.origin,
        status: item.status,
      },
    });
  }
}

/** Each decision's audit action and its plain-English summary, named once rather than inlined. */
const DECISION_ACTION: Record<'approve' | 'reject' | 'archive' | 'restore', string> = {
  approve: 'knowledge.confirm',
  reject: 'knowledge.reject',
  archive: 'knowledge.archive',
  restore: 'knowledge.confirm',
};

const DECISION_SUMMARY: Record<'approve' | 'reject' | 'archive' | 'restore', string> = {
  approve: 'You approved a suggestion, so Jarvis may now use it.',
  reject: 'You rejected a suggestion. It will not be proposed again.',
  archive: 'You archived a note. It is kept but no longer retrieved.',
  restore: 'You restored a note to use.',
};

function pairKey(left: string, right: string | null): string {
  return [left, right ?? ''].sort().join('|');
}

function boundReason(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  return trimmed.length <= 600 ? trimmed : `${trimmed.slice(0, 597)}…`;
}

function authorityReason(
  item: KnowledgeItem,
  authoritative: boolean,
  nowIso: string,
): string {
  if (authoritative) {
    return item.origin === 'explicit'
      ? 'You stated this, so Jarvis may rely on it.'
      : 'Recorded from evidence rather than from a guess.';
  }
  if (item.status !== 'active') return 'Not in use, so it is not relied on.';
  if (item.expiresAt && Date.parse(item.expiresAt) <= Date.parse(nowIso)) {
    return 'Past its expiry date. Still visible, no longer treated as current.';
  }
  return 'A guess rather than a statement. It may be mentioned, not relied on.';
}
