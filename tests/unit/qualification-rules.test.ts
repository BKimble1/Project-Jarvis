import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ACTIVATION_CAPABILITIES,
  CAPABILITY_REQUIRED_LEVEL,
  EMPTY_ASSUMPTIONS,
  QUALIFICATION_CHECKS,
  QUALIFICATION_LEVELS,
  assertActivationAllowed,
  describeActivation,
  evaluateActivation,
  evaluateQualification,
  levelIndex,
  meetsLevel,
  requiresRequalification,
  type CheckOutcome,
  type QualificationCheckId,
  type QualificationCheckResult,
  type QualificationLevel,
} from '@/domain/qualification';
import { ForbiddenError } from '@/domain/errors';
import {
  ALLOWED_DELIVERY_METHODS,
  DISPLAY_ROUTE_INVENTORY,
  FORBIDDEN_DELIVERY_METHODS,
  checkDeliveryRestricted,
  checkDispatcherRestricted,
} from '@/server/qualification/surface-checks';
import { EXPECTED_MIGRATIONS } from '@/server/qualification/qualification-service';

/**
 * The qualification ladder, the activation lock, and the assertions that make them mean anything.
 *
 * The tests that matter most here are the ones that try to *cheat*: a check that reports
 * `unavailable` must not lift a rung, a `not_applicable` with no reason must not count, and a
 * later rung passing must not carry an earlier one. Each of those is a way a qualification system
 * quietly becomes decorative.
 */

function results(
  entries: Partial<Record<QualificationCheckId, CheckOutcome | [CheckOutcome, string]>>,
): readonly QualificationCheckResult[] {
  return Object.entries(entries).map(([id, value]) => {
    const [outcome, detail] = Array.isArray(value) ? value : [value, 'Checked.'];
    return {
      id: id as QualificationCheckId,
      outcome,
      detail,
      evidence: {},
      checkedAt: '2026-03-01T00:00:00.000Z',
      durationMs: 1,
    };
  });
}

const ALL_PASSING = (level: QualificationLevel) =>
  Object.fromEntries(
    QUALIFICATION_CHECKS.filter((check) => levelIndex(check.requiredFor) <= levelIndex(level)).map(
      (check) => [check.id, 'pass' as CheckOutcome],
    ),
  ) as Partial<Record<QualificationCheckId, CheckOutcome>>;

describe('the qualification ladder', () => {
  it('starts at built and stays there until the suite reports', () => {
    const verdict = evaluateQualification({
      results: [],
      automatedPassed: false,
      simulatedPassed: false,
    });
    expect(verdict.level).toBe('built');
    expect(verdict.nextLevel).toBe('automated');
    expect(verdict.blocking).toHaveLength(1);
  });

  it('does not reach simulated on the automated suite alone', () => {
    const verdict = evaluateQualification({
      results: [],
      automatedPassed: true,
      simulatedPassed: false,
    });
    expect(verdict.level).toBe('automated');
    expect(verdict.ladder.find((rung) => rung.level === 'simulated')?.reached).toBe(false);
  });

  it('will not let a later rung carry an earlier one', () => {
    /* Every live-write check passes, but the suite never reported. */
    const verdict = evaluateQualification({
      results: results(ALL_PASSING('live_write')),
      automatedPassed: false,
      simulatedPassed: false,
    });
    expect(verdict.level).toBe('built');
  });

  it('treats an unavailable check as not passing', () => {
    const verdict = evaluateQualification({
      results: results({ ...ALL_PASSING('live_read'), live_read_audit: 'unavailable' }),
      automatedPassed: true,
      simulatedPassed: true,
    });
    expect(verdict.level).toBe('simulated');
    expect(verdict.blocking.map((entry) => entry.id)).toContain('live_read_audit');
  });

  it('counts not_applicable only when it carries a reason', () => {
    const withoutReason = evaluateQualification({
      results: results({
        ...ALL_PASSING('live_read'),
        live_read_audit: ['not_applicable', 'n/a'],
      }),
      automatedPassed: true,
      simulatedPassed: true,
    });
    expect(withoutReason.level).toBe('simulated');

    const withReason = evaluateQualification({
      results: results({
        ...ALL_PASSING('live_read'),
        live_read_audit: [
          'not_applicable',
          'This deployment has no model provider and never runs agent work.',
        ],
      }),
      automatedPassed: true,
      simulatedPassed: true,
    });
    expect(withReason.level).toBe('live_read');
  });

  it('reaches production only when every check at every rung is satisfied', () => {
    const verdict = evaluateQualification({
      results: results(ALL_PASSING('production')),
      automatedPassed: true,
      simulatedPassed: true,
    });
    expect(verdict.level).toBe('production');
    expect(verdict.nextLevel).toBeNull();
    expect(verdict.blocking).toHaveLength(0);
  });

  it('gives every check a rung that exists', () => {
    for (const check of QUALIFICATION_CHECKS) {
      expect(QUALIFICATION_LEVELS).toContain(check.requiredFor);
    }
  });

  it('never assigns a configuration check to a rung the suite alone earns', () => {
    /*
     * `automated` and `simulated` are earned by tests reporting, not by configuration. A check
     * pointed at either would be silently ignored by `evaluateQualification`, which is worse than
     * a check that fails.
     */
    for (const check of QUALIFICATION_CHECKS) {
      expect(check.requiredFor).not.toBe('automated');
      expect(check.requiredFor).not.toBe('simulated');
      expect(check.requiredFor).not.toBe('built');
    }
  });
});

describe('requalification', () => {
  it('is not required when nothing changed', () => {
    const verdict = requiresRequalification({
      qualifiedUnder: { ...EMPTY_ASSUMPTIONS, workerProtocolVersion: '2.0.0' },
      current: { ...EMPTY_ASSUMPTIONS, workerProtocolVersion: '2.0.0' },
      qualifiedAt: '2026-03-01T00:00:00.000Z',
      nowIso: '2026-03-02T00:00:00.000Z',
    });
    expect(verdict.required).toBe(false);
  });

  it('is required when the worker protocol changes', () => {
    const verdict = requiresRequalification({
      qualifiedUnder: { ...EMPTY_ASSUMPTIONS, workerProtocolVersion: '2.0.0' },
      current: { ...EMPTY_ASSUMPTIONS, workerProtocolVersion: '3.0.0' },
      qualifiedAt: '2026-03-01T00:00:00.000Z',
      nowIso: '2026-03-02T00:00:00.000Z',
    });
    expect(verdict.required).toBe(true);
    expect(verdict.triggers).toContain('worker_protocol_changed');
  });

  it('does not thrash on an assumption nobody can fingerprint', () => {
    const verdict = requiresRequalification({
      qualifiedUnder: { ...EMPTY_ASSUMPTIONS, runtimeName: null },
      current: { ...EMPTY_ASSUMPTIONS, runtimeName: 'claude-agent-sdk' },
      qualifiedAt: '2026-03-01T00:00:00.000Z',
      nowIso: '2026-03-02T00:00:00.000Z',
    });
    expect(verdict.required).toBe(false);
  });

  it('expires an old qualification even when nothing changed', () => {
    const verdict = requiresRequalification({
      qualifiedUnder: EMPTY_ASSUMPTIONS,
      current: EMPTY_ASSUMPTIONS,
      qualifiedAt: '2025-01-01T00:00:00.000Z',
      nowIso: '2026-03-01T00:00:00.000Z',
    });
    expect(verdict.required).toBe(true);
    expect(verdict.triggers).toContain('expired');
  });

  it('treats a failed security review as invalidating, not merely as a failed check', () => {
    const verdict = requiresRequalification({
      qualifiedUnder: EMPTY_ASSUMPTIONS,
      current: EMPTY_ASSUMPTIONS,
      qualifiedAt: '2026-03-01T00:00:00.000Z',
      nowIso: '2026-03-02T00:00:00.000Z',
      securityCheckPassing: false,
    });
    expect(verdict.required).toBe(true);
    expect(verdict.triggers).toContain('security_check_failed');
  });
});

describe('the activation lock', () => {
  it('refuses every capability at built', () => {
    for (const capability of ACTIVATION_CAPABILITIES) {
      expect(evaluateActivation(capability, 'built').allowed).toBe(false);
    }
  });

  it('unlocks scheduled briefings once the suite passes, and nothing that needs a model', () => {
    const { unlocked, locked } = describeActivation('automated');
    expect(unlocked).toContain('scheduled_briefing');
    expect(unlocked).toContain('scheduled_evidence_refresh');
    expect(locked.map((entry) => entry.capability)).toContain('model_task_readonly');
    expect(locked.map((entry) => entry.capability)).toContain('model_task_write');
  });

  it('never lets a read qualification unlock writing', () => {
    expect(evaluateActivation('model_task_readonly', 'live_read').allowed).toBe(true);
    expect(evaluateActivation('model_task_write', 'live_read').allowed).toBe(false);
    expect(evaluateActivation('github_write', 'live_read').allowed).toBe(false);
  });

  it('holds CI and TestFlight back until production', () => {
    for (const level of QUALIFICATION_LEVELS.filter((entry) => entry !== 'production')) {
      expect(evaluateActivation('ci_dispatch', level).allowed).toBe(false);
      expect(evaluateActivation('testflight_dispatch', level).allowed).toBe(false);
    }
    expect(evaluateActivation('ci_dispatch', 'production').allowed).toBe(true);
  });

  it('throws with the reason rather than returning a boolean somebody can ignore', () => {
    expect(() => assertActivationAllowed('model_task_write', 'automated')).toThrow(ForbiddenError);
    try {
      assertActivationAllowed('model_task_write', 'automated');
    } catch (error) {
      expect((error as ForbiddenError).message).toContain('run an agent task that writes');
    }
  });

  it('requires every capability to name a rung, and none to be free', () => {
    for (const capability of ACTIVATION_CAPABILITIES) {
      const required = CAPABILITY_REQUIRED_LEVEL[capability];
      expect(QUALIFICATION_LEVELS).toContain(required);
      expect(required).not.toBe('built');
    }
  });

  it('orders the ladder so meetsLevel is monotonic', () => {
    for (const [index, level] of QUALIFICATION_LEVELS.entries()) {
      for (const [otherIndex, other] of QUALIFICATION_LEVELS.entries()) {
        expect(meetsLevel(level, other)).toBe(index >= otherIndex);
      }
    }
  });
});

describe('the surfaces qualification asserts', () => {
  it('finds the delivery client restricted to four methods', () => {
    const verdict = checkDeliveryRestricted();
    expect(verdict.ok).toBe(true);
    expect(verdict.evidence.methods).toBe(
      'checkStatus, comment, createDraftPullRequest, updatePullRequestBody',
    );
  });

  it('would notice a forbidden method appearing on the delivery client', () => {
    /*
     * The allowed and forbidden lists must not overlap, or a method could be both permitted and
     * prohibited and the check's answer would depend on which list it consulted first.
     */
    for (const name of ALLOWED_DELIVERY_METHODS) {
      expect(FORBIDDEN_DELIVERY_METHODS).not.toContain(name);
    }
  });

  it('finds the CI dispatcher restricted', () => {
    const verdict = checkDispatcherRestricted();
    expect(verdict.ok).toBe(true);
    expect(verdict.evidence.methods).toBe('declaredSecretNames, dispatch, findRun');
  });

  it('keeps the generic request escape hatch off both prototypes', () => {
    /*
     * A method taking an arbitrary path and body is every forbidden operation at once. Both
     * clients use a hard `#private`, which is not on the prototype at all — TypeScript's
     * `private` is erased and would still be reachable through a cast.
     */
    expect(checkDeliveryRestricted().evidence.methods).not.toContain('request');
    expect(checkDispatcherRestricted().evidence.methods).not.toContain('call');
  });

  it('has no display-authenticated route outside the inventory', () => {
    /*
     * This is the half the runtime check honestly says it cannot do: once built, the application
     * has no view of its own source tree. So the source tree is scanned here instead, and any new
     * caller of display authentication fails the suite until it is added to the inventory
     * deliberately.
     */
    const routes = collectRouteFiles(path.join(process.cwd(), 'src/app/api'));
    const displayRoutes = routes.filter((file) =>
      /displays\s*\.\s*authenticate/.test(readFileSync(file, 'utf8')),
    );

    const relative = displayRoutes
      .map((file) => path.relative(process.cwd(), file).replace(/\\/g, '/'))
      .sort();
    expect(relative).toEqual([...DISPLAY_ROUTE_INVENTORY.map((entry) => entry.path)].sort());
  });

  it('expects exactly the migrations that exist on disk', () => {
    const onDisk = readdirSync(path.join(process.cwd(), 'drizzle'))
      .filter((file) => file.endsWith('.sql'))
      .sort();
    expect([...EXPECTED_MIGRATIONS]).toEqual(onDisk);
  });
});

function collectRouteFiles(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...collectRouteFiles(full));
    else if (entry.name === 'route.ts') found.push(full);
  }
  return found;
}
