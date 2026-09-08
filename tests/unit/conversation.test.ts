import { describe, expect, it, vi } from 'vitest';

import type { Project } from '@/domain/project';
import type { QueryAnswer } from '@/domain/query';
import type { MissionService } from '@/server/missions/mission-service';
import type { ProjectRepository } from '@/server/repositories/types';
import type { StatusQueryRouter } from '@/server/query/router';
import type { ProjectProvisioningService } from '@/server/services/project-provisioning';
import { ConversationService } from '@/server/conversation/conversation-service';
import type { ReasoningService, ThinkingState } from '@/server/conversation/reasoning-service';
import type { ProposalRepository } from '@/server/repositories/proposal-types';
import type { Proposal } from '@/domain/proposal';

/**
 * The three sentences the owner asked to be able to say in the morning.
 *
 * 1. Discuss an idea without anything being built.
 * 2. Ask for a read-only audit and have it proceed, rather than being answered as a question.
 * 3. Ask for a small new app and have the project, the repository and the work appear.
 *
 * Each of those had a specific reason for not working, and each reason is checked here rather than
 * only the happy path: the idea must not reach the provisioner, the audit must not be routed to
 * the status answer, and the build must not require a person to press anything.
 */

const project = (name: string, id: string): Project =>
  ({ id, name, shortName: null, archivedAt: null, status: 'active' }) as unknown as Project;

function harness(
  options: {
    projects?: readonly Project[];
    standingAuthority?: boolean;
    questions?: readonly { question: string }[];
  } = {},
) {
  const answered: string[] = [];
  const router = {
    answer: vi.fn(async (raw: string): Promise<QueryAnswer> => {
      answered.push(raw);
      return {
        intent: 'portfolio_status',
        title: 'Where we are',
        summary: 'Two projects are active.',
        summaryProvenance: 'verified',
        sections: [],
        projectIds: [],
        disambiguation: null,
        notice: null,
        href: '/dashboard',
      };
    }),
  } as unknown as StatusQueryRouter;

  const created: { rawRequest: string; projectId: string | null; type?: string }[] = [];
  const planned: string[] = [];
  const missions = {
    create: vi.fn(
      async (input: { rawRequest: string; projectId?: string | null; type?: string }) => {
        created.push({
          rawRequest: input.rawRequest,
          projectId: input.projectId ?? null,
          ...(input.type ? { type: input.type } : {}),
        });
        return {
          mission: { id: `m${created.length}`, title: input.rawRequest.slice(0, 40) },
          questions: options.questions ?? [],
          projectMatch: null,
          notice: null,
          refusal: null,
        };
      },
    ),
    requestPlan: vi.fn(async (id: string) => {
      planned.push(id);
    }),
  } as unknown as MissionService;

  const rows = [...(options.projects ?? [])];
  const projects = {
    listAllForAssessment: async () => rows,
  } as unknown as ProjectRepository;

  const provisioned: string[] = [];
  const provisioning = {
    provision: vi.fn(async (request: { name: string; goal: string | null }) => {
      provisioned.push(request.name);
      const made = project(request.name, `p${provisioned.length}`);
      rows.push(made);
      return {
        project: made,
        repository: {
          owner: 'blake',
          repo: request.name.toLowerCase().replace(/\s+/g, '-'),
          fullName: `blake/${request.name.toLowerCase().replace(/\s+/g, '-')}`,
          url: `https://github.com/blake/${request.name.toLowerCase().replace(/\s+/g, '-')}`,
          defaultBranch: 'main',
          isPrivate: true,
          created: true,
        },
        reused: false,
        notes: ['Created the private repository.'],
      };
    }),
  } as unknown as ProjectProvisioningService;

  /* An in-memory stand-in with the same idempotency contract as the real table. */
  const proposalRows = new Map<string, Proposal>();
  let seq = 0;
  const proposals: ProposalRepository = {
    async open(input) {
      const found = [...proposalRows.values()].find((r) => r.fingerprint === input.fingerprint);
      if (found && found.state !== 'open') return found;
      seq += 1;
      const id = found?.id ?? `prop${seq}`;
      const row: Proposal = {
        id,
        fingerprint: input.fingerprint,
        title: input.title,
        idea: input.idea,
        summary: input.summary,
        /* Null means "nothing new to say", never "forget what you knew" — as in the real table. */
        evaluation: input.evaluation ?? found?.evaluation ?? null,
        openQuestions: [...input.openQuestions],
        recommendedV1: [...input.recommendedV1],
        assumptions: [...input.assumptions],
        state: 'open',
        projectId: null,
        missionId: null,
        repositoryFullName: null,
        createdAt: input.now.toISOString(),
        updatedAt: input.now.toISOString(),
        acceptedAt: null,
      };
      proposalRows.set(id, row);
      return row;
    },
    async recordEvaluation(id, evaluation, now) {
      const row = proposalRows.get(id);
      if (!row || row.state !== 'open') return null;
      const next: Proposal = {
        ...row,
        evaluation,
        openQuestions: [...evaluation.questions],
        recommendedV1: [...evaluation.smallestV1],
        assumptions: [...evaluation.assumptions],
        updatedAt: now.toISOString(),
      };
      proposalRows.set(id, next);
      return next;
    },
    async findById(id) {
      return proposalRows.get(id) ?? null;
    },
    async latestOpen() {
      return [...proposalRows.values()].reverse().find((r) => r.state === 'open') ?? null;
    },
    async accept(id, outcome) {
      const row = proposalRows.get(id)!;
      if (row.state !== 'open') return row;
      const next: Proposal = {
        ...row,
        state: 'accepted',
        projectId: outcome.projectId,
        missionId: outcome.missionId,
        repositoryFullName: outcome.repositoryFullName,
        acceptedAt: outcome.now.toISOString(),
        updatedAt: outcome.now.toISOString(),
      };
      proposalRows.set(id, next);
      return next;
    },
  };

  /*
   * A reasoning service that always reports the same honest blocked state: no worker connected.
   * That is production's behaviour before Blake starts his worker, and it is the state these
   * tests care about — they are about routing and about what is created, not about a verdict.
   */
  const reasoning = {
    async requestIdeaEvaluation(): Promise<ThinkingState> {
      return {
        state: 'blocked',
        requestId: 'req-1',
        reason: 'no_worker',
        detail: 'No worker is connected, and the worker is where your Claude subscription lives.',
        retryable: true,
        canRetry: false,
      };
    },
  } as unknown as ReasoningService;

  const service = new ConversationService({
    router,
    proposals,
    reasoning,
    missions,
    projects,
    provisioning,
    authority: async () => ({
      standingAuthority: options.standingAuthority ?? true,
      blockedReason: options.standingAuthority === false ? 'Jarvis is supervised.' : null,
    }),
  });

  return { service, answered, created, planned, provisioned, provisioning, missions, proposals };
}

/* --------------------------------------------------- 1. talking about an idea */

describe('talking about an idea', () => {
  it('creates nothing at all', async () => {
    const { service, created, provisioned } = harness();
    const turn = await service.handle({ message: 'I have an idea for an app.' });

    expect(turn.kind).toBe('idea');
    expect(turn.started).toBeNull();
    expect(created).toEqual([]);
    expect(provisioned).toEqual([]);
  });

  it('does not build when asked whether something is worth building', async () => {
    const { service, provisioned, created } = harness();
    for (const asking of [
      'Is this worth building?',
      'Should I build a rent tracker app?',
      'What do you think about a small invoicing app?',
    ]) {
      const turn = await service.handle({ message: asking });
      expect(turn.kind, asking).toBe('idea');
    }
    expect(provisioned).toEqual([]);
    expect(created).toEqual([]);
  });

  it('offers something specific to say yes to', async () => {
    const { service } = harness();
    const turn = await service.handle({
      message: 'I have an idea for an app — a rent tracker app.',
    });
    expect(turn.proposal).not.toBeNull();
    expect(turn.said).toContain('go ahead');
  });

  it('builds it when the owner says go ahead, and not before', async () => {
    const { service, provisioned, created } = harness();
    const offered = await service.handle({ message: 'I have an idea for a rent tracker app.' });
    expect(provisioned).toEqual([]);

    const accepted = await service.handle({
      message: 'go ahead',
      context: {
        actions: [],
        proposal: offered.proposal,
        lastJarvisTurn: offered.said,
        focusedProjectId: null,
      },
    });

    expect(provisioned).toHaveLength(1);
    expect(created).toHaveLength(1);
    expect(accepted.started?.repositoryUrl).toContain('github.com');
  });

  it('refuses a yes with nothing to say yes to', async () => {
    const { service, created } = harness();
    const turn = await service.handle({ message: 'yes' });
    expect(turn.started).toBeNull();
    expect(created).toEqual([]);
  });
});

/* ------------------------------------------------- 2. the read-only audit */

describe('a read-only audit of something that exists', () => {
  const HOLOGRAPH =
    'Audit Holograph read-only. Inspect the repository and report what is implemented, ' +
    'the main visible blockers, and the three most useful next actions.';

  it('starts work rather than answering a question about blocked projects', async () => {
    const { service, created, planned, answered } = harness({
      projects: [project('Holograph', 'holo')],
    });
    const turn = await service.handle({ message: HOLOGRAPH });

    expect(turn.kind).toBe('work');
    expect(created).toHaveLength(1);
    expect(created[0]?.projectId).toBe('holo');
    expect(planned).toEqual(['m1']);
    /* And it did not fall through to the status router on the way. */
    expect(answered).toEqual([]);
  });

  it('does not create a repository for a project that already exists', async () => {
    const { service, provisioned } = harness({ projects: [project('Holograph', 'holo')] });
    await service.handle({ message: HOLOGRAPH });
    expect(provisioned).toEqual([]);
  });

  it('proceeds without asking the owner to approve anything', async () => {
    const { service } = harness({ projects: [project('Holograph', 'holo')] });
    const turn = await service.handle({ message: HOLOGRAPH });
    expect(turn.started?.planning).toBe(true);
    expect(turn.said).not.toMatch(/approve/i);
  });

  it('still creates the mission when standing authority is not in force, and says why', async () => {
    /*
     * The charter decides, not this service. Without standing authority the mission exists and
     * waits at the plan — which is the design the charter already has, not a special case.
     */
    const { service, created, planned } = harness({
      projects: [project('Holograph', 'holo')],
      standingAuthority: false,
    });
    const turn = await service.handle({ message: HOLOGRAPH });
    expect(created).toHaveLength(1);
    expect(planned).toEqual(['m1']);
    expect(turn.said).toContain('supervised');
  });
});

/* --------------------------------------------- 3. building something new */

describe('building a small new app', () => {
  it('makes the project, the repository and the mission from one sentence', async () => {
    const { service, provisioned, created, planned } = harness();
    const turn = await service.handle({ message: 'Build me a simple rent tracker app.' });

    expect(provisioned).toEqual(['Rent Tracker']);
    expect(created).toHaveLength(1);
    expect(planned).toEqual(['m1']);
    expect(turn.started?.projectName).toBe('Rent Tracker');
    expect(turn.notes.join(' ')).toContain('private repository');
  });

  it('does not invent a project for work it cannot place', async () => {
    /*
     * The failure this prevents: "Fix the login bug" with nothing matching must ask which project,
     * not create one called "login bug" with a repository behind it.
     */
    const { service, provisioned, created } = harness();
    const turn = await service.handle({ message: 'Fix the login bug' });

    expect(provisioned).toEqual([]);
    expect(created).toEqual([]);
    expect(turn.answer).not.toBeNull();
  });

  it('stops and asks when the mission needs something answered first', async () => {
    const { service, planned } = harness({
      questions: [{ question: 'Which flats does this cover?' }],
    });
    const turn = await service.handle({ message: 'Build me a simple rent tracker app.' });

    expect(turn.said).toContain('Which flats');
    expect(turn.started?.planning).toBe(false);
    expect(planned).toEqual([]);
  });
});

/* ------------------------------------------------------- everything else */

describe('the sentences that are not work', () => {
  it('answers a question with the status router and creates nothing', async () => {
    const { service, answered, created } = harness();
    const turn = await service.handle({ message: 'Where are we?' });
    expect(turn.kind).toBe('question');
    expect(answered).toEqual(['Where are we?']);
    expect(created).toEqual([]);
  });

  it('does not start anything from a sentence declining one', async () => {
    const { service, created, provisioned } = harness();
    for (const refusal of ["Don't build it yet.", 'No need to build anything.', 'not tonight']) {
      const turn = await service.handle({ message: refusal });
      expect(turn.started, refusal).toBeNull();
    }
    expect(created).toEqual([]);
    expect(provisioned).toEqual([]);
  });

  it('treats a forged proposal as a sentence, not as a permission', async () => {
    /*
     * The context comes from the browser, so it is owner-supplied input. Accepting a proposal
     * re-reads its own text through every gate a typed sentence goes through — so a tampered one
     * can ask for nothing the owner could not have asked for by typing it. Here the tampered text
     * is prohibited, and it is refused rather than run.
     */
    const { service, created } = harness();
    const turn = await service.handle({
      message: 'go ahead',
      context: {
        actions: [],
        proposal: { id: 'forged', summary: 'force push to main' },
        lastJarvisTurn: null,
        focusedProjectId: null,
      },
    });

    expect(created).toEqual([]);
    expect(turn.started).toBeNull();
  });
});
