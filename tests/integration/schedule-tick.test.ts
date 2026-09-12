import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as AuthGuard from '@/server/auth/guard';
import type * as Container from '@/server/container';
import type { ActivationCapability } from '@/domain/qualification';
import type { NotificationRepository } from '@/server/repositories/automation-types';
import { ScheduleService, type ScheduleServiceDeps } from '@/server/schedules/schedule-service';
import { qualifiedConfig, qualifyToLiveRead } from '../helpers/qualified';
import { createHarness, type TestHarness } from '../helpers/services';

/**
 * The tick, driven the way something is actually going to drive it.
 *
 * `tests/integration/reminders-and-briefings.test.ts` proves that a tick delivers the right thing.
 * This file is about the tick being *called* — repeatedly, concurrently, and by something that is
 * not a test — because that is where it was broken: `/api/cron/schedules` had no caller anywhere
 * in the repository, so on the documented single-machine deployment no reminder had ever fired.
 *
 * The four things a caller on a timer needs, and which nothing checked:
 *
 *  - calling it twice must not deliver twice, and calling it while it is running must not either;
 *  - one schedule that blows up must not take the pass, or the caller, down with it;
 *  - a delivery that failed must leave the thing still owed, rather than consuming it;
 *  - and it must eventually give up, without leaving the schedule owing something nothing is
 *    ever going to deliver.
 */
describe('a schedule tick something can drive', () => {
  let harness: TestHarness;
  let now: Date;

  /* A fixed clock the tests move by hand. Real time would make every assertion a race. */
  const at = (iso: string) => {
    now = new Date(iso);
  };

  beforeEach(async () => {
    at('2026-03-10T07:00:00.000Z');
    harness = await createHarness({ config: qualifiedConfig(), clock: () => now });
    /* Unattended work needs the rung; without this every assertion below would pass as "skipped". */
    await qualifyToLiveRead(harness);
  });

  afterEach(async () => {
    await harness.close();
  });

  const unread = async () => harness.services.notifications.list({ unreadOnly: true, limit: 50 });

  const remindDaily = async (input: { hour: number; text: string }) =>
    harness.services.schedules.create({
      kind: 'reminder',
      name: input.text,
      cadence: 'daily',
      hour: input.hour,
      minute: 0,
      timeZone: 'UTC',
      catchUp: 'run_latest',
      maxRetries: 2,
      instruction: input.text,
      createdBy: 'test-owner',
    });

  const remindOnce = async (input: { onDate: string; hour: number; text: string }) =>
    harness.services.schedules.create({
      kind: 'reminder',
      name: input.text,
      cadence: 'once',
      hour: input.hour,
      minute: 0,
      timeZone: 'UTC',
      onDate: input.onDate,
      catchUp: 'run_latest',
      maxRetries: 2,
      instruction: input.text,
      createdBy: 'test-owner',
    });

  /**
   * The container's own wiring, with one dependency replaced.
   *
   * Everything a test does not name is the shipping object, so a test about a broken notification
   * store is not also quietly a test about a stubbed qualification ladder.
   */
  const serviceWith = (overrides: Partial<ScheduleServiceDeps>): ScheduleService =>
    new ScheduleService({
      schedules: harness.services.schedules,
      notifications: harness.services.notifications,
      briefings: harness.services.briefingRecords,
      settings: harness.services.settings,
      audit: harness.services.audit,
      allows: async (capability) => {
        const verdict = await harness.services.qualificationService.evaluate(
          capability as ActivationCapability,
        );
        return {
          allowed: verdict.allowed,
          reason: verdict.reason ?? 'Not available at this level.',
        };
      },
      clock: () => now,
      ...overrides,
    });

  /** The real repository with `upsert` made unreachable on demand. Nothing else is replaced. */
  const unreachableWhile = (
    real: NotificationRepository,
    down: () => boolean,
  ): NotificationRepository =>
    new Proxy(real, {
      get(target, property, receiver) {
        if (property === 'upsert' && down()) {
          return () => Promise.reject(new Error('The notification store is unreachable.'));
        }
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });

  /*
   * The caller. Everything else in this file assumes something calls `tick`; this is the assertion
   * that something does.
   *
   * Through `operatorService.tick()` — the pass the enrolled worker drives on its own timer, which
   * on the documented single-machine install is the only thing that reliably runs at all. Nothing
   * stubbed: the reminder is created through the real schedule service, and the only call made is
   * the one the worker makes every minute.
   */
  it('is called by the pass of the operating loop the worker already drives', async () => {
    await remindDaily({ hour: 9, text: 'Ring the dentist' });

    at('2026-03-10T09:00:30.000Z');
    await harness.services.operatorService.tick();

    const delivered = await unread();
    expect(delivered.map((notification) => notification.title)).toContain('Ring the dentist');
  }, 60_000);

  it('fires a schedule once and only once across two ticks', async () => {
    await remindDaily({ hour: 9, text: 'Ring the dentist' });

    at('2026-03-10T09:00:30.000Z');
    const first = await harness.services.scheduleService.tick();
    at('2026-03-10T09:01:30.000Z');
    const second = await harness.services.scheduleService.tick();

    expect(first.delivered).toBe(1);
    expect(second.delivered, 'the second tick delivered the same morning again').toBe(0);
    expect(await unread()).toHaveLength(1);
  });

  it('does the work once when two ticks overlap', async () => {
    await remindDaily({ hour: 9, text: 'Ring the dentist' });
    at('2026-03-10T09:00:30.000Z');

    /*
     * A caller on a timer whose previous pass has not finished. The claim already makes a second
     * delivery impossible; the guard is what stops the second pass doing the whole tick's work
     * again — reading every schedule, composing every briefing — for nothing.
     */
    const [first, second] = await Promise.all([
      harness.services.scheduleService.tick(),
      harness.services.scheduleService.tick(),
    ]);

    expect(first.delivered + second.delivered).toBe(1);
    expect([first.held, second.held], 'one of two overlapping passes should stand down').toContain(
      true,
    );
    expect(await unread()).toHaveLength(1);
  });

  it('lets one broken schedule fail on its own', async () => {
    await remindDaily({ hour: 8, text: 'Ring the dentist' });
    /*
     * A zone the platform does not know. `Intl` throws on it, from inside the due-ness arithmetic
     * and before anything is claimed — which is the shape of the real hazard: a row written by an
     * older build, or a zone a government retired, taking every other schedule down with it.
     */
    const broken = await harness.services.schedules.create({
      kind: 'reminder',
      name: 'Broken zone',
      cadence: 'daily',
      hour: 9,
      minute: 0,
      timeZone: 'Mars/Olympus',
      catchUp: 'run_latest',
      maxRetries: 2,
      instruction: 'Never arrives.',
      createdBy: 'test-owner',
    });
    await remindDaily({ hour: 10, text: 'Walk the dog' });

    at('2026-03-10T11:00:00.000Z');
    const report = await harness.services.scheduleService.tick();

    expect(report.failed).toBe(1);
    expect(report.delivered, 'the schedules either side of the broken one').toBe(2);
    expect(
      (await unread()).map((notification) => notification.body).sort(),
      'both good reminders arrived',
    ).toEqual(['Ring the dentist', 'Walk the dog']);

    /* Recorded, not just counted: a failure nobody can find is a failure nobody fixes. */
    const audit = await harness.services.audit.list({ limit: 50 });
    expect(
      audit.some((entry) => entry.action === 'schedule.failed' && entry.subjectId === broken.id),
    ).toBe(true);
  });

  it('leaves a snoozed reminder owed when the delivery fails', async () => {
    const created = await remindOnce({ onDate: '2026-03-10', hour: 9, text: 'Ring the dentist' });
    at('2026-03-10T09:00:30.000Z');
    await harness.services.scheduleService.tick();
    await harness.services.notifications.acknowledge((await unread())[0]!.id, now);

    /* "Not now — in an hour." */
    await harness.services.schedules.patch(created.id, {
      snoozedUntil: new Date('2026-03-10T10:00:00.000Z'),
    });

    let down = true;
    const brittle = serviceWith({
      notifications: unreachableWhile(harness.services.notifications, () => down),
    });

    at('2026-03-10T10:00:30.000Z');
    const failed = await brittle.tick();
    expect(failed.delivered).toBe(0);
    expect(failed.failed).toBe(1);

    /*
     * The whole point. A snooze is spent by a delivery that worked, not by one that was attempted:
     * consuming it here is how "remind me in an hour" became "never".
     */
    expect(
      (await harness.services.schedules.findById(created.id))?.snoozedUntil,
      'the reminder was destroyed by a delivery that failed',
    ).not.toBeNull();

    /* And it arrives once the store comes back, under the schedule's own retry bound. */
    down = false;
    at('2026-03-10T10:06:00.000Z');
    expect((await brittle.tick()).delivered).toBe(1);
    const arrived = await unread();
    expect(arrived).toHaveLength(1);
    expect(arrived[0]?.body).toBe('Ring the dentist');
    expect((await harness.services.schedules.findById(created.id))?.snoozedUntil).toBeNull();
  });

  it('gives up on a snooze it cannot deliver, rather than on the schedule', async () => {
    const created = await remindDaily({ hour: 9, text: 'Ring the dentist' });
    at('2026-03-10T09:00:30.000Z');
    await harness.services.scheduleService.tick();
    await harness.services.notifications.acknowledge((await unread())[0]!.id, now);
    await harness.services.schedules.patch(created.id, {
      snoozedUntil: new Date('2026-03-10T10:00:00.000Z'),
    });

    /* Down for good this time, so every attempt the schedule's own bound allows is spent. */
    const brittle = serviceWith({
      notifications: unreachableWhile(harness.services.notifications, () => true),
    });
    for (const instant of [
      '2026-03-10T10:00:30.000Z' /* the snooze itself */,
      '2026-03-10T10:06:00.000Z' /* five minutes later */,
      '2026-03-10T10:20:00.000Z' /* ten more */,
    ]) {
      at(instant);
      expect((await brittle.tick()).failed, `nothing was attempted at ${instant}`).toBe(1);
    }

    /* The bound holds: a reminder that has failed three times needs a person, not a fourth try. */
    at('2026-03-10T11:30:00.000Z');
    expect((await brittle.tick()).failed, 'a fourth attempt').toBe(0);

    /*
     * And what is left is still a schedule. A snooze that has come round is, by R-SC8, the only
     * thing a schedule offers — so one still set against an occurrence nothing will ever try
     * again does not lose a reminder, it stops the daily reminder for good.
     */
    expect(
      (await harness.services.schedules.findById(created.id))?.snoozedUntil,
      'the schedule is still offering an occurrence that can never be claimed again',
    ).toBeNull();

    at('2026-03-11T09:00:30.000Z');
    expect((await harness.services.scheduleService.tick()).delivered, 'tomorrow never came').toBe(
      1,
    );
    expect((await unread()).map((notification) => notification.body)).toEqual(['Ring the dentist']);
  });

  it('does not fire an occurrence from before the schedule was created', async () => {
    /*
     * Its own harness, on a clock near real time. `createdAt` is written by the database's own
     * `now()`, which no injected clock reaches, so a fixture sitting months in the past cannot
     * exercise this rule at all — its anchor would be in the future and is ignored on purpose.
     */
    at(new Date().toISOString());
    const fresh = await createHarness({ config: qualifiedConfig(), clock: () => now });
    try {
      await qualifyToLiveRead(fresh);

      const earlier = new Date(now.getTime() - 2 * 3_600_000);
      const created = await fresh.services.schedules.create({
        kind: 'morning_briefing',
        name: 'Morning briefing',
        cadence: 'daily',
        hour: earlier.getUTCHours(),
        minute: earlier.getUTCMinutes(),
        timeZone: 'UTC',
        catchUp: 'run_latest',
        maxRetries: 2,
        createdBy: 'test-owner',
      });

      /* A minute after the row was written, by the clock that wrote it. */
      at(new Date(new Date(created.createdAt).getTime() + 60_000).toISOString());
      const immediately = await fresh.services.scheduleService.tick();
      expect(
        immediately.delivered,
        'a schedule created this afternoon delivered this morning',
      ).toBe(0);
      expect(await fresh.services.briefingRecords.list(10)).toHaveLength(0);

      /* Anchored forward, not silenced: the first occurrence after creation still arrives. */
      at(new Date(earlier.getTime() + 86_400_000 + 30_000).toISOString());
      expect((await fresh.services.scheduleService.tick()).delivered).toBe(1);
    } finally {
      await fresh.close();
    }
  });
});

/**
 * The route, when the pass it drives throws.
 *
 * The tick used to sit outside the handler's `try`, so a database that went away came back to the
 * caller as an unhandled exception instead of an error response — and the thing driving the tick
 * on a timer is exactly the caller least able to cope with that.
 */
describe('the cron route', () => {
  afterEach(() => {
    vi.doUnmock('@/server/auth/guard');
    vi.doUnmock('@/server/container');
    vi.resetModules();
  });

  it('answers with an error rather than throwing when the tick blows up', async () => {
    vi.resetModules();
    vi.doMock('@/server/auth/guard', async () => ({
      ...(await vi.importActual<typeof AuthGuard>('@/server/auth/guard')),
      assertCronAuthorised: () => undefined,
    }));
    vi.doMock('@/server/container', async () => ({
      ...(await vi.importActual<typeof Container>('@/server/container')),
      getServices: async () => ({
        scheduleService: {
          tick: () => Promise.reject(new Error('the database went away')),
        },
      }),
    }));

    const route = await import('@/app/api/cron/schedules/route');
    const response = await route.POST(
      new Request('http://localhost:3000/api/cron/schedules', { method: 'POST' }),
    );

    expect(response.status).toBe(500);
    expect((await response.json()) as { error?: { code?: string } }).toHaveProperty('error');
  });
});
