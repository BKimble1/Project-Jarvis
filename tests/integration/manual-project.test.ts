import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { projectInputSchema } from '@/domain/project';
import { createHarness, type TestHarness } from '../helpers/services';

describe('manual projects', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await createHarness();
  });

  afterEach(async () => {
    await harness.close();
  });

  it('creates a project with no source and briefs it without inventing progress', async () => {
    const { services } = harness;
    const project = await services.projects.create(
      projectInputSchema.parse({
        name: 'Thesis chapter 3',
        type: 'school',
        goal: 'Submit the revised methodology section.',
      }),
    );

    const briefing = await services.briefings.briefProject(project.id);

    expect(briefing.assessment.status).toBe('active');
    expect(briefing.assessment.recentlyCompleted).toHaveLength(0);
    expect(briefing.assessment.currentWork).toHaveLength(0);
    expect(briefing.method).toBe('deterministic');
    /* Nothing observed means unknown, not "no progress". */
    expect(briefing.assessment.freshness.state).toBe('live');

    /*
     * Jarvis never reports a completion figure. Asserting on the rendered claim text rather than
     * on the serialised object means an empty or malformed briefing cannot satisfy this by
     * containing nothing at all.
     */
    const prose = [
      briefing.narrative.currentState,
      ...briefing.narrative.recentlyCompleted,
      ...briefing.narrative.inProgress,
      ...briefing.narrative.nextActions,
      ...briefing.narrative.unknowns,
      briefing.assessment.headline.text,
      ...briefing.assessment.recommendedActions.map((action) => action.action),
    ];
    expect(prose.length).toBeGreaterThan(0);
    expect(briefing.narrative.currentState.length).toBeGreaterThan(0);
    for (const line of prose) {
      expect(line, line).not.toMatch(/\d+\s*(%|percent|pct)/i);
      expect(line, line).not.toMatch(/\b(complete|done|finished)\s*[:=]\s*\d/i);
      expect(line, line).not.toMatch(/\b(health|progress)\s+score\b/i);
    }
    /* And no numeric completion field exists to render in the first place. */
    expect(Object.keys(briefing.assessment)).not.toContain('completion');
    expect(Object.keys(briefing.assessment)).not.toContain('percentComplete');
    expect(Object.keys(briefing.assessment)).not.toContain('score');
  });

  it('records blockers, actions and updates as manual provenance', async () => {
    const { services } = harness;
    const project = await services.projects.create(
      projectInputSchema.parse({ name: 'Studio site', type: 'website' }),
    );

    await services.projects.addBlocker(project.id, {
      title: 'Decide on the hosting provider',
      severity: 'high',
      requiresOwnerDecision: true,
      description: null,
      resolutionRequirement: 'Compare the two quotes.',
    });

    const briefing = await services.briefings.briefProject(project.id, { regenerate: true });

    expect(briefing.assessment.status).toBe('blocked');
    expect(briefing.assessment.statusProvenance).toBe('inferred');
    expect(briefing.assessment.decisionsNeeded).toHaveLength(1);
    expect(briefing.assessment.decisionsNeeded[0]?.provenance).toBe('manual');
    expect(briefing.assessment.needsAttention).toBe(true);

    const refreshed = await services.projects.findById(project.id);
    expect(refreshed?.needsAttention).toBe(true);

    /* The other two owner-entered kinds the test name promises. */
    const action = await services.projects.addNextAction(project.id, {
      action: 'Compare the two hosting quotes',
      priority: 'high',
      status: 'open',
      position: 0,
      dueDate: null,
      requiresOwner: true,
    });
    const update = await services.projects.addUpdate(project.id, {
      whatChanged: 'Collected quotes from both providers.',
      currentWork: null,
      problemsOrRisks: null,
      proposedNextAction: null,
      occurredOn: null,
    });

    expect(action.provenance).toBe('manual');
    expect(action.sourceSystem).toBe('manual');
    expect(update.provenance).toBe('manual');
    expect(update.sourceSystem).toBe('manual');

    const aggregate = await services.projects.aggregate(project.id);
    expect(aggregate?.blockers.map((item) => item.provenance)).toEqual(['manual']);
    expect(aggregate?.nextActions.map((item) => item.provenance)).toEqual(['manual']);
    expect(aggregate?.updates.map((item) => item.provenance)).toEqual(['manual']);
  });
});
