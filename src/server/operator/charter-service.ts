import {
  charterContentSchema,
  charterDigest,
  isCharterExpired,
  validateGrants,
  type CharterContent,
  type OperatingCharterVersion,
} from '@/domain/charter';
import {
  authorize,
  type AuthorizationDecision,
  type AuthorizationRequest,
  type CapabilityRequest,
} from '@/domain/authorization';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '@/domain/errors';
import {
  assertModeChange,
  modeGrantsStandingAuthority,
  OPERATING_MODE_LABELS,
  type ModeActor,
  type OperatingMode,
} from '@/domain/operating-mode';
import type { QualificationLevel } from '@/domain/qualification';
import type { AuditRepository } from '@/server/repositories/accounting-types';
import type {
  AuthorizationDecisionRepository,
  CharterRepository,
  OperatorStateRecord,
  OperatorStateRepository,
  StoredAuthorizationDecision,
} from '@/server/repositories/charter-types';

/**
 * Standing authority, as a service.
 *
 * Three jobs, and the boundaries between them are the design:
 *
 * 1. **Charters are written and activated by people.** Nothing on this class can be reached by a
 *    model. `draft` and `activate` take an owner's name because there is no other kind of caller.
 * 2. **The mode is validated by the domain table, not here.** `assertModeChange` decides what may
 *    move where and who may move it; this class calls it and writes the result. Duplicating the
 *    rule would create two answers that eventually differ.
 * 3. **Every decision is recorded, including the refusals.** `decide` writes a row whatever it
 *    concludes, because "why has Jarvis not done anything?" is a question answered by reading the
 *    refusals, and a discarded refusal is unanswerable later.
 *
 * ## What this class deliberately cannot do
 *
 * It cannot widen a charter on Jarvis's behalf, raise a limit, add a repository, or promote a
 * mode. Every one of those is an owner action arriving through an authenticated route, and the
 * absence of a code path is the enforcement — not a flag, not a check somewhere that a later
 * refactor could invert.
 */

export interface CharterServiceDeps {
  readonly charters: CharterRepository;
  readonly state: OperatorStateRepository;
  readonly decisions: AuthorizationDecisionRepository;
  readonly audit: AuditRepository;
  /** Asked at decision time, never cached: a demotion mid-shift must take effect immediately. */
  readonly currentLevel: () => Promise<QualificationLevel>;
  readonly clock?: () => Date;
}

/**
 * A decision that has been re-read and still holds.
 *
 * The two charter fields are narrowed to non-null, because confirming a decision *is* proving
 * they are there. Handing callers the nullable shape would push a `?? throw` into every one of
 * them, and a check written five times is a check wrong in one of them.
 */
export interface ConfirmedAuthorization extends StoredAuthorizationDecision {
  readonly charterVersionId: string;
  readonly charterDigest: string;
}

export interface ActiveAuthority {
  readonly mode: OperatingMode;
  readonly charter: OperatingCharterVersion | null;
  readonly qualificationLevel: QualificationLevel;
  /** True only when the mode grants standing authority *and* a usable charter is in force. */
  readonly standingAuthority: boolean;
  /** Why standing authority is unavailable, in a sentence, or null when it is available. */
  readonly blockedReason: string | null;
}

export class CharterService {
  private readonly clock: () => Date;

  constructor(private readonly deps: CharterServiceDeps) {
    this.clock = deps.clock ?? (() => new Date());
  }

  /* ------------------------------------------------------------- authoring */

  /**
   * Write a new charter version as a draft.
   *
   * Validation happens in two layers and both are needed. The schema decides whether the shape is
   * a charter at all; `validateGrants` decides whether the *grants* make sense — a capability that
   * must enumerate its scope but says `*`, a scope dimension the capability does not have, a
   * duplicate. A schema cannot express the second, and a service that skipped it would accept a
   * charter that reads plausibly and grants something nobody meant.
   */
  async draft(input: {
    readonly content: unknown;
    readonly authoredBy: string;
    readonly note?: string | null;
  }): Promise<OperatingCharterVersion> {
    const parsed = charterContentSchema.safeParse(input.content);
    if (!parsed.success) {
      throw new ValidationError('That is not a valid charter.', {
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      });
    }
    const content = parsed.data as CharterContent;

    const problems = validateGrants(content.grants);
    if (problems.length > 0) {
      throw new ValidationError('Some of those grants cannot be honoured as written.', {
        problems: problems.map((problem) => ({
          capability: problem.capability,
          reason: problem.reason,
        })),
      });
    }

    const digest = charterDigest(content);
    const charter = await this.deps.charters.draft({
      content,
      digest,
      authoredBy: input.authoredBy,
      note: input.note ?? null,
    });

    await this.deps.audit.append({
      actor: input.authoredBy,
      actorKind: 'owner',
      action: 'charter.drafted',
      subjectKind: 'charter',
      subjectId: charter.id,
      outcome: 'allowed',
      summary: `Charter version ${charter.version} drafted with ${content.grants.length} grants. It authorises nothing until activated.`,
      detail: {
        version: charter.version,
        digest,
        capabilities: content.grants.map((grant) => grant.capability),
      },
    });
    return charter;
  }

  /**
   * Put a version in force.
   *
   * Activating a charter does *not* change the mode. Those are separate decisions and conflating
   * them would mean writing a charter switched Jarvis on — which is precisely the surprise nobody
   * wants from a document editor. The owner activates, then chooses a mode, and both are recorded.
   */
  async activate(id: string, activatedBy: string): Promise<OperatingCharterVersion> {
    const now = this.clock();
    const charter = await this.deps.charters.activate(id, activatedBy, now);

    /* Point the operator row at it, so "which charter is in force?" has one answer. */
    const state = await this.deps.state.get();
    await this.deps.state.set({
      mode: state.mode,
      charterId: charter.id,
      changedBy: activatedBy,
      reason: `Charter version ${charter.version} activated.`,
      until: state.until ? new Date(state.until) : null,
      now,
    });

    await this.deps.audit.append({
      actor: activatedBy,
      actorKind: 'owner',
      action: 'charter.activated',
      subjectKind: 'charter',
      subjectId: charter.id,
      outcome: 'allowed',
      summary: `Charter version ${charter.version} is now in force.`,
      detail: { version: charter.version, digest: charter.digest, mode: state.mode },
    });
    return charter;
  }

  async active(): Promise<OperatingCharterVersion | null> {
    return this.deps.charters.active();
  }

  async findById(id: string): Promise<OperatingCharterVersion | null> {
    return this.deps.charters.findById(id);
  }

  async history(limit?: number): Promise<readonly OperatingCharterVersion[]> {
    return this.deps.charters.list(limit);
  }

  /* ----------------------------------------------------------------- mode */

  async state(): Promise<OperatorStateRecord> {
    return this.deps.state.get();
  }

  /**
   * Change how much autonomy Jarvis has.
   *
   * The actor is `owner` or `system` and the difference is enforced by the transition table:
   * everything that reduces autonomy is available to both, everything that increases it is
   * available only to a signed-in owner. So a stuck or failing Jarvis can always be brought down,
   * and can never bring itself up.
   *
   * Moving *into* operator mode additionally requires a charter that is in force and not expired.
   * Standing authority with nothing standing behind it is the worst of both worlds: it looks
   * authorised in the interface and authorises nothing in fact.
   */
  async setMode(input: {
    readonly to: OperatingMode;
    readonly actor: ModeActor;
    readonly changedBy: string;
    readonly reason?: string | null;
    readonly until?: Date | null;
  }): Promise<OperatorStateRecord> {
    const now = this.clock();
    const current = await this.deps.state.get();
    const transition = assertModeChange(current.mode, input.to, input.actor);

    if (modeGrantsStandingAuthority(input.to)) {
      const charter = await this.deps.charters.active();
      if (!charter) {
        throw new ConflictError(
          'Jarvis cannot operate on standing authority without a charter in force. Activate one first.',
        );
      }
      if (isCharterExpired(charter, now)) {
        throw new ConflictError(
          `Charter version ${charter.version} expired on ${charter.content.expiresAt}. Draft and activate a new one before operating.`,
        );
      }
    }

    const next = await this.deps.state.set({
      mode: input.to,
      changedBy: input.changedBy,
      reason: input.reason ?? transition.summary,
      until: input.until ?? null,
      now,
    });

    await this.deps.audit.append({
      actor: input.changedBy,
      actorKind: input.actor === 'owner' ? 'owner' : 'system',
      action: transition.widens ? 'operator.mode.widened' : 'operator.mode.narrowed',
      subjectKind: 'operator_state',
      subjectId: 'singleton',
      outcome: 'allowed',
      summary: `Jarvis moved from ${OPERATING_MODE_LABELS[current.mode]} to ${OPERATING_MODE_LABELS[input.to]}: ${transition.summary}.`,
      detail: {
        from: current.mode,
        to: input.to,
        widens: transition.widens,
        reason: input.reason ?? null,
        until: input.until?.toISOString() ?? null,
      },
    });
    return next;
  }

  /* ------------------------------------------------------------ authority */

  /**
   * What authority is in force right now, and why it is not more.
   *
   * Read by the interface and by the operator loop. `blockedReason` is a sentence rather than a
   * code because its only consumer is a person asking why nothing is happening, and translating a
   * code back into that sentence in three different places is how the three come to disagree.
   */
  async authority(): Promise<ActiveAuthority> {
    const now = this.clock();
    const [state, charter, qualificationLevel] = await Promise.all([
      this.deps.state.get(),
      this.deps.charters.active(),
      this.deps.currentLevel(),
    ]);

    const blockedReason = !modeGrantsStandingAuthority(state.mode)
      ? `Jarvis is ${OPERATING_MODE_LABELS[state.mode].toLowerCase()}, so nothing runs on standing authority.`
      : !charter
        ? 'No charter is in force, so standing authority grants nothing.'
        : isCharterExpired(charter, now)
          ? `Charter version ${charter.version} expired on ${charter.content.expiresAt}.`
          : null;

    return {
      mode: state.mode,
      charter,
      qualificationLevel,
      standingAuthority: blockedReason === null,
      blockedReason,
    };
  }

  /* ------------------------------------------------------------- decision */

  /**
   * Decide whether a plan may proceed on standing authority, and record the decision.
   *
   * The decision itself is `authorize`, a pure function in the domain with no model anywhere near
   * it. This method's whole job is to assemble its inputs honestly — the mode as stored, the
   * charter as activated, the qualification rung as it is *now* — and to write down what came out.
   *
   * A charter in force but expired is passed through as `null` rather than as itself. `authorize`
   * checks expiry too, and would refuse it; passing null makes the recorded decision say "there
   * was no charter", which is the truthful description of what authorised the outcome.
   */
  async decide(
    request: AuthorizationRequest,
    options: { readonly record?: boolean } = {},
  ): Promise<{
    readonly decision: AuthorizationDecision;
    readonly stored: StoredAuthorizationDecision | null;
  }> {
    const now = this.clock();
    const [state, charter, qualificationLevel] = await Promise.all([
      this.deps.state.get(),
      this.deps.charters.active(),
      this.deps.currentLevel(),
    ]);

    const usable = charter && !isCharterExpired(charter, now) ? charter : null;
    const decision = authorize(request, {
      mode: state.mode,
      charter: usable
        ? { versionId: usable.id, digest: usable.digest, content: usable.content }
        : null,
      qualificationLevel,
      now,
    });

    if (options.record === false) return { decision, stored: null };

    const stored = await this.deps.decisions.record({
      missionId: request.missionId ?? null,
      decision,
      requested: request.capabilities,
      estimatedSpendUsd: request.estimatedSpendUsd ?? null,
    });

    await this.deps.audit.append({
      actor: 'charter',
      actorKind: 'system',
      action: `authorization.${decision.outcome}`,
      subjectKind: 'authorization_decision',
      subjectId: stored.id,
      missionId: request.missionId ?? null,
      outcome: decision.outcome === 'authorized' ? 'allowed' : 'refused',
      summary: decision.summary,
      detail: {
        mode: decision.mode,
        charterVersionId: decision.charterVersionId,
        charterDigest: decision.charterDigest,
        qualificationLevel: decision.qualificationLevel,
        capabilities: request.capabilities.map(
          (capability: CapabilityRequest) => capability.capability,
        ),
      },
    });

    return { decision, stored };
  }

  /**
   * Re-read a recorded decision and confirm it still authorises this mission.
   *
   * The approval path calls this rather than trusting an id it was handed. A decision id is just a
   * string until somebody looks it up, and "the caller passed a plausible uuid" is not a form of
   * authorisation. Four things are checked, and each has a way of being wrong that this catches:
   * the decision exists, it came out `authorized`, it was made for *this* mission, and the charter
   * it cites is still the one in force with the same digest.
   */
  async confirmDecision(
    decisionId: string,
    missionId: string,
  ): Promise<ConfirmedAuthorization> {
    const stored = await this.deps.decisions.findById(decisionId);
    if (!stored) throw new NotFoundError('Authorisation decision');
    if (stored.outcome !== 'authorized') {
      throw new ForbiddenError(
        `That decision came out "${stored.outcome}", so it authorises nothing.`,
        { decisionId, outcome: stored.outcome },
      );
    }
    if (stored.missionId !== missionId) {
      throw new ForbiddenError('That decision was made for a different mission.', {
        decisionId,
        expected: missionId,
        actual: stored.missionId,
      });
    }

    const charter = await this.deps.charters.active();
    if (!charter || charter.id !== stored.charterVersionId) {
      throw new ConflictError(
        'The charter changed after that decision was made. Ask again before acting on it.',
        { decisionId, decided: stored.charterVersionId, inForce: charter?.id ?? null },
      );
    }
    if (charter.digest !== stored.charterDigest) {
      throw new ConflictError(
        'The charter in force no longer matches the one that decision cited.',
        { decisionId, decided: stored.charterDigest, inForce: charter.digest },
      );
    }
    /*
     * Re-stated as non-null because the checks above proved it. The stored row types both as
     * nullable — a refused decision may cite no charter at all — and callers past this point need
     * the values, not another `?? throw`.
     */
    return { ...stored, charterVersionId: charter.id, charterDigest: charter.digest };
  }

  async decisionsForMission(missionId: string): Promise<readonly StoredAuthorizationDecision[]> {
    return this.deps.decisions.listForMission(missionId);
  }

  async recentDecisions(limit?: number): Promise<readonly StoredAuthorizationDecision[]> {
    return this.deps.decisions.recent(limit);
  }
}
