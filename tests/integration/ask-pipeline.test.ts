import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { askTurnSchema } from '@/domain/answer-run';
import { FORGET_CONFIRMATION } from '@/domain/knowledge';
import { ForbiddenError } from '@/domain/errors';
import { projectInputSchema } from '@/domain/project';
import type { MemoryActor } from '@/server/knowledge/memory-service';
import { FakeAnswerProvider, scriptedAnswer } from '../helpers/fake-answer-provider';
import { createHarness, type TestHarness } from '../helpers/services';

/**
 * Ask Jarvis against a real migrated database.
 *
 * These are the claims a unit test cannot settle, because every one is about what survives a write
 * and what crosses a boundary. The important ones are negative — a canary planted in one project
 * never appears in another project's answer, its prompt, its stored evidence or its audit trail —
 * and negatives are asserted with unique improbable strings rather than with counts. A test that
 * asserts "two results" passes while one of them is the wrong project's; a test that asserts a
 * specific string is absent everywhere cannot.
 *
 * Every negative here is paired with a positive control in the same test, because "the canary was
 * absent" is worthless if the search returned nothing at all. Questions are therefore written to
 * share vocabulary with the notes they should find: the retrieval contract uses
 * `websearch_to_tsquery`, which requires every term, and a question that matches nothing would
 * make these tests pass for the wrong reason.
 */

const OWNER = 'owner@example.com';
const OWNER_ACTOR: MemoryActor = { actor: OWNER, actorKind: 'owner' };
const AGENT_ACTOR: MemoryActor = { actor: 'agent:analyst', actorKind: 'agent' };

const CANARY_A = 'zarquon-ask-alpha-canary-3312';
const CANARY_B = 'zarquon-ask-bravo-canary-7741';
const FORGOTTEN = 'zarquon-ask-forgotten-canary-5528';
const PENDING = 'zarquon-ask-pending-canary-6693';
const APPROVED = 'zarquon-ask-approved-canary-1180';

describe('the Ask Jarvis pipeline', () => {
  let harness: TestHarness;
  let provider: FakeAnswerProvider;

  beforeEach(async () => {
    provider = new FakeAnswerProvider();
    harness = await createHarness({ answerProvider: provider });
  });

  afterEach(async () => {
    await harness.close();
  });

  const ask = (input: Record<string, unknown>) =>
    harness.services.answerService.ask(askTurnSchema.parse(input), OWNER);

  async function makeProject(name: string): Promise<string> {
    const project = await harness.services.projects.create(
      projectInputSchema.parse({ name, type: 'software' }),
    );
    return project.id;
  }

  async function note(input: {
    title: string;
    text: string;
    projectId: string | null;
    sourceId?: string;
  }): Promise<string> {
    const outcome = await harness.services.ingestion.addNote({
      kind: 'note',
      ...(input.sourceId ? { sourceId: input.sourceId } : {}),
      title: input.title,
      scope: input.projectId ? 'project' : 'global',
      projectId: input.projectId,
      sensitivity: 'internal',
      addedBy: 'owner',
      text: input.text,
    });
    return outcome.sourceId;
  }

  /** Everything the answer could possibly have carried, in one string to search. */
  async function everythingSeenBy(answerId: string): Promise<string> {
    const evidence = await harness.services.answerRuns.listEvidence(answerId);
    const run = await harness.services.answerRuns.findForOwner(answerId, OWNER);
    return JSON.stringify({ evidence, run, prompts: provider.prompts });
  }

  /* ------------------------------------------------------------- isolation */

  describe('scope isolation', () => {
    it('gives a one-project answer nothing from any other project', async () => {
      const a = await makeProject('Alpha');
      const b = await makeProject('Bravo');
      await note({
        title: 'Alpha decisions',
        text: `We decided about auth: Alpha uses ${CANARY_A}.`,
        projectId: a,
      });
      await note({
        title: 'Bravo decisions',
        text: `We decided about auth: Bravo uses ${CANARY_B}.`,
        projectId: b,
      });

      provider.setAnswer(scriptedAnswer({ citations: [] }));
      const result = await ask({
        question: 'What did we decide about auth?',
        scope: 'project',
        projectIds: [a],
        idempotencyKey: 'iso-one-project-1',
      });

      const seen = await everythingSeenBy(result.run.id);
      expect(seen).toContain(CANARY_A);
      expect(seen).not.toContain(CANARY_B);
      expect(result.run.projectIds).toEqual([a]);
    });

    it('refuses a project the owner does not have', async () => {
      await makeProject('Alpha');
      await expect(
        ask({
          question: 'Where are we?',
          scope: 'project',
          projectIds: ['00000000-0000-4000-8000-000000000000'],
          idempotencyKey: 'iso-unauthorised-1',
        }),
      ).rejects.toThrow(/named a project/i);
    });

    it('refuses a follow-up that names a project outside the conversation', async () => {
      const a = await makeProject('Alpha');
      const b = await makeProject('Bravo');
      const conversation = await harness.services.answerService.startConversation(
        { scope: 'project', projectIds: [a] },
        OWNER,
      );

      await expect(
        ask({
          conversationId: conversation.id,
          question: 'And what about the other one?',
          projectIds: [b],
          idempotencyKey: 'iso-widen-11',
        }),
      ).rejects.toBeInstanceOf(ForbiddenError);
    });

    it('rebuilds the next turn under a narrowed scope rather than carrying evidence forward', async () => {
      const a = await makeProject('Alpha');
      const b = await makeProject('Bravo');
      await note({
        title: 'Alpha hosting',
        text: `The Alpha hosting arrangement is ${CANARY_A}.`,
        projectId: a,
      });
      await note({
        title: 'Bravo hosting',
        text: `The Bravo hosting arrangement is ${CANARY_B}.`,
        projectId: b,
      });

      const conversation = await harness.services.answerService.startConversation(
        { scope: 'selected', projectIds: [a, b] },
        OWNER,
      );

      const question = 'What is the hosting arrangement?';
      provider.setAnswer(scriptedAnswer({ citations: [] }));
      const wide = await ask({
        conversationId: conversation.id,
        question,
        idempotencyKey: 'rescope-wide-1',
      });
      const wideSeen = await everythingSeenBy(wide.run.id);
      expect(wideSeen).toContain(CANARY_A);
      expect(wideSeen).toContain(CANARY_B);

      await harness.services.answerService.rescopeConversation(
        conversation.id,
        { scope: 'project', projectIds: [a] },
        OWNER,
      );

      const promptsBefore = provider.prompts.length;
      const narrow = await ask({
        conversationId: conversation.id,
        question,
        idempotencyKey: 'rescope-narrow-1',
      });

      const evidence = JSON.stringify(
        await harness.services.answerRuns.listEvidence(narrow.run.id),
      );
      const promptsSince = provider.prompts.slice(promptsBefore).join('\n');
      /* The positive control: the narrowed turn still answers, from Alpha alone. */
      expect(evidence).toContain(CANARY_A);
      expect(evidence).not.toContain(CANARY_B);
      /* And the earlier turn's prose is dropped too, rather than smuggled in as history. */
      expect(promptsSince).not.toContain(CANARY_B);
      expect(narrow.run.projectIds).toEqual([a]);
    });
  });

  /* -------------------------------------------------------------- memories */

  describe('what memories may say', () => {
    it('never lets a memory awaiting approval reach the model', async () => {
      const project = await makeProject('Alpha');
      await harness.services.memoryService.remember(
        {
          scope: 'project',
          projectId: project,
          category: 'preference',
          statement: `I prefer to deploy with ${APPROVED}.`,
          tags: [],
        },
        OWNER_ACTOR,
      );
      await harness.services.memoryService.propose(
        {
          scope: 'project',
          projectId: project,
          category: 'preference',
          origin: 'model_suggested',
          statement: `I prefer to deploy with ${PENDING}.`,
          excerpts: [],
          tags: [],
        },
        AGENT_ACTOR,
      );

      provider.setAnswer(scriptedAnswer({ citations: [] }));
      const result = await ask({
        question: 'What do I prefer about deploys?',
        scope: 'project',
        projectIds: [project],
        idempotencyKey: 'memory-pending-1',
      });

      const seen = await everythingSeenBy(result.run.id);
      /* The approved one is the control: retrieval worked, and only the suggestion was withheld. */
      expect(seen).toContain(APPROVED);
      expect(seen).not.toContain(PENDING);
    });

    it('cannot resurrect a forgotten memory through a later turn', async () => {
      const project = await makeProject('Alpha');
      const remembered = await harness.services.memoryService.remember(
        {
          scope: 'project',
          projectId: project,
          category: 'preference',
          statement: `I prefer to deploy only on ${FORGOTTEN}.`,
          tags: [],
        },
        OWNER_ACTOR,
      );

      provider.setAnswer(scriptedAnswer({ citations: [] }));
      const conversation = await harness.services.answerService.startConversation(
        { scope: 'project', projectIds: [project] },
        OWNER,
      );
      const question = 'What do I prefer about deploys?';
      const first = await ask({
        conversationId: conversation.id,
        question,
        idempotencyKey: 'memory-forget-1',
      });
      expect(await everythingSeenBy(first.run.id)).toContain(FORGOTTEN);

      await harness.services.memoryService.forget(
        remembered.item.id,
        { confirmation: FORGET_CONFIRMATION },
        OWNER_ACTOR,
      );

      const promptsBefore = provider.prompts.length;
      const second = await ask({
        conversationId: conversation.id,
        question,
        idempotencyKey: 'memory-forget-2',
      });

      const evidence = await harness.services.answerRuns.listEvidence(second.run.id);
      expect(JSON.stringify(evidence)).not.toContain(FORGOTTEN);
      expect(provider.prompts.slice(promptsBefore).join('\n')).not.toContain(FORGOTTEN);
    });
  });

  /* -------------------------------------------------------------- snapshot */

  describe('the evidence snapshot', () => {
    it('does not change when the source it came from is rewritten', async () => {
      const project = await makeProject('Alpha');
      const sourceId = await note({
        title: 'Release process',
        text: `The release process ships from ${CANARY_A}.`,
        projectId: project,
      });

      provider.setAnswer(scriptedAnswer({ citations: [] }));
      const result = await ask({
        question: 'What is the release process?',
        scope: 'project',
        projectIds: [project],
        idempotencyKey: 'snapshot-pin-1',
      });

      const before = await harness.services.answerRuns.listEvidence(result.run.id);
      const pinned = before.find((item) => item.excerpt.includes(CANARY_A));
      expect(pinned).toBeDefined();
      /* Pinned to an exact revision, which is what makes the snapshot checkable later. */
      expect(pinned?.revisionId).not.toBeNull();

      await note({
        sourceId,
        title: 'Release process',
        text: `The release process now ships from ${CANARY_B}, and the old one is gone.`,
        projectId: project,
      });

      const after = await harness.services.answerRuns.listEvidence(result.run.id);
      expect(JSON.stringify(after)).toContain(CANARY_A);
      expect(JSON.stringify(after)).not.toContain(CANARY_B);
      expect(after).toEqual(before);
    });
  });

  /* --------------------------------------------------- deletion reaches it */

  describe('deletion reaches the copies an answer kept', () => {
    it('scrubs a forgotten memory out of answers that already quoted it', async () => {
      const project = await makeProject('Alpha');
      const remembered = await harness.services.memoryService.remember(
        {
          scope: 'project',
          projectId: project,
          category: 'preference',
          statement: `I prefer to deploy only on ${FORGOTTEN}.`,
          tags: [],
        },
        OWNER_ACTOR,
      );

      /* The scripted provider cites nothing, so the claim text *is* the excerpt here: both
       * copies of the sentence have to go, not only the evidence row. */
      const result = await ask({
        question: 'What do I prefer about deploys?',
        scope: 'project',
        projectIds: [project],
        idempotencyKey: 'scrub-memory-1',
      });
      const stored = await harness.services.answers.findById(result.run.id);
      expect(JSON.stringify(stored?.claims)).toContain(FORGOTTEN);
      expect(
        JSON.stringify(await harness.services.answerRuns.listEvidence(result.run.id)),
      ).toContain(FORGOTTEN);

      await harness.services.memoryService.forget(
        remembered.item.id,
        { confirmation: FORGET_CONFIRMATION },
        OWNER_ACTOR,
      );

      const after = await harness.services.answers.findById(result.run.id);
      const evidenceAfter = await harness.services.answerRuns.listEvidence(result.run.id);
      expect(JSON.stringify(after?.claims)).not.toContain(FORGOTTEN);
      expect(JSON.stringify(evidenceAfter)).not.toContain(FORGOTTEN);
      /* And it says what happened rather than leaving a citation pointing at nothing. */
      expect(JSON.stringify(evidenceAfter)).toContain('since deleted');

      /* The receipt names where content was scrubbed from, so the claim stays checkable. */
      const receipts = await harness.services.deletionReceipts.list(10);
      const targets = receipts.flatMap((receipt) => receipt.scrubbedTargets);
      expect(targets).toContain('answer_evidence.excerpt');
      expect(targets).toContain('answers.claims');
    });

    it('scrubs a deleted source out of answers that already quoted it', async () => {
      const project = await makeProject('Alpha');
      const sourceId = await note({
        title: 'Release process',
        text: `The release process ships from ${CANARY_A}.`,
        projectId: project,
      });

      provider.setAnswer(scriptedAnswer({ citations: [] }));
      const result = await ask({
        question: 'What is the release process?',
        scope: 'project',
        projectIds: [project],
        idempotencyKey: 'scrub-source-1',
      });
      expect(
        JSON.stringify(await harness.services.answerRuns.listEvidence(result.run.id)),
      ).toContain(CANARY_A);

      const outcome = await harness.services.ingestion.deleteSource(sourceId);
      expect(outcome.frozenAnswerCopiesRemoved).toBeGreaterThan(0);

      const evidenceAfter = await harness.services.answerRuns.listEvidence(result.run.id);
      expect(JSON.stringify(evidenceAfter)).not.toContain(CANARY_A);
      expect(JSON.stringify(evidenceAfter)).toContain('since deleted');
    });

    it('destroys the evidence when the conversation itself is deleted', async () => {
      const project = await makeProject('Alpha');
      await note({
        title: 'Release process',
        text: `The release process ships from ${CANARY_A}.`,
        projectId: project,
      });
      provider.setAnswer(scriptedAnswer({ citations: [] }));

      const conversation = await harness.services.answerService.startConversation(
        { scope: 'project', projectIds: [project] },
        OWNER,
      );
      const result = await ask({
        conversationId: conversation.id,
        question: 'What is the release process?',
        idempotencyKey: 'delete-conversation-1',
      });

      const removed = await harness.services.answerService.deleteConversation(
        conversation.id,
        OWNER,
      );
      expect(removed.removed).toBe(1);

      expect(await harness.services.answerRuns.findForOwner(result.run.id, OWNER)).toBeNull();
      expect(await harness.services.answerRuns.listEvidence(result.run.id)).toHaveLength(0);
    });
  });

  /* ------------------------------------------------------------ validation */

  describe('validation', () => {
    it('rejects an answer citing something it was never given, and keeps the evidence', async () => {
      const project = await makeProject('Alpha');
      await note({
        title: 'Release process',
        text: `The release process ships from ${CANARY_A}.`,
        projectId: project,
      });

      provider.setAnswer(
        scriptedAnswer({ citations: ['source:11111111-1111-4111-8111-111111111111'] }),
      );

      const result = await ask({
        question: 'What is the release process?',
        scope: 'project',
        projectIds: [project],
        idempotencyKey: 'validate-invented-1',
      });

      expect(result.run.mode).toBe('generation_failed');
      expect(result.run.rejectionRule).toBe('R-AN1');
      /* Bounded: one retry, and no more. Not a repair loop. */
      expect(provider.calls).toBe(2);
      /* The evidence survived the rejection — what failed was the narrative, not the gathering. */
      const evidence = await harness.services.answerRuns.listEvidence(result.run.id);
      expect(JSON.stringify(evidence)).toContain(CANARY_A);
      expect(result.claims.length).toBeGreaterThan(0);
    });

    it('accepts an answer that cites only what it was handed', async () => {
      const project = await makeProject('Alpha');
      provider.setAnswer(scriptedAnswer({ citations: [`project:${project}`], projectId: project }));

      const result = await ask({
        question: 'Where are we on Alpha?',
        scope: 'project',
        projectIds: [project],
        idempotencyKey: 'validate-good-1',
      });

      expect(result.run.mode).toBe('model_generated');
      expect(result.claims[0]?.citations[0]?.id).toBe(project);
      /* The label and the href are the server's, not the model's. */
      expect(result.claims[0]?.citations[0]?.href).toContain(project);
      expect(provider.calls).toBe(1);
    });
  });

  /* ----------------------------------------------------------- no provider */

  describe('without a model', () => {
    it('answers from the evidence and says so', async () => {
      const bare = await createHarness();
      try {
        const project = await bare.services.projects.create(
          projectInputSchema.parse({ name: 'Alpha', type: 'software' }),
        );
        const result = await bare.services.answerService.ask(
          askTurnSchema.parse({
            question: 'Where are we on Alpha?',
            scope: 'project',
            projectIds: [project.id],
            idempotencyKey: 'no-provider-1',
          }),
          OWNER,
        );

        expect(result.run.mode).toBe('evidence_only');
        expect(result.run.method).toBe('no_model_configured');
        expect(result.run.state).toBe('complete_with_limitations');
        expect(result.run.limitations.join(' ')).toMatch(/no writing model is configured/i);
        expect(result.claims.length).toBeGreaterThan(0);
        /* Nothing in this mode may claim a model interpreted anything. */
        expect(result.claims.some((claim) => claim.kind === 'model_interpretation')).toBe(false);
        expect(result.run.provider).toBeNull();
      } finally {
        await bare.close();
      }
    });

    it('still offers a proposal, in the owner\u2019s own words rather than a paraphrase', async () => {
      const bare = await createHarness();
      try {
        const project = await bare.services.projects.create(
          projectInputSchema.parse({ name: 'Alpha', type: 'software' }),
        );
        const result = await bare.services.answerService.ask(
          askTurnSchema.parse({
            question: 'Build the onboarding screen for Alpha',
            scope: 'project',
            projectIds: [project.id],
            idempotencyKey: 'proposal-no-model-1',
            proposeAction: true,
          }),
          OWNER,
        );

        expect(result.missionSuggestion?.rawRequest).toBe('Build the onboarding screen for Alpha');
        expect(result.missionSuggestion?.started).toBe(false);
        expect(result.missionSuggestion?.projectId).toBe(project.id);
        /* It survives the round trip, so the draft route can re-read it rather than trust a body. */
        const stored = await bare.services.answers.findById(result.run.id);
        expect(stored?.missionSuggestion?.started).toBe(false);

        /* And nothing was created by proposing it. */
        expect((await bare.services.missions.list({ limit: 20 })).items).toHaveLength(0);
      } finally {
        await bare.close();
      }
    });

    it('answers a research question by offering to go and look, never by pretending it did', async () => {
      const bare = await createHarness();
      try {
        const project = await bare.services.projects.create(
          projectInputSchema.parse({ name: 'Alpha', type: 'software' }),
        );
        const result = await bare.services.answerService.ask(
          askTurnSchema.parse({
            question: 'Research competitors for this app',
            scope: 'project',
            projectIds: [project.id],
            idempotencyKey: 'proposal-research-1',
            proposeAction: true,
          }),
          OWNER,
        );

        expect(result.missionSuggestion?.rawRequest).toMatch(/^Research: /);
        expect(result.missionSuggestion?.rationale).toMatch(/read-only/i);
        expect(result.missionSuggestion?.started).toBe(false);
        expect(result.run.limitations.join(' ')).toMatch(/outside Jarvis/i);
        expect((await bare.services.missions.list({ limit: 20 })).items).toHaveLength(0);
      } finally {
        await bare.close();
      }
    });

    it('proposes nothing when the question did not ask for anything to happen', async () => {
      const bare = await createHarness();
      try {
        const project = await bare.services.projects.create(
          projectInputSchema.parse({ name: 'Alpha', type: 'software' }),
        );
        const result = await bare.services.answerService.ask(
          askTurnSchema.parse({
            question: 'Where are we on Alpha?',
            scope: 'project',
            projectIds: [project.id],
            idempotencyKey: 'proposal-none-1',
            proposeAction: true,
          }),
          OWNER,
        );
        expect(result.missionSuggestion).toBeNull();
      } finally {
        await bare.close();
      }
    });

    it('keeps the gathered evidence when the provider fails', async () => {
      const project = await makeProject('Alpha');
      await note({
        title: 'Release process',
        text: `The release process ships from ${CANARY_A}.`,
        projectId: project,
      });
      provider.setFailure(new Error('the provider is on fire'));

      const result = await ask({
        question: 'What is the release process?',
        scope: 'project',
        projectIds: [project],
        idempotencyKey: 'provider-fails-1',
      });

      expect(result.run.mode).toBe('generation_failed');
      expect(result.claims.length).toBeGreaterThan(0);
      const evidence = await harness.services.answerRuns.listEvidence(result.run.id);
      expect(JSON.stringify(evidence)).toContain(CANARY_A);
    });
  });

  /* ----------------------------------------------------------- idempotency */

  describe('duplicate submissions', () => {
    it('does not pay twice for the same request identifier', async () => {
      const project = await makeProject('Alpha');
      provider.setAnswer(scriptedAnswer({ citations: [`project:${project}`], projectId: project }));

      const turn = {
        question: 'Where are we on Alpha?',
        scope: 'project' as const,
        projectIds: [project],
        idempotencyKey: 'duplicate-1',
      };

      const first = await ask(turn);
      const second = await ask(turn);

      expect(second.reused).toBe(true);
      expect(second.run.id).toBe(first.run.id);
      expect(provider.calls).toBe(1);

      const usage = await harness.services.usage.list({ kinds: ['answer'] });
      expect(usage).toHaveLength(1);
    });
  });

  /* ---------------------------------------------------------- cancellation */

  describe('cancellation', () => {
    it('is terminal, and a late provider result cannot undo it', async () => {
      const project = await makeProject('Alpha');
      provider.setAnswer(scriptedAnswer({ citations: [] })).setHang(30_000);

      const pending = ask({
        question: 'Where are we on Alpha?',
        scope: 'project',
        projectIds: [project],
        idempotencyKey: 'cancel-run-1',
      });

      /* Found the way the interface finds it: by the key the client minted. */
      let runId: string | null = null;
      for (let attempt = 0; attempt < 100 && runId === null; attempt += 1) {
        const found = await harness.services.answerRuns.findByKey(OWNER, 'cancel-run-1');
        runId = found?.id ?? null;
        if (runId === null) await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(runId).not.toBeNull();

      const cancelled = await harness.services.answerService.cancel(runId!, OWNER);
      expect(cancelled.state).toBe('cancelled');

      const settled = await pending;
      expect(settled.run.state).toBe('cancelled');
      expect(settled.headline).toBe('');

      const stored = await harness.services.answerRuns.findForOwner(runId!, OWNER);
      expect(stored?.state).toBe('cancelled');
      expect(stored?.headline).toBeNull();

      /* And it stays cancelled: nothing may move it afterwards. */
      const late = await harness.services.answerRuns.transition(runId!, 'complete');
      expect(late.ok).toBe(false);
    });
  });

  /* --------------------------------------------------------------- actions */

  describe('action proposals', () => {
    it('proposes a mission and never starts one', async () => {
      const project = await makeProject('Alpha');
      provider.setAnswer(
        scriptedAnswer({
          citations: [`project:${project}`],
          projectId: project,
          missionSuggestion: {
            rawRequest: 'Build the onboarding screen',
            projectId: project,
            rationale: 'The owner asked for it.',
          },
        }),
      );

      const before = await harness.services.missions.list({ limit: 50 });

      const result = await ask({
        question: 'Build the onboarding screen for Alpha',
        scope: 'project',
        projectIds: [project],
        idempotencyKey: 'propose-mission-1',
        proposeAction: true,
      });

      expect(result.missionSuggestion?.started).toBe(false);
      expect(result.missionSuggestion?.rawRequest).toBe('Build the onboarding screen');

      /* Asking created nothing. A draft exists only once the owner asks for one. */
      const after = await harness.services.missions.list({ limit: 50 });
      expect(after.items).toHaveLength(before.items.length);
    });

    it('has no reachable path to mission execution', async () => {
      /*
       * Structural, and checked at runtime rather than by reading the constructor. The answer
       * service is walked as an object graph and every method it can reach is collected; if a
       * later change wires an orchestrator, a worker or a connector into it, one of these names
       * appears and this fails. "We would never call that" is not a property — this is.
       */
      const forbidden =
        /^(start|dispatch|enqueue|approve|enroll|claim|lease|merge|createBranch|createPullRequest|trigger|runNow|execute)$/;
      const builtin = new Set(['Object', 'Array', 'Map', 'Set', 'Promise', 'Date', 'RegExp']);
      const seen = new Set<unknown>();
      const found: string[] = [];

      const walk = (value: unknown, path: string, depth: number): void => {
        if (depth > 4 || value === null || typeof value !== 'object') return;
        if (seen.has(value)) return;
        seen.add(value);

        if (Array.isArray(value)) {
          value.forEach((entry, index) => walk(entry, `${path}[${index}]`, depth + 1));
          return;
        }

        const prototype = Object.getPrototypeOf(value) as object | null;
        const constructorName = (value as { constructor?: { name?: string } }).constructor?.name;
        const names = [
          ...Object.keys(value as Record<string, unknown>),
          ...(prototype && !builtin.has(constructorName ?? '')
            ? Object.getOwnPropertyNames(prototype)
            : []),
        ];

        for (const name of names) {
          if (name === 'constructor') continue;
          let child: unknown;
          try {
            child = (value as Record<string, unknown>)[name];
          } catch {
            continue;
          }
          if (typeof child === 'function' && forbidden.test(name)) found.push(`${path}.${name}`);
          if (typeof child === 'object') walk(child, `${path}.${name}`, depth + 1);
        }
      };

      walk(harness.services.answerService, 'answerService', 0);
      expect(found).toEqual([]);
    });
  });

  /* ------------------------------------------------------------ accounting */

  describe('usage and audit', () => {
    it('records a missing token count as missing rather than as zero', async () => {
      const project = await makeProject('Alpha');
      provider
        .setAnswer(scriptedAnswer({ citations: [`project:${project}`], projectId: project }))
        .setUsage({
          inputTokens: 4321,
          outputTokens: null,
          cachedInputTokens: null,
          reportedCostUsd: null,
        });

      await ask({
        question: 'Where are we on Alpha?',
        scope: 'project',
        projectIds: [project],
        idempotencyKey: 'usage-nulls-1',
      });

      const [record] = await harness.services.usage.list({ kinds: ['answer'] });
      expect(record).toBeDefined();
      expect(record?.inputTokens).toBe(4321);
      expect(typeof record?.inputTokens).toBe('number');
      expect(record?.outputTokens).toBeNull();
      expect(record?.reportedCostUsd).toBeNull();
      expect(record?.costBasis).toBe('unknown');
    });

    it('keeps token counts numeric on the answer row as well', async () => {
      const project = await makeProject('Alpha');
      provider
        .setAnswer(scriptedAnswer({ citations: [`project:${project}`], projectId: project }))
        .setUsage({
          inputTokens: 1200,
          outputTokens: 340,
          cachedInputTokens: 90,
          reportedCostUsd: 0.0042,
        });

      const result = await ask({
        question: 'Where are we on Alpha?',
        scope: 'project',
        projectIds: [project],
        idempotencyKey: 'usage-numbers-1',
      });

      const run = await harness.services.answerRuns.findForOwner(result.run.id, OWNER);
      expect(run?.inputTokens).toBe(1200);
      expect(run?.outputTokens).toBe(340);
      expect(run?.cachedInputTokens).toBe(90);
      expect(run?.costUsd).toBeCloseTo(0.0042, 6);
    });

    it('audits the answer without copying the sources into the audit trail', async () => {
      const project = await makeProject('Alpha');
      await note({
        title: 'Release process',
        text: `The release process ships from ${CANARY_A}.`,
        projectId: project,
      });
      provider.setAnswer(scriptedAnswer({ citations: [] }));

      const result = await ask({
        question: 'What is the release process?',
        scope: 'project',
        projectIds: [project],
        idempotencyKey: 'audit-trail-1',
      });
      /* The control: this answer really did carry the excerpt. */
      expect(await everythingSeenBy(result.run.id)).toContain(CANARY_A);

      const events = await harness.services.audit.list({ limit: 200 });
      const mine = events.filter((event) => event.action.startsWith('answer.'));
      expect(mine.length).toBeGreaterThan(0);
      expect(mine.some((event) => event.rule === 'R-AE1')).toBe(true);
      /* An audit record is not a second copy of the sources. */
      expect(JSON.stringify(events)).not.toContain(CANARY_A);
    });
  });

  /* ------------------------------------------------------------- citations */

  describe('citation resolution', () => {
    it('resolves only for the owner who asked', async () => {
      const project = await makeProject('Alpha');
      provider.setAnswer(scriptedAnswer({ citations: [`project:${project}`], projectId: project }));

      const mine = await ask({
        question: 'Where are we on Alpha?',
        scope: 'project',
        projectIds: [project],
        idempotencyKey: 'citation-owner-1',
      });

      const resolved = await harness.services.answerService.resolveCitation({
        answerId: mine.run.id,
        ref: `project:${project}`,
        ownerId: OWNER,
      });
      expect(resolved.subjectId).toBe(project);

      await expect(
        harness.services.answerService.resolveCitation({
          answerId: mine.run.id,
          ref: `project:${project}`,
          ownerId: 'someone-else@example.com',
        }),
      ).rejects.toThrow();
    });

    it('will not resolve one answer’s reference through another answer’s id', async () => {
      /*
       * The enumeration case. Answer B holds Bravo's evidence and answer A holds Alpha's; a
       * reference lifted from one and replayed against the other must resolve to nothing, or the
       * citation route becomes a way to walk the identifier space across scopes.
       */
      const a = await makeProject('Alpha');
      const b = await makeProject('Bravo');
      await note({
        title: 'Bravo hosting',
        text: `The Bravo hosting arrangement is ${CANARY_B}.`,
        projectId: b,
      });

      provider.setAnswer(scriptedAnswer({ citations: [] }));
      const answerA = await ask({
        question: 'Where are we on Alpha?',
        scope: 'project',
        projectIds: [a],
        idempotencyKey: 'cross-answer-a',
      });
      const answerB = await ask({
        question: 'What is the hosting arrangement?',
        scope: 'project',
        projectIds: [b],
        idempotencyKey: 'cross-answer-b',
      });

      const bravoEvidence = await harness.services.answerRuns.listEvidence(answerB.run.id);
      const bravoRef = bravoEvidence[0]?.ref;
      expect(bravoRef).toBeDefined();

      await expect(
        harness.services.answerService.resolveCitation({
          answerId: answerB.run.id,
          ref: bravoRef!,
          ownerId: OWNER,
        }),
      ).resolves.toBeDefined();

      await expect(
        harness.services.answerService.resolveCitation({
          answerId: answerA.run.id,
          ref: bravoRef!,
          ownerId: OWNER,
        }),
      ).rejects.toThrow();
    });
  });
});
