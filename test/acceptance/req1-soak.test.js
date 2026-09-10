import test from 'node:test';
import assert from 'node:assert/strict';
import { makeApp, recordEvents, AutoClock } from '../helpers/harness.js';

/**
 * A bounded, deterministic soak over the autonomous loop.
 *
 * Single scenarios prove a path; this proves there is no path that leaves a
 * project stuck. Every project must reach a terminal state, every terminal
 * state must be justified, and the loop guard must never trip.
 */

/** Deterministic PRNG so a failure is always reproducible from the seed. */
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

const GOALS = [
  'a search box and a results list',
  'login, logout and a password reset',
  'a settings screen',
  'an importer, an exporter and a scheduler',
  'a dashboard with charts, filters, alerts and a share link',
];

/** Failures a competent agent is expected to get through on its own. */
const RECOVERABLE = [
  null,
  null,
  { throw: { message: 'socket hang up', code: 'ECONNRESET' } },
  { throw: { message: 'rate limit exceeded', status: 429 } },
  { ok: false, reason: 'a check did not pass' },
  { needsAnswer: { text: 'Which shape should this take?', recommendedDefault: 'the simple one', options: ['simple', 'full'], impact: 'low' } },
];

test('req1.12 soak: 30 varied projects all reach a justified terminal state', async (t) => {
  const random = rng(20260910);
  const clock = new AutoClock();

  // Every project draws recoverable trouble; a fifth of them also hit a
  // genuine credential wall, which must block rather than be retried away.
  const doomed = new Set();
  const seen = new Map();
  const executor = async (task, ctx) => {
    const n = (seen.get(task.id) ?? 0) + 1;
    seen.set(task.id, n);

    if (doomed.has(ctx.project.id) && task.kind === 'implement') {
      throw Object.assign(new Error('token expired for the build target'), { status: 401 });
    }
    // Repairs and retries succeed: that is what makes a failure recoverable.
    if (task.kind === 'repair' || n > 1) return { output: `${task.kind} ok` };

    const pick = RECOVERABLE[Math.floor(random() * RECOVERABLE.length)];
    if (!pick) return { output: `${task.kind} ok` };
    if (pick.throw) throw Object.assign(new Error(pick.throw.message), pick.throw);
    if (pick.needsAnswer) return { needsAnswer: pick.needsAnswer };
    return { ok: false, reason: pick.reason };
  };

  const app = makeApp({ clock, executor });
  t.after(() => app.cleanup());
  const events = recordEvents(app.bus);

  for (let i = 0; i < 30; i++) {
    const goal = GOALS[i % GOALS.length];
    const out = await app.dispatcher.handle({ conversationId: `soak-${i}`, text: `build ${goal}` });
    if (i % 5 === 0) doomed.add(out.projectId);
    await app.orchestrator.run(out.projectId);

    // Answer anything genuinely material, the way Blake would.
    for (const q of app.questions.open(out.projectId)) app.questions.answer(q.id, q.recommendedDefault ?? 'yes');
    await app.orchestrator.run(out.projectId);
    await app.orchestrator.run(out.projectId);
  }

  const projects = app.store.all('projects');
  assert.equal(projects.length, 30, 'one project per request — no duplicates, none lost');

  const stuck = projects.filter((p) => !['delivered', 'evaluated', 'blocked'].includes(p.status));
  assert.deepEqual(
    stuck.map((p) => `${p.title}: ${p.status}/${p.phase}`),
    [],
    'no project was left mid-flight',
  );

  // Every block must name what is needed — never a bare "it failed".
  for (const p of projects.filter((x) => x.status === 'blocked')) {
    assert.ok(p.blockedReason, `${p.title} blocked with no reason`);
    assert.match(p.blockedReason, /credential|permission|token|repair rounds|depend/i, `unhelpful blocker: ${p.blockedReason}`);
  }

  const delivered = projects.filter((p) => p.status === 'delivered');
  const blocked = projects.filter((p) => p.status === 'blocked');
  assert.equal(delivered.length, 24, `every project without a credential wall delivered unattended (${delivered.length}/24)`);
  assert.equal(blocked.length, 6, 'exactly the projects that hit a credential wall blocked');
  for (const p of blocked) assert.match(p.blockedReason, /credential|token expired/i);

  // Every delivered project has exactly one deliverable and passing checks.
  for (const p of delivered) {
    const deliverables = app.store.find('deliverables', (d) => d.projectId === p.id);
    assert.equal(deliverables.length, 1, `${p.title} should have exactly one deliverable`);
    const checks = app.store.find('tasks', (x) => x.projectId === p.id && (x.kind === 'verify' || x.kind === 'review'));
    assert.ok(checks.some((x) => x.status === 'done'), `${p.title} was delivered without a passing check`);
    assert.ok(!checks.some((x) => x.status === 'failed'), `${p.title} was delivered with a failing check`);
  }

  // Repair rounds stayed bounded everywhere.
  for (const p of projects) assert.ok((p.repairRounds ?? 0) <= 4, `${p.title} ran ${p.repairRounds} repair rounds`);

  // No question was ever asked twice for the same project.
  const asked = events.ofType('question.asked').map((e) => `${e.payload.projectId}|${e.payload.question?.text ?? e.payload.text}`);
  assert.equal(new Set(asked).size, asked.length, 'a question was asked twice');
});
