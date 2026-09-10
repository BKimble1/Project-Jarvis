import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PHASES, TERMINAL_STATUSES, NON_RUNNABLE_STATUSES,
  nextPhase, isTerminal, canRun, isFinalPhase,
} from '../../src/orchestrator/lifecycle.js';

test('PHASES is the contract order', () => {
  assert.deepEqual([...PHASES], ['planning', 'implementing', 'verifying', 'reviewing', 'repairing', 'delivering']);
});

test('nextPhase covers every forward edge of the happy path', () => {
  assert.equal(nextPhase('planning', { repairsNeeded: false }), 'implementing');
  assert.equal(nextPhase('implementing', { repairsNeeded: false }), 'verifying');
  assert.equal(nextPhase('verifying', { repairsNeeded: false }), 'reviewing');
  assert.equal(nextPhase('reviewing', { repairsNeeded: false }), 'delivering');
  assert.equal(nextPhase('delivering', { repairsNeeded: false }), 'done');
});

test('repairsNeeded only branches at reviewing', () => {
  assert.equal(nextPhase('reviewing', { repairsNeeded: true }), 'repairing');
  assert.equal(nextPhase('repairing', { repairsNeeded: true }), 'verifying');
  assert.equal(nextPhase('repairing', { repairsNeeded: false }), 'verifying');
  assert.equal(nextPhase('planning', { repairsNeeded: true }), 'implementing');
  assert.equal(nextPhase('implementing', { repairsNeeded: true }), 'verifying');
  assert.equal(nextPhase('verifying', { repairsNeeded: true }), 'reviewing');
  assert.equal(nextPhase('delivering', { repairsNeeded: true }), 'done');
});

test('nextPhase defaults repairsNeeded to false', () => {
  assert.equal(nextPhase('reviewing'), 'delivering');
  assert.equal(nextPhase('reviewing', {}), 'delivering');
});

test('idle and unset phases enter at planning; done is absorbing', () => {
  assert.equal(nextPhase('idle'), 'planning');
  assert.equal(nextPhase(null), 'planning');
  assert.equal(nextPhase(undefined), 'planning');
  assert.equal(nextPhase(''), 'planning');
  assert.equal(nextPhase('done'), 'done');
  assert.equal(isFinalPhase('done'), true);
  assert.equal(isFinalPhase('delivering'), false);
});

test('nextPhase refuses an unknown phase', () => {
  assert.throws(() => nextPhase('shipping'), TypeError);
  assert.throws(() => nextPhase(7), TypeError);
});

test('the repair loop runs verify/review again and then delivers', () => {
  // Two rounds of repair, then a clean review.
  let repairsLeft = 2;
  let phase = 'planning';
  const seen = [phase];
  for (let i = 0; i < 20 && phase !== 'done'; i += 1) {
    const repairsNeeded = phase === 'reviewing' && repairsLeft > 0;
    if (repairsNeeded) repairsLeft -= 1;
    phase = nextPhase(phase, { repairsNeeded });
    seen.push(phase);
  }
  assert.deepEqual(seen, [
    'planning', 'implementing', 'verifying', 'reviewing',
    'repairing', 'verifying', 'reviewing',
    'repairing', 'verifying', 'reviewing',
    'delivering', 'done',
  ]);
  assert.equal(repairsLeft, 0);
});

test('a build with no repairs walks straight through to done', () => {
  let phase = 'planning';
  const seen = [phase];
  for (let i = 0; i < 10 && phase !== 'done'; i += 1) {
    phase = nextPhase(phase, { repairsNeeded: false });
    seen.push(phase);
  }
  assert.deepEqual(seen, ['planning', 'implementing', 'verifying', 'reviewing', 'delivering', 'done']);
});

test('isTerminal marks only the statuses a project never leaves', () => {
  assert.deepEqual([...TERMINAL_STATUSES], ['delivered', 'evaluated', 'stopped']);
  assert.equal(isTerminal('delivered'), true);
  assert.equal(isTerminal('evaluated'), true);
  assert.equal(isTerminal('stopped'), true);
  assert.equal(isTerminal('active'), false);
  assert.equal(isTerminal('paused'), false);
  assert.equal(isTerminal('blocked'), false);
  assert.equal(isTerminal(undefined), false);
});

test('canRun is false for paused, stopped, blocked, delivered and evaluated', () => {
  assert.deepEqual([...NON_RUNNABLE_STATUSES], ['paused', 'stopped', 'blocked', 'delivered', 'evaluated']);
  for (const status of NON_RUNNABLE_STATUSES) {
    assert.equal(canRun({ id: 'p1', status }), false, `${status} must not run`);
  }
  assert.equal(canRun({ id: 'p1', status: 'active' }), true);
});

test('canRun is false for a missing project', () => {
  assert.equal(canRun(null), false);
  assert.equal(canRun(undefined), false);
  assert.equal(canRun('p1'), false);
});
