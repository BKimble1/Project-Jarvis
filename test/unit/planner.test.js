import test from 'node:test';
import assert from 'node:assert/strict';
import { DeterministicPlanner, extractFeatures } from '../../src/orchestrator/planner.js';

test('features split on commas, "and", and bullet lists without duplicating', () => {
  assert.deepEqual(
    extractFeatures('search, a favorites list and a settings screen').map((f) => f.label),
    ['search', 'favorites list', 'settings screen'],
  );
  assert.deepEqual(
    extractFeatures('- login\n- logout\n- login').map((f) => f.label),
    ['login', 'logout'],
    'a repeated feature is not planned twice',
  );
  assert.deepEqual(extractFeatures('').map((f) => f.label), ['the requested work']);
  assert.equal(extractFeatures('a, b, c, d, e, f, g, h', 3).length, 3, 'feature count is capped');
});

test('a build plan runs implement -> verify -> review -> deliver with real dependencies', async () => {
  const planner = new DeterministicPlanner();
  const plan = await planner.plan({ title: 'Notes', goal: 'notes with tags and export', evaluationOnly: false });

  const kinds = plan.tasks.map((x) => x.kind);
  assert.deepEqual(kinds, ['implement', 'implement', 'verify', 'review', 'deliver']);

  const verify = plan.tasks.find((x) => x.kind === 'verify');
  const implementKeys = plan.tasks.filter((x) => x.kind === 'implement').map((x) => x.key);
  assert.deepEqual(verify.dependsOn.sort(), implementKeys.sort(), 'verification waits for the whole build');

  const review = plan.tasks.find((x) => x.kind === 'review');
  assert.deepEqual(review.dependsOn, [verify.key]);
  const deliver = plan.tasks.find((x) => x.kind === 'deliver');
  assert.deepEqual(deliver.dependsOn, [review.key]);

  assert.deepEqual(plan.scope, ['notes with tags', 'export']);
  assert.ok(plan.acceptance.length >= 3);
});

test('an evaluation-only plan builds nothing', async () => {
  const planner = new DeterministicPlanner();
  const plan = await planner.plan({ title: 'Redis move', goal: 'move the queue to Redis', evaluationOnly: true });
  assert.deepEqual(plan.tasks.map((x) => x.kind), ['deliver']);
  assert.match(plan.tasks[0].title, /^Evaluate /);
  assert.match(plan.summary, /^Evaluation of /);
});

test('a change plan produces update work and its own checks', async () => {
  const planner = new DeterministicPlanner();
  const plan = await planner.plan(
    { title: 'Notes', goal: 'notes', evaluationOnly: false },
    { change: 'also add dark mode and CSV export' },
  );
  const titles = plan.tasks.filter((x) => x.kind === 'implement').map((x) => x.title);
  assert.deepEqual(titles, ['Update dark mode', 'Update CSV export']);
  assert.ok(plan.tasks.some((x) => x.kind === 'verify'), 'a change is re-verified');
  assert.ok(plan.tasks.some((x) => x.kind === 'deliver'), 'a change is re-delivered');
  assert.match(plan.rationale, /earlier scope is retained/i);
});

test('an evaluation-only project still plans real work once a change asks for it', async () => {
  const planner = new DeterministicPlanner();
  const plan = await planner.plan(
    { title: 'Redis move', goal: 'move the queue to Redis', evaluationOnly: true },
    { change: 'go ahead and build the migration script' },
  );
  assert.ok(plan.tasks.some((x) => x.kind === 'implement'), 'an explicit go-ahead overrides evaluate-only');
});
