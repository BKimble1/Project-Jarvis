import { newId } from '../core/ids.js';

const COLLECTION = 'backlog';

export const BACKLOG_STATUSES = Object.freeze(['pending', 'picked', 'done']);

/**
 * `add` documents `authorized = true`, so only an explicit `false` holds an
 * item back. The read path has to use exactly the same rule as the write path:
 * a stricter `=== true` would strand any record whose flag went missing in
 * `status:'pending'` forever, invisible to both `next()` and `size()`.
 */
function isAuthorized(item) {
  return item?.authorized !== false;
}

/**
 * FIFO queue of authorized future work.
 *
 * `next()` returning null is a real answer: when the backlog is empty Jarvis
 * stops. It never synthesizes an item to keep itself busy (acceptance req. 1,
 * "do not invent endless additional work").
 */
export class Backlog {
  constructor({ store, bus, clock }) {
    if (!store) throw new TypeError('Backlog: store is required');
    if (!bus) throw new TypeError('Backlog: bus is required');
    if (!clock) throw new TypeError('Backlog: clock is required');
    this.store = store;
    this.bus = bus;
    this.clock = clock;
  }

  add({ title, goal, source = 'user', authorized = true } = {}) {
    const cleanTitle = String(title ?? '').trim().replace(/\s+/g, ' ');
    if (!cleanTitle) throw new TypeError('Backlog.add: title is required');
    const cleanGoal = String(goal ?? '').trim();
    const item = {
      id: newId('bk'),
      title: cleanTitle,
      goal: cleanGoal || cleanTitle,
      source: source ?? 'user',
      authorized: isAuthorized({ authorized }),
      status: 'pending',
      seq: this._nextSeq(),
      projectId: null,
      createdAt: this.clock.now(),
      pickedAt: null,
      completedAt: null,
    };
    this.store.put(COLLECTION, item.id, item);
    return item;
  }

  /** Every item, oldest first. */
  items() {
    return this.store
      .all(COLLECTION)
      .filter(Boolean)
      .sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0) || (a.createdAt ?? 0) - (b.createdAt ?? 0));
  }

  /** Items `next()` would serve, oldest first. */
  pending() {
    return this.items().filter((i) => i.status === 'pending' && isAuthorized(i));
  }

  /**
   * Pull the oldest authorized pending item and mark it picked.
   * @returns {object|null} null (plus `backlog.empty`) when there is nothing.
   */
  next() {
    const ready = this.pending();
    if (ready.length === 0) {
      this.bus.emit('backlog.empty', {
        projectId: null,
        size: ready.length,
        unauthorized: this.items().filter((i) => i.status === 'pending' && !isAuthorized(i)).length,
      });
      return null;
    }
    const picked = this.store.patch(COLLECTION, ready[0].id, {
      status: 'picked',
      pickedAt: this.clock.now(),
    });
    this.bus.emit('backlog.picked', {
      projectId: picked.projectId ?? null,
      itemId: picked.id,
      title: picked.title,
      goal: picked.goal,
      item: picked,
    });
    return picked;
  }

  /** Mark an item finished, optionally recording the project that did it. */
  complete(itemId, { projectId = null } = {}) {
    const current = this.store.get(COLLECTION, itemId);
    if (!current) return null;
    return this.store.patch(COLLECTION, itemId, {
      status: 'done',
      completedAt: this.clock.now(),
      projectId: projectId ?? current.projectId ?? null,
    });
  }

  /** Grant authorization to a held item so `next()` can serve it. */
  authorize(itemId) {
    const current = this.store.get(COLLECTION, itemId);
    if (!current) return null;
    return this.store.patch(COLLECTION, itemId, { authorized: true });
  }

  /** How much work is actually available to pick up. */
  size() { return this.pending().length; }

  _nextSeq() {
    let max = 0;
    for (const item of this.store.all(COLLECTION)) {
      const seq = Number(item?.seq ?? 0);
      if (Number.isFinite(seq) && seq > max) max = seq;
    }
    return max + 1;
  }
}
