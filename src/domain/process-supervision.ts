/**
 * When to restart a process that died, and when to stop trying.
 *
 * ## Why this is a domain module and not four lines in the launcher
 *
 * Because the four lines are the ones that matter. A supervisor that restarts unconditionally
 * turns a configuration error into an infinite loop that fills a disk with the same stack trace;
 * a supervisor that never restarts turns a dropped network connection into a morning of nothing
 * happening. The interesting behaviour is entirely in the boundary between those, which is
 * exactly the kind of thing that should be testable without spawning anything.
 *
 * ## The shape of the policy
 *
 * Exponential backoff inside a rolling window, with a hard ceiling on attempts. A process that
 * dies once and comes back is a blip. A process that dies five times in ten minutes is broken, and
 * the useful thing to do is stop and say so — an owner reading "gave up after 5 attempts; the last
 * error is above" can act; an owner watching an endless restart loop cannot even read the error.
 */

/** Restarts are counted within this much of now. Older ones are forgiven. */
export const RESTART_WINDOW_MS = 10 * 60_000;

/** Attempts allowed inside the window before the supervisor stops trying. */
export const MAX_RESTARTS_IN_WINDOW = 5;

/** Backoff between attempts, by how many have already happened in the window. */
const BACKOFF_MS = [2_000, 4_000, 8_000, 16_000, 30_000];

export interface RestartDecision {
  readonly restart: boolean;
  /** How long to wait first. Zero when not restarting. */
  readonly delayMs: number;
  /** One sentence for the log. Always says what was decided and why. */
  readonly reason: string;
}

export function decideRestart(input: {
  /** Epoch milliseconds of restarts already attempted for this process. */
  readonly restarts: readonly number[];
  readonly now: number;
  /** True when the process exited zero, which for a long-lived service is still a surprise. */
  readonly cleanExit: boolean;
  /** True when the supervisor is stopping on purpose. Nothing is restarted then. */
  readonly shuttingDown: boolean;
  readonly name: string;
}): RestartDecision {
  if (input.shuttingDown) {
    return { restart: false, delayMs: 0, reason: `${input.name} exited during shutdown.` };
  }

  const recent = input.restarts.filter((at) => input.now - at < RESTART_WINDOW_MS);
  if (recent.length >= MAX_RESTARTS_IN_WINDOW) {
    return {
      restart: false,
      delayMs: 0,
      reason:
        `${input.name} has been restarted ${recent.length} times in the last ` +
        `${Math.round(RESTART_WINDOW_MS / 60_000)} minutes and died again. Something is wrong that restarting will not fix — ` +
        'the last error is above. Stopping the rest of Jarvis.',
    };
  }

  const delayMs = BACKOFF_MS[Math.min(recent.length, BACKOFF_MS.length - 1)] ?? 30_000;
  return {
    restart: true,
    delayMs,
    reason:
      `${input.name} exited ${input.cleanExit ? 'cleanly, which it should not do while Jarvis is running' : 'unexpectedly'}. ` +
      `Restarting in ${Math.round(delayMs / 1000)}s (attempt ${recent.length + 1} of ${MAX_RESTARTS_IN_WINDOW}).`,
  };
}

/* ------------------------------------------------------------------- logs */

/** Roll the log over past this, so a chatty worker cannot fill a Raspberry Pi's card. */
export const LOG_ROTATE_BYTES = 8 * 1024 * 1024;

/** How many rolled files to keep. Enough to cover a night; not enough to matter. */
export const LOG_KEEP = 5;

export function shouldRotate(sizeBytes: number): boolean {
  return sizeBytes >= LOG_ROTATE_BYTES;
}

/**
 * The rolled name for a given generation. `jarvis.log`, `jarvis.1.log`, …
 *
 * Numbered rather than timestamped so the set of files is bounded and predictable — a directory
 * that accumulates one file per rotation is a directory somebody eventually has to clean out.
 */
export function rolledLogName(base: string, generation: number): string {
  return generation === 0 ? base : base.replace(/\.log$/, `.${generation}.log`);
}

/* ------------------------------------------------------------ the worker pool */

/**
 * The hard ceiling on worker processes, whatever configuration asks for.
 *
 * A pool size is a number in a file, and a number in a file is one typo away from four hundred.
 * Every one of those would be a separate Claude subscription session on one login, which is not a
 * throughput problem — it is a way to get an account rate-limited by accident overnight. Four is
 * more than a single-owner deployment needs and small enough to be survivable.
 */
export const MAX_WORKER_POOL = 4;

/**
 * How many workers to run, given what was asked for.
 *
 * Clamped rather than rejected: a supervisor that refuses to start because the pool size is silly
 * leaves the owner with no worker at all, which is worse than running the number that is safe and
 * saying so. The reason is returned so the log can say what it did rather than quietly disagreeing
 * with the configuration file.
 */
export function resolveWorkerPool(requested: number | null | undefined): {
  readonly size: number;
  readonly reason: string | null;
} {
  if (requested === null || requested === undefined || Number.isNaN(requested)) {
    return { size: 1, reason: null };
  }
  const whole = Math.floor(requested);
  if (whole < 1) {
    return {
      size: 1,
      reason: `A pool of ${requested} would run nothing, so one worker is running.`,
    };
  }
  if (whole > MAX_WORKER_POOL) {
    return {
      size: MAX_WORKER_POOL,
      reason:
        `A pool of ${whole} was asked for and ${MAX_WORKER_POOL} is the ceiling — every worker is ` +
        'a separate session on one subscription login.',
    };
  }
  return { size: whole, reason: null };
}

/**
 * The environment variable each member of the pool takes its identity from.
 *
 * The first is the plain name every single-worker installation already uses; the rest are
 * numbered from two, matching the `worker-2`, `worker-3` names the supervisor gives them.
 */
export function workerTokenVariable(index: number): string {
  return index === 0 ? 'JARVIS_WORKER_TOKEN' : `JARVIS_WORKER_TOKEN_${index + 1}`;
}

/**
 * One enrolment token per member of the pool, and a pool no larger than the tokens allow.
 *
 * ## Why a pool cannot share a token
 *
 * A token names one enrolled worker — one row, one `currentRunId`, one held assignment. Every
 * process that presents it *is* that worker as far as the control plane is concerned, and
 * `WorkerService.claim` hands a worker that already holds a run that same run back, because that
 * is how a worker recovers its own work after a restart. So a pool of three sharing one token does
 * not divide the work three ways: all three are handed the same mission, clone it into the same
 * workspace directory, and run three agent sessions and three sets of git operations over one
 * checkout.
 *
 * That was what `JARVIS_WORKER_POOL=3` did, silently, and the log said "3 worker(s)".
 *
 * ## Why this reduces rather than refuses
 *
 * The same reason `resolveWorkerPool` clamps rather than rejecting: an owner who mistyped a pool
 * size should end up with a smaller pool and an explanation, not with no worker at all overnight.
 * A pool asked for and not configured for runs at the size its tokens support, and says which
 * variables would let it grow.
 *
 * Enrol the extra workers the way the first one was enrolled — Operations → Workers — and give
 * each its own variable. Nothing here creates a credential.
 */
export function resolveWorkerTokens(
  size: number,
  env: Record<string, string | undefined>,
): { readonly tokens: readonly string[]; readonly reason: string | null } {
  const tokens: string[] = [];
  for (let index = 0; index < size; index += 1) {
    const value = env[workerTokenVariable(index)]?.trim();
    if (!value) break;
    tokens.push(value);
  }

  if (tokens.length === size) return { tokens, reason: null };

  const missing = [];
  for (let index = tokens.length; index < size; index += 1)
    missing.push(workerTokenVariable(index));

  return {
    tokens,
    reason:
      `A pool of ${size} was asked for and ${tokens.length} worker token${tokens.length === 1 ? ' is' : 's are'} ` +
      `set, so ${tokens.length} worker${tokens.length === 1 ? ' is' : 's are'} running. Processes cannot ` +
      `share a token — the control plane would treat them as one worker and hand them all the same ` +
      `mission. Enrol another worker and set ${missing.join(', ')}.`,
  };
}
