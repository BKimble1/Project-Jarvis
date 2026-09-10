/**
 * A single unit of execution.
 *
 * A Worker is a thin, observable wrapper around an injected `executor`: it
 * announces `worker.started`, keeps honest counters, and rethrows whatever the
 * executor threw. It never classifies or swallows failures — supervision
 * (crash / restart / retry) belongs to the pool, which is the only thing that
 * knows about capacity and budgets.
 */
import { newId } from '../core/ids.js';
import { createLogger } from '../core/logger.js';

export class Worker {
  constructor({ id = newId('worker'), clock, executor, bus = null, logger = createLogger('workers:worker') } = {}) {
    if (!clock || typeof clock.now !== 'function') throw new Error('Worker requires a clock');
    if (typeof executor !== 'function') throw new Error('Worker requires an executor function');
    this._id = id;
    this.clock = clock;
    this.executor = executor;
    this.bus = bus;
    this.logger = logger;

    this._state = 'idle';        // 'idle' | 'running' | 'crashed'
    this._started = 0;
    this._completed = 0;
    this._failed = 0;
    this._restarts = 0;
    this._lastError = null;
    this._lastTaskId = null;
  }

  get id() { return this._id; }
  get state() { return this._state; }
  get busy() { return this._state === 'running'; }
  get healthy() { return this._state !== 'crashed'; }
  get lastError() { return this._lastError; }

  /**
   * Execute one task.
   * @param {object} task  a Task record (needs at least `id`)
   * @param {object} [ctx] orchestrator context; `clock` and `workerId` are guaranteed
   * @returns {Promise<any>} whatever the executor resolved with
   */
  async run(task, ctx = {}) {
    if (!task || typeof task !== 'object') throw new TypeError('Worker.run requires a task object');
    if (this._state === 'crashed') throw new Error(`worker ${this._id} is crashed and must be restarted before reuse`);
    if (this._state === 'running') throw new Error(`worker ${this._id} is already running a task`);

    this._state = 'running';
    this._started += 1;
    this._lastTaskId = task.id ?? null;

    const runCtx = { ...(ctx ?? {}), workerId: this._id, clock: ctx?.clock ?? this.clock };

    this.bus?.emit('worker.started', {
      workerId: this._id,
      taskId: task.id ?? null,
      projectId: task.projectId ?? ctx?.project?.id ?? null,
      title: task.title ?? null,
      kind: task.kind ?? null,
      attempt: runCtx.poolAttempt ?? ctx?.attempt ?? 1,
      at: this.clock.now(),
    });

    try {
      const result = await this.executor(task, runCtx);
      this._state = 'idle';
      this._completed += 1;
      this._lastError = null;
      return result;
    } catch (err) {
      // Stay 'idle' on a plain task failure: only the pool may declare a crash.
      this._state = 'idle';
      this._failed += 1;
      this._lastError = err?.message ?? String(err);
      this.logger.debug('executor threw', { workerId: this._id, taskId: task.id ?? null, error: this._lastError });
      throw err;
    }
  }

  /** The pool declares this worker crashed; it cannot run again until restarted. */
  markCrashed(err) {
    this._state = 'crashed';
    if (err) this._lastError = err?.message ?? String(err);
    return this;
  }

  /** Bring a crashed worker back to a usable state. */
  restart() {
    this._state = 'idle';
    this._restarts += 1;
    this._lastError = null;
    return this;
  }

  stats() {
    return {
      id: this._id,
      state: this._state,
      started: this._started,
      completed: this._completed,
      failed: this._failed,
      restarts: this._restarts,
      lastError: this._lastError,
      lastTaskId: this._lastTaskId,
    };
  }
}

/** Build the error described by one entry of a failure plan. */
function toError(spec) {
  if (spec instanceof Error) return spec;
  if (typeof spec === 'string') return new Error(spec);
  const err = new Error(spec?.message ?? 'scripted failure');
  if (spec?.code !== undefined) err.code = spec.code;
  if (spec?.status !== undefined) err.status = spec.status;
  return err;
}

/**
 * Deterministic executor for demos and tests.
 *
 * Resolves with `{ taskId, title, kind, output }` where `output` is a short,
 * fully deterministic string — the same task always produces the same result,
 * so a demo run and a test run agree.
 *
 * `failurePlan` maps a task id, title or kind to a script of failures:
 *   - an Error / a message string / `{ message, code, status }` → thrown on every attempt
 *   - `{ message, code, status, times: n }`                     → thrown on the first n attempts
 *   - an array of the above, consulted by 1-based attempt number; a `null`
 *     entry means "succeed on that attempt" and the last entry repeats.
 * Attempts are counted per task id, so a pool retry advances the script.
 *
 * @param {{clock?: object, delayMs?: number, failurePlan?: object,
 *          output?: (task: object, ctx: object) => string}} [options]
 * @returns {(task: object, ctx: object) => Promise<{taskId, title, kind, output}>}
 */
export function createEchoExecutor({ clock = null, delayMs = 0, failurePlan = {}, output = null } = {}) {
  const attempts = new Map();

  const plannedFor = (task, attempt) => {
    const keys = [task?.id, task?.title, task?.kind].filter((k) => k !== undefined && k !== null);
    for (const key of keys) {
      if (!Object.prototype.hasOwnProperty.call(failurePlan, key)) continue;
      const entry = failurePlan[key];
      if (Array.isArray(entry)) return entry.length ? (attempt <= entry.length ? entry[attempt - 1] : entry[entry.length - 1]) : null;
      if (entry && typeof entry === 'object' && Number.isFinite(entry.times)) {
        return attempt <= entry.times ? entry : null;
      }
      return entry ?? null;
    }
    return null;
  };

  async function echoExecutor(task, ctx = {}) {
    if (!task || typeof task !== 'object') throw new TypeError('echo executor requires a task object');
    const taskId = task.id ?? null;
    const attempt = (attempts.get(taskId) ?? 0) + 1;
    attempts.set(taskId, attempt);

    const wait = Math.max(0, Number(delayMs) || 0);
    if (wait > 0) {
      const sleeper = ctx?.clock ?? clock;
      if (sleeper?.sleep) await sleeper.sleep(wait);
    }

    const failure = plannedFor(task, attempt);
    if (failure) throw toError(failure);

    const title = task.title ?? 'untitled task';
    const kind = task.kind ?? 'implement';
    return {
      taskId,
      title,
      kind,
      output: typeof output === 'function' ? String(output(task, ctx)) : `${kind} complete: ${title}`,
    };
  }

  /** Attempts recorded for a task id — lets tests assert retry counts. */
  echoExecutor.attemptsFor = (taskId) => attempts.get(taskId ?? null) ?? 0;
  echoExecutor.reset = () => attempts.clear();
  return echoExecutor;
}
