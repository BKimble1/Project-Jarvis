/**
 * Supervised worker pool.
 *
 * Two jobs, both load-bearing for acceptance req. 5:
 *   1. Never run more tasks at once than the scheduler currently allows, and
 *      re-ask the scheduler before EVERY dispatch so a mid-run capacity drop
 *      immediately narrows the pipe.
 *   2. Survive worker crashes: a transient failure crashes and restarts the
 *      worker (`worker.crashed` then `worker.recovered`) and the task is
 *      retried; anything else is the caller's problem and is rethrown.
 *
 * Dispatch decisions are made by a single serialized pump loop, which is what
 * makes `scheduler.gate()` behave as a real pace between tasks instead of a
 * delay every caller pays in parallel.
 */
import { classifyError } from '../orchestrator/retry.js';
import { createLogger } from '../core/logger.js';
import { Worker } from './worker.js';

/** setImmediate ticks — not wall-clock time — used to bound shutdown draining. */
const SHUTDOWN_DRAIN_TICKS = 100;

function tick() { return new Promise((resolve) => setImmediate(resolve)); }

async function ticks(n) { for (let i = 0; i < n; i += 1) await tick(); }

export class WorkerPool {
  constructor({
    clock,
    bus = null,
    scheduler = null,
    size = 4,
    executor,
    maxCrashRestarts = 3,
    zeroCapacityPollMs = 1_000,
    logger = createLogger('workers:pool'),
  } = {}) {
    if (!clock || typeof clock.sleep !== 'function') throw new Error('WorkerPool requires a clock with sleep()');
    if (typeof executor !== 'function') throw new Error('WorkerPool requires an executor function');

    this.clock = clock;
    this.bus = bus;
    this.scheduler = scheduler;
    this.logger = logger;
    this.size = Math.max(1, Math.floor(Number(size) || 1));
    const restarts = Number(maxCrashRestarts);
    this.maxCrashRestarts = Number.isFinite(restarts) ? Math.max(0, Math.floor(restarts)) : 3;
    this.zeroCapacityPollMs = Math.max(1, Math.floor(Number(zeroCapacityPollMs) || 1000));
    this.executor = executor;

    this._workers = Array.from({ length: this.size }, (_, i) => new Worker({
      id: `worker-${i + 1}`,
      clock,
      executor,
      bus,
      logger: logger.child ? logger.child(`w${i + 1}`) : logger,
    }));
    this._free = [...this._workers];

    this._queue = [];
    this._running = new Set();
    this._active = 0;
    this._peak = 0;
    this._restarts = 0;
    this._crashed = 0;
    this._completed = 0;
    this._closed = false;
    this._pumping = false;
    this._waiter = null;
  }

  get inFlight() { return this._active; }
  get peakConcurrency() { return this._peak; }
  get queued() { return this._queue.length; }
  get workers() { return [...this._workers]; }

  stats() {
    return {
      size: this.size,
      inFlight: this._active,
      peakConcurrency: this._peak,
      restarts: this._restarts,
      crashed: this._crashed,
    };
  }

  /**
   * Queue a task and resolve with the executor's result.
   * Rejects with the executor's error once crash restarts are exhausted, or
   * immediately for non-transient failures.
   */
  submit(task, ctx = {}) {
    if (this._closed) return Promise.reject(new Error('worker pool is shut down'));
    if (!task || typeof task !== 'object') return Promise.reject(new TypeError('WorkerPool.submit requires a task object'));

    return new Promise((resolve, reject) => {
      this._queue.push({ task, ctx, resolve, reject, attempts: 0, restarts: 0 });
      this._pump();
    });
  }

  /** How many tasks the scheduler allows right now, capped by the pool size. */
  _limit() {
    if (!this.scheduler || typeof this.scheduler.concurrency !== 'function') return this.size;
    let requested;
    try {
      requested = Math.floor(Number(this.scheduler.concurrency()));
    } catch (err) {
      this.logger.warn('scheduler.concurrency() threw; falling back to 1', err?.message);
      return 1;
    }
    if (!Number.isFinite(requested)) return this.size;
    return Math.max(0, Math.min(this.size, requested));
  }

  async _gate() {
    if (this.scheduler && typeof this.scheduler.gate === 'function') await this.scheduler.gate();
  }

  /** Promise that resolves the next time a slot frees up (or on shutdown). */
  _slotFreed() {
    if (!this._waiter) {
      let resolve;
      const promise = new Promise((r) => { resolve = r; });
      this._waiter = { promise, resolve };
    }
    return this._waiter.promise;
  }

  _notify() {
    const waiter = this._waiter;
    this._waiter = null;
    waiter?.resolve();
  }

  /**
   * The single dispatch loop. Re-reads the scheduler on every iteration, so a
   * capacity change lands on the very next dispatch.
   */
  async _pump() {
    if (this._pumping) return;
    this._pumping = true;
    try {
      while (!this._closed && this._queue.length > 0) {
        const limit = this._limit();

        // Full: wait for a running task to finish, then reconsider.
        if (limit > 0 && this._active >= limit) {
          await this._slotFreed();
          continue;
        }

        // Pace. When concurrency is 0 the gate blocks until capacity returns.
        await this._gate();
        if (this._closed) break;

        // Capacity may have moved while we paced — ask again before committing.
        const limitNow = this._limit();
        if (limitNow <= 0) {
          // Zero capacity. A real Scheduler.gate() already blocks here; this
          // keeps a bare stub scheduler from spinning the event loop.
          await this.clock.sleep(this.zeroCapacityPollMs);
          continue;
        }
        if (this._active >= limitNow) continue;

        const job = this._queue.shift();
        if (job) this._dispatch(job);
      }
    } catch (err) {
      this.logger.error('pump loop failed', err?.message);
    } finally {
      this._pumping = false;
    }
  }

  _dispatch(job) {
    const worker = this._free.shift();
    if (!worker) { this._queue.unshift(job); return; }

    this._active += 1;
    if (this._active > this._peak) this._peak = this._active;
    job.attempts += 1;

    const ctx = { ...(job.ctx ?? {}), poolAttempt: job.attempts };
    const promise = (async () => {
      let ok = false;
      let result;
      let error;
      try {
        result = await worker.run(job.task, ctx);
        ok = true;
      } catch (err) {
        error = err;
      }

      // Release the slot BEFORE settling the caller's promise, so `inFlight`
      // and `stats()` are already accurate when the awaiting caller resumes.
      this._active -= 1;
      this._running.delete(promise);

      if (ok) {
        this._completed += 1;
        this._free.push(worker);
        job.resolve(result);
      } else {
        this._handleFailure(job, worker, error);
        if (worker.state !== 'crashed') this._free.push(worker);
      }

      this._notify();
      this._pump();
    })();

    this._running.add(promise);
  }

  /**
   * Crash supervision. Transient failures crash + restart the worker and requeue
   * the task; everything else (fatal, permission, credential, capacity) belongs
   * to the caller, which has the project context to block or repair.
   */
  _handleFailure(job, worker, err) {
    const classification = classifyError(err);
    if (classification !== 'transient') {
      job.reject(err);
      return;
    }

    const willRestart = !this._closed && job.restarts < this.maxCrashRestarts;
    this._crashed += 1;
    worker.markCrashed(err);

    const payload = {
      workerId: worker.id,
      taskId: job.task?.id ?? null,
      projectId: job.task?.projectId ?? job.ctx?.project?.id ?? null,
      error: err?.message ?? String(err),
      classification,
      attempt: job.attempts,
      willRestart,
    };
    this.bus?.emit('worker.crashed', payload);
    this.logger.warn('worker crashed', payload);

    // An in-process worker is always brought back to a usable state; only a
    // restart that actually buys the task another attempt counts as recovery.
    worker.restart();

    if (!willRestart) {
      job.reject(err);
      return;
    }

    job.restarts += 1;
    this._restarts += 1;
    this.bus?.emit('worker.recovered', {
      workerId: worker.id,
      taskId: job.task?.id ?? null,
      projectId: payload.projectId,
      restarts: this._restarts,
      attempt: job.attempts,
      retrying: true,
    });
    this._queue.unshift(job);
  }

  /**
   * Stop accepting work, let running tasks settle, and fail whatever is still
   * queued. Draining is bounded by scheduler ticks (never by wall-clock time),
   * so a pool whose clock is frozen cannot hang a shutdown.
   */
  async shutdown() {
    if (this._closed) return;
    this._closed = true;
    this._notify();

    const queued = this._queue.splice(0, this._queue.length);
    for (const job of queued) job.reject(new Error('worker pool is shut down'));

    if (this._running.size > 0) {
      await Promise.race([
        Promise.allSettled([...this._running]),
        ticks(SHUTDOWN_DRAIN_TICKS),
      ]);
    }
  }
}
