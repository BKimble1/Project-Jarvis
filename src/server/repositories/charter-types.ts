import type { CharterContent, OperatingCharterVersion } from '@/domain/charter';
import type {
  AuthorizationDecision,
  CapabilityRequest,
  CapabilityVerdict,
} from '@/domain/authorization';
import type { OperatingMode } from '@/domain/operating-mode';

/**
 * The persistence boundary for standing authority.
 *
 * Three tables, one interface each, and the shape of them says what matters: charters are written
 * and activated but never edited, the operating mode is one row, and decisions are only ever
 * appended. Nothing here has an `update` that changes what a past decision said, because the point
 * of the whole subsystem is to be able to answer "what was it allowed to do, and who said so?"
 * long after the answer has changed.
 */

export interface CharterRepository {
  /** Write a new version as a draft. Drafts authorise nothing until activated. */
  draft(input: {
    content: CharterContent;
    digest: string;
    authoredBy: string;
    note?: string | null;
  }): Promise<OperatingCharterVersion>;

  /**
   * Make a version the one in force, superseding whatever was, in a single transaction.
   *
   * Both halves or neither. A partial application would leave either two charters in force — which
   * the partial unique index refuses, loudly, at some unrelated later moment — or none, which
   * silently switches Jarvis off.
   */
  activate(id: string, activatedBy: string, now: Date): Promise<OperatingCharterVersion>;

  findById(id: string): Promise<OperatingCharterVersion | null>;
  /** The version in force, or null when there is none. */
  active(): Promise<OperatingCharterVersion | null>;
  list(limit?: number): Promise<readonly OperatingCharterVersion[]>;
}

export interface OperatorStateRecord {
  readonly mode: OperatingMode;
  readonly charterId: string | null;
  readonly changedBy: string;
  readonly changedAt: string;
  readonly reason: string | null;
  readonly until: string | null;
  /**
   * Where a pause came from, so lifting it can return to exactly that mode.
   *
   * Null in every mode that is not `paused`. See the column's own note: without it a master pause
   * is a one-way door, because coming back out of it is a widening move that asks for a typed
   * confirmation intended for a quite different decision.
   */
  readonly pausedFrom: OperatingMode | null;
}

export interface OperatorStateRepository {
  /**
   * The current state, creating the singleton row on first read.
   *
   * Defaults to `off`. A deployment that has never been configured must not be observing, let
   * alone operating, and "the row was missing" is not a reason to guess otherwise.
   */
  get(): Promise<OperatorStateRecord>;
  set(input: {
    mode: OperatingMode;
    charterId?: string | null;
    changedBy: string;
    reason?: string | null;
    until?: Date | null;
    pausedFrom?: OperatingMode | null;
    now: Date;
  }): Promise<OperatorStateRecord>;
}

export interface StoredAuthorizationDecision extends AuthorizationDecision {
  readonly id: string;
  readonly missionId: string | null;
  readonly requested: readonly CapabilityRequest[];
  readonly estimatedSpendUsd: number | null;
}

export interface AuthorizationDecisionRepository {
  record(input: {
    missionId?: string | null;
    decision: AuthorizationDecision;
    requested: readonly CapabilityRequest[];
    estimatedSpendUsd?: number | null;
  }): Promise<StoredAuthorizationDecision>;
  findById(id: string): Promise<StoredAuthorizationDecision | null>;
  listForMission(missionId: string): Promise<readonly StoredAuthorizationDecision[]>;
  /** Most recent first. Used by the operator interface and by "why has it done nothing?" */
  recent(limit?: number): Promise<readonly StoredAuthorizationDecision[]>;
}

export type { CapabilityVerdict };
