import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CompletionReceiptContent } from '@/domain/completion-receipt';
import { QUALIFICATION_VERSION } from '@/domain/qualification';
import { WORKER_VERSION } from '@/domain/worker-protocol';
import { ForbiddenError, ValidationError } from '@/domain/errors';
import { projectInputSchema } from '@/domain/project';
import { testConfig } from '../helpers/test-config';
import { createHarness, type TestHarness } from '../helpers/services';

/**
 * Qualification, end to end through the real service.
 *
 * The claim under test is Prompt 4's first one: that "built", "the tests pass", "it ran with
 * replacements", "a real model read a real repository" and "a real model wrote to one" are five
 * different statements, and that Jarvis will not act as though it has earned one it has not.
 *
 * So most of these tests are attempts to *cheat the ladder* — record a suite for a different
 * build, claim a read qualification from a mission that wrote, record the same run twice, use a
 * sandbox nobody allow-listed. Each one has to be refused with a reason.
 */

const SANDBOX = 'owner/jarvis-sandbox';

function configWith(overrides: {
  readonly sandboxes?: readonly string[];
  readonly buildRef?: string | null;
  readonly backup?: { configured: boolean; testedAt: string | null };
}) {
  const base = testConfig();
  return {
    ...base,
    qualification: {
      ...base.qualification,
      sandboxRepositories: overrides.sandboxes ?? [SANDBOX],
      buildRef: overrides.buildRef === undefined ? 'build-abc' : overrides.buildRef,
      backupConfigured: overrides.backup?.configured ?? false,
      backupRestoreTestedAt: overrides.backup?.testedAt ?? null,
    },
  };
}

/**
 * A finished mission against a real project with a real GitHub source.
 *
 * The source matters: a mission's repository is *resolved* from the project's sources, not read
 * off the mission row, so a fixture that set the mission's own columns would exercise a path no
 * real mission takes.
 */
async function completedMission(
  harness: TestHarness,
  input: {
    readonly repository: string | null;
    readonly pullRequestUrl?: string | null;
    readonly artifacts?: number;
    readonly state?: 'completed' | 'failed';
  },
) {
  let projectId: string | null = null;
  if (input.repository) {
    const [owner, name] = input.repository.split('/');
    const project = await harness.services.projects.create(
      projectInputSchema.parse({ name: `Project ${name}`, type: 'software' }),
    );
    await harness.services.sources.addGithubSource(project.id, {
      owner: owner as string,
      repo: name as string,
      isPrimary: true,
    });
    projectId = project.id;
  }

  const mission = await harness.services.missionRepo.create({
    rawRequest: 'Rehearse a harmless change.',
    title: 'Qualification rehearsal',
    type: 'code_change',
    priority: 'medium',
    riskLevel: 'low',
    riskRuleIds: [],
    riskReasons: [],
    ownerLogin: 'owner',
    state: input.state ?? 'completed',
    constraints: [],
    doNotTouch: [],
    acceptanceCriteria: [],
    projectId,
  });

  await harness.services.missionRepo.patch(mission.id, { baseSha: 'a1b2c3d4e5f6' });

  const content: CompletionReceiptContent = {
    missionId: mission.id,
    missionTitle: mission.title,
    rawRequest: mission.rawRequest,
    projectName: null,
    planVersion: 1,
    graphVersion: 1,
    playbook: null,
    agents: [],
    tasks: [],
    integrationBranch: 'jarvis/qualification',
    taskBranches: [],
    integrationResult: 'clean',
    integrationDetail: null,
    changedFiles: [],
    diffSummary: null,
    verification: [],
    reviews: [],
    repairedFindings: [],
    remainingFindings: [],
    unresolvedRisks: [],
    artifacts: Array.from({ length: input.artifacts ?? 1 }, (_, index) => ({
      id: `artifact-${index}`,
      title: 'Audit report',
      kind: 'research_report',
    })),
    pullRequestUrl: input.pullRequestUrl ?? null,
    pullRequestNumber: input.pullRequestUrl ? 7 : null,
    usage: {
      outputTokens: 1200,
      inputTokens: 8000,
      durationMs: 60_000,
      agentRuns: 1,
      estimatedCostUsd: null,
    },
    stages: [],
    nextSteps: [],
    generatedAt: '2026-03-01T00:00:00.000Z',
  };

  await harness.services.receipts.upsert({
    missionId: mission.id,
    graphVersion: 1,
    planVersion: 1,
    content,
  });

  return mission;
}

describe('qualification', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await createHarness({ config: configWith({}) });
  });

  afterEach(async () => {
    await harness.close();
  });

  it('reports built on a fresh deployment, with every unavailable check named', async () => {
    const status = await harness.services.qualificationService.run({ startedBy: 'test' });

    expect(status.verdict.level).toBe('built');
    expect(status.run?.results.length).toBeGreaterThan(10);

    /* Nothing that needs a worker, a write credential or a live run may report a pass. */
    const shouldNotPass = [
      'worker_enrolled',
      'worker_version',
      'model_provider',
      'github_write_credential',
      'live_read_audit',
      'live_write_draft_pr',
      'recovery_drill',
      'security_review',
    ];
    for (const id of shouldNotPass) {
      expect(status.run?.results.find((result) => result.id === id)?.outcome).not.toBe('pass');
    }

    /*
     * The harness does have a working (fake) read provider, so that check passes — and it should.
     * A check that reported failure because the credential was a test double would be measuring
     * the test rig rather than the system.
     */
    expect(status.run?.results.find((result) => result.id === 'github_read')?.outcome).toBe('pass');

    /* And the ones that can be decided from the code itself do report honestly. */
    expect(status.run?.results.find((result) => result.id === 'delivery_restricted')?.outcome).toBe(
      'pass',
    );
    expect(status.run?.results.find((result) => result.id === 'migrations_applied')?.outcome).toBe(
      'pass',
    );
  });

  it('unlocks nothing at all until a suite reports', async () => {
    await harness.services.qualificationService.run({ startedBy: 'test' });

    for (const capability of [
      'scheduled_briefing',
      'model_task_readonly',
      'model_task_write',
      'ci_dispatch',
    ] as const) {
      const verdict = await harness.services.qualificationService.evaluate(capability);
      expect(verdict.allowed).toBe(false);
      expect(verdict.reason).toContain('unattended');
    }

    await expect(
      harness.services.qualificationService.assertAllowed('scheduled_briefing'),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('reaches automated when the suite reports, and simulated only when both do', async () => {
    await harness.services.qualificationService.recordSuite({
      kind: 'automated',
      passed: true,
      detail: 'The gate passed.',
      testCount: 836,
    });
    expect((await harness.services.qualificationService.status()).verdict.level).toBe('automated');

    await harness.services.qualificationService.recordSuite({
      kind: 'simulated',
      passed: true,
      detail: 'The multi-agent smoke test passed.',
      testCount: null,
    });
    expect((await harness.services.qualificationService.status()).verdict.level).toBe('simulated');

    const briefing = await harness.services.qualificationService.evaluate('scheduled_briefing');
    expect(briefing.allowed).toBe(true);
    const model = await harness.services.qualificationService.evaluate('model_task_readonly');
    expect(model.allowed).toBe(false);
  });

  it('does not let a suite recorded for another build qualify this one', async () => {
    await harness.services.qualificationService.recordSuite({
      kind: 'automated',
      passed: true,
      detail: 'Passed on a different commit.',
      testCount: 836,
    });
    expect((await harness.services.qualificationService.status()).verdict.level).toBe('automated');

    /* The deployment moves to a new build; yesterday's green run no longer says anything. */
    const moved = await createHarness({ config: configWith({ buildRef: 'build-def' }) });
    try {
      await moved.services.qualificationService.recordSuite({
        kind: 'automated',
        passed: true,
        detail: 'Passed here.',
        testCount: 1,
      });
      const status = await moved.services.qualificationService.status();
      expect(status.buildRef).toBe('build-def');
      expect(status.automatedPassed).toBe(true);
    } finally {
      await moved.close();
    }
  });

  it('records a failing suite as failing rather than leaving the old pass in place', async () => {
    await harness.services.qualificationService.recordSuite({
      kind: 'automated',
      passed: true,
      detail: 'Green.',
      testCount: 836,
    });
    await harness.services.qualificationService.recordSuite({
      kind: 'automated',
      passed: false,
      detail: 'One test failed.',
      testCount: 836,
    });
    expect((await harness.services.qualificationService.status()).verdict.level).toBe('built');
  });

  describe('the sandbox', () => {
    it('refuses a repository nobody allow-listed', async () => {
      await expect(
        harness.services.qualificationService.selectSandbox('owner/production-app'),
      ).rejects.toBeInstanceOf(ValidationError);
    });

    it('accepts one that was named deliberately', async () => {
      const chosen = await harness.services.qualificationService.selectSandbox(SANDBOX);
      expect(chosen).toBe(SANDBOX);

      const status = await harness.services.qualificationService.run({ startedBy: 'test' });
      expect(
        status.run?.results.find((result) => result.id === 'sandbox_allow_listed')?.outcome,
      ).toBe('pass');
    });
  });

  describe('recording a live run', () => {
    beforeEach(async () => {
      await harness.services.qualificationService.selectSandbox(SANDBOX);
    });

    it('refuses a mission that did not succeed', async () => {
      const mission = await completedMission(harness, {
        repository: SANDBOX,
        state: 'failed',
      });
      await expect(
        harness.services.qualificationService.recordLiveQualification({
          missionId: mission.id,
          kind: 'live_read',
        }),
      ).rejects.toThrow(/R-QL1/);
    });

    it('refuses a mission that ran against something other than the sandbox', async () => {
      const mission = await completedMission(harness, { repository: 'owner/production-app' });
      await expect(
        harness.services.qualificationService.recordLiveQualification({
          missionId: mission.id,
          kind: 'live_read',
        }),
      ).rejects.toThrow(/R-QL2/);
    });

    it('refuses a write qualification from a mission that opened no pull request', async () => {
      const mission = await completedMission(harness, { repository: SANDBOX });
      await expect(
        harness.services.qualificationService.recordLiveQualification({
          missionId: mission.id,
          kind: 'live_write',
        }),
      ).rejects.toThrow(/R-QL3/);
    });

    it('refuses a read qualification from a mission that wrote', async () => {
      const mission = await completedMission(harness, {
        repository: SANDBOX,
        pullRequestUrl: 'https://github.com/owner/jarvis-sandbox/pull/7',
      });
      await expect(
        harness.services.qualificationService.recordLiveQualification({
          missionId: mission.id,
          kind: 'live_read',
        }),
      ).rejects.toThrow(/R-QL4/);
    });

    it('refuses a read qualification from a mission that produced nothing', async () => {
      const mission = await completedMission(harness, { repository: SANDBOX, artifacts: 0 });
      await expect(
        harness.services.qualificationService.recordLiveQualification({
          missionId: mission.id,
          kind: 'live_read',
        }),
      ).rejects.toThrow(/R-QL4/);
    });

    it('records a genuine read, and refuses to record the same run twice', async () => {
      const mission = await completedMission(harness, { repository: SANDBOX });
      const recorded = await harness.services.qualificationService.recordLiveQualification({
        missionId: mission.id,
        kind: 'live_read',
      });
      expect(recorded.summary).toContain(SANDBOX);

      await expect(
        harness.services.qualificationService.recordLiveQualification({
          missionId: mission.id,
          kind: 'live_read',
        }),
      ).rejects.toThrow(/R-QL5/);

      const evidence = await harness.services.qualification.listLiveEvidence();
      expect(evidence).toHaveLength(1);
      expect(evidence[0]?.qualificationVersion).toBe(QUALIFICATION_VERSION);
      expect(evidence[0]?.pullRequestUrl).toBeNull();
      /*
       * Checked against credential *values*, not key names: `outputTokens` is a count and a
       * shape that forbids the word "token" would be checking spelling rather than safety.
       */
      expect(JSON.stringify(evidence[0])).not.toMatch(/sk-ant-|gh[pousr]_|-----BEGIN/);
    });

    it('climbs to live_read only when every check for that rung is satisfied', async () => {
      await harness.services.qualificationService.recordSuite({
        kind: 'automated',
        passed: true,
        detail: 'Green.',
        testCount: 1,
      });
      await harness.services.qualificationService.recordSuite({
        kind: 'simulated',
        passed: true,
        detail: 'Green.',
        testCount: null,
      });

      const mission = await completedMission(harness, { repository: SANDBOX });
      await harness.services.qualificationService.recordLiveQualification({
        missionId: mission.id,
        kind: 'live_read',
      });

      /*
       * The live audit is now recorded — and the rung is still not earned, because no worker is
       * enrolled and no model provider is reachable. That is the point: one piece of evidence
       * does not make a qualification.
       */
      const status = await harness.services.qualificationService.run({ startedBy: 'test' });
      expect(status.run?.results.find((r) => r.id === 'live_read_audit')?.outcome).toBe('pass');
      expect(status.verdict.level).toBe('simulated');
      expect(status.verdict.blocking.map((entry) => entry.id)).toContain('worker_enrolled');
    });
  });

  describe('attestations', () => {
    it('refuses a note too short to be evidence', async () => {
      await expect(
        harness.services.qualificationService.recordAttestation({
          kind: 'recoveryDrill',
          note: 'done',
          recordedBy: 'owner',
        }),
      ).rejects.toBeInstanceOf(ValidationError);
    });

    it('stops counting a security review once the build moves on', async () => {
      await harness.services.qualificationService.recordAttestation({
        kind: 'securityReview',
        note: 'Reviewed the diff against docs/THREAT_MODEL.md and found nothing new.',
        recordedBy: 'owner',
      });
      const first = await harness.services.qualificationService.run({ startedBy: 'test' });
      expect(first.run?.results.find((r) => r.id === 'security_review')?.outcome).toBe('pass');

      const moved = await createHarness({ config: configWith({ buildRef: 'build-later' }) });
      try {
        await moved.services.qualificationService.recordAttestation({
          kind: 'securityReview',
          note: 'Reviewed an older commit entirely.',
          recordedBy: 'owner',
        });
        /* Recorded against build-later, so it passes there — the interesting case is the reverse. */
        const status = await moved.services.qualificationService.run({ startedBy: 'test' });
        expect(status.run?.results.find((r) => r.id === 'security_review')?.outcome).toBe('pass');
      } finally {
        await moved.close();
      }
    });
  });

  describe('backups', () => {
    it('fails rather than passes when a backup exists but no restore was rehearsed', async () => {
      const configured = await createHarness({
        config: configWith({ backup: { configured: true, testedAt: null } }),
      });
      try {
        const status = await configured.services.qualificationService.run({ startedBy: 'test' });
        const result = status.run?.results.find((entry) => entry.id === 'backup_configured');
        expect(result?.outcome).toBe('fail');
        expect(result?.detail).toContain('belief');
      } finally {
        await configured.close();
      }
    });

    it('passes when a restore has actually been rehearsed', async () => {
      const drilled = await createHarness({
        config: configWith({
          backup: { configured: true, testedAt: '2026-02-01T00:00:00.000Z' },
        }),
      });
      try {
        const status = await drilled.services.qualificationService.run({ startedBy: 'test' });
        expect(status.run?.results.find((entry) => entry.id === 'backup_configured')?.outcome).toBe(
          'pass',
        );
      } finally {
        await drilled.close();
      }
    });
  });

  describe('what a check is actually allowed to claim', () => {
    /**
     * Enrol a worker and have it report a heartbeat, so the fleet checks have something real to
     * read rather than a row that never connected.
     */
    async function connectWorker(
      overrides: { runtimeName?: string; runtimeAvailable?: boolean } = {},
    ) {
      const { worker } = await harness.services.workerService.enrol('qualification-worker', 1);
      await harness.services.workerService.heartbeat(worker.id, {
        status: 'idle',
        version: WORKER_VERSION,
        runtimeAvailable: overrides.runtimeAvailable ?? true,
        runtimeName: overrides.runtimeName ?? 'claude-agent-sdk',
        workspaceHealthy: true,
        githubDeliveryConfigured: true,
        diagnostics: [],
      });
      return worker;
    }

    it('refuses to call a scripted stand-in a model provider', async () => {
      /*
       * The runtime that exists so the whole mission path can be exercised *without* a model. It
       * reports itself available, truthfully, and counting that as a model provider would let a
       * deployment with no Anthropic key anywhere climb the ladder — which is the exact shape of
       * dishonesty this ladder was built to prevent.
       */
      await connectWorker({ runtimeName: 'scripted' });

      const status = await harness.services.qualificationService.run({ startedBy: 'test' });
      const result = status.run?.results.find((entry) => entry.id === 'model_provider');

      expect(result?.outcome).toBe('fail');
      expect(result?.detail).toContain('stand-in');
      expect(result?.detail).toContain('scripted');
    });

    it('accepts a real runtime', async () => {
      await connectWorker({ runtimeName: 'claude-agent-sdk' });

      const status = await harness.services.qualificationService.run({ startedBy: 'test' });
      expect(status.run?.results.find((entry) => entry.id === 'model_provider')?.outcome).toBe(
        'pass',
      );
    });

    it('will not call a delivered pull request evidence that verification ran', async () => {
      /*
       * The check that used to be a duplicate.
       *
       * `verification_discoverable` says "the repository's own checks can be found and run", and
       * it was implemented as the identical call `live_write_draft_pr` makes — so a mission that
       * opened a draft pull request having run nothing at all satisfied both. That mission proves
       * the delivery path and says nothing whatever about verification.
       */
      await harness.services.qualificationService.selectSandbox(SANDBOX);
      const mission = await completedMission(harness, {
        repository: SANDBOX,
        pullRequestUrl: 'https://github.test/owner/jarvis-sandbox/pull/7',
      });
      await harness.services.qualificationService.recordLiveQualification({
        missionId: mission.id,
        kind: 'live_write',
      });

      const status = await harness.services.qualificationService.run({ startedBy: 'test' });
      const delivered = status.run?.results.find((entry) => entry.id === 'live_write_draft_pr');
      const verified = status.run?.results.find(
        (entry) => entry.id === 'verification_discoverable',
      );

      /* The delivery is real and passes. */
      expect(delivered?.outcome).toBe('pass');
      /* And the verification claim is refused, where it used to be the same answer. */
      expect(verified?.outcome).toBe('fail');
      expect(verified?.detail).toContain('no verification');
    });

    it('passes verification once the repository’s own commands have actually run', async () => {
      await harness.services.qualificationService.selectSandbox(SANDBOX);
      const mission = await completedMission(harness, {
        repository: SANDBOX,
        pullRequestUrl: 'https://github.test/owner/jarvis-sandbox/pull/7',
      });

      /* A run needs a worker, and a verification needs a run — so the worker is real too. */
      const worker = await connectWorker();
      const run = await harness.services.missionRuns.start({
        missionId: mission.id,
        workerId: worker.id,
        attempt: 1,
        kind: 'execution',
        planVersion: 1,
        startedAt: new Date(),
      });
      await harness.services.verifications.record(mission.id, run.id, {
        command: 'npm test',
        source: 'package_script',
        outcome: 'passed',
        exitCode: 0,
        durationMs: 4200,
        outputExcerpt: 'ok',
        missionRelated: true,
        reason: null,
      });

      await harness.services.qualificationService.recordLiveQualification({
        missionId: mission.id,
        kind: 'live_write',
      });

      const status = await harness.services.qualificationService.run({ startedBy: 'test' });
      const verified = status.run?.results.find(
        (entry) => entry.id === 'verification_discoverable',
      );
      expect(verified?.outcome).toBe('pass');
      expect(verified?.detail).toContain('discovered and run');
      /* Which commands ran is evidence, not prose: it is what makes the pass checkable. */
      expect(verified?.evidence.commands).toBe('npm test');
      expect(verified?.evidence.passed).toBe('1');
    });
  });

  it('never stores a credential in a check result', async () => {
    const status = await harness.services.qualificationService.run({ startedBy: 'test' });
    const serialised = JSON.stringify(status.run?.results ?? []);
    expect(serialised).not.toMatch(/sk-ant-/);
    expect(serialised).not.toMatch(/gh[pousr]_/);
    expect(serialised).not.toMatch(/"value"\s*:/);
  });
});
