import type { IdeaEvaluation } from '@/domain/proposal';
import type {
  ReasoningAssignment,
  ReasoningFailure,
  ReasoningInput,
  ReasoningKind,
  ReasoningRequest,
  ReasoningStage,
} from '@/domain/reasoning';

/**
 * The store for questions put to the worker's model.
 *
 * Every method that changes state does so with a conditional update, because both ends of this can
 * be retried: the browser re-posts, the worker re-reports, a lease expires while a result is in
 * flight. The store is the only place that can make "exactly once" true, so it is where it lives.
 */
export interface ReasoningRepository {
  /**
   * Queue a question, or return the one already queued for it.
   *
   * Idempotent on `requestKey`. Asking the same question twice — a double submit, a retry, the
   * owner repeating himself because nothing appeared to happen — returns the existing row rather
   * than spending the subscription twice to answer it once.
   *
   * A request that already finished is *not* reopened: the caller gets the finished row back and
   * decides whether to show the answer or ask again deliberately.
   */
  enqueue(input: {
    readonly kind: ReasoningKind;
    readonly requestKey: string;
    readonly proposalId: string | null;
    readonly conversationId: string | null;
    readonly input: ReasoningInput;
    readonly now: Date;
  }): Promise<ReasoningRequest>;

  find(id: string): Promise<ReasoningRequest | null>;
  findByKey(requestKey: string): Promise<ReasoningRequest | null>;

  /**
   * Hand the oldest waiting question to one worker.
   *
   * Returns null when there is nothing to do. The claim is a single conditional UPDATE so two
   * workers polling in the same millisecond cannot both take it, and a row whose lease has expired
   * is claimable again — which is how a worker that died mid-question stops blocking the answer.
   */
  claim(input: {
    readonly workerId: string;
    readonly now: Date;
    readonly leaseMs: number;
    readonly maxAttempts: number;
  }): Promise<ReasoningAssignment | null>;

  /**
   * Record a successful answer.
   *
   * Conditional on the row still being leased by this worker, so a result reported after the lease
   * was reclaimed loses to whoever holds it now. Returns false when the write did not apply, which
   * the caller reports as an accepted-but-ignored result rather than as an error.
   */
  succeed(input: {
    readonly requestId: string;
    readonly workerId: string;
    /**
     * The attempt this answer belongs to.
     *
     * The fence. A lease-owner check alone does not catch a late report from the *same* worker
     * after its turn was abandoned and the question handed out again — it would still own the
     * lease. Requiring the attempt to match means the older answer loses and is told it lost.
     */
    readonly attempt: number;
    readonly evaluation: IdeaEvaluation;
    readonly usage: {
      readonly inputTokens: number | null;
      readonly outputTokens: number | null;
      readonly durationMs: number | null;
    } | null;
    readonly now: Date;
  }): Promise<boolean>;

  /**
   * Record a failed attempt.
   *
   * Below the attempt ceiling the row goes back to `queued` so another worker — or the same one
   * after a restart — can try. At the ceiling it becomes `failed`, which is what turns a silent
   * retry loop into a sentence the owner can read.
   */
  fail(input: {
    readonly requestId: string;
    readonly workerId: string;
    /** Fenced exactly as `succeed` is, and for the same reason. */
    readonly attempt: number;
    readonly failure: ReasoningFailure;
    readonly detail: string | null;
    /** How far the attempt got. Recorded so a failure says which stage it stopped at. */
    readonly stage: ReasoningStage | null;
    readonly maxAttempts: number;
    readonly now: Date;
  }): Promise<boolean>;

  /**
   * Put a failed question back in the queue because the owner asked again.
   *
   * Conditional on the row being `failed` and on the manual-retry ceiling, so a held-down button
   * cannot become an unbounded loop against a runtime that is genuinely broken. The attempt
   * counter resets — a deliberate retry deserves its own three tries — and `manual_retries`
   * increments, which is what bounds it.
   *
   * Returns null when nothing was requeued: already running, never failed, or out of retries.
   */
  requeue(input: {
    readonly requestId: string;
    readonly maxManualRetries: number;
    readonly now: Date;
  }): Promise<ReasoningRequest | null>;

  /**
   * Return leases that have run out to the queue.
   *
   * Called before a claim, so a worker that was killed mid-question does not hold the answer
   * hostage until somebody notices.
   */
  reclaimExpired(input: { readonly now: Date; readonly maxAttempts: number }): Promise<number>;

  /** How many questions are waiting or in flight. Used to say "queued behind one other". */
  countActive(): Promise<number>;
}
