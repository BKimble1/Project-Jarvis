import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EMPTY_ASSUMPTIONS, QUALIFICATION_VERSION } from '@/domain/qualification';
import type { BriefingContent } from '@/domain/briefing';
import { createHarness, type TestHarness } from '../helpers/services';

/**
 * The Prompt 4 persistence layer, against a migrated PostgreSQL.
 *
 * These are not repository-shaped unit tests. Each one asserts a property the *design* depends
 * on and that only the database can actually provide: that a schedule occurrence can be claimed
 * once under concurrency, that a rate limiter counts correctly when five requests arrive at the
 * same moment, that forgetting a memory removes it from the search index, that revoking a push
 * subscription destroys its keys, and that editing or deleting an audit row is detected.
 *
 * Where a claim is about concurrency it is tested with concurrency, because a read-then-write
 * race cannot be found by a sequential test — that is precisely how it survives review.
 */

describe('Prompt 4 persistence', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await createHarness();
  });

  afterEach(async () => {
    await harness.close();
  });

  /* ------------------------------------------------------------ knowledge */

  describe('knowledge', () => {
    it('indexes chunks for ranked search and ranks a closer match higher', async () => {
      const { knowledgeSources, chunks } = harness.services;
      const source = await knowledgeSources.create({
        kind: 'note',
        title: 'Deployment notes',
        origin: 'deployment.md',
        contentHash: 'hash-deploy',
        byteSize: 200,
        charCount: 190,
        addedBy: 'owner',
      });

      await chunks.replaceForSource(source.id, null, [
        {
          ordinal: 0,
          locator: '## Deployment',
          heading: 'Deployment',
          text: 'Netlify deploys run from the main branch once the verification suite passes.',
        },
        {
          ordinal: 1,
          locator: '## Rollback',
          heading: 'Rollback',
          text: 'Roll back by redeploying the previous Netlify build.',
        },
      ]);

      const hits = await chunks.search({ query: 'netlify verification' });
      expect(hits).toHaveLength(1);
      expect(hits[0]?.chunk.locator).toBe('## Deployment');
      expect(hits[0]?.sourceTitle).toBe('Deployment notes');

      const broader = await chunks.search({ query: 'netlify' });
      expect(broader).toHaveLength(2);
    });

    it('keeps the search vector in step when a chunk is replaced', async () => {
      const { knowledgeSources, chunks } = harness.services;
      const source = await knowledgeSources.create({
        kind: 'note',
        title: 'Hosting',
        origin: 'hosting.md',
        contentHash: 'hash-host',
        byteSize: 50,
        charCount: 48,
        addedBy: 'owner',
      });

      await chunks.replaceForSource(source.id, null, [
        { ordinal: 0, locator: 'p. 1', heading: null, text: 'Netlify hosts the control plane.' },
      ]);
      expect(await chunks.search({ query: 'netlify' })).toHaveLength(1);

      await chunks.replaceForSource(source.id, null, [
        { ordinal: 0, locator: 'p. 1', heading: null, text: 'Fly.io hosts the worker process.' },
      ]);
      expect(await chunks.search({ query: 'netlify' })).toHaveLength(0);
      expect(await chunks.search({ query: 'worker' })).toHaveLength(1);
    });

    it('only searches active memories, so a suggestion cannot answer a question', async () => {
      const { knowledge } = harness.services;
      await knowledge.create({
        scope: 'global',
        category: 'preference',
        origin: 'explicit',
        status: 'active',
        statusRule: 'R-KN1',
        statement: 'I prefer briefings with counts rather than adjectives.',
        createdBy: 'owner',
      });
      await knowledge.create({
        scope: 'global',
        category: 'preference',
        origin: 'model_suggested',
        status: 'suggested',
        statusRule: 'R-KN5',
        statement: 'I prefer briefings written as long flowing prose.',
        createdBy: 'system',
        confidence: 'low',
      });

      const hits = await knowledge.searchActive({ query: 'briefings' });
      expect(hits).toHaveLength(1);
      expect(hits[0]?.item.status).toBe('active');

      const counts = await knowledge.countsByStatus();
      expect(counts.active).toBe(1);
      expect(counts.suggested).toBe(1);
      expect(counts.forgotten).toBe(0);
    });

    it('removes a forgotten memory from the search index, not merely from listings', async () => {
      const { knowledge } = harness.services;
      const item = await knowledge.create({
        scope: 'global',
        category: 'fact',
        origin: 'explicit',
        status: 'active',
        statusRule: 'R-KN1',
        statement: 'My accountant is called Marchetti and reviews the books in April.',
        detail: 'Contact through the shared folder.',
        excerpts: [{ text: 'Marchetti reviews the books in April.', locator: 'p. 2' }],
        createdBy: 'owner',
      });

      expect(await knowledge.searchActive({ query: 'accountant' })).toHaveLength(1);

      const forgotten = await knowledge.forget(item.id, new Date());
      expect(forgotten.status).toBe('forgotten');
      expect(forgotten.detail).toBeNull();
      expect(forgotten.excerpts).toEqual([]);
      expect(forgotten.statement).not.toContain('Marchetti');

      expect(await knowledge.searchActive({ query: 'accountant' })).toHaveLength(0);
      expect(await knowledge.searchActive({ query: 'Marchetti' })).toHaveLength(0);

      /* And not through the raw index either — the generated column is the only copy. */
      const raw = await harness.services.db.execute(
        sql`select count(*)::int as n from knowledge_items
            where search_vector @@ websearch_to_tsquery('english', 'Marchetti')`,
      );
      expect(Number(rowsOf(raw)[0]?.n ?? -1)).toBe(0);
    });

    it('destroys a purged source and lets the same file be added again', async () => {
      const { knowledgeSources, chunks } = harness.services;
      const source = await knowledgeSources.create({
        kind: 'pdf',
        title: 'Contract',
        origin: 'contract.pdf',
        contentHash: 'hash-contract',
        byteSize: 900,
        charCount: 880,
        bodyText: 'The private terms of the contract.',
        addedBy: 'owner',
      });
      await chunks.replaceForSource(source.id, null, [
        { ordinal: 0, locator: 'p. 1', heading: null, text: 'The private terms of the contract.' },
      ]);

      expect(await knowledgeSources.findLiveByHash('hash-contract')).not.toBeNull();

      const removed = await knowledgeSources.purge(source.id);
      expect(removed).toBe(1);
      expect(await knowledgeSources.readBody(source.id)).toBeNull();
      expect(await chunks.listForSource(source.id)).toHaveLength(0);
      expect(await chunks.search({ query: 'contract' })).toHaveLength(0);

      /* The row survives as a record that it existed, but no longer blocks a re-add. */
      expect((await knowledgeSources.findById(source.id))?.state).toBe('deleted');
      expect(await knowledgeSources.findLiveByHash('hash-contract')).toBeNull();
      await expect(
        knowledgeSources.create({
          kind: 'pdf',
          title: 'Contract',
          origin: 'contract.pdf',
          contentHash: 'hash-contract',
          byteSize: 900,
          charCount: 880,
          addedBy: 'owner',
        }),
      ).resolves.toBeDefined();
    });

    it('raises a conflict once however often it is re-detected', async () => {
      const { knowledge, conflicts } = harness.services;
      const left = await knowledge.create({
        scope: 'global',
        category: 'preference',
        origin: 'explicit',
        status: 'active',
        statusRule: 'R-KN1',
        statement: 'Deploy on Fridays.',
        createdBy: 'owner',
      });
      const right = await knowledge.create({
        scope: 'global',
        category: 'preference',
        origin: 'explicit',
        status: 'active',
        statusRule: 'R-KN1',
        statement: 'Never deploy on Fridays.',
        createdBy: 'owner',
      });

      for (let attempt = 0; attempt < 3; attempt += 1) {
        await conflicts.record({
          kind: 'contradiction',
          leftId: left.id,
          rightId: right.id,
          summary: 'These two disagree about Friday deployments.',
          detectedRule: 'R-KC1',
        });
      }
      expect(await conflicts.openCount()).toBe(1);

      const [only] = await conflicts.list('open');
      const resolved = await conflicts.resolve(only!.id, 'keep_right', new Date());
      expect(resolved.state).toBe('resolved');
      expect(await conflicts.openCount()).toBe(0);

      /* Resolving changes neither side. Nothing is overwritten by a conflict decision. */
      expect((await knowledge.findById(left.id))?.statement).toBe('Deploy on Fridays.');
      expect((await knowledge.findById(right.id))?.statement).toBe('Never deploy on Fridays.');
    });
  });

  /* -------------------------------------------------------- qualification */

  describe('qualification', () => {
    it('replaces a re-run check rather than keeping two answers, and redacts what it stores', async () => {
      const { qualification } = harness.services;
      const run = await qualification.createRun({
        startedBy: 'owner',
        buildRef: 'abc123',
        assumptions: EMPTY_ASSUMPTIONS,
        qualificationVersion: QUALIFICATION_VERSION,
      });

      await qualification.recordCheck(run.id, {
        id: 'model_provider',
        outcome: 'pass',
        detail: 'Validated with sk-ant-api03-0123456789abcdefghijklmnop, which must not persist.',
        evidence: { identity: 'jarvis-worker' },
      });
      await qualification.recordCheck(run.id, {
        id: 'model_provider',
        outcome: 'fail',
        detail: 'A later attempt disagreed.',
        evidence: {},
      });

      const stored = await qualification.findRun(run.id);
      expect(stored?.results).toHaveLength(1);
      expect(stored?.results[0]?.outcome).toBe('fail');

      const first = await qualification.recordCheck(run.id, {
        id: 'github_read',
        outcome: 'pass',
        detail: 'Token sk-ant-api03-0123456789abcdefghijklmnop was accepted.',
        evidence: { login: 'jarvis-bot' },
      });
      expect(first.detail).not.toContain('sk-ant-api03-0123456789abcdefghijklmnop');
    });

    it('keeps one suite outcome per kind and supersedes older runs', async () => {
      const { qualification } = harness.services;
      await qualification.recordSuiteOutcome({
        kind: 'automated',
        passed: true,
        buildRef: 'abc',
        detail: '802 tests passed.',
        testCount: 802,
      });
      await qualification.recordSuiteOutcome({
        kind: 'automated',
        passed: false,
        buildRef: 'def',
        detail: 'One test failed.',
        testCount: 803,
      });
      const outcomes = await qualification.suiteOutcomes();
      expect(outcomes).toHaveLength(1);
      expect(outcomes[0]?.passed).toBe(false);
      expect(outcomes[0]?.buildRef).toBe('def');

      const older = await qualification.createRun({
        startedBy: 'owner',
        assumptions: EMPTY_ASSUMPTIONS,
        qualificationVersion: QUALIFICATION_VERSION,
      });
      const newer = await qualification.createRun({
        startedBy: 'owner',
        assumptions: EMPTY_ASSUMPTIONS,
        qualificationVersion: QUALIFICATION_VERSION,
      });
      expect(await qualification.supersedeOlderThan(newer.id, new Date())).toBe(1);
      expect((await qualification.latestRun())?.id).toBe(newer.id);
      expect((await qualification.findRun(older.id))?.supersededAt).not.toBeNull();
    });

    it('records live evidence without any field that could hold a secret', async () => {
      const { qualification } = harness.services;
      const run = await qualification.createRun({
        startedBy: 'owner',
        assumptions: EMPTY_ASSUMPTIONS,
        qualificationVersion: QUALIFICATION_VERSION,
      });
      const evidence = await qualification.recordLiveEvidence({
        kind: 'live_write',
        runId: run.id,
        repositoryFullName: 'owner/sandbox',
        commitSha: 'deadbeef',
        branchName: 'jarvis/qualification',
        pullRequestUrl: 'https://github.com/owner/sandbox/pull/1',
        pullRequestNumber: 1,
        qualificationVersion: QUALIFICATION_VERSION,
        summary: 'A draft pull request was opened and left unmerged.',
      });

      expect(Object.keys(evidence)).not.toContain('token');
      expect(evidence.pullRequestNumber).toBe(1);
      expect(await qualification.listLiveEvidence()).toHaveLength(1);
    });
  });

  /* --------------------------------------------------------------- schedules */

  describe('schedules', () => {
    it('lets exactly one caller claim an occurrence, even under concurrency', async () => {
      const { schedules } = harness.services;
      const schedule = await schedules.create({
        kind: 'morning_briefing',
        name: 'Morning briefing',
        cadence: 'daily',
        hour: 7,
        minute: 30,
        timeZone: 'Europe/London',
        catchUp: 'run_latest',
        maxRetries: 2,
        createdBy: 'owner',
      });

      const claim = {
        scheduleId: schedule.id,
        occurrenceAt: new Date('2026-03-29T06:30:00.000Z'),
        occurrenceLocal: '2026-03-29T07:30',
        idempotencyKey: `${schedule.id}:2026-03-29T07:30`,
        state: 'running' as const,
      };

      const winners = await Promise.all(
        Array.from({ length: 6 }, () => schedules.claimOccurrence(claim)),
      );
      expect(winners.filter((row) => row !== null)).toHaveLength(1);

      /* And a later, sequential attempt is refused too. */
      expect(await schedules.claimOccurrence(claim)).toBeNull();
    });

    it('treats a DST-repeated wall-clock hour as one occurrence', async () => {
      const { schedules } = harness.services;
      const schedule = await schedules.create({
        kind: 'morning_briefing',
        name: 'Early briefing',
        cadence: 'daily',
        hour: 1,
        minute: 30,
        timeZone: 'Europe/London',
        catchUp: 'run_latest',
        maxRetries: 2,
        createdBy: 'owner',
      });

      /*
       * On the autumn transition, 01:30 local happens twice — at 00:30Z and again at 01:30Z. The
       * idempotency key is derived from the *local* time, so the second one is refused.
       */
      const key = `${schedule.id}:2026-10-25T01:30`;
      const first = await schedules.claimOccurrence({
        scheduleId: schedule.id,
        occurrenceAt: new Date('2026-10-25T00:30:00.000Z'),
        occurrenceLocal: '2026-10-25T01:30',
        idempotencyKey: key,
        state: 'running',
      });
      const second = await schedules.claimOccurrence({
        scheduleId: schedule.id,
        occurrenceAt: new Date('2026-10-25T01:30:00.000Z'),
        occurrenceLocal: '2026-10-25T01:30',
        idempotencyKey: key,
        state: 'running',
      });

      expect(first).not.toBeNull();
      expect(second).toBeNull();
      expect(await schedules.listExecutions(schedule.id)).toHaveLength(1);
    });

    it('surfaces a failed execution as due for retry only once its time has come', async () => {
      const { schedules } = harness.services;
      const schedule = await schedules.create({
        kind: 'evidence_refresh',
        name: 'Refresh',
        cadence: 'daily',
        hour: 3,
        minute: 0,
        timeZone: 'UTC',
        catchUp: 'skip_missed',
        maxRetries: 2,
        createdBy: 'owner',
      });
      const execution = await schedules.claimOccurrence({
        scheduleId: schedule.id,
        occurrenceAt: new Date('2026-03-01T03:00:00.000Z'),
        occurrenceLocal: '2026-03-01T03:00',
        idempotencyKey: `${schedule.id}:2026-03-01T03:00`,
        state: 'running',
      });

      await schedules.patchExecution(execution!.id, {
        state: 'failed',
        attempt: 1,
        nextRetryAt: new Date('2026-03-01T03:10:00.000Z'),
        failureCode: 'provider_unavailable',
      });

      expect(await schedules.pendingRetries(new Date('2026-03-01T03:05:00.000Z'))).toHaveLength(0);
      expect(await schedules.pendingRetries(new Date('2026-03-01T03:15:00.000Z'))).toHaveLength(1);
    });
  });

  /* ----------------------------------------------------------- notifications */

  describe('notifications', () => {
    it('collapses a recurring problem into one row and starts fresh after acknowledgement', async () => {
      const { notifications } = harness.services;
      const first = await notifications.upsert(
        {
          category: 'sync_failing',
          severity: 'high',
          title: 'A sync is failing',
          dedupeKey: 'sync:project-1',
        },
        new Date('2026-03-01T09:00:00.000Z'),
      );
      const second = await notifications.upsert(
        {
          category: 'sync_failing',
          severity: 'high',
          title: 'A sync is failing',
          dedupeKey: 'sync:project-1',
        },
        new Date('2026-03-01T09:10:00.000Z'),
      );

      expect(first.collapsed).toBe(false);
      expect(second.collapsed).toBe(true);
      expect(second.notification.id).toBe(first.notification.id);
      expect(second.notification.occurrenceCount).toBe(2);

      await notifications.acknowledge(first.notification.id, new Date());
      const third = await notifications.upsert(
        {
          category: 'sync_failing',
          severity: 'high',
          title: 'It is failing again',
          dedupeKey: 'sync:project-1',
        },
        new Date('2026-03-02T09:00:00.000Z'),
      );
      expect(third.collapsed).toBe(false);
      expect(third.notification.id).not.toBe(first.notification.id);
    });

    it('collapses correctly when several reports arrive at once', async () => {
      const { notifications } = harness.services;
      const now = new Date('2026-03-01T09:00:00.000Z');
      const results = await Promise.all(
        Array.from({ length: 5 }, () =>
          notifications.upsert(
            {
              category: 'worker_offline',
              severity: 'critical',
              title: 'The worker is offline',
              dedupeKey: 'worker:offline',
            },
            now,
          ),
        ),
      );

      const ids = new Set(results.map((result) => result.notification.id));
      expect(ids.size).toBe(1);
      expect(results.filter((result) => !result.collapsed)).toHaveLength(1);
      expect(await notifications.list({ categories: ['worker_offline'] })).toHaveLength(1);
    });

    it('keeps one delivery row per channel and never lets a failure hide a later success', async () => {
      const { notifications } = harness.services;
      const { notification } = await notifications.upsert(
        {
          category: 'briefing_ready',
          severity: 'low',
          title: 'Your briefing is ready',
          dedupeKey: 'briefing:2026-03-01',
        },
        new Date(),
      );

      await notifications.recordDelivery({
        notificationId: notification.id,
        channel: 'web_push',
        state: 'failed',
        attempt: 1,
        failureMessage: 'Endpoint gone',
      });
      await notifications.recordDelivery({
        notificationId: notification.id,
        channel: 'web_push',
        state: 'delivered',
        attempt: 2,
        deliveredAt: new Date(),
      });

      const deliveries = await notifications.listDeliveries(notification.id);
      expect(deliveries).toHaveLength(1);
      expect(deliveries[0]?.state).toBe('delivered');
      expect(deliveries[0]?.attempt).toBe(2);
    });
  });

  /* ------------------------------------------------------ push subscriptions */

  describe('push subscriptions', () => {
    it('never returns credential material through the ordinary read path', async () => {
      const { push } = harness.services;
      const subscription = await push.register({
        endpoint: 'https://push.example.com/abcdef',
        endpointHash: 'hash-abcdef',
        keyP256dh: 'p256dh-value',
        keyAuth: 'auth-value',
        label: 'Phone',
      });

      expect(JSON.stringify(subscription)).not.toContain('push.example.com');
      expect(JSON.stringify(subscription)).not.toContain('auth-value');
      expect(JSON.stringify(await push.list())).not.toContain('p256dh-value');

      const sendable = await push.active();
      expect(sendable[0]?.endpoint).toBe('https://push.example.com/abcdef');
    });

    it('destroys the keys when a subscription is revoked', async () => {
      const { push, db } = harness.services;
      const subscription = await push.register({
        endpoint: 'https://push.example.com/xyz',
        endpointHash: 'hash-xyz',
        keyP256dh: 'p256dh-value',
        keyAuth: 'auth-value',
      });

      await push.revoke(subscription.id, new Date());
      expect(await push.active()).toHaveLength(0);

      const raw = await db.execute(
        sql`select endpoint, key_auth, key_p256dh from push_subscriptions where id = ${subscription.id}`,
      );
      const row = rowsOf(raw)[0] ?? {};
      expect(row.endpoint).toBe('');
      expect(row.key_auth).toBe('');
      expect(row.key_p256dh).toBe('');
    });
  });

  /* ----------------------------------------------------------------- money */

  describe('usage and budgets', () => {
    it('separates reported, estimated and unknown cost rather than summing nulls as zero', async () => {
      const { usage } = harness.services;
      await usage.record({
        kind: 'agent_task',
        modelName: 'model-a',
        reportedCostUsd: 0.5,
        costBasis: 'reported',
        outputTokens: 1000,
        occurredAt: new Date('2026-03-01T10:00:00.000Z'),
      });
      await usage.record({
        kind: 'review',
        modelName: 'model-a',
        estimatedCostUsd: 0.25,
        costBasis: 'estimated',
        outputTokens: 500,
        occurredAt: new Date('2026-03-01T11:00:00.000Z'),
      });
      await usage.record({
        kind: 'answer',
        modelName: 'model-b',
        costBasis: 'unknown',
        outputTokens: 200,
        occurredAt: new Date('2026-03-02T10:00:00.000Z'),
      });

      const totals = await usage.totals({
        from: new Date('2026-03-01T00:00:00.000Z'),
        to: new Date('2026-03-03T00:00:00.000Z'),
      });
      expect(totals.reportedUsd).toBeCloseTo(0.5);
      expect(totals.estimatedUsd).toBeCloseTo(0.25);
      expect(totals.unknownCount).toBe(1);
      expect(totals.recordCount).toBe(3);
      expect(totals.outputTokens).toBe(1700);
    });

    it('reports a day with no measurable cost as unknown rather than as zero spend', async () => {
      const { usage } = harness.services;
      await usage.record({
        kind: 'answer',
        modelName: 'model-b',
        costBasis: 'unknown',
        outputTokens: 200,
        occurredAt: new Date('2026-03-02T10:00:00.000Z'),
      });
      await usage.record({
        kind: 'agent_task',
        modelName: 'model-a',
        reportedCostUsd: 1.25,
        costBasis: 'reported',
        occurredAt: new Date('2026-03-03T10:00:00.000Z'),
      });

      const daily = await usage.dailySpend({
        from: new Date('2026-03-01T00:00:00.000Z'),
        to: new Date('2026-03-04T00:00:00.000Z'),
      });
      const unknownDay = daily.find((entry) => entry.day === '2026-03-02');
      const knownDay = daily.find((entry) => entry.day === '2026-03-03');
      expect(unknownDay?.usd).toBeNull();
      expect(knownDay?.usd).toBeCloseTo(1.25);
    });

    it('records a usage row once however often a worker replays its report', async () => {
      const { usage } = harness.services;
      const first = await usage.record({
        kind: 'agent_task',
        modelName: 'model-a',
        costBasis: 'unknown',
        idempotencyKey: 'run-1:final',
      });
      const replay = await usage.record({
        kind: 'agent_task',
        modelName: 'model-a',
        costBasis: 'unknown',
        idempotencyKey: 'run-1:final',
      });

      expect(first).not.toBeNull();
      expect(replay).toBeNull();
      expect((await usage.totals({})).recordCount).toBe(1);
    });

    it('accumulates rather than replaces, so a retried task does not undercount', async () => {
      const { usage } = harness.services;
      for (const attempt of [1, 2, 3]) {
        await usage.record({
          kind: 'agent_task',
          modelName: 'model-a',
          reportedCostUsd: 0.4,
          costBasis: 'reported',
          outputTokens: 100,
          retryCount: attempt - 1,
          idempotencyKey: `run-1:attempt-${attempt}`,
        });
      }
      const totals = await usage.totals({});
      expect(totals.recordCount).toBe(3);
      expect(totals.reportedUsd).toBeCloseTo(1.2);
      expect(totals.outputTokens).toBe(300);
    });

    it('keeps one row per budget target and finds every budget that could bind', async () => {
      const { budgets } = harness.services;
      const first = await budgets.upsert({
        scope: 'day',
        limitUsd: 10,
        warnAtPercent: 80,
        kind: 'hard',
      });
      const second = await budgets.upsert({
        scope: 'day',
        limitUsd: 20,
        warnAtPercent: 80,
        kind: 'hard',
      });
      expect(second.id).toBe(first.id);
      expect(second.limitUsd).toBe(20);

      await budgets.upsert({
        scope: 'model',
        targetId: 'model-a',
        limitUsd: 5,
        warnAtPercent: 80,
        kind: 'warning',
      });
      const applicable = await budgets.applicable({ modelName: 'model-a' });
      expect(applicable.map((budget) => budget.scope).sort()).toEqual(['day', 'model']);

      /* A budget for a different model must not be picked up. */
      const other = await budgets.applicable({ modelName: 'model-z' });
      expect(other.map((budget) => budget.scope)).toEqual(['day']);
    });

    it('stops applying an override once it expires', async () => {
      const { budgets } = harness.services;
      const budget = await budgets.upsert({
        scope: 'day',
        limitUsd: 10,
        warnAtPercent: 80,
        kind: 'hard',
      });
      const override = await budgets.recordOverride({
        budgetId: budget.id,
        reason: 'A one-off release run.',
        previousLimitUsd: 10,
        newLimitUsd: 40,
        approvedBy: 'owner',
        expiresAt: new Date('2026-03-01T12:00:00.000Z'),
      });

      expect(
        (await budgets.activeOverride(budget.id, new Date('2026-03-01T11:00:00.000Z')))?.id,
      ).toBe(override.id);
      expect(
        await budgets.activeOverride(budget.id, new Date('2026-03-01T13:00:00.000Z')),
      ).toBeNull();
    });
  });

  /* ------------------------------------------------------------ rate limits */

  describe('rate limiting', () => {
    it('counts correctly when requests arrive simultaneously', async () => {
      const { rateLimits } = harness.services;
      const now = new Date('2026-03-01T10:00:05.000Z');
      const verdicts = await Promise.all(
        Array.from({ length: 5 }, () =>
          rateLimits.hit({ key: 'owner:/api/ask', limit: 3, windowSeconds: 60, now }),
        ),
      );

      /* Each request must see a distinct count; two seeing "1" is the bug this test exists for. */
      expect(new Set(verdicts.map((verdict) => verdict.count)).size).toBe(5);
      expect(verdicts.filter((verdict) => verdict.allowed)).toHaveLength(3);
    });

    it('starts a fresh count in the next window and sweeps the old bucket', async () => {
      const { rateLimits } = harness.services;
      await rateLimits.hit({
        key: 'owner:/api/ask',
        limit: 2,
        windowSeconds: 60,
        now: new Date('2026-03-01T10:00:05.000Z'),
      });
      const next = await rateLimits.hit({
        key: 'owner:/api/ask',
        limit: 2,
        windowSeconds: 60,
        now: new Date('2026-03-01T10:01:05.000Z'),
      });
      expect(next.count).toBe(1);
      expect(next.allowed).toBe(true);

      expect(await rateLimits.sweep(new Date('2026-03-01T10:01:00.000Z'))).toBe(1);
    });
  });

  /* ----------------------------------------------------------------- audit */

  describe('audit trail', () => {
    it('verifies a well-formed chain and redacts what it stores', async () => {
      const { audit } = harness.services;
      for (const action of ['knowledge.create', 'knowledge.confirm', 'budget.override']) {
        await audit.append({
          actor: 'owner',
          actorKind: 'owner',
          action,
          outcome: 'allowed',
          summary: `Performed ${action}.`,
          detail: { note: 'fine', apiKey: 'sk-ant-api03-0123456789abcdefghijklmnop' },
        });
      }

      const verdict = await audit.verifyChain();
      expect(verdict.ok).toBe(true);
      expect(verdict.checked).toBe(3);

      const stored = await audit.list({ limit: 3 });
      expect(JSON.stringify(stored)).not.toContain('0123456789abcdefghijklmnop');
    });

    it('detects an edited record', async () => {
      const { audit, db } = harness.services;
      for (const action of ['knowledge.create', 'knowledge.confirm', 'knowledge.forget']) {
        await audit.append({
          actor: 'owner',
          actorKind: 'owner',
          action,
          outcome: 'allowed',
          summary: `Performed ${action}.`,
        });
      }

      await db.execute(
        sql`update audit_events set summary = 'nothing happened' where sequence = 2`,
      );
      const verdict = await audit.verifyChain();
      expect(verdict.ok).toBe(false);
      expect(verdict.brokenAt).toBe(2);
      expect(verdict.reason).toContain('R-AU1');
    });

    it('detects a removed record', async () => {
      const { audit, db } = harness.services;
      for (const action of ['knowledge.create', 'knowledge.confirm', 'knowledge.forget']) {
        await audit.append({
          actor: 'owner',
          actorKind: 'owner',
          action,
          outcome: 'allowed',
          summary: `Performed ${action}.`,
        });
      }

      await db.execute(sql`delete from audit_events where sequence = 2`);
      const verdict = await audit.verifyChain();
      expect(verdict.ok).toBe(false);
      expect(verdict.brokenAt).toBe(3);
      expect(verdict.reason).toContain('R-AU2');
    });

    it('links a chain correctly even when records are appended concurrently', async () => {
      const { audit } = harness.services;
      await Promise.all(
        Array.from({ length: 8 }, (_, index) =>
          audit.append({
            actor: 'system',
            actorKind: 'system',
            action: 'schedule.run',
            outcome: 'allowed',
            summary: `Run ${index}.`,
          }),
        ),
      );

      expect(await audit.count()).toBe(8);
      const verdict = await audit.verifyChain();
      expect(verdict.ok).toBe(true);
      expect(verdict.checked).toBe(8);
    });
  });

  /* ------------------------------------------------------------ connectors */

  describe('connectors', () => {
    it('starts disabled and loses its credential flag when revoked', async () => {
      const { connectors } = harness.services;
      const initial = await connectors.ensure('github_read', null);
      expect(initial.state).toBe('disabled');
      expect(initial.credentialConfigured).toBe(false);

      await connectors.recordCredential({
        connectorId: 'github_read',
        projectId: null,
        configured: true,
        identity: 'jarvis-bot',
        rotatedAt: new Date('2026-02-01T00:00:00.000Z'),
      });
      await connectors.setState({
        connectorId: 'github_read',
        projectId: null,
        state: 'enabled',
        actor: 'owner',
        now: new Date(),
      });

      const revoked = await connectors.setState({
        connectorId: 'github_read',
        projectId: null,
        state: 'revoked',
        actor: 'owner',
        reason: 'Rotating the token.',
        now: new Date(),
      });
      expect(revoked.state).toBe('revoked');
      expect(revoked.credentialConfigured).toBe(false);
      expect(revoked.credentialIdentity).toBeNull();
    });

    it('has no field anywhere in its record that could hold a credential value', async () => {
      const { connectors } = harness.services;
      const record = await connectors.ensure('web_url', null);
      const keys = Object.keys(record);
      expect(keys).toContain('credentialConfigured');
      expect(keys).not.toContain('credential');
      expect(keys).not.toContain('token');
      expect(keys).not.toContain('secret');
    });
  });

  /* ------------------------------------------------------------ lifecycle */

  describe('data lifecycle', () => {
    it('records that a deletion happened without keeping what was deleted', async () => {
      const { deletionReceipts } = harness.services;
      const receipt = await deletionReceipts.record({
        subjectKind: 'knowledge_source',
        subjectId: 'source-1',
        reason: 'The owner deleted it.',
        itemCount: 12,
        requestedBy: 'owner',
        scrubbedTargets: ['chunks', 'search_vector', 'excerpts', 'body_text'],
      });

      expect(receipt.itemCount).toBe(12);
      expect(receipt.scrubbedTargets).toContain('search_vector');
      expect(Object.keys(receipt)).not.toContain('content');
      expect(await deletionReceipts.list()).toHaveLength(1);
    });

    it('lets a voice capture retention window lapse on its own', async () => {
      const { voice } = harness.services;
      const capture = await voice.create({
        transcript: 'Draft a mission to fix the login screen.',
        intent: 'mission_draft',
        audioRetained: true,
        audioDeleteAfter: new Date('2026-03-01T00:00:00.000Z'),
      });
      expect(capture.state).toBe('awaiting_confirmation');

      expect(await voice.expireRetention(new Date('2026-02-28T00:00:00.000Z'))).toBe(0);
      expect(await voice.expireRetention(new Date('2026-03-02T00:00:00.000Z'))).toBe(1);
      expect((await voice.findById(capture.id))?.audioRetained).toBe(false);
    });

    it('stores a quiet briefing as quiet rather than padding it out', async () => {
      const { briefingRecords } = harness.services;
      const content: BriefingContent = {
        kind: 'daily',
        window: {
          from: '2026-03-01T00:00:00.000Z',
          to: '2026-03-02T00:00:00.000Z',
          firstEver: true,
        },
        projectIds: [],
        headline: 'Nothing changed in this window.',
        items: [],
        stalled: [],
        decisions: [],
        costs: null,
        evidenceIds: [],
        isQuiet: true,
        gaps: [],
        generatedAt: '2026-03-02T00:00:00.000Z',
      };

      const stored = await briefingRecords.create({
        kind: 'daily',
        windowFrom: new Date('2026-03-01T00:00:00.000Z'),
        windowTo: new Date('2026-03-02T00:00:00.000Z'),
        content,
        method: 'deterministic',
        isQuiet: true,
      });

      expect(stored.isQuiet).toBe(true);
      expect(stored.content.items).toEqual([]);
      expect((await briefingRecords.latest('daily'))?.id).toBe(stored.id);
      expect((await briefingRecords.markRead(stored.id, new Date())).readAt).not.toBeNull();
    });
  });
});

/** The drivers disagree about `execute`'s shape; the tests only need the rows. */
function rowsOf(result: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(result)) return result as Array<Record<string, unknown>>;
  if (result && typeof result === 'object' && 'rows' in result) {
    const rows = (result as { rows: unknown }).rows;
    if (Array.isArray(rows)) return rows as Array<Record<string, unknown>>;
  }
  return [];
}
