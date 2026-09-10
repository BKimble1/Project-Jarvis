/**
 * HTTP API. Deliberately small: chat is the interface, so the surface is
 * "one snapshot, one event stream, and the handful of POSTs the page needs".
 */
export function createRouter(app) {
  const routes = [
    ['GET', '/api/state', getState],
    ['GET', '/api/diagnostics', getDiagnostics],
    ['GET', '/api/capacity', getCapacity],
    ['POST', '/api/capacity/refresh', refreshCapacity],
    ['POST', '/api/chat', postChat],
    ['POST', '/api/answer', postAnswer],
    ['POST', '/api/control', postControl],
    ['POST', '/api/settings', postSettings],
    ['POST', '/api/speech/ack', postSpeechAck],
    ['GET', '/api/speech/pending', getSpeechPending],
    ['POST', '/api/backlog', postBacklog],
    ['GET', '/api/projects', getProjects],
    ['GET', '/api/health', getHealth],
  ];

  async function handle(req, res, url) {
    const route = routes.find(([m, p]) => m === req.method && p === url.pathname);
    if (!route) return false;
    try {
      const body = req.method === 'POST' ? await readJson(req) : {};
      const result = await route[2]({ app, req, res, url, body });
      if (result !== undefined) sendJson(res, 200, result);
    } catch (err) {
      const status = err?.statusCode ?? 500;
      sendJson(res, status, { error: err?.message ?? 'Internal error' });
    }
    return true;
  }

  return { handle, routes };
}

// ------------------------------------------------------------------ handlers

function getState({ app, url }) {
  return app.state(url.searchParams.get('conversationId') || 'default');
}

function getDiagnostics({ app }) {
  return app.diagnostics();
}

function getCapacity({ app }) {
  return app.usage.report();
}

async function refreshCapacity({ app }) {
  return app.usage.refresh();
}

async function postChat({ app, body }) {
  const text = String(body.text ?? '').trim();
  if (!text) throw badRequest('text is required');
  const conversationId = String(body.conversationId || 'default');
  const out = await app.dispatcher.handle({ conversationId, text });
  return {
    reply: out.reply,
    intent: out.intent?.kind ?? null,
    projectId: out.projectId ?? null,
    state: app.state(conversationId),
  };
}

function postAnswer({ app, body }) {
  const questionId = String(body.questionId ?? '');
  if (!questionId) throw badRequest('questionId is required');
  const question = app.questions.answer(questionId, body.answer);
  if (!question) throw badRequest('unknown question');
  return { question, state: app.state(String(body.conversationId || 'default')) };
}

function postControl({ app, body }) {
  const { projectId, action } = body;
  if (!projectId) throw badRequest('projectId is required');
  if (!['pause', 'resume', 'stop'].includes(action)) throw badRequest('action must be pause, resume or stop');
  const project = app.orchestrator[action](projectId);
  if (!project) throw badRequest('unknown project');
  return { project };
}

function postSettings({ app, body }) {
  return { settings: app.updateSettings(body ?? {}) };
}

function postSpeechAck({ app, body }) {
  const seq = Number(body.seq);
  if (!Number.isFinite(seq)) throw badRequest('seq is required');
  app.speech.acknowledge(seq);
  return { ok: true, seq };
}

function getSpeechPending({ app, url }) {
  const since = Number(url.searchParams.get('since') ?? 0) || 0;
  return { items: app.speech.unspoken(since) };
}

function postBacklog({ app, body }) {
  if (!body.title) throw badRequest('title is required');
  const item = app.backlog.add({
    title: String(body.title),
    goal: String(body.goal ?? body.title),
    source: 'api',
    authorized: body.authorized !== false,
  });
  return { item };
}

function getProjects({ app }) {
  return { projects: app.store.all('projects') };
}

function getHealth({ app }) {
  return app.state().health;
}

// ------------------------------------------------------------------- helpers

export function sendJson(res, status, payload) {
  const body = JSON.stringify(payload ?? null);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

export function readJson(req, { limit = 1_000_000 } = {}) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) { reject(badRequest('payload too large')); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); }
      catch { reject(badRequest('invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

export function badRequest(message) {
  const err = new Error(message);
  err.statusCode = 400;
  return err;
}
