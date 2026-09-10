import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import { createRouter, sendJson } from './api/routes.js';
import { createLogger } from './core/logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

export function createServer({ app, publicDir = PUBLIC_DIR, logger = createLogger('server') } = {}) {
  const router = createRouter(app);

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);

    if (url.pathname === '/api/events') return streamEvents({ app, req, res, url });

    const handled = await router.handle(req, res, url);
    if (handled) return;

    if (req.method !== 'GET') return sendJson(res, 405, { error: 'Method not allowed' });
    return serveStatic({ res, url, publicDir, logger });
  });

  return server;
}

/** Server-Sent Events: one stream, resumable by sequence, no duplicate replay. */
function streamEvents({ app, req, res, url }) {
  const since = Number(url.searchParams.get('since') ?? 0) || 0;
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });

  const write = (evt) => {
    if (res.writableEnded) return;
    res.write(`id: ${evt.seq}\nevent: ${evt.type}\ndata: ${JSON.stringify({ seq: evt.seq, type: evt.type, payload: evt.payload })}\n\n`);
  };

  for (const evt of app.bus.since(since)) write(evt);
  res.write(`event: sync\ndata: ${JSON.stringify({ seq: app.bus.lastSeq })}\n\n`);

  const off = app.bus.on('*', write);
  const keepalive = setInterval(() => { if (!res.writableEnded) res.write(': keepalive\n\n'); }, 20_000);
  keepalive.unref?.();

  const cleanup = () => { off(); clearInterval(keepalive); };
  req.on('close', cleanup);
  req.on('error', cleanup);
  res.on('close', cleanup);
}

function serveStatic({ res, url, publicDir, logger }) {
  const rel = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\/+/, '');
  const target = path.resolve(publicDir, rel);
  if (!target.startsWith(path.resolve(publicDir))) {
    return sendJson(res, 403, { error: 'Forbidden' });
  }
  fs.readFile(target, (err, data) => {
    if (err) {
      // Only route-like paths fall back to the page. A missing .js or .css must
      // 404 loudly — serving HTML in its place breaks module loading silently.
      const looksLikeAsset = path.extname(rel) !== '';
      if (url.pathname.startsWith('/api/') || looksLikeAsset) {
        logger.warn(`404 ${url.pathname}`);
        return sendJson(res, 404, { error: 'Not found', path: url.pathname });
      }
      return fs.readFile(path.join(publicDir, 'index.html'), (err2, html) => {
        if (err2) return sendJson(res, 404, { error: 'Not found' });
        res.writeHead(200, { 'content-type': MIME['.html'] });
        res.end(html);
      });
    }
    res.writeHead(200, {
      'content-type': MIME[path.extname(target)] ?? 'application/octet-stream',
      'cache-control': 'no-cache',
    });
    res.end(data);
  });
}

/**
 * Everything the process does besides serve HTTP: pick up work that was
 * in flight when we last stopped, and keep the capacity reading current.
 * Exported so both halves are testable without booting a process.
 *
 * @returns {{resumed: string[], stop: () => void}}
 */
export function startBackgroundWork(app, { logger = createLogger('server'), capacityIntervalMs = 120_000 } = {}) {
  const active = app.store.find('projects', (p) => p.status === 'active');
  if (active.length) {
    logger.info(`resuming ${active.length} project(s) from saved state`);
    for (const p of active) {
      const run = app.orchestrator.run(p.id);
      if (run && typeof run.catch === 'function') run.catch((err) => logger.error('resume failed', err?.message));
    }
  }

  // Failures degrade the reading to stale, never to a fake zero.
  const refresh = () => app.usage.refresh().catch((err) => logger.error('capacity refresh failed', err?.message));
  const first = refresh();
  const timer = capacityIntervalMs > 0 ? setInterval(refresh, capacityIntervalMs) : null;
  timer?.unref?.();

  return {
    resumed: active.map((p) => p.id),
    firstRefresh: first,
    stop() { if (timer) clearInterval(timer); },
  };
}

async function main() {
  const logger = createLogger('server');
  const port = Number(process.env.PORT ?? 8787);
  const host = process.env.HOST ?? '127.0.0.1';
  const app = createApp({ dataDir: process.env.JARVIS_DATA_DIR ?? path.join(process.cwd(), 'data') });

  const background = startBackgroundWork(app, {
    logger,
    capacityIntervalMs: Number(process.env.JARVIS_CAPACITY_INTERVAL_MS ?? 120_000),
  });

  const server = createServer({ app, logger });
  server.listen(port, host, () => logger.info(`Jarvis listening on http://${host}:${port}`));

  const shutdown = async () => {
    logger.info('shutting down');
    background.stop();
    server.close();
    await app.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((err) => { console.error('[error] server: failed to start', err); process.exit(1); });
}
