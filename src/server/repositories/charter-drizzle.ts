import { and, desc, eq, isNotNull, isNull, sql } from 'drizzle-orm';

import type { CharterContent, OperatingCharterVersion } from '@/domain/charter';
import type { AuthorizationDecision, CapabilityRequest } from '@/domain/authorization';
import { ConflictError, NotFoundError } from '@/domain/errors';
import type { OperatingMode } from '@/domain/operating-mode';
import {
  authorizationDecisions,
  operatingCharters,
  operatorState,
} from '@/server/db/schema';
import type { Database } from '@/server/db/client';
import type {
  AuthorizationDecisionRepository,
  CharterRepository,
  OperatorStateRecord,
  OperatorStateRepository,
  StoredAuthorizationDecision,
} from './charter-types';
import { iso, isoRequired } from './mappers';

/**
 * Persistence for standing authority.
 *
 * The rule this file exists to keep is that **nothing here rewrites the past**. A charter is
 * drafted, activated, and superseded; it is never edited. A decision is recorded whatever its
 * outcome and never revised. The mode is the only mutable thing, and its history lives in the
 * hash-chained audit log rather than in a second table that could disagree with the first.
 */

const OPERATOR_STATE_ID = 'singleton';

function toCharter(row: typeof operatingCharters.$inferSelect): OperatingCharterVersion {
  return {
    id: row.id,
    version: row.version,
    content: row.content,
    digest: row.digest,
    authoredBy: row.authoredBy,
    note: row.note,
    activatedAt: iso(row.activatedAt),
    activatedBy: row.activatedBy,
    supersededAt: iso(row.supersededAt),
    createdAt: isoRequired(row.createdAt),
  };
}

export class DrizzleCharterRepository implements CharterRepository {
  constructor(private readonly db: Database) {}

  /**
   * Write a new draft version.
   *
   * The version number is derived inside the same statement that inserts, from
   * `max(version) + 1`, rather than read and then written. Two owners drafting at once would
   * otherwise both read the same number and the unique index would reject one of them with an
   * error about a constraint instead of simply giving them the next number.
   */
  async draft(input: {
    content: CharterContent;
    digest: string;
    authoredBy: string;
    note?: string | null;
  }): Promise<OperatingCharterVersion> {
    const [row] = await this.db
      .insert(operatingCharters)
      .values({
        version: sql`(select coalesce(max(${operatingCharters.version}), 0) + 1 from ${operatingCharters})`,
        content: input.content,
        digest: input.digest,
        authoredBy: input.authoredBy,
        note: input.note ?? null,
      })
      .returning();
    if (!row) throw new ConflictError('The charter version could not be written.');
    return toCharter(row);
  }

  /**
   * Make a version the one in force.
   *
   * One transaction, and the supersession comes first. The partial unique index over
   * `(superseded_at) where superseded_at is null and activated_at is not null` is what makes the
   * ordering safe under concurrency: two activations racing cannot both leave a row in force,
   * because the second violates the index and its whole transaction rolls back. That is a
   * database guarantee rather than a hopeful sequence of statements.
   *
   * Re-activating the version already in force is a no-op that succeeds rather than an error. It
   * is a thing an owner does when they are not sure the first click registered, and the safe
   * reading of it is "yes, that one".
   */
  async activate(
    id: string,
    activatedBy: string,
    now: Date,
  ): Promise<OperatingCharterVersion> {
    return this.db.transaction(async (tx) => {
      const [candidate] = await tx
        .select()
        .from(operatingCharters)
        .where(eq(operatingCharters.id, id))
        .limit(1);
      if (!candidate) throw new NotFoundError('Charter version');
      if (candidate.supersededAt) {
        throw new ConflictError(
          `Charter version ${candidate.version} was superseded on ${candidate.supersededAt.toISOString()}. Draft a new version rather than reviving an old one.`,
        );
      }
      if (candidate.activatedAt) return toCharter(candidate);

      await tx
        .update(operatingCharters)
        .set({ supersededAt: now })
        .where(
          and(
            isNull(operatingCharters.supersededAt),
            isNotNull(operatingCharters.activatedAt),
          ),
        );

      const [activated] = await tx
        .update(operatingCharters)
        .set({ activatedAt: now, activatedBy, supersededAt: null })
        .where(eq(operatingCharters.id, id))
        .returning();
      if (!activated) throw new NotFoundError('Charter version');
      return toCharter(activated);
    });
  }

  async findById(id: string): Promise<OperatingCharterVersion | null> {
    const [row] = await this.db
      .select()
      .from(operatingCharters)
      .where(eq(operatingCharters.id, id))
      .limit(1);
    return row ? toCharter(row) : null;
  }

  async active(): Promise<OperatingCharterVersion | null> {
    const [row] = await this.db
      .select()
      .from(operatingCharters)
      .where(
        and(isNull(operatingCharters.supersededAt), isNotNull(operatingCharters.activatedAt)),
      )
      .limit(1);
    return row ? toCharter(row) : null;
  }

  async list(limit = 50): Promise<readonly OperatingCharterVersion[]> {
    const rows = await this.db
      .select()
      .from(operatingCharters)
      .orderBy(desc(operatingCharters.version))
      .limit(limit);
    return rows.map(toCharter);
  }
}

/* ------------------------------------------------------------------- mode */

function toState(row: typeof operatorState.$inferSelect): OperatorStateRecord {
  return {
    mode: row.mode,
    charterId: row.charterId,
    changedBy: row.changedBy,
    changedAt: isoRequired(row.changedAt),
    reason: row.reason,
    until: iso(row.until),
  };
}

export class DrizzleOperatorStateRepository implements OperatorStateRepository {
  constructor(private readonly db: Database) {}

  /**
   * Read the state, creating the row on first use.
   *
   * The default is `off`, and `changedBy` is `system` — an accurate statement that nobody has
   * chosen anything yet. A deployment that has never been configured must not be observing, and
   * "the row was missing" is not grounds for assuming otherwise.
   */
  async get(): Promise<OperatorStateRecord> {
    const [existing] = await this.db
      .select()
      .from(operatorState)
      .where(eq(operatorState.id, OPERATOR_STATE_ID))
      .limit(1);
    if (existing) return toState(existing);

    const [created] = await this.db
      .insert(operatorState)
      .values({ id: OPERATOR_STATE_ID, mode: 'off', changedBy: 'system' })
      .onConflictDoNothing()
      .returning();
    if (created) return toState(created);

    const [raced] = await this.db
      .select()
      .from(operatorState)
      .where(eq(operatorState.id, OPERATOR_STATE_ID))
      .limit(1);
    if (!raced) throw new ConflictError('The operator state row could not be created.');
    return toState(raced);
  }

  /**
   * Write the mode.
   *
   * This deliberately validates nothing. Whether a move is permitted, and by whom, is
   * `assertModeChange`'s question, and answering it in two places is how the two answers start to
   * differ. The service asks; the repository writes what it is told.
   */
  async set(input: {
    mode: OperatingMode;
    charterId?: string | null;
    changedBy: string;
    reason?: string | null;
    until?: Date | null;
    now: Date;
  }): Promise<OperatorStateRecord> {
    await this.get();
    const [row] = await this.db
      .update(operatorState)
      .set({
        mode: input.mode,
        ...(input.charterId !== undefined ? { charterId: input.charterId } : {}),
        changedBy: input.changedBy,
        changedAt: input.now,
        reason: input.reason ?? null,
        until: input.until ?? null,
      })
      .where(eq(operatorState.id, OPERATOR_STATE_ID))
      .returning();
    if (!row) throw new ConflictError('The operator state could not be written.');
    return toState(row);
  }
}

/* -------------------------------------------------------------- decisions */

function toDecision(
  row: typeof authorizationDecisions.$inferSelect,
): StoredAuthorizationDecision {
  return {
    id: row.id,
    missionId: row.missionId,
    outcome: row.outcome,
    mode: row.mode,
    qualificationLevel: row.qualificationLevel as StoredAuthorizationDecision['qualificationLevel'],
    charterVersionId: row.charterVersionId,
    charterDigest: row.charterDigest,
    verdicts: row.verdicts ?? [],
    requested: row.requested ?? [],
    estimatedSpendUsd: row.estimatedSpendUsd === null ? null : Number(row.estimatedSpendUsd),
    summary: row.summary,
    decidedAt: isoRequired(row.decidedAt),
  };
}

export class DrizzleAuthorizationDecisionRepository implements AuthorizationDecisionRepository {
  constructor(private readonly db: Database) {}

  /**
   * Append a decision, whatever it decided.
   *
   * The refusals are the more valuable half of this table. An owner asking "why has it not done
   * anything?" is asking to read the refusals, and a decision discarded because the answer was no
   * is a decision nobody can explain afterwards.
   */
  async record(input: {
    missionId?: string | null;
    decision: AuthorizationDecision;
    requested: readonly CapabilityRequest[];
    estimatedSpendUsd?: number | null;
  }): Promise<StoredAuthorizationDecision> {
    const [row] = await this.db
      .insert(authorizationDecisions)
      .values({
        missionId: input.missionId ?? null,
        outcome: input.decision.outcome,
        mode: input.decision.mode,
        qualificationLevel: input.decision.qualificationLevel,
        charterVersionId: input.decision.charterVersionId,
        charterDigest: input.decision.charterDigest,
        verdicts: [...input.decision.verdicts],
        requested: [...input.requested],
        estimatedSpendUsd:
          input.estimatedSpendUsd === null || input.estimatedSpendUsd === undefined
            ? null
            : input.estimatedSpendUsd.toFixed(4),
        summary: input.decision.summary,
        decidedAt: new Date(input.decision.decidedAt),
      })
      .returning();
    if (!row) throw new ConflictError('The authorisation decision could not be recorded.');
    return toDecision(row);
  }

  async findById(id: string): Promise<StoredAuthorizationDecision | null> {
    const [row] = await this.db
      .select()
      .from(authorizationDecisions)
      .where(eq(authorizationDecisions.id, id))
      .limit(1);
    return row ? toDecision(row) : null;
  }

  async listForMission(missionId: string): Promise<readonly StoredAuthorizationDecision[]> {
    const rows = await this.db
      .select()
      .from(authorizationDecisions)
      .where(eq(authorizationDecisions.missionId, missionId))
      .orderBy(desc(authorizationDecisions.decidedAt));
    return rows.map(toDecision);
  }

  async recent(limit = 50): Promise<readonly StoredAuthorizationDecision[]> {
    const rows = await this.db
      .select()
      .from(authorizationDecisions)
      .orderBy(desc(authorizationDecisions.decidedAt))
      .limit(limit);
    return rows.map(toDecision);
  }
}
