import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FakeClock } from '../../src/core/clock.js';
import { EventBus } from '../../src/core/bus.js';
import { Store } from '../../src/core/store.js';
import { ConversationService } from '../../src/chat/conversation.js';
import { classify } from '../../src/chat/intent.js';
import { resolveReference } from '../../src/chat/reference.js';

/** A throwaway store under the OS tmpdir — no real project state is touched. */
function harness(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-chat-'));
  const clock = new FakeClock(1_700_000_000_000, 'UTC');
  const bus = new EventBus();
  const store = new Store({ dir, clock });
  const events = [];
  bus.on('chat.message', (evt) => events.push(evt));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, clock, bus, store, events, service: new ConversationService({ store, bus, clock }) };
}

function seedProject(store, { id, title, updatedAt, status = 'active' }) {
  store.put('projects', id, { id, title, status, phase: 'implementing', createdAt: updatedAt, updatedAt });
  return id;
}

function seedQuestion(store, over = {}) {
  const question = {
    id: 'q_1', projectId: 'p_1', taskId: null, text: 'Which database?',
    recommendedDefault: 'Postgres', options: ['Postgres', 'SQLite'],
    status: 'open', answer: null, askedAt: 10, answeredAt: null, ...over,
  };
  store.put('questions', question.id, question);
  return question;
}

test('the constructor demands its collaborators', () => {
  assert.throws(() => new ConversationService({}), TypeError);
  assert.throws(() => new ConversationService({ store: {}, bus: {} }), TypeError);
});

test('ensure creates once and is idempotent', (t) => {
  const { service, store, clock } = harness(t);
  const first = service.ensure('c1');
  assert.equal(first.id, 'c1');
  assert.equal(first.createdAt, clock.now());
  assert.equal(first.projectId, null);
  assert.deepEqual(first.lastOptions, []);

  clock.set(clock.now() + 5_000);
  const second = service.ensure('c1');
  assert.equal(second.createdAt, first.createdAt, 'must not re-create the conversation');
  assert.equal(store.ids('conversations').length, 1);
});

test('append persists the turn, stamps it from the clock and emits chat.message', (t) => {
  const { service, store, clock, events } = harness(t);
  const turn = service.append('c1', { role: 'user', text: '  build me a CLI  ', meta: { source: 'web' } });

  assert.equal(turn.conversationId, 'c1');
  assert.equal(turn.role, 'user');
  assert.equal(turn.text, 'build me a CLI');
  assert.equal(turn.index, 1);
  assert.equal(turn.at, clock.now());
  assert.deepEqual(turn.meta, { source: 'web' });

  assert.deepEqual(store.get('turns', turn.id), turn);
  assert.equal(store.get('conversations', 'c1').turnCount, 1);

  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'chat.message');
  assert.deepEqual(events[0].payload.turn, turn);
  assert.equal(events[0].payload.conversationId, 'c1');
});

test('append auto-creates an unknown conversation and rejects unknown roles', (t) => {
  const { service, store } = harness(t);
  service.append('fresh', { role: 'assistant', text: 'on it' });
  assert.ok(store.get('conversations', 'fresh'));
  assert.throws(() => service.append('fresh', { role: 'robot', text: 'hi' }), TypeError);
  assert.throws(() => service.append('', { text: 'hi' }), TypeError);
});

test('chat.message carries the bound projectId', (t) => {
  const { service, events } = harness(t);
  service.bindProject('c1', 'p_1');
  service.append('c1', { role: 'assistant', text: 'building' });
  assert.equal(events.at(-1).payload.projectId, 'p_1');
});

test('history returns the most recent turns in chronological order', (t) => {
  const { service } = harness(t);
  for (let i = 1; i <= 5; i++) service.append('c1', { role: 'user', text: `turn ${i}` });

  const recent = service.history('c1', 3);
  assert.deepEqual(recent.map((tn) => tn.text), ['turn 3', 'turn 4', 'turn 5']);
  assert.deepEqual(recent.map((tn) => tn.index), [3, 4, 5]);

  assert.equal(service.history('c1', 100).length, 5);
  assert.deepEqual(service.history('c1', 0), []);
  assert.deepEqual(service.history('c1', -2), []);
  assert.equal(service.history('c1').length, 5);
});

test('history keeps ordering when a fake clock issues identical timestamps', (t) => {
  const { service, clock } = harness(t);
  const before = clock.now();
  for (let i = 1; i <= 4; i++) service.append('c1', { role: 'user', text: `t${i}` });
  assert.equal(clock.now(), before, 'clock did not move — ordering must not depend on it');
  assert.deepEqual(service.history('c1', 4).map((tn) => tn.text), ['t1', 't2', 't3', 't4']);
});

test('history is isolated per conversation', (t) => {
  const { service } = harness(t);
  service.append('a', { role: 'user', text: 'alpha' });
  service.append('b', { role: 'user', text: 'beta' });
  assert.deepEqual(service.history('a', 10).map((tn) => tn.text), ['alpha']);
  assert.deepEqual(service.history('b', 10).map((tn) => tn.text), ['beta']);
});

test('history survives a restart because turns are persisted', (t) => {
  const { service, dir, clock, bus, store } = harness(t);
  service.append('c1', { role: 'user', text: 'build me a CLI' });
  service.append('c1', { role: 'assistant', text: "I'm on it" });
  store.flush();

  const reopened = new ConversationService({ store: new Store({ dir, clock }), bus, clock });
  assert.deepEqual(reopened.history('c1', 10).map((tn) => tn.text), ['build me a CLI', "I'm on it"]);
});

test('bindProject / activeProject track the project the chat is about', (t) => {
  const { service } = harness(t);
  assert.equal(service.activeProject('c1'), null);
  service.bindProject('c1', 'p_1');
  assert.equal(service.activeProject('c1'), 'p_1');
  service.bindProject('c1', 'p_2');
  assert.equal(service.activeProject('c1'), 'p_2');
  assert.deepEqual(service.ensure('c1').projectIds, ['p_1', 'p_2']);
  assert.throws(() => service.bindProject('c1', null), TypeError);
});

test('setLastOptions / lastOptions remember what we offered', (t) => {
  const { service } = harness(t);
  assert.deepEqual(service.lastOptions('c1'), []);
  service.setLastOptions('c1', ['Recipe scraper', ' Slack bot ', '', null]);
  assert.deepEqual(service.lastOptions('c1'), ['Recipe scraper', 'Slack bot']);
  service.setLastOptions('c1', []);
  assert.deepEqual(service.lastOptions('c1'), []);
});

test('context assembles everything classify and resolveReference need', (t) => {
  const { service, store } = harness(t);
  seedProject(store, { id: 'p_old', title: 'Recipe scraper', updatedAt: 100 });
  seedProject(store, { id: 'p_new', title: 'Slack standup bot', updatedAt: 500 });
  service.bindProject('c1', 'p_new');
  service.setLastOptions('c1', ['Postgres', 'SQLite']);
  service.append('c1', { role: 'user', text: 'hello' });

  const ctx = service.context('c1');
  assert.equal(ctx.conversationId, 'c1');
  assert.equal(ctx.activeProjectId, 'p_new');
  assert.deepEqual(ctx.recentProjects.map((p) => p.id), ['p_new', 'p_old'], 'most recently updated first');
  assert.deepEqual(Object.keys(ctx.recentProjects[0]).sort(), ['id', 'title', 'updatedAt']);
  assert.deepEqual(ctx.lastOptions, ['Postgres', 'SQLite']);
  assert.equal(ctx.openQuestion, null);
  assert.equal(ctx.turnCount, 1);
  assert.deepEqual(ctx.recentTurns.map((tn) => tn.text), ['hello']);
});

test('context exposes only the open question, scoped to the active project', (t) => {
  const { service, store } = harness(t);
  seedProject(store, { id: 'p_1', title: 'Recipe scraper', updatedAt: 100 });
  seedQuestion(store, { id: 'q_answered', status: 'answered', answer: 'Postgres', askedAt: 5 });
  seedQuestion(store, { id: 'q_open', projectId: 'p_1', askedAt: 20 });
  seedQuestion(store, { id: 'q_other', projectId: 'p_other', text: 'Which host?', askedAt: 30 });

  service.bindProject('c1', 'p_1');
  const ctx = service.context('c1');
  assert.equal(ctx.openQuestion.id, 'q_open');
  assert.equal(ctx.openQuestion.status, 'open');
  // With no options remembered, the question's own options stand in.
  assert.deepEqual(ctx.lastOptions, ['Postgres', 'SQLite']);
});

test('context falls back to the newest open question when no project is bound', (t) => {
  const { service, store } = harness(t);
  seedQuestion(store, { id: 'q_a', projectId: 'p_a', askedAt: 10 });
  seedQuestion(store, { id: 'q_b', projectId: 'p_b', text: 'Which host?', askedAt: 40 });
  assert.equal(service.context('c1').openQuestion.id, 'q_b');
});

test('context with no open questions and no projects is still well formed', (t) => {
  const { service } = harness(t);
  const ctx = service.context('brand-new');
  assert.equal(ctx.activeProjectId, null);
  assert.deepEqual(ctx.recentProjects, []);
  assert.deepEqual(ctx.lastOptions, []);
  assert.equal(ctx.openQuestion, null);
  assert.deepEqual(ctx.recentTurns, []);
});

test('context drives classify and resolveReference end to end', (t) => {
  const { service, store } = harness(t);
  seedProject(store, { id: 'p_1', title: 'Recipe scraper', updatedAt: 100 });
  service.bindProject('c1', 'p_1');
  service.append('c1', { role: 'user', text: 'build me a recipe scraper' });

  // A change, understood as a change to the bound project.
  let ctx = service.context('c1');
  const change = classify('actually make it TypeScript', ctx);
  assert.equal(change.kind, 'change');
  assert.equal(resolveReference('actually make it TypeScript', ctx).projectId, 'p_1');

  // A decision card is offered, then answered with an ordinal.
  seedQuestion(store, { id: 'q_1', projectId: 'p_1', askedAt: 50 });
  service.setLastOptions('c1', ['Postgres', 'SQLite']);
  ctx = service.context('c1');
  const answer = classify('the second option', ctx);
  assert.equal(answer.kind, 'answer');
  assert.equal(answer.payload.questionId, 'q_1');
  const ref = resolveReference('the second option', ctx);
  assert.equal(ref.optionIndex, 1);
  assert.equal(ref.questionId, 'q_1');
});

test('returned records are copies, so callers cannot corrupt the store', (t) => {
  const { service, store } = harness(t);
  const turn = service.append('c1', { role: 'user', text: 'hello' });
  turn.text = 'tampered';
  turn.meta.evil = true;
  assert.equal(store.get('turns', turn.id).text, 'hello');
  assert.deepEqual(store.get('turns', turn.id).meta, {});

  const conversation = service.ensure('c1');
  conversation.projectId = 'p_hack';
  assert.equal(service.activeProject('c1'), null);
});
