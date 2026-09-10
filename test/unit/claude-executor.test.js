import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createClaudeExecutor, buildPrompt, classifyCliFailure } from '../../src/workers/claude-executor.js';
import { classifyError } from '../../src/orchestrator/retry.js';
import { FakeClock } from '../../src/core/clock.js';

/** Minimal stand-in for a spawned process. */
function fakeSpawn({ stdout = '', stderr = '', code = 0, failToSpawn = null, calls = [] } = {}) {
  return (command, args, options) => {
    calls.push({ command, args, options });
    if (failToSpawn) throw new Error(failToSpawn);
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    setImmediate(() => {
      if (stdout) child.stdout.emit('data', stdout);
      if (stderr) child.stderr.emit('data', stderr);
      child.emit('close', code);
    });
    return child;
  };
}

const ctx = {
  project: { id: 'prj_1', title: 'Recipe app', goal: 'a recipe app' },
  scope: ['search', 'favorites'],
  answers: { q1: 'store it locally' },
};

test('it runs the CLI in a per-project workspace with a real prompt', async () => {
  const calls = [];
  const dirs = [];
  const execute = createClaudeExecutor({
    clock: new FakeClock(0),
    workspaceRoot: '/tmp/jarvis-ws',
    spawnImpl: fakeSpawn({ calls, stdout: JSON.stringify({ result: 'Added search.\nDetails follow.', total_cost_usd: 0.02 }) }),
    mkdir: (d) => dirs.push(d),
  });

  const result = await execute({ id: 't1', title: 'Build search', kind: 'implement' }, ctx);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.cwd, '/tmp/jarvis-ws/prj_1');
  assert.deepEqual(dirs, ['/tmp/jarvis-ws/prj_1']);
  assert.equal(calls[0].args[0], '-p');
  assert.match(calls[0].args[1], /Build search/);
  assert.match(calls[0].args[1], /Agreed scope: search; favorites/);
  assert.match(calls[0].args[1], /store it locally/, 'decisions already made are carried in');
  assert.ok(calls[0].args.includes('--output-format'));
  assert.equal(result.output, 'Added search.', 'the summary is one line, not the whole transcript');
  assert.equal(result.costUsd, 0.02);
});

test('verify and review report a verdict the loop can act on', async () => {
  const pass = createClaudeExecutor({
    clock: new FakeClock(0), workspaceRoot: '/tmp/ws',
    spawnImpl: fakeSpawn({ stdout: JSON.stringify({ result: 'PASS - 42 tests green' }) }), mkdir: () => {},
  });
  const passed = await pass({ id: 't', title: 'Verify', kind: 'verify' }, ctx);
  assert.notEqual(passed.ok, false);

  const fail = createClaudeExecutor({
    clock: new FakeClock(0), workspaceRoot: '/tmp/ws',
    spawnImpl: fakeSpawn({ stdout: JSON.stringify({ result: 'FAIL - 2 tests failed in cart.test.js' }) }), mkdir: () => {},
  });
  const failed = await fail({ id: 't', title: 'Verify', kind: 'verify' }, ctx);
  assert.equal(failed.ok, false, 'a failing check must not read as success');
  assert.match(failed.reason, /2 tests failed/);
});

test('CLI failures map onto the classes the orchestrator already acts on', () => {
  const task = { kind: 'implement' };
  const cases = [
    ['Invalid API key · Please run /login', 'credential'],
    ['Error: not logged in', 'credential'],
    ['permission denied writing to /etc', 'permission'],
    ['429 rate limit exceeded', 'capacity'],
    ['socket hang up', 'transient'],
    ['SyntaxError: unexpected token', 'fatal'],
  ];
  for (const [stderr, expected] of cases) {
    const err = classifyCliFailure({ code: 1, stderr, stdout: '' }, task);
    assert.equal(classifyError(err), expected, `"${stderr}" should classify as ${expected}`);
  }
});

test('a timeout is transient, and a missing binary is fatal with a fixable message', async () => {
  const slow = createClaudeExecutor({
    clock: new FakeClock(0), workspaceRoot: '/tmp/ws', timeoutMs: 5, mkdir: () => {},
    spawnImpl: () => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = () => setImmediate(() => child.emit('close', 143));
      return child;
    },
  });
  await assert.rejects(
    () => slow({ id: 't', title: 'x', kind: 'implement' }, ctx),
    (err) => { assert.equal(classifyError(err), 'transient'); return true; },
  );

  const missing = createClaudeExecutor({
    clock: new FakeClock(0), workspaceRoot: '/tmp/ws', command: 'nope',
    spawnImpl: fakeSpawn({ failToSpawn: 'spawn nope ENOENT' }), mkdir: () => {},
  });
  await assert.rejects(
    () => missing({ id: 't', title: 'x', kind: 'implement' }, ctx),
    (err) => {
      assert.equal(classifyError(err), 'fatal', 'a missing binary is not worth retrying');
      assert.match(err.message, /JARVIS_CLAUDE_BIN/, 'it says how to fix it');
      return true;
    },
  );
});

test('prompts differ meaningfully by task kind', () => {
  const p = (kind) => buildPrompt({ id: 't', title: 'the thing', kind, meta: { reason: 'tests failed' } }, ctx);
  assert.match(p('implement'), /Implement this piece/);
  assert.match(p('repair'), /tests failed/);
  assert.match(p('verify'), /Do not change code/);
  assert.match(p('review'), /Do not change code/);
  assert.match(p('deliver'), /two sentences/);
});

test('a non-JSON CLI response still yields a usable line rather than crashing', async () => {
  const execute = createClaudeExecutor({
    clock: new FakeClock(0), workspaceRoot: '/tmp/ws', mkdir: () => {},
    spawnImpl: fakeSpawn({ stdout: 'plain text output from an older CLI\nsecond line' }),
  });
  const out = await execute({ id: 't', title: 'x', kind: 'implement' }, ctx);
  assert.equal(out.output, 'plain text output from an older CLI');
});
