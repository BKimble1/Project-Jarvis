import type { IdeaEvaluation, Proposal } from '@/domain/proposal';

/**
 * Where proposals live between being offered and being agreed to.
 *
 * Every method here is written to be safe under repetition, because every caller above it can be
 * retried: a double-submitted form, a worker that restarted mid-request, an owner who said "go
 * ahead" twice because the first one looked like it did nothing.
 */
export interface ProposalRepository {
  /**
   * Record a proposal, or return the one this idea already has.
   *
   * Keyed on the fingerprint, so describing the same idea twice updates one row rather than
   * producing a second proposal the owner would have to tell apart. An already-accepted proposal
   * is returned untouched — re-describing an idea that has been built must not reopen it.
   */
  open(input: {
    readonly fingerprint: string;
    readonly title: string;
    readonly idea: string;
    readonly summary: string;
    readonly evaluation: IdeaEvaluation | null;
    readonly openQuestions: readonly string[];
    readonly recommendedV1: readonly string[];
    readonly assumptions: readonly string[];
    readonly now: Date;
  }): Promise<Proposal>;

  /**
   * Attach an evaluation to a proposal that is still open.
   *
   * Separate from `open` because the two happen at different moments now: the proposal is written
   * the instant the owner describes an idea, and the assessment arrives later, from the worker.
   * Conditional on `state = 'open'` so an answer that arrives after "go ahead" cannot rewrite the
   * record of what was agreed to.
   *
   * Returns null when nothing was updated — the proposal was accepted, superseded, or gone.
   */
  recordEvaluation(id: string, evaluation: IdeaEvaluation, now: Date): Promise<Proposal | null>;

  findById(id: string): Promise<Proposal | null>;

  /**
   * The proposal a bare "go ahead" refers to when the page did not say which.
   *
   * The most recently updated open one. Null when there is none — which the caller must treat as
   * "ask what to continue", never as "pick something".
   */
  latestOpen(): Promise<Proposal | null>;

  /**
   * Stamp what accepting produced, once.
   *
   * Conditional on the proposal still being open, so a second acceptance changes nothing and
   * returns the project and mission the first one created.
   */
  accept(
    id: string,
    outcome: {
      readonly projectId: string;
      readonly missionId: string | null;
      readonly repositoryFullName: string | null;
      readonly now: Date;
    },
  ): Promise<Proposal>;
}
