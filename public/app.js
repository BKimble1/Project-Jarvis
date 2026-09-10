import { createCore } from './modules/core-anim.js';
import { createChat } from './modules/chat.js';
import { createDrawers } from './modules/drawers.js';
import { createSpeech } from './modules/speech.js';
import { renderUsage } from './modules/usage.js';
import { createDictation } from './modules/dictate.js';

/**
 * Dashboard bootstrap.
 *
 * The default view is five things: the core, one action sentence, chat, the
 * compact mode/health controls, and the usage circles. A decision card and the
 * deliverables strip appear only when there is something to act on or show.
 * Everything else lives in a drawer.
 */

const CONVERSATION_ID = 'blake';
const $ = (id) => document.getElementById(id);

const el = {
  action: $('action-line'),
  coreCanvas: $('core-canvas'),
  decision: $('decision'),
  decisionText: $('decision-text'),
  decisionOptions: $('decision-options'),
  decisionForm: $('decision-form'),
  decisionInput: $('decision-input'),
  attention: $('attention'),
  attentionText: $('attention-text'),
  attentionRemedy: $('attention-remedy'),
  usageRoot: $('usage-root'),
  transcript: $('transcript'),
  transcriptEmpty: $('transcript-empty'),
  composer: $('composer'),
  composerInput: $('composer-input'),
  deliverables: $('deliverables'),
  deliverablesList: $('deliverables-list'),
  modeSelect: $('mode-select'),
  muteToggle: $('mute-toggle'),
  muteLabel: $('mute-label'),
  enableVoice: $('enable-voice'),
  linkState: $('link-state'),
  dictate: $('dictate'),
  healthDot: $('health-dot'),
  activityList: $('activity-list'),
  projectsList: $('projects-list'),
  diagnosticsBody: $('diagnostics-body'),
};

let lastSeq = 0;
let openDecisionId = null;
let currentState = null;

// ---------------------------------------------------------------- transport

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    let detail = res.statusText;
    try { detail = (await res.json()).error ?? detail; } catch { /* keep statusText */ }
    throw new Error(detail);
  }
  return res.json();
}

// ------------------------------------------------------------------ widgets

const core = el.coreCanvas ? createCore({ canvas: el.coreCanvas }) : null;

const chat = createChat({
  form: el.composer,
  input: el.composerInput,
  transcript: el.transcript,
  empty: el.transcriptEmpty,
  onSend: async (text) => {
    speech.unlock();
    const out = await api('/api/chat', { method: 'POST', body: { conversationId: CONVERSATION_ID, text } });
    if (out.state) applyState(out.state);
    return out.reply;
  },
  // Sending is a real user gesture, which is exactly what the browser wants
  // before it will let us speak.
  onActivity: () => speech.unlock(),
});

// Answer by voice as well as by text. The button hides itself entirely when
// the browser cannot do speech recognition, so it is never a dead control.
const dictation = createDictation({
  button: el.dictate,
  input: el.composerInput,
  onFinal: () => { speech.unlock(); },
  onStateChange: (listening) => { if (listening) core?.setState('working'); },
});

const drawers = createDrawers({
  onOpen: (id) => { if (id === 'panel-diagnostics') void loadDiagnostics(); },
});

const speech = createSpeech({
  ack: (seq) => { void api('/api/speech/ack', { method: 'POST', body: { seq } }).catch(() => {}); },
  onActivationRequired: (needed) => { if (el.enableVoice) el.enableVoice.hidden = !needed; },
  onSpeakingChange: (speaking) => { if (speaking) core?.setState('speaking'); else core?.setState(coreStateFor(currentState)); },
});

/**
 * Every route into the speaker goes through here, so the "what have we already
 * been offered?" high-water mark can never drift from what was actually handed
 * to the synthesiser — which is what stops `/api/speech/pending` re-offering
 * (and the page re-speaking) an announcement after a refresh.
 */
let highestOffered = 0;
function offerSpeech(items) {
  const list = Array.isArray(items) ? items : [items];
  for (const item of list) {
    if (Number.isFinite(item?.seq)) highestOffered = Math.max(highestOffered, item.seq);
  }
  return speech.offerMany(list);
}

// ------------------------------------------------------------------ rendering

function coreStateFor(state) {
  if (!state) return 'idle';
  if (state.project?.status === 'blocked' || state.health?.level === 'attention') return 'blocked';
  if (state.project?.status === 'active' && state.project.phase !== 'idle') return 'working';
  return 'idle';
}

function applyState(state) {
  if (!state) return;
  currentState = state;
  if (Number.isFinite(state.seq)) lastSeq = Math.max(lastSeq, state.seq);

  setAction(state.currentAction);
  core?.setState(coreStateFor(state));

  chat.applyTurns(state.conversation?.turns ?? []);
  paintUsage(state.capacity);
  renderDecision(state.decision);
  renderAttention(state);
  renderDeliverables(state.deliverables ?? []);
  renderHealth(state.health);
  renderSettings(state.settings);
  renderProjects(state.projects ?? []);
  void pullSpeech();
}

function setAction(text) {
  if (!el.action || !text || el.action.textContent === text) return;
  el.action.textContent = text;
}

function paintUsage(report) {
  renderUsage(el.usageRoot, report, { onRecover: () => void refreshCapacity() });
}

function renderDecision(decision) {
  if (!el.decision) return;
  if (!decision) {
    el.decision.hidden = true;
    openDecisionId = null;
    el.decisionOptions.replaceChildren();
    return;
  }
  openDecisionId = decision.questionId;
  el.decisionText.textContent = decision.recommendedDefault
    ? `${decision.text} (I'd go with ${decision.recommendedDefault}.)`
    : decision.text;

  const buttons = (decision.options ?? []).map((option) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'option';
    button.appendChild(document.createTextNode(option));
    if (option === decision.recommendedDefault) {
      // The class the stylesheet actually knows about — a recommendation that
      // is not marked is not a recommendation.
      button.classList.add('option-recommended');
      const tag = document.createElement('span');
      tag.className = 'option-tag';
      tag.textContent = 'recommended';
      button.appendChild(tag);
    }
    button.addEventListener('click', () => void answer(option));
    return button;
  });
  el.decisionOptions.replaceChildren(...buttons);
  el.decision.hidden = false;
}

/** One summary of an actionable failure, with its remedy. Never hidden, never repeated. */
function renderAttention(state) {
  if (!el.attention) return;
  const blocked = state.project?.status === 'blocked' ? state.project.blockedReason : null;
  if (!blocked) { el.attention.hidden = true; return; }
  el.attentionText.textContent = blocked;
  el.attentionRemedy.textContent = 'Tell me what you want me to do and I will pick it straight back up.';
  el.attention.hidden = false;
}

function renderDeliverables(deliverables) {
  if (!el.deliverables) return;
  if (deliverables.length === 0) { el.deliverables.hidden = true; return; }
  const items = deliverables.map((d) => {
    const li = document.createElement('li');
    li.className = 'deliverable';
    const head = document.createElement('div');
    head.className = 'deliverable-head';
    const h = document.createElement('h3');
    h.className = 'deliverable-title';
    h.textContent = d.title;
    head.appendChild(h);
    if (d.kind) {
      const kind = document.createElement('span');
      kind.className = 'deliverable-kind';
      kind.textContent = d.kind;
      head.appendChild(kind);
    }
    const body = document.createElement('p');
    body.className = 'deliverable-body';
    body.textContent = d.body;
    li.append(head, body);
    return li;
  });
  el.deliverablesList.replaceChildren(...items);
  el.deliverables.hidden = false;
}

function renderHealth(health) {
  if (!el.healthDot || !health) return;
  el.healthDot.dataset.level = health.level ?? 'ok';
  const detail = health.detail || 'all systems nominal';
  el.healthDot.setAttribute('aria-label', `Health: ${detail}`);
  el.healthDot.title = detail;
}

/**
 * Settings the server has confirmed. The cached snapshot is updated too: the
 * mode handler compares against it to decide whether the live project has to be
 * paused or resumed, and a stale copy would silently skip that.
 */
function applySettings(settings) {
  if (!settings) return;
  if (currentState) currentState.settings = settings;
  renderSettings(settings);
}

function renderSettings(settings) {
  if (!settings) return;
  if (el.modeSelect && el.modeSelect.value !== settings.mode) el.modeSelect.value = settings.mode;
  const muted = Boolean(settings.muted);
  speech.setMuted(muted);
  if (el.muteToggle) {
    el.muteToggle.setAttribute('aria-pressed', muted ? 'true' : 'false');
    el.muteToggle.classList.toggle('is-off', muted);
    el.muteLabel.textContent = muted ? 'Voice off' : 'Voice on';
  }
}

function renderProjects(projects) {
  if (!el.projectsList) return;
  el.projectsList.replaceChildren(...projects.map((p) => {
    const li = document.createElement('li');
    li.className = 'project';
    const title = document.createElement('p');
    title.className = 'project-title';
    title.textContent = p.title;
    const meta = document.createElement('p');
    meta.className = 'project-meta';
    meta.textContent = `${p.status}${p.phase ? ` · ${p.phase}` : ''}`;
    li.append(title, meta);
    return li;
  }));
}

/** One line in the Activity drawer: what happened, and any detail worth keeping. */
function logActivity(type, payload) {
  if (!el.activityList || !type) return;
  const li = document.createElement('li');
  li.className = 'event';
  const kind = document.createElement('span');
  kind.className = 'event-type';
  kind.textContent = type;
  li.appendChild(kind);
  const detail = detailOf(payload);
  if (detail) {
    const note = document.createElement('span');
    note.className = 'event-detail';
    note.textContent = detail;
    li.appendChild(note);
  }
  el.activityList.prepend(li);
  while (el.activityList.children.length > 100) el.activityList.lastElementChild.remove();
}

function detailOf(payload) {
  if (!payload || typeof payload !== 'object') return typeof payload === 'string' ? payload : null;
  return payload.reason ?? payload.text ?? payload.title ?? payload.message
    ?? payload.blockedReason ?? payload.phase ?? null;
}


async function loadDiagnostics() {
  if (!el.diagnosticsBody) return;
  el.diagnosticsBody.textContent = 'Loading…';
  try {
    const diag = await api('/api/diagnostics');
    const pre = document.createElement('pre');
    pre.className = 'code';
    pre.textContent = JSON.stringify({ capacity: diag.capacity, scheduler: diag.scheduler, pool: diag.pool, counts: diag.counts }, null, 2);
    el.diagnosticsBody.replaceChildren(pre);
  } catch (err) {
    el.diagnosticsBody.textContent = `Diagnostics unavailable: ${err.message}`;
  }
}

// -------------------------------------------------------------------- actions

async function answer(text) {
  const questionId = openDecisionId;
  if (!questionId) return;
  // One answer per decision. Clearing the id first means a double click, or a
  // click racing the typed form, cannot post the same question twice.
  openDecisionId = null;
  if (el.decision) el.decision.hidden = true;
  speech.unlock();
  try {
    const out = await api('/api/answer', { method: 'POST', body: { questionId, answer: text, conversationId: CONVERSATION_ID } });
    if (out.state) applyState(out.state);
  } catch (err) {
    // It never reached Jarvis, so put the decision back rather than losing it.
    openDecisionId = questionId;
    if (el.decision) el.decision.hidden = false;
    logActivity('answer.failed', { reason: err.message });
  }
}

async function refreshCapacity() {
  try {
    const report = await api('/api/capacity/refresh', { method: 'POST' });
    paintUsage(report);
  } catch (err) {
    logActivity('capacity.refresh.failed', { reason: err.message });
  }
}

async function pullSpeech() {
  try {
    const { items } = await api(`/api/speech/pending?since=${highestOffered}`);
    if (items?.length) offerSpeech(items);
  } catch { /* the next event will try again */ }
}

/** Pause/resume/stop the project in flight. */
async function control(projectId, action) {
  if (!projectId) return;
  try {
    await api('/api/control', { method: 'POST', body: { projectId, action } });
  } catch (err) {
    logActivity(`control.${action}.failed`, { reason: err.message });
  }
}

// ----------------------------------------------------------------- event feed

/**
 * Every event name in the bus vocabulary (docs/CONTRACTS.md). `EventSource`
 * only delivers named events to a matching listener, so an event missing from
 * this list is an event the page never sees — including the high-water mark it
 * carries, which is what a reconnect resumes from.
 */
const BUS_EVENTS = [
  'project.created', 'project.updated', 'project.phase', 'project.blocked', 'project.delivered',
  'project.paused', 'project.resumed', 'project.stopped', 'project.evaluated', 'project.changed',
  'plan.revised', 'task.started', 'task.completed', 'task.failed', 'task.retrying', 'task.blocked',
  'question.asked', 'question.answered', 'worker.started', 'worker.crashed', 'worker.recovered',
  'backlog.picked', 'backlog.empty', 'action.current',
  'capacity.updated', 'capacity.unavailable', 'chat.message', 'speech.say', 'settings.updated',
];

/**
 * Fast paths. The payload of these events is authoritative, so they paint
 * immediately instead of waiting for a snapshot round-trip. Returning `true`
 * means "fully handled" — no snapshot needed at all.
 */
const FAST_PATHS = {
  'action.current': (p) => { setAction(p?.text); return true; },
  'speech.say': (p) => { if (p) offerSpeech(p); return true; },
  'settings.updated': (p) => { applySettings(p?.settings); return true; },
  // These change more than the piece they carry (health, phase, the action
  // line), so they paint now AND reconcile with the next snapshot.
  'chat.message': (p) => { if (p?.turn) chat.appendTurn(p.turn); return false; },
  'capacity.updated': (p) => { paintUsage(p); return false; },
  'capacity.unavailable': (p) => { paintUsage(p); return false; },
};

const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 30_000;
let reconnectDelay = RECONNECT_MIN_MS;
let reconnectTimer = null;
let wasDisconnected = false;

function connect() {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  const source = new EventSource(`/api/events?since=${lastSeq}`);

  source.addEventListener('open', () => {
    reconnectDelay = RECONNECT_MIN_MS;
    if (el.linkState) el.linkState.hidden = true;
    // Coming back from a gap: take one authoritative snapshot rather than
    // trusting that the replay covered everything.
    if (wasDisconnected) { wasDisconnected = false; void refreshState(); }
  });

  source.addEventListener('error', () => {
    wasDisconnected = true;
    if (el.linkState) el.linkState.hidden = false;
    source.close();
    // Back off exponentially so a server that is down does not get hammered,
    // and resume from the last sequence we saw so nothing is missed.
    const wait = reconnectDelay;
    reconnectDelay = Math.min(RECONNECT_MAX_MS, reconnectDelay * 2);
    reconnectTimer = setTimeout(connect, wait);
  });

  source.addEventListener('sync', (evt) => {
    const data = safeParse(evt.data);
    if (Number.isFinite(data?.seq)) lastSeq = Math.max(lastSeq, data.seq);
  });

  for (const type of BUS_EVENTS) {
    source.addEventListener(type, (evt) => handleEvent(type, safeParse(evt.data)));
  }
}

function handleEvent(type, data) {
  const seq = Number(data?.seq);
  if (Number.isFinite(seq)) {
    // Monotonic guard. A reconnect replays from `since`, and the browser's own
    // retry can re-deliver too: anything at or below the mark has already been
    // applied, so it is dropped rather than logged and rendered twice.
    if (seq <= lastSeq) return;
    lastSeq = seq;
  }
  logActivity(type, data?.payload);
  const handled = FAST_PATHS[type]?.(data?.payload) === true;
  if (!handled) void refreshState();
}

let refreshing = null;
let refreshQueued = false;
function refreshState() {
  // Collapse bursts of events into one state read, but always take a trailing
  // read afterwards — otherwise the last event of a burst (the delivery, say)
  // would never be rendered and the page would sit on a stale sentence.
  if (refreshing) { refreshQueued = true; return refreshing; }
  refreshing = api(`/api/state?conversationId=${encodeURIComponent(CONVERSATION_ID)}`)
    .then(applyState)
    .catch(() => {})
    .finally(() => {
      refreshing = null;
      if (refreshQueued) { refreshQueued = false; void refreshState(); }
    });
  return refreshing;
}

function safeParse(text) {
  try { return JSON.parse(text); } catch { return null; }
}

// -------------------------------------------------------------------- wiring

/**
 * "Paused" is a state, not a label: choosing it actually stops the project in
 * flight, and choosing anything else picks it straight back up. Without this
 * the select would quietly lie — the mode would read "Paused" while the workers
 * carried on building.
 */
async function setMode(mode) {
  const previous = currentState?.settings?.mode ?? null;
  const project = currentState?.project ?? null;
  try {
    const out = await api('/api/settings', { method: 'POST', body: { mode } });
    applySettings(out.settings);
  } catch (err) {
    logActivity('settings.mode.failed', { reason: err.message });
    if (previous && el.modeSelect) el.modeSelect.value = previous;   // do not show a mode we failed to set
    return;
  }
  if (!project || mode === previous) return;
  if (mode === 'paused' && project.status === 'active') await control(project.id, 'pause');
  else if (previous === 'paused' && project.status === 'paused') await control(project.id, 'resume');
  else return;
  void refreshState();
}

el.modeSelect?.addEventListener('change', () => {
  speech.unlock();
  void setMode(el.modeSelect.value);
});

el.muteToggle?.addEventListener('click', () => {
  speech.unlock();
  const muted = el.muteToggle.getAttribute('aria-pressed') !== 'true';
  void api('/api/settings', { method: 'POST', body: { muted } })
    .then((out) => applySettings(out.settings))
    .catch((err) => logActivity('settings.voice.failed', { reason: err.message }));
});

el.enableVoice?.addEventListener('click', () => {
  speech.unlock();
  el.enableVoice.hidden = true;
});

el.decisionForm?.addEventListener('submit', (evt) => {
  evt.preventDefault();
  const text = el.decisionInput.value.trim();
  if (!text) return;
  el.decisionInput.value = '';
  void answer(text);
});

// Any real gesture satisfies the browser's speech activation requirement.
for (const type of ['pointerdown', 'keydown']) {
  document.addEventListener(type, () => speech.unlock(), { once: true, passive: true });
}

await refreshState();
connect();
chat.focus();
