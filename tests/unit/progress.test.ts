import { describe, expect, it } from 'vitest';

import {
  EXPLORATION_LIMITS,
  NO_PROGRESS_SIGNALS,
  SUPERVISOR_ACTIONS,
  boundsFromCharter,
  detectNoProgress,
  preservable,
  superviseMission,
  type ExplorationBounds,
  type ProgressSnapshot,
} from '@/domain/progress';
import { charterContentSchema } from '@/domain/charter';

/**
 * Knowing when to stop.
 *
 * The expensive failure is not doing the wrong thing. It is doing something almost right forty
 * times — re-running a failing test with a slightly different fix, spending an afternoon and a lot
 * of money, and reporting steady activity the whole way. These tests build exactly that mission
 * and check that it gets stopped, that the reason is a sentence, and that what it produced is kept.
 */

const BOUNDS = boundsFromCharter(
  charterContentSchema.parse({
    goals: [],
    projectIds: [],
    grants: [],
    limits: {},
    communication: {},
  }).limits,
);

function snapshot(overrides: Partial<ProgressSnapshot> = {}): ProgressSnapshot {
  return {
    attemptsUsed: 1,
    repairRoundsUsed: 0,
    elapsedMinutes: 5,
    minutesSinceStateChange: 1,
    outputTokens: 4_000,
    spendUsd: 0.2,
    turnsSinceFileChanged: 1,
    changedFileCount: 3,
    diffHashes: ['a', 'b', 'c'],
    errorSignatures: [],
    questions: [],
    findingsBeforeRepair: [],
    findingsAfterRepair: [],
    producedSomething: true,
    failureImprovedSinceWidening: null,
    ...overrides,
  };
}

describe('the bounds', () => {
  it('takes what the owner chose from the charter and fixes the rest', () => {
    const bounds = boundsFromCharter(
      charterContentSchema.parse({
        goals: [],
        projectIds: [],
        grants: [],
        limits: { maxAttempts: 4, maxMissionMinutes: 120, dailySpendUsd: 25 },
        communication: {},
      }).limits,
    );
    expect(bounds.attempts).toBe(4);
    expect(bounds.missionMinutes).toBe(120);
    expect(bounds.missionSpendUsd).toBe(25);
    /* Not the owner's to choose: an owner should not have to reason about agent turns. */
    expect(bounds.agentTurns).toBeGreaterThan(0);
    expect(bounds.repeatedErrors).toBeGreaterThan(0);
  });

  it('names a meaning for every limit and every signal', () => {
    expect(EXPLORATION_LIMITS.length).toBe(11);
    expect(NO_PROGRESS_SIGNALS.length).toBe(10);
  });
});

describe('detecting a stall', () => {
  it('says nothing is wrong with a mission that is working', () => {
    const verdict = detectNoProgress(snapshot(), BOUNDS);
    expect(verdict.stalled).toBe(false);
    expect(verdict.findings).toEqual([]);
    expect(verdict.limitsReached).toEqual([]);
  });

  it('catches the same error coming back', () => {
    const verdict = detectNoProgress(
      snapshot({
        errorSignatures: [
          'TS2345 in importer.ts',
          'TS2345 in importer.ts',
          'TS2345 in importer.ts',
        ],
      }),
      BOUNDS,
    );
    expect(verdict.findings.map((finding) => finding.signal)).toContain('repeated_error');
    expect(verdict.findings[0]?.detail).toContain('3 times');
  });

  it('catches a diff that has gone back to where it was', () => {
    const verdict = detectNoProgress(snapshot({ diffHashes: ['a', 'b', 'a'] }), BOUNDS);
    expect(verdict.findings.map((finding) => finding.signal)).toContain('oscillating_diff');
  });

  it('catches a repair round that changed nothing', () => {
    const verdict = detectNoProgress(
      snapshot({ findingsBeforeRepair: ['f1', 'f2'], findingsAfterRepair: ['f2', 'f1'] }),
      BOUNDS,
    );
    expect(verdict.findings.map((finding) => finding.signal)).toContain('repair_ineffective');
  });

  it('catches a lot of writing that produced nothing', () => {
    const verdict = detectNoProgress(
      snapshot({ outputTokens: 90_000, producedSomething: false }),
      BOUNDS,
    );
    expect(verdict.findings.map((finding) => finding.signal)).toContain('output_without_result');
  });

  it('catches a scope that grows while the failure does not move', () => {
    const verdict = detectNoProgress(snapshot({ failureImprovedSinceWidening: false }), BOUNDS);
    expect(verdict.findings.map((finding) => finding.signal)).toContain(
      'widening_without_improving',
    );
  });

  /*
   * Reported together rather than one at a time. "The same error three times and the diff has
   * stopped changing" is a different sentence from either half, and stopping at the first would
   * report whichever happened to be checked earliest.
   */
  it('reports every signal it finds, not the first', () => {
    const verdict = detectNoProgress(
      snapshot({
        errorSignatures: ['same', 'same', 'same'],
        diffHashes: ['a', 'a'],
        minutesSinceStateChange: 45,
      }),
      BOUNDS,
    );
    expect(verdict.findings.length).toBeGreaterThanOrEqual(3);
  });

  it('separates a limit that has been reached from a softer stall signal', () => {
    const verdict = detectNoProgress(snapshot({ elapsedMinutes: 10_000 }), BOUNDS);
    expect(verdict.limitsReached).toContain('missionMinutes');
    expect(verdict.stalled).toBe(true);
  });

  it('does not count spend against a charter that set no money limit', () => {
    const bounds: ExplorationBounds = { ...BOUNDS, missionSpendUsd: null };
    const verdict = detectNoProgress(snapshot({ spendUsd: 9_999 }), bounds);
    expect(verdict.limitsReached).not.toContain('missionSpendUsd');
  });
});

describe('the supervisor', () => {
  it('leaves a working mission alone', () => {
    const verdict = superviseMission({
      snapshot: snapshot(),
      bounds: BOUNDS,
      alreadyNarrowed: false,
      ownerCouldUnblock: false,
    });
    expect(verdict.action).toBe('continue');
  });

  it('narrows once, then stops', () => {
    const stalling = snapshot({
      errorSignatures: ['same', 'same', 'same'],
      diffHashes: ['a', 'a'],
    });
    const first = superviseMission({
      snapshot: stalling,
      bounds: { ...BOUNDS, repeatedErrors: 99 },
      alreadyNarrowed: false,
      ownerCouldUnblock: false,
    });
    expect(first.action).toBe('narrow');

    const second = superviseMission({
      snapshot: stalling,
      bounds: { ...BOUNDS, repeatedErrors: 99 },
      alreadyNarrowed: true,
      ownerCouldUnblock: false,
    });
    expect(second.action).toBe('stop');
  });

  it('asks the owner when a person could plausibly unblock it', () => {
    const verdict = superviseMission({
      snapshot: snapshot({ diffHashes: ['a', 'a'] }),
      bounds: BOUNDS,
      alreadyNarrowed: false,
      ownerCouldUnblock: true,
    });
    expect(verdict.action).toBe('escalate');
  });

  it('asks the owner when the agent keeps asking the same question', () => {
    const verdict = superviseMission({
      snapshot: snapshot({ questions: ['which database?', 'which database?'] }),
      bounds: BOUNDS,
      alreadyNarrowed: false,
      ownerCouldUnblock: false,
    });
    expect(verdict.action).toBe('escalate');
  });

  it('stops outright on a limit, whatever else is true', () => {
    const verdict = superviseMission({
      snapshot: snapshot({ attemptsUsed: 99 }),
      bounds: BOUNDS,
      alreadyNarrowed: false,
      ownerCouldUnblock: true,
    });
    expect(verdict.action).toBe('stop');
    expect(verdict.reason).toContain('the limit was reached');
    expect(verdict.reason).toContain('attempts');
  });

  /*
   * The one that matters most. A mission stopped for going nowhere still produced a branch, a
   * diagnosis and a list of things that did not work, and the next attempt should not have to pay
   * for the same lesson twice.
   */
  it('always says what to keep, even from a mission that produced nothing', () => {
    const empty = superviseMission({
      snapshot: snapshot({
        attemptsUsed: 99,
        changedFileCount: 0,
        producedSomething: false,
        errorSignatures: [],
        questions: [],
      }),
      bounds: BOUNDS,
      alreadyNarrowed: true,
      ownerCouldUnblock: false,
    });
    expect(empty.preserve.length).toBeGreaterThan(0);
    expect(empty.preserve[0]).toContain('what it tried');

    const rich = preservable(
      snapshot({ changedFileCount: 4, errorSignatures: ['a', 'b', 'a'], questions: ['why?'] }),
    );
    expect(rich.join(' ')).toContain('4 changed file');
    expect(rich.join(' ')).toContain('2 distinct failure');
  });

  /*
   * The tempting fix for "the builder is stuck" is another reviewer, then a researcher to explain
   * the reviewer. That turns a stalled mission into an expensive stalled mission, so there is no
   * outcome here that adds an agent at all.
   */
  it('has no way out that spawns another agent', () => {
    expect([...SUPERVISOR_ACTIONS]).toEqual(['continue', 'narrow', 'escalate', 'stop']);
  });

  it('gives a reason made of the findings rather than a summary of them', () => {
    const verdict = superviseMission({
      snapshot: snapshot({ errorSignatures: ['boom', 'boom', 'boom'] }),
      bounds: BOUNDS,
      alreadyNarrowed: true,
      ownerCouldUnblock: false,
    });
    expect(verdict.reason).toContain('boom');
  });
});
