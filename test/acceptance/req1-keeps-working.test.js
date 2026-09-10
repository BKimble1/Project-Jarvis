import test from 'node:test';
import assert from 'node:assert/strict';
import { makeApp, createScriptedExecutor, recordEvents, AutoClock } from '../helpers/harness.js';
import { createApp } from '../../src/app.js';

/**
 * Acceptance requirement 1 — "Keep working after a request".
 * Jarvis plans, implements, verifies, reviews, repairs and delivers on its own.
 */

test('req1.1 a build request runs all the way to delivery with no further input', async (t) => {
  const app = makeApp();
  t.after(() => app.cleanup());
  const events = recordEvents(app.bus);

  const project = await app.orchestrator.submit({
    conversationId: 'c1',
    title: 'Recipe app',
    goal: 'a recipe app with search, a favorites list and a settings screen',
  });
  await app.orchestrator.run(project.id);

  const final = app.store.get('projects', project.id);
  assert.equal(final.status, 'delivered', 'project must reach delivered without further input');
  assert.equal(final.phase, 'idle');

  const kinds = app.store.find('tasks', (x) => x.projectId === project.id).map((x) => x.kind);
  for (const required of ['implement', 'verify', 'review', 'deliver']) {
    assert.ok(kinds.includes(required), `expected a ${required} task, got ${kinds.join(', ')}`);
  }

  const deliverables = app.store.find('deliverables', (d) => d.projectId === project.id);
  assert.equal(deliverables.length, 1, 'exactly one deliverable');
  assert.match(deliverables[0].body, /Recipe app/);

  assert.equal(events.count('project.delivered'), 1);
  // It did not stop after planning.
  assert.ok(events.count('task.completed') >= 4, 'work continued past the plan');
});

test('req1.2 "evaluate only" produces the evaluation and builds nothing', async (t) => {
  const executed = [];
  const app = makeApp({ executor: createScriptedExecutor({ onTask: (task) => executed.push(task.kind) }) });
  t.after(() => app.cleanup());

  const project = await app.orchestrator.submit({
    conversationId: 'c1', title: 'Queue rewrite', goal: 'rewrite the job queue', evaluationOnly: true,
  });
  await app.orchestrator.run(project.id);

  const final = app.store.get('projects', project.id);
  assert.equal(final.status, 'evaluated');
  assert.deepEqual([...new Set(executed)], ['deliver'], 'only the evaluation ran');
  assert.equal(executed.filter((k) => k === 'implement').length, 0, 'nothing was built');

  const deliverables = app.store.find('deliverables', (d) => d.projectId === project.id);
  assert.equal(deliverables.length, 1);
  assert.match(deliverables[0].title, /^Evaluation:/);
});

test('req1.3 a mid-build change folds into the same project and keeps agreed scope', async (t) => {
  let changeApplied = false;
  const app = makeApp({
    executor: createScriptedExecutor({
      onTask: (task, ctx) => {
        if (!changeApplied && task.kind === 'implement') {
          changeApplied = true;
          // Suggest a change while the build is genuinely in flight.
          queueMicrotask(() => app.orchestrator.applyChange(ctx.project.id, 'also add dark mode and CSV export'));
        }
      },
    }),
  });
  t.after(() => app.cleanup());
  const events = recordEvents(app.bus);

  const project = await app.orchestrator.submit({
    conversationId: 'c1', title: 'Dashboard', goal: 'a dashboard with charts and a filter bar',
  });
  await app.orchestrator.run(project.id);
  await app.orchestrator.run(project.id);

  assert.equal(app.store.ids('projects').length, 1, 'no duplicate project was created');
  const final = app.store.get('projects', project.id);
  assert.ok(final.planRevision >= 2, `plan was revised in place (revision ${final.planRevision})`);
  assert.equal(events.count('project.changed'), 1);

  // Original scope survived the change.
  const scope = final.scope.join(' | ').toLowerCase();
  assert.match(scope, /charts/, 'original scope kept');
  assert.match(scope, /filter bar/, 'original scope kept');
  assert.match(scope, /dark mode/, 'new scope added');
  assert.match(scope, /csv export/, 'new scope added');

  const titles = app.store.find('tasks', (x) => x.projectId === project.id).map((x) => x.title.toLowerCase());
  assert.ok(titles.some((x) => x.includes('dark mode')), 'change produced real work');
  assert.equal(final.status, 'delivered');
});

test('req1.4 a transient failure is retried, then repaired, and the build still lands', async (t) => {
  const attempts = [];
  const app = makeApp({
    executor: createScriptedExecutor({
      script: {
        implement: [
          { throw: { message: 'socket hang up', code: 'ECONNRESET' } },
          { throw: { message: 'socket hang up', code: 'ECONNRESET' } },
          {},
        ],
      },
      onTask: (task, _ctx, n) => attempts.push(`${task.kind}#${n}`),
    }),
  });
  t.after(() => app.cleanup());
  const events = recordEvents(app.bus);

  const project = await app.orchestrator.submit({ conversationId: 'c1', title: 'Importer', goal: 'a CSV importer' });
  await app.orchestrator.run(project.id);

  const recovered = events.count('worker.crashed') + events.count('worker.recovered') + events.count('task.retrying');
  assert.ok(recovered >= 2, `transient errors were recovered from, not surfaced (saw ${recovered} recovery events)`);
  assert.equal(events.count('project.blocked'), 0, 'a recoverable error never reached Blake as a blocker');
  const final = app.store.get('projects', project.id);
  assert.equal(final.status, 'delivered', 'a recoverable error did not stop the loop');
  assert.ok(attempts.length >= 3, 'the failing step was genuinely retried');
});

test('req1.4b a permanently transient failure is bounded, repaired, and still delivers', async (t) => {
  let implementCalls = 0;
  const app = makeApp({
    executor: createScriptedExecutor({
      script: { implement: { throw: { message: 'socket hang up', code: 'ECONNRESET' } } },
      onTask: (task) => { if (task.kind === 'implement') implementCalls += 1; },
    }),
  });
  t.after(() => app.cleanup());
  const events = recordEvents(app.bus);

  const project = await app.orchestrator.submit({ conversationId: 'c1', title: 'Flaky', goal: 'one flaky feature' });
  await app.orchestrator.run(project.id);

  assert.ok(implementCalls <= 6, `retries stayed bounded (${implementCalls} attempts), not multiplied across layers`);
  assert.ok(events.count('task.failed') >= 1, 'it gave up on the failing step rather than retrying forever');
  assert.ok(app.store.find('tasks', (x) => x.kind === 'repair').length >= 1, 'and repaired it');
  assert.equal(app.store.get('projects', project.id).status, 'delivered');
});

test('req1.5 a credential failure blocks with a precise ask and stops retrying', async (t) => {
  let calls = 0;
  const app = makeApp({
    executor: createScriptedExecutor({
      script: { implement: { throw: { message: 'token expired for the deploy target', status: 401 } } },
      onTask: (task) => { if (task.kind === 'implement') calls += 1; },
    }),
  });
  t.after(() => app.cleanup());
  const events = recordEvents(app.bus);

  const project = await app.orchestrator.submit({ conversationId: 'c1', title: 'Deployer', goal: 'deploy the site' });
  await app.orchestrator.run(project.id);

  const final = app.store.get('projects', project.id);
  assert.equal(final.status, 'blocked');
  assert.match(final.blockedReason, /credential|permission/i);
  assert.match(final.blockedReason, /token expired/i, 'says precisely what is needed');
  assert.equal(events.count('project.blocked'), 1);
  assert.ok(calls <= 2, `it stopped retrying a non-recoverable failure (ran ${calls} times)`);
});

test('req1.6 pause and stop are honoured, and resume continues from saved state', async (t) => {
  let seen = 0;
  const app = makeApp({
    executor: createScriptedExecutor({
      onTask: (task, ctx) => {
        seen += 1;
        if (seen === 1) app.orchestrator.pause(ctx.project.id);
      },
    }),
  });
  t.after(() => app.cleanup());

  const project = await app.orchestrator.submit({ conversationId: 'c1', title: 'Notes app', goal: 'notes with tags, search and export' });
  await app.orchestrator.run(project.id);

  let mid = app.store.get('projects', project.id);
  assert.equal(mid.status, 'paused', 'pause took effect at a task boundary');
  assert.notEqual(mid.phase, 'idle', 'work is parked mid-flight, not finished');
  const doneAtPause = app.store.find('tasks', (x) => x.status === 'done').length;

  app.orchestrator.resume(project.id);
  await app.orchestrator.run(project.id);

  const final = app.store.get('projects', project.id);
  assert.equal(final.status, 'delivered', 'resume carried on from saved state');
  assert.ok(app.store.find('tasks', (x) => x.status === 'done').length > doneAtPause, 'it continued rather than restarting');
});

test('req1.7 an ordinary build never stops for a routine approval', async (t) => {
  const app = makeApp();
  t.after(() => app.cleanup());
  const events = recordEvents(app.bus);

  const project = await app.orchestrator.submit({
    conversationId: 'c1', title: 'Billing', goal: 'billing with invoices, refunds and a tax table',
  });
  await app.orchestrator.run(project.id);

  assert.equal(app.store.get('projects', project.id).status, 'delivered');
  assert.equal(events.count('question.asked'), 0, 'no routine approval stops');
  assert.equal(events.count('task.blocked'), 0);
});

test('req1.7b a material question blocks one task while independent work continues', async (t) => {
  const clock = new AutoClock();
  const app = makeApp({
    clock,
    executor: createScriptedExecutor({
      script: {
        'Build invoices': [
          {
            needsAnswer: {
              text: 'Should invoices be numbered per-customer or globally?',
              recommendedDefault: 'globally',
              options: ['per-customer', 'globally'],
              impact: 'high',
            },
          },
          {},
        ],
      },
    }),
  });
  t.after(() => app.cleanup());
  const events = recordEvents(app.bus);

  const project = await app.orchestrator.submit({
    conversationId: 'c1', title: 'Billing', goal: 'invoices, refunds and a tax table',
  });
  await app.orchestrator.run(project.id);

  assert.equal(events.count('question.asked'), 1, 'exactly one question, asked once');
  const question = app.questions.open(project.id)[0];
  assert.ok(question, 'the question is open');
  assert.equal(question.recommendedDefault, 'globally', 'it carries a recommended default');

  const tasks = app.store.find('tasks', (x) => x.projectId === project.id);
  const parked = tasks.filter((x) => x.blockedByQuestionId === question.id);
  assert.equal(parked.length, 1, 'only the dependent task is parked');
  const independentDone = tasks.filter((x) => x.kind === 'implement' && x.status === 'done');
  assert.ok(independentDone.length >= 1, 'independent work continued while waiting');
  assert.equal(app.store.get('projects', project.id).status, 'active', 'the project is not blocked, just waiting');

  // Answering resumes automatically — no "continue" needed.
  app.questions.answer(question.id, 'per-customer');
  await app.orchestrator.run(project.id);
  await app.orchestrator.run(project.id);

  assert.equal(app.store.get('projects', project.id).status, 'delivered', 'it resumed on its own after the answer');
});

test('req1.8 a routine choice with a sensible default is decided, not asked', async (t) => {
  const app = makeApp({
    executor: createScriptedExecutor({
      script: {
        implement: {
          needsAnswer: {
            text: 'Which date format should the list use?',
            recommendedDefault: 'ISO 8601',
            options: ['ISO 8601', 'US'],
            impact: 'low',
          },
        },
      },
    }),
  });
  t.after(() => app.cleanup());
  const events = recordEvents(app.bus);

  const project = await app.orchestrator.submit({ conversationId: 'c1', title: 'Log viewer', goal: 'a log viewer' });
  await app.orchestrator.run(project.id);

  assert.equal(events.count('question.asked'), 0, 'no approval stop for a routine choice');
  assert.equal(app.store.get('projects', project.id).status, 'delivered');
  const decided = app.store.find('tasks', (x) => x.result?.autoDecided);
  assert.ok(decided.length >= 1, 'the default was applied and recorded');
});

test('req1.9 after delivering it works the authorized backlog, then stops', async (t) => {
  const app = makeApp();
  t.after(() => app.cleanup());
  const events = recordEvents(app.bus);

  app.backlog.add({ title: 'Add keyboard shortcuts', goal: 'add keyboard shortcuts' });
  app.backlog.add({ title: 'Someday: rewrite in Rust', goal: 'rewrite in Rust', authorized: false });

  const project = await app.orchestrator.submit({ conversationId: 'c1', title: 'Wiki', goal: 'a wiki' });
  await app.orchestrator.run(project.id);
  await app.orchestrator.drain();

  const projects = app.store.all('projects');
  assert.equal(projects.length, 2, 'it picked up exactly the one authorized backlog item');
  assert.ok(projects.every((p) => ['delivered', 'evaluated'].includes(p.status)));
  assert.equal(events.count('backlog.picked'), 1);
  assert.ok(events.count('backlog.empty') >= 1, 'it announced the backlog was empty rather than inventing work');

  const unauthorized = app.backlog.items().find((i) => i.authorized === false);
  assert.equal(unauthorized.status, 'pending', 'unauthorized work was never started');
});

test('req1.10 the current action is always one short first-person sentence', async (t) => {
  const app = makeApp();
  t.after(() => app.cleanup());

  const seen = [];
  app.bus.on('action.current', (evt) => seen.push(evt.payload.text));

  const project = await app.orchestrator.submit({ conversationId: 'c1', title: 'Timer app', goal: 'a timer app' });
  await app.orchestrator.run(project.id);

  assert.ok(seen.length >= 2, 'the action line actually changes as work moves');
  for (const line of seen) {
    assert.ok(line.length <= 120, `"${line}" is ${line.length} chars`);
    assert.ok(/^I\b|^I'm\b/.test(line), `"${line}" must be first person`);
    assert.equal(line.split(/(?<=[.!?])\s+\S/).length, 1, `"${line}" must be one sentence`);
    assert.ok(!/[*_`#]/.test(line), 'no markdown in the action line');
  }
});

test('req1.11 in-flight work survives a restart and resumes from the journal', async (t) => {
  const clock = new AutoClock();
  const app = makeApp({
    clock,
    executor: createScriptedExecutor({
      onTask: (task, ctx, n) => { if (task.kind === 'implement' && n === 1) app.orchestrator.pause(ctx.project.id); },
    }),
  });
  const project = await app.orchestrator.submit({ conversationId: 'c1', title: 'Kanban', goal: 'a kanban board with columns and drag and drop' });
  await app.orchestrator.run(project.id);
  assert.equal(app.store.get('projects', project.id).status, 'paused');
  const dataDir = app.testDataDir;
  await app.close();

  // A brand-new process over the same data directory.
  const revived = createApp({ dataDir, clock, provider: app.testProvider, executor: createScriptedExecutor() });
  t.after(async () => { await revived.cleanup?.(); await revived.close(); });

  const restored = revived.store.get('projects', project.id);
  assert.ok(restored, 'the project survived the restart');
  assert.equal(restored.status, 'paused');
  assert.ok(revived.store.find('tasks', (x) => x.projectId === project.id).length > 0, 'its tasks survived too');

  revived.orchestrator.resume(project.id);
  await revived.orchestrator.run(project.id);
  assert.equal(revived.store.get('projects', project.id).status, 'delivered', 'it finished the saved work');
});

test('req1.13 a restarted process picks up in-flight work by itself', async (t) => {
  const { createGatedExecutor } = await import('../helpers/harness.js');
  const { startBackgroundWork } = await import('../../src/server.js');
  const { silentLogger } = await import('../helpers/fakes.js');

  // Leave a project genuinely mid-build, then drop the process.
  const gated = createGatedExecutor();
  const first = makeApp({ executor: gated.executor });
  const project = await first.orchestrator.submit({ conversationId: 'c1', title: 'Ledger', goal: 'a ledger and a report' });
  await gated.firstArrival;
  const dataDir = first.testDataDir;
  const clock = first.testClock;
  const provider = first.testProvider;
  assert.equal(first.store.get('projects', project.id).status, 'active', 'it was still running when we stopped');
  gated.release();
  await first.close();

  // A fresh process over the same data directory, with nobody asking it to continue.
  const revived = createApp({ dataDir, clock, provider, executor: createScriptedExecutor(), logger: silentLogger() });
  t.after(async () => { await revived.close(); });

  const background = startBackgroundWork(revived, { logger: silentLogger(), capacityIntervalMs: 0 });
  t.after(() => background.stop());

  assert.deepEqual(background.resumed, [project.id], 'it found the saved work on boot');
  await revived.orchestrator.run(project.id);
  assert.equal(revived.store.get('projects', project.id).status, 'delivered', 'and carried it to delivery unprompted');
});
