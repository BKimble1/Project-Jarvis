import test from 'node:test';
import assert from 'node:assert/strict';

import {
  usageViewModel,
  renderUsage,
  ringGeometry,
  formatAge,
  RING_RADIUS,
  UNAVAILABLE_LABEL,
} from '../../public/modules/usage.js';
import { createChat } from '../../public/modules/chat.js';
import { createSpeech } from '../../public/modules/speech.js';

/**
 * The dashboard's usage circles (acceptance req. 4 + 5) are driven entirely by
 * `usageViewModel`, a pure function over the server `Report`. Testing it here
 * pins the three honest states — live, stale, unavailable — and above all pins
 * the invariant that "unknown" can never be mistaken for "0% used".
 */

const TZ = 'America/Los_Angeles';

function liveReport(overrides = {}) {
  return {
    status: 'live',
    measuredAt: 1_700_000_000_000,
    ageMs: 12_000,
    timezone: TZ,
    windows: [
      {
        key: 'five_hour',
        label: '5-hour',
        utilization: 0.32,
        usedPercent: 32,
        remainingPercent: 68,
        resetsAt: 1_700_005_400_000,
        unit: 'percent',
        source: 'claude-subscription',
        measuredAt: 1_700_000_000_000,
        resetsAtLocal: 'Tue, Nov 14, 3:30 PM',
        freshness: 'live',
      },
      {
        key: 'seven_day_opus',
        label: '7-day (Opus)',
        utilization: 0.9,
        usedPercent: 90,
        remainingPercent: 10,
        resetsAt: 1_700_300_000_000,
        unit: 'percent',
        source: 'claude-subscription',
        measuredAt: 1_700_000_000_000,
        resetsAtLocal: 'Fri, Nov 17, 9:00 AM',
        freshness: 'live',
      },
    ],
    explanation: null,
    recovery: null,
    lastError: null,
    staleAfterMs: 900_000,
    ...overrides,
  };
}

function staleReport() {
  const base = liveReport();
  return {
    ...base,
    status: 'stale',
    ageMs: 42 * 60_000,
    windows: base.windows.map((w) => ({ ...w, freshness: 'stale' })),
    explanation: 'The last usage refresh failed (network); showing the reading from 2520s ago.',
    recovery: 'Retry the usage refresh.',
    lastError: { reason: 'network', message: 'boom', remedy: 'Retry the usage refresh.', at: 1 },
  };
}

function unavailableReport() {
  return {
    status: 'unavailable',
    measuredAt: null,
    ageMs: null,
    timezone: TZ,
    windows: [],
    explanation: 'No subscription OAuth token is available, so usage cannot be read.',
    recovery: 'Run `claude setup-token` so Jarvis can read your subscription limits, then retry.',
    lastError: { reason: 'not_authenticated', message: 'no token', remedy: 'Run `claude setup-token`.', at: 1 },
    staleAfterMs: 900_000,
  };
}

// ---------------------------------------------------------------------- live

test('live: one solid ring per reported window with real used, remaining and reset time', () => {
  const vm = usageViewModel(liveReport());

  assert.equal(vm.state, 'live');
  assert.equal(vm.circles.length, 2, 'one circle per window the server actually reported');
  assert.equal(vm.placeholder, null, 'a live reading has no unknown placeholder');

  const five = vm.circles.find((c) => c.key === 'five_hour');
  assert.equal(five.label, '5-hour');
  assert.equal(five.ringStyle, 'solid');
  assert.equal(five.usedPercent, 32);
  assert.equal(five.remainingPercent, 68);
  assert.equal(five.usedText, '32% used');
  assert.equal(five.remainingText, '68% left');
  assert.equal(five.percentText, '32%');
  assert.equal(five.resetLabel, 'Resets Tue, Nov 14, 3:30 PM', 'reset time in the operator timezone');
  assert.equal(five.freshness, 'live');
  assert.equal(five.note, null, 'nothing to caveat on a live reading');
  assert.equal(five.tone, 'ok');

  const seven = vm.circles.find((c) => c.key === 'seven_day_opus');
  assert.equal(seven.tone, 'critical', '90% used is flagged, not merely drawn');
  assert.match(seven.ariaLabel, /7-day \(Opus\) window, 90% used, 10% left/);
});

test('live: the freshness line states liveness, age and timezone', () => {
  const vm = usageViewModel(liveReport());
  assert.equal(vm.headline, 'Usage · live');
  assert.equal(vm.ageLabel, '12s');
  assert.match(vm.freshnessLine, /Live reading, measured 12s ago/);
  assert.match(vm.freshnessLine, /America\/Los_Angeles/);
  assert.equal(vm.stale, false);
});

test('ring geometry maps used percent onto the arc', () => {
  const circumference = 2 * Math.PI * RING_RADIUS;
  const empty = ringGeometry(0);
  const quarter = ringGeometry(25);
  const full = ringGeometry(100);

  assert.equal(empty.dashOffset, circumference, '0% leaves the whole ring unpainted');
  assert.ok(Math.abs(quarter.dashOffset - circumference * 0.75) < 1e-9);
  assert.equal(full.dashOffset, 0);
  assert.equal(usageViewModel(liveReport()).circles[0].geometry.dashArray, circumference);
});

// --------------------------------------------------------------------- stale

test('stale: same numbers, but visibly marked as last known with its age', () => {
  const vm = usageViewModel(staleReport());

  assert.equal(vm.state, 'stale');
  assert.equal(vm.stale, true);
  assert.equal(vm.ageLabel, '42m');
  assert.equal(vm.headline, 'Usage · last known, 42m ago');

  assert.equal(vm.circles.length, 2, 'the last known windows are still drawn');
  for (const circle of vm.circles) {
    assert.equal(circle.ringStyle, 'solid', 'a stale reading is a real reading, so the ring stays solid');
    assert.equal(circle.freshness, 'stale');
    assert.equal(circle.note, 'last known, 42m ago');
    assert.match(circle.ariaLabel, /last known, 42m ago/);
  }
  assert.equal(vm.circles[0].usedPercent, 32, 'the last known number is preserved verbatim');
  assert.match(vm.freshnessLine, /Last known reading, 42m old/);
  assert.ok(vm.explanation, 'a stale reading explains why it is not live');
  assert.equal(vm.recoveryAction.endpoint, '/api/capacity/refresh', 'and offers a refresh');
  assert.doesNotMatch(vm.headline, /live/i, 'stale is never presented as live');
});

// --------------------------------------------------------------- unavailable

test('unavailable: a dashed grey ring reading "Unavailable", with explanation and recovery', () => {
  const vm = usageViewModel(unavailableReport());

  assert.equal(vm.state, 'unavailable');
  assert.match(vm.headline, /unavailable/i);
  assert.equal(vm.circles.length, 0, 'no filled ring is drawn for an unknown reading');
  assert.equal(vm.placeholder.ringStyle, 'dashed');
  assert.equal(vm.placeholder.tone, 'grey');
  assert.equal(vm.placeholder.label, 'Unavailable');
  assert.equal(vm.placeholder.percentText, null, 'the placeholder carries no percentage at all');
  assert.equal(vm.explanationExpandable, true);
  assert.match(vm.explanation, /token/i);
  assert.match(vm.recovery, /setup-token/);
  assert.equal(vm.recoveryAction.label, 'Retry usage check');
  assert.equal(vm.recoveryAction.method, 'POST');
  assert.equal(vm.lastErrorReason, 'not_authenticated');
});

test('unavailable can never be confused with 0% used', () => {
  const unknown = usageViewModel(unavailableReport());

  // A genuine zero reading: same shape of report, a real measured 0.
  const zero = usageViewModel(liveReport({
    windows: [{
      key: 'five_hour',
      label: '5-hour',
      usedPercent: 0,
      remainingPercent: 100,
      resetsAt: 1_700_005_400_000,
      resetsAtLocal: 'Tue, Nov 14, 3:30 PM',
      freshness: 'live',
    }],
  }));

  // The zero reading is a real, solid, numbered ring.
  assert.equal(zero.state, 'live');
  assert.equal(zero.circles.length, 1);
  assert.equal(zero.circles[0].ringStyle, 'solid');
  assert.equal(zero.circles[0].percentText, '0%');
  assert.equal(zero.circles[0].usedText, '0% used');
  assert.equal(zero.circles[0].remainingText, '100% left');
  assert.equal(zero.placeholder, null);
  assert.doesNotMatch(zero.headline, /unavailable/i);

  // The unknown reading shares none of that.
  assert.notEqual(unknown.state, zero.state);
  assert.notEqual(unknown.circles.length, zero.circles.length);
  assert.notEqual(unknown.placeholder, null);
  assert.equal(unknown.placeholder.ringStyle, 'dashed');
  assert.notEqual(unknown.placeholder.ringStyle, zero.circles[0].ringStyle);

  // And it carries no number anywhere that a reader (or a screen reader) could
  // mistake for a measurement.
  const serialized = JSON.stringify(unknown);
  assert.ok(!/usedPercent/.test(serialized), 'the unknown view model has no usedPercent field');
  assert.ok(!/remainingPercent/.test(serialized), 'nor a remainingPercent field');
  assert.ok(!/\d+%/.test(serialized), `no percentage text at all, got: ${serialized}`);
  assert.ok(!/\b0\b/.test(unknown.placeholder.label + unknown.placeholder.detail), 'and never the digit 0 as a stand-in');
});

test('a malformed or empty "live" report degrades to unavailable, never to a 0% ring', () => {
  for (const windows of [[], null, [{ key: 'x', usedPercent: null }], [{ key: 'y', usedPercent: 'NaN' }]]) {
    const vm = usageViewModel(liveReport({ windows }));
    assert.equal(vm.state, 'unavailable', `windows=${JSON.stringify(windows)} must not become a ring`);
    assert.equal(vm.circles.length, 0);
    assert.equal(vm.placeholder.label, UNAVAILABLE_LABEL, 'it shows the unknown placeholder instead');
    assert.equal(
      vm.explanation,
      'The last usage measurement arrived without any usable capacity window.',
      'and says exactly why, rather than showing an empty panel',
    );
    assert.match(vm.recovery, /setup-token/, 'with a concrete way out');
    assert.equal(vm.recoveryAction.endpoint, '/api/capacity/refresh');
    assert.doesNotMatch(JSON.stringify(vm), /\d+%/, 'and no percentage anywhere in it');
  }
});

test('a missing or nonsense report renders as unavailable rather than throwing', () => {
  for (const input of [null, undefined, {}, 'nope', 42, { status: 'weird' }]) {
    const vm = usageViewModel(input);
    assert.equal(vm.state, 'unavailable');
    assert.equal(vm.circles.length, 0);
    assert.match(vm.headline, /unavailable/i);
    assert.match(vm.explanation, /unknown — not zero/, 'the default explanation names the distinction');
    assert.match(vm.recovery, /setup-token/, 'and the default recovery is an instruction, not a shrug');
    assert.equal(vm.recoveryAction.label, 'Retry usage check');
    assert.equal(vm.lastErrorReason, null, 'no error is invented when the report is simply absent');
    assert.equal(vm.timezone, 'UTC', 'an unknown timezone falls back to UTC, not to undefined');
  }
});

test('a window with a partial reading still yields a truthful remaining figure', () => {
  const vm = usageViewModel(liveReport({
    windows: [{ key: 'five_hour', label: '5-hour', usedPercent: 41.4, resetsAtLocal: null, freshness: 'live' }],
  }));
  assert.equal(vm.circles.length, 1);
  assert.equal(vm.circles[0].usedPercent, 41.4, 'the precise reading is kept');
  assert.equal(vm.circles[0].percentText, '41%', 'the ring label is rounded for legibility');
  assert.equal(vm.circles[0].remainingPercent, 58.6, 'remaining is derived, not invented');
  assert.equal(vm.circles[0].resetLabel, null, 'no reset line when the provider did not report one');
});

// ----------------------------------------------------------------- age labels

test('formatAge is compact and honest across the units', () => {
  assert.equal(formatAge(0), '0s');
  assert.equal(formatAge(12_000), '12s');
  assert.equal(formatAge(42 * 60_000), '42m');
  assert.equal(formatAge(90 * 60_000), '1h 30m');
  assert.equal(formatAge(3 * 3_600_000), '3h');
  assert.equal(formatAge(50 * 3_600_000), '2d 2h');
  assert.equal(formatAge(-1), null, 'a negative age is not an age');
  assert.equal(formatAge(Number.NaN), null);
  assert.equal(formatAge(undefined), null);
});

// ============================================================================
// The rendered DOM, not just the view model.
//
// Everything above pins `usageViewModel`. But the operator reads pixels, and a
// renderer can take the wrong branch of a perfectly good model — draw a value
// ring for an unknown reading, or paint the arc from the remaining percentage
// instead of the used one. These tests run the real DOM-building code against a
// micro-DOM (Node has no document, and the contract forbids an npm one) and
// assert on what actually lands on the page.
// ============================================================================

class MicroNode {
  constructor(tag, namespace = null) {
    this.tagName = String(tag).toUpperCase();
    this.namespaceURI = namespace;
    this.children = [];
    this.attributes = new Map();
    this.dataset = {};
    this.listeners = new Map();
    this.hidden = false;
    this.parentNode = null;
    this.scrollHeight = 0;
    this.scrollTop = 0;
    this.clientHeight = 0;
    this.ownText = '';
  }

  set className(value) { this.attributes.set('class', String(value)); }
  get className() { return this.attributes.get('class') ?? ''; }

  set textContent(value) { this.ownText = value === null || value === undefined ? '' : String(value); this.children = []; }
  get textContent() { return this.ownText + this.children.map((c) => c.textContent).join(''); }

  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; }

  appendChild(node) { node.parentNode = this; this.children.push(node); return node; }
  insertBefore(node, ref) {
    const at = this.children.indexOf(ref);
    if (at < 0) return this.appendChild(node);
    node.parentNode = this;
    this.children.splice(at, 0, node);
    return node;
  }
  replaceChildren(...nodes) { this.children = []; for (const node of nodes) this.appendChild(node); }

  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(fn);
  }
  dispatch(type, event = {}) { for (const fn of this.listeners.get(type) ?? []) fn(event); }

  /** Enough selector support for the one selector the modules actually use. */
  querySelectorAll(selector) {
    const match = /^([a-z]+)(?:\[([\w-]+)="([^"]*)"\])?$/i.exec(selector);
    if (!match) return [];
    const [, tag, attr, value] = match;
    return descendants(this).filter((n) => n.tagName === tag.toUpperCase()
      && (!attr || n.getAttribute(attr) === value));
  }

  focus() {}
}

function descendants(node, out = []) {
  for (const child of node.children) { out.push(child); descendants(child, out); }
  return out;
}

function findAll(root, className) {
  return descendants(root).filter((n) => n.className.split(/\s+/).includes(className));
}

const microDocument = {
  createElement: (tag) => new MicroNode(tag),
  createElementNS: (ns, tag) => new MicroNode(tag, ns),
  createTextNode: (text) => { const n = new MicroNode('#text'); n.textContent = text; return n; },
};

globalThis.document = microDocument;

// ------------------------------------------------------- renderUsage: unknown

test('renderUsage draws the unknown reading as a dashed ring with no number anywhere', () => {
  const root = new MicroNode('div');
  let recovered = 0;
  const vm = renderUsage(root, unavailableReport(), { onRecover: () => { recovered += 1; } });

  assert.equal(vm.state, 'unavailable');
  assert.equal(root.dataset.state, 'unavailable', 'the section is marked so the stylesheet can grey it');

  // The ring that is drawn is the dashed unknown one, and the value ring — the
  // one that would imply a measurement — is never created at all.
  assert.equal(findAll(root, 'ring-value').length, 0, 'no value arc for an unknown reading');
  const dashed = findAll(root, 'ring-unknown');
  assert.equal(dashed.length, 1, 'exactly one dashed placeholder ring');
  assert.equal(dashed[0].getAttribute('stroke-dasharray'), '5 7', 'and it is genuinely dashed');
  assert.equal(dashed[0].getAttribute('stroke-dashoffset'), null, 'a dashed ring carries no arc offset');

  // Nothing on screen can be read as a measurement.
  const text = root.textContent;
  assert.match(text, new RegExp(UNAVAILABLE_LABEL, 'i'));
  assert.doesNotMatch(text, /\d+\s*%/, `no percentage may be rendered, got: ${text}`);
  assert.doesNotMatch(text, /\b0\b/, `and never a bare zero, got: ${text}`);
  assert.match(text, /token/i, 'the explanation is on the page, not just in the model');
  assert.match(text, /setup-token/, 'and so is the recovery instruction');

  // The recovery button is real and wired.
  const button = descendants(root).find((n) => n.className === 'action-button');
  assert.ok(button, 'the recovery action is rendered as a button');
  assert.equal(button.type, 'button', 'and never a form-submitting one');
  assert.equal(button.textContent, 'Retry usage check');
  button.dispatch('click');
  button.dispatch('click');
  assert.equal(recovered, 2, 'each press asks for a refresh');
});

// ---------------------------------------------------------- renderUsage: live

test('renderUsage paints one arc per window, from the USED share and not its complement', () => {
  const root = new MicroNode('div');
  renderUsage(root, liveReport());

  const arcs = findAll(root, 'ring-value');
  assert.equal(arcs.length, 2, 'a solid value arc per reported window');
  assert.equal(findAll(root, 'ring-unknown').length, 0, 'and no dashed placeholder in sight');

  const circumference = 2 * Math.PI * RING_RADIUS;
  // 32% used must leave 68% of the circumference as offset. Painting the
  // remaining share instead would give 0.32 * C and look almost right.
  assert.ok(
    Math.abs(Number(arcs[0].getAttribute('stroke-dashoffset')) - circumference * 0.68) < 1e-9,
    'the 32%-used arc is drawn from the used share',
  );
  assert.ok(
    Math.abs(Number(arcs[1].getAttribute('stroke-dashoffset')) - circumference * 0.10) < 1e-9,
    'and the 90%-used arc likewise',
  );
  for (const arc of arcs) {
    assert.equal(Number(arc.getAttribute('stroke-dasharray')), circumference);
    assert.match(arc.getAttribute('transform'), /rotate\(-90 /, 'arcs start at twelve o’clock');
  }

  const centres = findAll(root, 'circle-centre').map((n) => n.textContent);
  assert.deepEqual(centres, ['32%', '90%']);
  const text = root.textContent;
  assert.match(text, /32% used · 68% left/);
  assert.match(text, /Resets Tue, Nov 14, 3:30 PM/);
  assert.match(text, /Live reading, measured 12s ago/);
});

// ------------------------------------------- aberrant readings are not zeroes

test('an aberrant percentage is dropped, never clamped into a plausible ring', () => {
  // A negative or over-100 utilization is a broken reading, not a measurement.
  // Clamping it would silently produce a confident "0% used" or "100% used"
  // ring — precisely the lie the whole unknown-is-not-zero rule forbids.
  for (const bad of [-5, -0.001, 140, 100.5, Number.POSITIVE_INFINITY]) {
    const vm = usageViewModel(liveReport({
      windows: [
        { key: 'bad', label: 'bad', usedPercent: bad, freshness: 'live' },
        { key: 'five_hour', label: '5-hour', usedPercent: 20, remainingPercent: 80, freshness: 'live' },
      ],
    }));
    assert.equal(vm.circles.length, 1, `usedPercent=${bad} must not become a ring`);
    assert.equal(vm.circles[0].key, 'five_hour', 'only the sound reading survives');
    assert.equal(vm.circles[0].usedPercent, 20, 'and it is untouched by its broken neighbour');
  }

  // Every window aberrant is the same as no window at all: unknown.
  const allBad = usageViewModel(liveReport({
    windows: [{ key: 'a', usedPercent: -1 }, { key: 'b', usedPercent: 101 }],
  }));
  assert.equal(allBad.state, 'unavailable');
  assert.equal(allBad.circles.length, 0);
  assert.doesNotMatch(JSON.stringify(allBad), /\d+%/, 'and it shows no percentage at all');

  // A nonsense `remainingPercent` next to a sound `usedPercent` is derived,
  // not trusted: 30% used can never be reported as 900% left.
  const derived = usageViewModel(liveReport({
    windows: [{ key: 'five_hour', label: '5-hour', usedPercent: 30, remainingPercent: 900, freshness: 'live' }],
  }));
  assert.equal(derived.circles[0].remainingPercent, 70);
  assert.equal(derived.circles[0].remainingText, '70% left');
});

test('ringGeometry refuses to paint an arc for a value that is not a number', () => {
  const circumference = 2 * Math.PI * RING_RADIUS;
  for (const bad of [null, undefined, Number.NaN, '42', {}]) {
    const geometry = ringGeometry(bad);
    assert.equal(geometry.known, false, `${JSON.stringify(bad)} is not a reading`);
    assert.equal(geometry.dashOffset, circumference, 'so nothing is painted, rather than a 0% arc');
  }
  assert.equal(ringGeometry(0).known, true, 'a measured zero, by contrast, is a reading');
});

// ================================================================ transcript ==

function makeChat() {
  const form = new MicroNode('form');
  const input = new MicroNode('textarea');
  input.value = '';
  const transcript = new MicroNode('ol');
  const empty = new MicroNode('p');
  const chat = createChat({ form, input, transcript, empty, onSend: async () => {} });
  return { chat, form, input, transcript, empty };
}

const turn = (index, text = `turn ${index}`) => ({
  id: `t${index}`, conversationId: 'c1', index, role: index % 2 ? 'user' : 'assistant', text, at: 1_700_000_000_000 + index * 1000,
});

/** The transcript in the order a reader would actually see it. */
const shown = (transcript) => transcript.children.map((li) => descendants(li)
  .find((n) => n.className === 'turn-text').textContent);

test('the transcript orders by server index however scrambled the arrivals are', () => {
  const { chat, transcript } = makeChat();

  // A live event beats the snapshot it belongs to, and the bus replays are not
  // sorted: #5 lands first, then #3, and only then does the snapshot fill in
  // the gaps. Insertion has to consult where turns actually sit on the page,
  // not the order they happened to arrive in.
  assert.equal(chat.appendTurn(turn(5)), true);
  assert.equal(chat.appendTurn(turn(3)), true);
  assert.equal(chat.applyTurns([turn(1), turn(2), turn(4)]), 3);

  assert.deepEqual(shown(transcript), ['turn 1', 'turn 2', 'turn 3', 'turn 4', 'turn 5']);
  assert.equal(chat.size, 5);
});

test('a replayed snapshot adds nothing and cannot duplicate a turn', () => {
  const { chat, transcript, empty } = makeChat();
  assert.equal(empty.hidden, false, 'the empty hint shows until there is something to read');

  const snapshot = [turn(1), turn(2), turn(3)];
  assert.equal(chat.applyTurns(snapshot), 3);
  assert.equal(empty.hidden, true);

  // The reconnect replays the same three and then one genuinely new turn.
  assert.equal(chat.applyTurns([...snapshot]), 0, 'a replay adds nothing');
  assert.equal(chat.appendTurn(turn(2)), false, 'and a single replayed turn is refused');
  assert.equal(chat.applyTurns([...snapshot, turn(4)]), 1, 'only the new one lands');

  assert.equal(chat.size, 4);
  assert.equal(transcript.children.length, 4, 'no turn is rendered twice');
  assert.deepEqual(shown(transcript), ['turn 1', 'turn 2', 'turn 3', 'turn 4']);
  assert.equal(chat.has(turn(3)), true);
  assert.equal(chat.has(turn(9)), false);

  // Identity is the SERVER id, not the text: Blake saying the same thing twice
  // is two turns, and the same id arriving twice is one.
  chat.appendTurn({ id: 't98', index: 98, role: 'user', text: 'again', at: 1 });
  chat.appendTurn({ id: 't99', index: 99, role: 'user', text: 'again', at: 2 });
  chat.appendTurn({ id: 't99', index: 99, role: 'user', text: 'again', at: 2 });
  assert.equal(chat.size, 6);
});

// ==================================================================== speech ==

class FakeUtterance {
  constructor(text) { this.text = text; }
}

/** A synthesiser that speaks immediately, like a browser after a gesture. */
function speakingSynth(spoken) {
  return {
    speaking: false,
    pending: false,
    cancel() {},
    speak(utterance) { spoken.push(utterance.text); utterance.onstart?.(); utterance.onend?.(); },
  };
}

function makeSpeech(synth, overrides = {}) {
  const acks = [];
  const activation = [];
  const speech = createSpeech({
    synth,
    utteranceClass: FakeUtterance,
    ack: (seq) => acks.push(seq),
    onActivationRequired: (needed) => activation.push(needed),
    ...overrides,
  });
  return { speech, acks, activation };
}

const item = (seq, text = `item ${seq}`, priority = 'normal') => ({ seq, text, priority, at: seq, key: `k${seq}` });

test('speech says each announcement once, in order, and acknowledges exactly one seq each', () => {
  const spoken = [];
  const { speech, acks, activation } = makeSpeech(speakingSynth(spoken));

  // Before any gesture the browser will swallow speech, so nothing is spoken
  // and ONE affordance is offered — not one per queued item.
  assert.equal(speech.offerMany([item(1), item(2)]), 2);
  assert.deepEqual(spoken, [], 'nothing is spoken before a gesture');
  assert.equal(speech.needsActivation, true);
  assert.deepEqual(activation, [true], 'exactly one activation prompt for the whole queue');
  assert.equal(speech.pending, 2, 'and the queue is kept, not thrown away');
  assert.deepEqual(acks, [], 'nothing may be acknowledged that was never said');

  speech.unlock();
  assert.deepEqual(spoken, ['item 1', 'item 2'], 'the gesture drains the queue in order');
  assert.deepEqual(acks, [1, 2], 'each spoken item acknowledges its own seq, once');
  assert.equal(speech.pending, 0);
  assert.equal(speech.needsActivation, false);

  // The server re-offers seq 2 after a refresh; it must not be said again.
  assert.equal(speech.offer(item(2)), false, 'a seq already handled is dropped');
  assert.equal(speech.offerMany([item(1), item(2), item(3)]), 1, 'only the genuinely new one is accepted');
  assert.deepEqual(spoken, ['item 1', 'item 2', 'item 3']);
  assert.deepEqual(acks, [1, 2, 3], 'and no seq is acknowledged twice');
});

test('a high-priority announcement jumps the queue without being duplicated', () => {
  const spoken = [];
  const { speech, acks } = makeSpeech(speakingSynth(spoken));
  speech.unlock();
  speech.setMuted(true);            // hold everything back so ordering is observable
  speech.setMuted(false);

  const held = [];
  const holding = {
    speaking: false, pending: false, cancel() {},
    speak(utterance) { held.push(utterance); },   // never finishes: the queue backs up
  };
  const second = makeSpeech(holding);
  second.speech.unlock();
  second.speech.offer(item(1, 'routine one'));
  second.speech.offer(item(2, 'routine two'));
  second.speech.offer(item(3, 'BLOCKED', 'high'));
  assert.equal(held.length, 1, 'only one utterance is in flight at a time');
  assert.equal(held[0].text, 'routine one');
  assert.equal(second.speech.pending, 2);

  held[0].onend();                  // the first finishes; the urgent one is next
  assert.equal(held[1].text, 'BLOCKED', 'the high-priority item overtakes the routine one');
  held[1].onend();
  assert.equal(held[2].text, 'routine two');
  held[2].onend();
  assert.deepEqual(second.acks, [1, 3, 2], 'each is acknowledged once, as spoken');
  assert.equal(spoken.length, 0);
  assert.deepEqual(acks, []);
});

test('muted never speaks, and an interrupted utterance is never acknowledged as spoken', () => {
  const spoken = [];
  const { speech, acks } = makeSpeech(speakingSynth(spoken), { muted: true });
  speech.unlock();

  assert.equal(speech.offer(item(7)), false, 'muted wins: the item is not queued');
  assert.deepEqual(spoken, [], 'and nothing is said');
  assert.equal(speech.muted, true);
  // It IS acknowledged, so that lifting the mute does not release stale news.
  assert.deepEqual(acks, [7], 'a deliberately silenced item is settled with the server');

  speech.setMuted(false);
  assert.equal(speech.offer(item(8)), true);
  assert.deepEqual(spoken, ['item 8'], 'unmuting restores the voice');
  assert.deepEqual(acks, [7, 8]);

  // An utterance the browser cuts off mid-word was NOT heard, so acknowledging
  // it would lose the message forever.
  const held = [];
  const holding = { speaking: false, pending: false, cancel() {}, speak: (u) => held.push(u) };
  const cut = makeSpeech(holding);
  cut.speech.unlock();
  cut.speech.offer(item(9, 'half a sentence'));
  held[0].onerror({ error: 'interrupted' });
  assert.deepEqual(cut.acks, [], 'an interrupted utterance is not reported as spoken');
  assert.equal(cut.speech.speaking, false, 'and the speaker does not stay stuck');
});

test('an utterance the browser silently swallows is detected only after the timeout, and kept', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });

  // Chromium accepts `speak()` before a gesture and then does nothing at all:
  // no start event, nothing speaking, nothing pending. The only way to notice
  // is to wait — so the wait has to be real.
  const swallowing = { speaking: false, pending: false, cancel() {}, speak() {} };
  const { speech, acks, activation } = makeSpeech(swallowing);
  speech.unlock();
  assert.equal(speech.offer(item(4, 'did you hear that')), true);

  t.mock.timers.tick(699);
  assert.equal(speech.needsActivation, false, 'the watchdog must not fire early');
  assert.deepEqual(acks, [], 'and nothing is acknowledged while it is still in doubt');

  t.mock.timers.tick(1);
  assert.equal(speech.needsActivation, true, 'at the timeout the swallowed speech is noticed');
  assert.deepEqual(activation.at(-1), true);
  assert.equal(speech.pending, 1, 'the announcement is put back, not lost');
  assert.deepEqual(acks, [], 'and never acknowledged, because it was never heard');
  assert.equal(speech.speaking, false);
});
