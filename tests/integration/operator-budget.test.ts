import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { z } from 'zod';

import type { AuthorizationRequest, CapabilityRequest } from '@/domain/authorization';
import { spendIsMeasurable, sumUsage } from '@/domain/budget';
import { charterContentSchema, type CharterContent } from '@/domain/charter';
import type { MissionPlanContent } from '@/domain/mission-plan';
import { blockerInputSchema, projectInputSchema } from '@/domain/project';
import { WORKER_VERSION } from '@/domain/worker-protocol';
import { createHarness, type TestHarness } from '../helpers/services';
import {
  QUALIFIED_SANDBOX,
  qualifiedConfig,
  qualifyToLiveRead,
  qualifyToLiveWrite,
} from '../helpers/qualified';

/**
 * The two things that stopped the loop dead, against a real migrated database.
 *
 * Both are failures of *arithmetic about work Jarvis had already done*, and both ended the same
 * way: an operator that reported a reason and did nothing, for ever, with nothing running.
 *
 * 1. Three self-started missions that succeeded — a write mission's success is a draft pull
 *    request sitting in `pull_request_ready` — counted against the three-slot ceiling for ever,
 *    so every later tick had no room for anything, including the missions Blake asked for.
 * 2. A charter with any spending limit refused every plan: the operator offered no cost estimate,
 *    and a subscription worker's costless ledger rows made the spend look unmeasurable.
 *
 * Each case here is written as the failure an owner would describe rather than as a unit of the
 * fix, because both fixes are about which rows get counted and a test written against the counting
 * would pass whatever the loop then did.
 */

const PLAN: MissionPlanContent = {
  summary: 'Tidy the invoice importer',
  proposedOutcome: 'A draft pull request tidying the invoice importer.',
  assumptions: [],
  scope: ['Rename two functions in the importer'],
  outOfScope: ['Merging the pull request.'],
  affectedAreas: ['src/invoices.ts'],
  approach: 'Rename the two functions and add a regression test.',
  dataMigrations: [],
  testsToAddOrUpdate: ['Importer unit tests'],
  verification: [
    {
      command: 'npm test',
      purpose: 'Run the suite.',
      source: 'package_script',
      expectedUnavailableReason: null,
    },
  ],
  uiValidation: [],
  risks: [],
  rollback: 'Close the pull request and delete the branch.',
  acceptanceCriteria: ['The importer is tidier and the suite is green.'],
  openQuestions: [],
  estimatedComplexity: 'small',
  withinRequestedScope: true,
  scopeNotes: null,
  reviewOnlyDelivery: true,
  evidenceIds: [],
  repositoryFacts: {},
};

const HEARTBEAT = {
  status: 'idle' as const,
  version: WORKER_VERSION,
  runtimeAvailable: true,
  workspaceHealthy: true,
  githubDeliveryConfigured: true,
  diagnostics: [],
};

type CharterInput = z.input<typeof charterContentSchema>;
type GrantInput = NonNullable<CharterInput['grants']>[number];

function charter(overrides: Partial<CharterInput> = {}): CharterContent {
  return charterContentSchema.parse({
    goals: [],
    projectIds: [],
    grants: [],
    limits: {},
    communication: {},
    ...overrides,
  }) as CharterContent;
}

/**
 * A project id for a request that only needs *a* project, and the sandbox for the repository.
 *
 * Both are named rather than null because `repository.audit` is scoped by project and repository:
 * R-AU4 refuses a scoped capability that says which neither, before the charter or the spend
 * ledger are consulted at all — and a refusal from there would look exactly like the money one
 * these tests are about.
 */
const SOME_PROJECT = '11111111-2222-4333-8444-555555555555';

function ask(
  overrides: Partial<CapabilityRequest> & Pick<CapabilityRequest, 'capability'>,
): CapabilityRequest {
  return {
    projectId: SOME_PROJECT,
    repository: QUALIFIED_SANDBOX,
    branch: null,
    environment: null,
    releaseChannel: null,
    connectorId: null,
    reason: 'the plan said so',
    ...overrides,
  };
}

/** A plan that knows what it expects to spend, so only the *ledger* is under test. */
function request(overrides: Partial<AuthorizationRequest> = {}): AuthorizationRequest {
  return {
    missionId: null,
    capabilities: [ask({ capability: 'repository.audit' })],
    estimatedSpendUsd: 0.1,
    estimatedMinutes: null,
    parallelAgents: 1,
    exceptional: [],
    ...overrides,
  };
}

/* One repository, named: `code.change` refuses a `*` scope, exactly as an owner's charter must. */
const BLOCKED_REPO = 'blocked-project';

const DAY_MS = 24 * 60 * 60 * 1000;

describe('the operating loop, its slots and its money', () => {
  let harness: TestHarness;
  let counter = 0;

  beforeEach(async () => {
    harness = await createHarness({ config: qualifiedConfig() });
  });

  afterEach(async () => {
    await harness.close();
  });

  /** A project with something visibly wrong with it, recorded the way a person records it. */
  async function projectWithABlocker(name: string) {
    const created = await harness.services.projects.create(
      projectInputSchema.parse({ name, type: 'software' }),
    );
    await harness.services.sources.addGithubSource(created.id, {
      owner: 'test-owner',
      repo: BLOCKED_REPO,
      isPrimary: true,
    });
    await harness.services.projects.addBlocker(
      created.id,
      blockerInputSchema.parse({
        title: 'The importer rejects European invoices',
        description: 'Reported by two customers this week.',
        severity: 'high',
      }),
    );
    return created;
  }

  /** Qualified to write, under a charter granting everything fixing a bug actually takes. */
  async function operatingOnWrites() {
    const { charterService } = harness.services;
    await qualifyToLiveWrite(harness);
    const scope = {
      projects: ['*'],
      repositories: [`test-owner/${BLOCKED_REPO}`],
      branches: ['jarvis/*'],
    };
    const version = await charterService.draft({
      content: charter({
        grants: [
          { capability: 'bug.diagnose', scope: { projects: ['*'], repositories: ['*'] } },
          { capability: 'code.change', scope },
          { capability: 'test.add', scope },
          { capability: 'branch.create', scope },
          {
            capability: 'pull_request.open',
            scope: { projects: ['*'], repositories: [`test-owner/${BLOCKED_REPO}`] },
          },
        ] as GrantInput[],
      }),
      authoredBy: 'owner',
    });
    await charterService.activate(version.id, 'owner');
    await charterService.setMode({ to: 'supervised', actor: 'owner', changedBy: 'owner' });
    await charterService.setMode({ to: 'operator', actor: 'owner', changedBy: 'owner' });
    return version;
  }

  /** Read-only authority, which is all an owner's `project_review` request needs. */
  async function operatingAtLiveRead(limits: CharterInput['limits'] = {}) {
    const { charterService } = harness.services;
    await qualifyToLiveRead(harness);
    const version = await charterService.draft({
      content: charter({
        limits,
        grants: [
          {
            capability: 'repository.audit',
            scope: { projects: ['*'], repositories: ['*'] },
          } as GrantInput,
        ],
      }),
      authoredBy: 'owner',
    });
    await charterService.activate(version.id, 'owner');
    await charterService.setMode({ to: 'supervised', actor: 'owner', changedBy: 'owner' });
    await charterService.setMode({ to: 'operator', actor: 'owner', changedBy: 'owner' });
    return version;
  }

  /** A mission the owner asked for, planned by a worker and waiting at `awaiting_plan_approval`. */
  async function readyMission() {
    counter += 1;
    const project = await harness.services.projects.create(
      projectInputSchema.parse({ name: `Invoices ${counter}`, type: 'software' }),
    );
    await harness.services.sources.addGithubSource(project.id, {
      owner: 'test-owner',
      repo: `invoices-${counter}`,
      isPrimary: true,
    });
    const mission = await harness.services.missionRepo.create({
      rawRequest: 'Bring the invoice project status up to date.',
      title: `Update the invoice project status ${counter}`,
      type: 'project_review',
      priority: 'medium',
      riskLevel: 'low',
      riskRuleIds: [],
      riskReasons: [],
      ownerLogin: 'owner',
      state: 'planning',
      constraints: [],
      doNotTouch: [],
      acceptanceCriteria: [],
      projectId: project.id,
    });
    await harness.services.missions.storePlan(
      mission,
      PLAN,
      'jarvis_deterministic',
      'verified',
      null,
    );
    return { missionId: mission.id, projectId: project.id };
  }

  /**
   * Self-started missions parked in one state.
   *
   * `autonomous` is what makes a mission Jarvis's own — the approval path sets it when the charter
   * is the approver — so it is set here directly rather than by running three missions to
   * completion, which would test the state machine instead of the ceiling.
   */
  async function selfStarted(count: number, state: 'pull_request_ready' | 'queued') {
    const ids: string[] = [];
    for (let index = 0; index < count; index += 1) {
      counter += 1;
      const mission = await harness.services.missionRepo.create({
        rawRequest: 'Something Jarvis picked up itself.',
        title: `Jarvis mission ${counter}`,
        type: 'code_change',
        priority: 'medium',
        riskLevel: 'low',
        riskRuleIds: [],
        riskReasons: [],
        ownerLogin: null,
        state,
        constraints: [],
        doNotTouch: [],
        acceptanceCriteria: [],
        projectId: null,
      });
      await harness.services.missionRepo.patch(mission.id, {
        autonomous: true,
        ...(state === 'pull_request_ready'
          ? { pullRequestUrl: `https://github.com/test-owner/${BLOCKED_REPO}/pull/${index + 1}` }
          : {}),
      });
      ids.push(mission.id);
    }
    return ids;
  }

  /* -------------------------------------------------------------- the slots */

  describe('what counts as a slot in use', () => {
    /*
     * The reproduction, as an owner would describe it: "it worked for one night and then never
     * again". Three write missions delivered draft pull requests, and the loop reported
     * "1 thing(s) worth doing; 0 started. … Every mission slot is in use." with nothing running.
     */
    it('starts new work while its own delivered pull requests wait to be read', async () => {
      await projectWithABlocker('Blocked');
      await operatingOnWrites();
      await selfStarted(3, 'pull_request_ready');

      const result = await harness.services.operatorService.tick();

      expect(result.summary).not.toMatch(/Every mission slot is in use/);
      const raised = result.started.find((entry) => entry.missionId !== null);
      expect(raised, JSON.stringify(result.started)).toBeDefined();
    });

    /*
     * The half that made this a total outage rather than a self-imposed pause.
     *
     * `room` bounds the *whole* tick, so once it was pinned at zero the loop stopped advancing
     * the owner's own missions too — the ones a person had asked for by talking to Jarvis, which
     * have nothing to do with the ceiling on self-started work.
     */
    it('still advances the owner’s own mission while its deliveries wait', async () => {
      await operatingAtLiveRead();
      await selfStarted(3, 'pull_request_ready');
      const { missionId } = await readyMission();

      await harness.services.operatorService.tick();

      const after = await harness.services.missionRepo.findById(missionId);
      expect(after?.state, 'the owner’s mission should not be waiting on a click').not.toBe(
        'awaiting_plan_approval',
      );
      expect(after?.approvedPlanVersion).toBe(1);
    });

    /*
     * The protection this ceiling exists for, unchanged. Three self-started missions waiting for a
     * worker really do hold all three slots: nobody has to decide anything for a queued mission to
     * become a running one, so the owner would find every slot taken by work Jarvis chose.
     */
    it('stops starting when three of its own missions are genuinely waiting on a worker', async () => {
      await projectWithABlocker('Blocked');
      await operatingOnWrites();
      await selfStarted(3, 'queued');

      const result = await harness.services.operatorService.tick();

      expect(result.started).toEqual([]);
      expect(result.summary).toMatch(/Every mission slot is in use/);
    });

    /*
     * The mechanism rather than the trigger, which is the likeliest way the fix above is only
     * half of one.
     *
     * Counting delivered pull requests as slots was what pinned the ceiling at zero, but the
     * outage was that a *self-started* ceiling bounded the whole tick — so the owner's own mission
     * stopped moving too. Correcting which states count fixes the pin without touching the
     * coupling: three self-started missions that are genuinely waiting on a worker still pin it,
     * legitimately, and on that perfectly ordinary night Blake's own request would sit at
     * `awaiting_plan_approval` waiting for a click, for the same reason as before.
     *
     * A ceiling whose stated purpose is keeping the owner's queue clear of work Jarvis chose must
     * never be the thing holding the owner's queue up. This is that, written as the night rather
     * than as the arithmetic.
     */
    it('advances the owner’s own mission while three of its own hold every slot', async () => {
      await operatingAtLiveRead();
      await selfStarted(3, 'queued');
      const { missionId } = await readyMission();

      await harness.services.operatorService.tick();

      const after = await harness.services.missionRepo.findById(missionId);
      expect(after?.state, 'Jarvis’s own ceiling is not a reason to stall the owner').toBe(
        'queued',
      );
      expect(after?.approvedPlanVersion).toBe(1);
    });
  });

  /* -------------------------------------------------------------- the money */

  describe('a charter that sets a spending limit', () => {
    /** Whatever the ledger says about the last week, in the shape the charter reads it. */
    async function weekTotals() {
      return harness.services.usage.totals({
        from: new Date(Date.now() - 7 * DAY_MS),
        to: new Date(),
      });
    }

    /*
     * The reproduction: `limits.dailySpendUsd: 20` — the obvious thing to do with a field
     * described as "money Jarvis may spend on model usage per day" — and every plan came back
     * "Waiting for you: this plan cannot say what it would cost, and your charter sets a spending
     * limit". The operator hard-coded no estimate, and an unestimated plan is a refusal whenever a
     * limit exists.
     */
    it('authorises a routine plan instead of refusing it for having no estimate', async () => {
      await operatingAtLiveRead({ dailySpendUsd: 20 });
      const { missionId } = await readyMission();

      const result = await harness.services.operatorService.tick();

      const entry = result.started.find((item) => item.missionId === missionId);
      expect(entry?.outcome, JSON.stringify(result.started)).toBe('queued');
      const after = await harness.services.missionRepo.findById(missionId);
      expect(after?.state).toBe('queued');
      expect(after?.autonomous).toBe(true);
    });

    /*
     * And the limit still means something. The assumption the operator now offers is a bound, not
     * a way round the ceiling: once the day's *measured* spending has reached what the owner
     * allowed, the next plan waits for them however cheap it claims to be.
     */
    it('still refuses once the day’s spending has already gone', async () => {
      await operatingAtLiveRead({ dailySpendUsd: 1 });
      await harness.services.usage.record({
        kind: 'agent_task',
        inputTokens: 40_000,
        outputTokens: 9_000,
        reportedCostUsd: 1.5,
        costBasis: 'reported',
        occurredAt: new Date(),
      });
      const { missionId } = await readyMission();

      const result = await harness.services.operatorService.tick();

      const entry = result.started.find((item) => item.missionId === missionId);
      expect(entry?.outcome).toBe('proposed');
      expect(entry?.reason).toMatch(/already spent/);
      const after = await harness.services.missionRepo.findById(missionId);
      expect(after?.state).toBe('awaiting_plan_approval');
    });

    /*
     * A subscription run's ledger row is the second cause, and it is not a mistake in the ledger:
     * the marginal cost of a subscription run genuinely is nothing, so Claude Code's counterfactual
     * API figure is dropped and the row carries tokens and no money. Recorded as `subscription` it
     * is a measured zero and stays out of the honesty column — including in the database's own
     * aggregate, which counts `cost_basis = 'unknown'` and therefore needs no change to agree.
     */
    it('counts a subscription run as measured and free', async () => {
      await operatingAtLiveRead({ dailySpendUsd: 20 });
      await harness.services.usage.record({
        kind: 'answer',
        reportedCostUsd: 0.5,
        costBasis: 'reported',
        occurredAt: new Date(),
      });
      for (let index = 0; index < 3; index += 1) {
        await harness.services.usage.record({
          kind: 'agent_task',
          inputTokens: 40_000,
          outputTokens: 9_000,
          costBasis: 'subscription',
          occurredAt: new Date(),
        });
      }

      const totals = await weekTotals();
      expect(totals.recordCount).toBe(4);
      expect(totals.unknownCount).toBe(0);
      expect(spendIsMeasurable(totals)).toBe(true);
      /* The same answer from the records themselves, so the two ways of totalling agree. */
      expect(spendIsMeasurable(sumUsage(await harness.services.usage.list({})))).toBe(true);

      const { decision } = await harness.services.charterService.decide(request());
      expect(decision.outcome, decision.summary).toBe('authorized');
    });

    /*
     * The protection, kept. An API-key run whose cost went unrecorded is money that was spent and
     * not written down, and beside spending that *was* written down it drags the total below being
     * worth enforcing a limit against — so Jarvis asks rather than proceeding under a ceiling it
     * cannot apply.
     */
    it('still fails closed when an API-key run’s cost went unrecorded', async () => {
      await operatingAtLiveRead({ dailySpendUsd: 20 });
      await harness.services.usage.record({
        kind: 'answer',
        reportedCostUsd: 0.5,
        costBasis: 'reported',
        occurredAt: new Date(),
      });
      for (let index = 0; index < 3; index += 1) {
        await harness.services.usage.record({
          kind: 'answer',
          inputTokens: 8_000,
          outputTokens: 1_200,
          costBasis: 'unknown',
          occurredAt: new Date(),
        });
      }

      const totals = await weekTotals();
      expect(totals.unknownCount).toBe(3);
      expect(spendIsMeasurable(totals)).toBe(false);

      const { decision } = await harness.services.charterService.decide(request());
      expect(decision.outcome).toBe('needs_owner');
      expect(decision.verdicts[0]?.reason).toMatch(/no cost attached/);
    });

    /*
     * The one that closes the gap the two above only papered over.
     *
     * A window with no priced work at all is measurable at the total it reports, zero — but that
     * clause holds only while *nothing* is priced. One reported cent beside a subscription
     * worker's tokenful, costless rows used to put the ratio back in charge, read them as a ledger
     * with most of its money missing, and refuse every plan again: the same outage, one priced
     * call later.
     *
     * What makes it hold now is that the run says which it is. Nothing here sets `costBasis` by
     * hand — the worker reports `billing: 'subscription'` on the real protocol, and the ledger
     * writes a measured zero rather than a missing figure.
     */
    it('keeps working when a real subscription run sits beside one priced call', async () => {
      await operatingAtLiveRead({ dailySpendUsd: 20 });
      const { missionId } = await readyMission();
      await harness.services.missions.approvePlan(
        missionId,
        { planVersion: 1, acknowledgedRiskLevel: 'low', pausedProjectOverride: false },
        'owner',
      );
      const enrolled = await harness.services.workerService.enrol('billing-worker', 2);
      const assignment = await harness.services.workerService.claim(enrolled.worker.id, {
        heartbeat: HEARTBEAT,
        accepts: ['execution'],
      });
      expect(assignment, 'the fixture needs a real claimed run to report against').not.toBeNull();
      await harness.services.workerService.reportRunState(enrolled.worker.id, {
        runId: assignment!.runId,
        usage: { inputTokens: 40_000, outputTokens: 9_000, billing: 'subscription' },
      });

      /* The one priced call. An answer Jarvis gave through the API, costing a cent. */
      await harness.services.usage.record({
        kind: 'answer',
        reportedCostUsd: 0.01,
        costBasis: 'reported',
        occurredAt: new Date(),
      });

      const totals = await weekTotals();
      expect(totals.recordCount).toBe(2);
      expect(totals.unknownCount, 'the subscription run is measured, not unknown').toBe(0);
      expect(spendIsMeasurable(totals)).toBe(true);

      const next = await readyMission();
      const result = await harness.services.operatorService.tick();
      const entry = result.started.find((item) => item.missionId === next.missionId);
      expect(entry?.outcome, JSON.stringify(result.started)).toBe('queued');
    });

    /*
     * And the same deployment with a worker too old to send the field. Its rows say `unknown`,
     * because that is genuinely all its silence tells us — but there is no money anywhere in the
     * window for them to be understating, so the loop keeps working rather than refusing every
     * plan until somebody deletes the limit.
     */
    it('keeps working on a day whose ledger has no money in it at all', async () => {
      await operatingAtLiveRead({ dailySpendUsd: 20 });
      const { missionId } = await readyMission();
      await harness.services.missions.approvePlan(
        missionId,
        { planVersion: 1, acknowledgedRiskLevel: 'low', pausedProjectOverride: false },
        'owner',
      );
      const enrolled = await harness.services.workerService.enrol('subscription-worker', 2);
      const assignment = await harness.services.workerService.claim(enrolled.worker.id, {
        heartbeat: HEARTBEAT,
        accepts: ['execution'],
      });
      expect(assignment, 'the fixture needs a real claimed run to report against').not.toBeNull();
      /* Tokens and no cost: exactly what a subscription run reports. */
      await harness.services.workerService.reportRunState(enrolled.worker.id, {
        runId: assignment!.runId,
        usage: { inputTokens: 40_000, outputTokens: 9_000 },
      });

      const totals = await weekTotals();
      expect(totals.unknownCount).toBe(1);
      expect(totals.reportedUsd).toBe(0);

      const next = await readyMission();
      const result = await harness.services.operatorService.tick();

      const entry = result.started.find((item) => item.missionId === next.missionId);
      expect(entry?.outcome, JSON.stringify(result.started)).toBe('queued');
    });
  });
});
