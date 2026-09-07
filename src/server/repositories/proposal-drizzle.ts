import { and, desc, eq } from 'drizzle-orm';
import { ideaEvaluationSchema, type IdeaEvaluation, type Proposal } from '@/domain/proposal';
import type { Database } from '../db/client';
import { conversationProposals } from '../db/schema';
import type { ProposalRepository } from './proposal-types';

type Row = typeof conversationProposals.$inferSelect;

/**
 * Proposal ids arrive from the browser, so they are not necessarily ids.
 *
 * Postgres rejects a malformed uuid with an error rather than an empty result, which turns a
 * tampered or stale value in a request body into a failed request instead of "no such proposal".
 * Checking the shape first keeps a bad id an ordinary miss.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function toProposal(row: Row): Proposal {
  /*
   * The stored evaluation is parsed rather than cast. It was written by whatever produced it —
   * including, on the model path, a model — and a row that no longer matches the schema should
   * degrade to "no evaluation" rather than reach the interface as a malformed object.
   */
  const parsed = ideaEvaluationSchema.safeParse(row.evaluation);
  const evaluation: IdeaEvaluation | null = parsed.success ? parsed.data : null;
  return {
    id: row.id,
    fingerprint: row.fingerprint,
    title: row.title,
    idea: row.idea,
    summary: row.summary,
    evaluation,
    openQuestions: row.openQuestions ?? [],
    recommendedV1: row.recommendedV1 ?? [],
    assumptions: row.assumptions ?? [],
    state: row.state,
    projectId: row.projectId,
    missionId: row.missionId,
    repositoryFullName: row.repositoryFullName,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    acceptedAt: row.acceptedAt?.toISOString() ?? null,
  };
}

export class DrizzleProposalRepository implements ProposalRepository {
  constructor(private readonly db: Database) {}

  async open(input: {
    fingerprint: string;
    title: string;
    idea: string;
    summary: string;
    evaluation: IdeaEvaluation | null;
    openQuestions: readonly string[];
    recommendedV1: readonly string[];
    assumptions: readonly string[];
    now: Date;
  }): Promise<Proposal> {
    const existing = await this.db
      .select()
      .from(conversationProposals)
      .where(eq(conversationProposals.fingerprint, input.fingerprint))
      .limit(1);

    const found = existing[0];
    /*
     * An idea that has already been built is not re-opened by describing it again. Returning it
     * as-is lets the caller say "you already have this" rather than silently making a second one.
     */
    if (found && found.state !== 'open') return toProposal(found);

    const values = {
      fingerprint: input.fingerprint,
      title: input.title,
      idea: input.idea,
      summary: input.summary,
      /*
       * Null means "nothing new to say about it", not "forget what you knew". The assessment now
       * arrives from the worker, minutes after the proposal is written, so re-describing an idea
       * while its answer is in flight must not erase the answer that is about to land.
       */
      evaluation: input.evaluation ?? found?.evaluation ?? null,
      openQuestions: [...input.openQuestions],
      recommendedV1: [...input.recommendedV1],
      assumptions: [...input.assumptions],
      state: 'open' as const,
      updatedAt: input.now,
    };

    /*
     * Upsert on the unique fingerprint rather than insert-if-absent, because two requests can pass
     * the read above at the same moment — a double-submitted form is exactly that race.
     */
    const [row] = await this.db
      .insert(conversationProposals)
      .values({ ...values, createdAt: input.now })
      .onConflictDoUpdate({ target: conversationProposals.fingerprint, set: values })
      .returning();

    if (!row) throw new Error('Proposal could not be recorded.');
    return toProposal(row);
  }

  async recordEvaluation(
    id: string,
    evaluation: IdeaEvaluation,
    now: Date,
  ): Promise<Proposal | null> {
    if (!UUID.test(id)) return null;
    /*
     * Conditional on still being open. An evaluation that arrives after the owner said "go ahead"
     * is late to a decision already taken, and rewriting the proposal then would change the record
     * of what was agreed to after the fact.
     */
    const [row] = await this.db
      .update(conversationProposals)
      .set({
        evaluation,
        openQuestions: [...evaluation.questions],
        recommendedV1: [...evaluation.smallestV1],
        assumptions: [...evaluation.assumptions],
        updatedAt: now,
      })
      .where(and(eq(conversationProposals.id, id), eq(conversationProposals.state, 'open')))
      .returning();
    return row ? toProposal(row) : null;
  }

  async findById(id: string): Promise<Proposal | null> {
    if (!UUID.test(id)) return null;
    const rows = await this.db
      .select()
      .from(conversationProposals)
      .where(eq(conversationProposals.id, id))
      .limit(1);
    const row = rows[0];
    return row ? toProposal(row) : null;
  }

  async latestOpen(): Promise<Proposal | null> {
    const rows = await this.db
      .select()
      .from(conversationProposals)
      .where(eq(conversationProposals.state, 'open'))
      .orderBy(desc(conversationProposals.updatedAt))
      .limit(1);
    const row = rows[0];
    return row ? toProposal(row) : null;
  }

  async accept(
    id: string,
    outcome: {
      projectId: string;
      missionId: string | null;
      repositoryFullName: string | null;
      now: Date;
    },
  ): Promise<Proposal> {
    /*
     * Conditional on `state = 'open'`. The second "go ahead" updates nothing, falls through to the
     * read below, and gets back the project and mission the first one created — which is the whole
     * of the no-duplicates guarantee at this layer.
     */
    await this.db
      .update(conversationProposals)
      .set({
        state: 'accepted',
        projectId: outcome.projectId,
        missionId: outcome.missionId,
        repositoryFullName: outcome.repositoryFullName,
        acceptedAt: outcome.now,
        updatedAt: outcome.now,
      })
      .where(and(eq(conversationProposals.id, id), eq(conversationProposals.state, 'open')));

    const current = await this.findById(id);
    if (!current) throw new Error('Proposal disappeared while being accepted.');
    return current;
  }
}
