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
    const intent = classify(text, NO_CTX);
    assert.equal(intent.kind, 'evaluate_only', `misclassified: ${text}`);
    // The flag the orchestrator actually branches on — a kind alone is not enough.
    assert.equal(intent.payload.evaluationOnly, true, `evaluationOnly not set for: ${text}`);
    assert.equal(intent.confidence, CONFIDENCE.evaluateOnly, `wrong confidence for: ${text}`);
    assert.equal(intent.payload.raw, text, `raw utterance lost for: ${text}`);
    assert.equal(intent.payload.goal, intent.payload.text, `goal and text disagree for: ${text}`);
    assert.ok(intent.payload.title.length > 0, `no title derived for: ${text}`);
  }
});

test('the evaluation marker is cut out of the goal handed on', () => {
  const cases = [
    ['Build me a CLI but evaluate only first', 'Build me a CLI'],
    ['just evaluate a slack bot for standups', 'a slack bot for standups'],
    ['scope out a payments integration, no code yet', 'scope out a payments integration'],
    ['look at a Stripe migration without building it', 'look at a Stripe migration'],
    ["don't build yet, tell me what a Slack digest bot would take", 'tell me what a Slack digest bot would take'],
  ];
  for (const [text, goal] of cases) {
    const intent = classify(text, NO_CTX);
    assert.equal(intent.kind, 'evaluate_only', `misclassified: ${text}`);
    assert.equal(intent.payload.goal, goal, `wrong goal for: ${text}`);
  }
  // When the marker IS the whole message there is no work to strip, so the
  // utterance stands in rather than handing the orchestrator an empty goal.
  const bare = classify('assessment only please', NO_CTX);
  assert.equal(bare.kind, 'evaluate_only');
  assert.equal(bare.payload.goal, 'assessment only please');
});

test('a go-ahead preamble does not swallow the brief that follows it', () => {
  // "go ahead"/"carry on" in front of a real brief is a preamble, not the
  // instruction: approving nothing, or resuming nothing, loses the request.
  const briefs = [
    'go ahead and build me a slack bot',
    'go on and build me a CLI',
    'ok go ahead and create an invoice parser',
    'perfect, now build me a CLI',
    'carry on and build the dashboard too',
    'proceed to build the exporter',
  ];
  for (const text of briefs) {
    const intent = classify(text, NO_CTX);
    assert.equal(intent.kind, 'build', `preamble swallowed the brief: ${text}`);
    assert.equal(intent.payload.evaluationOnly, false);
    assert.ok(intent.payload.title.length > 0, `no title for: ${text}`);
  }

  // With work in flight, the same preamble in front of an addition is a change.
  const addition = classify('carry on and also add dark mode', ACTIVE);
  assert.equal(addition.kind, 'change');
  assert.equal(addition.payload.projectId, 'p_active');

  // A bare go-ahead is still exactly that.
  assert.equal(kindOf('go ahead', withQuestion()), 'approve');
  assert.equal(kindOf('carry on', ACTIVE), 'resume');
  assert.equal(kindOf('looks good, ship it', NO_CTX), 'approve');
});

test('an offered option only matches on whole words', () => {
  // "No" must not be answered by the word "know": silently answering a decision
  // card with text that was never a choice is the failure the card prevents.
  const yesNo = withQuestion(['Yes', 'No']);
  for (const text of [
    'I need to know how long this will take before deciding',
    'there is nothing blocking us on the frontend side',
  ]) {
    assert.notEqual(classify(text, yesNo).kind, 'answer', `spurious option match: ${text}`);
  }

  // Genuine picks still land, and at full option confidence.
  const db = withQuestion();
  assert.equal(classify('SQLite', db).confidence, CONFIDENCE.optionAnswer);
  assert.equal(classify('no', yesNo).kind, 'answer', 'the actual word "no" is still an answer');
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
    // An explicit pick is more certain than a bare reply, and says so.
    assert.equal(intent.confidence, CONFIDENCE.optionAnswer, `wrong confidence for: ${text}`);
    assert.ok(CONFIDENCE.optionAnswer > CONFIDENCE.bareAnswer, 'a pick must outrank a bare reply');
    assert.equal(intent.payload.questionId, 'q_1', `question not carried for: ${text}`);
    assert.equal(intent.payload.projectId, 'p_active', `project not carried for: ${text}`);
    assert.equal(intent.payload.text, text);
  }
  // A reply that is not one of the offered choices is still an answer, but a
  // less certain one — the caller uses that gap to decide whether to confirm.
  const offList = classify('mysql', ctx);
  assert.equal(offList.kind, 'answer');
  assert.equal(offList.confidence, CONFIDENCE.bareAnswer);
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

test('classify tolerates junk input and still returns a usable intent', () => {
  for (const junk of [null, undefined, 42, {}, [], true]) {
    const intent = classify(junk, undefined);
    assert.ok(INTENT_KINDS.includes(intent.kind), `bad kind for ${String(junk)}`);
    assert.equal(typeof intent.payload.text, 'string', `payload.text not a string for ${String(junk)}`);
    assert.ok(intent.confidence >= 0 && intent.confidence <= 1, `confidence out of range for ${String(junk)}`);
  }
  // Nothing said means nothing to act on, and the confidence must admit it.
  for (const empty of [null, undefined, '', '   ', []]) {
    const intent = classify(empty, {});
    assert.equal(intent.kind, 'chitchat', `expected chitchat for ${JSON.stringify(empty)}`);
    assert.equal(intent.payload.text, '');
    assert.equal(intent.confidence, CONFIDENCE.empty);
  }
  assert.equal(classify('hi', null).kind, 'chitchat');
  assert.equal(classify('build me a CLI', null).kind, 'build', 'a null ctx must not disable classification');
});

/**
 * ADDITIONAL — hardest requirement #1: precedence.
 *
 * The module's whole job is deciding which marker wins when several are
 * present, and the documented order is
 *   stop > pause > evaluate_only > resume > reminder > approve > change >
 *   status > answer > social > question > build.
 * Each case below carries BOTH markers, so a rung swapped with its neighbour
 * flips the answer. The richest possible ctx (active project + open question
 * whose options could also match) is used throughout, because that is exactly
 * where a lower rung would steal the classification.
 */
test('the precedence ladder holds when two markers collide', () => {
  const rich = {
    activeProjectId: 'p_active',
    openQuestion: { id: 'q_1', projectId: 'p_active', text: 'Which database?', options: ['Postgres', 'stop'] },
    lastOptions: ['Postgres', 'stop'],
  };

  const ladder = [
    // stop beats pause: "cancel" and "hold on" together must abandon, not wait.
    ['stop', 'cancel that, hold on'],
    // stop beats resume.
    ['stop', 'stop, do not continue'],
    // pause beats evaluate_only: waiting outranks starting an evaluation.
    ['pause', 'hold on, just evaluate it'],
    // evaluate_only beats resume, reminder, change, status, answer and build.
    ['evaluate_only', 'continue but evaluate only first'],
    ['evaluate_only', 'remind me — evaluation only for the mobile port'],
    ['evaluate_only', 'actually make it a Rust CLI, but do not build it yet'],
    ['evaluate_only', "what's the status — and just assess the Redis move"],
    ['evaluate_only', 'Postgres, but evaluate only first'],
    ['evaluate_only', 'build me a CLI but evaluate only first'],
    // resume beats reminder and status.
    ['resume', 'keep going'],
    // reminder beats approve, change and status.
    ['reminder', 'remind me to approve the invoice tomorrow'],
    ['reminder', "remind me to check the status at 5pm"],
    // approve beats change, status and answer.
    ['approve', 'looks good, ship it'],
    // change beats status and answer.
    ['change', "actually make it TypeScript — what's the status"],
    // status beats answer: asking is not answering.
    ['status', "what's the status"],
    // answer beats build language only when the build language is absent.
    ['answer', 'Postgres'],
    // build is last: nothing else fit.
    ['build', 'build me a habit tracker with streaks'],
  ];

  for (const [expected, text] of ladder) {
    assert.equal(classify(text, rich).kind, expected, `precedence broke for: ${text}`);
  }

  // And the one rule the contract states outright: an explicit stop, pause or
  // evaluation marker must never come back as `build`.
  for (const text of [
    'stop the build', 'pause the build', 'cancel the build', 'abort',
    'build me a CLI but evaluate only first', "don't build yet",
  ]) {
    assert.notEqual(classify(text, rich).kind, 'build', `build leaked through: ${text}`);
  }
});

test('titleFrom strips request scaffolding', () => {
  assert.equal(titleFrom('please build me a habit tracker'), 'Habit tracker');
  assert.equal(titleFrom('can you create an invoice parser'), 'Invoice parser');
  assert.equal(titleFrom(''), 'Untitled project');
  assert.ok(titleFrom('build '.padEnd(200, 'x')).length <= 70);
});
