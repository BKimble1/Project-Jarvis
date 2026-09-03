import {
  EventQueue,
  type AgentEvent,
  type AgentRuntime,
  type AgentSession,
  type AgentSessionRequest,
  type RuntimeAvailability,
} from './types';

/**
 * A deterministic runtime for tests.
 *
 * Every automated test that exercises a mission end to end runs against this. It is not a
 * simplified stand-in for the mission flow — it drives the *real* worker, the real policy, the
 * real git wrapper and the real control-plane API. Only the model is replaced.
 *
 * That distinction matters: it means the tests prove that a force push is refused by the code
 * that will refuse it in production, rather than by a mock that agreed to.
 */

export type ScriptedStep =
  | { readonly kind: 'message'; readonly text: string }
  | { readonly kind: 'summary'; readonly text: string }
  /** Runs through the real policy: `decide` is called exactly as the SDK would call it. */
  | {
      readonly kind: 'tool';
      readonly toolName: string;
      readonly input: Record<string, unknown>;
      /** Applied to the workspace when the policy allows it. */
      readonly effect?: (workspaceRoot: string) => Promise<void>;
    }
  | { readonly kind: 'error'; readonly message: string; readonly retryable?: boolean }
  | { readonly kind: 'wait_for_message' }
  | { readonly kind: 'done'; readonly result: string };

export interface ScriptedRuntimeOptions {
  readonly steps: readonly ScriptedStep[];
  /**
   * Steps chosen per session, when one script cannot serve every role.
   *
   * A multi-agent mission starts several sessions with different jobs: a builder edits a file, a
   * reviewer returns a JSON verdict. Returning `null` falls back to `steps`, so the single-script
   * case is unchanged and every existing test keeps working.
   */
  readonly stepsFor?: (request: AgentSessionRequest) => readonly ScriptedStep[] | null;
  readonly sessionId?: string;
  readonly available?: boolean;
  readonly unavailableDetail?: string;
  /** Called with each follow-up message the owner sends, so tests can assert delivery. */
  readonly onMessage?: (text: string) => void;
}

export class ScriptedRuntime implements AgentRuntime {
  readonly name = 'scripted';
  /** Every prompt this runtime was started with, so tests can assert what the agent was told. */
  readonly prompts: { system: string; user: string }[] = [];

  constructor(private readonly options: ScriptedRuntimeOptions) {}

  async availability(): Promise<RuntimeAvailability> {
    return this.options.available === false
      ? {
          available: false,
          version: null,
          detail: this.options.unavailableDetail ?? 'Scripted runtime is disabled for this test.',
        }
      : { available: true, version: 'test', detail: 'Scripted runtime.' };
  }

  async start(request: AgentSessionRequest): Promise<AgentSession> {
    const options = this.options;
    this.prompts.push({ system: request.systemPrompt, user: request.prompt });

    const queue = new EventQueue<AgentEvent>();
    const sessionId = this.options.sessionId ?? 'scripted-session';
    let interrupted = false;
    let resolveMessage: ((text: string) => void) | null = null;

    const steps = this.options.stepsFor?.(request) ?? this.options.steps;

    const run = async () => {
      queue.push({ type: 'session', sessionId });
      for (const step of steps) {
        if (interrupted || request.signal.aborted) break;

        switch (step.kind) {
          case 'message':
            queue.push({ type: 'message', text: step.text });
            break;

          case 'summary':
            queue.push({ type: 'summary', text: step.text });
            break;

          case 'tool': {
            const decision = await request.decide({
              toolName: step.toolName,
              input: step.input,
            });
            if (decision.verdict !== 'allow') {
              queue.push({
                type: 'denied',
                toolName: step.toolName,
                reason: decision.reason,
              });
              break;
            }
            queue.push({
              type: 'tool_use',
              toolName: step.toolName,
              summary:
                `${step.toolName} ${String(step.input.file_path ?? step.input.command ?? '')}`.trim(),
              detail: step.input,
            });
            await step.effect?.(request.workspaceRoot);
            queue.push({
              type: 'tool_result',
              toolName: step.toolName,
              summary: 'ok',
              isError: false,
            });
            break;
          }

          case 'wait_for_message':
            await new Promise<string>((resolve) => {
              resolveMessage = resolve;
            });
            break;

          case 'error':
            queue.push({
              type: 'error',
              message: step.message,
              retryable: step.retryable ?? false,
            });
            break;

          case 'done':
            queue.push({
              type: 'done',
              result: step.result,
              usage: {
                inputTokens: 1200,
                outputTokens: 340,
                cacheReadTokens: 0,
                totalCostUsd: 0.0123,
                turns: 3,
                durationMs: 4200,
              },
            });
            break;
        }
      }
      queue.finish();
    };

    const finished = run();

    return {
      events: queue,
      sessionId,
      async send(text: string) {
        options.onMessage?.(text);
        resolveMessage?.(text);
        resolveMessage = null;
      },
      async interrupt() {
        interrupted = true;
        resolveMessage?.('');
        resolveMessage = null;
      },
      async close() {
        interrupted = true;
        resolveMessage?.('');
        resolveMessage = null;
        queue.finish();
        await finished.catch(() => undefined);
      },
    };
  }
}
