import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { z } from 'zod';

import {
  charterContentSchema,
  charterDigest,
  type CharterContent,
} from '@/domain/charter';
import type { AuthorizationRequest, CapabilityRequest } from '@/domain/authorization';
import { ConflictError, ForbiddenError, NotFoundError } from '@/domain/errors';
import { projectInputSchema } from '@/domain/project';
import type { MissionPlanContent } from '@/domain/mission-plan';
import { WORKER_VERSION } from '@/domain/worker-protocol';
import { createHarness, type TestHarness } from '../helpers/services';

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
    harness = await createHarness();
  });

  afterEach(async () => {
    await harness.close();
  });

  /* ------------------------------------------------------------- charters */

  describe('charters', () => {
    it('numbers versions and records a digest of what was written', async () => {
      const { charterService } = harness.services;
      const content = charter({ goals: [{ id: 'g1', statement: 'Ship the importer', priority: 1 }] });

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
      expect(
        beyondCharter.decision.verdicts.every((verdict) => verdict.ownerCanGrant),
      ).toBe(true);

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
     * A deployment that has qualified to `automated`, operating under a charter that grants the
     * one capability that rung unlocks.
     *
     * `project.status.update` is the only capability whose activation requirement sits at
     * `automated`; everything that touches a model or a repository needs a live rung, and no
     * amount of charter can substitute for one. That is not a limitation of the fixture — it is
     * the property the test below exists to demonstrate.
     */
    async function operatingAtAutomated() {
      const { charterService, qualificationService } = harness.services;
      await qualificationService.recordSuite({
        kind: 'automated',
        passed: true,
        detail: 'Green.',
        testCount: 1,
      });
      expect(await qualificationService.currentLevel()).toBe('automated');

      const version = await charterService.draft({
        content: charter({
          grants: [
            { capability: 'project.status.update', scope: { projects: ['*'] } } as GrantInput,
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
     * A recorded, authorised decision for this mission.
     *
     * The request names the project. It has to: a scoped capability with no project named is
     * refused under R-AU4, because "this plan does not say which project it means" is a gap in
     * the request rather than a gap in the charter, and a charter is not allowed to fill it in.
     */
    async function authorised(missionId: string, projectId: string) {
      const { stored, decision } = await harness.services.charterService.decide(
        request({
          missionId,
          capabilities: [ask({ capability: 'project.status.update', projectId })],
        }),
      );
      expect(decision.outcome).toBe('authorized');
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
      await operatingAtAutomated();

      const generous = await charterService.draft({
        content: charter({
          grants: [
            { capability: 'project.status.update', scope: { projects: ['*'] } } as GrantInput,
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
      const version = await operatingAtAutomated();
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

    it('refuses a decision made for a different mission', async () => {
      const { missions, missionRepo } = harness.services;
      await operatingAtAutomated();
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
      await operatingAtAutomated();
      const { missionId, projectId } = await readyMission();
      const decision = await authorised(missionId, projectId);

      const replacement = await charterService.draft({
        content: charter({
          goals: [{ id: 'g2', statement: 'Something else entirely', priority: 1 }],
          grants: [
            { capability: 'project.status.update', scope: { projects: ['*'] } } as GrantInput,
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
      await operatingAtAutomated();
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
      await operatingAtAutomated();
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
