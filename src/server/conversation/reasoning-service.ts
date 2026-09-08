import type { CapacityDecision } from '@/domain/claude-capacity';
import type { IdeaEvaluation } from '@/domain/proposal';
import {
  REASONING_MAX_ATTEMPTS,
  REASONING_MAX_MANUAL_RETRIES,
  REASONING_STAGE_LABELS,
  ideaEvaluationInput,
  reasoningRequestKey,
  type ReasoningFailure,
  type ReasoningOutcomeInput,
  type ReasoningRequest,
  type ReasoningStage,
} from '@/domain/reasoning';
import { deriveWorkerHealth } from '@/domain/worker';
import type { AuditRepository, UsageRepository } from '@/server/repositories/accounting-types';
import type { WorkerRepository } from '@/server/repositories/mission-types';
import type { ProposalRepository } from '@/server/repositories/proposal-types';
import type { ReasoningRepository } from '@/server/repositories/reasoning-types';

/**
 * Where the dashboard's thinking happens — which is to say, not here.
 *
 * This service queues questions and reads answers. The model runs on the worker, on Blake's own
 * Claude subscription, because that is where his model access is and because the control plane
 * serves a browser and must never hold a model credential. Nothing in this file has a field for
 * one.
 *
 * ## Why "thinking" is a state and not a promise
 *
 * The answer arrives from another process, seconds later, and the owner may refresh the page,
 * close the tab, or ask from his phone in the meantime. So the conversation returns immediately
 * with a state, and the state is read back from a row. That also means a restart of either side
 * loses nothing: the question is still queued and the next poll picks it up.
 *
 * ## Why blocked states are enumerated
 *
 * "No worker is running" and "your five-hour window is full" and "the model answered with
 * something unreadable" need three different things from Blake — start the worker, wait, or tell
 * somebody. A single "it did not work" sends him to none of them, and a fallback paragraph that
 * *looks* like an assessment would be worse than all four.
 */

export const REASONING_BLOCKS = [
  /** Nothing is connected that could run a model. */
  'no_worker',
  /** A worker is connected but its Claude runtime is not usable. */
  'runtime_unavailable',
  /** The governor is holding model capacity back. */
  'capacity_exhausted',
  /** It was tried and it did not work, up to the attempt ceiling. */
  'failed',
] as const;
export type ReasoningBlock = (typeof REASONING_BLOCKS)[number];

export type ThinkingState =
  | {
      readonly state: 'thinking';
      readonly requestId: string;
      readonly since: string;
      /** What is happening, in the words the owner reads while he waits. */
      readonly detail: string;
    }
  | {
      readonly state: 'ready';
      readonly requestId: string;
      readonly evaluation: IdeaEvaluation;
    }
  | {
      readonly state: 'blocked';
      readonly requestId: string;
      readonly reason: ReasoningBlock;
      readonly detail: string;
      /** True while the question is still queued, so saying "it will run when…" is honest. */
      readonly retryable: boolean;
      /** True when asking again would do something. False once the retry ceiling is reached. */
      readonly canRetry: boolean;
    };

export interface ReasoningServiceDeps {
  readonly reasoning: ReasoningRepository;
  readonly proposals: ProposalRepository;
  readonly workers: WorkerRepository;
  readonly capacity: () => Promise<CapacityDecision>;
  /** The trail. A model turn Blake paid for should be findable afterwards. */
  readonly audit: AuditRepository;
  /**
   * The spend ledger.
   *
   * A subscription turn has no dollar figure — Claude Code's own is a counterfactual API price,
   * which the mission path already refuses to record — so what lands here is tokens, duration and
   * `costBasis: 'unknown'`. That is deliberately not zero: zero is a claim that it was free.
   */
  readonly usage: UsageRepository;
  readonly clock?: () => Date;
}

export class ReasoningService {
  constructor(private readonly deps: ReasoningServiceDeps) {}

  private now(): Date {
    return this.deps.clock?.() ?? new Date();
  }

  /**
   * Ask the worker what it makes of an idea.
   *
   * Idempotent on the proposal: describing the same idea twice, a double-submitted form, or a
   * retried request all land on one row and cost one answer. A proposal that already has an
   * evaluation is returned as `ready` without asking again — the owner can see it, and spending
   * his subscription to re-derive something he is already looking at would be rude.
   */
  async requestIdeaEvaluation(input: {
    readonly proposalId: string;
    readonly conversationId: string | null;
    readonly idea: string;
    readonly title: string;
    readonly existing: IdeaEvaluation | null;
  }): Promise<ThinkingState> {
    const key = reasoningRequestKey('idea_evaluation', input.proposalId);

    /*
     * An evaluation only counts as an answer when a model produced it.
     *
     * Rows written before the worker path existed carry `basis: 'not_assessed'` — the old "no model
     * is configured here" placeholder. Treating one as ready is what left a live QuickPick showing
     * that sentence weeks later: the proposal had an evaluation, so nothing was ever asked. It was
     * never a judgement, so it is not one now, and the question goes to the worker.
     */
    if (input.existing?.basis === 'reasoned') {
      const already = await this.deps.reasoning.findByKey(key);
      return {
        state: 'ready',
        requestId: already?.id ?? key,
        evaluation: input.existing,
      };
    }

    const request = await this.deps.reasoning.enqueue({
      kind: 'idea_evaluation',
      requestKey: key,
      proposalId: input.proposalId,
      conversationId: input.conversationId,
      input: ideaEvaluationInput({ idea: input.idea, title: input.title }),
      now: this.now(),
    });

    const state = await this.describe(request);
    /*
     * Audited at the moment of asking, and with the state it was asked in. "He asked and nothing
     * was connected" is the entry that explains a quiet morning, and it is only available here —
     * by the time the worker starts, the condition has gone.
     */
    await this.deps.audit
      .append({
        actor: 'owner',
        actorKind: 'owner',
        action: 'reasoning.requested',
        subjectKind: 'reasoning_request',
        subjectId: request.id,
        outcome: state.state === 'blocked' ? 'refused' : 'allowed',
        rule: state.state === 'blocked' ? state.reason : null,
        summary: `Asked the worker to judge "${input.title}".`,
        detail: { kind: request.kind, state: state.state },
      })
      .catch(() => undefined);

    return state;
  }

  /** Read where a question has got to. Returns null when the id is not one of ours. */
  async statusFor(requestId: string): Promise<ThinkingState | null> {
    const request = await this.deps.reasoning.find(requestId);
    return request ? this.describe(request) : null;
  }

  /**
   * Apply a worker's answer.
   *
   * The evaluation is written onto the proposal as well as onto the request, so the next thing to
   * read the proposal — a page load, a "go ahead", a briefing — sees it without having to know
   * that a queue exists. `recordEvaluation` refuses a proposal that has already been accepted, so
   * a late answer cannot rewrite the record of what was agreed to.
   */
  async apply(workerId: string, outcome: ReasoningOutcomeInput): Promise<{ applied: boolean }> {
    const now = this.now();

    if (outcome.status === 'failed') {
      const applied = await this.deps.reasoning.fail({
        requestId: outcome.requestId,
        workerId,
        attempt: outcome.attempt,
        failure: outcome.failure,
        detail: outcome.detail ?? null,
        stage: outcome.stage ?? null,
        maxAttempts: REASONING_MAX_ATTEMPTS,
        now,
      });
      if (applied) {
        await this.recordSpend(outcome.requestId, workerId, outcome.usage ?? null, true, now);
        await this.deps.audit
          .append({
            actor: workerId,
            actorKind: 'worker',
            action: 'reasoning.failed',
            subjectKind: 'reasoning_request',
            subjectId: outcome.requestId,
            outcome: 'failed',
            rule: outcome.failure,
            summary: `The worker could not answer: ${outcome.failure}.`,
            detail: { failure: outcome.failure },
          })
          .catch(() => undefined);
      }
      return { applied };
    }

    const applied = await this.deps.reasoning.succeed({
      requestId: outcome.requestId,
      workerId,
      attempt: outcome.attempt,
      evaluation: outcome.evaluation,
      usage: outcome.usage
        ? {
            inputTokens: outcome.usage.inputTokens ?? null,
            outputTokens: outcome.usage.outputTokens ?? null,
            durationMs: outcome.usage.durationMs ?? null,
          }
        : null,
      now,
    });
    if (!applied) return { applied: false };

    const request = await this.deps.reasoning.find(outcome.requestId);
    if (request?.proposalId) {
      await this.deps.proposals.recordEvaluation(request.proposalId, outcome.evaluation, now);
    }

    await this.recordSpend(outcome.requestId, workerId, outcome.usage ?? null, false, now);
    await this.deps.audit
      .append({
        actor: workerId,
        actorKind: 'worker',
        action: 'reasoning.answered',
        subjectKind: 'reasoning_request',
        subjectId: outcome.requestId,
        outcome: 'allowed',
        summary: 'The worker answered a reasoning request.',
        detail: {
          kind: request?.kind ?? 'idea_evaluation',
          /* Counts, never content: the evaluation itself lives on the request and the proposal. */
          questions: outcome.evaluation.questions.length,
          smallestV1: outcome.evaluation.smallestV1.length,
        },
      })
      .catch(() => undefined);

    return { applied: true };
  }

  /**
   * Put a reasoning turn in the same ledger as everything else that spends the subscription.
   *
   * Keyed per attempt, so a replayed report counts once. `costBasis: 'unknown'` rather than a
   * figure: a subscription turn has no price, and recording zero would say it was free — which is
   * the one thing a spend ledger must never imply.
   */
  private async recordSpend(
    requestId: string,
    workerId: string,
    usage: {
      inputTokens?: number | null;
      outputTokens?: number | null;
      durationMs?: number | null;
    } | null,
    failed: boolean,
    now: Date,
  ): Promise<void> {
    const request = await this.deps.reasoning.find(requestId);
    await this.deps.usage
      .record({
        kind: 'reasoning',
        providerName: 'claude-code',
        modelName: null,
        inputTokens: usage?.inputTokens ?? null,
        outputTokens: usage?.outputTokens ?? null,
        costBasis: 'unknown',
        durationMs: usage?.durationMs ?? null,
        failed,
        workerId,
        attempt: request?.attempt ?? null,
        occurredAt: now,
        idempotencyKey: `reasoning:${requestId}:${request?.attempt ?? 0}`,
      })
      .catch(() => null);
  }

  /**
   * Ask again, because the owner said so.
   *
   * Only a request that has actually failed can be retried, and only while there are manual
   * retries left — so a held-down button costs nothing and a genuinely broken runtime still ends
   * in a sentence rather than a loop. The proposal is untouched: the same question, on the same
   * row, with its attempts reset.
   *
   * Returns the new state, or null when there was nothing to retry.
   */
  async retry(requestId: string): Promise<ThinkingState | null> {
    const requeued = await this.deps.reasoning.requeue({
      requestId,
      maxManualRetries: REASONING_MAX_MANUAL_RETRIES,
      now: this.now(),
    });
    if (!requeued) return null;

    await this.deps.audit
      .append({
        actor: 'owner',
        actorKind: 'owner',
        action: 'reasoning.requested',
        subjectKind: 'reasoning_request',
        subjectId: requeued.id,
        outcome: 'allowed',
        rule: 'manual_retry',
        summary: 'Asked the worker to try the question again.',
        detail: { manualRetries: requeued.manualRetries },
      })
      .catch(() => undefined);

    return this.describe(requeued);
  }

  /* ---------------------------------------------------------------- reading */

  private async describe(request: ReasoningRequest): Promise<ThinkingState> {
    if (request.state === 'succeeded' && request.result) {
      return { state: 'ready', requestId: request.id, evaluation: request.result };
    }

    if (request.state === 'failed' || request.state === 'abandoned') {
      return {
        state: 'blocked',
        requestId: request.id,
        reason: 'failed',
        detail: failureSentence(request.failure, request.failureDetail, request.stage),
        retryable: false,
        canRetry:
          request.state === 'failed' && request.manualRetries < REASONING_MAX_MANUAL_RETRIES,
      };
    }

    /*
     * Still queued or running. Whether that is "any moment now" or "not until something changes"
     * depends on what is out there, so the answer is assembled from the fleet and the governor
     * rather than from the row — the row only knows that nobody has answered yet.
     */
    const reach = await this.reachability();
    if (reach) {
      /* Still queued, so waiting is the retry. Pressing a button would change nothing. */
      return { ...reach, requestId: request.id, canRetry: false };
    }

    return {
      state: 'thinking',
      requestId: request.id,
      since: request.createdAt,
      detail:
        request.state === 'running'
          ? 'Jarvis is thinking. Your worker is running this on your Claude subscription.'
          : 'Jarvis is thinking. The question is queued for your worker.',
    };
  }

  /**
   * Why the question cannot be answered right now, if it cannot.
   *
   * Null means there is nothing standing in the way, which is not the same as "an answer is
   * imminent" — it means the honest thing to say is "thinking".
   */
  private async reachability(): Promise<Omit<
    ThinkingState & { state: 'blocked' },
    'requestId' | 'canRetry'
  > | null> {
    const now = this.now();
    const workers = await this.deps.workers.list();
    const live = workers
      .map((worker) => deriveWorkerHealth(worker, now))
      .filter(
        (health) =>
          health.effectiveStatus !== 'revoked' &&
          health.effectiveStatus !== 'disconnected' &&
          health.effectiveStatus !== 'registered',
      );

    if (live.length === 0) {
      return {
        state: 'blocked',
        reason: 'no_worker',
        detail:
          'No worker is connected, and the worker is where your Claude subscription lives — so there is nothing here that can think about this yet. Start it with `npm run jarvis:live` and the question will be answered without you asking again.',
        retryable: true,
      };
    }

    if (!live.some((health) => health.worker.runtimeAvailable)) {
      const detail = live.find((health) => health.worker.runtimeDetail)?.worker.runtimeDetail;
      return {
        state: 'blocked',
        reason: 'runtime_unavailable',
        detail: `Your worker is connected but its Claude runtime is not usable, so it cannot think about this yet.${
          detail ? ` It reports: ${detail}` : ''
        } The question stays queued.`,
        retryable: true,
      };
    }

    const capacity = await this.deps.capacity();
    if (!capacity.mayStartNewWork) {
      return {
        state: 'blocked',
        reason: 'capacity_exhausted',
        detail: `Jarvis is not spending Claude capacity right now. ${capacity.reason} The question stays queued and will be answered when there is room.`,
        retryable: true,
      };
    }

    return null;
  }
}

/**
 * One sentence per failure, because each one needs a different thing from the owner.
 *
 * The stage is appended when there is one, because "it timed out before the session started" and
 * "it timed out after the model answered" are different faults. The detail is dropped when it is
 * already the sentence being said — the live report read "The model did not answer in time, so
 * nothing has judged this. It reported: The model did not answer in time.", which is one fact
 * charged twice.
 */
function failureSentence(
  failure: ReasoningFailure | null,
  detail: string | null,
  stage: ReasoningStage | null = null,
): string {
  const head = headline(failure);
  const useful = detail && !head.toLowerCase().includes(detail.toLowerCase().replace(/[.]$/, ''));
  const tail = useful ? ` It reported: ${detail}` : '';
  const where = stage ? ` It got as far as: ${REASONING_STAGE_LABELS[stage]}.` : '';
  return `${head}${where}${tail}`;
}

function headline(failure: ReasoningFailure | null): string {
  switch (failure) {
    case 'runtime_unavailable':
      return 'Your worker could not start its Claude runtime, so nothing has judged this.';
    case 'timed_out':
      return 'The model did not answer in time, so nothing has judged this.';
    case 'unreadable':
      return 'The model answered, but not in a shape Jarvis could read — so it has not judged this rather than guessing at what was meant.';
    case 'model_error':
      return 'The model could not answer, so nothing has judged this.';
    case 'interrupted':
      return 'The worker stopped before it answered, so nothing has judged this.';
    default:
      return 'Nothing has judged this.';
  }
}
