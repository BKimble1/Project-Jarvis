import { createCore } from './modules/core-anim.js';
import { createChat } from './modules/chat.js';
import { createDrawers } from './modules/drawers.js';
import { createSpeech } from './modules/speech.js';
import { renderUsage } from './modules/usage.js';

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
  onActivity: (note) => pushActivity(note),
});

const drawers = createDrawers({
  onOpen: (id) => { if (id === 'panel-diagnostics') void loadDiagnostics(); },
});

const speech = createSpeech({
  ack: (seq) => { void api('/api/speech/ack', { method: 'POST', body: { seq } }).catch(() => {}); },
  onActivationRequired: (needed) => { if (el.enableVoice) el.enableVoice.hidden = !needed; },
  onSpeakingChange: (speaking) => { if (speaking) core?.setState('speaking'); else core?.setState(coreStateFor(currentState)); },
});

// ------------------------------------------------------------------ rendering

function coreStateFor(state) {
  if (!state) return 'idle';
  if (state.project?.status === 'blocked' || state.health?.level === 'attention') return 'blocked';
  if (state.project && ['active'].includes(state.project.status) && state.project.phase !== 'idle') return 'working';
  return 'idle';
}

function applyState(state) {
  if (!state) return;
  currentState = state;
  if (Number.isFinite(state.seq)) lastSeq = Math.max(lastSeq, state.seq);

  setAction(state.currentAction);
  core?.setState(coreStateFor(state));

  chat.applyTurns(state.conversation?.turns ?? []);
  renderUsage(el.usageRoot, state.capacity, { onRecover: () => void refreshCapacity() });
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
    button.textContent = option;
    if (option === decision.recommendedDefault) button.classList.add('option-default');
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
    const h = document.createElement('h3');
    h.className = 'deliverable-title';
    h.textContent = d.title;
    const body = document.createElement('p');
    body.className = 'deliverable-body';
    body.textContent = d.body;
    li.append(h, body);
    return li;
  });
  el.deliverablesList.replaceChildren(...items);
  el.deliverables.hidden = false;
}

function renderHealth(health) {
  if (!el.healthDot || !health) return;
  el.healthDot.dataset.level = health.level;
  el.healthDot.setAttribute('aria-label', `Health: ${health.detail}`);
  el.healthDot.title = health.detail;
}

function renderSettings(settings) {
  if (!settings) return;
  if (el.modeSelect && el.modeSelect.value !== settings.mode) el.modeSelect.value = settings.mode;
  const muted = Boolean(settings.muted);
  speech.setMuted(muted);
  if (el.muteToggle) {
    el.muteToggle.setAttribute('aria-pressed', muted ? 'true' : 'false');
    el.muteLabel.textContent = muted ? 'Voice off' : 'Voice on';
  }
}

function renderProjects(projects) {
  if (!el.projectsList) return;
  el.projectsList.replaceChildren(...projects.map((p) => {
    const li = document.createElement('li');
    li.className = 'project';
    li.textContent = `${p.title} — ${p.status}`;
    return li;
  }));
}

function pushActivity(note) {
  if (!el.activityList || !note) return;
  const li = document.createElement('li');
  li.className = 'event';
  li.textContent = note;
  el.activityList.prepend(li);
  while (el.activityList.children.length > 100) el.activityList.lastElementChild.remove();
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
  if (!openDecisionId) return;
  speech.unlock();
  const out = await api('/api/answer', { method: 'POST', body: { questionId: openDecisionId, answer: text, conversationId: CONVERSATION_ID } });
  if (out.state) applyState(out.state);
}

async function refreshCapacity() {
  try {
    const report = await api('/api/capacity/refresh', { method: 'POST' });
    renderUsage(el.usageRoot, report, { onRecover: () => void refreshCapacity() });
  } catch (err) {
    pushActivity(`Capacity refresh failed: ${err.message}`);
  }
}

async function pullSpeech() {
  try {
    const { items } = await api(`/api/speech/pending?since=${lastSpokenSeq()}`);
    if (items?.length) speech.offerMany(items);
  } catch { /* the next event will try again */ }
}

let highestOffered = 0;
function lastSpokenSeq() { return highestOffered; }
function noteOffered(items) {
  for (const item of items ?? []) if (Number.isFinite(item.seq)) highestOffered = Math.max(highestOffered, item.seq);
}

// ----------------------------------------------------------------- event feed

function connect() {
  const source = new EventSource(`/api/events?since=${lastSeq}`);

  source.addEventListener('open', () => { if (el.linkState) el.linkState.hidden = true; });

  source.addEventListener('error', () => {
    if (el.linkState) el.linkState.hidden = false;
    source.close();
    // Reconnect from the last sequence we saw, so nothing is replayed.
    setTimeout(connect, 1500);
  });

  source.onmessage = () => {};
  source.addEventListener('sync', (evt) => {
    const data = safeParse(evt.data);
    if (Number.isFinite(data?.seq)) lastSeq = Math.max(lastSeq, data.seq);
  });

  for (const type of [
    'action.current', 'project.created', 'project.updated', 'project.phase', 'project.blocked',
    'project.delivered', 'project.evaluated', 'project.changed', 'project.paused', 'project.resumed',
    'project.stopped', 'question.asked', 'question.answered', 'capacity.updated', 'capacity.unavailable',
    'chat.message', 'settings.updated', 'plan.revised', 'task.failed', 'backlog.picked',
  ]) {
    source.addEventListener(type, (evt) => {
      const data = safeParse(evt.data);
      if (Number.isFinite(data?.seq)) lastSeq = Math.max(lastSeq, data.seq);
      if (type === 'action.current' && data?.payload?.text) setAction(data.payload.text);
      pushActivity(`${type}${data?.payload?.reason ? `: ${data.payload.reason}` : ''}`);
      void refreshState();
    });
  }
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

el.modeSelect?.addEventListener('change', () => {
  speech.unlock();
  void api('/api/settings', { method: 'POST', body: { mode: el.modeSelect.value } })
    .then((out) => renderSettings(out.settings))
    .catch((err) => pushActivity(`Could not change mode: ${err.message}`));
});

el.muteToggle?.addEventListener('click', () => {
  speech.unlock();
  const muted = el.muteToggle.getAttribute('aria-pressed') !== 'true';
  void api('/api/settings', { method: 'POST', body: { muted } })
    .then((out) => renderSettings(out.settings))
    .catch((err) => pushActivity(`Could not change voice: ${err.message}`));
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

const originalOfferMany = speech.offerMany;
speech.offerMany = (items) => { noteOffered(items); return originalOfferMany(items); };

await refreshState();
connect();
chat.focus();
