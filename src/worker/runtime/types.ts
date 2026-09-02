import type { RunUsage } from '@/domain/mission-run';
import type { PolicyDecision } from '../policy';

/**
 * The agent runtime adapter.
 *
 * Mission logic never imports the Claude Agent SDK. It talks to this interface, so a later phase
 * can add another agent implementation without touching a line of mission or project code — and
 * so every automated test can run the real mission flow against a deterministic fake.
 *
 * The interface is deliberately small. Everything Jarvis needs from an agent is: start, resume,
 * send more input, receive a stream of structured events, and interrupt.
 */

export interface AgentSessionRequest {
  /** Absolute path the agent is confined to. */
  readonly workspaceRoot: string;
  readonly systemPrompt: string;
  readonly prompt: string;
  /** Continue a previous conversation rather than starting fresh. */
  readonly resumeSessionId: string | null;
  readonly readOnly: boolean;
  readonly maxTurns: number;
  readonly model: string | null;
  /**
   * Called for every tool the runtime would otherwise prompt about.
   *
   * Returning `ask` is what produces an owner-facing permission request; the runtime blocks on
   * that promise until the owner decides, or the run is interrupted.
   */
  readonly decide: (request: {
    toolName: string;
    input: Record<string, unknown>;
  }) => Promise<PolicyDecision>;
  readonly signal: AbortSignal;
}

export type AgentEvent =
  | { readonly type: 'session'; readonly sessionId: string }
  | { readonly type: 'message'; readonly text: string }
  /** A short, model-provided summary of its reasoning. Never raw hidden chain-of-thought. */
  | { readonly type: 'summary'; readonly text: string }
  | {
      readonly type: 'tool_use';
      readonly toolName: string;
      readonly summary: string;
      readonly detail: Record<string, unknown>;
    }
  | {
      readonly type: 'tool_result';
      readonly toolName: string;
      readonly summary: string;
      readonly isError: boolean;
    }
  | { readonly type: 'denied'; readonly toolName: string; readonly reason: string }
  | { readonly type: 'usage'; readonly usage: RunUsage }
  | { readonly type: 'done'; readonly result: string; readonly usage: RunUsage | null }
  | { readonly type: 'error'; readonly message: string; readonly retryable: boolean };

export interface AgentSession {
  readonly events: AsyncIterable<AgentEvent>;
  /** Deliver a follow-up instruction into the running conversation. */
  send(text: string): Promise<void>;
  /** Ask the agent to stop at the next safe boundary. */
  interrupt(): Promise<void>;
  /** Release the process and any transport. Safe to call twice. */
  close(): Promise<void>;
  readonly sessionId: string | null;
}

export interface AgentRuntime {
  readonly name: string;
  /** Whether this runtime can actually run right now, and why not if it cannot. */
  availability(): Promise<RuntimeAvailability>;
  start(request: AgentSessionRequest): Promise<AgentSession>;
}

export interface RuntimeAvailability {
  readonly available: boolean;
  readonly version: string | null;
  /** Owner-facing explanation, shown on the workers page when unavailable. */
  readonly detail: string;
}

/** A small async queue, so a callback-shaped SDK can be consumed as an async iterable. */
export class EventQueue<T> {
  private readonly buffer: T[] = [];
  private readonly waiting: ((value: IteratorResult<T>) => void)[] = [];
  private finished = false;

  push(value: T): void {
    if (this.finished) return;
    const waiter = this.waiting.shift();
    if (waiter) waiter({ value, done: false });
    else this.buffer.push(value);
  }

  finish(): void {
    if (this.finished) return;
    this.finished = true;
    for (const waiter of this.waiting.splice(0)) {
      waiter({ value: undefined as never, done: true });
    }
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    for (;;) {
      const buffered = this.buffer.shift();
      if (buffered !== undefined) {
        yield buffered;
        continue;
      }
      if (this.finished) return;
      const next = await new Promise<IteratorResult<T>>((resolve) => this.waiting.push(resolve));
      if (next.done) return;
      yield next.value;
    }
  }
}
