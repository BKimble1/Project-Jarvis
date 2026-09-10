import test from 'node:test';
import assert from 'node:assert/strict';
import { makeApp, createScriptedExecutor, AutoClock } from '../helpers/harness.js';

/**
 * Acceptance requirement 3 — "Speak plainly and briefly", and speak it once.
 */

const say = (app, text, conversationId = 'c1') => app.dispatcher.handle({ conversationId, text });

function sentenceCount(text) {
  return String(text).trim().split(/(?<=[.!?])\s+/).filter(Boolean).length;
}

test('req3.1 chat replies are first person and one to three short sentences', async (t) => {
  const app = makeApp();
  t.after(() => app.cleanup());

  const replies = [];
  replies.push((await say(app, 'build a pomodoro timer with sound and stats')).reply);
  replies.push((await say(app, "what's the status?")).reply);
  replies.push((await say(app, 'pause')).reply);
  replies.push((await say(app, 'continue')).reply);

  for (const reply of replies) {
    assert.ok(reply.length > 0);
    assert.ok(sentenceCount(reply) <= 3, `"${reply}" should be 1-3 sentences`);
    assert.ok(reply.length <= 220, `"${reply}" is ${reply.length} chars — too long for a default reply`);
    assert.ok(!/[*_`#]|\n\s*[-*]\s/.test(reply), `"${reply}" must not contain markdown formatting`);
    assert.ok(!/\bthe assistant\b|\bJarvis will\b/i.test(reply), `"${reply}" must be first person`);
  }
});

test('req3.2 the spoken sentence is exactly the sentence shown in chat', async (t) => {
  const app = makeApp();
  t.after(() => app.cleanup());

  const spoken = [];
  app.bus.on('speech.say', (evt) => spoken.push(evt.payload));

  const start = await say(app, 'build a shopping list');
  await app.orchestrator.run(start.projectId);
  app.speech.flushBatch();

  const delivered = spoken.find((s) => /deliver/i.test(s.text));
  assert.ok(delivered, `expected a spoken delivery announcement, got: ${spoken.map((s) => s.text).join(' | ')}`);
  const action = app.orchestrator.currentAction(start.projectId);
  assert.equal(delivered.text, action, 'spoken text and on-screen text are the same sentence');
});

test('req3.3 the same event is never spoken twice', async (t) => {
  const app = makeApp();
  t.after(() => app.cleanup());

  const spoken = [];
  app.bus.on('speech.say', (evt) => spoken.push(evt.payload));

  const start = await say(app, 'build a unit converter');
  await app.orchestrator.run(start.projectId);
  app.speech.flushBatch();

  // Re-emitting the identical event must not produce a second utterance.
  const project = app.store.get('projects', start.projectId);
  const before = spoken.length;
  app.bus.emit('project.delivered', { projectId: project.id, project, deliverable: { id: 'x', title: project.title } });
  app.bus.emit('project.delivered', { projectId: project.id, project, deliverable: { id: 'x', title: project.title } });
  app.speech.flushBatch();

  const deliveries = spoken.filter((s) => /deliver/i.test(s.text));
  assert.equal(deliveries.length, 1, `delivery spoken ${deliveries.length} times`);
  assert.equal(spoken.length, before, 'duplicate events produced no new speech');

  const keys = spoken.map((s) => s.key);
  assert.equal(new Set(keys).size, keys.length, 'every spoken item has a distinct key');
});

test('req3.4 refreshing never replays what was already spoken', async (t) => {
  const app = makeApp();
  t.after(() => app.cleanup());

  const start = await say(app, 'build a colour picker');
  await app.orchestrator.run(start.projectId);
  app.speech.flushBatch();

  const pending = app.speech.unspoken(0);
  assert.ok(pending.length >= 1, 'there is something to say on first load');

  // The client speaks them and acknowledges the last one — a refresh follows.
  const lastSeq = pending.at(-1).seq;
  app.speech.acknowledge(lastSeq);
  assert.deepEqual(app.speech.unspoken(0), [], 'nothing is re-offered after acknowledgement');
  assert.deepEqual(app.speech.unspoken(lastSeq), [], 'nothing is re-offered by sequence either');

  // Even a completely fresh service over the same store must not replay.
  const { SpeechService } = await import('../../src/voice/speech.js');
  const revived = new SpeechService({ store: app.store, bus: app.bus, clock: app.testClock, settings: app.settings });
  assert.deepEqual(revived.unspoken(0), [], 'a restart does not replay old speech');
});

test('req3.5 minor progress is batched, important events are not', async (t) => {
  const app = makeApp();
  t.after(() => app.cleanup());

  const spoken = [];
  app.bus.on('speech.say', (evt) => spoken.push(evt.payload));

  const start = await say(app, 'build a form with validation, autosave, a summary step and a print view');
  await app.orchestrator.run(start.projectId);

  const beforeFlush = spoken.filter((s) => s.priority === 'normal').length;
  app.speech.flushBatch();
  const after = spoken.length;

  const taskChatter = spoken.filter((s) => /^I (started|began) /i.test(s.text));
  assert.equal(taskChatter.length, 0, 'per-task chatter is not spoken individually');

  const high = spoken.filter((s) => s.priority === 'high');
  assert.ok(high.length >= 1, 'the delivery was announced immediately at high priority');
  assert.ok(after >= beforeFlush, 'batched progress is summarized on flush');
  assert.ok(spoken.length <= 6, `speech stayed concise (${spoken.length} utterances for a 4-feature build)`);
});

test('req3.6 mute silences everything; quiet hours still let blockers through', async (t) => {
  // 23:30 UTC — inside a 22:00-07:00 quiet window.
  const clock = new AutoClock(Date.UTC(2026, 0, 15, 23, 30), 'UTC');
  const app = makeApp({
    clock,
    appOptions: { settings: { quietHours: { start: '22:00', end: '07:00', enabled: true, timezone: 'UTC' } } },
    executor: createScriptedExecutor({
      script: { implement: { throw: { message: 'token expired', status: 401 } } },
    }),
  });
  t.after(() => app.cleanup());

  const spoken = [];
  app.bus.on('speech.say', (evt) => spoken.push(evt.payload));

  const start = await say(app, 'build a deploy script');
  await app.orchestrator.run(start.projectId);
  app.speech.flushBatch();

  assert.ok(spoken.some((s) => /blocked|need|credential|permission|token/i.test(s.text)),
    `a blocker must break quiet hours, got: ${spoken.map((s) => s.text).join(' | ')}`);
  assert.equal(spoken.filter((s) => s.priority === 'normal').length, 0, 'routine progress stayed quiet');

  // Now mute and prove nothing at all is spoken.
  app.updateSettings({ muted: true });
  const before = spoken.length;
  const second = await say(app, 'build a backup script');
  await app.orchestrator.run(second.projectId);
  app.speech.flushBatch();
  assert.equal(spoken.length, before, 'mute wins over everything');
});

test('req3.7 delivery, blockers and questions are announced; nothing else insists', async (t) => {
  const app = makeApp({
    executor: createScriptedExecutor({
      script: {
        'Build a sync engine': {
          needsAnswer: {
            text: 'Should sync be last-write-wins or merge?',
            recommendedDefault: 'merge',
            options: ['last-write-wins', 'merge'],
            impact: 'high',
          },
        },
      },
    }),
  });
  t.after(() => app.cleanup());

  const spoken = [];
  app.bus.on('speech.say', (evt) => spoken.push(evt.payload));

  const start = await say(app, 'build a sync engine, a conflict viewer and an audit log');
  await app.orchestrator.run(start.projectId);
  app.speech.flushBatch();

  assert.ok(spoken.some((s) => /sync be last-write-wins|need to know|should sync/i.test(s.text)),
    `the question must be announced, got: ${spoken.map((s) => s.text).join(' | ')}`);
  assert.ok(spoken.every((s) => sentenceCount(s.text) <= 2), 'spoken lines stay to one or two sentences');
});
