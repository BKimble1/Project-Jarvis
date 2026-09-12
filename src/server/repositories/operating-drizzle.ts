import { and, asc, desc, eq, inArray, isNull } from 'drizzle-orm';
import {
  canMoveOperatingState,
  type OperatingEvent,
  type OperatingEventKind,
  type OperatingSnapshot,
  type OperatingState,
} from '@/domain/operating-state';
import type { Database } from '../db/client';
import { operatingEvents, operatingStates } from '../db/schema';

type StateRow = typeof operatingStates.$inferSelect;
type EventRow = typeof operatingEvents.$inferSelect;

/**
 * Ids arrive from the browser, so they are not necessarily ids.
 *
 * Postgres rejects a malformed uuid with an error rather than an empty result, which turns a stale
 * value in a request body into a failed request instead of "no such idea".
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function toSnapshot(row: StateRow): OperatingSnapshot {
  return {
    id: row.id,
    proposalId: row.proposalId,
    state: row.state,
    projectId: row.projectId,
    missionId: row.missionId,
    detail: row.detail,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toEvent(row: EventRow): OperatingEvent {
  return {
    id: row.id,
    proposalId: row.proposalId,
    projectId: row.projectId,
    missionId: row.missionId,
    kind: row.kind,
    fromState: row.fromState,
    toState: row.toState,
    message: row.message,
    spokenAt: row.spokenAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

export interface OperatingTransition {
  readonly to: OperatingState;
  readonly kind: OperatingEventKind;
  /** The exact words, shown and spoken unchanged. */
  readonly message: string;
  readonly projectId?: string | null;
  readonly missionId?: string | null;
  readonly detail?: string | null;
  readonly now: Date;
}

/**
 * Where every idea has got to, and everything that has been said about it.
 *
 * Every method is safe under repetition, because everything above it can be retried: a resubmitted
 * form, a worker that restarted mid-report, an owner who said "go ahead" twice.
 */
export class DrizzleOperatingRepository {
  constructor(private readonly db: Database) {}

  /**
   * The state for an idea, created at `captured` if this is the first anyone has heard of it.
   *
   * Upsert on the unique proposal id rather than read-then-insert, because two requests can pass
   * the read at the same moment — a double-submitted message is exactly that race, and it must not
   * produce two operating states for one idea.
   */
  async ensure(proposalId: string, now: Date): Promise<OperatingSnapshot> {
    const [row] = await this.db
      .insert(operatingStates)
      .values({ proposalId, state: 'captured', createdAt: now, updatedAt: now })
      .onConflictDoUpdate({
        target: operatingStates.proposalId,
        /* Touch nothing. The row already exists and its state is the truth. */
        set: { proposalId },
      })
      .returning();
    if (!row) throw new Error('The operating state could not be recorded.');
    return toSnapshot(row);
  }

  async find(proposalId: string): Promise<OperatingSnapshot | null> {
    if (!UUID.test(proposalId)) return null;
    const rows = await this.db
      .select()
      .from(operatingStates)
      .where(eq(operatingStates.proposalId, proposalId))
      .limit(1);
    const row = rows[0];
    return row ? toSnapshot(row) : null;
  }

  /**
   * Move an idea, and record the move as an event with an id of its own.
   *
   * Returns null when the move is not one the table allows — which the caller must treat as "the
   * world moved on", not as an error to retry. Re-entering the current state is allowed and writes
   * an event, because a repeated report of the same phase is how progress inside a phase is said.
   */
  async transition(
    proposalId: string,
    input: OperatingTransition,
  ): Promise<{ snapshot: OperatingSnapshot; event: OperatingEvent } | null> {
    const current = await this.ensure(proposalId, input.now);
    if (!canMoveOperatingState(current.state, input.to)) return null;

    const projectId = input.projectId ?? current.projectId;
    const missionId = input.missionId ?? current.missionId;

    const [updated] = await this.db
      .update(operatingStates)
      .set({
        state: input.to,
        projectId,
        missionId,
        detail: input.detail === undefined ? current.detail : input.detail,
        updatedAt: input.now,
      })
      .where(eq(operatingStates.id, current.id))
      .returning();
    if (!updated) return null;

    const [event] = await this.db
      .insert(operatingEvents)
      .values({
        operatingStateId: current.id,
        proposalId,
        projectId,
        missionId,
        kind: input.kind,
        fromState: current.state,
        toState: input.to,
        message: input.message,
        createdAt: input.now,
      })
      .returning();
    if (!event) throw new Error('The operating event could not be recorded.');

    return { snapshot: toSnapshot(updated), event: toEvent(event) };
  }

  /** Everything said about one idea, oldest first. Asked for by idea, never by recency. */
  async events(proposalId: string, limit = 200): Promise<readonly OperatingEvent[]> {
    if (!UUID.test(proposalId)) return [];
    const rows = await this.db
      .select()
      .from(operatingEvents)
      .where(eq(operatingEvents.proposalId, proposalId))
      .orderBy(asc(operatingEvents.createdAt))
      .limit(limit);
    return rows.map(toEvent);
  }

  /**
   * What has not been said out loud yet, across every idea, oldest first.
   *
   * Ordered by creation rather than by idea so that two ideas in flight are narrated in the order
   * things actually happened, which is the order a person in the room would have heard them.
   */
  async unspoken(limit = 20): Promise<readonly OperatingEvent[]> {
    const rows = await this.db
      .select()
      .from(operatingEvents)
      .where(isNull(operatingEvents.spokenAt))
      .orderBy(asc(operatingEvents.createdAt))
      .limit(limit);
    return rows.map(toEvent);
  }

  /**
   * Mark events as said.
   *
   * Conditional on `spoken_at` still being null, so two tabs racing to speak the same sentence
   * produce one update and one utterance rather than two. The count returned is how many this
   * caller actually won, which is what it may speak.
   */
  async markSpoken(ids: readonly string[], now: Date): Promise<readonly string[]> {
    const valid = ids.filter((id) => UUID.test(id));
    if (valid.length === 0) return [];
    const rows = await this.db
      .update(operatingEvents)
      .set({ spokenAt: now })
      /*
       * `inArray`, not a hand-built IN clause. The ids are uuid-shaped by the filter above, but a
       * value that reaches SQL by string concatenation is one refactor away from not being.
       */
      .where(and(isNull(operatingEvents.spokenAt), inArray(operatingEvents.id, valid)))
      .returning({ id: operatingEvents.id });
    return rows.map((row) => row.id);
  }

  /** Every idea that has not finished, newest activity first. */
  async live(limit = 20): Promise<readonly OperatingSnapshot[]> {
    const rows = await this.db
      .select()
      .from(operatingStates)
      .orderBy(desc(operatingStates.updatedAt))
      .limit(limit);
    return rows
      .map(toSnapshot)
      .filter((row) => row.state !== 'delivered' && row.state !== 'cancelled');
  }
}
