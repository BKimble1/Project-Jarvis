import type { RunUsage } from '@/domain/mission-run';
import {
  IDEA_EVALUATION_SYSTEM_PROMPT,
  REASONING_MAX_TURNS,
  REASONING_TIMEOUT_MS,
  buildIdeaEvaluationPrompt,
  parseIdeaEvaluation,
  type ReasoningAssignment,
  type ReasoningFailure,
  type ReasoningOutcomeInput,
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
    const failed = (
      failure: ReasoningFailure,
      detail: string | null,
      usage: RunUsage | null = null,
    ): ReasoningOutcomeInput => ({
      status: 'failed',
      requestId: assignment.requestId,
      failure,
      detail: detail ? boundText(redactSecrets(detail), 300) : null,
      usage: usageFor(usage, startedAt, this.deps.now?.() ?? new Date()),
    });

    const availability = await this.deps.runtime.availability().catch(() => null);
    if (!availability?.available) {
      return failed(
        'runtime_unavailable',
        availability?.detail ?? 'The Claude runtime could not be started.',
      );
    }

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
        /* Every tool, every time. A judgement needs nothing from the machine it runs on. */
        decide: async () => ({
          verdict: 'deny' as const,
          rule: 'P-REASON01',
          reason: 'A reasoning turn may not use tools.',
        }),
        signal: controller.signal,
      });

      let text = '';
      let usage: RunUsage | null = null;
      let error: string | null = null;

      const consume = (async (): Promise<'finished'> => {
        for await (const event of session.events) {
          if (event.type === 'message') text += `${event.text}\n`;
          else if (event.type === 'usage') usage = event.usage;
          else if (event.type === 'done') {
            if (event.result) text += `${event.result}\n`;
            usage = event.usage ?? usage;
          } else if (event.type === 'error') error = event.message;
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
       * Raced rather than simply awaited.
       *
       * A runtime that honours the abort signal ends its own stream and `settled` wins. One that
       * does not would leave this loop iterating forever, and a worker stuck inside a reasoning
       * turn stops answering everything else — so the deadline gets its own way out, and the
       * session is interrupted and closed on the way past. The abandoned iteration is left to
       * finish on its own; its lease expires and the question comes back to the queue.
       */
      const outcome = await Promise.race([settled, stopped]);
      if (outcome === 'stopped') {
        await session.interrupt().catch(() => undefined);
        await session.close().catch(() => undefined);
        return timedOut
          ? failed('timed_out', 'The model did not answer in time.', usage)
          : failed('interrupted', 'The worker stopped.', usage);
      }

      await session.close().catch(() => undefined);

      if (timedOut) return failed('timed_out', 'The model did not answer in time.', usage);
      if (signal?.aborted) return failed('interrupted', 'The worker stopped.', usage);
      if (error) return failed('model_error', error, usage);

      const evaluation = parseIdeaEvaluation(text);
      if (!evaluation) {
        return failed(
          'unreadable',
          'The model answered, but not in the shape Jarvis asked for.',
          usage,
        );
      }

      return {
        status: 'succeeded',
        requestId: assignment.requestId,
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
}

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
