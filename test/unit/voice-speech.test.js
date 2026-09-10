import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { FakeClock } from '../../src/core/clock.js';
import { EventBus } from '../../src/core/bus.js';
import { Store } from '../../src/core/store.js';
import { SpeechService, salientId } from '../../src/voice/speech.js';
import { renderSentence } from '../../src/voice/policy.js';

const NOON = Date.UTC(2026, 0, 15, 12, 0);
const PROJECT_ID = 'prj_1';
const PROJECT_TITLE = 'the settings screen';

function harness({ settings = {}, startMs = NOON, timezone = 'UTC', batchWindowMs = 4000 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-speech-'));
  const clock = new FakeClock(startMs, timezone);
  const store = new Store({ dir, clock });
  const bus = new EventBus({ historyLimit: 100 });
  const spoken = [];
  bus.on('speech.say', (evt) => spoken.push(evt.payload));

  store.put('projects', PROJECT_ID, { id: PROJECT_ID, title: PROJECT_TITLE, status: 'active' });
  const speech = new SpeechService({ store, bus, clock, settings, batchWindowMs });

  return {
    dir, clock, store, bus, spoken, speech,
    revive: (over = {}) => new SpeechService({ store, bus, clock, settings, batchWindowMs, ...over }),
    // A real restart: a brand new Store reading the same directory off disk, so
    // nothing survives in memory that the persisted state does not carry.
    reboot: (over = {}) => new SpeechService({
      store: new Store({ dir, clock }), bus, clock, settings, batchWindowMs, ...over,
    }),
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

const completed = (taskId, title) => ({
  type: 'task.completed',
  payload: { projectId: PROJECT_ID, taskId, title, task: { id: taskId, title } },
});
const started = (taskId, title) => ({
  type: 'task.started',
  payload: { projectId: PROJECT_ID, taskId, title, task: { id: taskId, title } },
});
const delivered = (deliverableId = 'dlv_1') => ({
  type: 'project.delivered',
  payload: {
    projectId: PROJECT_ID,
    project: { id: PROJECT_ID, title: PROJECT_TITLE, status: 'delivered' },
    deliverable: { id: deliverableId, title: PROJECT_TITLE },
  },
});
const blocked = (reason = 'I need working credentials: the token expired.') => ({
  type: 'project.blocked',
  payload: { projectId: PROJECT_ID, project: { id: PROJECT_ID, title: PROJECT_TITLE, status: 'blocked' }, reason },
});
const asked = (questionId = 'q_1', text = 'Should sync be last-write-wins or merge?') => ({
  type: 'question.asked',
  payload: { projectId: PROJECT_ID, questionId, text, question: { id: questionId, text } },
});

function sentenceCount(text) {
  return String(text).trim().split(/(?<=[.!?])\s+/).filter(Boolean).length;
}

// ------------------------------------------------- invariant 1: speak once

test('the same event never produces a second utterance, even across a flush', (t) => {
  const h = harness();
  t.after(h.cleanup);

  const event = completed('tsk_1', 'Build the login form');

  assert.equal(h.speech.consider(event), null, 'minor progress is parked, not spoken');
  assert.equal(h.speech.consider(event), null, 'the duplicate is dropped');
  assert.equal(h.speech.batchSize(), 1, 'the duplicate never reached the batch');

  const item = h.speech.flushBatch();
  assert.equal(item.text, 'I built the login form.');
  assert.equal(h.spoken.length, 1);

  // Same event again, now on the far side of the flush boundary.
  assert.equal(h.speech.consider(event), null);
  assert.equal(h.speech.batchSize(), 0, 'an already spoken key is not re-queued');
  assert.equal(h.speech.flushBatch(), null);
  assert.equal(h.spoken.length, 1, 'still exactly one utterance for one event');
});

test('a re-broadcast delivery is spoken once, whatever deliverable it names', (t) => {
  const h = harness();
  t.after(h.cleanup);

  const first = h.speech.consider(delivered('dlv_real'));
  assert.equal(first.text, `I delivered ${PROJECT_TITLE}.`);
  assert.equal(first.priority, 'high');

  assert.equal(h.speech.consider(delivered('dlv_real')), null);
  assert.equal(h.speech.consider(delivered('x')), null, 'the delivery is about the project, not the deliverable id');
  assert.equal(h.spoken.filter((s) => /deliver/i.test(s.text)).length, 1);
});

test('dedupe keys are distinct per event and per project', (t) => {
  const h = harness();
  t.after(h.cleanup);

  h.speech.consider(delivered());
  h.speech.consider(blocked());
  h.speech.consider(asked());
  h.speech.consider(completed('tsk_1', 'Build autosave'));
  h.speech.consider(completed('tsk_2', 'Build the print view'));
  h.speech.flushBatch();

  const keys = h.spoken.map((s) => s.key);
  assert.equal(keys.length, 4);
  assert.equal(new Set(keys).size, keys.length, 'every spoken item has a distinct key');
  assert.equal(keys[0], `project.delivered|${PROJECT_ID}|delivered`);
  assert.equal(keys[1], `project.blocked|${PROJECT_ID}|I need working credentials: the token expired.`);
  assert.equal(keys[2], `question.asked|${PROJECT_ID}|q_1`);
  assert.equal(salientId('task.completed', { taskId: 'tsk_9' }), 'tsk_9');

  // Two projects doing the same work are two pieces of news, not one: the
  // project id is part of the key, so neither silences the other.
  h.store.put('projects', 'prj_2', { id: 'prj_2', title: 'the deploy script' });
  const twin = (projectId) => ({ type: 'project.delivered', payload: { projectId, project: { id: projectId, status: 'delivered' } } });
  assert.equal(h.speech.consider(twin(PROJECT_ID)), null, 'this project was already announced');
  const other = h.speech.consider(twin('prj_2'));
  assert.equal(other.key, 'project.delivered|prj_2|delivered');
  assert.equal(other.text, 'I delivered the deploy script.');
});

test('the persisted key set survives a restart, so nothing is spoken twice', (t) => {
  const h = harness();
  t.after(h.cleanup);

  assert.ok(h.speech.consider(delivered()));
  assert.equal(h.spoken.length, 1);

  const revived = h.revive();
  assert.equal(revived.consider(delivered()), null, 'a fresh service still knows it was said');
  assert.equal(h.spoken.length, 1);
});

// --------------------------------------- invariant 2: no replay on refresh

test('acknowledging a sequence retires everything up to it, and it persists', (t) => {
  const h = harness();
  t.after(h.cleanup);

  h.speech.consider(delivered());
  h.speech.consider(completed('tsk_1', 'Build autosave'));
  h.speech.consider(completed('tsk_2', 'Build the print view'));
  h.speech.flushBatch();

  const pending = h.speech.unspoken(0);
  assert.equal(pending.length, 2, 'a delivery plus one batched summary');
  assert.deepEqual(pending.map((i) => i.seq), [1, 2]);
  assert.deepEqual(h.speech.pending(), pending);

  const lastSeq = pending.at(-1).seq;
  assert.equal(h.speech.acknowledge(lastSeq), lastSeq);
  assert.deepEqual(h.speech.unspoken(0), [], 'nothing is re-offered after acknowledgement');
  assert.deepEqual(h.speech.unspoken(lastSeq), [], 'nothing is re-offered by sequence either');
  assert.deepEqual(h.speech.pending(), []);

  const revived = h.revive();
  assert.deepEqual(revived.unspoken(0), [], 'a restart does not replay old speech');
  assert.equal(revived.acknowledgedSeq, lastSeq);
  assert.equal(revived.lastSeq, lastSeq, 'the sequence continues where it left off');
});

test('unspoken returns only strictly newer, unacknowledged items', (t) => {
  const h = harness();
  t.after(h.cleanup);

  const first = h.speech.consider(delivered());
  h.speech.acknowledge(first.seq);

  const second = h.speech.consider(blocked());
  assert.deepEqual(h.speech.unspoken(0).map((i) => i.seq), [second.seq], 'only the new item is offered');
  assert.deepEqual(h.speech.unspoken(first.seq).map((i) => i.seq), [second.seq]);
  assert.deepEqual(h.speech.unspoken(second.seq), [], 'the client cursor also filters');

  // A reconnecting client that is behind its own acknowledgement gets nothing old.
  h.speech.acknowledge(second.seq);
  assert.deepEqual(h.speech.unspoken(0), []);
});

test('acknowledgement is a high-water mark and never moves backwards', (t) => {
  const h = harness();
  t.after(h.cleanup);

  const a = h.speech.consider(delivered());
  const b = h.speech.consider(blocked());
  h.speech.acknowledge(b.seq);
  assert.equal(h.speech.acknowledge(a.seq), b.seq, 'a stale ack does not reopen older items');
  assert.equal(h.speech.acknowledge('nonsense'), b.seq);
  assert.deepEqual(h.speech.unspoken(0), []);
});

test('items returned to callers are plain SpeechItems', (t) => {
  const h = harness();
  t.after(h.cleanup);

  const item = h.speech.consider(delivered());
  assert.deepEqual(Object.keys(item).sort(), ['at', 'key', 'priority', 'seq', 'text']);
  assert.equal(item.at, NOON);
  assert.deepEqual(h.speech.unspoken(0)[0], item);
  assert.deepEqual(h.spoken[0], item);
});

// --------------------------------------------- invariant 3: batch the small

test('several completions inside the window collapse into one sentence', (t) => {
  const h = harness();
  t.after(h.cleanup);

  assert.equal(h.speech.consider(completed('tsk_1', 'Build validation')), null);
  assert.equal(h.speech.consider(completed('tsk_2', 'Build autosave')), null);
  assert.equal(h.speech.consider(completed('tsk_3', 'Build the summary step')), null);
  assert.equal(h.spoken.length, 0, 'minor progress says nothing on its own');
  assert.equal(h.speech.batchSize(), 3);

  const item = h.speech.flushBatch();
  assert.equal(item.text, 'I finished 3 tasks on the settings screen.');
  assert.equal(item.priority, 'normal');
  assert.equal(h.spoken.length, 1, 'three events, one sentence');
  assert.equal(h.speech.flushBatch(), null, 'an empty batch says nothing');
});

test('task starts and phase changes never speak individually', (t) => {
  const h = harness();
  t.after(h.cleanup);

  h.speech.consider(started('tsk_1', 'Build validation'));
  h.speech.consider({ type: 'project.phase', payload: { projectId: PROJECT_ID, phase: 'implementing' } });
  assert.equal(h.spoken.length, 0);

  const item = h.speech.flushBatch();
  assert.equal(item.text, 'I am building the settings screen.', 'the phase is the informative part');
  assert.equal(h.spoken.filter((s) => /^I (started|began) /i.test(s.text)).length, 0);
});

test('a window of starts alone summarises as work in hand, never as "I started"', (t) => {
  const h = harness();
  t.after(h.cleanup);

  h.speech.consider(started('tsk_1', 'Build validation'));
  h.speech.consider(started('tsk_2', 'Build autosave'));
  const item = h.speech.flushBatch();
  assert.equal(item.text, 'I am working on the settings screen.');
  assert.equal(/^I (started|began) /i.test(item.text), false);
});

test('completions across projects are summarised honestly', (t) => {
  const h = harness();
  t.after(h.cleanup);
  h.store.put('projects', 'prj_2', { id: 'prj_2', title: 'the deploy script' });

  h.speech.consider(completed('tsk_1', 'Build validation'));
  h.speech.consider(completed('tsk_2', 'Build autosave'));
  h.speech.consider({ type: 'task.completed', payload: { projectId: 'prj_2', taskId: 'tsk_3', title: 'Build the uploader' } });

  const item = h.speech.flushBatch();
  assert.equal(item.text, 'I finished 3 tasks across 2 projects.');
});

test('a batch older than the window rolls over when the next event arrives', (t) => {
  const h = harness({ batchWindowMs: 4000 });
  t.after(h.cleanup);

  h.speech.consider(completed('tsk_1', 'Build validation'));
  h.speech.consider(completed('tsk_2', 'Build autosave'));
  assert.equal(h.spoken.length, 0);

  h.clock.set(NOON + 5000);
  h.speech.consider(completed('tsk_3', 'Build the print view'));

  assert.equal(h.spoken.length, 1, 'the stale window was spoken before the new one opened');
  assert.equal(h.spoken[0].text, 'I finished 2 tasks on the settings screen.');
  assert.equal(h.speech.batchSize(), 1);

  const second = h.speech.flushBatch();
  assert.equal(second.text, 'I built the print view.');
  assert.equal(second.at, NOON + 5000);
});

test('important events jump the queue while a batch is still filling', (t) => {
  const h = harness();
  t.after(h.cleanup);

  h.speech.consider(completed('tsk_1', 'Build validation'));
  const question = h.speech.consider(asked());
  const block = h.speech.consider(blocked());

  assert.equal(question.text, 'I need to know: Should sync be last-write-wins or merge?');
  assert.equal(question.priority, 'high');
  assert.equal(block.priority, 'high');
  assert.equal(h.speech.batchSize(), 1, 'important events are never parked');
  assert.deepEqual(h.spoken.map((s) => s.seq), [1, 2]);
});

// --------------------------------------------------------- mute and quiet

test('mute suppresses everything, blockers and questions included', (t) => {
  const h = harness({ settings: { muted: true } });
  t.after(h.cleanup);

  assert.equal(h.speech.consider(blocked()), null);
  assert.equal(h.speech.consider(asked()), null);
  assert.equal(h.speech.consider(delivered()), null);
  assert.equal(h.speech.consider(completed('tsk_1', 'Build autosave')), null);
  assert.equal(h.speech.flushBatch(), null);
  assert.equal(h.spoken.length, 0, 'mute wins over everything');
  assert.deepEqual(h.speech.unspoken(0), []);

  h.speech.setSettings({ muted: false });
  assert.equal(h.speech.consider(blocked()).priority, 'high', 'unmuting restores speech');
  assert.equal(h.spoken.length, 1);
});

test('quiet hours silence routine speech but let blockers and questions through', (t) => {
  const h = harness({
    startMs: Date.UTC(2026, 0, 15, 23, 30),
    settings: { quietHours: { start: '22:00', end: '07:00', enabled: true, timezone: 'UTC' } },
  });
  t.after(h.cleanup);

  assert.equal(h.speech.consider(delivered()), null, 'a delivery can wait until morning');
  assert.equal(h.speech.consider(completed('tsk_1', 'Build autosave')), null);
  assert.equal(h.speech.batchSize(), 0, 'suppressed progress is not even queued');
  assert.equal(h.speech.flushBatch(), null);

  assert.equal(h.speech.consider(blocked()).priority, 'high');
  assert.equal(h.speech.consider(asked()).priority, 'high');
  assert.equal(h.spoken.length, 2);
  assert.equal(h.spoken.every((s) => s.priority === 'high'), true, 'nothing routine was spoken');
});

test('a batch gathered before bedtime is not fired off after it', (t) => {
  const h = harness({
    startMs: Date.UTC(2026, 0, 15, 21, 59),
    settings: { quietHours: { start: '22:00', end: '07:00', enabled: true, timezone: 'UTC' } },
  });
  t.after(h.cleanup);

  h.speech.consider(completed('tsk_1', 'Build validation'));
  h.speech.consider(completed('tsk_2', 'Build autosave'));
  assert.equal(h.speech.batchSize(), 2);

  h.clock.set(Date.UTC(2026, 0, 15, 22, 30));
  assert.equal(h.speech.flushBatch(), null, 'quiet hours are re-checked at speaking time');
  assert.equal(h.spoken.length, 0);
});

test('setSettings merges quiet hours instead of replacing them', (t) => {
  const h = harness({
    startMs: Date.UTC(2026, 0, 15, 23, 30),
    settings: { quietHours: { start: '22:00', end: '07:00', enabled: false, timezone: 'UTC' } },
  });
  t.after(h.cleanup);

  assert.ok(h.speech.consider(delivered()), 'quiet hours are off to begin with');
  h.speech.setSettings({ quietHours: { enabled: true } });
  assert.equal(h.speech.settings.quietHours.start, '22:00', 'the window survived the partial update');
  assert.equal(h.speech.consider(completed('tsk_1', 'Build autosave')), null);
});

// ------------------------------------------------- one renderer, one voice

test('the spoken text is exactly the sentence the shared renderer gives chat', (t) => {
  const h = harness();
  t.after(h.cleanup);

  const cases = [
    delivered(),
    blocked(),
    asked(),
    { type: 'feature.completed', payload: { projectId: PROJECT_ID, taskId: 'tsk_7', title: 'Build autosave' } },
  ];

  for (const event of cases) {
    const item = h.speech.consider(event);
    assert.ok(item, `${event.type} should be spoken`);
    const inChat = renderSentence(event, { projectTitle: PROJECT_TITLE });
    assert.equal(item.text, inChat, `${event.type}: spoken and on-screen text must be the same sentence`);
  }

  // And the batched path reuses the renderer for a single completion.
  h.speech.consider(completed('tsk_8', 'Build the print view'));
  const batched = h.speech.flushBatch();
  assert.equal(batched.text, renderSentence(completed('tsk_8', 'Build the print view'), { projectTitle: PROJECT_TITLE }));
});

test('every utterance is one short first-person sentence', (t) => {
  const h = harness();
  t.after(h.cleanup);

  h.speech.consider(delivered());
  h.speech.consider(blocked());
  h.speech.consider(asked());
  h.speech.consider(completed('tsk_1', 'Build validation'));
  h.speech.consider(completed('tsk_2', 'Build autosave'));
  h.speech.flushBatch();

  assert.equal(h.spoken.length, 4);
  for (const item of h.spoken) {
    assert.match(item.text, /^I /, `"${item.text}" must be first person`);
    assert.equal(sentenceCount(item.text), 1, `"${item.text}" must be exactly one sentence`);
    // 120 chars is the cap; only a question is allowed the longer 180 so a real
    // question is not cut off mid-word.
    const cap = item.text.startsWith('I need to know:') ? 180 : 120;
    assert.ok(item.text.length <= cap, `"${item.text}" is ${item.text.length} chars — too long to speak`);
    assert.equal(/[*`#]|\n/.test(item.text), false, `"${item.text}" must be plain speech`);
    assert.equal(/\p{Extended_Pictographic}/u.test(item.text), false);
    assert.ok(['high', 'normal'].includes(item.priority));
    assert.equal(typeof item.at, 'number');
  }
});

// --------------------------------------------------------------- plumbing

test('speech ignores its own events so an utterance cannot feed itself', (t) => {
  const h = harness();
  t.after(h.cleanup);

  h.bus.on('*', (evt) => h.speech.consider(evt));
  const item = h.speech.consider(delivered());
  assert.equal(h.spoken.length, 1);
  assert.equal(h.speech.consider({ type: 'speech.say', payload: item }), null);
  assert.equal(h.spoken.length, 1);
});

test('the service works without a bus and refuses to run without its collaborators', (t) => {
  const h = harness();
  t.after(h.cleanup);

  const headless = new SpeechService({ store: h.store, clock: h.clock });
  const item = headless.consider(delivered());
  assert.equal(item.text, `I delivered ${PROJECT_TITLE}.`);

  assert.throws(() => new SpeechService({ clock: h.clock }), /store is required/);
  assert.throws(() => new SpeechService({ store: h.store }), /clock is required/);
});

test('history is bounded and old items are dropped from the store', (t) => {
  const h = harness();
  t.after(h.cleanup);

  const speech = new SpeechService({ store: h.store, bus: h.bus, clock: h.clock, maxItems: 3 });
  for (let i = 0; i < 6; i++) {
    speech.consider({ type: 'project.blocked', payload: { projectId: PROJECT_ID, reason: `I need key number ${i}.` } });
  }
  assert.equal(speech.lastSeq, 6);
  assert.deepEqual(speech.history(10).map((i) => i.seq), [4, 5, 6]);
  assert.deepEqual(speech.history(2).map((i) => i.seq), [5, 6]);
  assert.deepEqual(speech.history(0), [], 'asking for none returns none, not everything');
  assert.equal(h.store.get('speech', 'sp_1'), null, 'trimmed items leave the store too');
  assert.ok(h.store.get('speech', 'sp_6'));
});

// ================================================================= the hard
// Two extra tests for the two requirements most likely to break subtly, plus
// the window arithmetic that decides when a batch is spoken.

test('one delivery stays one utterance however the payload drifts, and across a real restart', (t) => {
  const h = harness();
  t.after(h.cleanup);

  const first = h.speech.consider(delivered('dlv_real'));
  assert.equal(first.text, `I delivered ${PROJECT_TITLE}.`);
  assert.equal(first.key, `project.delivered|${PROJECT_ID}|delivered`);

  // The same news re-broadcast in every shape the orchestrator and the bus
  // replay can produce it in. None of these is a *different* delivery, so none
  // of them may earn a second key — in particular a broadcast made before the
  // project record was flipped to 'delivered' must not slip through.
  const rebroadcasts = [
    delivered('dlv_real'),
    delivered('dlv_other'),
    { type: 'project.delivered', payload: { projectId: PROJECT_ID, project: { id: PROJECT_ID, title: PROJECT_TITLE, status: 'active' } } },
    { type: 'project.delivered', payload: { projectId: PROJECT_ID, project: { id: PROJECT_ID, title: PROJECT_TITLE } } },
    { type: 'project.delivered', payload: { projectId: PROJECT_ID } },
  ];
  for (const event of rebroadcasts) {
    assert.equal(h.speech.consider(event), null, `re-broadcast ${JSON.stringify(event.payload.project ?? {})} spoke again`);
  }
  assert.equal(h.spoken.length, 1, 'six broadcasts of one delivery, one utterance');
  assert.equal(h.speech.lastSeq, 1, 'no sequence was burned on a duplicate');

  // And the guarantee is on disk, not in memory: a new Store over the same
  // directory, a new service, and the delivery is still already said.
  const rebooted = h.reboot();
  assert.equal(rebooted.consider(delivered('dlv_after_restart')), null, 'a restart forgot that it had spoken');
  assert.equal(rebooted.consider({ type: 'project.delivered', payload: { projectId: PROJECT_ID, project: { id: PROJECT_ID, status: 'active' } } }), null);
  assert.equal(h.spoken.length, 1, 'still exactly one delivery announcement');

  // A genuinely different piece of news about the same project still speaks.
  const evaluated = rebooted.consider({
    type: 'project.evaluated',
    payload: { projectId: PROJECT_ID, project: { id: PROJECT_ID, title: PROJECT_TITLE, status: 'evaluated' } },
  });
  assert.equal(evaluated.text, `I finished evaluating ${PROJECT_TITLE}.`);
  assert.equal(evaluated.seq, 2, 'the restarted service continues the sequence, it does not reuse it');
});

test('a refresh resumes exactly at the acknowledged sequence — one item owed, no more, no fewer', (t) => {
  const h = harness();
  t.after(h.cleanup);

  const a = h.speech.consider(delivered());
  const b = h.speech.consider(blocked());
  const c = h.speech.consider(asked());
  assert.deepEqual([a.seq, b.seq, c.seq], [1, 2, 3]);

  // The client spoke the first two and acknowledged the second.
  h.speech.acknowledge(b.seq);
  assert.deepEqual(h.speech.unspoken(0).map((i) => i.seq), [3], 'the acknowledged item itself is never re-offered');
  assert.deepEqual(h.speech.unspoken(1).map((i) => i.seq), [3], 'a stale client cursor cannot resurrect it');
  assert.deepEqual(h.speech.unspoken(3), [], 'the cursor is strictly greater-than, not greater-or-equal');

  // Refresh: a new Store off disk, a new service. Exactly the one unspoken
  // item is still owed — losing it would be as wrong as replaying the others.
  const rebooted = h.reboot();
  assert.equal(rebooted.acknowledgedSeq, 2);
  assert.equal(rebooted.lastSeq, 3);
  assert.deepEqual(rebooted.unspoken(0).map((i) => i.seq), [3]);
  assert.deepEqual(rebooted.unspoken(0).map((i) => i.text), [c.text]);
  assert.deepEqual(rebooted.pending(), rebooted.unspoken(0));

  // The client says it and acknowledges; a second refresh is silent for good.
  rebooted.acknowledge(3);
  const again = h.reboot();
  assert.deepEqual(again.unspoken(0), [], 'a second refresh replayed old speech');
  assert.equal(again.acknowledgedSeq, 3);

  // An acknowledgement can never run ahead of what was actually said.
  again.acknowledge(99);
  assert.equal(again.acknowledgedSeq, 3, 'ack is clamped to the last real utterance');
  const next = again.consider({ type: 'question.asked', payload: { projectId: PROJECT_ID, questionId: 'q_2', text: 'Ship it now?' } });
  assert.equal(next.seq, 4);
  assert.deepEqual(again.unspoken(0).map((i) => i.seq), [4], 'new speech after a refresh is still offered');
});

test('the batch window is measured from its first event and closes exactly on the window', (t) => {
  const h = harness({ batchWindowMs: 4000 });
  t.after(h.cleanup);

  h.speech.consider(completed('tsk_1', 'Build validation'));

  h.clock.set(NOON + 3999);
  h.speech.consider(completed('tsk_2', 'Build autosave'));
  assert.equal(h.spoken.length, 0, 'one millisecond short of the window, the batch is still filling');
  assert.equal(h.speech.batchSize(), 2);

  h.clock.set(NOON + 4000);
  h.speech.consider(completed('tsk_3', 'Build the print view'));
  assert.equal(h.spoken.length, 1, 'at exactly the window the gathered batch is spoken');
  assert.equal(h.spoken[0].text, 'I finished 2 tasks on the settings screen.', 'only the closed window is summarised');
  assert.equal(h.spoken[0].at, NOON + 4000, 'the summary is stamped when it was said, not when it was gathered');
  assert.equal(h.speech.batchSize(), 1, 'the event that closed the window opens the next one');

  // The new window runs from tsk_3, not from tsk_1 — otherwise everything after
  // the first stale window would be spoken one event at a time.
  h.clock.set(NOON + 7999);
  h.speech.consider(completed('tsk_4', 'Build the export'));
  assert.equal(h.spoken.length, 1, 'the second window is measured from its own first event');
  assert.equal(h.speech.batchSize(), 2);

  assert.equal(h.speech.flushBatch().text, 'I finished 2 tasks on the settings screen.');
  assert.equal(h.spoken.length, 2, 'four completions, two summaries, never four utterances');
});
