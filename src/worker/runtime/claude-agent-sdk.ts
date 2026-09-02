import { boundText, redactSecrets } from '@/domain/redaction';
import type { RunUsage } from '@/domain/mission-run';
import {
  EventQueue,
  type AgentEvent,
  type AgentRuntime,
  type AgentSession,
  type AgentSessionRequest,
  type RuntimeAvailability,
} from './types';

/**
 * The Claude Agent SDK runtime.
 *
 * Two deliberate choices here.
 *
 * **The SDK is loaded through a dynamic import.** It is an optional dependency, so a worker
 * installed without it — or without an API key — reports "runtime unavailable" honestly instead
 * of crashing on startup. That is what makes "live execution stays visibly unavailable until
 * configured" a real behaviour rather than a note in the documentation.
 *
 * **The SDK's types are declared locally**, narrowly, and only for the parts Jarvis uses. The
 * alternative — importing its types — would make the whole application's type-check depend on an
 * optional package being installed. The shapes below match `@anthropic-ai/claude-agent-sdk`'s
 * `query()`, `Options`, `CanUseTool` and `SDKMessage`.
 */

const PACKAGE = '@anthropic-ai/claude-agent-sdk';

/* ------------------------------------------------- minimal SDK surface types */

interface SdkPermissionAllow {
  behavior: 'allow';
  updatedInput?: Record<string, unknown>;
}
interface SdkPermissionDeny {
  behavior: 'deny';
  message: string;
  interrupt?: boolean;
}
type SdkPermissionResult = SdkPermissionAllow | SdkPermissionDeny;

interface SdkContentBlock {
  type: string;
  text?: string;
  thinking?: string;
  name?: string;
  input?: Record<string, unknown>;
  content?: unknown;
  is_error?: boolean;
  tool_use_id?: string;
}

interface SdkMessage {
  type: string;
  subtype?: string;
  session_id?: string;
  result?: string;
  is_error?: boolean;
  total_cost_usd?: number;
  num_turns?: number;
  duration_ms?: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
  };
  message?: { content?: SdkContentBlock[] | string };
}

interface SdkQuery extends AsyncIterable<SdkMessage> {
  interrupt(): Promise<unknown>;
  close?: () => void;
}

interface SdkOptions {
  cwd?: string;
  model?: string;
  maxTurns?: number;
  resume?: string;
  permissionMode?: string;
  allowedTools?: string[];
  disallowedTools?: string[];
  abortController?: AbortController;
  env?: Record<string, string | undefined>;
  settingSources?: string[];
  systemPrompt?: string | { type: 'preset'; preset: 'claude_code'; append?: string };
  canUseTool?: (
    toolName: string,
    input: Record<string, unknown>,
    options: { signal: AbortSignal },
  ) => Promise<SdkPermissionResult>;
}

interface SdkModule {
  query(params: { prompt: string | AsyncIterable<unknown>; options?: SdkOptions }): SdkQuery;
}

/* -------------------------------------------------------------- the runtime */

export interface ClaudeAgentRuntimeOptions {
  readonly apiKey: string | null;
  readonly model: string | null;
  /** Overridable so tests can inject a module without the real package installed. */
  readonly load?: () => Promise<SdkModule>;
}

export class ClaudeAgentRuntime implements AgentRuntime {
  readonly name = 'claude-agent-sdk';
  private cached: SdkModule | null = null;

  constructor(private readonly options: ClaudeAgentRuntimeOptions) {}

  private async load(): Promise<SdkModule> {
    if (this.cached) return this.cached;
    if (this.options.load) {
      this.cached = await this.options.load();
      return this.cached;
    }
    /* Indirected through a variable so a bundler cannot make this a hard dependency. */
    const specifier = PACKAGE;
    const loaded = (await import(/* webpackIgnore: true */ specifier)) as SdkModule;
    this.cached = loaded;
    return loaded;
  }

  async availability(): Promise<RuntimeAvailability> {
    if (!this.options.apiKey) {
      return {
        available: false,
        version: null,
        detail: `ANTHROPIC_API_KEY is not set on this worker, so it cannot run a Claude session. Set it and restart the worker.`,
      };
    }
    try {
      await this.load();
      return {
        available: true,
        version: null,
        detail: 'The Claude Agent SDK is installed and a credential is configured.',
      };
    } catch (error) {
      return {
        available: false,
        version: null,
        detail: `${PACKAGE} could not be loaded (${describe(error)}). Install it with: npm install ${PACKAGE}`,
      };
    }
  }

  async start(request: AgentSessionRequest): Promise<AgentSession> {
    const sdk = await this.load();
    const queue = new EventQueue<AgentEvent>();
    const controller = new AbortController();
    request.signal.addEventListener('abort', () => controller.abort(), { once: true });

    /* Follow-up owner messages are delivered by pushing into this stream. */
    const inbox = new EventQueue<{ type: 'user'; message: { role: 'user'; content: string } }>();
    inbox.push({ type: 'user', message: { role: 'user', content: request.prompt } });

    const session = sdk.query({
      prompt: inbox,
      options: {
        cwd: request.workspaceRoot,
        maxTurns: request.maxTurns,
        abortController: controller,
        ...(request.model ? { model: request.model } : {}),
        ...(request.resumeSessionId ? { resume: request.resumeSessionId } : {}),
        /*
         * `default` keeps every tool call flowing through `canUseTool`, which is where Jarvis's
         * policy actually runs. `bypassPermissions` would hand the model the keys.
         */
        permissionMode: 'default',
        /*
         * No filesystem settings are loaded. A repository's `.claude/settings.json` is repository
         * content, and repository content does not get to configure the agent's permissions.
         */
        settingSources: [],
        disallowedTools: request.readOnly ? ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'] : [],
        systemPrompt: {
          type: 'preset',
          preset: 'claude_code',
          append: request.systemPrompt,
        },
        /* The worker's own credential. Never sent by the control plane, never in a prompt. */
        env: {
          ...process.env,
          ...(this.options.apiKey ? { ANTHROPIC_API_KEY: this.options.apiKey } : {}),
          CLAUDE_AGENT_SDK_CLIENT_APP: 'jarvis-worker',
        },
        canUseTool: async (toolName, input) => {
          const decision = await request.decide({ toolName, input });
          if (decision.verdict === 'allow') return { behavior: 'allow' };
          queue.push({ type: 'denied', toolName, reason: decision.reason });
          return { behavior: 'deny', message: decision.reason };
        },
      },
    });

    let sessionId: string | null = request.resumeSessionId;

    const pump = (async () => {
      try {
        for await (const message of session) {
          if (message.session_id && message.session_id !== sessionId) {
            sessionId = message.session_id;
            queue.push({ type: 'session', sessionId: message.session_id });
          }
          for (const event of translate(message)) queue.push(event);
        }
      } catch (error) {
        queue.push({
          type: 'error',
          message: redactSecrets(describe(error)),
          retryable: isRetryable(error),
        });
      } finally {
        inbox.finish();
        queue.finish();
      }
    })();

    return {
      events: queue,
      get sessionId() {
        return sessionId;
      },
      async send(text: string) {
        inbox.push({ type: 'user', message: { role: 'user', content: text } });
      },
      async interrupt() {
        await session.interrupt().catch(() => undefined);
      },
      async close() {
        controller.abort();
        inbox.finish();
        session.close?.();
        await pump.catch(() => undefined);
      },
    };
  }
}

/** SDK message → Jarvis event. Anything Jarvis has no use for is simply dropped. */
function translate(message: SdkMessage): readonly AgentEvent[] {
  const events: AgentEvent[] = [];

  if (message.type === 'assistant') {
    const content = message.message?.content;
    const blocks = Array.isArray(content) ? content : [];
    for (const block of blocks) {
      if (block.type === 'text' && block.text) {
        events.push({ type: 'message', text: boundText(redactSecrets(block.text), 2000) });
      } else if (block.type === 'thinking' && block.thinking) {
        /*
         * Summarised to a single opening line. Jarvis shows what the agent is *doing*, not a
         * transcript of its private reasoning.
         */
        const firstLine = block.thinking.split('\n').find((line) => line.trim().length > 0) ?? '';
        if (firstLine) {
          events.push({ type: 'summary', text: boundText(redactSecrets(firstLine), 300) });
        }
      } else if (block.type === 'tool_use' && block.name) {
        events.push({
          type: 'tool_use',
          toolName: block.name,
          summary: describeToolUse(block.name, block.input ?? {}),
          detail: block.input ?? {},
        });
      }
    }
  }

  if (message.type === 'user') {
    const content = message.message?.content;
    const blocks = Array.isArray(content) ? content : [];
    for (const block of blocks) {
      if (block.type !== 'tool_result') continue;
      events.push({
        type: 'tool_result',
        toolName: 'tool',
        summary: boundText(redactSecrets(stringifyResult(block.content)), 600),
        isError: block.is_error === true,
      });
    }
  }

  if (message.type === 'result') {
    const usage = extractUsage(message);
    if (message.is_error) {
      events.push({
        type: 'error',
        message: redactSecrets(message.result ?? 'The agent reported an error.'),
        retryable: false,
      });
    } else {
      events.push({
        type: 'done',
        result: boundText(redactSecrets(message.result ?? ''), 4000),
        usage,
      });
    }
  }

  return events;
}

function extractUsage(message: SdkMessage): RunUsage | null {
  if (!message.usage && message.total_cost_usd === undefined) return null;
  return {
    inputTokens: message.usage?.input_tokens ?? null,
    outputTokens: message.usage?.output_tokens ?? null,
    cacheReadTokens: message.usage?.cache_read_input_tokens ?? null,
    totalCostUsd: message.total_cost_usd ?? null,
    turns: message.num_turns ?? null,
    durationMs: message.duration_ms ?? null,
  };
}

function describeToolUse(toolName: string, input: Record<string, unknown>): string {
  const path = input.file_path ?? input.path ?? input.notebook_path;
  if (typeof path === 'string') return `${toolName} ${path}`;
  if (typeof input.command === 'string') {
    return `${toolName}: ${boundText(redactSecrets(input.command), 200)}`;
  }
  if (typeof input.pattern === 'string') return `${toolName} ${input.pattern}`;
  return toolName;
}

function stringifyResult(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((item) =>
        item && typeof item === 'object' && 'text' in item
          ? String((item as { text: unknown }).text)
          : '',
      )
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function isRetryable(error: unknown): boolean {
  const message = describe(error).toLowerCase();
  return (
    message.includes('overloaded') ||
    message.includes('rate limit') ||
    message.includes('timeout') ||
    message.includes('econnreset')
  );
}
