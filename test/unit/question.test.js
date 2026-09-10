import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { FakeClock } from '../../src/core/clock.js';
import { EventBus } from '../../src/core/bus.js';
import { Store } from '../../src/core/store.js';
import { QuestionGate, normalizeQuestionText } from '../../src/orchestrator/question.js';

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

function harness({ startMs = 1_700_000_000_000 } = {}) {
  const clock = new FakeClock(startMs);
  const bus = new EventBus();
  const store = new MemoryStore();
  const events = [];
  bus.on('*', (evt) => events.push(evt));
  return { clock, bus, store, events, gate: new QuestionGate({ store, bus, clock }) };
}

const asked = (events) => events.filter((e) => e.type === 'question.asked');
const answered = (events) => events.filter((e) => e.type === 'question.answered');

test('ask stores a contract-shaped question and emits question.asked once', () => {
  const { gate, store, events, clock } = harness();
  const q = gate.ask({
    projectId: 'p1', taskId: 't1', text: 'Which database should I use?',
    recommendedDefault: 'sqlite', options: ['sqlite', 'postgres'],
  });

  assert.deepEqual(Object.keys(q).sort(), [
    'answer', 'answeredAt', 'askedAt', 'id', 'options', 'projectId', 'recommendedDefault', 'status', 'taskId', 'text',
  ]);
  assert.equal(q.projectId, 'p1');
  assert.equal(q.taskId, 't1');
  assert.equal(q.status, 'open');
  assert.equal(q.answer, null);
  assert.equal(q.answeredAt, null);
  assert.equal(q.askedAt, clock.now());
  assert.deepEqual(q.options, ['sqlite', 'postgres']);
  assert.equal(store.all('questions').length, 1);

  assert.equal(asked(events).length, 1);
  assert.equal(asked(events)[0].payload.projectId, 'p1');
  assert.equal(asked(events)[0].payload.questionId, q.id);
  assert.equal(asked(events)[0].payload.text, 'Which database should I use?');
});

test('ask is idempotent per (projectId, normalized text) while the question is open', () => {
  const { gate, store, events } = harness();
  const first = gate.ask({ projectId: 'p1', text: 'Deploy to staging first?' });
  const again = gate.ask({ projectId: 'p1', text: '  deploy   to STAGING first  ' });
  const third = gate.ask({ projectId: 'p1', text: 'Deploy to staging first' });

  assert.equal(again.id, first.id, 'same question object id');
  assert.equal(third.id, first.id);
  assert.equal(store.all('questions').length, 1, 'no duplicate record');
  assert.equal(asked(events).length, 1, 'no second question.asked event');
});

test('the same text for a different project is a different question', () => {
  const { gate, store, events } = harness();
  const a = gate.ask({ projectId: 'p1', text: 'Which framework?' });
  const b = gate.ask({ projectId: 'p2', text: 'Which framework?' });
  assert.notEqual(a.id, b.id);
  assert.equal(store.all('questions').length, 2);
  assert.equal(asked(events).length, 2);
});

test('once answered, the same text may be asked again as a new question', () => {
  const { gate, events } = harness();
  const first = gate.ask({ projectId: 'p1', text: 'Retry the flaky test?' });
  gate.answer(first.id, 'yes');
  const second = gate.ask({ projectId: 'p1', text: 'Retry the flaky test?' });

  assert.notEqual(second.id, first.id);
  assert.equal(second.status, 'open');
  assert.equal(asked(events).length, 2);
});

test('answer records the answer, emits question.answered, and is a no-op the second time', () => {
  const { gate, store, events, clock } = harness();
  const q = gate.ask({ projectId: 'p1', taskId: 't9', text: 'Use feature flags?' });
  clock.set(clock.now() + 5_000);

  const updated = gate.answer(q.id, 'yes, behind a flag');
  assert.equal(updated.status, 'answered');
  assert.equal(updated.answer, 'yes, behind a flag');
  assert.equal(updated.answeredAt, clock.now());
  assert.equal(store.get('questions', q.id).status, 'answered');

  assert.equal(answered(events).length, 1);
  assert.equal(answered(events)[0].payload.projectId, 'p1');
  assert.equal(answered(events)[0].payload.questionId, q.id);
  assert.equal(answered(events)[0].payload.taskId, 't9');
  assert.equal(answered(events)[0].payload.answer, 'yes, behind a flag');

  const repeat = gate.answer(q.id, 'no');
  assert.equal(repeat.answer, 'yes, behind a flag', 'first answer wins');
  assert.equal(answered(events).length, 1, 'no second question.answered event');
});

test('answer on an unknown id throws', () => {
  const { gate } = harness();
  assert.throws(() => gate.answer('q_missing', 'x'), /unknown question q_missing/);
});

test('open() lists only open questions for the project, oldest first', () => {
  const { gate, clock } = harness();
  const a = gate.ask({ projectId: 'p1', text: 'First?' });
  clock.set(clock.now() + 1000);
  const b = gate.ask({ projectId: 'p1', text: 'Second?' });
  clock.set(clock.now() + 1000);
  gate.ask({ projectId: 'p2', text: 'Other project?' });
  gate.answer(a.id, 'done');

  assert.deepEqual(gate.open('p1').map((q) => q.id), [b.id]);
  assert.equal(gate.open('p2').length, 1);
  assert.equal(gate.open().length, 2, 'no argument means every project');
});

test('ask validates its inputs rather than storing junk', () => {
  const { gate, store } = harness();
  assert.throws(() => gate.ask({ text: 'no project' }), TypeError);
  assert.throws(() => gate.ask({ projectId: 'p1', text: '   ' }), TypeError);
  assert.throws(() => gate.ask({ projectId: 'p1' }), TypeError);
  assert.equal(store.all('questions').length, 0);
});

test('isMaterial: a reasonable default means decide, not ask', () => {
  const { gate } = harness();
  assert.equal(gate.isMaterial({ text: 'Tabs or spaces?', recommendedDefault: 'spaces' }), false);
  assert.equal(gate.isMaterial({ text: 'Tabs or spaces?', recommendedDefault: 'spaces', impact: 'low' }), false);
  assert.equal(gate.isMaterial({ text: 'Tabs or spaces?', recommendedDefault: 'spaces', impact: 'medium' }), false);
  assert.equal(gate.isMaterial({ text: 'Retry limit?', recommendedDefault: 3 }), false);
  assert.equal(gate.isMaterial({ text: 'Enable cache?', recommendedDefault: false }), false);
});

test('isMaterial: high impact or no reasonable default means ask', () => {
  const { gate } = harness();
  assert.equal(gate.isMaterial({ text: 'Delete the production bucket?', recommendedDefault: 'no', impact: 'high' }), true);
  assert.equal(gate.isMaterial({ text: 'Which payment provider?' }), true);
  assert.equal(gate.isMaterial({ text: 'Which payment provider?', recommendedDefault: null }), true);
  assert.equal(gate.isMaterial({ text: 'Which payment provider?', recommendedDefault: '   ' }), true);
  assert.equal(gate.isMaterial({ text: 'Which payment provider?', recommendedDefault: [] }), true);
});

test('isMaterial: empty or whitespace text is never material', () => {
  const { gate } = harness();
  assert.equal(gate.isMaterial({ text: '' }), false);
  assert.equal(gate.isMaterial({ text: '   \n\t ' }), false);
  assert.equal(gate.isMaterial({}), false);
  assert.equal(gate.isMaterial({ text: '  ', impact: 'high' }), false);
  assert.equal(gate.isMaterial(), false);
});

test('normalizeQuestionText collapses case, whitespace and trailing punctuation', () => {
  assert.equal(normalizeQuestionText('  Use   Postgres?  '), 'use postgres');
  assert.equal(normalizeQuestionText('Use postgres!'), 'use postgres');
  assert.equal(normalizeQuestionText(null), '');
});

test('idempotency survives a restart backed by the durable Store', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-question-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const clock = new FakeClock(5_000);
  const bus = new EventBus();
  const events = [];
  bus.on('*', (e) => events.push(e));

  const first = new QuestionGate({ store: new Store({ dir, clock }), bus, clock }).ask({ projectId: 'p1', text: 'Ship it?' });

  const reloaded = new QuestionGate({ store: new Store({ dir, clock }), bus, clock });
  const again = reloaded.ask({ projectId: 'p1', text: 'ship it' });

  assert.equal(again.id, first.id);
  assert.equal(asked(events).length, 1);
  assert.deepEqual(reloaded.open('p1').map((q) => q.id), [first.id]);
});

// --- Added by audit -------------------------------------------------------
// The hardest requirement in this module is `ask` idempotency, and it has two
// failure directions that a single-phrasing test cannot separate: a duplicate
// slipping through, and two genuinely different questions collapsing onto one
// record (which loses a question the human never gets shown).

test('ask never splits one question and never merges two', () => {
  const { gate, store, events } = harness();

  // Each group is one question written several ways; the groups are different
  // questions. The last three normalize to nothing but punctuation.
  const groups = [
    ['Deploy to staging first?', '  deploy   to STAGING first  ', 'Deploy to staging first',
     'DEPLOY TO STAGING FIRST!', 'Deploy to staging first.'],
    ['Deploy to production first?', 'deploy to production first'],
    ['???'],
    ['...'],
    ['!'],
  ];

  const ids = groups.map((variants) => {
    const seen = variants.map((text) => gate.ask({ projectId: 'p1', text }).id);
    assert.equal(new Set(seen).size, 1, `every phrasing of ${JSON.stringify(variants[0])} must reuse one question`);
    return seen[0];
  });

  assert.equal(new Set(ids).size, groups.length, 'distinct questions must never collapse onto one id');
  assert.equal(store.all('questions').length, groups.length, 'exactly one stored record per distinct question');
  assert.equal(asked(events).length, groups.length, 'exactly one question.asked per distinct question');
  assert.deepEqual(asked(events).map((e) => e.payload.questionId), ids);
  assert.deepEqual(
    asked(events).map((e) => e.payload.text),
    ['Deploy to staging first?', 'Deploy to production first?', '???', '...', '!'],
    'the first phrasing is the one that is stored and announced',
  );
});

test('a duplicate ask leaves the stored question completely untouched', () => {
  const { gate, store, clock } = harness();
  const first = gate.ask({ projectId: 'p1', taskId: 't1', text: 'Use feature flags?', recommendedDefault: 'yes', options: ['yes', 'no'] });
  const snapshot = { ...first };

  clock.set(clock.now() + 90_000);
  const again = gate.ask({ projectId: 'p1', taskId: 't2', text: 'use feature flags', recommendedDefault: 'no', options: ['later'] });

  assert.equal(again.id, first.id);
  assert.deepEqual(again, snapshot, 'the duplicate must not re-stamp askedAt or overwrite taskId/default/options');
  assert.deepEqual(store.get('questions', first.id), snapshot);
});
