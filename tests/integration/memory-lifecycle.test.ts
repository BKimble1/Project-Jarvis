import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DeterministicEmbeddingProvider } from '@/domain/embedding';
import { FORGET_CONFIRMATION } from '@/domain/knowledge';
import { buildScopeFilter, type ScopeFilter } from '@/domain/retrieval';
import { ForbiddenError, ValidationError } from '@/domain/errors';
import type { MemoryActor } from '@/server/knowledge/memory-service';
import { createHarness, type TestHarness } from '../helpers/services';

/**
 * What Jarvis remembers, against a real database.
 *
 * The claims here are the ones a green unit test cannot settle, because they are about what
 * survives a write: that a suggestion an agent made is not retrievable until I approve it, that
 * the agent cannot approve it itself, and — the one worth the most — that a forgotten memory is
 * gone from *every* path rather than merely from the one the interface happens to use.
 *
 * Forgetting is checked by canary: a unique improbable string goes in, is forgotten, and is then
 * searched for across the item row, the generated search vector, the embeddings table and the
 * audit trail. A count-based assertion would pass while the sentence sat in an audit payload.
 */
describe('memory lifecycle', () => {
  let harness: TestHarness;

  const OWNER: MemoryActor = { actor: 'owner@example.com', actorKind: 'owner' };
  const AGENT: MemoryActor = { actor: 'agent:analyst', actorKind: 'agent' };

  const CANARY = 'quixotic-vellum-forget-4471';
  const OTHER_CANARY = 'harpsichord-marmoset-kept-9917';

  beforeEach(async () => {
    harness = await createHarness({ embeddings: new DeterministicEmbeddingProvider(512) });
  });

  afterEach(async () => {
    await harness.close();
  });

  const ownerScope = (): ScopeFilter =>
    buildScopeFilter({ audience: 'owner', scopes: ['global'], projectIds: [] });

  const search = async (query: string, scope: ScopeFilter) =>
    harness.services.retrieval.retrieve({
      query,
      scope,
      purpose: 'owner_search',
      limit: 10,
      charBudget: 8000,
      includeSources: true,
      includeMemories: true,
      sourceKinds: null,
      asOf: null,
    });

  const rowsOf = (result: unknown): Record<string, unknown>[] => {
    if (Array.isArray(result)) return result as Record<string, unknown>[];
    if (result && typeof result === 'object' && 'rows' in result) {
      const rows = (result as { rows: unknown }).rows;
      if (Array.isArray(rows)) return rows as Record<string, unknown>[];
    }
    return [];
  };

  /* ------------------------------------------------------------ authoring */

  describe('what the owner states', () => {
    it('is active immediately and retrievable', async () => {
      const outcome = await harness.services.memoryService.remember(
        {
          scope: 'global',
          category: 'preference',
          statement: `Deployments happen on Tuesday, never Friday. ${OTHER_CANARY}`,
          tags: [],
        },
        OWNER,
      );

      expect(outcome.item.status).toBe('active');
      expect(outcome.rule).toBe('R-KN1');
      expect(outcome.needsConfirmation).toBe(false);
      /* A preference is about the owner, so it defaults to private rather than internal. */
      expect(outcome.item.sensitivity).toBe('private');

      const found = await search(OTHER_CANARY, ownerScope());
      expect(found.evidence.some((item) => item.excerpt.includes(OTHER_CANARY))).toBe(true);
    });

    it('refuses a project-scoped note that names no project', async () => {
      await expect(
        harness.services.memoryService.remember(
          { scope: 'project', category: 'fact', statement: 'Something about a project.', tags: [] },
          OWNER,
        ),
      ).rejects.toBeInstanceOf(ValidationError);
    });

    it('cannot be recorded by anything that is not the owner', async () => {
      await expect(
        harness.services.memoryService.remember(
          { scope: 'global', category: 'fact', statement: 'An agent wrote this directly.', tags: [] },
          AGENT,
        ),
      ).rejects.toBeInstanceOf(ForbiddenError);
    });
  });

  /* ------------------------------------------------------------ proposals */

  describe('what an agent proposes', () => {
    it('is a suggestion, and a suggestion is not retrievable', async () => {
      const outcome = await harness.services.memoryService.propose(
        {
          scope: 'global',
          category: 'fact',
          origin: 'model_suggested',
          statement: `The build cache lives in the CI runner. ${CANARY}`,
          excerpts: [],
          tags: [],
        },
        AGENT,
      );

      expect(outcome.item.status).toBe('suggested');
      expect(outcome.needsConfirmation).toBe(true);
      expect(outcome.item.confirmedAt).toBeNull();

      const found = await search(CANARY, ownerScope());
      expect(found.evidence).toHaveLength(0);
    });

    it('cannot be approved by the thing that proposed it', async () => {
      const outcome = await harness.services.memoryService.propose(
        {
          scope: 'global',
          category: 'fact',
          origin: 'inferred',
          statement: 'You always merge without review.',
          excerpts: [],
          tags: [],
        },
        AGENT,
      );

      /* As itself: refused on actor kind. */
      await expect(
        harness.services.memoryService.decide(outcome.item.id, { decision: 'approve' }, AGENT),
      ).rejects.toBeInstanceOf(ForbiddenError);

      /*
       * And presenting as the owner while keeping its own identity: refused on R-KA2, which is
       * the check that still holds if an actor kind is ever forged or an agent is run under owner
       * identity by a future code path.
       */
      await expect(
        harness.services.memoryService.decide(
          outcome.item.id,
          { decision: 'approve' },
          { actor: AGENT.actor, actorKind: 'owner' },
        ),
      ).rejects.toThrow(/cannot also approve/i);

      const still = await harness.services.knowledge.findById(outcome.item.id);
      expect(still?.status).toBe('suggested');
    });

    it('never activates an owner-only category however confident the model is', async () => {
      for (const category of ['preference', 'decision', 'goal', 'constraint'] as const) {
        const outcome = await harness.services.memoryService.propose(
          {
            scope: 'global',
            category,
            origin: 'model_suggested',
            statement: `A ${category} the model is certain about.`,
            confidence: 'high',
            excerpts: [],
            tags: [],
          },
          AGENT,
        );
        expect(outcome.item.status).toBe('suggested');
        expect(outcome.rule).toBe('R-KN3');
      }
    });

    it('becomes retrievable only once the owner approves it', async () => {
      const outcome = await harness.services.memoryService.propose(
        {
          scope: 'global',
          category: 'fact',
          origin: 'model_suggested',
          statement: `Staging rebuilds nightly at 02:00. ${OTHER_CANARY}`,
          excerpts: [],
          tags: [],
        },
        AGENT,
      );

      expect((await search(OTHER_CANARY, ownerScope())).evidence).toHaveLength(0);

      const approved = await harness.services.memoryService.decide(
        outcome.item.id,
        { decision: 'approve' },
        OWNER,
      );
      expect(approved.status).toBe('active');
      expect(approved.confirmedBy).toBe(OWNER.actor);

      const found = await search(OTHER_CANARY, ownerScope());
      expect(found.evidence.some((item) => item.excerpt.includes(OTHER_CANARY))).toBe(true);
    });

    it('marks a confirmed suggestion as agent-drafted even after approval', async () => {
      const outcome = await harness.services.memoryService.propose(
        {
          scope: 'global',
          category: 'fact',
          origin: 'inferred',
          statement: `Reviews take about a day. ${OTHER_CANARY}`,
          excerpts: [],
          tags: [],
        },
        AGENT,
      );
      await harness.services.memoryService.decide(outcome.item.id, { decision: 'approve' }, OWNER);

      const found = await search(OTHER_CANARY, ownerScope());
      const hit = found.evidence.find((item) => item.excerpt.includes(OTHER_CANARY));
      expect(hit?.trust).toBe('agent_suggested');
    });

    it('rejects with a reason, and a rejected suggestion is not retrievable', async () => {
      const outcome = await harness.services.memoryService.propose(
        {
          scope: 'global',
          category: 'fact',
          origin: 'model_suggested',
          statement: `The database is MySQL. ${CANARY}`,
          excerpts: [],
          tags: [],
        },
        AGENT,
      );
      const rejected = await harness.services.memoryService.decide(
        outcome.item.id,
        { decision: 'reject', reason: 'It is Postgres.' },
        OWNER,
      );

      expect(rejected.status).toBe('rejected');
      expect(rejected.rejectedReason).toBe('It is Postgres.');
      expect((await search(CANARY, ownerScope())).evidence).toHaveLength(0);
    });
  });

  /* ----------------------------------------------------------- forgetting */

  describe('forgetting', () => {
    const rememberCanary = async () =>
      harness.services.memoryService.remember(
        {
          scope: 'global',
          category: 'fact',
          statement: `The office alarm code is ${CANARY}.`,
          detail: `Written down again here: ${CANARY}.`,
          tags: [],
        },
        OWNER,
      );

    it('needs the exact confirmation phrase', async () => {
      const outcome = await rememberCanary();
      await expect(
        harness.services.memoryService.forget(outcome.item.id, { confirmation: 'yes' }, OWNER),
      ).rejects.toBeInstanceOf(ValidationError);

      const still = await harness.services.knowledge.findById(outcome.item.id);
      expect(still?.statement).toContain(CANARY);
    });

    it('is refused for anything that is not the owner', async () => {
      const outcome = await rememberCanary();
      await expect(
        harness.services.memoryService.forget(
          outcome.item.id,
          { confirmation: FORGET_CONFIRMATION },
          AGENT,
        ),
      ).rejects.toBeInstanceOf(ForbiddenError);
    });

    it('removes the text from every path that could return it', async () => {
      const outcome = await rememberCanary();

      /* Established first: the canary really is reachable before it is forgotten. */
      expect((await search(CANARY, ownerScope())).evidence.length).toBeGreaterThan(0);
      const embeddedBefore = await harness.services.db.execute(
        sql`select count(*)::int as n from knowledge_embeddings where item_id = ${outcome.item.id}::uuid`,
      );
      expect(Number(rowsOf(embeddedBefore)[0]?.n ?? 0)).toBeGreaterThan(0);

      const result = await harness.services.memoryService.forget(
        outcome.item.id,
        { confirmation: FORGET_CONFIRMATION, reason: 'No longer relevant.' },
        OWNER,
      );
      expect(result.embeddingsRemoved).toBeGreaterThan(0);

      /* 1. Retrieval. */
      expect((await search(CANARY, ownerScope())).evidence).toHaveLength(0);

      /* 2. The row itself, including detail, excerpts, tags and the source reference. */
      const row = await harness.services.knowledge.findById(outcome.item.id);
      expect(row?.status).toBe('forgotten');
      expect(row?.statement).not.toContain(CANARY);
      expect(row?.detail).toBeNull();
      expect(row?.excerpts).toHaveLength(0);
      expect(row?.forgottenAt).not.toBeNull();

      /* 3. The generated full-text index built from those columns. */
      const vector = await harness.services.db.execute(
        sql`select search_vector::text as v from knowledge_items where id = ${outcome.item.id}::uuid`,
      );
      expect(String(rowsOf(vector)[0]?.v ?? '')).not.toContain(CANARY.toLowerCase());

      /* 4. The semantic index. */
      const embeddedAfter = await harness.services.db.execute(
        sql`select count(*)::int as n from knowledge_embeddings where item_id = ${outcome.item.id}::uuid`,
      );
      expect(Number(rowsOf(embeddedAfter)[0]?.n ?? 0)).toBe(0);

      /* 5. A raw scan of every text column in the table, in case a path was missed. */
      const anywhere = await harness.services.db.execute(
        sql`select count(*)::int as n from knowledge_items
            where statement like ${'%' + CANARY + '%'}
               or coalesce(detail, '') like ${'%' + CANARY + '%'}
               or excerpts::text like ${'%' + CANARY + '%'}
               or tags::text like ${'%' + CANARY + '%'}`,
      );
      expect(Number(rowsOf(anywhere)[0]?.n ?? 0)).toBe(0);
    });

    it('keeps a receipt that records the deletion without recording what was deleted', async () => {
      const outcome = await rememberCanary();
      await harness.services.memoryService.forget(
        outcome.item.id,
        { confirmation: FORGET_CONFIRMATION, reason: 'No longer relevant.' },
        OWNER,
      );

      const receipts = await harness.services.deletionReceipts.list(10);
      const receipt = receipts.find((entry) => entry.subjectId === outcome.item.id);
      expect(receipt).toBeDefined();
      expect(receipt?.scrubbedTargets).toContain('knowledge_embeddings');
      expect(JSON.stringify(receipt)).not.toContain(CANARY);

      const events = await harness.services.audit.list({ actions: ['knowledge.forget'] });
      const event = events.find((entry) => entry.subjectId === outcome.item.id);
      expect(event?.outcome).toBe('allowed');
      expect(event?.summary).not.toContain(CANARY);
      expect(JSON.stringify(event?.detail ?? {})).not.toContain(CANARY);

      /* And nowhere in the whole trail, including the create event written before forgetting. */
      const all = await harness.services.audit.list({ limit: 200 });
      expect(JSON.stringify(all)).not.toContain(CANARY);
    });

    it('cannot be acted on again once forgotten', async () => {
      const outcome = await rememberCanary();
      await harness.services.memoryService.forget(
        outcome.item.id,
        { confirmation: FORGET_CONFIRMATION },
        OWNER,
      );
      await expect(
        harness.services.memoryService.decide(outcome.item.id, { decision: 'restore' }, OWNER),
      ).rejects.toBeInstanceOf(ForbiddenError);
      await expect(
        harness.services.memoryService.edit(outcome.item.id, { statement: 'Bring it back' }, OWNER),
      ).rejects.toBeInstanceOf(ValidationError);
    });

    it('does not re-embed a tombstone on the next indexing pass', async () => {
      const outcome = await rememberCanary();
      await harness.services.memoryService.forget(
        outcome.item.id,
        { confirmation: FORGET_CONFIRMATION },
        OWNER,
      );

      await harness.services.memoryService.embedPending();

      const after = await harness.services.db.execute(
        sql`select count(*)::int as n from knowledge_embeddings where item_id = ${outcome.item.id}::uuid`,
      );
      expect(Number(rowsOf(after)[0]?.n ?? 0)).toBe(0);
    });
  });

  /* ------------------------------------------------------------ editing */

  describe('editing', () => {
    it('reindexes so the old wording stops answering searches', async () => {
      const outcome = await harness.services.memoryService.remember(
        { scope: 'global', category: 'fact', statement: `Old wording ${CANARY}.`, tags: [] },
        OWNER,
      );
      expect((await search(CANARY, ownerScope())).evidence.length).toBeGreaterThan(0);

      await harness.services.memoryService.edit(
        outcome.item.id,
        { statement: `New wording ${OTHER_CANARY}.` },
        OWNER,
      );

      expect((await search(CANARY, ownerScope())).evidence).toHaveLength(0);
      expect((await search(OTHER_CANARY, ownerScope())).evidence.length).toBeGreaterThan(0);
    });

    it('cannot be done by an agent', async () => {
      const outcome = await harness.services.memoryService.remember(
        { scope: 'global', category: 'fact', statement: 'Something true.', tags: [] },
        OWNER,
      );
      await expect(
        harness.services.memoryService.edit(outcome.item.id, { statement: 'Something else' }, AGENT),
      ).rejects.toBeInstanceOf(ForbiddenError);
    });
  });

  /* ---------------------------------------------------------- archiving */

  describe('archiving', () => {
    it('stops retrieval without destroying anything', async () => {
      const outcome = await harness.services.memoryService.remember(
        { scope: 'global', category: 'fact', statement: `Archive me ${CANARY}.`, tags: [] },
        OWNER,
      );
      await harness.services.memoryService.decide(outcome.item.id, { decision: 'archive' }, OWNER);

      expect((await search(CANARY, ownerScope())).evidence).toHaveLength(0);

      /* The text is still there — archiving is not forgetting, and the difference is the point. */
      const row = await harness.services.knowledge.findById(outcome.item.id);
      expect(row?.statement).toContain(CANARY);

      const restored = await harness.services.memoryService.decide(
        outcome.item.id,
        { decision: 'restore' },
        OWNER,
      );
      expect(restored.status).toBe('active');
      expect((await search(CANARY, ownerScope())).evidence.length).toBeGreaterThan(0);
    });
  });

  /* ---------------------------------------------------------- conflicts */

  describe('conflicts', () => {
    const twoThatDisagree = async () => {
      const first = await harness.services.memoryService.remember(
        {
          scope: 'global',
          category: 'fact',
          statement: 'The production database runs Postgres 16 on Neon.',
          tags: [],
        },
        OWNER,
      );
      const second = await harness.services.memoryService.remember(
        {
          scope: 'global',
          category: 'fact',
          statement: 'The production database runs Postgres 15 on Supabase.',
          tags: [],
        },
        OWNER,
      );
      return { first: first.item, second: second.item, conflicts: second.conflicts };
    };

    it('are raised without altering either statement', async () => {
      const { first, second, conflicts } = await twoThatDisagree();
      expect(conflicts.length).toBeGreaterThan(0);

      const left = await harness.services.knowledge.findById(first.id);
      const right = await harness.services.knowledge.findById(second.id);
      expect(left?.status).toBe('active');
      expect(right?.status).toBe('active');
      expect(left?.supersededById).toBeNull();
    });

    it('are not duplicated when the same pair is re-examined', async () => {
      const { second } = await twoThatDisagree();
      const before = (await harness.services.conflicts.list('open')).length;
      await harness.services.memoryService.raiseConflicts(second);
      const after = (await harness.services.conflicts.list('open')).length;
      expect(after).toBe(before);
    });

    it('leave both statements standing when the owner keeps both', async () => {
      const { first, second, conflicts } = await twoThatDisagree();
      const conflict = conflicts[0]!;

      await harness.services.memoryService.resolveConflict(
        conflict.id,
        { resolution: 'keep_both' },
        OWNER,
      );

      expect((await harness.services.knowledge.findById(first.id))?.status).toBe('active');
      expect((await harness.services.knowledge.findById(second.id))?.status).toBe('active');
    });

    it('retire only the losing statement when the owner picks a side', async () => {
      const { first, second, conflicts } = await twoThatDisagree();
      const conflict = conflicts[0]!;
      const loserId = conflict.leftId === first.id ? conflict.rightId! : conflict.leftId;
      const winnerId = loserId === first.id ? second.id : first.id;

      await harness.services.memoryService.resolveConflict(
        conflict.id,
        { resolution: conflict.leftId === winnerId ? 'keep_left' : 'keep_right' },
        OWNER,
      );

      expect((await harness.services.knowledge.findById(winnerId))?.status).toBe('active');
      const loser = await harness.services.knowledge.findById(loserId);
      expect(loser?.status).toBe('superseded');
      /* Retired, not destroyed: the words are still there to look at. */
      expect(loser?.statement).toContain('Postgres');
    });

    it('cannot be resolved by an agent', async () => {
      const { conflicts } = await twoThatDisagree();
      await expect(
        harness.services.memoryService.resolveConflict(
          conflicts[0]!.id,
          { resolution: 'keep_both' },
          AGENT,
        ),
      ).rejects.toBeInstanceOf(ForbiddenError);
    });
  });

  /* ------------------------------------------------------------ audiences */

  describe('who can see what', () => {
    const rememberAt = async (sensitivity: 'public' | 'internal' | 'private', text: string) =>
      harness.services.memoryService.remember(
        { scope: 'global', category: 'fact', statement: text, tags: [], sensitivity },
        OWNER,
      );

    it('never shows private memory to a wallboard, whatever the request asks for', async () => {
      await rememberAt('private', `The bank details are ${CANARY}.`);
      await rememberAt('public', `The office opens at nine. ${OTHER_CANARY}`);

      /*
       * The display audience asking for the highest ceiling there is. `buildScopeFilter` clamps
       * it rather than honouring it, and the clamp is in code with no request parameter that can
       * reach it — which is what makes "a wallboard never shows private material" a property
       * rather than a policy.
       */
      const displayScope = buildScopeFilter({
        audience: 'display',
        scopes: ['global'],
        projectIds: [],
        sensitivityCeiling: 'private',
      });
      expect(displayScope.sensitivityCeiling).toBe('public');

      const found = await search(CANARY, displayScope);
      expect(found.evidence).toHaveLength(0);
      expect(JSON.stringify(found)).not.toContain(CANARY);

      /* Public material still reaches it, so the check is not simply blocking everything. */
      const allowed = await search(OTHER_CANARY, displayScope);
      expect(allowed.evidence.length).toBeGreaterThan(0);

      /* And the owner, asking the same question, does see it. */
      const owner = await search(CANARY, ownerScope());
      expect(owner.evidence.length).toBeGreaterThan(0);
    });

    it('never gives an agent private memory, even asking for its own project', async () => {
      await rememberAt('private', `A private preference about ${CANARY}.`);
      await rememberAt('internal', `A working note about ${OTHER_CANARY}.`);

      const agentScope = buildScopeFilter({
        audience: 'agent',
        scopes: ['global'],
        projectIds: [],
        sensitivityCeiling: 'private',
      });
      expect(agentScope.sensitivityCeiling).toBe('internal');

      expect((await search(CANARY, agentScope)).evidence).toHaveLength(0);
      expect((await search(OTHER_CANARY, agentScope)).evidence.length).toBeGreaterThan(0);
    });
  });

  /* ---------------------------------------------------------- explaining */

  describe('explaining why something is remembered', () => {
    it('reports the rule, the origin and whether it may be relied on', async () => {
      const stated = await harness.services.memoryService.remember(
        { scope: 'global', category: 'decision', statement: 'We ship on Tuesdays.', tags: [] },
        OWNER,
      );
      const explained = await harness.services.memoryService.explain(stated.item.id);

      expect(explained.statusRule).toBe('R-KN1');
      expect(explained.provenance).toBe('manual');
      expect(explained.authoritative).toBe(true);
      expect(explained.decidedBy).toBe(OWNER.actor);
      expect(explained.embedded).toBe(true);
    });

    it('says an approved guess is still a guess', async () => {
      const guessed = await harness.services.memoryService.propose(
        {
          scope: 'global',
          category: 'fact',
          origin: 'inferred',
          statement: 'You prefer short pull requests.',
          excerpts: [],
          tags: [],
        },
        AGENT,
      );
      await harness.services.memoryService.decide(guessed.item.id, { decision: 'approve' }, OWNER);

      const explained = await harness.services.memoryService.explain(guessed.item.id);
      expect(explained.item.status).toBe('active');
      expect(explained.provenance).toBe('inferred');
      /* Retrievable, but not something to build a recommendation on. */
      expect(explained.authoritative).toBe(false);
      expect(explained.authorityReason).toMatch(/guess/i);
    });

    it('links a memory to the source it was read from', async () => {
      const url = 'https://docs.example.com/runbook.md';
      harness.urlFetcher.setPage(url, '# Runbook\n\nRestart the worker before the API.');
      const source = await harness.services.ingestion.addUrl({
        url,
        kind: 'web_url',
        title: 'Runbook',
        scope: 'global',
        projectId: null,
        sensitivity: 'internal',
        addedBy: OWNER.actor,
      });

      const imported = await harness.services.memoryService.propose(
        {
          scope: 'global',
          category: 'procedure',
          origin: 'imported',
          statement: 'Restart the worker before the API.',
          sourceId: source.sourceId,
          sourceRef: 'lines 3-3',
          excerpts: [{ text: 'Restart the worker before the API.', locator: 'lines 3-3' }],
          tags: [],
        },
        AGENT,
      );

      const explained = await harness.services.memoryService.explain(imported.item.id);
      expect(explained.citation.sourceId).toBe(source.sourceId);
      expect(explained.citation.href).toBe(`/knowledge/sources/${source.sourceId}`);
      expect(explained.citation.sourceRef).toBe('lines 3-3');
    });
  });

  /* --------------------------------------------------------- supersession */

  describe('replacing a memory', () => {
    it('keeps both and links them in both directions', async () => {
      const first = await harness.services.memoryService.remember(
        { scope: 'global', category: 'decision', statement: `We use Fly.io. ${CANARY}`, tags: [] },
        OWNER,
      );
      const second = await harness.services.memoryService.supersede(
        first.item.id,
        {
          scope: 'global',
          category: 'decision',
          statement: `We use Netlify. ${OTHER_CANARY}`,
          tags: [],
        },
        OWNER,
        'Moved off Fly in March.',
      );

      const previous = await harness.services.knowledge.findById(first.item.id);
      expect(previous?.status).toBe('superseded');
      expect(previous?.supersededById).toBe(second.item.id);
      expect(previous?.supersededReason).toBe('Moved off Fly in March.');
      expect(second.item.supersedesId).toBe(first.item.id);

      /* The replaced statement is kept and readable, but no longer answers a search. */
      expect(previous?.statement).toContain(CANARY);
      expect((await search(CANARY, ownerScope())).evidence).toHaveLength(0);
      expect((await search(OTHER_CANARY, ownerScope())).evidence.length).toBeGreaterThan(0);

      const explained = await harness.services.memoryService.explain(second.item.id);
      expect(explained.supersedes?.id).toBe(first.item.id);
    });

    it('refuses to replace something already replaced', async () => {
      const first = await harness.services.memoryService.remember(
        { scope: 'global', category: 'decision', statement: 'Original decision.', tags: [] },
        OWNER,
      );
      await harness.services.memoryService.supersede(
        first.item.id,
        { scope: 'global', category: 'decision', statement: 'Second decision.', tags: [] },
        OWNER,
      );

      await expect(
        harness.services.memoryService.supersede(
          first.item.id,
          { scope: 'global', category: 'decision', statement: 'Third decision.', tags: [] },
          OWNER,
        ),
      ).rejects.toBeInstanceOf(ValidationError);
    });
  });
});
