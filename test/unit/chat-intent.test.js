import test from 'node:test';
import assert from 'node:assert/strict';
import { classify, titleFrom, INTENT_KINDS, CONFIDENCE } from '../../src/chat/intent.js';

const NO_CTX = {};
const ACTIVE = { activeProjectId: 'p_active' };
const withQuestion = (options = ['Postgres', 'SQLite']) => ({
  activeProjectId: 'p_active',
  openQuestion: { id: 'q_1', projectId: 'p_active', text: 'Which database?', options },
});

const kindOf = (text, ctx = NO_CTX) => classify(text, ctx).kind;

test('evaluation markers beat build language', () => {
  const intent = classify('Build me a CLI but evaluate only first', NO_CTX);
  assert.equal(intent.kind, 'evaluate_only');
  assert.equal(intent.payload.evaluationOnly, true);
  assert.ok(intent.confidence >= 0.8, `expected high confidence, got ${intent.confidence}`);
  // The goal handed on is the work, with the instruction about it stripped out.
  assert.equal(intent.payload.text, 'Build me a CLI');
  assert.doesNotMatch(intent.payload.text, /evaluate only/i);
});

test('every evaluation phrasing lands on evaluate_only, never build', () => {
  const phrasings = [
    "don't build yet, tell me what a Slack digest bot would take",
    'just evaluate a slack bot for standups',
    'assessment only please',
    'review only, no code',
    'scope out a payments integration, no code yet',
    'do not implement it, evaluate first',
    'evaluation only for the mobile port',
    'look at a Stripe migration without building it',
  ];
  for (const text of phrasings) {
    assert.equal(kindOf(text), 'evaluate_only', `misclassified: ${text}`);
  }
});

test('a product description containing "review only" is still a build', () => {
  const intent = classify('Build a forum where users can review only their own posts', NO_CTX);
  assert.equal(intent.kind, 'build');
  assert.equal(intent.payload.evaluationOnly, false);
});

test('pause markers classify as pause', () => {
  for (const text of ['pause', 'hold on', 'wait', 'pause the build for a bit', 'hold off for now']) {
    assert.equal(kindOf(text, ACTIVE), 'pause', `misclassified: ${text}`);
  }
});

test('stop markers classify as stop', () => {
  for (const text of ['stop', 'cancel that', 'abort', 'stop the build', 'scrap it', 'I want you to stop']) {
    assert.equal(kindOf(text, ACTIVE), 'stop', `misclassified: ${text}`);
  }
});

test('control words inside a project description do not hijack the intent', () => {
  assert.equal(kindOf('build a tool to cancel subscriptions'), 'build');
  assert.equal(kindOf('build a CLI that can pause and resume downloads'), 'build');
  assert.equal(kindOf('build a status page for the API'), 'build');
});

test('resume markers classify as resume', () => {
  for (const text of ['continue', 'keep going', 'resume', 'carry on', 'pick it back up']) {
    assert.equal(kindOf(text, ACTIVE), 'resume', `misclassified: ${text}`);
  }
});

test('change language with an active project classifies as change and carries the change', () => {
  const cases = [
    ['change that', /change that/i],
    ['actually make it TypeScript', /TypeScript/],
    ['also add dark mode', /dark mode/],
    ['instead use Postgres', /Postgres/],
    ['switch it to Rust', /Rust/],
    ['add a settings page', /settings page/],
  ];
  for (const [text, expected] of cases) {
    const intent = classify(text, ACTIVE);
    assert.equal(intent.kind, 'change', `misclassified: ${text}`);
    assert.match(intent.payload.text, expected);
    assert.equal(intent.payload.projectId, 'p_active');
  }
});

test('change payload drops conversational scaffolding', () => {
  assert.equal(classify('actually make it TypeScript', ACTIVE).payload.text, 'make it TypeScript');
  assert.equal(classify('ok, can you switch it to Rust', ACTIVE).payload.text, 'switch it to Rust');
});

test('change language without an active project is not a change', () => {
  const intent = classify('actually make it a TypeScript CLI', NO_CTX);
  assert.notEqual(intent.kind, 'change');
  assert.equal(intent.kind, 'build');
});

test('status language classifies as status', () => {
  for (const text of ["what's the status", "how's it going", 'where are we', 'give me an update', 'any progress?']) {
    assert.equal(kindOf(text, ACTIVE), 'status', `misclassified: ${text}`);
  }
});

test('a bare reply while a question is open is an answer', () => {
  const ctx = withQuestion();
  const intent = classify('postgres', ctx);
  assert.equal(intent.kind, 'answer');
  assert.equal(intent.payload.questionId, 'q_1');
  assert.equal(intent.payload.projectId, 'p_active');
  assert.equal(intent.payload.text, 'postgres');
});

test('picking an offered option while a question is open is an answer', () => {
  const ctx = withQuestion();
  for (const text of ['the second option', 'option 2', 'SQLite']) {
    const intent = classify(text, ctx);
    assert.equal(intent.kind, 'answer', `misclassified: ${text}`);
    assert.ok(intent.confidence >= CONFIDENCE.bareAnswer);
  }
});

test('an open question does not turn a fresh build request into an answer', () => {
  assert.equal(kindOf('Build me a slack bot that posts standups', withQuestion()), 'build');
});

test('affirmatives approve only when something is waiting on approval', () => {
  assert.equal(kindOf('yes', withQuestion()), 'approve');
  assert.equal(classify('yes', withQuestion()).payload.questionId, 'q_1');
  assert.equal(kindOf('yes', NO_CTX), 'chitchat');
  assert.equal(kindOf('looks good, ship it', NO_CTX), 'approve');
});

test('reminder language extracts the task and the time', () => {
  const intent = classify('remind me to call the dentist at 5pm', NO_CTX);
  assert.equal(intent.kind, 'reminder');
  assert.equal(intent.payload.text, 'call the dentist');
  assert.match(intent.payload.when, /5pm/i);
  assert.equal(intent.payload.raw, 'remind me to call the dentist at 5pm');

  const second = classify('set a reminder to review the invoice tomorrow', NO_CTX);
  assert.equal(second.kind, 'reminder');
  assert.equal(second.payload.text, 'review the invoice');
  assert.match(second.payload.when, /tomorrow/i);
});

test('a substantive project description is a build with a usable title', () => {
  const intent = classify('Build me a CLI that renames photo files by EXIF date', NO_CTX);
  assert.equal(intent.kind, 'build');
  assert.equal(intent.payload.title, 'CLI that renames photo files by EXIF date');
  assert.equal(intent.payload.evaluationOnly, false);
  assert.ok(intent.confidence >= 0.7, `expected confident build, got ${intent.confidence}`);
});

test('short social text is chitchat, and questions are questions', () => {
  for (const text of ['hey', 'thanks!', 'how are you?', 'good morning']) {
    assert.equal(kindOf(text), 'chitchat', `misclassified: ${text}`);
  }
  const usage = classify('how much usage do I have left?', NO_CTX);
  assert.equal(usage.kind, 'question');
  assert.equal(usage.payload.topic, 'capacity');
  assert.equal(kindOf('can you build me a CLI?'), 'build');
});

test('explicit markers are more confident than inferred ones', () => {
  const explicit = classify('stop', ACTIVE).confidence;
  const inferred = classify('a small utility for tidying up my downloads folder', NO_CTX).confidence;
  assert.ok(explicit > inferred, `${explicit} should beat ${inferred}`);
  assert.ok(classify('hey', NO_CTX).confidence < classify('Build me a CLI tool', NO_CTX).confidence);
});

test('every classification is well formed for a broad corpus', () => {
  const corpus = [
    '', '   ', 'hey', 'stop', 'pause', 'continue', "what's the status", 'remind me to stretch',
    'Build me a CLI but evaluate only first', 'also add dark mode', 'option 2', 'yes',
    'why did that fail?', 'the deploy pipeline keeps timing out on the verify step',
  ];
  for (const text of corpus) {
    for (const ctx of [NO_CTX, ACTIVE, withQuestion()]) {
      const intent = classify(text, ctx);
      assert.ok(INTENT_KINDS.includes(intent.kind), `bad kind ${intent.kind} for ${JSON.stringify(text)}`);
      assert.equal(typeof intent.confidence, 'number');
      assert.ok(intent.confidence >= 0 && intent.confidence <= 1, `confidence out of range: ${intent.confidence}`);
      assert.ok(intent.payload && typeof intent.payload === 'object');
      assert.equal(typeof intent.payload.text, 'string');
    }
  }
});

test('classify tolerates junk input without throwing', () => {
  for (const junk of [null, undefined, 42, {}, [], true]) {
    const intent = classify(junk, undefined);
    assert.ok(INTENT_KINDS.includes(intent.kind));
  }
  assert.equal(classify('hi', null).kind, 'chitchat');
});

test('titleFrom strips request scaffolding', () => {
  assert.equal(titleFrom('please build me a habit tracker'), 'Habit tracker');
  assert.equal(titleFrom('can you create an invoice parser'), 'Invoice parser');
  assert.equal(titleFrom(''), 'Untitled project');
  assert.ok(titleFrom('build '.padEnd(200, 'x')).length <= 70);
});
