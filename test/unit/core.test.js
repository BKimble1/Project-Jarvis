import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventBus } from '../../src/core/bus.js';
import { Store } from '../../src/core/store.js';
import { FakeClock, SystemClock } from '../../src/core/clock.js';
import { newId, dedupeKey } from '../../src/core/ids.js';
import { createLogger } from '../../src/core/logger.js';

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-core-'));
}

test('bus stamps a monotonic sequence and replays only newer events', () => {
  const bus = new EventBus();
  const a = bus.emit('one', { x: 1 });
  const b = bus.emit('two', { x: 2 });
  assert.equal(a.seq, 1);
  assert.equal(b.seq, 2);
  assert.deepEqual(bus.since(1).map((e) => e.type), ['two']);
  assert.deepEqual(bus.since(2), []);
  assert.equal(bus.lastSeq, 2);
});

test('bus delivers to typed and wildcard handlers and unsubscribes cleanly', () => {
  const bus = new EventBus();
  const typed = [];
  const all = [];
  const off = bus.on('ping', (e) => typed.push(e.type));
  bus.on('*', (e) => all.push(e.type));

  bus.emit('ping');
  bus.emit('pong');
  off();
  bus.emit('ping');

  assert.deepEqual(typed, ['ping']);
  assert.deepEqual(all, ['ping', 'pong', 'ping']);
});

test('bus survives a throwing handler without dropping the rest', () => {
  const bus = new EventBus();
  const seen = [];
  const errors = [];
  const originalError = console.error;
  console.error = (...args) => errors.push(args);
  try {
    bus.on('x', () => { throw new Error('boom'); });
    bus.on('x', () => seen.push('second handler still ran'));
    bus.emit('x');
  } finally {
    console.error = originalError;
  }
  assert.deepEqual(seen, ['second handler still ran']);
  assert.equal(errors.length, 1);
});

test('bus history is bounded', () => {
  const bus = new EventBus({ historyLimit: 3 });
  for (let i = 0; i < 10; i++) bus.emit('e', { i });
  assert.equal(bus.since(0).length, 3);
  assert.equal(bus.since(0)[0].payload.i, 7);
});

test('store round-trips values and reports collections', () => {
  const dir = tmpdir();
  const store = new Store({ dir, clock: new FakeClock(1000) });
  store.put('projects', 'p1', { id: 'p1', title: 'One' });
  store.put('projects', 'p2', { id: 'p2', title: 'Two' });
  store.patch('projects', 'p1', { title: 'One (edited)' });

  assert.equal(store.get('projects', 'p1').title, 'One (edited)');
  assert.equal(store.all('projects').length, 2);
  assert.deepEqual(store.ids('projects').sort(), ['p1', 'p2']);
  assert.equal(store.find('projects', (p) => p.title.startsWith('Two')).length, 1);
  assert.equal(store.get('projects', 'missing'), null);

  store.delete('projects', 'p2');
  assert.equal(store.all('projects').length, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('store replays its journal after a crash that lost the snapshot', () => {
  const dir = tmpdir();
  const clock = new FakeClock(1000);
  const store = new Store({ dir, clock, autoflush: false });
  store.put('tasks', 't1', { id: 't1', status: 'running' });
  store.put('tasks', 't2', { id: 't2', status: 'pending' });
  // No flush: simulate the process dying before the snapshot was written.
  assert.equal(fs.existsSync(path.join(dir, 'state.json')), false);

  const revived = new Store({ dir, clock });
  assert.equal(revived.get('tasks', 't1').status, 'running');
  assert.equal(revived.get('tasks', 't2').status, 'pending');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('store recovers from a corrupt snapshot by rebuilding from the journal', () => {
  const dir = tmpdir();
  const clock = new FakeClock(1000);
  const store = new Store({ dir, clock });
  store.put('a', '1', { v: 1 });
  store.flush();
  fs.writeFileSync(path.join(dir, 'state.json'), '{not json');

  const revived = new Store({ dir, clock });
  assert.deepEqual(revived.get('a', '1'), { v: 1 }, 'rebuilt from the journal');
  assert.ok(fs.existsSync(path.join(dir, 'state.json.corrupt')), 'the bad snapshot is kept for forensics');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('store compaction keeps state and empties the journal', () => {
  const dir = tmpdir();
  const store = new Store({ dir, clock: new FakeClock(1000) });
  for (let i = 0; i < 50; i++) store.put('e', `k${i}`, { i });
  store.compact();
  assert.equal(fs.readFileSync(path.join(dir, 'journal.jsonl'), 'utf8'), '');
  const revived = new Store({ dir, clock: new FakeClock(2000) });
  assert.equal(revived.all('e').length, 50);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('FakeClock advances virtual time and resolves sleeps in order', async () => {
  const clock = new FakeClock(0);
  const order = [];
  clock.sleep(300).then(() => order.push(300));
  clock.sleep(100).then(() => order.push(100));
  clock.sleep(200).then(() => order.push(200));

  await clock.advance(250);
  assert.deepEqual(order, [100, 200]);
  assert.equal(clock.now(), 250);

  await clock.advance(100);
  assert.deepEqual(order, [100, 200, 300]);
  assert.equal(clock.now(), 350);
});

test('SystemClock reports a real timezone', () => {
  const tz = new SystemClock().timezone();
  assert.equal(typeof tz, 'string');
  assert.ok(tz.length > 0);
});

test('ids are unique and dedupe keys are stable', () => {
  const ids = new Set(Array.from({ length: 500 }, () => newId('t')));
  assert.equal(ids.size, 500);
  assert.ok([...ids][0].startsWith('t_'));
  assert.equal(dedupeKey('a', 'b', null), dedupeKey('a', 'b', undefined));
  assert.notEqual(dedupeKey('a', 'b'), dedupeKey('a', 'c'));
});

test('logger respects its level and scopes children', () => {
  const lines = [];
  const sink = { log: (...a) => lines.push(a.join(' ')), error: (...a) => lines.push(a.join(' ')) };
  const log = createLogger('root', { level: 'warn', sink });
  log.debug('hidden');
  log.info('hidden');
  log.warn('shown');
  log.child('sub').error('also shown');

  assert.equal(lines.length, 2);
  assert.match(lines[0], /^\[warn\] root: shown$/);
  assert.match(lines[1], /^\[error\] root:sub: also shown$/);
});
