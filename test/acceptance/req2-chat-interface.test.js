import test from 'node:test';
import assert from 'node:assert/strict';
import { makeApp, createScriptedExecutor, createGatedExecutor, recordEvents } from '../helpers/harness.js';

/**
 * Acceptance requirement 2 — "Make chat the complete interface".
 * Everything below happens through chat alone: no management screen is touched.
 */

const say = (app, text, conversationId = 'c1') => app.dispatcher.handle({ conversationId, text });

test('req2.1 describing work in chat starts and finishes a real project', async (t) => {
  const app = makeApp();
  t.after(() => app.cleanup());

  const out = await say(app, 'build me a habit tracker with streaks and reminders');
  assert.equal(out.intent.kind, 'build');
  assert.ok(out.projectId, 'chat alone created the project');
  await app.orchestrator.run(out.projectId);
  assert.equal(app.store.get('projects', out.projectId).status, 'delivered');
});

test('req2.2 "change that" resolves to the project in flight, not a new one', async (t) => {
  const app = makeApp();
  t.after(() => app.cleanup());

  const start = await say(app, 'build a portfolio site with a gallery and a contact form');
  await app.orchestrator.run(start.projectId);

  const change = await say(app, 'change that — also add a blog');
  assert.equal(change.intent.kind, 'change');
  assert.equal(change.projectId, start.projectId, '"that" resolved to the active project');
  await app.orchestrator.run(start.projectId);

  assert.equal(app.store.ids('projects').length, 1, 'no duplicate project');
  assert.match(app.store.get('projects', start.projectId).scope.join(' ').toLowerCase(), /blog/);
});

test('req2.3 "the second option" resolves against the options last offered', async (t) => {
  const app = makeApp();
  t.after(() => app.cleanup());

  app.conversations.ensure('c1');
  app.conversations.setLastOptions('c1', ['SQLite', 'Postgres', 'a flat file']);
  const ctx = app.conversations.context('c1');

  const { resolveReference } = await import('../../src/chat/reference.js');
  assert.equal(resolveReference('use the second option', ctx).optionIndex, 1);
  assert.equal(resolveReference('go with option 3', ctx).optionIndex, 2);
  assert.equal(resolveReference('the first one please', ctx).optionIndex, 0);
  assert.equal(resolveReference('option 9', ctx).optionIndex, null, 'out of range is not guessed');
});

test('req2.4 "continue" resumes the right project', async (t) => {
  const app = makeApp({
    executor: createScriptedExecutor({
      onTask: (task, ctx, n) => { if (task.kind === 'implement' && n === 1) app.orchestrator.pause(ctx.project.id); },
    }),
  });
  t.after(() => app.cleanup());

  const start = await say(app, 'build a bookmarks manager with folders and search');
  await app.orchestrator.run(start.projectId);
  assert.equal(app.store.get('projects', start.projectId).status, 'paused');

  const cont = await say(app, 'continue');
  assert.equal(cont.intent.kind, 'resume');
  assert.equal(cont.projectId, start.projectId);
  await app.orchestrator.run(start.projectId);
  assert.equal(app.store.get('projects', start.projectId).status, 'delivered');
});

test('req2.5 status, pause and stop all work from chat while a build is in flight', async (t) => {
  const gated = createGatedExecutor();
  const app = makeApp({ executor: gated.executor });
  t.after(() => { gated.release(); return app.cleanup(); });

  const start = await say(app, 'build a markdown editor with preview and export');
  await gated.firstArrival;

  const status = await say(app, "how's it going?");
  assert.equal(status.intent.kind, 'status');
  assert.match(status.reply, /^I\b|^I'm\b/, `status must answer in first person, got: ${status.reply}`);

  const paused = await say(app, 'pause');
  assert.equal(paused.intent.kind, 'pause');
  assert.equal(app.store.get('projects', start.projectId).status, 'paused');

  gated.release();
  await app.orchestrator.run(start.projectId);
  const afterRelease = app.store.get('projects', start.projectId);
  assert.equal(afterRelease.status, 'paused', 'a paused build does not quietly finish itself');
  assert.notEqual(afterRelease.phase, 'idle');

  const stopped = await say(app, 'stop');
  assert.equal(stopped.intent.kind, 'stop');
  assert.equal(app.store.get('projects', start.projectId).status, 'stopped');
});

test('req2.6 a question asked by Jarvis is answered in chat and the answer is not lost', async (t) => {
  const app = makeApp({
    executor: createScriptedExecutor({
      script: {
        'Build wishlist': [
          {
          needsAnswer: {
            text: 'Should the wishlist be public or private by default?',
            recommendedDefault: 'private',
            options: ['public', 'private'],
            impact: 'high',
          },
        },
          {},
        ],
      },
    }),
  });
  t.after(() => app.cleanup());

  const start = await say(app, 'build a wishlist, a share sheet and an email digest');
  await app.orchestrator.run(start.projectId);

  const question = app.questions.open(start.projectId)[0];
  assert.ok(question, 'it asked in chat rather than guessing');

  const answered = await say(app, 'public');
  assert.equal(answered.intent.kind, 'answer', 'a bare reply is understood as the answer');
  const stored = app.store.get('questions', question.id);
  assert.equal(stored.status, 'answered');
  assert.equal(stored.answer, 'public', 'the answer was not lost');

  await app.orchestrator.run(start.projectId);
  await app.orchestrator.run(start.projectId);
  assert.equal(app.store.get('projects', start.projectId).status, 'delivered');
});

test('req2.7 a genuinely ambiguous reference is asked about, not guessed', async (t) => {
  const app = makeApp();
  t.after(() => app.cleanup());

  const a = await say(app, 'build a weather widget', 'cA');
  await app.orchestrator.run(a.projectId);
  const b = await say(app, 'build a stock ticker', 'cB');
  await app.orchestrator.run(b.projectId);

  // A third conversation with no active project referring to "it".
  const out = await say(app, 'change it to use dark colours', 'cC');
  assert.notEqual(out.projectId, a.projectId);
  assert.notEqual(out.projectId, b.projectId);
  assert.match(out.reply, /which|don't have|tell me/i, `expected a clarifying reply, got: ${out.reply}`);
});

test('req2.8 evaluation-only requests are honoured from chat', async (t) => {
  const app = makeApp();
  t.after(() => app.cleanup());

  const out = await say(app, 'evaluate only: should we move the queue to Redis? do not build yet');
  assert.equal(out.intent.kind, 'evaluate_only');
  await app.orchestrator.run(out.projectId);
  const project = app.store.get('projects', out.projectId);
  assert.equal(project.status, 'evaluated');
  assert.equal(app.store.find('tasks', (x) => x.projectId === project.id && x.kind === 'implement').length, 0);
});

test('req2.9 the conversation transcript is the record; management screens are optional', async (t) => {
  const app = makeApp();
  t.after(() => app.cleanup());

  await say(app, 'build a countdown timer');
  const turns = app.conversations.history('c1', 50);
  assert.ok(turns.length >= 2, 'user and assistant turns are both recorded');
  assert.equal(turns[0].role, 'user');
  assert.equal(turns[1].role, 'assistant');

  const state = app.state('c1');
  assert.ok(state.conversation.turns.length >= 2, 'the dashboard renders the same conversation');
  assert.ok(state.project, 'the project record exists internally without any screen being used');
});

test('req2.10 reminders are captured from chat without becoming unauthorized work', async (t) => {
  const app = makeApp();
  t.after(() => app.cleanup());

  const out = await say(app, 'remind me to renew the domain next month');
  assert.equal(out.intent.kind, 'reminder');
  const items = app.backlog.items();
  assert.equal(items.length, 1);
  assert.equal(items[0].authorized, false, 'a reminder is not silently authorized work');

  await app.orchestrator.drain();
  assert.equal(app.store.ids('projects').length, 0, 'Jarvis did not invent a project from a reminder');
});

test('req2.11 reminders are listed, started and dropped entirely from chat', async (t) => {
  const app = makeApp();
  t.after(() => app.cleanup());

  await say(app, 'remind me to renew the domain next month');
  await say(app, 'remind me to archive the old logs');

  const listed = await say(app, 'what are my reminders?');
  assert.match(listed.reply, /2 reminders/i);
  assert.match(listed.reply, /renew the domain/i);
  assert.match(listed.reply, /archive the old logs/i);
  assert.equal(app.store.ids('projects').length, 0, 'listing starts nothing');

  const started = await say(app, 'go ahead with the domain reminder');
  assert.match(started.reply, /on it/i);
  assert.match(started.reply, /renew the domain/i);
  await app.orchestrator.drain();

  const projects = app.store.all('projects');
  assert.equal(projects.length, 1, 'exactly the authorized reminder became work');
  assert.match(projects[0].title, /renew the domain/i);
  assert.equal(projects[0].status, 'delivered');

  const dropped = await say(app, 'drop the logs reminder');
  assert.match(dropped.reply, /dropped/i);
  await app.orchestrator.drain();
  assert.equal(app.store.ids('projects').length, 1, 'a dropped reminder is never picked up');

  const empty = await say(app, 'any reminders left?');
  assert.match(empty.reply, /no reminders/i);
});
