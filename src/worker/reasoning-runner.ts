import type { RunUsage } from '@/domain/mission-run';
import {
  IDEA_EVALUATION_SYSTEM_PROMPT,
  REASONING_MAX_TURNS,
  REASONING_REPLY_MAX_CHARS,
  REASONING_TIMEOUT_MS,
  buildIdeaEvaluationPrompt,
  parseIdeaEvaluation,
  type ReasoningAssignment,
  type ReasoningFailure,
  type ReasoningOutcomeInput,
  type ReasoningStage,
} from '@/domain/reasoning';
import { boundText, redactSecrets } from '@/domain/redaction';
import type { AgentRuntime } from './runtime/types';
import { prepareScratchWorkspace } from './workspace';

/**
 * One short thought, on the owner's own Claude subscription.
 *
 * This is the whole of the worker's side of dashboard reasoning: take a question, run one bounded
 * turn through the runtime that already holds the credential, read the answer, and report a
 * structured outcome. It is deliberately much smaller than the mission runner, because it does
 * much less — there is no repository, no branch, no plan, no write set and no verification.
 *
 * ## Why no tools
 *
 * `decide` denies everything, unconditionally. A question about whether an idea is worth building
 * has no business reading a file, running a command or fetching a URL, and the cheapest way to be
 * certain it does not is to make every tool call fail rather than to hope the prompt discourages
 * it. `readOnly` alone would not do: it disallows the editing tools and leaves the shell.
 *
 * ## Why a scratch directory
 *
 * Because the spawned process needs a working directory that exists, and because the policy's
 * containment root is derived from the same value. `prepareScratchWorkspace` makes one inside the
 * worker's own workspace root, path-checked, with nothing in it — no clone, no git, no repository
 * content of any kind for the model to reach even if a tool somehow ran.
 *
 * ## Why the failure cases are enumerated
 *
 * Because they need different things from the owner. "Your Claude runtime is not available" and
 * "the model answered with something I could not read" and "it took too long" send him to three
 * different places, and a single "it failed" would send him to none of them.
 */

export interface ReasoningRunnerDeps {
  readonly runtime: AgentRuntime;
  /** The worker's own workspace root. A scratch directory is made inside it and left empty. */
  readonly workspaceRoot: string;
  readonly timeoutMs?: number;
  readonly now?: () => Date;
  /**
   * Called as each stage is reached.
   *
   * The worker logs these. They are the diagnostic that tells "the subprocess never spoke" apart
   * from "it spoke and we did not stop" — a distinction that cost a live morning to learn and is
   * one line of output to keep. Stage names only: no prompt, no answer, no environment.
   */
  readonly onStage?: (stage: ReasoningStage) => void;
  /** How long `close()` is given before the turn is abandoned. Bounded so a wedged
   * subprocess cannot hold the reasoning loop. */
  readonly closeTimeoutMs?: number;
}

export class ReasoningRunner {
  constructor(private readonly deps: ReasoningRunnerDeps) {}

  /**
   * Answer one assignment.
   *
   * Never throws. Every path — including an unavailable runtime and an abort — produces a reported
   * outcome, because a question that fails silently leaves the owner watching a spinner that will
   * never resolve.
   */
  async run(assignment: ReasoningAssignment, signal?: AbortSignal): Promise<ReasoningOutcomeInput> {
    const startedAt = (this.deps.now?.() ?? new Date()).getTime();

    let stage = 'claimed' as ReasoningStage;
    const reached = (next: ReasoningStage): void => {
      stage = next;
      this.deps.onStage?.(next);
    };
    reached('claimed');

    const failed = (
      failure: ReasoningFailure,
      detail: string | null,
      usage: RunUsage | null = null,
    ): ReasoningOutcomeInput => ({
      status: 'failed',
      requestId: assignment.requestId,
      attempt: assignment.attempt,
      failure,
      detail: detail ? boundText(redactSecrets(detail), 300) : null,
      stage,
      usage: usageFor(usage, startedAt, this.deps.now?.() ?? new Date()),
    });

    const availability = await this.deps.runtime.availability().catch(() => null);
    if (!availability?.available) {
      return failed(
        'runtime_unavailable',
        availability?.detail ?? 'The Claude runtime could not be started.',
      );
    }
    reached('runtime_checked');

    /*
     * A timeout of our own, on top of whatever the runtime does. The mission path has a watchdog;
     * this one has a deadline, because a reasoning turn that hangs is a person waiting rather than
     * a background job running long.
     */
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      this.deps.timeoutMs ?? REASONING_TIMEOUT_MS,
    );
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });

    let timedOut = false;
    controller.signal.addEventListener(
      'abort',
      () => {
        timedOut = signal?.aborted !== true;
      },
      { once: true },
    );

    try {
      const workspace = await prepareScratchWorkspace(
        this.deps.workspaceRoot,
        assignment.requestId,
      );
      const session = await this.deps.runtime.start({
        workspaceRoot: workspace.repoPath,
        systemPrompt: IDEA_EVALUATION_SYSTEM_PROMPT,
        /* Not a coding turn. See the note on `systemPromptMode`. */
        systemPromptMode: 'replace',
        prompt: buildIdeaEvaluationPrompt(assignment.input),
        resumeSessionId: null,
        readOnly: true,
        maxTurns: REASONING_MAX_TURNS,
        model: null,
        /* The answer is parsed, not displayed. See `REASONING_REPLY_MAX_CHARS`. */
        resultMaxChars: REASONING_REPLY_MAX_CHARS,
        /* Every tool, every time. A judgement needs nothing from the machine it runs on. */
        decide: async () => ({
          verdict: 'deny' as const,
          rule: 'P-REASON01',
          reason: 'A reasoning turn may not use tools.',
        }),
        signal: controller.signal,
      });
      reached('session_started');

      /*
       * Two texts, deliberately not one.
       *
       * `result` is the runtime's final answer, kept whole. `streamed` is what came through the
       * `message` events, which are bounded for display and can arrive cut mid-sentence. They used
       * to be concatenated, and that is a second way to lose a good answer: the truncated copy
       * leaves an unterminated code fence, and everything after it reads as part of that block.
       * The result is tried first and the stream only as a fallback, so a runtime that never
       * produced a final result is still readable while a complete answer is never spoiled by an
       * abbreviated one.
       */
      let result = '';
      let streamed = '';
      let usage: RunUsage | null = null;
      let error: string | null = null;

      /*
       * Stop at the end of the turn, not at the end of the stream.
       *
       * This is the bug that made every live request time out while every scripted test passed.
       * The Claude Agent SDK enters streaming input/output mode when the prompt is an async
       * iterable — which is how the runtime drives it, so that an owner can send a follow-up into
       * a running mission — and in that mode the query stays open for more input. It does not end
       * after the result. The scripted runtime, having no such notion, finishes its queue when its
       * steps run out, so draining to completion worked there and deadlocked here: the model
       * answered, the `done` event arrived, and this loop kept waiting for a stream end that could
       * never come until the deadline fired and called it a timeout.
       *
       * `MissionRunner` has always returned out of its loop on `done`. This now does the same. The
       * session is closed afterwards, which ends the input stream and lets the runtime tear the
       * subprocess down — and, in doing so, collect the capacity reading it takes on the way out.
       */
      const consume = (async (): Promise<'finished'> => {
        for await (const event of session.events) {
          if (stage === 'session_started') reached('first_event');
          if (event.type === 'message') {
            streamed += `${event.text}\n`;
            reached('model_replied');
          } else if (event.type === 'usage') {
            usage = event.usage;
          } else if (event.type === 'done') {
            result = event.result;
            usage = event.usage ?? usage;
            reached('model_replied');
            break;
          } else if (event.type === 'error') {
            error = event.message;
            break;
          }
        }
        return 'finished';
      })();
      /* Attached now, so a rejection after the race below is handled rather than unhandled. */
      const settled = consume.catch(() => 'finished' as const);

      const stopped = new Promise<'stopped'>((resolve) => {
        if (controller.signal.aborted) resolve('stopped');
        else controller.signal.addEventListener('abort', () => resolve('stopped'), { once: true });
      });

      /*
       * Still raced, because breaking on `done` only helps when a `done` arrives. A runtime that
       * hangs before saying anything, or one that ignores the abort, must not wedge this loop —
       * so the deadline keeps its own way out and the session is interrupted on the way past.
       */
      const outcome = await Promise.race([settled, stopped]);
      if (outcome === 'stopped') {
        await session.interrupt().catch(() => undefined);
        await this.closeBounded(session);
        return timedOut
          ? failed(
              'timed_out',
              `The model did not answer in time — it got as far as ${stage}.`,
              usage,
            )
          : failed('interrupted', 'The worker stopped.', usage);
      }

      await this.closeBounded(session);

      if (timedOut) return failed('timed_out', 'The model did not answer in time.', usage);
      if (signal?.aborted) return failed('interrupted', 'The worker stopped.', usage);
      if (error) return failed('model_error', error, usage);

      const evaluation = parseIdeaEvaluation(result) ?? parseIdeaEvaluation(streamed);
      if (!evaluation) {
        return failed(
          'unreadable',
          'The model answered, but not in the shape Jarvis asked for.',
          usage,
        );
      }
      reached('parsed');

      return {
        status: 'succeeded',
        requestId: assignment.requestId,
        attempt: assignment.attempt,
        evaluation,
        usage: usageFor(usage, startedAt, this.deps.now?.() ?? new Date()),
      };
    } catch (cause) {
      if (timedOut) return failed('timed_out', 'The model did not answer in time.');
      if (signal?.aborted) return failed('interrupted', 'The worker stopped.');
      return failed('model_error', cause instanceof Error ? cause.message : String(cause));
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  /**
   * Close the session, but never wait on it forever.
   *
   * `close()` ends the input stream and waits for the runtime's own pump — which is where the
   * capacity reading is taken, so it is worth waiting for. But a subprocess that has stopped
   * responding would otherwise hold the reasoning loop open indefinitely, and a worker that cannot
   * answer the next question is a worse outcome than a missed capacity reading.
   */
  private async closeBounded(session: { close(): Promise<void> }): Promise<void> {
    const limit = this.deps.closeTimeoutMs ?? CLOSE_TIMEOUT_MS;
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      session.close().catch(() => undefined),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, limit);
      }),
    ]);
    if (timer) clearTimeout(timer);
  }
}

/** How long a session is given to shut down before the turn stops waiting for it. */
const CLOSE_TIMEOUT_MS = 10_000;

/**
 * What is reported back about the cost of a thought.
 *
 * Tokens when the runtime knew them, and always a wall-clock duration measured here rather than
 * taken from the model — the duration is a fact about the owner's wait, and it exists even when
 * the run failed before anything was counted. No dollar figure travels: on a subscription there
 * isn't one, and the mission path already refuses to invent a counterfactual API price.
 */
function usageFor(
  usage: RunUsage | null,
  startedAt: number,
  now: Date,
): { inputTokens: number | null; outputTokens: number | null; durationMs: number } {
  return {
    inputTokens: usage?.inputTokens ?? null,
    outputTokens: usage?.outputTokens ?? null,
    durationMs: Math.max(0, now.getTime() - startedAt),
  };
}
