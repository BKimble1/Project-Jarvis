/**
 * Which Claude account Jarvis is working through, and who pays for it.
 *
 * A worker can reach Claude two ways, and they bill differently: an `ANTHROPIC_API_KEY` charges
 * the API account per token, while a Claude Code login draws on the owner's subscription. Both
 * work. The dangerous state is not knowing which one is in force — an owner who believes they are
 * inside a subscription and is quietly being invoiced per token has been failed by the software,
 * not by the pricing.
 *
 * So this module answers one question and refuses to guess at it: **which credential will actually
 * be used, and is that the one the owner asked for?** Where those disagree, Jarvis stops and says
 * so rather than picking the one that happens to be more likely to work.
 *
 * ## What it deliberately does not do
 *
 * It never reads, prints, logs or stores a credential value. The evidence it works from is the
 * output of a supported Claude Code command that reports *which kind* of login is stored, and a
 * boolean for whether an API key exists in the worker's environment. Neither carries a secret.
 *
 * It never unsets, edits or deletes anything. An `ANTHROPIC_API_KEY` in the owner's shell is
 * theirs, put there for a reason Jarvis does not know about. The remedy is always something the
 * owner does deliberately, and it is spelled out.
 */

export const CLAUDE_AUTH_MODES = [
  /** A Claude Code login. Draws on the owner's subscription; no per-token invoice. */
  'subscription',
  /** An `ANTHROPIC_API_KEY`. Bills the API account per token. */
  'api_key',
  /** Jarvis could not establish which. Never treated as either. */
  'unknown',
] as const;
export type ClaudeAuthMode = (typeof CLAUDE_AUTH_MODES)[number];

export const CLAUDE_AUTH_MODE_LABELS: Record<ClaudeAuthMode, string> = {
  subscription: 'Claude subscription',
  api_key: 'Anthropic API key',
  unknown: 'Unknown',
};

/**
 * What a supported Claude Code command reported about the stored login.
 *
 * Exactly three fields are kept from it. `claude auth status --json` also returns a projects
 * directory, which is a filesystem path and therefore none of Jarvis's business — a path is not
 * needed to answer "which kind of login is this", and carrying one would be the beginning of
 * carrying transcripts.
 */
export interface ClaudeAuthObservation {
  readonly loggedIn: boolean;
  /** e.g. `oauth_token`. Reported verbatim so an unfamiliar value is visible rather than guessed. */
  readonly authMethod: string | null;
  /** e.g. `firstParty`, `bedrock`, `vertex`. */
  readonly apiProvider: string | null;
  readonly observedAt: string;
  /** The command this came from, so a wrong reading can be traced to a wrong reader. */
  readonly source: string;
}

export interface ClaudeAuthVerdict {
  /** What will actually be used, as best Jarvis can establish. */
  readonly mode: ClaudeAuthMode;
  /** Whether the worker may run model work at all. */
  readonly usable: boolean;
  /** Who pays. `unknown` is never rendered as free. */
  readonly bills: 'subscription' | 'api' | 'unknown';
  /** One sentence an owner reads. */
  readonly reason: string;
  /** Exactly what to do about it, or null when there is nothing to do. */
  readonly remedy: string | null;
}

/** Auth methods that mean a Claude Code login rather than a key. */
function isOauthMethod(method: string | null): boolean {
  return method !== null && method.toLowerCase().includes('oauth');
}

function isKeyMethod(method: string | null): boolean {
  if (method === null) return false;
  const lower = method.toLowerCase();
  return lower.includes('api_key') || lower.includes('apikey');
}

/**
 * Decide which credential is in force, and whether it is the one that was asked for.
 *
 * The ordering matters and is deliberate: **ambiguity is checked before availability.** A worker
 * configured for the subscription, with a working subscription login *and* an API key present, is
 * refused — not because it could not run, but because it would run on the key and quietly bill for
 * it. Getting that the other way round would make the refusal unreachable exactly when it matters.
 */
export function resolveClaudeAuth(input: {
  /** What the owner configured this worker to use. */
  readonly configured: 'subscription' | 'api_key';
  /** Whether `ANTHROPIC_API_KEY` exists in the worker's environment. Never its value. */
  readonly apiKeyPresent: boolean;
  /** What Claude Code reported, or null when it could not be asked. */
  readonly observation: ClaudeAuthObservation | null;
}): ClaudeAuthVerdict {
  if (input.configured === 'api_key') {
    if (!input.apiKeyPresent) {
      return {
        mode: 'unknown',
        usable: false,
        bills: 'unknown',
        reason:
          'This worker is set to use an Anthropic API key, but ANTHROPIC_API_KEY is not set in its environment.',
        remedy:
          'Set ANTHROPIC_API_KEY for the worker process, or set JARVIS_WORKER_AUTH_MODE=subscription to use your Claude subscription instead.',
      };
    }
    return {
      mode: 'api_key',
      usable: true,
      bills: 'api',
      reason:
        'This worker uses an Anthropic API key, so model usage is billed to that API account per token rather than drawn from a Claude subscription.',
      remedy: null,
    };
  }

  /*
   * Subscription mode. The key check comes first, because a key wins over a login inside the SDK
   * and the whole point of this mode is that the owner is not billed by surprise.
   */
  if (input.apiKeyPresent) {
    return {
      mode: 'unknown',
      usable: false,
      bills: 'unknown',
      reason:
        'This worker is set to use your Claude subscription, but ANTHROPIC_API_KEY is also set in its environment. That key would take precedence and bill the API account, so Jarvis will not guess which you meant.',
      remedy:
        'Start the worker without that variable — for example `env -u ANTHROPIC_API_KEY npm run worker` — or set JARVIS_WORKER_AUTH_MODE=api_key to use the key deliberately. Jarvis will not unset it for you.',
    };
  }

  if (!input.observation) {
    return {
      mode: 'unknown',
      usable: false,
      bills: 'unknown',
      reason:
        'Jarvis could not ask Claude Code which account is signed in, so it cannot confirm this worker has a subscription to draw on.',
      remedy:
        'Install Claude Code and make sure `claude` is on this worker’s PATH, then run `claude auth status` yourself to check.',
    };
  }

  if (!input.observation.loggedIn) {
    return {
      mode: 'unknown',
      usable: false,
      bills: 'unknown',
      reason: 'Claude Code is installed on this worker but no account is signed in.',
      remedy:
        'Run `claude auth login` as the same operating-system user that runs this worker, sign in with the account that holds your subscription, then restart the worker.',
    };
  }

  if (isKeyMethod(input.observation.authMethod)) {
    return {
      mode: 'api_key',
      usable: false,
      bills: 'api',
      reason: `Claude Code reports it is authenticated with "${input.observation.authMethod}", which is a key rather than a subscription login. Jarvis will not run subscription-only work on it.`,
      remedy:
        'Run `claude auth logout` then `claude auth login` and sign in with the account that holds your subscription, or set JARVIS_WORKER_AUTH_MODE=api_key to bill the API deliberately.',
    };
  }

  if (!isOauthMethod(input.observation.authMethod)) {
    return {
      mode: 'unknown',
      usable: false,
      bills: 'unknown',
      reason: `Claude Code reports an authentication method Jarvis does not recognise ("${input.observation.authMethod ?? 'none reported'}"), so it cannot tell whether work would be billed to a subscription or to an API account.`,
      remedy:
        'Run `claude auth status` on this worker and check which account is signed in before enabling autonomous work.',
    };
  }

  return {
    mode: 'subscription',
    usable: true,
    bills: 'subscription',
    reason: `Signed in to Claude Code with a subscription login${
      input.observation.apiProvider ? ` on ${input.observation.apiProvider}` : ''
    }. Model work draws on the subscription rather than being invoiced per token.`,
    remedy: null,
  };
}

/**
 * The short line the worker prints and the heartbeat carries.
 *
 * Kept separate from the verdict so the wording lives in one place rather than being reassembled
 * by the console, the workers page and Operations into three subtly different sentences.
 */
export function describeClaudeAuth(verdict: ClaudeAuthVerdict): string {
  return verdict.usable
    ? `${CLAUDE_AUTH_MODE_LABELS[verdict.mode]} — ${verdict.reason}`
    : `${CLAUDE_AUTH_MODE_LABELS[verdict.mode]} — ${verdict.reason}${
        verdict.remedy ? ` ${verdict.remedy}` : ''
      }`;
}
