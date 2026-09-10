import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { ClaudeSubscriptionProvider } from '../../src/telemetry/providers/claude-cli.js';
import { FakeClock } from '../../src/core/clock.js';

/**
 * Proves the provider speaks the real protocol against a real socket: the
 * method, path, and authenticated headers Claude Code's own usage read uses.
 * (Unit tests elsewhere stub fetch; this one does not.)
 */
async function withServer(handler, run) {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push({ method: req.method, url: req.url, headers: { ...req.headers } });
    handler(req, res);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  try { return await run(base, requests); }
  finally { server.close(); await once(server, 'close'); }
}

test('the provider issues an authenticated GET to the OAuth usage endpoint', async () => {
  await withServer(
    (req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        five_hour: { utilization: 23, resets_at: '2026-09-10T18:00:00Z' },
        seven_day: { utilization: 0.61, resets_at: '2026-09-14T00:00:00Z' },
        seven_day_opus: { utilization: 4, resets_at: '2026-09-14T00:00:00Z' },
      }));
    },
    async (base, requests) => {
      const provider = new ClaudeSubscriptionProvider({
        clock: new FakeClock(1_700_000_000_000),
        baseUrl: base,
        tokenResolver: () => ({ token: 'oauth-secret-value', source: 'test' }),
        env: {},
      });

      const m = await provider.measure();
      assert.equal(m.ok, true, `expected a reading, got ${JSON.stringify(m)}`);

      assert.equal(requests.length, 1);
      assert.equal(requests[0].method, 'GET');
      assert.equal(requests[0].url, '/api/oauth/usage');
      assert.equal(requests[0].headers.authorization, 'Bearer oauth-secret-value');
      assert.equal(requests[0].headers['anthropic-beta'], 'oauth-2025-04-20');
      assert.match(requests[0].headers.accept, /application\/json/);

      // Both utilization scales normalize, and labels come from the provider.
      const byKey = Object.fromEntries(m.windows.map((w) => [w.key, w]));
      assert.equal(Math.round(byKey.five_hour.usedPercent), 23, '0-100 scale');
      assert.equal(Math.round(byKey.seven_day.usedPercent), 61, '0-1 scale');
      assert.equal(byKey.five_hour.label, '5-hour');
      assert.equal(byKey.seven_day_opus.label, '7-day (Opus)');
      assert.equal(byKey.five_hour.resetsAt, Date.parse('2026-09-10T18:00:00Z'));
    },
  );
});

test('a 401 from the real socket becomes an unauthorized reading, not a crash or a zero', async () => {
  await withServer(
    (req, res) => { res.writeHead(401, { 'content-type': 'application/json' }); res.end('{"error":"expired"}'); },
    async (base) => {
      const provider = new ClaudeSubscriptionProvider({
        clock: new FakeClock(1_700_000_000_000),
        baseUrl: base,
        tokenResolver: () => ({ token: 'stale-token', source: 'test' }),
        env: {},
      });
      const m = await provider.measure();
      assert.equal(m.ok, false);
      assert.equal(m.reason, 'unauthorized');
      assert.ok(m.remedy, 'it says how to fix it');
      assert.ok(!JSON.stringify(m).includes('stale-token'), 'the token never leaks');
      assert.ok(!('windows' in m), 'a failure carries no fabricated windows');
    },
  );
});

test('a connection refused becomes a network reading rather than an exception', async () => {
  // Bind and immediately close to get a port nothing is listening on.
  const server = http.createServer(() => {});
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  server.close();
  await once(server, 'close');

  const provider = new ClaudeSubscriptionProvider({
    clock: new FakeClock(1_700_000_000_000),
    baseUrl: `http://127.0.0.1:${port}`,
    tokenResolver: () => ({ token: 'tok', source: 'test' }),
    env: {},
  });
  const m = await provider.measure();
  assert.equal(m.ok, false);
  assert.equal(m.reason, 'network');
  assert.match(m.message, /could not reach/i);
});

test('a response with no usable window is malformed, never an empty-but-ok reading', async () => {
  await withServer(
    (req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ five_hour: { utilization: null }, seven_day: { utilization: -3 } }));
    },
    async (base) => {
      const provider = new ClaudeSubscriptionProvider({
        clock: new FakeClock(1_700_000_000_000),
        baseUrl: base,
        tokenResolver: () => ({ token: 'tok', source: 'test' }),
        env: {},
      });
      const m = await provider.measure();
      assert.equal(m.ok, false);
      assert.equal(m.reason, 'malformed');
      assert.ok(!/"usedPercent":0\b/.test(JSON.stringify(m)), 'nothing was coerced to 0%');
    },
  );
});
