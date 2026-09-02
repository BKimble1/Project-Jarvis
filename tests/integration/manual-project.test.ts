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
    expect(JSON.stringify(briefing)).not.toMatch(/\d+%\s*complete/i);
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
  });
});
