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
