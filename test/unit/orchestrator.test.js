import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventBus } from '../../src/core/bus.js';
import { Store } from '../../src/core/store.js';
import { Scheduler } from '../../src/orchestrator/scheduler.js';
import { WorkerPool } from '../../src/workers/pool.js';
import { QuestionGate } from '../../src/orchestrator/question.js';
import { Backlog } from '../../src/orchestrator/backlog.js';
import { Orchestrator } from '../../src/orchestrator/orchestrator.js';
import { DeterministicPlanner } from '../../src/orchestrator/planner.js';
import { AutoClock, createScriptedExecutor, silentLogger } from '../helpers/fakes.js';

function build({ executor = createScriptedExecutor(), clock = new AutoClock(), usageStatus = 'live' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-orch-'));
  const bus = new EventBus();
  const store = new Store({ dir, clock });
  const usage = {
    report: () => ({ status: usageStatus, windows: [], ageMs: 0 }),
    windowsForScheduling: () => (usageStatus === 'live' ? [{ key: 'five_hour', remainingPercent: 80 }] : []),
  };
  const scheduler = new Scheduler({ clock, usage, bus, maxConcurrency: 4, logger: silentLogger() });
  const pool = new WorkerPool({ clock, bus, scheduler, size: 4, executor, logger: silentLogger() });
  const questions = new QuestionGate({ store, bus, clock });
  const backlog = new Backlog({ store, bus, clock });
  const orchestrator = new Orchestrator({
    store, bus, clock, scheduler, pool, questions, backlog,
    planner: new DeterministicPlanner(), logger: silentLogger(),
  });
  return {
    orchestrator, store, bus, clock, pool, questions, backlog, scheduler,
    cleanup: async () => { await pool.shutdown(); fs.rmSync(dir, { recursive: true, force: true }); },
  };
}

test('a plan is never the stopping point', async (t) => {
  const h = build();
  t.after(h.cleanup);
  const phases = [];
  h.bus.on('project.phase', (e) => phases.push(e.payload.phase));

  const project = await h.orchestrator.submit({ title: 'App', goal: 'a login screen and a profile page' });
  await h.orchestrator.run(project.id);

  assert.deepEqual(phases, ['implementing', 'verifying', 'reviewing', 'delivering']);
  assert.equal(h.store.get('projects', project.id).status, 'delivered');
});

test('a failing check triggers a repair and the checks are re-run, not assumed', async (t) => {
  let verifyRuns = 0;
  const h = build({
    executor: createScriptedExecutor({
      script: { verify: [{ ok: false, reason: 'two tests failed' }, {}] },
      onTask: (task) => { if (task.kind === 'verify') verifyRuns += 1; },
    }),
  });
  t.after(h.cleanup);
  const failures = [];
  h.bus.on('task.failed', (e) => failures.push(e.payload.reason));

  const project = await h.orchestrator.submit({ title: 'App', goal: 'a settings page' });
  await h.orchestrator.run(project.id);

  assert.deepEqual(failures, ['two tests failed']);
  assert.equal(verifyRuns, 2, 'the failed check was re-run after the repair');
  const repairs = h.store.find('tasks', (x) => x.kind === 'repair');
  assert.equal(repairs.length, 1);
  assert.equal(repairs[0].status, 'done');
  assert.equal(h.store.get('projects', project.id).status, 'delivered');
});

test('an unfixable failure blocks after the repair cap rather than spinning forever', async (t) => {
  const h = build({
    executor: createScriptedExecutor({
      script: { verify: { ok: false, reason: 'always broken' }, repair: {} },
    }),
  });
  t.after(h.cleanup);

  const project = await h.orchestrator.submit({ title: 'App', goal: 'a broken thing' });
  await h.orchestrator.run(project.id);

  const final = h.store.get('projects', project.id);
  assert.equal(final.status, 'blocked');
  assert.match(final.blockedReason, /repair rounds/i);
  assert.ok(final.repairRounds <= 4, `repair rounds were capped (${final.repairRounds})`);
});

test('concurrent run() calls share one loop rather than double-executing work', async (t) => {
  const seen = [];
  const h = build({ executor: createScriptedExecutor({ onTask: (task) => seen.push(task.id) }) });
  t.after(h.cleanup);

  const project = await h.orchestrator.submit({ title: 'App', goal: 'a, b and c' });
  await Promise.all([h.orchestrator.run(project.id), h.orchestrator.run(project.id), h.orchestrator.run(project.id)]);

  assert.equal(new Set(seen).size, seen.length, 'no task ran twice');
  assert.equal(h.store.get('projects', project.id).status, 'delivered');
});

test('a change queued during a running phase is folded in at a task boundary', async (t) => {
  let sent = false;
  const h = build({
    executor: createScriptedExecutor({
      onTask: (task, ctx) => {
        if (!sent && task.kind === 'implement') {
          sent = true;
          h.orchestrator.applyChange(ctx.project.id, 'also add an audit trail');
        }
      },
    }),
  });
  t.after(h.cleanup);

  const project = await h.orchestrator.submit({ title: 'App', goal: 'a ledger and a report' });
  await h.orchestrator.run(project.id);
  await h.orchestrator.run(project.id);

  assert.equal(h.store.ids('projects').length, 1);
  const final = h.store.get('projects', project.id);
  assert.ok(final.planRevision >= 2);
  assert.match(final.scope.join(' ').toLowerCase(), /audit trail/);
  assert.match(final.scope.join(' ').toLowerCase(), /ledger/);
  assert.equal(final.status, 'delivered');
  assert.equal(h.orchestrator.pendingChanges(project.id), 0, 'no change was left stranded in the queue');
});

test('a change accepted as the loop settles is still folded in', async (t) => {
  const h = build();
  t.after(h.cleanup);

  const project = await h.orchestrator.submit({ title: 'App', goal: 'a chart' });
  const run = h.orchestrator.run(project.id);
  // Land the change on the same turn the loop is finishing on.
  const change = run.then(() => h.orchestrator.applyChange(project.id, 'also add a legend'));
  await run;
  await change;
  await h.orchestrator.run(project.id);

  assert.equal(h.orchestrator.pendingChanges(project.id), 0);
  assert.equal(h.store.ids('projects').length, 1);
  assert.match(h.store.get('projects', project.id).scope.join(' ').toLowerCase(), /legend/);
  assert.equal(h.store.get('projects', project.id).status, 'delivered');
});

test('applying a change to a delivered project reopens it instead of forking one', async (t) => {
  const h = build();
  t.after(h.cleanup);

  const project = await h.orchestrator.submit({ title: 'App', goal: 'a calendar' });
  await h.orchestrator.run(project.id);
  assert.equal(h.store.get('projects', project.id).status, 'delivered');

  await h.orchestrator.applyChange(project.id, 'add recurring events');
  await h.orchestrator.run(project.id);

  assert.equal(h.store.ids('projects').length, 1, 'reopened, not forked');
  const final = h.store.get('projects', project.id);
  assert.equal(final.status, 'delivered');
  assert.match(final.scope.join(' ').toLowerCase(), /recurring events/);
  assert.equal(h.store.find('deliverables', (d) => d.projectId === project.id).length, 2);
});

test('a stopped project refuses further changes with a clear message', async (t) => {
  const h = build();
  t.after(h.cleanup);
  const project = await h.orchestrator.submit({ title: 'App', goal: 'a thing', autostart: false });
  h.orchestrator.stop(project.id);
  await assert.rejects(() => h.orchestrator.applyChange(project.id, 'add more'), /stopped/i);
});

test('status() reports progress without leaking internals into the action line', async (t) => {
  const h = build();
  t.after(h.cleanup);
  const project = await h.orchestrator.submit({ title: 'App', goal: 'x, y and z' });
  await h.orchestrator.run(project.id);

  const status = h.orchestrator.status(project.id);
  assert.equal(status.progress.done, status.progress.total);
  assert.equal(status.progress.percent, 100);
  assert.equal(status.openQuestions.length, 0);
  assert.equal(status.deliverables.length, 1);
  assert.ok(status.currentAction.length <= 120);
  assert.ok(!/tsk_|prj_/.test(status.currentAction), 'no internal ids in what Blake reads');
});

test('drain() stops at an empty backlog instead of inventing work', async (t) => {
  const h = build();
  t.after(h.cleanup);
  const emptied = [];
  h.bus.on('backlog.empty', () => emptied.push(1));

  const done = await h.orchestrator.drain();
  assert.deepEqual(done, []);
  assert.equal(h.store.ids('projects').length, 0);
  assert.equal(emptied.length, 1);
});

test('ask-first mode shows the plan and waits, then builds on approval', async (t) => {
  let mode = 'ask-first';
  const h = build();
  h.orchestrator.settingsProvider = () => ({ mode });
  t.after(h.cleanup);

  const project = await h.orchestrator.submit({ title: 'App', goal: 'a chart and a table' });
  await h.orchestrator.run(project.id);

  const question = h.questions.open(project.id)[0];
  assert.ok(question, 'it asked before building');
  assert.match(question.text, /shall i go ahead/i);
  assert.match(question.text, /chart/i, 'the plan itself is in the question');
  assert.equal(question.recommendedDefault, 'yes');
  assert.equal(h.store.find('tasks', (x) => x.status === 'done').length, 0, 'nothing was built yet');

  h.questions.answer(question.id, 'yes');
  await h.orchestrator.run(project.id);
  assert.equal(h.store.get('projects', project.id).status, 'delivered');
});

test('declining the plan in ask-first mode pauses instead of building anyway', async (t) => {
  const h = build();
  h.orchestrator.settingsProvider = () => ({ mode: 'ask-first' });
  t.after(h.cleanup);

  const project = await h.orchestrator.submit({ title: 'App', goal: 'a risky migration' });
  await h.orchestrator.run(project.id);
  const question = h.questions.open(project.id)[0];

  h.questions.answer(question.id, 'no, change the plan');
  await h.orchestrator.run(project.id);

  assert.equal(h.store.get('projects', project.id).status, 'paused');
  assert.equal(h.store.find('tasks', (x) => x.status === 'done').length, 0, 'a decline built nothing');
});

test('paused mode records the work without starting it', async (t) => {
  const h = build();
  h.orchestrator.settingsProvider = () => ({ mode: 'paused' });
  t.after(h.cleanup);

  const project = await h.orchestrator.submit({ title: 'App', goal: 'anything at all' });
  assert.equal(project.status, 'paused');
  assert.equal(h.store.find('tasks', (x) => x.projectId === project.id).length, 0, 'nothing was planned or run');

  h.orchestrator.settingsProvider = () => ({ mode: 'autonomous' });
  h.orchestrator.resume(project.id);
  await h.orchestrator.run(project.id);
  assert.equal(h.store.get('projects', project.id).status, 'delivered', 'it picks up where it was held');
});

test('a step that keeps asking the same question gets the answer, not another question', async (t) => {
  const asked = {
    needsAnswer: { text: 'Which storage should this use?', recommendedDefault: 'SQLite', options: ['SQLite', 'Postgres'], impact: 'high' },
  };
  const h = build({ executor: createScriptedExecutor({ script: { implement: asked } }) });
  t.after(h.cleanup);
  let questions = 0;
  h.bus.on('question.asked', () => { questions += 1; });

  const project = await h.orchestrator.submit({ title: 'App', goal: 'a store' });
  await h.orchestrator.run(project.id);
  assert.equal(questions, 1);

  const q = h.questions.open(project.id)[0];
  h.questions.answer(q.id, 'Postgres');
  await h.orchestrator.run(project.id);
  await h.orchestrator.run(project.id);

  assert.equal(questions, 1, 'it did not ask the same thing twice');
  const reused = h.store.find('tasks', (x) => x.result?.reusedAnswer);
  assert.equal(reused.length, 1);
  assert.equal(reused[0].result.answer, 'Postgres', 'the answer Blake gave was applied');
  assert.equal(h.store.get('projects', project.id).status, 'delivered');
});
