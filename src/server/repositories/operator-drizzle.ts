import { and, desc, eq, gte, inArray, lt, notInArray, sql } from 'drizzle-orm';

import { ConflictError } from '@/domain/errors';
import type {
  ObservationCoverage,
  Opportunity,
  OpportunityState,
  PriorityBand,
  PriorityFactor,
} from '@/domain/opportunity';
import type { OutcomeHypothesis, OutcomeObservation } from '@/domain/outcome';
import {
  missionOutcomes,
  operatorLeases,
  operatorOpportunities,
  operatorTicks,
} from '@/server/db/schema';
import type { Database } from '@/server/db/client';
import type {
  OperatorLease,
  OperatorLeaseRepository,
  OperatorTickRecord,
  OperatorTickRepository,
  OpportunityRecord,
  OpportunityRepository,
  OutcomeRecord,
  OutcomeRepository,
} from './operator-types';
import { iso, isoRequired } from './mappers';

/**
 * Persistence for the operating loop.
 *
 * The interesting property here is what does *not* change on a repeat sighting. An opportunity
 * seen for the twentieth time keeps its `first_seen_at`, its state and whatever decision was made
 * about it; only `last_seen_at` and the freshly-derived wording move. Overwriting the rest would
 * quietly resurrect opportunities the owner had dismissed and reset the clock on ones that have
 * been ignored for a week — which is exactly the clock the age factor reads.
 */

function toOpportunity(row: typeof operatorOpportunities.$inferSelect): OpportunityRecord {
  return {
    id: row.id,
    key: row.key,
    projectId: row.projectId,
    source: row.source,
    rule: row.rule,
    title: row.title,
    detail: row.detail,
    severity: row.severity as Opportunity['severity'],
    provenance: row.provenance,
    evidenceIds: row.evidenceIds ?? [],
    capabilities: row.capabilities ?? [],
    acceptanceCriteria: row.acceptanceCriteria ?? [],
    missionType: row.missionType,
    requiresOwner: row.requiresOwner,
    state: row.state,
    band: row.band,
    score: row.score,
    factors: row.factors ?? [],
    missionId: row.missionId,
    observedAt: isoRequired(row.lastSeenAt),
    firstSeenAt: isoRequired(row.firstSeenAt),
    lastSeenAt: isoRequired(row.lastSeenAt),
    closedAt: iso(row.closedAt),
    closedReason: row.closedReason,
  };
}

export class DrizzleOpportunityRepository implements OpportunityRepository {
  constructor(private readonly db: Database) {}

  async observe(input: {
    readonly opportunities: readonly Opportunity[];
    readonly now: Date;
  }): Promise<readonly OpportunityRecord[]> {
    if (input.opportunities.length === 0) return [];

    const rows = await this.db
      .insert(operatorOpportunities)
      .values(
        input.opportunities.map((opportunity) => ({
          key: opportunity.key,
          projectId: opportunity.projectId,
          source: opportunity.source,
          rule: opportunity.rule,
          title: opportunity.title,
          detail: opportunity.detail,
          severity: opportunity.severity,
          provenance: opportunity.provenance,
          evidenceIds: [...opportunity.evidenceIds],
          capabilities: [...opportunity.capabilities],
          acceptanceCriteria: [...opportunity.acceptanceCriteria],
          missionType: opportunity.missionType,
          requiresOwner: opportunity.requiresOwner,
          firstSeenAt: input.now,
          lastSeenAt: input.now,
        })),
      )
      .onConflictDoUpdate({
        target: operatorOpportunities.key,
        set: {
          /*
           * The wording and the evidence may legitimately have moved — a workflow that was failing
           * once is now failing three times — so those are refreshed. `first_seen_at`, `state`,
           * `band`, `mission_id` and everything about a decision already taken are not: they are
           * what makes this the same opportunity rather than a new one wearing its name.
           */
          title: sql`excluded.title`,
          detail: sql`excluded.detail`,
          severity: sql`excluded.severity`,
          provenance: sql`excluded.provenance`,
          evidenceIds: sql`excluded.evidence_ids`,
          capabilities: sql`excluded.capabilities`,
          acceptanceCriteria: sql`excluded.acceptance_criteria`,
          missionType: sql`excluded.mission_type`,
          requiresOwner: sql`excluded.requires_owner`,
          lastSeenAt: input.now,
        },
      })
      .returning();
    return rows.map(toOpportunity);
  }

  async reprioritise(
    input: readonly {
      readonly key: string;
      readonly band: PriorityBand;
      readonly score: number;
      readonly factors: readonly PriorityFactor[];
    }[],
  ): Promise<void> {
    for (const entry of input) {
      await this.db
        .update(operatorOpportunities)
        .set({ band: entry.band, score: entry.score, factors: [...entry.factors] })
        .where(eq(operatorOpportunities.key, entry.key));
    }
  }

  async listByState(states: readonly OpportunityState[]): Promise<readonly OpportunityRecord[]> {
    if (states.length === 0) return [];
    const rows = await this.db
      .select()
      .from(operatorOpportunities)
      .where(inArray(operatorOpportunities.state, [...states]))
      .orderBy(desc(operatorOpportunities.score), desc(operatorOpportunities.lastSeenAt));
    return rows.map(toOpportunity);
  }

  async keysByState(states: readonly OpportunityState[]): Promise<ReadonlySet<string>> {
    if (states.length === 0) return new Set();
    const rows = await this.db
      .select({ key: operatorOpportunities.key })
      .from(operatorOpportunities)
      .where(inArray(operatorOpportunities.state, [...states]));
    return new Set(rows.map((row) => row.key));
  }

  async findByKey(key: string): Promise<OpportunityRecord | null> {
    const [row] = await this.db
      .select()
      .from(operatorOpportunities)
      .where(eq(operatorOpportunities.key, key))
      .limit(1);
    return row ? toOpportunity(row) : null;
  }

  /**
   * Attach the mission working it.
   *
   * The `state = 'open'` predicate is the concurrency control: two ticks that both selected the
   * same opportunity cannot both create a mission for it, because the second update matches
   * nothing and gets null back.
   */
  async take(key: string, missionId: string | null, now: Date): Promise<OpportunityRecord | null> {
    /*
     * `state = 'open'` on the first call is the concurrency control; `taken` on the second is how
     * the same holder comes back to attach the mission it has since created. Allowing both means
     * one method serves the claim and the attachment without a second, near-identical one that
     * could drift.
     */
    const [row] = await this.db
      .update(operatorOpportunities)
      .set({ state: 'taken', missionId, lastSeenAt: now })
      .where(
        and(
          eq(operatorOpportunities.key, key),
          missionId === null
            ? eq(operatorOpportunities.state, 'open')
            : inArray(operatorOpportunities.state, ['open', 'taken']),
        ),
      )
      .returning();
    return row ? toOpportunity(row) : null;
  }

  /**
   * Close what this tick did not see again.
   *
   * Scoped to the projects actually observed. A project whose source failed produced no
   * opportunities this tick, and closing its backlog on that basis would read "everything is
   * fixed" when the truth is "Jarvis could not look" — the exact confusion the coverage record
   * exists to prevent.
   *
   * `taken` is excluded: a mission is working it, and the underlying evidence disappearing while
   * that mission runs is normal rather than a reason to abandon it.
   */
  async resolveMissing(input: {
    readonly seenKeys: ReadonlySet<string>;
    readonly projectIds: readonly string[];
    readonly now: Date;
  }): Promise<number> {
    if (input.projectIds.length === 0) return 0;
    const keys = [...input.seenKeys];
    const rows = await this.db
      .update(operatorOpportunities)
      .set({
        state: 'resolved',
        closedAt: input.now,
        closedReason: 'The reason for it stopped being true.',
      })
      .where(
        and(
          eq(operatorOpportunities.state, 'open'),
          inArray(operatorOpportunities.projectId, [...input.projectIds]),
          keys.length > 0 ? notInArray(operatorOpportunities.key, keys) : sql`true`,
        ),
      )
      .returning({ id: operatorOpportunities.id });
    return rows.length;
  }

  async close(input: {
    readonly key: string;
    readonly state: Extract<OpportunityState, 'dismissed' | 'declined' | 'resolved'>;
    readonly reason: string;
    readonly now: Date;
  }): Promise<OpportunityRecord | null> {
    const [row] = await this.db
      .update(operatorOpportunities)
      .set({ state: input.state, closedAt: input.now, closedReason: input.reason })
      .where(eq(operatorOpportunities.key, input.key))
      .returning();
    return row ? toOpportunity(row) : null;
  }
}

/* ------------------------------------------------------------------ leases */

function toLease(row: typeof operatorLeases.$inferSelect): OperatorLease {
  return {
    scope: row.scope,
    key: row.key,
    holder: row.holder,
    acquiredAt: isoRequired(row.acquiredAt),
    expiresAt: isoRequired(row.expiresAt),
  };
}

export class DrizzleOperatorLeaseRepository implements OperatorLeaseRepository {
  constructor(private readonly db: Database) {}

  /**
   * Take the lease, stealing an expired one.
   *
   * One statement. Read-then-write would let two ticks both see a free lease and both take it,
   * which is precisely the thing a lease exists to stop — and it would happen rarely enough to
   * survive every test and show up in production a fortnight later.
   */
  async acquire(input: {
    readonly scope: string;
    readonly key: string;
    readonly holder: string;
    readonly ttlSeconds: number;
    readonly now: Date;
  }): Promise<boolean> {
    const expiresAt = new Date(input.now.getTime() + input.ttlSeconds * 1000);
    const rows = await this.db
      .insert(operatorLeases)
      .values({
        scope: input.scope,
        key: input.key,
        holder: input.holder,
        acquiredAt: input.now,
        expiresAt,
      })
      .onConflictDoUpdate({
        target: [operatorLeases.scope, operatorLeases.key],
        set: { holder: input.holder, acquiredAt: input.now, expiresAt },
        /* Only steal what has actually lapsed. A live holder keeps it. */
        where: lt(operatorLeases.expiresAt, input.now),
      })
      .returning();
    return rows.length > 0;
  }

  async renew(input: {
    readonly scope: string;
    readonly key: string;
    readonly holder: string;
    readonly ttlSeconds: number;
    readonly now: Date;
  }): Promise<boolean> {
    const rows = await this.db
      .update(operatorLeases)
      .set({ expiresAt: new Date(input.now.getTime() + input.ttlSeconds * 1000) })
      .where(
        and(
          eq(operatorLeases.scope, input.scope),
          eq(operatorLeases.key, input.key),
          eq(operatorLeases.holder, input.holder),
        ),
      )
      .returning();
    return rows.length > 0;
  }

  async release(scope: string, key: string, holder: string): Promise<void> {
    await this.db
      .delete(operatorLeases)
      .where(
        and(
          eq(operatorLeases.scope, scope),
          eq(operatorLeases.key, key),
          eq(operatorLeases.holder, holder),
        ),
      );
  }

  async current(scope: string, key: string): Promise<OperatorLease | null> {
    const [row] = await this.db
      .select()
      .from(operatorLeases)
      .where(
        and(
          eq(operatorLeases.scope, scope),
          eq(operatorLeases.key, key),
          gte(operatorLeases.expiresAt, new Date()),
        ),
      )
      .limit(1);
    return row ? toLease(row) : null;
  }
}

/* ------------------------------------------------------------------- ticks */

function toTick(row: typeof operatorTicks.$inferSelect): OperatorTickRecord {
  return {
    id: row.id,
    startedAt: isoRequired(row.startedAt),
    finishedAt: iso(row.finishedAt),
    mode: row.mode,
    outcome: row.outcome as OperatorTickRecord['outcome'],
    summary: row.summary,
    projectsObserved: row.projectsObserved,
    opportunitiesFound: row.opportunitiesFound,
    missionsStarted: row.missionsStarted,
    coverage: (row.coverage ?? []) as readonly ObservationCoverage[],
    capacityVerdict: row.capacityVerdict ?? null,
    capacityReason: row.capacityReason,
  };
}

export class DrizzleOperatorTickRepository implements OperatorTickRepository {
  constructor(private readonly db: Database) {}

  async start(input: { readonly mode: string; readonly now: Date }): Promise<OperatorTickRecord> {
    const [row] = await this.db
      .insert(operatorTicks)
      .values({ mode: input.mode, startedAt: input.now, summary: 'Started.' })
      .returning();
    if (!row) throw new ConflictError('The tick could not be recorded.');
    return toTick(row);
  }

  async finish(
    input: Parameters<OperatorTickRepository['finish']>[0],
  ): Promise<OperatorTickRecord> {
    const [row] = await this.db
      .update(operatorTicks)
      .set({
        finishedAt: input.now,
        outcome: input.outcome,
        summary: input.summary,
        projectsObserved: input.projectsObserved,
        opportunitiesFound: input.opportunitiesFound,
        missionsStarted: input.missionsStarted,
        coverage: [...input.coverage],
        /*
         * Written as a pair or not at all. A verdict with no sentence beside it is a word an owner
         * cannot act on, and a sentence with no verdict cannot be read by the next pass.
         */
        capacityVerdict: input.capacity?.verdict ?? null,
        capacityReason: input.capacity?.reason ?? null,
      })
      .where(eq(operatorTicks.id, input.id))
      .returning();
    if (!row) throw new ConflictError('That tick no longer exists.');
    return toTick(row);
  }

  async recent(limit = 50): Promise<readonly OperatorTickRecord[]> {
    const rows = await this.db
      .select()
      .from(operatorTicks)
      .orderBy(desc(operatorTicks.startedAt))
      .limit(limit);
    return rows.map(toTick);
  }

  async lastFinished(): Promise<OperatorTickRecord | null> {
    const [row] = await this.db
      .select()
      .from(operatorTicks)
      .where(sql`${operatorTicks.finishedAt} is not null`)
      .orderBy(desc(operatorTicks.startedAt))
      .limit(1);
    return row ? toTick(row) : null;
  }
}

/* ---------------------------------------------------------------- outcomes */

function toOutcome(row: typeof missionOutcomes.$inferSelect): OutcomeRecord {
  const hypothesis: OutcomeHypothesis = {
    observedProblem: row.observedProblem,
    expectedBenefit: row.expectedBenefit,
    benefitKind: row.benefitKind,
    whyNow: row.whyNow,
    estimatedEffort: row.estimatedEffort,
    verificationPlan: row.verificationPlan,
    successSignal: row.successSignal,
  };
  const observation: OutcomeObservation | null =
    row.observedAt && row.verdict
      ? {
          observedAt: isoRequired(row.observedAt),
          before: row.signalBefore,
          after: row.signalAfter,
          verdict: row.verdict,
          note: row.verdictNote ?? '',
          evidenceIds: row.evidenceIds,
        }
      : null;
  return {
    id: row.id,
    missionId: row.missionId,
    opportunityKey: row.opportunityKey,
    hypothesis,
    signalBefore: row.signalBefore,
    observation,
    createdAt: isoRequired(row.createdAt),
  };
}

export class DrizzleOutcomeRepository implements OutcomeRepository {
  constructor(private readonly db: Database) {}

  /**
   * Insert, and on conflict do *nothing*.
   *
   * Not an upsert. A hypothesis that could be rewritten once the result was known would not be a
   * prediction, and the only thing separating measurement from a flattering narrative is that the
   * prediction came first. So a second call returns what is already there.
   */
  async open(input: {
    readonly missionId: string;
    readonly opportunityKey: string | null;
    readonly hypothesis: OutcomeHypothesis;
    readonly signalBefore: string | null;
  }): Promise<OutcomeRecord> {
    const [row] = await this.db
      .insert(missionOutcomes)
      .values({
        missionId: input.missionId,
        opportunityKey: input.opportunityKey,
        observedProblem: input.hypothesis.observedProblem,
        expectedBenefit: input.hypothesis.expectedBenefit,
        benefitKind: input.hypothesis.benefitKind,
        whyNow: input.hypothesis.whyNow,
        estimatedEffort: input.hypothesis.estimatedEffort,
        verificationPlan: input.hypothesis.verificationPlan,
        successSignal: input.hypothesis.successSignal,
        signalBefore: input.signalBefore,
      })
      .onConflictDoNothing()
      .returning();
    if (row) return toOutcome(row);

    const existing = await this.findByMission(input.missionId);
    if (!existing) throw new ConflictError('That outcome record could not be written.');
    return existing;
  }

  async observe(input: {
    readonly missionId: string;
    readonly observation: OutcomeObservation;
    readonly rule: string;
  }): Promise<OutcomeRecord | null> {
    const [row] = await this.db
      .update(missionOutcomes)
      .set({
        observedAt: new Date(input.observation.observedAt),
        signalAfter: input.observation.after,
        verdict: input.observation.verdict,
        verdictRule: input.rule,
        verdictNote: input.observation.note,
        evidenceIds: [...input.observation.evidenceIds],
      })
      .where(eq(missionOutcomes.missionId, input.missionId))
      .returning();
    return row ? toOutcome(row) : null;
  }

  async findByMission(missionId: string): Promise<OutcomeRecord | null> {
    const [row] = await this.db
      .select()
      .from(missionOutcomes)
      .where(eq(missionOutcomes.missionId, missionId))
      .limit(1);
    return row ? toOutcome(row) : null;
  }

  async awaitingObservation(limit = 20): Promise<readonly OutcomeRecord[]> {
    const rows = await this.db
      .select()
      .from(missionOutcomes)
      .where(sql`${missionOutcomes.verdict} is null`)
      .orderBy(missionOutcomes.createdAt)
      .limit(limit);
    return rows.map(toOutcome);
  }

  async recent(limit = 20): Promise<readonly OutcomeRecord[]> {
    const rows = await this.db
      .select()
      .from(missionOutcomes)
      .orderBy(desc(missionOutcomes.createdAt))
      .limit(limit);
    return rows.map(toOutcome);
  }
}
