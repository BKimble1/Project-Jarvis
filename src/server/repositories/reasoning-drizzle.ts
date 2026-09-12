import { and, eq, inArray, sql } from 'drizzle-orm';
import { ideaEvaluationSchema, type IdeaEvaluation } from '@/domain/proposal';
import { boundText, redactSecrets } from '@/domain/redaction';
import {
  reasoningInputSchema,
  type ReasoningAssignment,
  type ReasoningFailure,
  type ReasoningInput,
  type ReasoningKind,
  type ReasoningRequest,
  type ReasoningStage,
} from '@/domain/reasoning';
import type { Database } from '../db/client';
import { reasoningRequests } from '../db/schema';
import type { ReasoningRepository } from './reasoning-types';

type Row = typeof reasoningRequests.$inferSelect;

/**
 * The reasoning queue, in Postgres.
 *
 * Everything that could be raced is one statement. The claim is a single
 * `UPDATE … WHERE id = (SELECT … FOR UPDATE SKIP LOCKED LIMIT 1)`, the same shape the mission
 * claim uses, so two workers polling in the same millisecond cannot both take a question. Reporting
 * a result is conditional on still holding the lease, so a worker that was reclaimed while its
 * answer was in flight loses to whoever holds it now — and finds out, rather than believing it
 * succeeded.
 */
export class DrizzleReasoningRepository implements ReasoningRepository {
  constructor(private readonly db: Database) {}

  async enqueue(input: {
    kind: ReasoningKind;
    requestKey: string;
    proposalId: string | null;
    conversationId: string | null;
    input: ReasoningInput;
    now: Date;
  }): Promise<ReasoningRequest> {
    /*
     * `onConflictDoUpdate` on the unique key. An insert that loses the race still returns the
     * winning row, which is what makes asking twice cost one answer. The state is deliberately not
     * reset: a request that already succeeded keeps its result, and the caller decides whether to
     * show it or ask again on purpose.
     *
     * ## Why the prompt is rewritten, and only while the row is still queued
     *
     * It was not, and the row kept whatever text arrived first. So a person who described an idea,
     * saw nothing happen, and described it again more fully had the *second* description written
     * onto the proposal — `open` updates `idea` — and the *first* one sent to the worker. The
     * screen then showed an assessment that did not answer what he had just asked, with no way to
     * tell from the outside that two different texts were in play.
     *
     * `setWhere` confines the rewrite to a row nobody has picked up yet. Once a worker has claimed
     * a request it is reading that prompt on another machine, and changing it underneath would
     * produce an answer stored against text that was never sent — the same failure, better hidden.
     * A claimed or finished request keeps its prompt, and the newer description is answered by
     * asking again deliberately rather than by rewriting history.
     */
    const [row] = await this.db
      .insert(reasoningRequests)
      .values({
        kind: input.kind,
        requestKey: input.requestKey,
        proposalId: input.proposalId,
        conversationId: input.conversationId,
        input: input.input,
        state: 'queued',
        createdAt: input.now,
        updatedAt: input.now,
      })
      .onConflictDoUpdate({
        target: reasoningRequests.requestKey,
        set: { updatedAt: input.now, input: input.input, conversationId: input.conversationId },
        setWhere: eq(reasoningRequests.state, 'queued'),
      })
      .returning();

    /*
     * `setWhere` that matches nothing updates nothing and returns nothing, which is not a failure —
     * it is the claimed-or-finished case above. The existing row is the answer.
     */
    if (!row) {
      const existing = await this.findByKey(input.requestKey);
      if (!existing) throw new Error('The reasoning request could not be written.');
      return existing;
    }
    return toRequest(row);
  }

  async find(id: string): Promise<ReasoningRequest | null> {
    if (!UUID.test(id)) return null;
    const rows = await this.db
      .select()
      .from(reasoningRequests)
      .where(eq(reasoningRequests.id, id))
      .limit(1);
    const row = rows[0];
    return row ? toRequest(row) : null;
  }

  async findByKey(requestKey: string): Promise<ReasoningRequest | null> {
    const rows = await this.db
      .select()
      .from(reasoningRequests)
      .where(eq(reasoningRequests.requestKey, requestKey))
      .limit(1);
    const row = rows[0];
    return row ? toRequest(row) : null;
  }

  async claim(input: {
    workerId: string;
    now: Date;
    leaseMs: number;
    maxAttempts: number;
  }): Promise<ReasoningAssignment | null> {
    await this.reclaimExpired({ now: input.now, maxAttempts: input.maxAttempts });

    const leaseExpiresAt = new Date(input.now.getTime() + input.leaseMs);
    const claimed = await this.db.execute(sql`
      update ${reasoningRequests} as r
      set state = 'running',
          lease_owner = ${input.workerId},
          lease_expires_at = ${leaseExpiresAt}::timestamptz,
          attempt = r.attempt + 1,
          started_at = coalesce(r.started_at, ${input.now}::timestamptz),
          updated_at = ${input.now}::timestamptz
      where r.id = (
        select c.id
        from ${reasoningRequests} as c
        where c.state = 'queued'
          and c.attempt < c.max_attempts
        order by c.created_at asc, c.id asc
        limit 1
        for update skip locked
      )
      returning r.id
    `);

    const id = firstId(claimed);
    if (!id) return null;

    const request = await this.find(id);
    if (!request) return null;

    return {
      requestId: request.id,
      kind: request.kind,
      input: request.input,
      attempt: request.attempt,
      leaseExpiresAt: leaseExpiresAt.toISOString(),
    };
  }

  async succeed(input: {
    requestId: string;
    workerId: string;
    attempt: number;
    evaluation: IdeaEvaluation;
    usage: {
      inputTokens: number | null;
      outputTokens: number | null;
      durationMs: number | null;
    } | null;
    now: Date;
  }): Promise<boolean> {
    if (!UUID.test(input.requestId)) return false;
    const updated = await this.db
      .update(reasoningRequests)
      .set({
        state: 'succeeded',
        result: input.evaluation,
        failure: null,
        failureDetail: null,
        inputTokens: input.usage?.inputTokens ?? null,
        outputTokens: input.usage?.outputTokens ?? null,
        durationMs: input.usage?.durationMs ?? null,
        stage: 'parsed',
        leaseOwner: null,
        leaseExpiresAt: null,
        finishedAt: input.now,
        updatedAt: input.now,
      })
      .where(
        and(
          eq(reasoningRequests.id, input.requestId),
          eq(reasoningRequests.state, 'running'),
          eq(reasoningRequests.leaseOwner, input.workerId),
          /* The fence. A report from an older attempt does not apply. */
          eq(reasoningRequests.attempt, input.attempt),
        ),
      )
      .returning({ id: reasoningRequests.id });
    return updated.length > 0;
  }

  async fail(input: {
    requestId: string;
    workerId: string;
    attempt: number;
    failure: ReasoningFailure;
    detail: string | null;
    stage: ReasoningStage | null;
    maxAttempts: number;
    now: Date;
  }): Promise<boolean> {
    if (!UUID.test(input.requestId)) return false;
    /*
     * The attempt was already counted by the claim, so the ceiling is read off the row rather than
     * incremented again here. Below it the row goes back to `queued`; at it the row is `failed`,
     * which is what turns a silent retry loop into a sentence somebody can read.
     */
    const updated = await this.db.execute(sql`
      update ${reasoningRequests} as r
      set state = case when r.attempt >= ${input.maxAttempts} then 'failed' else 'queued' end,
          failure = ${input.failure}::text,
          /*
           * Redacted here rather than by the caller. The worker already bounds and redacts what it
           * sends, and the route caps it at 300 characters — but redaction on this side is what
           * makes the guarantee true of *every* path into the column, which is the convention the
           * event and audit writers already follow.
           */
          failure_detail = ${input.detail === null ? null : boundText(redactSecrets(input.detail), 300)}::text,
          stage = ${input.stage}::text,
          lease_owner = null,
          lease_expires_at = null,
          /*
           * The cast is load-bearing. Inside a CASE whose other branch is a bare NULL, Postgres has
           * nothing to infer a parameter's type from and defaults it to text — which then fails
           * against a timestamptz column. Naming the type is what makes the statement legal.
           */
          finished_at = case
            when r.attempt >= ${input.maxAttempts} then ${input.now}::timestamptz
            else null
          end,
          updated_at = ${input.now}::timestamptz
      where r.id = ${input.requestId}
        and r.state = 'running'
        and r.lease_owner = ${input.workerId}
        and r.attempt = ${input.attempt}
      returning r.id
    `);
    return firstId(updated) !== null;
  }

  async requeue(input: {
    requestId: string;
    maxManualRetries: number;
    now: Date;
  }): Promise<ReasoningRequest | null> {
    if (!UUID.test(input.requestId)) return null;
    /*
     * One statement, conditional on the row still being failed and on the ceiling. Two presses of
     * the button in the same second therefore produce one requeue, and a runtime that is broken
     * rather than slow runs out of retries and stays failed.
     */
    const requeued = await this.db.execute(sql`
      update ${reasoningRequests} as r
      set state = 'queued',
          attempt = 0,
          manual_retries = r.manual_retries + 1,
          failure = null,
          failure_detail = null,
          stage = null,
          lease_owner = null,
          lease_expires_at = null,
          started_at = null,
          finished_at = null,
          updated_at = ${input.now}::timestamptz
      where r.id = ${input.requestId}
        and r.state = 'failed'
        and r.manual_retries < ${input.maxManualRetries}
      returning r.id
    `);
    return firstId(requeued) ? this.find(input.requestId) : null;
  }

  async reclaimExpired(input: { now: Date; maxAttempts: number }): Promise<number> {
    const reclaimed = await this.db.execute(sql`
      update ${reasoningRequests} as r
      set state = case when r.attempt >= ${input.maxAttempts} then 'failed' else 'queued' end,
          failure = case when r.attempt >= ${input.maxAttempts} then 'interrupted' else r.failure end,
          failure_detail = case
            when r.attempt >= ${input.maxAttempts}
            then 'The worker stopped before it answered, and there are no attempts left.'
            else r.failure_detail
          end,
          /*
           * Cleared, because a reclaim is precisely the case where nobody knows how far it got.
           * The stage left behind belongs to an attempt that stopped reporting, and carrying it
           * onto "the worker stopped before it answered" would put a confident "it got as far as
           * the model answered" under a sentence that says the opposite.
           */
          stage = null,
          lease_owner = null,
          lease_expires_at = null,
          finished_at = case
            when r.attempt >= ${input.maxAttempts} then ${input.now}::timestamptz
            else null
          end,
          updated_at = ${input.now}::timestamptz
      where r.state = 'running'
        and r.lease_expires_at is not null
        and r.lease_expires_at < ${input.now}::timestamptz
      returning r.id
    `);
    return rowsOf(reclaimed).length;
  }

  async countActive(): Promise<number> {
    const rows = await this.db
      .select({ id: reasoningRequests.id })
      .from(reasoningRequests)
      .where(inArray(reasoningRequests.state, ['queued', 'running']));
    return rows.length;
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The row as the rest of the system sees it.
 *
 * `input` and `result` are re-validated on the way out rather than trusted. They are JSON columns,
 * which means a hand-edited row or a schema that moved on under an old record would otherwise reach
 * a prompt or a screen unchecked, and a malformed evaluation that renders is worse than one that
 * is reported missing.
 */
function toRequest(row: Row): ReasoningRequest {
  const input = reasoningInputSchema.safeParse(row.input);
  const result = row.result ? ideaEvaluationSchema.safeParse(row.result) : null;
  return {
    id: row.id,
    kind: row.kind,
    state: row.state,
    proposalId: row.proposalId,
    conversationId: row.conversationId,
    input: input.success
      ? input.data
      : { kind: 'idea_evaluation', idea: '(unreadable)', title: '' },
    attempt: row.attempt,
    leaseOwner: row.leaseOwner,
    leaseExpiresAt: row.leaseExpiresAt?.toISOString() ?? null,
    result: result?.success ? result.data : null,
    failure: row.failure,
    failureDetail: row.failureDetail,
    stage: row.stage,
    manualRetries: row.manualRetries,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString() ?? null,
  };
}

function rowsOf(result: unknown): unknown[] {
  if (Array.isArray(result)) return result;
  if (result && typeof result === 'object' && 'rows' in result) {
    const rows = (result as { rows: unknown }).rows;
    return Array.isArray(rows) ? rows : [];
  }
  return [];
}

function firstId(result: unknown): string | null {
  const row = rowsOf(result)[0] as Record<string, unknown> | undefined;
  return typeof row?.id === 'string' ? row.id : null;
}
