import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { FakeClock } from '../../src/core/clock.js';
import { EventBus } from '../../src/core/bus.js';
import { Store } from '../../src/core/store.js';
import { Backlog } from '../../src/orchestrator/backlog.js';

/** In-memory stand-in with the same surface as src/core/store.js. */
class MemoryStore {
  constructor() { this.collections = new Map(); }
  _col(c) { if (!this.collections.has(c)) this.collections.set(c, new Map()); return this.collections.get(c); }
  put(c, id, v) { this._col(c).set(id, v); return v; }
  patch(c, id, partial) { return this.put(c, id, { ...(this.get(c, id) ?? {}), ...partial }); }
  get(c, id) { const v = this._col(c).get(id); return v === undefined ? null : v; }
  delete(c, id) { this._col(c).delete(id); }
  all(c) { return [...this._col(c).values()]; }
  ids(c) { return [...this._col(c).keys()]; }
  find(c, p) { return this.all(c).filter(p); }
  flush() {}
  compact() {}
}

function harness() {
  const clock = new FakeClock(1_700_000_000_000);
  const bus = new EventBus();
  const store = new MemoryStore();
  const events = [];
  bus.on('*', (evt) => events.push(evt));
  return { clock, bus, store, events, backlog: new Backlog({ store, bus, clock }) };
}

const typed = (events, type) => events.filter((e) => e.type === type);

test('add stores a pending, authorized item and defaults the goal to the title', () => {
  const { backlog, store, clock } = harness();
  const item = backlog.add({ title: '  Add   dark mode  ', source: 'chat' });

  assert.equal(item.title, 'Add dark mode');
  assert.equal(item.goal, 'Add dark mode');
  assert.equal(item.source, 'chat');
  assert.equal(item.authorized, true);
  assert.equal(item.status, 'pending');
  assert.equal(item.createdAt, clock.now());
  assert.equal(item.pickedAt, null);
  assert.equal(item.completedAt, null);
  assert.equal(store.get('backlog', item.id).id, item.id);

  const withGoal = backlog.add({ title: 'Ship v2', goal: 'Cut the release and publish notes' });
  assert.equal(withGoal.goal, 'Cut the release and publish notes');
});

test('add rejects an empty title instead of inventing one', () => {
  const { backlog, store } = harness();
  assert.throws(() => backlog.add({ title: '   ' }), TypeError);
  assert.throws(() => backlog.add({}), TypeError);
  assert.equal(store.all('backlog').length, 0);
});

test('next() is FIFO over pending items and emits backlog.picked', () => {
  const { backlog, events } = harness();
  const a = backlog.add({ title: 'First' });
  const b = backlog.add({ title: 'Second' });
  const c = backlog.add({ title: 'Third' });

  assert.equal(backlog.next().id, a.id);
  assert.equal(backlog.next().id, b.id);
  assert.equal(backlog.next().id, c.id);

  const picked = typed(events, 'backlog.picked');
  assert.deepEqual(picked.map((e) => e.payload.itemId), [a.id, b.id, c.id]);
  assert.deepEqual(picked.map((e) => e.payload.title), ['First', 'Second', 'Third']);
  assert.equal(typed(events, 'backlog.empty').length, 0);
});

test('next() marks the picked item and stamps pickedAt', () => {
  const { backlog, store, clock } = harness();
  const item = backlog.add({ title: 'Wire up telemetry' });
  clock.set(clock.now() + 1234);
  const picked = backlog.next();

  assert.equal(picked.status, 'picked');
  assert.equal(picked.pickedAt, clock.now());
  assert.equal(store.get('backlog', item.id).status, 'picked');
  assert.equal(backlog.next(), null, 'a picked item is not served again');
});

test('next() skips unauthorized items and leaves them pending', () => {
  const { backlog, store, events } = harness();
  const held = backlog.add({ title: 'Refactor billing', authorized: false });
  const ok = backlog.add({ title: 'Fix the login bug' });

  assert.equal(backlog.next().id, ok.id, 'the authorized item is picked even though it is newer');
  assert.equal(store.get('backlog', held.id).status, 'pending');
  assert.equal(backlog.size(), 0, 'unauthorized work is not available work');

  assert.equal(backlog.next(), null);
  assert.equal(typed(events, 'backlog.picked').length, 1);
  assert.equal(typed(events, 'backlog.empty').length, 1);
  assert.equal(typed(events, 'backlog.empty')[0].payload.unauthorized, 1);
});

test('authorize() releases a held item to next()', () => {
  const { backlog } = harness();
  const held = backlog.add({ title: 'Refactor billing', authorized: false });
  assert.equal(backlog.next(), null);

  backlog.authorize(held.id);
  assert.equal(backlog.size(), 1);
  assert.equal(backlog.next().id, held.id);
});

test('next() on an empty backlog returns null and emits backlog.empty once per call', () => {
  const { backlog, store, events } = harness();

  assert.equal(backlog.next(), null);
  assert.equal(typed(events, 'backlog.empty').length, 1);

  assert.equal(backlog.next(), null);
  assert.equal(typed(events, 'backlog.empty').length, 2, 'exactly one event per call');

  assert.equal(typed(events, 'backlog.picked').length, 0);
  assert.equal(store.all('backlog').length, 0, 'never synthesizes work');
});

test('complete() finishes an item and records the project that did it', () => {
  const { backlog, store, clock } = harness();
  const item = backlog.add({ title: 'Add search' });
  backlog.next();
  clock.set(clock.now() + 60_000);

  const done = backlog.complete(item.id, { projectId: 'proj_1' });
  assert.equal(done.status, 'done');
  assert.equal(done.completedAt, clock.now());
  assert.equal(done.projectId, 'proj_1');
  assert.equal(store.get('backlog', item.id).status, 'done');
  assert.equal(backlog.complete('bk_missing'), null);
});

test('size() counts only the authorized pending work', () => {
  const { backlog } = harness();
  assert.equal(backlog.size(), 0);
  const a = backlog.add({ title: 'A' });
  backlog.add({ title: 'B' });
  backlog.add({ title: 'C', authorized: false });
  assert.equal(backlog.size(), 2);

  backlog.next();
  assert.equal(backlog.size(), 1);
  backlog.complete(a.id);
  assert.equal(backlog.size(), 1);
});

test('FIFO order is stable when several items share a timestamp', () => {
  const { backlog } = harness();
  const titles = ['one', 'two', 'three', 'four'];
  const added = titles.map((title) => backlog.add({ title }));
  assert.deepEqual(added.map((i) => i.createdAt), new Array(4).fill(added[0].createdAt));
  assert.deepEqual(backlog.items().map((i) => i.id), added.map((i) => i.id));

  const order = [backlog.next(), backlog.next(), backlog.next(), backlog.next()];
  assert.deepEqual(order.map((i) => i.title), titles);
});

test('the queue and its FIFO order survive a restart on the durable Store', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-backlog-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const clock = new FakeClock(9_000);
  const bus = new EventBus();
  const events = [];
  bus.on('*', (e) => events.push(e));

  const before = new Backlog({ store: new Store({ dir, clock }), bus, clock });
  before.add({ title: 'Older' });
  before.add({ title: 'Newer' });

  const after = new Backlog({ store: new Store({ dir, clock }), bus, clock });
  assert.equal(after.size(), 2);
  assert.equal(after.next().title, 'Older');
  assert.equal(after.next().title, 'Newer');
  assert.equal(after.next(), null);
  assert.equal(typed(events, 'backlog.picked').length, 2);
  assert.equal(typed(events, 'backlog.empty').length, 1);
});

// --- Added by audit -------------------------------------------------------

test('an item stored without an explicit authorized flag is still available work', () => {
  const { backlog, store, clock, events } = harness();
  // `add` documents `authorized = true`, so only an explicit `false` holds an
  // item back. A record that reached the store without the flag (an older
  // writer, a seeded fixture, a hand-edited state file) must not be stranded
  // in `pending` forever, invisible to both next() and size().
  store.put('backlog', 'bk_legacy', {
    id: 'bk_legacy', title: 'Imported item', goal: 'Imported item', source: 'import',
    status: 'pending', seq: 1, projectId: null, createdAt: clock.now(), pickedAt: null, completedAt: null,
  });

  assert.equal(backlog.size(), 1, 'a flagless item is authorized by default');
  assert.deepEqual(backlog.pending().map((i) => i.id), ['bk_legacy']);
  assert.equal(backlog.next().id, 'bk_legacy');
  assert.equal(store.get('backlog', 'bk_legacy').status, 'picked');

  const held = backlog.add({ title: 'Held for approval', authorized: false });
  assert.equal(backlog.size(), 0, 'an explicit false is still the only thing that holds work back');
  assert.equal(backlog.next(), null);

  const empty = typed(events, 'backlog.empty').at(-1).payload;
  assert.equal(empty.size, 0, 'the empty payload reports the real available count');
  assert.equal(empty.unauthorized, 1, 'and says how much work is waiting on authorization');
  assert.equal(store.get('backlog', held.id).status, 'pending', 'held work stays pending, it is not dropped');
});

test('authorize() on an unknown id changes nothing and returns null', () => {
  const { backlog, store } = harness();
  assert.equal(backlog.authorize('bk_missing'), null);
  assert.equal(store.all('backlog').length, 0, 'never synthesizes a record to authorize');
});
