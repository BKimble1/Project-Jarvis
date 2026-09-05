import { describe, expect, it } from 'vitest';

import type { ReadinessCheck } from '@/domain/readiness';
import { buildSetupSteps, SETUP_STEP_IDS, summariseSetup } from '@/domain/setup-steps';

/**
 * First run, in the order somebody would do it.
 *
 * The behaviour worth testing is not the grouping, it is the honesty: a step that is set but
 * unproved must not read as done, a step that stops everything must not be counted the same as one
 * that merely unlocks more, and nothing anywhere may carry a value.
 */

function check(overrides: Partial<ReadinessCheck> & Pick<ReadinessCheck, 'area'>): ReadinessCheck {
  return {
    id: `${overrides.area}_check`,
    title: 'A check',
    state: 'verified',
    detail: 'It worked.',
    nextAction: null,
    blocking: false,
    ...overrides,
  };
}

const everythingWorks: readonly ReadinessCheck[] = [
  check({ area: 'runtime' }),
  check({ area: 'database' }),
  check({ area: 'access' }),
  check({ area: 'model' }),
  check({ area: 'worker' }),
];

describe('the setup walkthrough', () => {
  it('is a fixed, ordered list ending with what Jarvis may do unasked', () => {
    expect(SETUP_STEP_IDS[0]).toBe('runtime');
    expect(SETUP_STEP_IDS[SETUP_STEP_IDS.length - 1]).toBe('authority');
    expect(SETUP_STEP_IDS).toHaveLength(12);
  });

  it('does not round "set but unproved" up to done', () => {
    const steps = buildSetupSteps({
      checks: [check({ area: 'model', state: 'configured', nextAction: 'Run a real answer.' })],
      charterActive: false,
      modeLabel: 'Off',
    });
    const model = steps.find((step) => step.id === 'model');
    expect(model?.state).toBe('unverified');
    expect(model?.nextAction).toBe('Run a real answer.');
  });

  it('separates a step that stops everything from one that merely unlocks more', () => {
    const blocked = buildSetupSteps({
      checks: [
        ...everythingWorks.filter((entry) => entry.area !== 'worker'),
        check({ area: 'worker', state: 'missing', blocking: true, nextAction: 'Enrol one.' }),
      ],
      charterActive: true,
      modeLabel: 'Operating',
    });
    expect(blocked.find((step) => step.id === 'worker')?.state).toBe('blocking');
    expect(summariseSetup(blocked)).toContain('stops Jarvis from doing anything at all');

    const merelyUnfinished = buildSetupSteps({
      checks: [
        ...everythingWorks,
        check({ area: 'display', state: 'missing', nextAction: 'Optional.' }),
      ],
      charterActive: true,
      modeLabel: 'Operating',
    });
    expect(merelyUnfinished.find((step) => step.id === 'display')?.state).toBe('todo');
    expect(summariseSetup(merelyUnfinished)).toContain('Nothing outstanding stops Jarvis working');
  });

  it('hides a step with nothing in it rather than showing an empty tick', () => {
    const steps = buildSetupSteps({
      checks: [check({ area: 'runtime' })],
      charterActive: true,
      modeLabel: 'Operating',
    });
    expect(steps.find((step) => step.id === 'github')?.state).toBe('not_applicable');
    /*
     * And it is excluded from the count. With one check and a charter in force there are two
     * applicable steps and both are done — "1 of 12" would be a demand to configure ten things
     * this deployment has no way to configure.
     */
    expect(summariseSetup(steps)).toBe('Everything is set up. Nothing here needs you.');
  });

  it('treats a missing charter as a step, not a failure', () => {
    const steps = buildSetupSteps({
      checks: everythingWorks,
      charterActive: false,
      modeLabel: 'Supervised',
    });
    const authority = steps.find((step) => step.id === 'authority');
    expect(authority?.state).toBe('todo');
    expect(authority?.nextAction).toContain('approve each mission yourself');
    expect(authority?.nextAction).not.toMatch(/error|fail|must/i);
  });

  it('carries no value anywhere, only states and instructions', () => {
    const steps = buildSetupSteps({
      checks: [
        check({
          area: 'access',
          state: 'missing',
          detail: 'No session secret is set.',
          nextAction: 'Put SESSION_SECRET in .env.local.',
        }),
      ],
      charterActive: false,
      modeLabel: 'Off',
    });
    const serialised = JSON.stringify(steps);
    expect(serialised).not.toMatch(/sk-ant-/);
    expect(serialised).not.toMatch(/gh[pousr]_/);
    expect(serialised).not.toMatch(/postgres(?:ql)?:\/\//);
  });
});
