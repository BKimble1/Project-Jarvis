import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { FakeClock } from '../../src/core/clock.js';
import { createLogger } from '../../src/core/logger.js';
import {
  ClaudeSubscriptionProvider,
  resolveOAuthToken,
  normalizeUsagePayload,
  humanizeWindowKey,
} from '../../src/telemetry/providers/claude-cli.js';

const SECRET = 'sk-ant-oat01-SUPER-SECRET-TOKEN-VALUE';

/** Minimal fs double: only readFileSync, backed by a plain map. */
function fakeFs(files = {}) {
  return {
    reads: [],
    readFileSync(file, enc) {
      this.reads.push(file);
      if (!(file in files)) {
        const err = new Error(`ENOENT: no such file or directory, open '${file}'`);
        err.code = 'ENOENT';
        throw err;
      }
      assert.equal(enc, 'utf8');
      return files[file];
    },
  };
}

function fakeResponse({ status = 200, body = {}, text = null } = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    async json() {
      if (text !== null) return JSON.parse(text);
      return body;
    },
    async text() { return text !== null ? text : JSON.stringify(body); },
  };
}

function recordingFetch(responder) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    return typeof responder === 'function' ? responder(url, init) : responder;
  };
  fn.calls = calls;
  return fn;
}

function capturingLogger() {
  const lines = [];
  const sink = {
    log: (...args) => lines.push(args.map(fmt).join(' ')),
    error: (...args) => lines.push(args.map(fmt).join(' ')),
  };
  return { logger: createLogger('test:provider', { level: 'debug', sink }), lines };
}

function fmt(v) { return typeof v === 'string' ? v : JSON.stringify(v); }

const CRED_PATH = path.join('/fake/home', '.claude', '.credentials.json');

// ---------------------------------------------------------------- token resolution

test('resolveOAuthToken prefers CLAUDE_CODE_OAUTH_TOKEN', () => {
  const fs = fakeFs({ [CRED_PATH]: JSON.stringify({ claudeAiOauth: { accessToken: 'from-file' } }) });
  const got = resolveOAuthToken({
    env: { CLAUDE_CODE_OAUTH_TOKEN: SECRET },
    fs,
    home: '/fake/home',
    exec: () => { throw new Error('exec must not run'); },
    platform: 'darwin',
  });
  assert.deepEqual(got, { token: SECRET, source: 'env' });
  assert.equal(fs.reads.length, 0, 'must not touch the filesystem when the env var is set');
});

test('resolveOAuthToken reads claudeAiOauth.accessToken from <home>/.claude/.credentials.json', () => {
  const fs = fakeFs({
    [CRED_PATH]: JSON.stringify({ claudeAiOauth: { accessToken: SECRET, expiresAt: 1 }, other: 1 }),
  });
  const got = resolveOAuthToken({ env: {}, fs, home: '/fake/home', exec: () => '', platform: 'linux' });
  assert.deepEqual(got, { token: SECRET, source: 'credentials-file' });
  assert.deepEqual(fs.reads, [CRED_PATH]);
});

test('resolveOAuthToken accepts a top-level accessToken in the credentials file', () => {
  const fs = fakeFs({ [CRED_PATH]: JSON.stringify({ accessToken: SECRET }) });
  const got = resolveOAuthToken({ env: {}, fs, home: '/fake/home', platform: 'linux' });
  assert.deepEqual(got, { token: SECRET, source: 'credentials-file' });
});

test('resolveOAuthToken falls back to the macOS keychain only on darwin', () => {
  const execCalls = [];
  const exec = (file, args) => { execCalls.push([file, args]); return `${SECRET}\n`; };

  const linux = resolveOAuthToken({ env: {}, fs: fakeFs(), home: '/fake/home', exec, platform: 'linux' });
  assert.equal(linux, null, 'keychain must not be consulted off darwin');
  assert.deepEqual(execCalls, []);

  const darwin = resolveOAuthToken({ env: {}, fs: fakeFs(), home: '/fake/home', exec, platform: 'darwin' });
  assert.deepEqual(darwin, { token: SECRET, source: 'keychain' });
  assert.deepEqual(execCalls, [['security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w']]]);
});

test('resolveOAuthToken parses a JSON blob returned by the keychain', () => {
  const exec = () => JSON.stringify({ claudeAiOauth: { accessToken: SECRET } });
  const got = resolveOAuthToken({ env: {}, fs: fakeFs(), home: '/fake/home', exec, platform: 'darwin' });
  assert.deepEqual(got, { token: SECRET, source: 'keychain' });
});

test('resolveOAuthToken returns null when nothing is available, and ignores ANTHROPIC_API_KEY', () => {
  const got = resolveOAuthToken({
    env: { ANTHROPIC_API_KEY: 'sk-ant-api03-paid-key' },
    fs: fakeFs({ [CRED_PATH]: 'not json at all' }),
    home: '/fake/home',
    exec: () => { const e = new Error('keychain locked'); throw e; },
    platform: 'darwin',
  });
  assert.equal(got, null);
});

// ---------------------------------------------------------------- humanizeWindowKey

test('humanizeWindowKey maps the known windows and title-cases the rest', () => {
  assert.equal(humanizeWindowKey('five_hour'), '5-hour');
  assert.equal(humanizeWindowKey('seven_day'), '7-day');
  assert.equal(humanizeWindowKey('seven_day_opus'), '7-day (Opus)');
  assert.equal(humanizeWindowKey('seven_day_oauth_apps'), '7-day (apps)');
  assert.equal(humanizeWindowKey('monthly_credit_pool'), 'Monthly Credit Pool');
  assert.equal(humanizeWindowKey(''), 'Unknown');
  assert.equal(humanizeWindowKey(undefined), 'Unknown');
});

// ---------------------------------------------------------------- normalizeUsagePayload

test('normalizeUsagePayload handles the object-of-windows shape and both utilization scales', () => {
  const clock = new FakeClock(1_700_000_000_000);
  const windows = normalizeUsagePayload({
    five_hour: { utilization: 0.25, resets_at: '2026-09-10T18:00:00.000Z' },
    seven_day: { utilization: 80, resets_at: 1_700_003_600_000 },
    account_uuid: 'not-a-window',
  }, { clock, measuredAt: clock.now() });

  assert.equal(windows.length, 2);
  const five = windows.find((w) => w.key === 'five_hour');
  assert.deepEqual(five, {
    key: 'five_hour',
    label: '5-hour',
    utilization: 0.25,
    usedPercent: 25,
    remainingPercent: 75,
    resetsAt: Date.parse('2026-09-10T18:00:00.000Z'),
    unit: 'percent',
    source: 'claude-subscription',
    measuredAt: 1_700_000_000_000,
  });
  const seven = windows.find((w) => w.key === 'seven_day');
  assert.equal(seven.utilization, 0.8, '80 must be read as 80%, not 8000%');
  assert.equal(seven.usedPercent, 80);
  assert.equal(seven.remainingPercent, 20);
  assert.equal(seven.resetsAt, 1_700_003_600_000);
});

test('normalizeUsagePayload handles the {windows:[...]} array shape with key or name', () => {
  const clock = new FakeClock(5_000);
  const windows = normalizeUsagePayload({
    windows: [
      { key: 'five_hour', utilization: 0.1, resets_at: 1_700_000_000 },   // seconds
      { name: 'seven_day_opus', utilization: 42.5 },
      { utilization: 0.9 },                                               // no key -> dropped
    ],
  }, { clock });

  assert.deepEqual(windows.map((w) => w.key), ['five_hour', 'seven_day_opus']);
  assert.equal(windows[0].resetsAt, 1_700_000_000_000, 'epoch seconds are promoted to ms');
  assert.equal(windows[0].measuredAt, 5_000, 'measuredAt falls back to clock.now()');
  assert.equal(windows[1].label, '7-day (Opus)');
  assert.equal(windows[1].usedPercent, 42.5);
  assert.equal(windows[1].resetsAt, null, 'a missing resets_at becomes null');
});

test('normalizeUsagePayload gives resetsAt null for unparseable values', () => {
  const clock = new FakeClock(1);
  const windows = normalizeUsagePayload({
    a: { utilization: 0.5, resets_at: 'tomorrow-ish' },
    b: { utilization: 0.5, resets_at: null },
    c: { utilization: 0.5, resets_at: 12 },
    d: { utilization: 0.5 },
  }, { clock });
  assert.equal(windows.length, 4);
  for (const w of windows) assert.equal(w.resetsAt, null, `${w.key} should have a null resetsAt`);
});

test('normalizeUsagePayload DROPS unusable utilization instead of coercing it to 0', () => {
  const clock = new FakeClock(1);
  const windows = normalizeUsagePayload({
    good: { utilization: 0.4 },
    nully: { utilization: null },
    nanny: { utilization: Number.NaN },
    negative: { utilization: -0.2 },
    negativePct: { utilization: -12 },
    wordy: { utilization: 'unknown' },
    empty: { utilization: '' },
    booly: { utilization: false },
    objy: { utilization: {} },
    infinite: { utilization: Number.POSITIVE_INFINITY },
  }, { clock });

  assert.deepEqual(windows.map((w) => w.key), ['good']);
  assert.equal(windows.every((w) => Number.isFinite(w.usedPercent)), true);
  assert.equal(windows.some((w) => w.usedPercent === 0), false,
    'unknown utilization must never appear as a 0% window');
});

test('normalizeUsagePayload returns [] for junk payloads', () => {
  const clock = new FakeClock(1);
  assert.deepEqual(normalizeUsagePayload(null, { clock }), []);
  assert.deepEqual(normalizeUsagePayload('nope', { clock }), []);
  assert.deepEqual(normalizeUsagePayload({}, { clock }), []);
  assert.deepEqual(normalizeUsagePayload({ windows: [] }, { clock }), []);
});

// ---------------------------------------------------------------- measure()

function makeProvider({ fetchImpl, env = {}, tokenResolver = () => ({ token: SECRET, source: 'env' }), logger, baseUrl = 'https://api.example.test' }) {
  return new ClaudeSubscriptionProvider({
    clock: new FakeClock(1_700_000_000_000),
    fetchImpl,
    env,
    baseUrl,
    tokenResolver,
    logger,
  });
}

test('measure() performs an authenticated GET to {baseUrl}/api/oauth/usage', async () => {
  const fetchImpl = recordingFetch(fakeResponse({
    body: { five_hour: { utilization: 0.6, resets_at: '2026-09-10T18:00:00.000Z' } },
  }));
  const provider = makeProvider({ fetchImpl });
  assert.equal(provider.name, 'claude-subscription');

  const m = await provider.measure();

  assert.equal(fetchImpl.calls.length, 1);
  const [{ url, init }] = fetchImpl.calls;
  assert.equal(url, 'https://api.example.test/api/oauth/usage');
  assert.equal(init.method, 'GET');
  assert.deepEqual(init.headers, {
    Authorization: `Bearer ${SECRET}`,
    'anthropic-beta': 'oauth-2025-04-20',
    accept: 'application/json',
  });

  assert.equal(m.ok, true);
  assert.equal(m.source, 'claude-subscription');
  assert.equal(m.measuredAt, 1_700_000_000_000);
  assert.equal(m.windows.length, 1);
  assert.equal(m.windows[0].usedPercent, 60);
  assert.equal(m.windows[0].remainingPercent, 40);
});

test('measure() uses the real resolveOAuthToken when wired with injected machine doubles', async () => {
  const fetchImpl = recordingFetch(fakeResponse({ body: { five_hour: { utilization: 0.05 } } }));
  const provider = new ClaudeSubscriptionProvider({
    clock: new FakeClock(10),
    fetchImpl,
    env: {},
    baseUrl: 'https://api.example.test/',
    tokenOptions: {
      env: {},
      fs: fakeFs({ [CRED_PATH]: JSON.stringify({ claudeAiOauth: { accessToken: SECRET } }) }),
      home: '/fake/home',
      platform: 'linux',
    },
    logger: capturingLogger().logger,
  });

  const m = await provider.measure();
  assert.equal(m.ok, true);
  assert.equal(fetchImpl.calls[0].url, 'https://api.example.test/api/oauth/usage',
    'trailing slashes in baseUrl must not double up');
  assert.equal(fetchImpl.calls[0].init.headers.Authorization, `Bearer ${SECRET}`);
});

test('measure() refuses to use ANTHROPIC_API_KEY as a credential', async () => {
  const fetchImpl = recordingFetch(() => { throw new Error('fetch must not be attempted'); });
  const provider = makeProvider({
    fetchImpl,
    env: { ANTHROPIC_API_KEY: 'sk-ant-api03-paid-key' },
    tokenResolver: () => null,
  });

  const m = await provider.measure();

  assert.equal(fetchImpl.calls.length, 0, 'no request may be made with an API key');
  assert.equal(m.ok, false);
  assert.equal(m.reason, 'not_authenticated');
  assert.match(m.remedy, /claude setup-token/);
  assert.match(m.remedy, /ANTHROPIC_API_KEY/);
  assert.match(m.remedy, /not used/i);
  assert.equal(JSON.stringify(m).includes('sk-ant-api03-paid-key'), false,
    'the API key value itself must not be echoed back');
});

test('measure() maps 401 to unauthorized and 403 likewise', async () => {
  for (const status of [401, 403]) {
    const provider = makeProvider({ fetchImpl: recordingFetch(fakeResponse({ status, body: { error: 'nope' } })) });
    const m = await provider.measure();
    assert.equal(m.ok, false, `status ${status}`);
    assert.equal(m.reason, 'unauthorized');
    assert.equal(m.source, 'claude-subscription');
    assert.match(m.remedy, /claude setup-token/);
    assert.equal(Number.isFinite(m.measuredAt), true);
  }
});

test('measure() maps 404 to unsupported and 500 to network', async () => {
  const notFound = await makeProvider({ fetchImpl: recordingFetch(fakeResponse({ status: 404 })) }).measure();
  assert.equal(notFound.reason, 'unsupported');

  const boom = await makeProvider({ fetchImpl: recordingFetch(fakeResponse({ status: 500 })) }).measure();
  assert.equal(boom.reason, 'network');
});

test('measure() maps a thrown fetch to reason network without throwing', async () => {
  const fetchImpl = recordingFetch(() => { const e = new Error('getaddrinfo EAI_AGAIN api.example.test'); e.code = 'EAI_AGAIN'; throw e; });
  const provider = makeProvider({ fetchImpl });

  const m = await provider.measure();   // must not reject
  assert.equal(m.ok, false);
  assert.equal(m.reason, 'network');
  assert.match(m.message, /EAI_AGAIN/);
  assert.equal(typeof m.remedy, 'string');
  assert.ok(m.remedy.length > 0);
});

test('measure() maps unparseable and unrecognised payloads to malformed', async () => {
  const badJson = await makeProvider({
    fetchImpl: recordingFetch({
      status: 200, ok: true,
      async json() { throw new SyntaxError('Unexpected token < in JSON'); },
      async text() { return '<html>'; },
    }),
  }).measure();
  assert.equal(badJson.reason, 'malformed');

  const noWindows = await makeProvider({
    fetchImpl: recordingFetch(fakeResponse({ body: { five_hour: { utilization: null } } })),
  }).measure();
  assert.equal(noWindows.ok, false);
  assert.equal(noWindows.reason, 'malformed');
  assert.equal(JSON.stringify(noWindows).includes('"usedPercent":0'), false);
});

test('measure() never leaks the token into results, errors or logs', async () => {
  const { logger, lines } = capturingLogger();

  // success path
  const okProvider = makeProvider({
    fetchImpl: recordingFetch(fakeResponse({ body: { five_hour: { utilization: 0.3 } } })),
    logger,
  });
  const ok = await okProvider.measure();
  assert.equal(ok.ok, true);
  assert.equal(JSON.stringify(ok).includes(SECRET), false, 'success result leaked the token');

  // unauthorized path
  const unauth = await makeProvider({ fetchImpl: recordingFetch(fakeResponse({ status: 401 })), logger }).measure();
  assert.equal(JSON.stringify(unauth).includes(SECRET), false, 'failure result leaked the token');

  // a leaky transport that echoes the Authorization header inside its error message
  const leaky = makeProvider({
    fetchImpl: recordingFetch((_url, init) => { throw new Error(`socket hang up while sending ${init.headers.Authorization}`); }),
    logger,
  });
  const scrubbed = await leaky.measure();
  assert.equal(scrubbed.reason, 'network');
  assert.equal(JSON.stringify(scrubbed).includes(SECRET), false, 'transport error leaked the token');
  assert.match(scrubbed.message, /\[redacted\]/);

  assert.ok(lines.length > 0, 'the logger should have been exercised');
  const logged = lines.join('\n');
  assert.equal(logged.includes(SECRET), false, `log output leaked the token: ${logged}`);
});

test('measure() reports unsupported when no fetch implementation exists', async () => {
  // `null` (not `undefined`) so the constructor default never falls back to a real global fetch.
  const provider = makeProvider({ fetchImpl: null });
  const m = await provider.measure();
  assert.equal(m.ok, false);
  assert.equal(m.reason, 'unsupported');
});

test('measure() survives a token resolver that throws', async () => {
  const fetchImpl = recordingFetch(fakeResponse({}));
  const provider = makeProvider({ fetchImpl, tokenResolver: () => { throw new Error('keychain exploded'); } });
  const m = await provider.measure();
  assert.equal(m.reason, 'not_authenticated');
  assert.equal(fetchImpl.calls.length, 0);
});
