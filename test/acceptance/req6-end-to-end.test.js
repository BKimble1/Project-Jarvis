import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { makeApp, createScriptedExecutor, recordEvents, AutoClock, StubProvider, liveMeasurement } from '../helpers/harness.js';
import { createServer } from '../../src/server.js';

/**
 * Acceptance requirement 6 — "Prove the complete behavior".
 * One fresh project, driven entirely through chat, with a mid-build change, a
 * material question answered in chat, a worker crash and recovery, spoken
 * updates, and a verified delivery.
 */

test('req6.1 a whole project runs through chat: change, question, recovery, speech, delivery', async (t) => {
  const clock = new AutoClock();
  let changeSent = false;

  const app = makeApp({
    clock,
    provider: new StubProvider([liveMeasurement(clock, [{ key: 'five_hour', label: '5-hour', usedPercent: 30 }])]),
    executor: createScriptedExecutor({
      script: {
        // A material question on one feature.
        'Build reading list': [
          {
          needsAnswer: {
            text: 'Should the reading list sync across devices?',
            recommendedDefault: 'yes, sync it',
            options: ['yes, sync it', 'keep it local'],
            impact: 'high',
          },
        },
          {},
        ],
        // A worker crash that must recover on its own.
        'Build tag filtering': [
          { throw: { message: 'socket hang up', code: 'ECONNRESET' } },
          {},
        ],
      },
      onTask: (task, ctx) => {
        if (!changeSent && task.title.startsWith('Build tag filtering')) {
          changeSent = true;
          queueMicrotask(() => app.dispatcher.handle({
            conversationId: 'blake',
            text: 'change that — also add an offline reader',
          }));
        }
      },
    }),
  });
  t.after(() => app.cleanup());

  const events = recordEvents(app.bus);
  const spoken = [];
  app.bus.on('speech.say', (evt) => spoken.push(evt.payload));
  await app.usage.refresh();

  // --- 1. Blake describes the work in chat, and nothing else.
  const start = await app.dispatcher.handle({
    conversationId: 'blake',
    text: 'build a reading list, tag filtering and a weekly digest',
  });
  assert.equal(start.intent.kind, 'build');
  const projectId = start.projectId;
  assert.ok(projectId);

  await app.orchestrator.run(projectId);

  // --- 2. A material question was asked exactly once, in chat.
  assert.equal(events.count('question.asked'), 1, 'one question, asked once');
  const question = app.questions.open(projectId)[0];
  assert.ok(question, 'Jarvis is waiting on a genuine unknown');
  assert.ok(question.recommendedDefault, 'and it recommended a default');

  // Independent work carried on while it waited.
  const doneWhileWaiting = app.store.find('tasks', (x) => x.projectId === projectId && x.status === 'done');
  assert.ok(doneWhileWaiting.length >= 1, 'it kept working on what it could');

  // --- 3. Blake answers in chat. Nothing else is required to resume.
  const answer = await app.dispatcher.handle({ conversationId: 'blake', text: 'keep it local' });
  assert.equal(answer.intent.kind, 'answer');
  assert.equal(app.store.get('questions', question.id).answer, 'keep it local', 'the answer was not lost');

  await app.orchestrator.run(projectId);
  await app.orchestrator.run(projectId);

  // --- 4. The build finished, in the same project, with the change folded in.
  const project = app.store.get('projects', projectId);
  assert.equal(project.status, 'delivered', `expected delivery, got ${project.status}: ${project.blockedReason ?? ''}`);
  assert.equal(app.store.ids('projects').length, 1, 'no duplicate project was created');
  assert.ok(project.planRevision >= 2, 'the mid-build change revised the plan in place');

  const scope = project.scope.join(' | ').toLowerCase();
  assert.match(scope, /reading list/, 'original scope kept');
  assert.match(scope, /tag filtering/, 'original scope kept');
  assert.match(scope, /weekly digest/, 'original scope kept');
  assert.match(scope, /offline reader/, 'the change was incorporated');

  // --- 5. The worker crashed and recovered without Blake doing anything.
  assert.ok(events.count('task.retrying') + events.count('worker.recovered') >= 1, 'the transient failure recovered by itself');
  assert.equal(events.count('project.blocked'), 0, 'a recoverable error never became a blocker');

  // --- 6. Speech was meaningful, deduplicated and never replayed.
  app.speech.flushBatch();
  const saidInChat = new Set(app.conversations.history('blake', 50).filter((x) => x.role === 'assistant').map((x) => x.text));
  const replies = spoken.filter((s) => saidInChat.has(s.text));
  const announcements = spoken.filter((s) => !saidInChat.has(s.text));

  assert.equal(replies.length, saidInChat.size, 'every reply shown in chat was also spoken, verbatim');
  assert.ok(announcements.length >= 2, 'it announced the things that mattered on its own');
  assert.ok(announcements.length <= 6, `it did not narrate every step (${announcements.length} announcements)`);
  assert.ok(spoken.some((s) => /^I delivered\b/.test(s.text)), 'it announced the delivery');
  assert.ok(spoken.some((s) => /sync|need to know|reading list/i.test(s.text)), 'it announced the question');
  const keys = spoken.map((s) => s.key);
  assert.equal(new Set(keys).size, keys.length, 'nothing was spoken twice');

  const lastSeq = app.speech.pending().at(-1)?.seq ?? spoken.at(-1).seq;
  app.speech.acknowledge(lastSeq);
  assert.deepEqual(app.speech.unspoken(0), [], 'a refresh replays nothing');

  // --- 7. No routine approval stops along the way.
  assert.equal(events.count('question.asked'), 1, 'exactly one question in the whole run');

  // --- 8. The delivery is real and verified.
  const deliverables = app.store.find('deliverables', (d) => d.projectId === projectId);
  assert.equal(deliverables.length, 1);
  assert.match(deliverables[0].body, /offline reader/i, 'the deliverable reflects the final agreed scope');

  const verifyTasks = app.store.find('tasks', (x) => x.projectId === projectId && x.kind === 'verify');
  assert.ok(verifyTasks.some((x) => x.status === 'done'), 'verification actually ran and passed');
  const reviewTasks = app.store.find('tasks', (x) => x.projectId === projectId && x.kind === 'review');
  assert.ok(reviewTasks.some((x) => x.status === 'done'), 'review actually ran');

  // --- 9. The dashboard reflects the finished state without clutter.
  const state = app.state('blake');
  assert.equal(state.decision, null, 'no leftover decision card');
  assert.equal(state.deliverables.length, 1);
  assert.match(state.currentAction, /^I\b|^I'm\b/);
  assert.equal(state.capacity.status, 'live');
  assert.equal(state.health.level, 'ok');

  // --- 10. Replies are never stale: the last assistant turn describes the end state.
  const turns = app.conversations.history('blake', 50);
  assert.equal(turns.at(-1).role, 'assistant');
  assert.ok(turns.filter((x) => x.role === 'assistant').length >= 3, 'every message got its own answer');
});

test('req6.2 the same flow works over real HTTP, including a resumable event stream', async (t) => {
  const clock = new AutoClock();
  const app = makeApp({
    clock,
    provider: new StubProvider([liveMeasurement(clock, [{ key: 'five_hour', label: '5-hour', usedPercent: 25 }])]),
  });
  const server = createServer({ app });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { server.close(); await app.cleanup(); });

  await fetch(`${base}/api/capacity/refresh`, { method: 'POST' });

  // The page loads.
  const page = await fetch(`${base}/`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type'), /text\/html/);
  const html = await page.text();
  assert.match(html, /<main|<body|id="core"/i);

  // Chat drives the build.
  const chat = await fetch(`${base}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ conversationId: 'http', text: 'build a link shortener with analytics' }),
  });
  assert.equal(chat.status, 200);
  const chatBody = await chat.json();
  assert.ok(chatBody.projectId);
  assert.ok(chatBody.reply.length > 0);
  assert.ok(chatBody.state.currentAction);

  await app.orchestrator.run(chatBody.projectId);

  // State reflects the delivery, with real capacity numbers.
  const state = await (await fetch(`${base}/api/state?conversationId=http`)).json();
  assert.equal(state.project.status, 'delivered');
  assert.equal(state.capacity.status, 'live');
  assert.equal(Math.round(state.capacity.windows[0].usedPercent), 25);
  assert.equal(state.deliverables.length, 1);

  // The event stream backfills from a sequence and does not replay earlier events.
  const controller = new AbortController();
  const stream = await fetch(`${base}/api/events?since=${state.seq}`, { signal: controller.signal });
  assert.equal(stream.status, 200);
  assert.match(stream.headers.get('content-type'), /text\/event-stream/);
  app.bus.emit('action.current', { text: 'I am testing the stream.', projectId: null });

  const reader = stream.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const deadline = Date.now() + 4000;
  while (!buffer.includes('I am testing the stream') && Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
  }
  controller.abort();
  assert.match(buffer, /I am testing the stream/, 'live events reach the page');
  assert.ok(!buffer.includes('link shortener'), 'events before the resume point are not replayed');

  // Diagnostics are reachable, but only from their own endpoint.
  const diag = await (await fetch(`${base}/api/diagnostics`)).json();
  assert.ok(diag.pool && diag.counts);
  assert.ok(!('pool' in state), 'and never on the default dashboard payload');
});

test('req6.3 nothing routine ever stops the loop across a batch of builds', async (t) => {
  const app = makeApp();
  t.after(() => app.cleanup());
  const events = recordEvents(app.bus);

  const goals = [
    'a calculator with history',
    'a todo list with due dates and tags',
    'a contact form with validation',
  ];
  for (const goal of goals) {
    const out = await app.dispatcher.handle({ conversationId: 'batch', text: `build ${goal}` });
    await app.orchestrator.run(out.projectId);
  }

  assert.equal(app.store.ids('projects').length, 3, 'one project per request, no duplicates');
  assert.ok(app.store.all('projects').every((p) => p.status === 'delivered'), 'all delivered unattended');
  assert.equal(events.count('question.asked'), 0, 'not one routine approval stop');
  assert.equal(events.count('project.blocked'), 0);
});
