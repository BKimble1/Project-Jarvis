import { describe, expect, it } from 'vitest';

import {
  PRIORITY_BANDS,
  dedupe,
  novel,
  opportunitiesFromAssessment,
  opportunityKey,
  prioritise,
  rank,
  selectWork,
  type ObservationState,
  type Opportunity,
  type PriorityContext,
} from '@/domain/opportunity';
import type { ProjectAssessment } from '@/domain/status';

/**
 * What Jarvis decides to do next, and why.
 *
 * The failure mode of an autonomous operator is not that it does the wrong thing loudly. It is
 * that it invents work to stay busy, ranks it by arithmetic nobody can check, and treats a silent
 * system as a healthy one. Most of what follows is an attempt to produce exactly those three.
 */

const NOW = new Date('2026-06-15T12:00:00.000Z');
const PROJECT = 'project-1';

function opportunity(overrides: Partial<Opportunity> = {}): Opportunity {
  return {
    key: 'key-1',
    projectId: PROJECT,
    source: 'attention',
    rule: 'R-A1',
    title: 'The release workflow is failing',
    detail: 'The release workflow has failed three times.',
    severity: 'high',
    provenance: 'verified',
    evidenceIds: ['evidence-1'],
    capabilities: ['bug.diagnose'],
    requiresOwner: false,
    observedAt: NOW.toISOString(),
    ...overrides,
  };
}

function context(overrides: Partial<PriorityContext> = {}): PriorityContext {
  return {
    chartedProjectIds: new Set([PROJECT]),
    goalProjectIds: new Set<string>(),
    coverage: 'observed',
    now: NOW,
    ...overrides,
  };
}

function assessment(overrides: Partial<ProjectAssessment> = {}): ProjectAssessment {
  return {
    projectId: PROJECT,
    generatedAt: NOW.toISOString(),
    status: 'active',
    statusProvenance: 'verified',
    phase: null,
    phaseProvenance: 'unknown',
    headline: { text: 'Building', provenance: 'verified', evidenceIds: [] },
    recentlyCompleted: [],
    currentWork: [],
    activeBlockers: [],
    decisionsNeeded: [],
    recommendedActions: [],
    attention: [],
    needsAttention: false,
    freshness: {
      state: 'live',
      observedAt: NOW.toISOString(),
      ageHours: 1,
      explanation: 'Synced an hour ago.',
      lastError: null,
    },
    unknowns: [],
    keyEvidenceIds: [],
    evidenceFingerprint: 'fingerprint',
    ...overrides,
  };
}

describe('identity', () => {
  /*
   * Two ticks an hour apart looking at the same failing workflow must produce one opportunity. If
   * the key moved with time or wording, the backlog would fill with copies of the same problem and
   * the operator would work it repeatedly.
   */
  it('is about the situation, not about when it was noticed', () => {
    const first = opportunityKey({ projectId: PROJECT, rule: 'R-A1', subject: 'evidence-1' });
    const second = opportunityKey({ projectId: PROJECT, rule: 'R-A1', subject: 'evidence-1' });
    expect(first).toBe(second);
  });

  it('separates the same rule on different projects and different rules on one', () => {
    const base = { projectId: PROJECT, rule: 'R-A1', subject: 'evidence-1' };
    expect(opportunityKey({ ...base, projectId: 'project-2' })).not.toBe(opportunityKey(base));
    expect(opportunityKey({ ...base, rule: 'R-A2' })).not.toBe(opportunityKey(base));
    expect(opportunityKey({ ...base, subject: 'evidence-2' })).not.toBe(opportunityKey(base));
  });

  /* Length-prefixed, so a boundary cannot be moved between two parts to forge a collision. */
  it('cannot be made to collide by moving a boundary', () => {
    expect(opportunityKey({ projectId: 'ab', rule: 'c', subject: 'd' })).not.toBe(
      opportunityKey({ projectId: 'a', rule: 'bc', subject: 'd' }),
    );
  });

  it('keeps the first of a duplicate pair and drops the rest', () => {
    const kept = dedupe([
      opportunity({ key: 'a', title: 'first' }),
      opportunity({ key: 'a', title: 'second' }),
      opportunity({ key: 'b' }),
    ]);
    expect(kept.map((entry) => entry.key)).toEqual(['a', 'b']);
    expect(kept[0]?.title).toBe('first');
  });

  it('treats anything already in the backlog as not novel, whatever its state', () => {
    const candidates = [opportunity({ key: 'a' }), opportunity({ key: 'b' })];
    expect(novel(candidates, new Set(['a'])).map((entry) => entry.key)).toEqual(['b']);
  });
});

describe('derivation', () => {
  it('produces nothing at all from a project with nothing wrong', () => {
    expect(opportunitiesFromAssessment(assessment(), NOW)).toEqual([]);
  });

  it('carries the rule and the evidence through from the status engine', () => {
    const derived = opportunitiesFromAssessment(
      assessment({
        attention: [
          {
            code: 'failed_workflow',
            severity: 'critical',
            summary: 'The release workflow is failing',
            provenance: 'verified',
            evidenceIds: ['run-9'],
            rule: 'R-AT3',
          },
        ],
      }),
      NOW,
    );

    expect(derived).toHaveLength(1);
    expect(derived[0]?.rule).toBe('R-AT3');
    expect(derived[0]?.evidenceIds).toEqual(['run-9']);
    expect(derived[0]?.severity).toBe('critical');
    expect(derived[0]?.capabilities).toContain('checks.repair');
  });

  /*
   * The safe direction to be wrong in. A rule nobody has classified yet produces something that
   * can be looked at and nothing more, rather than silently inheriting the ability to write.
   */
  it('gives an unrecognised rule no capabilities at all', () => {
    const derived = opportunitiesFromAssessment(
      assessment({
        recommendedActions: [
          {
            action: 'Do the new thing',
            rationale: 'A rule added after this file was written.',
            provenance: 'verified',
            evidenceIds: [],
            requiresOwner: false,
            rule: 'R-BRAND-NEW',
          },
        ],
      }),
      NOW,
    );
    expect(derived[0]?.capabilities).toEqual([]);
  });

  it('keeps a decision the owner must make, and marks it as theirs', () => {
    const derived = opportunitiesFromAssessment(
      assessment({
        attention: [
          {
            code: 'decision_required',
            severity: 'critical',
            summary: 'Pick a payment provider',
            provenance: 'manual',
            evidenceIds: [],
            rule: 'R-AT1',
          },
        ],
      }),
      NOW,
    );
    expect(derived).toHaveLength(1);
    expect(derived[0]?.requiresOwner).toBe(true);
  });
});

describe('priority', () => {
  it('shows its working, and the points add up to the score', () => {
    const priority = prioritise(opportunity(), context());
    expect(priority.factors.length).toBeGreaterThan(1);
    expect(priority.factors.reduce((total, factor) => total + factor.points, 0)).toBe(
      priority.score,
    );
    for (const factor of priority.factors) {
      expect(factor.why.length).toBeGreaterThan(10);
    }
  });

  it('ranks a critical verified problem in a goal project first', () => {
    const priority = prioritise(
      opportunity({ severity: 'critical' }),
      context({ goalProjectIds: new Set([PROJECT]) }),
    );
    expect(priority.band).toBe('now');
  });

  /*
   * The three overrides. Each describes a case where acting would be wrong however urgent the
   * arithmetic makes the thing look, so each is asserted against a *critical* opportunity — the
   * one most likely to slip past a score threshold.
   */
  it('never acts on something only the owner can settle', () => {
    const priority = prioritise(
      opportunity({ severity: 'critical', requiresOwner: true }),
      context({ goalProjectIds: new Set([PROJECT]) }),
    );
    expect(priority.band).toBe('watch');
    expect(priority.factors.some((factor) => factor.name === 'needs you')).toBe(true);
  });

  it('never acts on a project it cannot currently see', () => {
    for (const coverage of ['stale', 'failed', 'unwatched'] as ObservationState[]) {
      const priority = prioritise(
        opportunity({ severity: 'critical' }),
        context({ coverage, goalProjectIds: new Set([PROJECT]) }),
      );
      expect(priority.band, coverage).toBe('watch');
    }
  });

  it('never acts on a project the charter does not cover', () => {
    const priority = prioritise(
      opportunity({ severity: 'critical' }),
      context({ chartedProjectIds: new Set(['somewhere-else']) }),
    );
    expect(priority.band).toBe('watch');
    expect(priority.factors.some((factor) => factor.name === 'outside the charter')).toBe(true);
  });

  it('trusts what it read over what it inferred', () => {
    const verified = prioritise(opportunity({ provenance: 'verified' }), context());
    const inferred = prioritise(opportunity({ provenance: 'inferred' }), context());
    const unknown = prioritise(opportunity({ provenance: 'unknown' }), context());
    expect(verified.score).toBeGreaterThan(inferred.score);
    expect(inferred.score).toBeGreaterThan(unknown.score);
  });
});

describe('the queue', () => {
  /*
   * Two ticks over the same unchanged backlog must produce the same order. A queue that reshuffles
   * itself makes "why did it do that one first?" unanswerable, which is the whole thing this
   * module is for.
   */
  it('is stable across ticks over an unchanged backlog', () => {
    const backlog = [
      opportunity({ key: 'c', severity: 'medium' }),
      opportunity({ key: 'a', severity: 'medium' }),
      opportunity({ key: 'b', severity: 'medium' }),
    ];
    const first = rank(backlog, () => context()).map((entry) => entry.opportunity.key);
    const second = rank([...backlog].reverse(), () => context()).map(
      (entry) => entry.opportunity.key,
    );
    expect(first).toEqual(second);
  });

  it('orders by band before score', () => {
    const ranked = rank(
      [
        opportunity({ key: 'watched', severity: 'critical', requiresOwner: true }),
        opportunity({ key: 'workable', severity: 'low' }),
      ],
      () => context(),
    );
    expect(ranked[0]?.opportunity.key).toBe('workable');
    expect(ranked[1]?.priority.band).toBe('watch');
  });

  it('never selects a watched opportunity, however much room there is', () => {
    const ranked = rank(
      [opportunity({ key: 'watched', severity: 'critical', requiresOwner: true })],
      () => context(),
    );
    expect(selectWork(ranked, 100)).toEqual([]);
  });

  it('selects nothing when there is no room', () => {
    const ranked = rank([opportunity()], () => context());
    expect(selectWork(ranked, 0)).toEqual([]);
    expect(selectWork(ranked, -1)).toEqual([]);
  });

  it('respects the room it is given', () => {
    const ranked = rank(
      [opportunity({ key: 'a' }), opportunity({ key: 'b' }), opportunity({ key: 'c' })],
      () => context(),
    );
    expect(selectWork(ranked, 2)).toHaveLength(2);
  });

  it('orders the bands from most to least urgent', () => {
    expect([...PRIORITY_BANDS]).toEqual(['now', 'next', 'later', 'watch']);
  });
});
