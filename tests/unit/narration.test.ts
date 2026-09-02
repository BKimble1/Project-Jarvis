import { describe, expect, it } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import { claim } from '@/domain/evidence';
import type { FreshnessState } from '@/domain/enums';
import type {
  AttentionReason,
  FocusEntry,
  FreshnessAssessment,
  PortfolioAssessment,
  PortfolioChange,
  PortfolioCounts,
  ProjectAssessment,
  RecommendedAction,
} from '@/domain/status';
import { AnthropicNarrator, stripFences } from '@/server/briefing/anthropic';
import {
  DeterministicNarrator,
  buildPortfolioNarrative,
  buildProjectNarrative,
} from '@/server/briefing/deterministic';
import { buildNarrationPayload } from '@/server/briefing/types';
import type { NarrationPayload, PortfolioNarrationPayload } from '@/server/briefing/types';
import {
  containsFabricatedProgress,
  validatePortfolioNarrative,
  validateProjectNarrative,
} from '@/server/briefing/validate';
import type { ValidationResult } from '@/server/briefing/validate';
import { createLogger } from '@/server/logging/logger';
import { NOW, hoursBefore, makeEvidence, makeProject } from '../helpers/factories';

/* ------------------------------------------------------------------ fixtures */

const SILENT_LOGGER = createLogger({ level: 'error', sink: () => undefined });

const freshnessOf = (
  state: FreshnessState,
  ageHours: number | null,
  lastError: string | null = null,
): FreshnessAssessment => ({
  state,
  observedAt: ageHours === null ? null : hoursBefore(ageHours),
  ageHours,
  explanation: `Evidence freshness is ${state}.`,
  lastError,
});

const recommend = (action: string, rule = 'R-RC1-open-next-action'): RecommendedAction => ({
  action,
  rationale: 'The deterministic engine recommended this.',
  provenance: 'inferred',
  evidenceIds: [],
  requiresOwner: true,
  rule,
});

const decisionReason = (summary: string): AttentionReason => ({
  code: 'decision_required',
  severity: 'high',
  summary,
  provenance: 'manual',
  evidenceIds: ['ev-3'],
  rule: 'R-A1-decision-required',
});

const focus = (projectName: string, reason: string, rank = 0): FocusEntry => ({
  projectId: projectName.toLowerCase(),
  projectName,
  reason,
  provenance: 'manual',
  rank,
});

const portfolioChange = (
  projectName: string,
  summary: string,
  evidenceIds: readonly string[],
): PortfolioChange => ({
  projectId: projectName.toLowerCase(),
  projectName,
  summary,
  occurredAt: hoursBefore(4),
  provenance: 'verified',
  evidenceIds,
});

function makeAssessment(overrides: Partial<ProjectAssessment> = {}): ProjectAssessment {
  return {
    projectId: 'project-under-test',
    generatedAt: NOW.toISOString(),
    status: 'active',
    statusProvenance: 'manual',
    phase: 'Build',
    phaseProvenance: 'manual',
    headline: claim('Two pull requests merged this week.', 'verified', ['ev-1']),
    recentlyCompleted: [],
    currentWork: [],
    activeBlockers: [],
    decisionsNeeded: [],
    recommendedActions: [],
    attention: [],
    needsAttention: false,
    freshness: freshnessOf('live', 3),
    unknowns: [],
    keyEvidenceIds: [],
    evidenceFingerprint: 'fingerprint-default',
    ...overrides,
  };
}

/** The evidence array is built from the supplied ids so citations are legitimate by default. */
function makePayload(
  assessment: ProjectAssessment,
  evidenceIds: readonly string[] = assessment.keyEvidenceIds,
): NarrationPayload {
  return {
    project: {
      name: 'Aurora',
      type: 'software',
      status: assessment.status,
      phase: assessment.phase,
      goal: 'Ship the first usable version.',
    },
    assessment,
    evidence: evidenceIds.map((id) => ({
      id,
      kind: 'git_commit',
      title: `Commit ${id}`,
      observedAt: hoursBefore(6),
      url: null,
    })),
  };
}

const NO_COUNTS: PortfolioCounts = {
  total: 0,
  active: 0,
  progressing: 0,
  needsAttention: 0,
  blocked: 0,
  waiting: 0,
  paused: 0,
  completed: 0,
  stale: 0,
  archived: 0,
  syncFailing: 0,
};

function makePortfolioAssessment(
  overrides: Partial<PortfolioAssessment> = {},
): PortfolioAssessment {
  return {
    generatedAt: NOW.toISOString(),
    counts: NO_COUNTS,
    progressingProjectIds: [],
    needsAttentionProjectIds: [],
    blockedProjectIds: [],
    waitingProjectIds: [],
    pausedProjectIds: [],
    staleProjectIds: [],
    recentChanges: [],
    decisionsNeeded: [],
    focusOrder: [],
    unknowns: [],
    ...overrides,
  };
}

function makePortfolioPayload(assessment: PortfolioAssessment): PortfolioNarrationPayload {
  return {
    assessment,
    projects: [
      {
        id: 'aurora',
        name: 'Aurora',
        status: 'active',
        headline: 'Two pull requests merged this week.',
        needsAttention: false,
        freshness: 'live',
      },
    ],
  };
}

/** An assessment that found completed work and work in progress, but no blockers or decisions. */
const baseAssessment = makeAssessment({
  recentlyCompleted: [claim('Merged #7 Evidence timeline', 'verified', ['ev-1'])],
  currentWork: [claim('Open PR #12 Status engine', 'verified', ['ev-2'])],
  recommendedActions: [recommend('Review PR #12')],
  keyEvidenceIds: ['ev-1', 'ev-2'],
});
const basePayload = makePayload(baseAssessment);

/** An assessment that found nothing at all — the hardest case for a narrator to respect. */
const emptyPayload = makePayload(makeAssessment({ keyEvidenceIds: ['ev-1', 'ev-2'] }));

const VALID_NARRATIVE = {
  currentState: 'Two pull requests merged this week.',
  recentlyCompleted: ['Merged #7 Evidence timeline'],
  inProgress: ['Open PR #12 Status engine'],
  blockers: [],
  decisionsNeeded: [],
  nextActions: ['Review PR #12'],
  unknowns: ['No issue tracker is connected.'],
  citedEvidenceIds: ['ev-1', 'ev-2'],
};

const portfolioAssessment = makePortfolioAssessment({
  counts: { ...NO_COUNTS, total: 4, active: 3, needsAttention: 1 },
  recentChanges: [portfolioChange('Aurora', 'Merged #7 Evidence timeline', ['ev-1'])],
  decisionsNeeded: [decisionReason('Decide on the hosting provider')],
  focusOrder: [focus('Aurora', 'A decision is waiting on you')],
});
const portfolioPayload = makePortfolioPayload(portfolioAssessment);

const VALID_PORTFOLIO_NARRATIVE = {
  headline: '3 active projects, 1 needing your attention.',
  importantChanges: ['Aurora: Merged #7 Evidence timeline'],
  decisionsNeeded: ['Decide on the hosting provider'],
  focusOrder: ['Aurora — A decision is waiting on you'],
  unknowns: [],
  citedEvidenceIds: ['ev-1'],
};

function accepted<T>(result: ValidationResult<T>): T {
  if (!result.ok) throw new Error(`Expected acceptance but was rejected: ${result.reason}`);
  return result.value;
}

function rejection<T>(result: ValidationResult<T>): string {
  if (result.ok) throw new Error('Expected the narrative to be rejected, but it was accepted.');
  return result.reason;
}

/* ------------------------------------------------------- deterministic narrator */

describe('DeterministicNarrator', () => {
  it('is always available and names itself as the deterministic method', async () => {
    const narrator = new DeterministicNarrator();
    expect(narrator.name).toBe('deterministic');
    expect(narrator.isAvailable()).toBe(true);

    const project = await narrator.narrateProject(basePayload);
    const portfolio = await narrator.narratePortfolio(portfolioPayload);
    expect(project.method).toBe('deterministic');
    expect(project.error).toBeNull();
    expect(portfolio.method).toBe('deterministic');
    expect(portfolio.error).toBeNull();
  });

  it('restates the assessment exactly, adding no fact of its own', async () => {
    const assessment = makeAssessment({
      headline: claim('Two pull requests merged this week.', 'verified', ['ev-1']),
      recentlyCompleted: [claim('Merged #7 Evidence timeline', 'verified', ['ev-1'])],
      currentWork: [claim('Open PR #12 Status engine', 'verified', ['ev-2'])],
      activeBlockers: [claim('Waiting on a provider decision', 'manual', ['ev-3'])],
      decisionsNeeded: [claim('Decide on the hosting provider', 'manual', ['ev-3'])],
      recommendedActions: [recommend('Review PR #12')],
      keyEvidenceIds: ['ev-1', 'ev-2', 'ev-3'],
    });

    const { narrative } = await new DeterministicNarrator().narrateProject(makePayload(assessment));

    expect(narrative.currentState).toBe('Two pull requests merged this week.');
    expect(narrative.recentlyCompleted).toEqual(['Merged #7 Evidence timeline']);
    expect(narrative.inProgress).toEqual(['Open PR #12 Status engine']);
    expect(narrative.blockers).toEqual(['Waiting on a provider decision']);
    expect(narrative.decisionsNeeded).toEqual(['Decide on the hosting provider']);
    expect(narrative.nextActions).toEqual(['Review PR #12']);
  });

  it('caps next actions at three however many the engine recommends', () => {
    const assessment = makeAssessment({
      recommendedActions: [
        recommend('Review PR #12'),
        recommend('Resolve the failing CI run'),
        recommend('Answer the hosting question'),
        recommend('Close the stale issue'),
        recommend('Schedule the release'),
      ],
    });

    expect(buildProjectNarrative(makePayload(assessment)).nextActions).toEqual([
      'Review PR #12',
      'Resolve the failing CI run',
      'Answer the hosting question',
    ]);
  });

  it.each([
    ['live', 3, 'Evidence observed 3 hours ago.'],
    ['recent', 30, 'Evidence observed 30 hours ago.'],
    ['stale', 24 * 10, 'The newest evidence is 10 days old.'],
    ['failing', 30, 'Synchronisation is currently failing; this is the last verified information.'],
    ['never', null, 'No evidence has been observed for this project yet.'],
  ] as const)('leads the unknowns with the %s freshness note', (state, ageHours, note) => {
    const assessment = makeAssessment({
      freshness: freshnessOf(state, ageHours),
      unknowns: ['No issue tracker is connected.'],
    });

    expect(buildProjectNarrative(makePayload(assessment)).unknowns).toEqual([
      note,
      'No issue tracker is connected.',
    ]);
  });

  it('cites only the key evidence, never the rest of the payload', () => {
    const assessment = makeAssessment({ keyEvidenceIds: ['ev-2', 'ev-4'] });
    const payload = makePayload(assessment, ['ev-1', 'ev-2', 'ev-3', 'ev-4', 'ev-5']);

    expect(buildProjectNarrative(payload).citedEvidenceIds).toEqual(['ev-2', 'ev-4']);
  });

  it('caps every narrated list at eight items', () => {
    const many = (prefix: string) =>
      Array.from({ length: 10 }, (_, index) => claim(`${prefix} ${index + 1}`, 'verified'));
    const assessment = makeAssessment({
      recentlyCompleted: many('Completed'),
      currentWork: many('In progress'),
      unknowns: Array.from({ length: 10 }, (_, index) => `Unknown ${index + 1}`),
    });

    const narrative = buildProjectNarrative(makePayload(assessment));

    expect(narrative.recentlyCompleted).toHaveLength(8);
    expect(narrative.recentlyCompleted.at(-1)).toBe('Completed 8');
    expect(narrative.inProgress).toHaveLength(8);
    /* The freshness note takes the first slot, so only seven assessment unknowns survive. */
    expect(narrative.unknowns).toHaveLength(8);
    expect(narrative.unknowns.at(-1)).toBe('Unknown 7');
  });

  it('produces a narrative that survives its own guard-rails', () => {
    const narrative = buildProjectNarrative(basePayload);
    expect(accepted(validateProjectNarrative(narrative, basePayload))).toEqual(narrative);
  });
});

describe('buildPortfolioNarrative', () => {
  it('invites the owner to add a project when the portfolio is empty', () => {
    const narrative = buildPortfolioNarrative(makePortfolioPayload(makePortfolioAssessment()));
    expect(narrative.headline).toBe('No projects yet. Add one to give Jarvis something to watch.');
  });

  it('summarises a mixed portfolio, omitting the categories that are empty', () => {
    const assessment = makePortfolioAssessment({
      counts: {
        ...NO_COUNTS,
        total: 8,
        active: 3,
        needsAttention: 2,
        blocked: 1,
        waiting: 1,
        paused: 1,
        stale: 2,
      },
    });

    expect(buildPortfolioNarrative(makePortfolioPayload(assessment)).headline).toBe(
      '3 active projects, 2 needing your attention, 1 blocked, 1 waiting, 1 paused, ' +
        '2 with stale data.',
    );
  });

  it('uses the singular and drops empty categories for a one-project portfolio', () => {
    const assessment = makePortfolioAssessment({
      counts: { ...NO_COUNTS, total: 1, active: 1, progressing: 1 },
    });

    expect(buildPortfolioNarrative(makePortfolioPayload(assessment)).headline).toBe(
      '1 active project.',
    );
  });

  it('formats changes, focus order and citations straight from the assessment', () => {
    const assessment = makePortfolioAssessment({
      counts: { ...NO_COUNTS, total: 2, active: 2 },
      recentChanges: [
        portfolioChange('Aurora', 'Merged #7 Evidence timeline', ['ev-1', 'ev-2']),
        portfolioChange('Iris', 'Released v1.0.0', ['ev-3']),
      ],
      decisionsNeeded: [decisionReason('Decide on the hosting provider')],
      focusOrder: [focus('Aurora', 'A decision is waiting on you')],
      unknowns: ['Two projects have no connected source.'],
    });

    const narrative = buildPortfolioNarrative(makePortfolioPayload(assessment));

    expect(narrative.importantChanges).toEqual([
      'Aurora: Merged #7 Evidence timeline',
      'Iris: Released v1.0.0',
    ]);
    expect(narrative.decisionsNeeded).toEqual(['Decide on the hosting provider']);
    expect(narrative.focusOrder).toEqual(['Aurora — A decision is waiting on you']);
    expect(narrative.citedEvidenceIds).toEqual(['ev-1', 'ev-2', 'ev-3']);
    expect(narrative.unknowns).toEqual(['Two projects have no connected source.']);
  });

  it('produces a narrative that survives its own guard-rails', () => {
    const narrative = buildPortfolioNarrative(portfolioPayload);
    expect(accepted(validatePortfolioNarrative(narrative, portfolioPayload))).toEqual(narrative);
  });
});

/* ------------------------------------------------------------------ guard-rails */

describe('validateProjectNarrative', () => {
  it('accepts a well-formed narrative that cites supplied evidence', () => {
    expect(validateProjectNarrative(VALID_NARRATIVE, basePayload)).toEqual({
      ok: true,
      value: VALID_NARRATIVE,
    });
  });

  it('rejects output that is not an object at all, naming the root', () => {
    expect(rejection(validateProjectNarrative(null, basePayload))).toBe(
      'Narrator output failed schema validation: root — Invalid input: expected object, received null',
    );
  });

  it('rejects output that breaks the schema, naming the offending field', () => {
    expect(
      rejection(validateProjectNarrative({ ...VALID_NARRATIVE, currentState: '' }, basePayload)),
    ).toMatch(/^Narrator output failed schema validation: currentState — /);
  });

  it('rejects a narrative citing an evidence id it was never given', () => {
    expect(
      rejection(
        validateProjectNarrative(
          { ...VALID_NARRATIVE, citedEvidenceIds: ['ev-1', 'ev-999'] },
          basePayload,
        ),
      ),
    ).toBe('Narrator cited evidence that was not supplied to it.');
  });

  it('rejects invented blockers', () => {
    expect(
      rejection(
        validateProjectNarrative(
          { ...VALID_NARRATIVE, blockers: ['Legal review has not started'] },
          basePayload,
        ),
      ),
    ).toBe('Narrator invented blockers that no evidence supports.');
  });

  it('rejects invented decisions', () => {
    expect(
      rejection(
        validateProjectNarrative(
          { ...VALID_NARRATIVE, decisionsNeeded: ['Choose a hosting provider'] },
          basePayload,
        ),
      ),
    ).toBe('Narrator invented decisions that no evidence supports.');
  });

  it('rejects invented completed work', () => {
    expect(
      rejection(
        validateProjectNarrative(
          { ...VALID_NARRATIVE, recentlyCompleted: ['Shipped the beta'], inProgress: [] },
          emptyPayload,
        ),
      ),
    ).toBe('Narrator invented completed work that no evidence supports.');
  });

  it('rejects invented work in progress', () => {
    expect(
      rejection(
        validateProjectNarrative(
          { ...VALID_NARRATIVE, recentlyCompleted: [], inProgress: ['Rewriting the importer'] },
          emptyPayload,
        ),
      ),
    ).toBe('Narrator invented work in progress that no evidence supports.');
  });

  it('rejects more blockers than the assessment found', () => {
    const payload = makePayload(
      makeAssessment({
        activeBlockers: [claim('Waiting on a provider decision', 'manual', ['ev-1'])],
        recentlyCompleted: baseAssessment.recentlyCompleted,
        currentWork: baseAssessment.currentWork,
        keyEvidenceIds: ['ev-1', 'ev-2'],
      }),
    );

    expect(
      rejection(
        validateProjectNarrative(
          {
            ...VALID_NARRATIVE,
            blockers: ['Waiting on a provider decision', 'The CI runner is offline'],
          },
          payload,
        ),
      ),
    ).toBe('Narrator reported more blockers than the assessment found.');
  });

  it('rejects more completed work than the assessment found', () => {
    expect(
      rejection(
        validateProjectNarrative(
          {
            ...VALID_NARRATIVE,
            recentlyCompleted: ['Merged #7 Evidence timeline', 'Shipped the beta'],
          },
          basePayload,
        ),
      ),
    ).toBe('Narrator reported more completed work than the assessment found.');
  });

  /*
   * The three-action cap is enforced by the schema before the semantic check can run, so a fourth
   * action is reported as a schema violation rather than by the `nextActions` guard below it.
   */
  it('rejects more than three next actions', () => {
    expect(
      rejection(
        validateProjectNarrative(
          { ...VALID_NARRATIVE, nextActions: ['One', 'Two', 'Three', 'Four'] },
          basePayload,
        ),
      ),
    ).toMatch(/^Narrator output failed schema validation: nextActions — /);
  });

  it('rejects a completion percentage in the current state', () => {
    expect(
      rejection(
        validateProjectNarrative(
          { ...VALID_NARRATIVE, currentState: 'The migration is 65% complete.' },
          basePayload,
        ),
      ),
    ).toBe('Narrator produced a completion percentage, which Jarvis never reports.');
  });
});

describe('validatePortfolioNarrative', () => {
  it('accepts a well-formed portfolio narrative', () => {
    expect(validatePortfolioNarrative(VALID_PORTFOLIO_NARRATIVE, portfolioPayload)).toEqual({
      ok: true,
      value: VALID_PORTFOLIO_NARRATIVE,
    });
  });

  it('rejects output that breaks the schema, naming the offending field', () => {
    expect(
      rejection(
        validatePortfolioNarrative(
          { ...VALID_PORTFOLIO_NARRATIVE, headline: '' },
          portfolioPayload,
        ),
      ),
    ).toMatch(/^Narrator output failed schema validation: headline — /);
  });

  it('rejects invented decisions', () => {
    const payload = makePortfolioPayload(
      makePortfolioAssessment({ counts: { ...NO_COUNTS, total: 1, active: 1 } }),
    );

    expect(
      rejection(
        validatePortfolioNarrative(
          {
            ...VALID_PORTFOLIO_NARRATIVE,
            headline: '1 active project.',
            decisionsNeeded: ['Choose a hosting provider'],
            focusOrder: [],
          },
          payload,
        ),
      ),
    ).toBe('Narrator invented decisions that no evidence supports.');
  });

  it('rejects a focus order longer than the assessment supports', () => {
    expect(
      rejection(
        validatePortfolioNarrative(
          {
            ...VALID_PORTFOLIO_NARRATIVE,
            focusOrder: ['Aurora — A decision is waiting on you', 'Iris — Invented urgency'],
          },
          portfolioPayload,
        ),
      ),
    ).toBe('Narrator listed more projects than exist in the portfolio.');
  });

  /*
   * `Math.max(focusOrder.length, 1)` deliberately floors the allowance at one, so a portfolio with
   * no ranked focus still permits a single focus line. Recorded so a change to that floor is a
   * visible decision rather than an accident.
   */
  it('allows a single focus line when the assessment ranked none', () => {
    const payload = makePortfolioPayload(
      makePortfolioAssessment({
        counts: { ...NO_COUNTS, total: 1, active: 1 },
        decisionsNeeded: [decisionReason('Decide on the hosting provider')],
      }),
    );

    expect(
      accepted(
        validatePortfolioNarrative(
          { ...VALID_PORTFOLIO_NARRATIVE, focusOrder: ['Aurora — Start here'] },
          payload,
        ),
      ).focusOrder,
    ).toEqual(['Aurora — Start here']);
  });

  it('rejects a completion percentage in the headline', () => {
    expect(
      rejection(
        validatePortfolioNarrative(
          { ...VALID_PORTFOLIO_NARRATIVE, headline: 'The portfolio is 40% complete.' },
          portfolioPayload,
        ),
      ),
    ).toBe('Narrator produced a completion percentage, which Jarvis never reports.');
  });
});

describe('containsFabricatedProgress', () => {
  it.each([
    ['The migration is 65% complete.', true],
    ['Roughly 80 % done at this point.', true],
    ['The work is 40%finished.', true],
    ['The health score is stable.', true],
    ['A progress score of seven.', true],
    ['Merged 12 pull requests this week.', false],
    ['100% of the CI checks are green.', false],
    ['Progress is steady on the importer.', false],
  ])('classifies %j as fabricated progress: %s', (text, expected) => {
    expect(containsFabricatedProgress(text)).toBe(expected);
  });
});

/* ------------------------------------------------------------------- AI narrator */

interface CapturedRequest {
  readonly model: string;
  readonly max_tokens: number;
  readonly temperature?: number;
  readonly system?: string;
  readonly messages: readonly { readonly role: string; readonly content: string }[];
  readonly tools?: readonly unknown[];
}

const textResponse = (text: string) => ({ content: [{ type: 'text', text }] });

/**
 * The narrator is always driven through an injected client, so no test can reach the network.
 * `respond` may throw, which exercises the transport-failure path.
 */
function narratorWith(respond: () => unknown): {
  narrator: AnthropicNarrator;
  calls: CapturedRequest[];
} {
  const calls: CapturedRequest[] = [];
  const create = async (request: CapturedRequest): Promise<unknown> => {
    calls.push(request);
    return respond();
  };
  const client = { messages: { create } } as unknown as Pick<Anthropic, 'messages'>;

  return {
    narrator: new AnthropicNarrator({
      apiKey: 'sk-ant-test-key-that-must-never-be-sent',
      model: 'claude-test-model',
      logger: SILENT_LOGGER,
      client,
    }),
    calls,
  };
}

const AI_NARRATIVE = {
  ...VALID_NARRATIVE,
  currentState: 'Momentum is steady: two changes landed and one review is open.',
};

const DETERMINISTIC_PROJECT = buildProjectNarrative(basePayload);
const DETERMINISTIC_PORTFOLIO = buildPortfolioNarrative(portfolioPayload);

describe('AnthropicNarrator', () => {
  it('reports itself as an available narrator named anthropic', () => {
    const { narrator } = narratorWith(() => textResponse(JSON.stringify(AI_NARRATIVE)));
    expect(narrator.name).toBe('anthropic');
    expect(narrator.isAvailable()).toBe(true);
  });

  it('uses the model wording when the response is valid JSON', async () => {
    const { narrator } = narratorWith(() => textResponse(JSON.stringify(AI_NARRATIVE)));

    const result = await narrator.narrateProject(basePayload);

    expect(result.method).toBe('ai_narrated');
    expect(result.error).toBeNull();
    expect(result.narrative.currentState).toBe(
      'Momentum is steady: two changes landed and one review is open.',
    );
    /* The AI wording replaces the deterministic headline rather than being merged with it. */
    expect(result.narrative.currentState).not.toBe(DETERMINISTIC_PROJECT.currentState);
    expect(result.narrative.citedEvidenceIds).toEqual(['ev-1', 'ev-2']);
  });

  it('parses a response wrapped in a triple-backtick json fence', async () => {
    const { narrator } = narratorWith(() =>
      textResponse('```json\n' + JSON.stringify(AI_NARRATIVE) + '\n```'),
    );

    const result = await narrator.narrateProject(basePayload);

    expect(result.method).toBe('ai_narrated');
    expect(result.narrative.currentState).toBe(
      'Momentum is steady: two changes landed and one review is open.',
    );
  });

  it.each([
    ['malformed JSON', () => textResponse('{ "currentState": }'), /JSON/],
    [
      'an empty content array',
      () => ({ content: [] }),
      /^The AI narrator returned an empty response\.$/,
    ],
    [
      'a transport failure',
      () => {
        throw new Error('connection reset by peer');
      },
      /^connection reset by peer$/,
    ],
    [
      'an invented blocker',
      () =>
        textResponse(
          JSON.stringify({ ...AI_NARRATIVE, blockers: ['Legal review has not started'] }),
        ),
      /^Narrator invented blockers that no evidence supports\.$/,
    ],
  ])('falls back to the deterministic narrative on %s', async (_case, respond, expectedError) => {
    const { narrator } = narratorWith(respond);

    const result = await narrator.narrateProject(basePayload);

    expect(result.method).toBe('ai_failed_fallback');
    expect(result.narrative).toEqual(DETERMINISTIC_PROJECT);
    expect(result.error).toMatch(expectedError);
  });

  it('narrates the portfolio and falls back when the model invents a decision', async () => {
    const narrated = await narratorWith(() =>
      textResponse(JSON.stringify(VALID_PORTFOLIO_NARRATIVE)),
    ).narrator.narratePortfolio(portfolioPayload);
    expect(narrated.method).toBe('ai_narrated');
    expect(narrated.narrative.headline).toBe('3 active projects, 1 needing your attention.');

    const emptyAssessmentPayload = makePortfolioPayload(
      makePortfolioAssessment({ counts: { ...NO_COUNTS, total: 1, active: 1 } }),
    );
    const rejected = await narratorWith(() =>
      textResponse(
        JSON.stringify({ ...VALID_PORTFOLIO_NARRATIVE, decisionsNeeded: ['Pick a host'] }),
      ),
    ).narrator.narratePortfolio(emptyAssessmentPayload);

    expect(rejected.method).toBe('ai_failed_fallback');
    expect(rejected.error).toBe('Narrator invented decisions that no evidence supports.');
    expect(rejected.narrative).toEqual(buildPortfolioNarrative(emptyAssessmentPayload));
  });

  it('keeps the deterministic portfolio narrative when the transport fails', async () => {
    const { narrator } = narratorWith(() => {
      throw new Error('the model timed out');
    });

    const result = await narrator.narratePortfolio(portfolioPayload);

    expect(result.method).toBe('ai_failed_fallback');
    expect(result.error).toBe('the model timed out');
    expect(result.narrative).toEqual(DETERMINISTIC_PORTFOLIO);
  });

  it('sends no tools, a temperature of zero and no credential', async () => {
    const { narrator, calls } = narratorWith(() => textResponse(JSON.stringify(AI_NARRATIVE)));

    await narrator.narrateProject(basePayload);

    expect(calls).toHaveLength(1);
    const request = calls[0];
    if (!request) throw new Error('The fake client captured no request.');

    expect(request.model).toBe('claude-test-model');
    expect(request.temperature).toBe(0);
    /* The narrator may write and nothing else: granting it a tool would make it an actor. */
    expect(request.tools).toBeUndefined();

    const serialisedMessages = JSON.stringify(request.messages);
    expect(serialisedMessages).not.toContain('sk-ant');
    expect(serialisedMessages).not.toContain('token');
    expect(serialisedMessages).not.toContain('secret');
    /* The evidence Jarvis does send must still be there — this is not an empty prompt. */
    expect(serialisedMessages).toContain('Merged #7 Evidence timeline');
  });
});

describe('stripFences', () => {
  it.each([
    ['```json\n{"currentState":"ok"}\n```', '{"currentState":"ok"}'],
    ['```JSON\n{"currentState":"ok"}\n```', '{"currentState":"ok"}'],
    ['```\n{"currentState":"ok"}\n```', '{"currentState":"ok"}'],
    ['{"currentState":"ok"}', '{"currentState":"ok"}'],
    ['  \n  {"currentState":"ok"}  \n', '{"currentState":"ok"}'],
    ['Here is the JSON:\n{"currentState":"ok"}\nHope that helps.', '{"currentState":"ok"}'],
  ])('extracts the JSON object from %j', (input, expected) => {
    expect(stripFences(input)).toBe(expected);
  });

  it('returns the trimmed body unchanged when there is no object to find', () => {
    expect(stripFences('  I could not produce JSON.  ')).toBe('I could not produce JSON.');
  });
});

/* ------------------------------------------------------------------ payload build */

describe('buildNarrationPayload', () => {
  it('puts key evidence first and exposes only id, kind, title, time and url', () => {
    const key = makeEvidence({ id: 'ev-key', kind: 'pull_request', title: 'Merged #7' });
    const other = makeEvidence({ id: 'ev-other', title: 'A commit' });
    const project = makeProject({ id: 'project-1' });
    const assessment = makeAssessment({ projectId: project.id, keyEvidenceIds: ['ev-key'] });

    const payload = buildNarrationPayload(project, assessment, [other, key]);

    expect(payload.evidence.map((item) => item.id)).toEqual(['ev-key', 'ev-other']);
    /* Nothing else from the evidence row travels — no metadata, no external id, no fetch time. */
    expect(payload.evidence[0]).toEqual({
      id: 'ev-key',
      kind: 'pull_request',
      title: 'Merged #7',
      observedAt: key.observedAt,
      url: key.url,
    });
    expect(payload.project).toEqual({
      name: project.name,
      type: project.type,
      status: assessment.status,
      phase: assessment.phase,
      goal: project.goal,
    });
  });

  it('caps the supporting evidence at twenty records beyond the key evidence', () => {
    const evidence = Array.from({ length: 40 }, (_, index) =>
      makeEvidence({ id: `ev-${index}`, title: `Commit ${index}` }),
    );
    const assessment = makeAssessment({ keyEvidenceIds: ['ev-0', 'ev-1'] });

    const payload = buildNarrationPayload(makeProject(), assessment, evidence);

    expect(payload.evidence).toHaveLength(22);
    expect(payload.evidence.slice(0, 2).map((item) => item.id)).toEqual(['ev-0', 'ev-1']);
    expect(payload.evidence.map((item) => item.id)).not.toContain('ev-39');
  });
});
