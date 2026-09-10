import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeApp, createScriptedExecutor, StubProvider, failedMeasurement } from '../helpers/harness.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const say = (app, text, conversationId = 'c1') => app.dispatcher.handle({ conversationId, text });

/**
 * Acceptance requirement 4 — "Remove dashboard clutter".
 * The default view is five things; everything else is conditional or in a drawer.
 */

test('req4.1 the default state payload carries exactly the five default-view pieces', async (t) => {
  const app = makeApp();
  t.after(() => app.cleanup());

  const state = app.state('c1');
  // 1 current action, 2 chat, 3 mode/health, 4 usage circles, 5 the core is client-side.
  assert.equal(typeof state.currentAction, 'string');
  assert.ok(state.currentAction.length > 0);
  assert.ok(Array.isArray(state.conversation.turns));
  assert.ok(state.settings && 'mode' in state.settings && 'muted' in state.settings);
  assert.ok(state.health && typeof state.health.level === 'string');
  assert.ok(state.capacity && typeof state.capacity.status === 'string');

  // Conditional pieces are absent when there is nothing to act on.
  assert.equal(state.decision, null, 'no decision card when nothing needs a decision');
  assert.deepEqual(state.deliverables, [], 'no deliverables strip when there is nothing to show');

  // Diagnostics never ride along with the default view.
  assert.ok(!('recentEvents' in state), 'the event log is not on the default dashboard');
  assert.ok(!('pool' in state), 'worker internals are not on the default dashboard');
  assert.ok(!('tasks' in state), 'the task list is not on the default dashboard');
});

test('req4.2 the decision card appears only while a decision is genuinely needed', async (t) => {
  const app = makeApp({
    executor: createScriptedExecutor({
      script: {
        'Build paywall': [
          {
          needsAnswer: {
            text: 'Should the paywall be hard or soft?',
            recommendedDefault: 'soft',
            options: ['hard', 'soft'],
            impact: 'high',
          },
        },
          {},
        ],
      },
    }),
  });
  t.after(() => app.cleanup());

  const start = await say(app, 'build a paywall, a pricing page and a receipt email');
  assert.equal(app.state('c1').decision, null, 'no card before anything is asked');

  await app.orchestrator.run(start.projectId);
  const waiting = app.state('c1');
  assert.ok(waiting.decision, 'the card shows when Jarvis needs Blake');
  assert.match(waiting.decision.text, /paywall/i);
  assert.equal(waiting.decision.recommendedDefault, 'soft', 'the card carries a recommended default');

  await say(app, 'soft');
  await app.orchestrator.run(start.projectId);
  await app.orchestrator.run(start.projectId);
  assert.equal(app.state('c1').decision, null, 'the card goes away once answered');
});

test('req4.3 deliverables appear only when there is something useful to show', async (t) => {
  const app = makeApp();
  t.after(() => app.cleanup());

  const start = await say(app, 'build a QR code generator');
  assert.deepEqual(app.state('c1').deliverables, []);
  await app.orchestrator.run(start.projectId);

  const after = app.state('c1');
  assert.equal(after.deliverables.length, 1);
  assert.ok(after.deliverables[0].body.length > 0);
});

test('req4.4 an actionable failure is surfaced once, with a remedy, and never hidden', async (t) => {
  const app = makeApp({
    executor: createScriptedExecutor({
      script: { implement: { throw: { message: 'the deploy key was rejected', status: 403 } } },
    }),
  });
  t.after(() => app.cleanup());

  const start = await say(app, 'build a release pipeline');
  await app.orchestrator.run(start.projectId);

  const state = app.state('c1');
  assert.equal(state.project.status, 'blocked');
  assert.ok(state.project.blockedReason, 'the failure is visible, not swallowed');
  assert.match(state.project.blockedReason, /permission|credential/i);
  assert.match(state.project.blockedReason, /deploy key/i, 'it names precisely what is needed');
  assert.equal(state.health.level, 'attention');

  // Once, not repeated: the same reason must not also be duplicated into the
  // action line and the health detail as two different sentences.
  assert.equal(state.health.detail, state.project.blockedReason);
});

test('req4.5 diagnostics, logs and project management live behind the drawer endpoint', async (t) => {
  const app = makeApp();
  t.after(() => app.cleanup());
  await say(app, 'build a sitemap generator');

  const diag = app.diagnostics();
  assert.ok(Array.isArray(diag.recentEvents), 'the event log is available in the drawer');
  assert.ok(diag.pool && typeof diag.pool.size === 'number');
  assert.ok(diag.counts && typeof diag.counts.tasks === 'number');
  assert.ok(diag.scheduler && typeof diag.scheduler.concurrency === 'number');
});

test('req4.6 the markup has no permanent warnings, empty panels or duplicate answers', async () => {
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');

  // Conditional regions must be hidden by default, not rendered empty.
  for (const id of ['decision', 'deliverables']) {
    const re = new RegExp(`<[^>]*id="[^"]*${id}[^"]*"[^>]*>`, 'i');
    const tag = html.match(re)?.[0] ?? '';
    assert.ok(tag, `expected a ${id} region`);
    assert.ok(/\bhidden\b/.test(tag), `${id} region must start hidden, got: ${tag}`);
  }

  // Drawers/secondary tabs must be closed by default.
  const drawerTags = html.match(/<(?:aside|section|div)[^>]*class="[^"]*drawer[^"]*"[^>]*>/gi) ?? [];
  assert.ok(drawerTags.length >= 1, 'diagnostics live in a drawer');
  for (const tag of drawerTags) {
    assert.ok(/\bhidden\b|aria-hidden="true"/.test(tag), `drawer must be closed by default: ${tag}`);
  }

  // No permanent explanatory banner shouting at Blake on every load.
  const banners = html.match(/class="[^"]*\b(?:warning|banner|notice)\b[^"]*"/gi) ?? [];
  for (const b of banners) {
    const idx = html.indexOf(b);
    const tag = html.slice(html.lastIndexOf('<', idx), html.indexOf('>', idx) + 1);
    assert.ok(/\bhidden\b/.test(tag), `banner must not be permanent: ${tag}`);
  }

  // No external network dependencies — it must work offline.
  assert.equal(html.match(/src="https?:\/\//g), null, 'no remote scripts');
  assert.equal(html.match(/href="https?:\/\/[^"]*\.css/g), null, 'no remote stylesheets');
});

test('req4.7 the default view stays legible when capacity is unreadable', async (t) => {
  const clock = undefined;
  const app = makeApp({ provider: new StubProvider([]) });
  t.after(() => app.cleanup());
  app.testProvider.push(failedMeasurement(app.testClock, 'not_authenticated'));
  await app.usage.refresh();

  const state = app.state('c1');
  assert.equal(state.capacity.status, 'unavailable');
  assert.deepEqual(state.capacity.windows, [], 'no invented circles');
  assert.ok(state.capacity.explanation, 'it explains itself instead of showing nothing');
  assert.ok(state.capacity.recovery, 'and offers a recovery action');
  assert.equal(state.health.level, 'degraded');
  assert.equal(state.decision, null, 'an unreadable meter is not a decision Blake must make');
});
