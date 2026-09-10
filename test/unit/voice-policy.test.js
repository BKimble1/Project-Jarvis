import test from 'node:test';
import assert from 'node:assert/strict';
import { FakeClock } from '../../src/core/clock.js';
import {
  SPEAK_ALWAYS, batchable, inQuietHours, oneSentence, parseHhMm, priorityFor,
  renderSentence, shouldSpeak,
} from '../../src/voice/policy.js';

const NOON = Date.UTC(2026, 0, 15, 12, 0);
const at = (h, m = 0, tz = 'UTC') => new FakeClock(Date.UTC(2026, 0, 15, h, m), tz);

const CROSSES_MIDNIGHT = { quietHours: { start: '22:00', end: '07:00', timezone: 'UTC' } };
const DAYTIME_WINDOW = { quietHours: { start: '09:00', end: '17:00', timezone: 'UTC' } };

function sentenceCount(text) {
  return String(text).trim().split(/(?<=[.!?])\s+/).filter(Boolean).length;
}

// ------------------------------------------------------------------ shape

test('SPEAK_ALWAYS is exactly the contract list', () => {
  assert.deepEqual(SPEAK_ALWAYS, ['project.delivered', 'project.blocked', 'question.asked', 'feature.completed']);
});

test('batchable() covers minor progress and nothing important', () => {
  for (const type of ['task.completed', 'task.started', 'project.phase']) {
    assert.equal(batchable(type), true, `${type} should batch`);
  }
  for (const type of ['project.delivered', 'project.blocked', 'question.asked', 'feature.completed', 'project.evaluated']) {
    assert.equal(batchable(type), false, `${type} must never be batched`);
  }
});

test('priorityFor marks only delivery, blockers and questions as high', () => {
  assert.equal(priorityFor('project.delivered'), 'high');
  assert.equal(priorityFor('project.blocked'), 'high');
  assert.equal(priorityFor('question.asked'), 'high');
  assert.equal(priorityFor('task.completed'), 'normal');
  assert.equal(priorityFor('feature.completed'), 'normal');
});

// ------------------------------------------------------------ quiet hours

test('parseHhMm reads wall-clock strings and rejects nonsense', () => {
  assert.equal(parseHhMm('22:00'), 22 * 60);
  assert.equal(parseHhMm('07:30'), 7 * 60 + 30);
  assert.equal(parseHhMm('0:05'), 5);
  assert.equal(parseHhMm('24:00'), null);
  assert.equal(parseHhMm('22:60'), null);
  assert.equal(parseHhMm('bedtime'), null);
  assert.equal(parseHhMm(undefined), null);
});

test('a quiet window that crosses midnight includes both sides of it', () => {
  assert.equal(inQuietHours(at(23, 30), CROSSES_MIDNIGHT), true, '23:30 is inside 22:00-07:00');
  assert.equal(inQuietHours(at(3, 0), CROSSES_MIDNIGHT), true, '03:00 is inside 22:00-07:00');
  assert.equal(inQuietHours(at(12, 0), CROSSES_MIDNIGHT), false, '12:00 is outside 22:00-07:00');
});

test('the crossing window is inclusive of start and exclusive of end', () => {
  assert.equal(inQuietHours(at(21, 59), CROSSES_MIDNIGHT), false);
  assert.equal(inQuietHours(at(22, 0), CROSSES_MIDNIGHT), true);
  assert.equal(inQuietHours(at(6, 59), CROSSES_MIDNIGHT), true);
  assert.equal(inQuietHours(at(7, 0), CROSSES_MIDNIGHT), false);
});

test('a window that does not cross midnight behaves normally', () => {
  assert.equal(inQuietHours(at(12, 0), DAYTIME_WINDOW), true, '12:00 is inside 09:00-17:00');
  assert.equal(inQuietHours(at(9, 0), DAYTIME_WINDOW), true);
  assert.equal(inQuietHours(at(8, 59), DAYTIME_WINDOW), false);
  assert.equal(inQuietHours(at(17, 0), DAYTIME_WINDOW), false);
  assert.equal(inQuietHours(at(23, 30), DAYTIME_WINDOW), false, '23:30 is outside 09:00-17:00');
});

test('quiet hours are read in the settings timezone, falling back to the clock', () => {
  // 14:30Z is 23:30 in Tokyo, so the clock's own zone puts us inside the window.
  assert.equal(inQuietHours(new FakeClock(Date.UTC(2026, 0, 15, 14, 30), 'Asia/Tokyo'),
    { quietHours: { start: '22:00', end: '07:00' } }), true);
  // Same instant, UTC clock, no settings zone: 14:30 is wide awake.
  assert.equal(inQuietHours(new FakeClock(Date.UTC(2026, 0, 15, 14, 30), 'UTC'),
    { quietHours: { start: '22:00', end: '07:00' } }), false);
  // An explicit settings zone wins over the clock's zone: 23:30Z is 18:30 in New York.
  assert.equal(inQuietHours(at(23, 30), { quietHours: { start: '22:00', end: '07:00', timezone: 'America/New_York' } }), false);
});

test('quiet hours are off when unset, disabled, malformed or zero-width', () => {
  assert.equal(inQuietHours(at(23, 30), {}), false);
  assert.equal(inQuietHours(at(23, 30), { quietHours: { start: '22:00', end: '07:00', enabled: false } }), false);
  assert.equal(inQuietHours(at(23, 30), { quietHours: { start: 'late', end: 'early' } }), false);
  assert.equal(inQuietHours(at(23, 30), { quietHours: { start: '22:00', end: '22:00' } }), false);
  assert.equal(inQuietHours(at(23, 30), { quietHours: { start: '22:00', end: '07:00', enabled: true, timezone: 'Not/AZone' } }),
    true, 'an unusable zone falls back to UTC rather than silently disabling quiet hours');
});

// --------------------------------------------------------------- shouldSpeak

test('routine progress speaks at normal priority in the clear', () => {
  const clock = new FakeClock(NOON, 'UTC');
  const d = shouldSpeak({ type: 'task.completed', payload: { projectId: 'p1' } }, { settings: {}, clock });
  assert.deepEqual(d, { speak: true, reason: 'batched', priority: 'normal' });
});

test('delivery, blockers and questions speak at high priority', () => {
  const clock = new FakeClock(NOON, 'UTC');
  for (const type of ['project.delivered', 'project.blocked', 'question.asked']) {
    const d = shouldSpeak({ type, payload: { projectId: 'p1' } }, { settings: {}, clock });
    assert.equal(d.speak, true, type);
    assert.equal(d.priority, 'high', type);
    assert.equal(d.reason, 'always', type);
  }
});

test('mute wins over everything, blockers included', () => {
  const clock = new FakeClock(NOON, 'UTC');
  for (const type of ['project.blocked', 'question.asked', 'project.delivered', 'task.completed', 'feature.completed']) {
    const d = shouldSpeak({ type, payload: { projectId: 'p1' } }, { settings: { muted: true }, clock });
    assert.equal(d.speak, false, `${type} must be silenced by mute`);
    assert.equal(d.reason, 'muted', type);
  }
});

test('voiceEnabled:false silences speech without being mute', () => {
  const clock = new FakeClock(NOON, 'UTC');
  const d = shouldSpeak({ type: 'project.delivered', payload: {} }, { settings: { voiceEnabled: false }, clock });
  assert.equal(d.speak, false);
  assert.equal(d.reason, 'voice_disabled');
});

test('quiet hours suppress everything except blockers and questions', () => {
  const clock = at(23, 30);
  const settings = CROSSES_MIDNIGHT;

  for (const type of ['project.delivered', 'project.evaluated', 'feature.completed', 'task.completed', 'task.started', 'project.phase']) {
    const d = shouldSpeak({ type, payload: { projectId: 'p1' } }, { settings, clock });
    assert.equal(d.speak, false, `${type} must stay quiet at 23:30`);
    assert.equal(d.reason, 'quiet_hours', type);
  }
  for (const type of ['project.blocked', 'question.asked']) {
    const d = shouldSpeak({ type, payload: { projectId: 'p1' } }, { settings, clock });
    assert.equal(d.speak, true, `${type} must break quiet hours`);
    assert.equal(d.priority, 'high', type);
  }
});

test('events with nothing to say are refused', () => {
  const clock = new FakeClock(NOON, 'UTC');
  for (const type of ['capacity.updated', 'project.created', 'project.updated', 'worker.started', 'speech.say']) {
    const d = shouldSpeak({ type, payload: {} }, { settings: {}, clock });
    assert.equal(d.speak, false, `${type} is not worth speaking`);
    assert.equal(d.reason, 'not_notable', type);
  }
  // Blake's own words are never read back to him; only assistant replies speak.
  const mine = shouldSpeak({ type: 'chat.message', payload: { turn: { role: 'user', text: 'build a thing' } } }, { settings: {}, clock });
  assert.equal(mine.speak, false);
  assert.equal(mine.reason, 'not_assistant_turn');
  const reply = shouldSpeak({ type: 'chat.message', payload: { turn: { role: 'assistant', text: "I'm on it." } } }, { settings: {}, clock });
  assert.equal(reply.speak, true, 'an assistant reply is spoken as shown');
  assert.equal(reply.priority, 'normal');
  assert.deepEqual(shouldSpeak(null, { settings: {}, clock }),
    { speak: false, reason: 'unknown_event', priority: 'normal' });
});

// ------------------------------------------------------------ renderSentence

test('renderSentence produces the exact sentences the orchestrator shows', () => {
  const project = { id: 'p1', title: 'Shopping list', status: 'delivered' };
  assert.equal(
    renderSentence({ type: 'project.delivered', payload: { projectId: 'p1', project } }),
    'I delivered Shopping list.',
  );
  assert.equal(
    renderSentence({ type: 'project.evaluated', payload: { projectId: 'p1', project: { ...project, status: 'evaluated' } } }),
    'I finished evaluating Shopping list.',
  );
  assert.equal(
    renderSentence({ type: 'project.paused', payload: { projectId: 'p1', project } }),
    'I paused Shopping list.',
  );
  assert.equal(
    renderSentence({ type: 'project.phase', payload: { projectId: 'p1', phase: 'implementing' } }, { projectTitle: 'Shopping list' }),
    'I am building Shopping list.',
  );
});

test('a blocker speaks the reason, trimmed to its first sentence', () => {
  const reason = 'I need working credentials: token expired. Give me that and I will pick Deploy script straight back up.';
  const text = renderSentence({ type: 'project.blocked', payload: { projectId: 'p1', reason } });
  assert.equal(text, 'I need working credentials: token expired.');
  assert.equal(sentenceCount(text), 1);
});

test('a question is announced verbatim, keeping its question mark', () => {
  const text = renderSentence({
    type: 'question.asked',
    payload: { projectId: 'p1', questionId: 'q1', text: 'Should sync be last-write-wins or merge?' },
  });
  assert.equal(text, 'I need to know: Should sync be last-write-wins or merge?');
  assert.equal(sentenceCount(text), 1);
});

test('task titles become past or present tense first-person clauses', () => {
  const done = (title) => renderSentence({ type: 'task.completed', payload: { projectId: 'p1', taskId: 't1', title } });
  assert.equal(done('Build the login form'), 'I built the login form.');
  assert.equal(done('Verify Shopping list'), 'I verified Shopping list.');
  assert.equal(done('Review Shopping list'), 'I reviewed Shopping list.');
  assert.equal(done('Update autosave'), 'I updated autosave.');
  assert.equal(done('Polish'), 'I finished Polish.', 'a title with no leading verb falls back cleanly');

  const started = (title) => renderSentence({ type: 'task.started', payload: { projectId: 'p1', taskId: 't1', title } });
  assert.equal(started('Build the login form'), 'I am building the login form.');
  assert.equal(started('Polish'), 'I am working on Polish.');
  assert.match(started('Build the login form'), /^I am /, 'a start is never phrased as "I started ..."');
});

test('feature.completed and task.completed render the same sentence for the same work', () => {
  const payload = { projectId: 'p1', taskId: 't1', title: 'Build autosave' };
  assert.equal(
    renderSentence({ type: 'feature.completed', payload }),
    renderSentence({ type: 'task.completed', payload }),
  );
  assert.equal(renderSentence({ type: 'feature.completed', payload }), 'I built autosave.');
});

test('renderSentence returns null when an event has nothing to say', () => {
  assert.equal(renderSentence({ type: 'capacity.updated', payload: {} }), null);
  assert.equal(renderSentence({ type: 'project.phase', payload: { phase: 'idle' } }), null);
  assert.equal(renderSentence({ type: 'question.asked', payload: { text: '   ' } }), null);
  assert.equal(renderSentence(null), null);
});

test('rendered sentences carry no markdown and no emoji', () => {
  const text = renderSentence({ type: 'project.blocked', payload: { reason: '**Blocked** 🚀 on the `deploy` key.' } });
  assert.equal(text, 'Blocked on the deploy key.');
  assert.equal(/[*`#]/.test(text), false);
  assert.equal(/\p{Extended_Pictographic}/u.test(text), false);
});

test('a very long sentence is truncated rather than rambling', () => {
  const title = 'x'.repeat(400);
  const text = renderSentence({ type: 'project.delivered', payload: { project: { title } } });
  assert.equal(text.length, 120);
  assert.equal(text.endsWith('…'), true);
});

test('oneSentence collapses whitespace and keeps only the first sentence', () => {
  assert.equal(oneSentence('  I did   the thing.\nThen more.  '), 'I did the thing.');
  assert.equal(oneSentence(''), '');
  assert.equal(oneSentence('abcdefghij', 5), 'abcd…');
});

test('renderSentence accepts a bare payload as well as a bus envelope', () => {
  const envelope = { seq: 7, type: 'project.delivered', payload: { project: { title: 'Colour picker' } } };
  const bare = { type: 'project.delivered', project: { title: 'Colour picker' } };
  assert.equal(renderSentence(envelope), 'I delivered Colour picker.');
  assert.equal(renderSentence(bare), 'I delivered Colour picker.');
});
