import { boundText, redactSecrets } from '@/domain/redaction';
import {
  resolveClaudeAuth,
  type ClaudeAuthObservation,
  type ClaudeAuthVerdict,
} from '@/domain/claude-auth';
import { withoutWorkerSecrets } from '../child-env';
import { observeClaudeAuth } from '../claude-auth-probe';
import {
  buildCapacityReport,
  type SdkAccountInfo,
  type SdkContextUsage,
  type SdkRateLimitInfo,
  type SdkUsageResponse,
} from '../claude-telemetry';
import type { WorkerCapacityInput } from '@/domain/worker-protocol';
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
  /*
   * Telemetry rides along with ordinary messages rather than arriving on its own channel:
   * `context_usage` is a sibling of `message` on an assistant turn, and a rate-limit warning is a
   * message of its own type. Both are declared optional because both are absent on most messages
   * and on any Claude Code older than the one that introduced them.
   */
  context_usage?: SdkContextUsage;
  rate_limit_info?: SdkRateLimitInfo;
}

interface SdkQuery extends AsyncIterable<SdkMessage> {
  interrupt(): Promise<unknown>;
  close?: () => void;
  /**
   * Which account is behind this session. Stable, and cheap.
   */
  accountInfo?: () => Promise<SdkAccountInfo>;
  /**
   * Plan rate-limit utilisation.
   *
   * Optional, and the name is the SDK's own: it is explicitly experimental and explicitly says not
   * to rely on it. Jarvis therefore feature-detects it rather than calling it, treats a throw as
   * "unknown" rather than as an error, and keeps working without it — every window simply stays
   * unknown, which the governor already knows how to be careful about.
   */
  usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET?: () => Promise<SdkUsageResponse>;
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

/**
 * Named so a wrong figure can be traced to a wrong reader.
 *
 * The value is stored beside every reading and shown next to it, which matters more than it looks:
 * the usage call is experimental, and when Anthropic changes it the first symptom will be a number
 * that is subtly wrong rather than an error. A figure that says where it came from can be checked
 * against that interface; one that does not can only be believed or ignored.
 */
const CAPACITY_SOURCE = 'claude-agent-sdk usage + rate_limit_event';

/* -------------------------------------------------------------- the runtime */

export interface ClaudeAgentRuntimeOptions {
  /**
   * The API key, or null.
   *
   * Null is the normal case now: in subscription mode the SDK inherits the Claude Code login from
   * the operating-system user running the worker, and passing a key would override it. The config
   * nulls this out unless key billing was deliberately chosen, so "null" here means "do not put a
   * key in the child environment" rather than "no credential exists".
   */
  readonly apiKey: string | null;
  /**
   * A subscription token for the agent session, or null.
   *
   * Null in the ordinary case, where the credential is the Claude Code login belonging to the
   * operating-system user running this worker and nothing needs to be passed at all.
   */
  readonly oauthToken: string | null;
  readonly authMode: 'subscription' | 'api_key';
  /** Whether ANTHROPIC_API_KEY exists in the worker's environment. Never its value. */
  readonly apiKeyPresent: boolean;
  readonly model: string | null;
  /** Overridable so tests can inject a module without the real package installed. */
  readonly load?: () => Promise<SdkModule>;
  /** Overridable so a test can drive every authentication branch without a Claude installation. */
  readonly observeAuth?: () => Promise<ClaudeAuthObservation | null>;
}

export class ClaudeAgentRuntime implements AgentRuntime {
  readonly name = 'claude-agent-sdk';
  private cached: SdkModule | null = null;
  private lastAuth: ClaudeAuthVerdict | null = null;
  /**
   * The newest capacity reading this worker has managed to take, kept between sessions.
   *
   * Held here rather than recomputed per heartbeat because capacity can only be read from a live
   * Claude session, and there usually is not one. Keeping the last reading is what lets a worker
   * report something true between missions; the control plane ages it into staleness on its own
   * timestamp, so holding it can make a figure old but never makes it wrong.
   */
  private lastCapacity: WorkerCapacityInput | null = null;

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

  /**
   * Whether this worker can really run a Claude session, and on whose account.
   *
   * Two questions, asked in this order and not merged. **Which credential is in force** comes
   * first, because a worker that can technically run but would bill an account the owner did not
   * choose should not run at all — and answering "is the package installed" first would report an
   * encouraging `available: true` on exactly that worker. **Is the SDK loadable** comes second,
   * because it is the cheap mechanical check and there is no point asking it about a worker that
   * is not allowed to proceed anyway.
   *
   * The verdict's own sentence is used as the detail. It reaches the workers page and the
   * heartbeat, so an owner sees the actual reason and the actual remedy rather than a generic
   * "runtime unavailable".
   */
  async availability(): Promise<RuntimeAvailability> {
    const verdict = resolveClaudeAuth({
      configured: this.options.authMode,
      apiKeyPresent: this.options.apiKeyPresent,
      observation: this.options.authMode === 'subscription' ? await this.observeAuth() : null,
    });
    this.lastAuth = verdict;

    if (!verdict.usable) {
      return {
        available: false,
        version: null,
        detail: verdict.reason + (verdict.remedy ? ` ${verdict.remedy}` : ''),
      };
    }

    try {
      await this.load();
      return { available: true, version: null, detail: verdict.reason };
    } catch (error) {
      return {
        available: false,
        version: null,
        detail: `${PACKAGE} could not be loaded (${describe(error)}). Install it with: npm install ${PACKAGE}`,
      };
    }
  }

  /**
   * The most recent authentication verdict, for the heartbeat to report.
   *
   * Cached rather than re-probed on demand: the probe spawns a process, the heartbeat runs on a
   * timer, and asking twice per cycle would double the cost of a question whose answer changes
   * only when somebody signs in or out.
   */
  auth(): ClaudeAuthVerdict | null {
    return this.lastAuth;
  }

  /**
   * The newest capacity reading, or null if this worker has never managed to take one.
   *
   * Null is a real answer and the heartbeat sends it as an absent block, which the control plane
   * reads as "nothing new" and leaves the stored reading alone. It never means zero.
   */
  capacity(): WorkerCapacityInput | null {
    return this.lastCapacity;
  }

  /**
   * Ask a live session what the account's capacity looks like, and remember the answer.
   *
   * Everything here is best-effort by design. The usage call is experimental and may be absent or
   * may throw; the account call may be absent on an older Claude Code. A failure means this
   * reading did not happen — the previous one stays, and the worker carries on running the
   * mission, because a governor being unable to see is not a reason to stop the work in flight.
   */
  private async collectCapacity(
    session: SdkQuery,
    observed: { rateLimit: SdkRateLimitInfo | null; context: SdkContextUsage | null },
  ): Promise<void> {
    const usage = await session
      .usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET?.()
      .catch(() => null);
    const account = await session.accountInfo?.().catch(() => null);

    const report = buildCapacityReport(
      {
        usage: usage ?? null,
        account: account ?? null,
        rateLimit: observed.rateLimit,
        context: observed.context,
      },
      {
        configuredAuthMode: this.options.authMode,
        now: new Date(),
        source: CAPACITY_SOURCE,
      },
    );
    if (report) this.lastCapacity = report;
  }

  /**
   * Who pays for this session's tokens, as far as this worker can tell.
   *
   * The verdict is the better answer because it reflects what is actually in force rather than
   * what was asked for, but it only exists once availability has been checked. Falling back to the
   * configured mode is safe: subscription is the default, and treating work as subscription-funded
   * when it might be is the direction that withholds a dollar figure rather than inventing one.
   */
  private billing(): 'subscription' | 'api' | 'unknown' {
    return this.lastAuth?.bills ?? (this.options.authMode === 'api_key' ? 'api' : 'subscription');
  }

  private async observeAuth(): Promise<ClaudeAuthObservation | null> {
    if (this.options.observeAuth) return this.options.observeAuth();
    return observeClaudeAuth();
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
        /*
         * Appending to Claude Code's own preset by default, replacing it only when the caller says
         * so. A repository session wants the preset; a reasoning turn that never touches a file
         * does not, and inheriting "you are a coding assistant" is how a question about whether an
         * idea is worth building comes back as an implementation plan.
         */
        systemPrompt:
          request.systemPromptMode === 'replace'
            ? request.systemPrompt
            : {
                type: 'preset',
                preset: 'claude_code',
                append: request.systemPrompt,
              },
        /*
         * The agent inherits an environment with every credential removed, and then at most one
         * put back: the model credential it cannot work without.
         *
         * At most one, and never both. The config nulls whichever credential the configured mode
         * did not ask for, so an `ANTHROPIC_API_KEY` here means key billing was deliberately
         * chosen — a key silently outranks a subscription login, and that is precisely the
         * confusion this whole path exists to prevent.
         *
         * Usually neither is set, and that is the healthy subscription case rather than a failure:
         * the SDK spawns Claude Code, which reads the login already stored for the operating-system
         * user running this worker. `CLAUDE_CODE_OAUTH_TOKEN` is for the headless machine that has
         * no such login to read.
         *
         * The delivery token in particular must not be here. The agent has Bash, and nothing in
         * the tool policy blocks `env` or `printenv` — so before this filter existed, the
         * credential that the four-method delivery client, the push guard and the CI separation
         * are all built on was one shell command away from the model. See `child-env.ts`.
         */
        env: {
          ...withoutWorkerSecrets(),
          ...(this.options.apiKey ? { ANTHROPIC_API_KEY: this.options.apiKey } : {}),
          ...(this.options.oauthToken ? { CLAUDE_CODE_OAUTH_TOKEN: this.options.oauthToken } : {}),
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

    /*
     * Telemetry seen in the stream, newest wins.
     *
     * Kept as plain locals rather than pushed into the event queue, because these are not things
     * that happened in the mission — they are facts about the account and the session, and they
     * belong in a capacity reading rather than in a mission's timeline.
     */
    const observed: { rateLimit: SdkRateLimitInfo | null; context: SdkContextUsage | null } = {
      rateLimit: null,
      context: null,
    };

    const pump = (async () => {
      try {
        for await (const message of session) {
          if (message.session_id && message.session_id !== sessionId) {
            sessionId = message.session_id;
            queue.push({ type: 'session', sessionId: message.session_id });
          }
          if (message.rate_limit_info) observed.rateLimit = message.rate_limit_info;
          if (message.context_usage) observed.context = message.context_usage;
          for (const event of translate(message, this.billing(), request.resultMaxChars))
            queue.push(event);
        }
      } catch (error) {
        queue.push({
          type: 'error',
          message: redactSecrets(describe(error)),
          retryable: isRetryable(error),
        });
      } finally {
        /*
         * Read capacity while the session is still alive, before the queue is finished and the
         * subprocess is torn down. This is the only moment a worker has: between missions there is
         * no session to ask, so a reading missed here is a reading that does not exist until the
         * next mission runs.
         *
         * It runs in `finally` so that a mission which ended in an error still contributes one —
         * that is often exactly the mission that ran into a rate limit, and it would be perverse
         * to discard the reading that explains why.
         */
        await this.collectCapacity(session, observed).catch(() => undefined);
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

/** What a final result is cut to when the caller does not ask for more. Suits a mission summary. */
const RESULT_MAX_CHARS = 4000;

/** SDK message → Jarvis event. Anything Jarvis has no use for is simply dropped. */
function translate(
  message: SdkMessage,
  billing: 'subscription' | 'api' | 'unknown',
  resultMaxChars: number = RESULT_MAX_CHARS,
): readonly AgentEvent[] {
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
    const usage = extractUsage(message, billing);
    if (message.is_error) {
      events.push({
        type: 'error',
        message: redactSecrets(message.result ?? 'The agent reported an error.'),
        retryable: false,
      });
    } else {
      events.push({
        type: 'done',
        /*
         * The one piece of text a caller may need whole. See `resultMaxChars`: a mission shows
         * this to a person and a reasoning turn parses it, and the second cannot survive being cut
         * in the middle of a JSON string. Still bounded, just not always at the display ceiling.
         */
        result: boundText(redactSecrets(message.result ?? ''), resultMaxChars),
        usage,
      });
    }
  }

  return events;
}

/**
 * Tokens, turns, duration — and money only when money was actually spent.
 *
 * Claude Code reports `total_cost_usd` on a subscription session too, and on a subscription it is
 * not a bill. It is what those tokens would have cost at API rates: a counterfactual, printed to
 * four decimal places, next to the word "cost". An owner who has paid a flat subscription fee and
 * reads "$0.4213" beside their mission has been told something untrue about their own money, and
 * a day of missions would add up to a figure they might reasonably act on.
 *
 * So subscription work reports no cost at all, which is the accurate number: the marginal cost of
 * a subscription mission is nothing. Tokens and turns still travel, and they are what actually
 * describes how much work was done. The charter's spend limits are about money and are unaffected
 * — subscription work spends none, and the capacity governor is what bounds it instead.
 */
function extractUsage(
  message: SdkMessage,
  billing: 'subscription' | 'api' | 'unknown',
): RunUsage | null {
  if (!message.usage && message.total_cost_usd === undefined) return null;
  return {
    inputTokens: message.usage?.input_tokens ?? null,
    outputTokens: message.usage?.output_tokens ?? null,
    cacheReadTokens: message.usage?.cache_read_input_tokens ?? null,
    totalCostUsd: billing === 'subscription' ? null : (message.total_cost_usd ?? null),
    turns: message.num_turns ?? null,
    durationMs: message.duration_ms ?? null,
    /*
     * And which of the two the null above is. Dropping the counterfactual cost is only half of
     * telling the truth about a subscription run: the ledger has to be able to tell "free" from
     * "nobody said", and this is the only place in the system that knows which.
     */
    billing,
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

/* ----------------------------------------------- structured error signals */

/**
 * How far down an error's `cause` chain the structured signals are looked for.
 *
 * Four links, because the chains that actually arrive here are short: the SDK wraps a transport
 * failure, the transport wraps a socket error, and a worker helper occasionally wraps that again.
 * A bound is needed at all because `cause` is an ordinary property that anything may set —
 * including, on a hand-built error object, back to the error itself, which an unbounded walk
 * would follow for ever.
 */
export const ERROR_CAUSE_DEPTH = 4;

/** What an error knows about itself, as opposed to what it says. */
export interface ErrorSignals {
  /**
   * A server's verdict on the request, when one reached a server at all.
   *
   * Only a failure status is ever reported here. A number outside that range on an error object
   * is something else wearing the name — see `httpFailureStatus`.
   */
  readonly status: number | null;
  /** A machine code: a Node `errno` such as `ECONNRESET`, or a domain error's `JarvisErrorCode`. */
  readonly code: string | null;
}

/**
 * Read what an unknown error knows about itself, before reading what it says.
 *
 * The worker's classifiers used to read `error.message` and nothing else, and a message is the
 * least dependable thing an error carries: prose, written by a provider, free to be reworded in
 * a point release. An Anthropic 403 whose text mentioned a timeout was retried on the strength of
 * that one word, and a 529 — overloaded, the most retryable status there is — was given up on
 * because its text contained no phrase the classifier knew.
 *
 * The shape is read rather than a class tested, because for the SDK there is no class to test
 * against: the package is an optional dynamic import whose types are declared locally (see the
 * note at the top of this file), so `instanceof` has nothing to name. Reading the shape also
 * survives a subprocess boundary, which turns an error into a plain object with no prototype.
 */
export function readErrorSignals(error: unknown): ErrorSignals {
  let status: number | null = null;
  let code: string | null = null;

  let current: unknown = error;
  for (let depth = 0; depth < ERROR_CAUSE_DEPTH; depth += 1) {
    if (typeof current !== 'object' || current === null) break;
    const record = current as Record<string, unknown>;
    const response =
      typeof record.response === 'object' && record.response !== null
        ? (record.response as Record<string, unknown>)
        : null;
    status ??=
      httpFailureStatus(record.status) ??
      httpFailureStatus(record.statusCode) ??
      httpFailureStatus(record.httpStatus) ??
      httpFailureStatus(response?.status);
    code ??= typeof record.code === 'string' && record.code.length > 0 ? record.code : null;
    current = record.cause;
  }

  return { status, code };
}

/**
 * The band a number has to be in before it is believed to be a server's verdict.
 *
 * It starts at 400 rather than 100 because `status` is a popular property name and most of what
 * carries it is not HTTP. The worker's own `ControlPlaneError` sets it to `0` when nothing
 * answered, and `status` is also where Node's own child-process helpers put an exit code — which
 * for a process killed by a signal is 128 plus the signal number, so 137 for SIGKILL and 143 for
 * SIGTERM. Every one of those passes a 100-to-599 test and is then read as "a server answered,
 * and not with a 5xx" — the opposite of what each of them means, and worse than reading nothing,
 * because a status found here silences the message rules that would otherwise have decided.
 *
 * Nothing is lost by ignoring the band below: no request that succeeded or was redirected arrives
 * here as a failure, so a 1xx, 2xx or 3xx on an error object is a number that means something
 * else.
 */
const HTTP_FAILURE_STATUS_MIN = 400;
const HTTP_STATUS_MAX = 599;

/** A server's verdict, or null for a property that merely shares the name. */
function httpFailureStatus(value: unknown): number | null {
  const numeric = typeof value === 'string' ? Number(value) : value;
  if (typeof numeric !== 'number' || !Number.isInteger(numeric)) return null;
  return numeric >= HTTP_FAILURE_STATUS_MIN && numeric <= HTTP_STATUS_MAX ? numeric : null;
}

/**
 * At and above this status the server is describing its own trouble rather than judging the
 * request, so the identical request is worth sending again.
 *
 * A floor rather than a list, because the set is open at the top: 500, 502, 503 and 504 come from
 * the API and from whatever proxy sits in front of it, and Anthropic's own overload status is 529
 * — outside every published enumeration of HTTP status codes, and the single most retryable thing
 * the API can return.
 */
export const RETRYABLE_STATUS_FLOOR = 500;

/**
 * The two 4xx that mean "later" rather than "no".
 *
 * Every other 4xx is a verdict on the request itself — a rejected key, a model this account may
 * not use, a body the API would refuse a thousand times over — and retrying one spends the
 * mission's attempts to arrive at the same answer more slowly. 408 is the server saying it gave
 * up waiting; 429 is it saying to come back.
 */
export const RETRYABLE_CLIENT_STATUSES: ReadonlySet<number> = new Set([408, 429]);

/**
 * Node error codes that describe the connection rather than the request.
 *
 * These arrive with no status at all, because nothing that could assign one was ever reached.
 * `EAI_AGAIN` is the DNS resolver explicitly asking to be asked again, and the `UND_ERR_` pair is
 * what Node's own `fetch` throws for a connection that timed out or died in flight.
 *
 * `ENOTFOUND` is deliberately absent. A hostname that does not resolve is almost always a
 * misconfigured base URL rather than a passing condition, and retrying it spends the run's
 * remaining attempts on a name that will still not resolve a minute later.
 */
export const RETRYABLE_NETWORK_CODES: ReadonlySet<string> = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EPIPE',
  'EAI_AGAIN',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
]);

/**
 * A status named in the sentence, for the failures that arrive as one.
 *
 * The SDK runs `claude` in a subprocess, and an API failure inside it reaches the worker as
 * whatever the CLI printed: `API Error: 529 {"type":"error"…}`. The status is there — it is just
 * in the prose rather than on the object, and reading only the adjectives around it is the
 * original defect in its commonest shape. A 403 whose body says "request timeout" was retried on
 * the word; `API Error: 500` was given up on because no word in it was familiar. Both are decided
 * here now, by the number, before any adjective is consulted.
 *
 * Anchored on the words that introduce a status, because a bare three-digit number in a message
 * means nothing in particular and there is no hurry to guess. `[45]\d\d` is
 * `HTTP_FAILURE_STATUS_MIN`…`HTTP_STATUS_MAX` said the only way a pattern can say it: the text
 * gets the same band as the object, so neither can be used to smuggle past the other.
 */
const STATUS_IN_MESSAGE = /(?:api error|http(?:\s+error)?|status(?:\s+code)?)\D{0,3}([45]\d\d)\b/i;

/**
 * The last resort: phrases worth acting on when the error carries nothing else.
 *
 * What is left once neither the object nor the text names a status: a sentence with no number in
 * it at all. These four are what this classifier was originally built from; they are kept, below
 * every reading of what the server actually said instead of in front of them.
 */
export const RETRYABLE_MESSAGE_HINTS: readonly string[] = [
  'overloaded',
  'rate limit',
  'timeout',
  'econnreset',
];

/**
 * One rule for a status, wherever it was found.
 *
 * Extracted so that a status on the object and a status in the text cannot come to disagree: the
 * question "does this number mean later or no" has one answer, and a rule kept in two places is
 * how the two readings of an error drifted apart in the first place.
 */
function statusIsRetryable(status: number): boolean {
  return status >= RETRYABLE_STATUS_FLOOR || RETRYABLE_CLIENT_STATUSES.has(status);
}

/**
 * Is the identical request worth making again?
 *
 * A status decides whenever one can be found, in both directions: it is the API's own account of
 * what happened, and no phrase in the body of a 403 turns a permanent refusal into a passing
 * condition. On the object first, because that reading cannot be confused by a quoted sentence;
 * then in the message, because a failure that crossed the `claude` subprocess boundary has
 * nowhere else to put it.
 *
 * A recognised network code sits between the two, for the failures that never reached a server to
 * be given a status by. A code that is present but unrecognised falls through rather than being
 * read as a refusal: an unknown code is evidence about where the failure came from, not about
 * whether it will recur, and treating it as "not retryable" would quietly stop the worker
 * retrying a genuinely overloaded API.
 *
 * The phrases speak last, and only for an error that names no status anywhere.
 */
export function isRetryable(error: unknown): boolean {
  const signals = readErrorSignals(error);
  if (signals.status !== null) return statusIsRetryable(signals.status);
  if (signals.code !== null && RETRYABLE_NETWORK_CODES.has(signals.code)) return true;

  const message = describe(error).toLowerCase();
  const spoken = STATUS_IN_MESSAGE.exec(message);
  if (spoken) return statusIsRetryable(Number(spoken[1]));

  return RETRYABLE_MESSAGE_HINTS.some((hint) => message.includes(hint));
}
