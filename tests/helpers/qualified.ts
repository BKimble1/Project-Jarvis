import { expect } from 'vitest';

import type { CompletionReceiptContent } from '@/domain/completion-receipt';
import { projectInputSchema } from '@/domain/project';
import { WORKER_VERSION } from '@/domain/worker-protocol';
import type { AppConfig } from '@/server/config/env';
import { testConfig } from './test-config';
import type { TestHarness } from './services';

/**
 * A deployment that has genuinely climbed to `live_read`.
 *
 * Every rung is earned the way a real deployment earns it — a green automated suite, a green
 * simulated suite, a live worker on a real runtime, a chosen and allow-listed sandbox, and a
 * finished read-only mission recorded as evidence. Nothing is forced: there is no code path that
 * sets a level directly, and a fixture that reached in and wrote one would be testing a system
 * nobody ships.
 *
 * It exists because standing authority is only interesting on a qualified deployment. Below
 * `live_read` the charter authorises nothing that runs a model, which is correct and also means
 * the autonomous path cannot be exercised at all — so without this helper the most important
 * behaviour in the operator would have no test.
 */

export const QUALIFIED_SANDBOX = 'test-owner/sandbox';

/** A config whose allow-list names the sandbox this helper qualifies against. */
export function qualifiedConfig(overrides: Record<string, string | undefined> = {}): AppConfig {
  const base = testConfig(overrides);
  return {
    ...base,
    qualification: {
      ...base.qualification,
      sandboxRepositories: [QUALIFIED_SANDBOX],
      buildRef: 'build-test',
    },
  };
}

/**
 * Climb to `live_read`, and assert that it worked.
 *
 * The assertion is part of the helper on purpose. A fixture that silently failed to qualify would
 * make every test using it pass for the wrong reason — the autonomous path would be refused, the
 * test would assert a refusal, and nobody would notice the qualified case had never run.
 */
export async function qualifyToLiveRead(harness: TestHarness): Promise<void> {
  const { qualificationService, workerService } = harness.services;

  await qualificationService.recordSuite({
    kind: 'automated',
    passed: true,
    detail: 'Green.',
    testCount: 1200,
  });
  await qualificationService.recordSuite({
    kind: 'simulated',
    passed: true,
    detail: 'Green.',
    testCount: null,
  });

  await qualificationService.selectSandbox(QUALIFIED_SANDBOX);

  /*
   * A worker that is live, on a build this control plane accepts, running something that is not a
   * stand-in. `checkModelProvider` deliberately refuses a scripted runtime: a deployment with no
   * model credential anywhere must not be able to qualify as having a model provider.
   */
  const enrolled = await workerService.enrol('qualified-worker', 2);
  await workerService.poll(enrolled.worker.id, {
    heartbeat: {
      status: 'idle',
      version: WORKER_VERSION,
      runtimeAvailable: true,
      runtimeName: 'claude-agent-sdk',
      workspaceHealthy: true,
      githubDeliveryConfigured: true,
      diagnostics: [],
    },
    acknowledgedCommandIds: [],
    wantsWork: false,
  });

  /* A finished read-only mission against the sandbox, with a report and no pull request. */
  const project = await sandboxProject(harness);
  const mission = await finishedMission(harness, {
    projectId: project.id,
    title: 'Qualification audit',
    pullRequest: null,
  });
  await qualificationService.recordLiveQualification({ missionId: mission.id, kind: 'live_read' });
  await qualificationService.run({ startedBy: 'test' });

  const level = await qualificationService.currentLevel();
  expect(
    level,
    'the qualified fixture did not reach live_read; every test using it would pass for the wrong reason',
  ).toBe('live_read');
}

/**
 * Climb all the way to `live_write`, and assert that it worked.
 *
 * Everything `live_read` needs, plus the two things a write rung asks for that a read rung does
 * not: a mission that really opened a draft pull request against the sandbox, and a record that
 * the repository's own checks ran during it. Both are recorded as evidence rather than asserted —
 * the ladder refuses a write qualification from a mission that opened no pull request (R-QL3), and
 * a live write that ran no verification at all fails outright.
 */
export async function qualifyToLiveWrite(harness: TestHarness): Promise<void> {
  await qualifyToLiveRead(harness);

  const { qualificationService, missionRepo, missionRuns, verifications } = harness.services;
  const project = (await harness.services.projects.listAllForAssessment(false)).find(
    (entry) => entry.name === 'Qualification sandbox',
  );
  const mission = await finishedMission(harness, {
    projectId: project?.id ?? null,
    title: 'Qualification write rehearsal',
    pullRequest: 'https://github.com/test-owner/sandbox/pull/1',
  });

  /* The repository's own checks, recorded against the run that opened the pull request. */
  const run = await missionRuns.start({
    missionId: mission.id,
    workerId: (await harness.services.workerRepo.list())[0]!.id,
    attempt: 1,
    kind: 'execution',
    planVersion: 1,
    startedAt: new Date(),
  });
  await missionRuns.patch(run.id, { state: 'succeeded', finishedAt: new Date() });
  await verifications.record(mission.id, run.id, {
    command: 'npm test',
    source: 'package_script',
    outcome: 'passed',
    exitCode: 0,
    missionRelated: true,
  });
  await missionRepo.patch(mission.id, { activeRunId: null });

  await qualificationService.recordLiveQualification({ missionId: mission.id, kind: 'live_write' });
  await qualificationService.run({ startedBy: 'test' });

  const level = await qualificationService.currentLevel();
  expect(
    level,
    'the qualified fixture did not reach live_write; every test using it would pass for the wrong reason',
  ).toBe('live_write');
}

async function sandboxProject(harness: TestHarness) {
  const [owner, repo] = QUALIFIED_SANDBOX.split('/');
  const project = await harness.services.projects.create(
    projectInputSchema.parse({ name: 'Qualification sandbox', type: 'software' }),
  );
  await harness.services.sources.addGithubSource(project.id, {
    owner: owner as string,
    repo: repo as string,
    isPrimary: true,
  });
  return project;
}

async function finishedMission(
  harness: TestHarness,
  input: {
    readonly projectId: string | null;
    readonly title: string;
    readonly pullRequest: string | null;
  },
) {
  const mission = await harness.services.missionRepo.create({
    rawRequest: 'Rehearse against the qualification sandbox.',
    title: input.title,
    type: input.pullRequest ? 'code_change' : 'project_review',
    priority: 'medium',
    riskLevel: input.pullRequest ? 'low' : 'read_only',
    riskRuleIds: [],
    riskReasons: [],
    ownerLogin: 'owner',
    state: 'completed',
    constraints: [],
    doNotTouch: [],
    acceptanceCriteria: [],
    projectId: input.projectId,
  });
  await harness.services.missionRepo.patch(mission.id, { baseSha: 'a1b2c3d4e5f6' });

  const content: CompletionReceiptContent = {
    missionId: mission.id,
    missionTitle: mission.title,
    rawRequest: mission.rawRequest,
    projectName: 'Qualification sandbox',
    planVersion: 1,
    graphVersion: 1,
    playbook: null,
    agents: [],
    tasks: [],
    integrationBranch: 'jarvis/qualification',
    taskBranches: [],
    integrationResult: 'clean',
    integrationDetail: null,
    changedFiles: input.pullRequest ? ['src/importer.ts'] : [],
    diffSummary: null,
    verification: [],
    reviews: [],
    repairedFindings: [],
    remainingFindings: [],
    unresolvedRisks: [],
    artifacts: [{ id: 'artifact-1', title: 'Report', kind: 'research_report' }],
    pullRequestUrl: input.pullRequest,
    pullRequestNumber: input.pullRequest ? 1 : null,
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
