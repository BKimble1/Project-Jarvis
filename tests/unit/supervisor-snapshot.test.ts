import { describe, expect, it } from 'vitest';

import { boundsFromCharter, superviseMission } from '@/domain/progress';
import { DORMANT_SUPERVISOR_SIGNALS, snapshotFromMission } from '@/server/operator/supervisor';
import type { CharterLimits } from '@/domain/charter';
import type { Mission } from '@/domain/mission';
import type { MissionRun } from '@/domain/mission-run';

/**
 * What the supervisor can honestly see.
 *
 * The interesting failures here are not arithmetic. They are a snapshot that fabricates a field it
 * cannot know — a diff hash, a turn count — which makes a stall signal fire at random and turns
 * the supervisor into a coin toss that occasionally ends somebody's afternoon's work.
 */

const NOW = new Date('2026-04-01T12:00:00.000Z');

function mission(overrides: Partial<Mission> = {}): Mission {
  return {
    id: 'mission-1',
    title: 'Improve the readme',
    state: 'running',
    attemptCount: 1,
    repairRoundsUsed: 0,
    startedAt: new Date(NOW.getTime() - 5 * 60_000).toISOString(),
    lastActivityAt: new Date(NOW.getTime() - 60_000).toISOString(),
    workingBranch: null,
    currentPlanVersion: 1,
    activeRunId: 'run-1',
    ...overrides,
  } as unknown as Mission;
}

function run(overrides: Partial<MissionRun> = {}): MissionRun {
  return {
    id: 'run-1',
    usage: {
      inputTokens: 10,
      outputTokens: 1000,
      cacheReadTokens: null,
      totalCostUsd: null,
      turns: 3,
      durationMs: 1000,
    },
    ...overrides,
  } as unknown as MissionRun;
}

const LIMITS: CharterLimits = {
  dailySpendUsd: 20,
  weeklySpendUsd: 80,
  maxMissionMinutes: 90,
  maxAttempts: 2,
  maxRepairRounds: 2,
  maxParallelAgents: 2,
  reserveFiveHourPercent: 25,
  reserveSevenDayPercent: 20,
};
const BOUNDS = boundsFromCharter(LIMITS);

describe('the progress snapshot the control plane can build', () => {
  it('leaves the signals it cannot compute silent rather than approximate', () => {
    /*
     * The point of the whole file. Three stall signals need a per-turn record of the working tree
     * that nobody keeps; a plausible-looking guess would make `oscillating_diff` fire on missions
     * that are working perfectly well.
     */
    const snapshot = snapshotFromMission({
      mission: mission(),
      run: run(),
      openQuestions: [],
      now: NOW,
    });

    expect(snapshot.diffHashes).toEqual([]);
    expect(snapshot.turnsSinceFileChanged).toBe(0);
    expect(snapshot.failureImprovedSinceWidening).toBeNull();
    expect(DORMANT_SUPERVISOR_SIGNALS).toContain('oscillating_diff');

    /* And with them silent, a healthy mission is left alone. */
    const verdict = superviseMission({
      snapshot,
      bounds: BOUNDS,
      alreadyNarrowed: false,
      ownerCouldUnblock: false,
    });
    expect(verdict.action).toBe('continue');
  });

  it('notices a mission that has stopped moving', () => {
    const stuck = snapshotFromMission({
      mission: mission({ lastActivityAt: new Date(NOW.getTime() - 40 * 60_000).toISOString() }),
      run: run(),
      openQuestions: [],
      now: NOW,
    });
    expect(stuck.minutesSinceStateChange).toBeCloseTo(40, 0);

    const verdict = superviseMission({
      snapshot: stuck,
      bounds: BOUNDS,
      alreadyNarrowed: false,
      ownerCouldUnblock: false,
    });
    expect(verdict.action).not.toBe('continue');
    expect(verdict.verdict.findings.map((finding) => finding.signal)).toContain('no_state_change');
  });

  it('notices a mission that has used every attempt it is allowed', () => {
    const exhausted = snapshotFromMission({
      mission: mission({ attemptCount: BOUNDS.attempts }),
      run: run(),
      openQuestions: [],
      now: NOW,
    });
    const verdict = superviseMission({
      snapshot: exhausted,
      bounds: BOUNDS,
      alreadyNarrowed: false,
      ownerCouldUnblock: false,
    });
    expect(verdict.action).toBe('stop');
    expect(verdict.verdict.limitsReached).toContain('attempts');
    /* And it keeps what the mission produced. A stopped mission is not a discarded one. */
    expect(verdict.preserve.length).toBeGreaterThan(0);
  });

  it('escalates rather than stopping when a person could unblock it', () => {
    /*
     * Getting this wrong in the pessimistic direction ends missions a person could have rescued
     * with one sentence — which is why an open question is read as evidence that they could.
     */
    const stuck = snapshotFromMission({
      mission: mission({ lastActivityAt: new Date(NOW.getTime() - 40 * 60_000).toISOString() }),
      run: run(),
      openQuestions: ['Which database should I use?'],
      now: NOW,
    });
    const verdict = superviseMission({
      snapshot: stuck,
      bounds: BOUNDS,
      alreadyNarrowed: false,
      ownerCouldUnblock: true,
    });
    expect(verdict.action).toBe('escalate');
  });

  it('reports no spend for a subscription mission rather than zero', () => {
    /*
     * Null, not 0. The spend limit is about money; a subscription mission spends none, and zero
     * would happen to be right here for the wrong reason — a reason that stops holding the moment
     * the same code sees an API worker.
     */
    const snapshot = snapshotFromMission({
      mission: mission(),
      run: run(),
      openQuestions: [],
      now: NOW,
    });
    expect(snapshot.spendUsd).toBeNull();
  });
});
