import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { z } from 'zod';

import { charterContentSchema, charterDigest, type CharterContent } from '@/domain/charter';
import type { AuthorizationRequest, CapabilityRequest } from '@/domain/authorization';
import { missionCapabilityRequests } from '@/domain/mission-capabilities';
import { ConflictError, ForbiddenError, NotFoundError } from '@/domain/errors';
import { blockerInputSchema, projectInputSchema } from '@/domain/project';
import type { MissionPlanContent } from '@/domain/mission-plan';
import { WORKER_VERSION } from '@/domain/worker-protocol';
import { createHarness, type TestHarness } from '../helpers/services';
import {
  QUALIFIED_SANDBOX,
  qualifiedConfig,
  qualifyToLiveRead,
  qualifyToLiveWrite,
} from '../helpers/qualified';

/**
 * Standing authority, against a real migrated database.
 *
 * Two questions run through everything here, and they are separate on purpose. *Did the owner
 * permit this?* is the charter's question. *Has this deployment proved it can do it safely?* is
 * the qualification ladder's. Neither answer implies the other, and the tests that matter most
 * are the ones where one says yes and the other says no.
 *
 * Almost every case below is an attempt to obtain a "yes" nobody granted: a draft charter used as
 * though it were in force, a decision made for one mission replayed against another, a charter
 * edited underneath a decision that cited it, and — the one this whole increment exists for — a
 * mission Jarvis authorised itself, on a deployment that has qualified for nothing.
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
 * A project id for requests that only need *a* project.
 *
 * Named rather than null, because a scoped capability with no project named is refused under
 * R-AU4 before the charter or the ladder are consulted at all — "this plan does not say which
 * project it means" is a gap in the request, and no grant may fill it in.
 */
const SOME_PROJECT = '11111111-2222-4333-8444-555555555555';

function ask(
  overrides: Partial<CapabilityRequest> & Pick<CapabilityRequest, 'capability'>,
): CapabilityRequest {
  return {
    projectId: SOME_PROJECT,
    repository: null,
    branch: null,
    environment: null,
    releaseChannel: null,
    connectorId: null,
    reason: 'the plan said so',
    ...overrides,
  };
}

function request(overrides: Partial<AuthorizationRequest> = {}): AuthorizationRequest {
  return {
    missionId: null,
    capabilities: [ask({ capability: 'research.read' })],
    estimatedSpendUsd: null,
    estimatedMinutes: null,
    parallelAgents: 1,
    exceptional: [],
    ...overrides,
  };
}

describe('standing authority', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    /*
     * The config names the sandbox `qualifyToLiveRead` climbs against. Tests that stay at `built`
     * are unaffected by it — an allow-list with nothing selected qualifies nothing.
     */
    harness = await createHarness({ config: qualifiedConfig() });
  });

  afterEach(async () => {
    await harness.close();
  });

  /* ------------------------------------------------------------- charters */

  describe('charters', () => {
    it('numbers versions and records a digest of what was written', async () => {
      const { charterService } = harness.services;
      const content = charter({
        goals: [{ id: 'g1', statement: 'Ship the importer', priority: 1 }],
      });

      const first = await charterService.draft({ content, authoredBy: 'owner' });
      const second = await charterService.draft({ content: charter(), authoredBy: 'owner' });

      expect(first.version).toBe(1);
      expect(second.version).toBe(2);
      expect(first.digest).toBe(charterDigest(content));
      expect(first.digest).not.toBe(second.digest);
    });

    /* A draft is a document somebody was thinking about. It permits nothing. */
    it('authorises nothing until it is activated', async () => {
      const { charterService } = harness.services;
      await charterService.draft({
        content: charter({
          grants: [{ capability: 'research.read', scope: { projects: ['*'] } } as GrantInput],
        }),
        authoredBy: 'owner',
      });

      expect(await charterService.active()).toBeNull();
      const { decision } = await charterService.decide(request());
      expect(decision.outcome).not.toBe('authorized');
      expect(decision.charterVersionId).toBeNull();
    });

    it('supersedes the incumbent in one step, leaving exactly one in force', async () => {
      const { charterService } = harness.services;
      const first = await charterService.draft({ content: charter(), authoredBy: 'owner' });
      const second = await charterService.draft({ content: charter(), authoredBy: 'owner' });

      await charterService.activate(first.id, 'owner');
      await charterService.activate(second.id, 'owner');

      const active = await charterService.active();
      expect(active?.id).toBe(second.id);
      const history = await charterService.history();
      expect(history.filter((entry) => entry.activatedAt && !entry.supersededAt)).toHaveLength(1);
      expect(history.find((entry) => entry.id === first.id)?.supersededAt).not.toBeNull();
    });

    /*
     * Two activations racing must not both leave a row in force. The partial unique index is what
     * makes that true, and a sequential test could never find its absence.
     */
    it('cannot leave two charters in force when two activations race', async () => {
      const { charterService, charters } = harness.services;
      const a = await charterService.draft({ content: charter(), authoredBy: 'owner' });
      const b = await charterService.draft({ content: charter(), authoredBy: 'owner' });

      const results = await Promise.allSettled([
        charterService.activate(a.id, 'owner'),
        charterService.activate(b.id, 'owner'),
      ]);
      expect(results.some((result) => result.status === 'fulfilled')).toBe(true);

      const all = await charters.list();
      const inForce = all.filter((entry) => entry.activatedAt && !entry.supersededAt);
      expect(inForce).toHaveLength(1);
    });

    it('refuses to revive a superseded version', async () => {
      const { charterService } = harness.services;
      const first = await charterService.draft({ content: charter(), authoredBy: 'owner' });
      const second = await charterService.draft({ content: charter(), authoredBy: 'owner' });
      await charterService.activate(first.id, 'owner');
      await charterService.activate(second.id, 'owner');

      await expect(charterService.activate(first.id, 'owner')).rejects.toBeInstanceOf(
        ConflictError,
      );
    });

    it('refuses a charter whose grants cannot be honoured as written', async () => {
      const { charterService } = harness.services;
      await expect(
        charterService.draft({
          content: {
            goals: [],
            projectIds: [],
            /* `deploy.website` must name its environments; `*` is not an answer. */
            grants: [{ capability: 'deploy.website', scope: { environments: ['*'] } }],
            limits: {},
            communication: {},
          },
          authoredBy: 'owner',
        }),
      ).rejects.toThrow(/cannot be honoured/);
    });
  });

  /* ----------------------------------------------------------------- mode */

  describe('the operating mode', () => {
    it('starts off, and says so rather than assuming', async () => {
      const state = await harness.services.charterService.state();
      expect(state.mode).toBe('off');
      expect(state.charterId).toBeNull();
    });

    it('refuses to grant standing authority with no charter in force', async () => {
      const { charterService } = harness.services;
      await charterService.setMode({ to: 'supervised', actor: 'owner', changedBy: 'owner' });
      await expect(
        charterService.setMode({ to: 'operator', actor: 'owner', changedBy: 'owner' }),
      ).rejects.toThrow(/without a charter in force/);
    });

    it('refuses to grant standing authority on an expired charter', async () => {
      const { charterService } = harness.services;
      const expired = await charterService.draft({
        content: charter({ expiresAt: '2020-01-01T00:00:00.000Z' }),
        authoredBy: 'owner',
      });
      await charterService.activate(expired.id, 'owner');
      await charterService.setMode({ to: 'supervised', actor: 'owner', changedBy: 'owner' });

      await expect(
        charterService.setMode({ to: 'operator', actor: 'owner', changedBy: 'owner' }),
      ).rejects.toThrow(/expired/);
    });

    /*
     * The asymmetry, exercised through the service rather than only through the table: anything
     * can take autonomy away, only a signed-in owner can hand it over.
     */
    it('lets the system reduce autonomy and refuses to let it increase autonomy', async () => {
      const { charterService } = harness.services;
      const version = await charterService.draft({ content: charter(), authoredBy: 'owner' });
      await charterService.activate(version.id, 'owner');
      await charterService.setMode({ to: 'supervised', actor: 'owner', changedBy: 'owner' });
      await charterService.setMode({ to: 'operator', actor: 'owner', changedBy: 'owner' });

      const reduced = await charterService.setMode({
        to: 'paused',
        actor: 'system',
        changedBy: 'supervisor',
        reason: 'No progress for an hour.',
      });
      expect(reduced.mode).toBe('paused');

      await expect(
        charterService.setMode({ to: 'operator', actor: 'system', changedBy: 'supervisor' }),
      ).rejects.toThrow(/Only you can grant Jarvis more autonomy/);
    });

    it('explains why standing authority is unavailable, in a sentence', async () => {
      const { charterService } = harness.services;
      const authority = await charterService.authority();
      expect(authority.standingAuthority).toBe(false);
      expect(authority.blockedReason).toContain('off');
    });
  });

  /* ------------------------------------------------------------ decisions */

  describe('decisions', () => {
    async function operating(overrides: Partial<z.input<typeof charterContentSchema>> = {}) {
      const { charterService } = harness.services;
      const version = await charterService.draft({
        content: charter({
          grants: [{ capability: 'research.read', scope: { projects: ['*'] } } as GrantInput],
          ...overrides,
        }),
        authoredBy: 'owner',
      });
      await charterService.activate(version.id, 'owner');
      await charterService.setMode({ to: 'supervised', actor: 'owner', changedBy: 'owner' });
      await charterService.setMode({ to: 'operator', actor: 'owner', changedBy: 'owner' });
      return version;
    }

    it('records refusals as carefully as approvals', async () => {
      const { charterService } = harness.services;
      const { decision } = await charterService.decide(
        request({ capabilities: [ask({ capability: 'deploy.website' })] }),
      );
      expect(decision.outcome).not.toBe('authorized');

      const recent = await charterService.recentDecisions();
      expect(recent).toHaveLength(1);
      expect(recent[0]?.outcome).toBe(decision.outcome);
      expect(recent[0]?.verdicts.length).toBeGreaterThan(0);
    });

    /*
     * A charter gap and a qualification gap are different answers, and the difference is what the
     * owner can do about it. Asking for something the charter does not mention is `needs_owner`,
     * because they can grant it. Asking for something the deployment has not qualified for is
     * `refused`, because they cannot.
     */
    it('distinguishes what the owner could grant from what only qualifying can fix', async () => {
      await operating();
      const { charterService } = harness.services;

      const beyondCharter = await charterService.decide(
        request({ capabilities: [ask({ capability: 'marketing.create' })] }),
      );
      expect(beyondCharter.decision.outcome).toBe('needs_owner');
      expect(beyondCharter.decision.verdicts.every((verdict) => verdict.ownerCanGrant)).toBe(true);

      /* Granted by the charter, and still refused: the deployment has qualified for nothing. */
      const beyondLadder = await charterService.decide(request());
      expect(beyondLadder.decision.outcome).toBe('refused');
      expect(beyondLadder.decision.verdicts[0]?.rule).toBe('R-AU5');
      expect(beyondLadder.decision.verdicts[0]?.ownerCanGrant).toBe(false);
    });

    it('refuses to confirm a decision that authorised nothing', async () => {
      await operating();
      const { charterService } = harness.services;
      const refused = await charterService.decide(
        request({ missionId: null, capabilities: [ask({ capability: 'marketing.publish' })] }),
      );
      await expect(
        charterService.confirmDecision(refused.stored!.id, 'anything'),
      ).rejects.toBeInstanceOf(ForbiddenError);
    });

    it('refuses a decision that does not exist', async () => {
      const { charterService } = harness.services;
      await expect(
        charterService.confirmDecision('11111111-2222-4333-8444-555555555555', 'mission'),
      ).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  /* --------------------------------------------------------- the loop */

  describe('the operating loop', () => {
    let projectCount = 0;

    async function project(name?: string) {
      projectCount += 1;
      return harness.services.projects.create(
        projectInputSchema.parse({ name: name ?? `Watched ${projectCount}`, type: 'software' }),
      );
    }

    /**
     * A project Jarvis genuinely cannot see.
     *
     * A source that has failed, rather than a project with no source at all: a freshly created
     * project counts as observed, because the owner typing it in *is* an observation, and pretending
     * otherwise would be a second notion of freshness disagreeing with the status engine's.
     */
    async function darkProject(name: string) {
      const created = await project(name);
      const source = await harness.services.sources.addGithubSource(created.id, {
        owner: 'test-owner',
        repo: `dark-${projectCount}`,
        isPrimary: true,
      });
      await harness.services.sources.recordSyncOutcome(source.id, {
        syncStatus: 'failed',
        at: new Date(),
        error: 'The token was rejected.',
      });
      return created;
    }

    /*
     * Two ticks overlapping is the normal case for a loop driven from more than one place. One
     * wins and the other goes back to sleep — without this, a slow tick and the next scheduled one
     * both see the same opportunity and both act on it.
     */
    it('will not run two passes at once', async () => {
      const { operatorLeases, operatorService } = harness.services;
      const now = new Date();
      await operatorLeases.acquire({
        scope: 'operator',
        key: 'tick',
        holder: 'somebody-else',
        ttlSeconds: 120,
        now,
      });

      const result = await operatorService.tick();
      expect(result.outcome).toBe('held');
      expect(result.tickId).toBeNull();
      expect(result.summary).toMatch(/already running/);
    });

    /* A tick killed mid-flight must not wedge the loop until somebody deletes a row by hand. */
    it('steals a lease that has expired', async () => {
      const { operatorLeases, operatorService } = harness.services;
      await operatorLeases.acquire({
        scope: 'operator',
        key: 'tick',
        holder: 'the-one-that-died',
        ttlSeconds: 1,
        now: new Date(Date.now() - 60_000),
      });

      const result = await operatorService.tick();
      expect(result.outcome).not.toBe('held');
    });

    it('does not even look while Jarvis is off', async () => {
      await project();
      const result = await harness.services.operatorService.tick();
      expect(result.outcome).toBe('skipped');
      expect(result.summary).toMatch(/not looking/);
    });

    async function observing() {
      const { charterService } = harness.services;
      await charterService.setMode({ to: 'observer', actor: 'owner', changedBy: 'owner' });
    }

    it('records a pass that found nothing, and says why', async () => {
      await observing();
      const result = await harness.services.operatorService.tick();
      expect(result.outcome).toBe('observed');
      expect(result.summary).toMatch(/no projects/i);

      const ticks = await harness.services.operatorService.recentTicks();
      expect(ticks).toHaveLength(1);
      expect(ticks[0]?.finishedAt).not.toBeNull();
    });

    /*
     * The most expensive mistake an unattended operator can make. A project whose source has never
     * reported produces no opportunities, which looks exactly like a project with nothing wrong —
     * and the coverage record is the only thing keeping them apart.
     */
    it('reports a project it could not see as unobserved, not as healthy', async () => {
      await observing();
      const created = await darkProject('Sync is failing');

      const result = await harness.services.operatorService.tick();
      const coverage = result.coverage.find((entry) => entry.projectId === created.id);
      expect(coverage?.state).toBe('failed');
      expect(coverage?.detail).toContain('token was rejected');
      expect(result.summary).toMatch(/could not be checked/);
    });

    it('never acts on a project the charter does not cover', async () => {
      await observing();
      const created = await project('Outside');

      const result = await harness.services.operatorService.tick();
      /* Nothing is selected, whatever the backlog says, because nothing is chartered. */
      expect(result.selected).toEqual([]);
      expect(result.coverage.some((entry) => entry.projectId === created.id)).toBe(true);
    });

    it('keeps one row per situation however many times it sees it', async () => {
      await observing();
      await project('Repeatedly seen');

      const first = await harness.services.operatorService.tick();
      const second = await harness.services.operatorService.tick();

      const backlog = await harness.services.operatorService.backlog();
      const keys = backlog.map((entry) => entry.key);
      expect(new Set(keys).size).toBe(keys.length);
      expect(second.backlog.length).toBe(first.backlog.length);
    });

    it('writes a tick row for every pass, including the quiet ones', async () => {
      await observing();
      await harness.services.operatorService.tick();
      await harness.services.operatorService.tick();
      await harness.services.operatorService.tick();

      const ticks = await harness.services.operatorService.recentTicks();
      expect(ticks).toHaveLength(3);
      for (const tick of ticks) {
        expect(tick.summary.length).toBeGreaterThan(0);
        expect(tick.finishedAt).not.toBeNull();
      }
    });

    it('lets the owner dismiss something, and it does not come back', async () => {
      await observing();
      const created = await project('Dismissible');
      await harness.services.projects.update(created.id, { goal: 'Ship it' });

      /* Seed the backlog directly: the point here is the dismissal, not the derivation. */
      await harness.services.opportunities.observe({
        opportunities: [
          {
            key: 'a'.repeat(32),
            projectId: created.id,
            source: 'attention',
            rule: 'R-TEST',
            title: 'Something Jarvis noticed',
            detail: 'Detail.',
            severity: 'high',
            provenance: 'verified',
            evidenceIds: [],
            capabilities: [],
            acceptanceCriteria: [],
            missionType: null,
            requiresOwner: false,
            observedAt: new Date().toISOString(),
          },
        ],
        now: new Date(),
      });

      const dismissed = await harness.services.operatorService.dismiss('a'.repeat(32), 'Not now.');
      expect(dismissed?.state).toBe('dismissed');

      await harness.services.operatorService.tick();
      const backlog = await harness.services.operatorService.backlog();
      expect(backlog.some((entry) => entry.key === 'a'.repeat(32))).toBe(false);
    });

    /*
     * Closing a backlog because a source failed would read "everything is fixed" when the truth is
     * "Jarvis could not look" — so an unobserved project's opportunities are left exactly alone.
     */
    it('does not close the backlog of a project it could not check', async () => {
      const created = await darkProject('Goes dark');
      await harness.services.opportunities.observe({
        opportunities: [
          {
            key: 'b'.repeat(32),
            projectId: created.id,
            source: 'attention',
            rule: 'R-TEST',
            title: 'Still true as far as anyone knows',
            detail: 'Detail.',
            severity: 'high',
            provenance: 'verified',
            evidenceIds: [],
            capabilities: [],
            acceptanceCriteria: [],
            missionType: null,
            requiresOwner: false,
            observedAt: new Date().toISOString(),
          },
        ],
        now: new Date(),
      });

      await observing();
      const result = await harness.services.operatorService.tick();
      expect(result.coverage.find((entry) => entry.projectId === created.id)?.state).not.toBe(
        'observed',
      );

      const record = await harness.services.opportunities.findByKey('b'.repeat(32));
      expect(record?.state).toBe('open');
    });
  });

  /* ------------------------------------------------------------ executing */

  describe('turning what it noticed into work', () => {
    /**
     * A project with a real repository and something visibly wrong with it.
     *
     * The blocker is recorded the way a person records one, so the status engine produces a real
     * `active_blocker` attention reason with a real rule and real evidence — which is the only
     * kind of thing the loop will act on.
     */
    /*
     * One repository, named. `code.change` refuses a `*` scope — naming three repositories is a
     * small cost, naming all of them by accident is not — so the fixture has to name this one in
     * the charter, exactly as an owner would.
     */
    const BLOCKED_REPO = 'blocked-project';

    async function projectWithABlocker(name: string) {
      const created = await harness.services.projects.create(
        projectInputSchema.parse({ name, type: 'software' }),
      );
      /* A repository of its own: the qualification sandbox already belongs to another project. */
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

    /**
     * The worker's half of planning, done by hand.
     *
     * Through `planning` first, exactly as `WorkerService.submitPlan` does it: the state machine
     * has no `inspecting → awaiting_plan_approval`, so a fixture that jumped straight there would
     * silently leave the mission inspecting and test nothing.
     */
    async function storeWorkerPlan(missionId: string) {
      const { missions, missionRepo } = harness.services;
      const mission = await missionRepo.findById(missionId);
      const planning = await missions.tryMove(mission!, 'planning', 'worker', {});
      await missions.storePlan(planning, PLAN, 'worker_inspection', 'verified', null);
    }

    /**
     * Qualified to write, under a charter that grants what fixing a bug actually takes.
     *
     * All five capabilities, because a bug fix is not one act: diagnose it, change the code, add
     * the test, make the branch, open the pull request. A charter that granted only the first
     * would authorise the diagnosis and refuse everything that makes it useful — which is what the
     * `falls back to a proposal` case below deliberately does.
     */
    async function operating(projectIds: readonly string[]) {
      const { charterService } = harness.services;
      await qualifyToLiveWrite(harness);
      const version = await charterService.draft({
        content: charter({
          projectIds: [...projectIds],
          grants: [
            {
              capability: 'bug.diagnose',
              scope: { projects: ['*'], repositories: ['*'] },
            } as GrantInput,
            {
              capability: 'code.change',
              scope: {
                projects: ['*'],
                repositories: [`test-owner/${BLOCKED_REPO}`],
                branches: ['jarvis/*'],
              },
            } as GrantInput,
            {
              capability: 'test.add',
              scope: {
                projects: ['*'],
                repositories: [`test-owner/${BLOCKED_REPO}`],
                branches: ['jarvis/*'],
              },
            } as GrantInput,
            {
              capability: 'branch.create',
              scope: {
                projects: ['*'],
                repositories: [`test-owner/${BLOCKED_REPO}`],
                branches: ['jarvis/*'],
              },
            } as GrantInput,
            {
              capability: 'pull_request.open',
              scope: { projects: ['*'], repositories: [`test-owner/${BLOCKED_REPO}`] },
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

    it('starts nothing while it is only observing', async () => {
      const created = await projectWithABlocker('Observed only');
      await harness.services.charterService.setMode({
        to: 'observer',
        actor: 'owner',
        changedBy: 'owner',
      });

      const result = await harness.services.operatorService.tick();
      expect(result.started).toEqual([]);
      expect(result.backlog.some((entry) => entry.opportunity.projectId === created.id)).toBe(true);
    });

    /*
     * Supervised mode is the one that proposes. The mission exists, it has a plan, and it waits —
     * which is exactly what "propose and wait for me on each one" has to mean.
     */
    it('proposes a mission and waits, while supervised', async () => {
      const created = await projectWithABlocker('Supervised');
      const { charterService, operatorService, missionRepo } = harness.services;
      await charterService.setMode({ to: 'supervised', actor: 'owner', changedBy: 'owner' });

      const result = await operatorService.tick();
      const started = result.started.filter((entry) => entry.missionId !== null);
      expect(started.length).toBeGreaterThan(0);

      const mission = await missionRepo.findById(started[0]!.missionId as string);
      expect(mission?.projectId).toBe(created.id);
      expect(mission?.autonomous).toBe(false);
      expect(['awaiting_plan_approval', 'needs_clarification']).toContain(mission?.state);
    });

    /*
     * Two ticks, because that is how it really works.
     *
     * Planning is asynchronous: the first tick raises the mission and a worker inspects it; only
     * once there is a plan is there anything to authorise. A loop that could not come back for its
     * own work on a later pass would start things forever and run none of them.
     */
    it('queues a mission on its own once the charter covers it', async () => {
      const created = await projectWithABlocker('Operated');
      await operating([created.id]);

      const first = await harness.services.operatorService.tick();
      const raised = first.started.find((entry) => entry.missionId !== null);
      expect(raised, JSON.stringify(first.started)).toBeDefined();
      expect(raised?.outcome).toBe('proposed');

      /* The worker's half: it inspects and stores a plan. */
      const inspecting = await harness.services.missionRepo.findById(raised!.missionId as string);
      expect(inspecting?.state).toBe('inspecting');
      await storeWorkerPlan(inspecting!.id);

      const result = await harness.services.operatorService.tick();
      const queued = result.started.find((entry) => entry.outcome === 'queued');
      expect(queued, JSON.stringify(result.started)).toBeDefined();

      const mission = await harness.services.missionRepo.findById(queued!.missionId as string);
      expect(mission?.state).toBe('queued');
      expect(mission?.autonomous).toBe(true);
      expect(mission?.charterVersionId).not.toBeNull();

      /* The timeline says a person did not do this. */
      const detail = await harness.services.missions.detail(mission!.id);
      expect(detail.events.some((event) => event.actor === 'charter')).toBe(true);
      expect(detail.events.find((event) => event.type === 'mission_created')?.summary).toMatch(
        /raised this itself/,
      );
    });

    /*
     * The plan is only knowable after planning, so a charter that covers the opportunity's guess
     * may still fall short of what the plan turns out to need. That must become a proposal, not a
     * refusal and not a silent widening.
     */
    it('falls back to a proposal when the charter does not cover the plan', async () => {
      const created = await projectWithABlocker('Half covered');
      const { charterService } = harness.services;
      await qualifyToLiveRead(harness);
      const version = await charterService.draft({
        content: charter({
          projectIds: [created.id],
          /* Enough to look, never enough to change anything. */
          grants: [
            {
              capability: 'research.read',
              scope: { projects: ['*'] },
            } as GrantInput,
          ],
        }),
        authoredBy: 'owner',
      });
      await charterService.activate(version.id, 'owner');
      await charterService.setMode({ to: 'supervised', actor: 'owner', changedBy: 'owner' });
      await charterService.setMode({ to: 'operator', actor: 'owner', changedBy: 'owner' });

      const first = await harness.services.operatorService.tick();
      const raised = first.started.find((entry) => entry.missionId !== null);
      expect(raised, JSON.stringify(first.started)).toBeDefined();

      await storeWorkerPlan(raised!.missionId as string);

      const result = await harness.services.operatorService.tick();
      const proposed = result.started.find((entry) => entry.outcome === 'proposed');
      expect(proposed, JSON.stringify(result.started)).toBeDefined();
      expect(proposed?.reason).toMatch(/does not grant|Waiting for you/);

      const mission = await harness.services.missionRepo.findById(proposed!.missionId as string);
      expect(mission?.autonomous).toBe(false);
      expect(mission?.state).not.toBe('queued');
    });

    /* One opportunity, one mission, however many ticks run over it. */
    it('does not start the same thing twice', async () => {
      const created = await projectWithABlocker('Once only');
      await operating([created.id]);

      const first = await harness.services.operatorService.tick();
      const second = await harness.services.operatorService.tick();
      const third = await harness.services.operatorService.tick();

      const startedIds = [...first.started, ...second.started, ...third.started]
        .map((entry) => entry.missionId)
        .filter((id): id is string => id !== null);
      expect(new Set(startedIds).size).toBe(startedIds.length);

      const backlog = await harness.services.operatorService.backlog();
      const taken = backlog.filter((entry) => entry.state === 'taken');
      expect(taken.every((entry) => entry.missionId !== null)).toBe(true);
    });

    it('records the tick as having done work, with a summary that says so', async () => {
      const created = await projectWithABlocker('Recorded');
      await operating([created.id]);

      const first = await harness.services.operatorService.tick();
      const raised = first.started.find((entry) => entry.missionId !== null);
      await storeWorkerPlan(raised!.missionId as string);
      await harness.services.operatorService.tick();

      const ticks = await harness.services.operatorService.recentTicks();
      const worked = ticks.find((tick) => tick.outcome === 'worked');
      expect(worked).toBeDefined();
      expect(worked?.missionsStarted).toBeGreaterThan(0);
      expect(worked?.summary).toMatch(/started/);
    });
  });

  /* ------------------------------------------------------------- releasing */

  describe('putting a mission back down', () => {
    /*
     * The unwind, which had never been exercised.
     *
     * When an approval turns out to be invalid between queueing and claiming, the mission has to
     * go back somewhere a later claim can find it. The previous version went straight for
     * `awaiting_plan_approval` — a move the state machine does not have from `claimed` — so
     * `tryMove` swallowed the conflict and the mission stayed in `claimed` with no run and no
     * worker: invisible to every queue and every ceiling, and stuck there until found by hand.
     */
    it('returns a mission whose approval vanished, rather than leaving it stuck', async () => {
      const { missions, missionRepo, approvals, workerService } = harness.services;

      const project = await harness.services.projects.create(
        projectInputSchema.parse({ name: 'Released', type: 'software' }),
      );
      await harness.services.sources.addGithubSource(project.id, {
        owner: 'test-owner',
        repo: 'released',
        isPrimary: true,
      });
      const mission = await missionRepo.create({
        rawRequest: 'Tidy the importer.',
        title: 'Tidy the importer',
        type: 'code_change',
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
      await missions.storePlan(mission, PLAN, 'jarvis_deterministic', 'verified', null);
      await missions.approvePlan(
        mission.id,
        { planVersion: 1, acknowledgedRiskLevel: 'low', pausedProjectOverride: false },
        'owner',
      );

      /* The approval goes without the mission's own columns changing, so the claim still matches. */
      await approvals.revokeAll(mission.id, 'Withdrawn.');

      const enrolled = await workerService.enrol('release-worker', 2);
      const claimed = await workerService.claim(enrolled.worker.id, {
        heartbeat: HEARTBEAT,
        accepts: ['execution'],
      });

      expect(claimed).toBeNull();
      const after = await missionRepo.findById(mission.id);
      expect(after?.state).toBe('awaiting_plan_approval');
      expect(after?.activeRunId).toBeNull();
      expect(after?.claimedByWorkerId).toBeNull();

      /* And an owner can see that it was picked up and put down again. */
      const detail = await missions.detail(mission.id);
      expect(detail.events.some((event) => event.type === 'policy_refusal')).toBe(true);
    });
  });

  /* -------------------------------------------------------------- the money */

  describe('the spend ledger', () => {
    let counter = 0;

    async function runningMission() {
      counter += 1;
      const project = await harness.services.projects.create(
        projectInputSchema.parse({ name: `Ledger ${counter}`, type: 'software' }),
      );
      await harness.services.sources.addGithubSource(project.id, {
        owner: 'test-owner',
        repo: `ledger-${counter}`,
        isPrimary: true,
      });
      const mission = await harness.services.missionRepo.create({
        rawRequest: 'Tidy the importer.',
        title: `Tidy the importer ${counter}`,
        type: 'code_change',
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
      await harness.services.missions.approvePlan(
        mission.id,
        { planVersion: 1, acknowledgedRiskLevel: 'low', pausedProjectOverride: false },
        'owner',
      );
      const enrolled = await harness.services.workerService.enrol(`ledger-worker-${counter}`, 2);
      const assignment = await harness.services.workerService.claim(enrolled.worker.id, {
        heartbeat: HEARTBEAT,
        accepts: ['execution'],
      });
      expect(assignment).not.toBeNull();
      return { workerId: enrolled.worker.id, runId: assignment!.runId, missionId: mission.id };
    }

    /*
     * The worker reports the run's total so far, not the delta since its last report. Appending
     * those would count the same tokens once per report, which is how a spending ledger comes to
     * say a mission cost four times what it did.
     */
    it('replaces one row per run rather than appending a running total', async () => {
      const { workerId, runId, missionId } = await runningMission();

      await harness.services.workerService.reportRunState(workerId, {
        runId,
        usage: { inputTokens: 1000, outputTokens: 200, totalCostUsd: 0.4, turns: 2 },
      });
      await harness.services.workerService.reportRunState(workerId, {
        runId,
        usage: { inputTokens: 3000, outputTokens: 900, totalCostUsd: 1.25, turns: 6 },
      });

      const records = await harness.services.usage.list({ missionId });
      expect(records).toHaveLength(1);
      expect(records[0]?.outputTokens).toBe(900);
      expect(records[0]?.reportedCostUsd).toBeCloseTo(1.25, 6);
      expect(records[0]?.costBasis).toBe('reported');

      const totals = await harness.services.usage.totals({ missionId });
      expect(totals.reportedUsd).toBeCloseTo(1.25, 6);
      expect(totals.recordCount).toBe(1);
    });

    /*
     * An absent cost is unknown, never zero. Zero is a claim that something was free, and a budget
     * computed from zeroes is a budget that does not hold — which `spendIsMeasurable` then says.
     */
    it('records an absent cost as unknown rather than as free', async () => {
      const { workerId, runId, missionId } = await runningMission();
      await harness.services.workerService.reportRunState(workerId, {
        runId,
        usage: { inputTokens: 500, outputTokens: 100 },
      });

      const totals = await harness.services.usage.totals({ missionId });
      expect(totals.unknownCount).toBe(1);
      expect(totals.reportedUsd).toBe(0);
      const records = await harness.services.usage.list({ missionId });
      expect(records[0]?.costBasis).toBe('unknown');
      expect(records[0]?.reportedCostUsd).toBeNull();
    });

    /*
     * The whole point of the ledger, exercised through the decision that reads it: a charter's
     * daily limit is about a total, so once the total is reached the next plan is refused however
     * cheap it claims to be.
     */
    it('refuses a plan once the charter’s daily limit has already gone', async () => {
      const { charterService } = harness.services;
      const version = await charterService.draft({
        content: charter({
          grants: [
            { capability: 'project.status.update', scope: { projects: ['*'] } } as GrantInput,
          ],
          limits: { dailySpendUsd: 1 },
        }),
        authoredBy: 'owner',
      });
      await charterService.activate(version.id, 'owner');
      await charterService.setMode({ to: 'supervised', actor: 'owner', changedBy: 'owner' });
      await charterService.setMode({ to: 'operator', actor: 'owner', changedBy: 'owner' });

      const cheap = await charterService.decide(
        request({
          capabilities: [ask({ capability: 'project.status.update' })],
          estimatedSpendUsd: 0.1,
        }),
      );
      expect(cheap.decision.outcome).not.toBe('needs_owner');

      /* Spend the limit through a real run report, not by writing the ledger directly. */
      const { workerId, runId } = await runningMission();
      await harness.services.workerService.reportRunState(workerId, {
        runId,
        usage: { inputTokens: 40_000, outputTokens: 9_000, totalCostUsd: 1.5 },
      });

      const after = await charterService.decide(
        request({
          capabilities: [ask({ capability: 'project.status.update' })],
          estimatedSpendUsd: 0.1,
        }),
      );
      expect(after.decision.outcome).toBe('needs_owner');
      expect(after.decision.verdicts[0]?.rule).toBe('R-AU7');
      expect(after.decision.verdicts[0]?.reason).toMatch(/already spent/);
    });
  });

  /* ------------------------------------------- the whole path, end to end */

  describe('approving on standing authority', () => {
    let counter = 0;

    /*
     * A mission of the given type with a stored plan, sitting at `awaiting_plan_approval`.
     *
     * The project gets a real GitHub source because a mission's repository is *resolved* from the
     * project's sources rather than read off the mission row, and a fixture that set the mission's
     * own columns would exercise a path no real mission takes.
     */
    async function readyMission(type: 'code_change' | 'project_review' = 'project_review') {
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
        type,
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
     * A deployment that has genuinely climbed to `live_read`, operating under a charter that
     * grants what a read-only mission actually needs.
     *
     * The rung matters. Below `live_read` the charter authorises nothing that runs a model — which
     * is correct, and also means the autonomous path cannot be exercised at all, so a fixture that
     * stayed at `automated` would leave the most important behaviour here untested.
     */
    async function operatingAtLiveRead() {
      const { charterService } = harness.services;
      await qualifyToLiveRead(harness);

      const version = await charterService.draft({
        content: charter({
          grants: [
            {
              capability: 'repository.audit',
              scope: { projects: ['*'], repositories: [QUALIFIED_SANDBOX, '*'] },
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

    /*
     * A recorded, authorised decision for this mission, asking for exactly what the mission will
     * need.
     *
     * Derived rather than named, because that is how the operator will build it and because a
     * decision that does not cover the plan is refused at approval — the request naming the
     * project is not optional either: a scoped capability with nothing named is refused under
     * R-AU4 before the charter is consulted at all.
     */
    async function authorised(missionId: string, projectId: string) {
      const mission = await harness.services.missionRepo.findById(missionId);
      const { stored, decision } = await harness.services.charterService.decide(
        request({
          missionId,
          capabilities: [
            ...missionCapabilityRequests({
              type: mission!.type,
              plan: PLAN,
              projectId,
              repository: QUALIFIED_SANDBOX,
              branch: null,
              reason: 'the plan said so',
            }),
          ],
        }),
      );
      expect(decision.outcome, decision.summary).toBe('authorized');
      return stored!;
    }

    /*
     * The composition, stated plainly.
     *
     * A charter is the owner saying yes. It is not, and must never become, evidence that the
     * deployment can do the thing safely — and the owner cannot fix this by granting more, which
     * is why the verdict reports `ownerCanGrant: false`.
     */
    it('refuses what the deployment has not qualified for, however generous the charter', async () => {
      const { charterService } = harness.services;
      await operatingAtLiveRead();

      const generous = await charterService.draft({
        content: charter({
          grants: [
            {
              capability: 'repository.audit',
              scope: { projects: ['*'], repositories: ['*'] },
            } as GrantInput,
            {
              capability: 'code.change',
              scope: {
                projects: ['*'],
                repositories: ['test-owner/invoices-1'],
                branches: ['jarvis/*'],
              },
            } as GrantInput,
          ],
        }),
        authoredBy: 'owner',
      });
      await charterService.activate(generous.id, 'owner');

      const { missionId, projectId } = await readyMission('code_change');
      const { decision } = await charterService.decide(
        request({
          missionId,
          capabilities: [
            ask({
              capability: 'code.change',
              projectId,
              repository: 'test-owner/invoices-1',
              branch: 'jarvis/change',
            }),
          ],
        }),
      );
      expect(decision.outcome).toBe('refused');
      const verdict = decision.verdicts.find((entry) => entry.capability === 'code.change');
      expect(verdict?.allowed).toBe(false);
      /* R-AU5 is the qualification rule, and the owner cannot grant their way past it. */
      expect(verdict?.rule).toBe('R-AU5');
      expect(verdict?.ownerCanGrant).toBe(false);
    });

    it('records which charter approved it, and shows the charter in the timeline', async () => {
      const { missions, approvals, missionRepo } = harness.services;
      const version = await operatingAtLiveRead();
      const { missionId, projectId } = await readyMission();
      const decision = await authorised(missionId, projectId);

      const queued = await missions.approvePlan(
        missionId,
        { planVersion: 1, acknowledgedRiskLevel: 'low', pausedProjectOverride: false },
        'owner',
        { kind: 'charter', decisionId: decision.id },
      );

      expect(queued.state).toBe('queued');
      expect(queued.autonomous).toBe(true);
      expect(queued.charterVersionId).toBe(version.id);
      expect(queued.authorizationDecisionId).toBe(decision.id);

      const approval = await approvals.activeFor(missionId);
      expect(approval?.approvedBy).toBe('charter');
      expect(approval?.charterVersionId).toBe(version.id);
      expect(approval?.charterDigest).toBe(version.digest);

      const detail = await missions.detail(missionId);
      const approved = detail.events.find((event) => event.type === 'plan_approved');
      expect(approved?.actor).toBe('charter');
      expect(approved?.summary).toContain('without asking you');

      expect((await missionRepo.findById(missionId))?.autonomous).toBe(true);
    });

    /*
     * The heart of the increment.
     *
     * The deployment has qualified for nothing. A mission standing authority queued must sit in
     * the queue rather than being handed to a worker, and an identical mission a person approved
     * must be handed over in the same breath — otherwise the gate is not a gate, it is an outage.
     *
     * The flag is set directly here rather than through the approval path, because the two are
     * independent claims and this one is about the claim query: whatever put the flag there, an
     * unqualified worker must not be given the mission.
     */
    it('will not hand an autonomous mission to a worker on an unqualified deployment', async () => {
      const { missions, missionRepo, workerService, qualificationService } = harness.services;
      expect(await qualificationService.currentLevel()).toBe('built');

      const autonomous = await readyMission('code_change');
      await missions.approvePlan(
        autonomous.missionId,
        { planVersion: 1, acknowledgedRiskLevel: 'low', pausedProjectOverride: false },
        'owner',
      );
      await missionRepo.patch(autonomous.missionId, { autonomous: true });

      const enrolled = await workerService.enrol('worker-1', 2);
      const refused = await workerService.claim(enrolled.worker.id, {
        heartbeat: HEARTBEAT,
        accepts: ['execution'],
      });
      expect(refused).toBeNull();
      expect((await missionRepo.findById(autonomous.missionId))?.state).toBe('queued');

      /* The same work, approved by a person, is handed over immediately. */
      const attended = await readyMission('code_change');
      await missions.approvePlan(
        attended.missionId,
        { planVersion: 1, acknowledgedRiskLevel: 'low', pausedProjectOverride: false },
        'owner',
      );
      const handed = await workerService.claim(enrolled.worker.id, {
        heartbeat: HEARTBEAT,
        accepts: ['execution'],
      });
      expect(handed?.missionId).toBe(attended.missionId);
    });

    /*
     * The gap this closes.
     *
     * Every other check passes: the decision exists, it came out authorised, it was made for this
     * mission, and it cites the charter in force. It is simply not *about* this work — permission
     * to read a repository is not permission to rewrite one — and until the capabilities were
     * compared, nothing anywhere noticed.
     */
    it('refuses an authorisation that does not cover what the mission will do', async () => {
      const { charterService, missions, missionRepo } = harness.services;
      await operatingAtLiveRead();
      const { missionId, projectId } = await readyMission('code_change');

      /* Asked for, and granted, only what a read-only audit needs. */
      const { decision, stored } = await charterService.decide(
        request({
          missionId,
          capabilities: [
            ask({
              capability: 'repository.audit',
              projectId,
              repository: QUALIFIED_SANDBOX,
            }),
          ],
        }),
      );
      expect(decision.outcome).toBe('authorized');

      await expect(
        missions.approvePlan(
          missionId,
          { planVersion: 1, acknowledgedRiskLevel: 'low', pausedProjectOverride: false },
          'owner',
          { kind: 'charter', decisionId: stored!.id },
        ),
      ).rejects.toThrow(/does not cover/);

      const after = await missionRepo.findById(missionId);
      expect(after?.state).toBe('awaiting_plan_approval');
      expect(after?.autonomous).toBe(false);
    });

    it('refuses a decision made for a different mission', async () => {
      const { missions, missionRepo } = harness.services;
      await operatingAtLiveRead();
      const one = await readyMission();
      const two = await readyMission();
      const decision = await authorised(one.missionId, one.projectId);

      await expect(
        missions.approvePlan(
          two.missionId,
          { planVersion: 1, acknowledgedRiskLevel: 'low', pausedProjectOverride: false },
          'owner',
          { kind: 'charter', decisionId: decision.id },
        ),
      ).rejects.toBeInstanceOf(ForbiddenError);
      expect((await missionRepo.findById(two.missionId))?.state).toBe('awaiting_plan_approval');
    });

    /*
     * A decision cites a charter by id *and* by digest. Activating a different charter afterwards
     * must invalidate it — otherwise "authorised in March" quietly becomes "authorised now".
     */
    it('refuses a decision whose charter has since been replaced', async () => {
      const { charterService, missions } = harness.services;
      await operatingAtLiveRead();
      const { missionId, projectId } = await readyMission();
      const decision = await authorised(missionId, projectId);

      const replacement = await charterService.draft({
        content: charter({
          goals: [{ id: 'g2', statement: 'Something else entirely', priority: 1 }],
          grants: [
            {
              capability: 'repository.audit',
              scope: { projects: ['*'], repositories: ['*'] },
            } as GrantInput,
          ],
        }),
        authoredBy: 'owner',
      });
      await charterService.activate(replacement.id, 'owner');

      await expect(
        missions.approvePlan(
          missionId,
          { planVersion: 1, acknowledgedRiskLevel: 'low', pausedProjectOverride: false },
          'owner',
          { kind: 'charter', decisionId: decision.id },
        ),
      ).rejects.toThrow(/charter changed/);
    });

    /*
     * The acknowledged risk level is not relaxed for a machine. A decision made at T and applied
     * at T+1 against a mission whose risk changed in between is exactly the staleness the check
     * was written for; a machine reaches it by deciding early rather than by leaving a tab open.
     */
    it('still refuses an approval whose acknowledged risk is stale', async () => {
      const { missions, missionRepo } = harness.services;
      await operatingAtLiveRead();
      const { missionId, projectId } = await readyMission();
      const decision = await authorised(missionId, projectId);
      await missionRepo.patch(missionId, { riskLevel: 'high' });

      await expect(
        missions.approvePlan(
          missionId,
          { planVersion: 1, acknowledgedRiskLevel: 'low', pausedProjectOverride: false },
          'owner',
          { kind: 'charter', decisionId: decision.id },
        ),
      ).rejects.toThrow(/risk level changed/);
    });

    /*
     * An owner taking over a mission Jarvis queued must clear the flag, or the mission stays gated
     * on a ladder rung that no longer applies to it and quietly never runs.
     */
    it('clears the autonomous flag when a person takes the mission over', async () => {
      const { missions, missionRepo } = harness.services;
      await operatingAtLiveRead();
      const { missionId, projectId } = await readyMission();
      const decision = await authorised(missionId, projectId);
      await missions.approvePlan(
        missionId,
        { planVersion: 1, acknowledgedRiskLevel: 'low', pausedProjectOverride: false },
        'owner',
        { kind: 'charter', decisionId: decision.id },
      );
      expect((await missionRepo.findById(missionId))?.autonomous).toBe(true);

      await missionRepo.transition(missionId, 'awaiting_plan_approval', {
        approvedPlanVersion: null,
      });
      const retaken = await missions.approvePlan(
        missionId,
        { planVersion: 1, acknowledgedRiskLevel: 'low', pausedProjectOverride: false },
        'owner',
      );
      expect(retaken.autonomous).toBe(false);
      expect(retaken.charterVersionId).toBeNull();
    });
  });
});
