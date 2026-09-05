import type {
  ObservationCoverage,
  Opportunity,
  OpportunityState,
  PriorityBand,
  PriorityFactor,
} from '@/domain/opportunity';

/**
 * The persistence boundary for the operating loop.
 *
 * Two things live here: the backlog of what Jarvis could do, and the lease that stops two ticks
 * running at once. Neither is glamorous, and the second is the one that decides whether the loop
 * survives a restart or quietly does everything twice.
 */

export interface OpportunityRecord extends Opportunity {
  readonly id: string;
  readonly state: OpportunityState;
  readonly band: PriorityBand;
  readonly score: number;
  readonly factors: readonly PriorityFactor[];
  /** The mission working it, once one exists. */
  readonly missionId: string | null;
  readonly firstSeenAt: string;
  readonly lastSeenAt: string;
  readonly closedAt: string | null;
  readonly closedReason: string | null;
}

export interface OpportunityRepository {
  /**
   * Record what this tick saw.
   *
   * Upsert on the key: a situation seen for the tenth time is the same opportunity with a newer
   * `lastSeenAt`, not a tenth row. Returns the records as they now stand, with `firstSeenAt`
   * preserved from whenever it was actually first noticed — which is the figure the age factor
   * uses, and the reason a long-ignored problem eventually rises.
   */
  observe(input: {
    readonly opportunities: readonly Opportunity[];
    readonly now: Date;
  }): Promise<readonly OpportunityRecord[]>;

  /** Rank and band, recomputed each tick because the charter and the coverage move underneath. */
  reprioritise(
    input: readonly {
      readonly key: string;
      readonly band: PriorityBand;
      readonly score: number;
      readonly factors: readonly PriorityFactor[];
    }[],
  ): Promise<void>;

  listByState(states: readonly OpportunityState[]): Promise<readonly OpportunityRecord[]>;
  keysByState(states: readonly OpportunityState[]): Promise<ReadonlySet<string>>;
  findByKey(key: string): Promise<OpportunityRecord | null>;

  /**
   * Claim it, and attach the mission once there is one.
   *
   * `missionId` may be null, because the claim has to happen *before* the mission exists — it is
   * what stops two ticks both creating a mission for the same thing, and a placeholder id would
   * either violate the foreign key or point at a mission that is not there.
   *
   * Returns null when something else got there first, which is not an error: two ticks racing is
   * the normal case for a loop driven from more than one place.
   */
  take(key: string, missionId: string | null, now: Date): Promise<OpportunityRecord | null>;

  /**
   * Close everything open that this tick did not see again.
   *
   * `resolved` rather than `dismissed`: nothing was done about it, it simply stopped being true,
   * and those read very differently in a weekly summary.
   */
  resolveMissing(input: {
    readonly seenKeys: ReadonlySet<string>;
    readonly projectIds: readonly string[];
    readonly now: Date;
  }): Promise<number>;

  close(input: {
    readonly key: string;
    readonly state: Extract<OpportunityState, 'dismissed' | 'declined' | 'resolved'>;
    readonly reason: string;
    readonly now: Date;
  }): Promise<OpportunityRecord | null>;
}

/* ------------------------------------------------------------------ leases */

export interface OperatorLease {
  readonly scope: string;
  readonly key: string;
  readonly holder: string;
  readonly acquiredAt: string;
  readonly expiresAt: string;
}

export interface OperatorLeaseRepository {
  /**
   * Take a lease, stealing one that has expired.
   *
   * Expired leases are stealable on purpose. A tick killed mid-flight — a container recycled, a
   * function timed out — would otherwise wedge the whole loop until somebody deleted a row, and an
   * operator that stops permanently because one invocation died is not an operator.
   *
   * Returns false rather than throwing when somebody else holds it. Two ticks racing is the normal
   * case, not an error: one wins, the other goes back to sleep.
   */
  acquire(input: {
    readonly scope: string;
    readonly key: string;
    readonly holder: string;
    readonly ttlSeconds: number;
    readonly now: Date;
  }): Promise<boolean>;

  /** Extend a lease this holder still holds. Returns false if it has been taken by somebody else. */
  renew(input: {
    readonly scope: string;
    readonly key: string;
    readonly holder: string;
    readonly ttlSeconds: number;
    readonly now: Date;
  }): Promise<boolean>;

  release(scope: string, key: string, holder: string): Promise<void>;
  current(scope: string, key: string): Promise<OperatorLease | null>;
}

/* -------------------------------------------------------------- tick record */

export interface OperatorTickRecord {
  readonly id: string;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly mode: string;
  readonly outcome: 'observed' | 'worked' | 'held' | 'skipped' | 'failed';
  /** Why nothing happened, when nothing happened. The most-read field on a quiet day. */
  readonly summary: string;
  readonly projectsObserved: number;
  readonly opportunitiesFound: number;
  readonly missionsStarted: number;
  readonly coverage: readonly ObservationCoverage[];
}

export interface OperatorTickRepository {
  start(input: { readonly mode: string; readonly now: Date }): Promise<OperatorTickRecord>;
  finish(input: {
    readonly id: string;
    readonly outcome: OperatorTickRecord['outcome'];
    readonly summary: string;
    readonly projectsObserved: number;
    readonly opportunitiesFound: number;
    readonly missionsStarted: number;
    readonly coverage: readonly ObservationCoverage[];
    readonly now: Date;
  }): Promise<OperatorTickRecord>;
  recent(limit?: number): Promise<readonly OperatorTickRecord[]>;
  lastFinished(): Promise<OperatorTickRecord | null>;
}
