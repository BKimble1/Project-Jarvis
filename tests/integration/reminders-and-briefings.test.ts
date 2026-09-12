import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { QUIET_HOURS_KEY } from '@/server/schedules/schedule-service';
import { createHarness, type TestHarness } from '../helpers/services';
import { qualifiedConfig, qualifyToLiveRead } from '../helpers/qualified';

/**
 * Schedules that actually fire.
 *
 * ## What was wrong before
 *
 * Nothing, and that was the problem. The tables were there, the wall-clock arithmetic was there,
 * the DST policy and the idempotency key and the catch-up rules and the notification routing were
 * all there and all correct — and no line of code called any of them. A reminder could be created
 * and would never arrive. That is the worst shape a gap can take, because from the inside it looks
 * finished: the types line up, the unit tests pass, and the only way to find out is to set a
 * reminder and wait.
 *
 * So these tests are all about *arrival*. Each one sets something up, moves a clock, and asks
 * whether the thing Blake asked for actually happened — and, just as importantly, whether asking
 * twice makes it happen twice.
 */
describe('reminders and briefings that arrive', () => {
  let harness: TestHarness;
  let now: Date;

  /* A fixed clock the tests move by hand. Real time would make every assertion a race. */
  const at = (iso: string) => {
    now = new Date(iso);
  };

  beforeEach(async () => {
    at('2026-03-10T08:59:00.000Z');
    harness = await createHarness({ config: qualifiedConfig(), clock: () => now });
    /*
     * A schedule is unattended work, so the activation ladder applies to it exactly as it applies
     * to a mission — and on a fresh install nothing scheduled runs at all. That is deliberate and
     * is pinned by its own test below; every other test here is about what happens *after* the
     * deployment has earned the rung, so the fixture climbs it first.
     */
    await qualifyToLiveRead(harness);
  });

  afterEach(async () => {
    await harness.close();
  });

  /** A one-time reminder, in UTC so the wall clock and the instant agree. */
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

  const unread = async () => harness.services.notifications.list({ unreadOnly: true, limit: 50 });

  it('delivers a one-time reminder when its time comes, and not before', async () => {
    await remindOnce({ onDate: '2026-03-10', hour: 9, text: 'Ring the dentist' });

    /* One minute early. Nothing owed yet. */
    const early = await harness.services.scheduleService.tick();
    expect(early.delivered).toBe(0);
    expect(await unread()).toHaveLength(0);

    at('2026-03-10T09:00:30.000Z');
    const on = await harness.services.scheduleService.tick();
    expect(on.delivered).toBe(1);

    const notifications = await unread();
    expect(notifications).toHaveLength(1);
    /* His words, given back unchanged. A reminder that had been rephrased is a different one. */
    expect(notifications[0]?.body).toBe('Ring the dentist');
  });

  it('says it once however often the tick runs', async () => {
    await remindOnce({ onDate: '2026-03-10', hour: 9, text: 'Ring the dentist' });
    at('2026-03-10T09:00:30.000Z');

    await harness.services.scheduleService.tick();
    at('2026-03-10T09:01:30.000Z');
    await harness.services.scheduleService.tick();
    at('2026-03-10T09:02:30.000Z');
    await harness.services.scheduleService.tick();

    /*
     * The durability story, exercised: a tick a minute, a restart, and the hour that happens twice
     * when the clocks go back all converge on one claim because the key comes from the local
     * occurrence rather than from an instant.
     */
    expect(await unread()).toHaveLength(1);
  });

  it('does not fire a one-time reminder a second time', async () => {
    const created = await remindOnce({ onDate: '2026-03-10', hour: 9, text: 'Ring the dentist' });
    at('2026-03-10T09:00:30.000Z');
    await harness.services.scheduleService.tick();

    /*
     * It stops because its single occurrence has been claimed, not because delivery marked it
     * finished. That distinction matters: an earlier version completed a one-time reminder on
     * delivery, which meant a snooze could never bring it back — "remind me in an hour" became
     * "never". Delivery is not completion; completion is Blake saying he has dealt with it.
     */
    expect((await harness.services.schedules.findById(created.id))?.completedAt).toBeNull();

    at('2026-03-11T09:00:30.000Z');
    expect((await harness.services.scheduleService.tick()).delivered).toBe(0);
  });

  it('stops a recurring reminder once Blake says it is dealt with', async () => {
    const created = await harness.services.schedules.create({
      kind: 'reminder',
      name: 'Stand up',
      cadence: 'daily',
      hour: 9,
      minute: 0,
      timeZone: 'UTC',
      catchUp: 'run_latest',
      maxRetries: 2,
      instruction: 'Stand up and walk about',
      createdBy: 'test-owner',
    });

    at('2026-03-10T09:00:30.000Z');
    expect((await harness.services.scheduleService.tick()).delivered).toBe(1);

    await harness.services.schedules.patch(created.id, {
      completedAt: new Date('2026-03-10T09:05:00.000Z'),
    });

    /* Dealt with means dealt with. A completed reminder owes nothing, for ever. */
    at('2026-03-11T09:00:30.000Z');
    expect((await harness.services.scheduleService.tick()).delivered).toBe(0);
  });

  it('brings a snoozed reminder back when the snooze runs out', async () => {
    const created = await remindOnce({ onDate: '2026-03-10', hour: 9, text: 'Ring the dentist' });
    at('2026-03-10T09:00:30.000Z');
    await harness.services.scheduleService.tick();
    expect(await unread()).toHaveLength(1);

    /* "Not now — in an hour." */
    await harness.services.notifications.acknowledge((await unread())[0]!.id, now);
    await harness.services.schedules.patch(created.id, {
      snoozedUntil: new Date('2026-03-10T10:00:00.000Z'),
    });

    at('2026-03-10T09:30:00.000Z');
    expect((await harness.services.scheduleService.tick()).delivered).toBe(0);

    /*
     * The part that the obvious implementation gets wrong. Marking it snoozed and letting the
     * normal arithmetic find it again does nothing: this occurrence has been claimed and a
     * one-time reminder has no next occurrence, so "in an hour" would mean "never".
     */
    at('2026-03-10T10:00:30.000Z');
    expect((await harness.services.scheduleService.tick()).delivered).toBe(1);
    expect(await unread()).toHaveLength(1);
  });

  it('does not let a daily reminder collapse into yesterday’s unread copy', async () => {
    await harness.services.schedules.create({
      kind: 'reminder',
      name: 'Stand up',
      cadence: 'daily',
      hour: 9,
      minute: 0,
      timeZone: 'UTC',
      catchUp: 'run_latest',
      maxRetries: 2,
      instruction: 'Stand up and walk about',
      createdBy: 'test-owner',
    });

    at('2026-03-10T09:00:30.000Z');
    await harness.services.scheduleService.tick();
    at('2026-03-11T09:00:30.000Z');
    await harness.services.scheduleService.tick();

    /*
     * Two mornings, two reminders. The dedupe index exists to stop a sync failing every ten
     * minutes producing four hundred rows; applied to a daily reminder it would show one row with
     * a count on it, and today's reminder would look like yesterday's.
     */
    expect(await unread()).toHaveLength(2);
  });

  it('keeps a briefing that lands in quiet hours, and marks it as held back', async () => {
    await harness.services.settings.set(QUIET_HOURS_KEY, {
      enabled: true,
      fromHour: 22,
      toHour: 7,
      timeZone: 'UTC',
    });

    await harness.services.schedules.create({
      kind: 'morning_briefing',
      name: 'Morning briefing',
      cadence: 'daily',
      hour: 6,
      minute: 0,
      timeZone: 'UTC',
      catchUp: 'run_latest',
      maxRetries: 2,
      createdBy: 'test-owner',
    });

    at('2026-03-10T06:00:30.000Z');
    const report = await harness.services.scheduleService.tick();
    expect(report.delivered).toBe(1);

    /*
     * Produced, stored, and on the dashboard — with the fact that it was held back recorded rather
     * than inferred at render time. Dropping it would lose it; speaking it would make the setting
     * a lie.
     */
    const stored = await harness.services.briefingRecords.latest('daily', null);
    expect(stored).not.toBeNull();
    expect(stored?.isQuiet).toBe(true);
    expect(await unread()).toHaveLength(1);
  });

  it('delivers only the most recent of the mornings it slept through', async () => {
    await harness.services.schedules.create({
      kind: 'morning_briefing',
      name: 'Morning briefing',
      cadence: 'daily',
      hour: 6,
      minute: 0,
      timeZone: 'UTC',
      catchUp: 'run_latest',
      maxRetries: 2,
      createdBy: 'test-owner',
    });

    /*
     * The watermark says Jarvis last accounted for Tuesday morning, and it is now Thursday
     * afternoon: the machine was off in between.
     *
     * `run_latest` is the default and the reason is worth stating. Delivering all three would give
     * Blake three briefings at once, two of them about days that are over; delivering none would
     * be silent about the fact that it slept. So the newest runs — Thursday's, which is still
     * within the twelve hours that make a briefing worth reading — and the older ones are recorded
     * as skipped so the record says what happened rather than pretending nothing was owed.
     *
     * The watermark has to be set explicitly here. Without one a schedule does not reach backwards
     * at all — a briefing created this afternoon must not immediately deliver this morning's — so
     * the "machine was off" case only exists once Jarvis has accounted for at least one occurrence.
     */
    const [schedule] = await harness.services.schedules.list(false);
    await harness.services.schedules.patch(schedule!.id, {
      lastOccurrenceAt: new Date('2026-03-10T06:00:00.000Z'),
    });

    at('2026-03-12T12:00:00.000Z');
    const report = await harness.services.scheduleService.tick();

    expect(report.delivered).toBe(1);
    expect(report.skipped + report.missed, 'the mornings it slept through are accounted for').toBe(
      1,
    );

    /* One briefing, about the window it actually looked at — not three stacked up. */
    const stored = await harness.services.briefingRecords.list(10);
    expect(stored).toHaveLength(1);
    expect(await unread()).toHaveLength(1);
  });

  it('runs nothing scheduled on a deployment that has not qualified', async () => {
    /*
     * Its own harness, deliberately unqualified. A reminder is small and harmless, and it is still
     * unattended work on a machine whose own suite has not been shown to pass — so it is recorded
     * as skipped with a reason rather than delivered, and nothing is invented to fill the gap.
     */
    const fresh = await createHarness({ clock: () => now });
    try {
      await fresh.services.schedules.create({
        kind: 'reminder',
        name: 'Ring the dentist',
        cadence: 'once',
        hour: 9,
        minute: 0,
        timeZone: 'UTC',
        onDate: '2026-03-10',
        catchUp: 'run_latest',
        maxRetries: 2,
        instruction: 'Ring the dentist',
        createdBy: 'test-owner',
      });

      at('2026-03-10T09:00:30.000Z');
      const report = await fresh.services.scheduleService.tick();
      expect(report.delivered).toBe(0);
      expect(report.skipped).toBe(1);
      /* And it says why, rather than going quiet. */
      expect(report.notes.join(' ').length).toBeGreaterThan(0);
      expect(await fresh.services.notifications.list({ unreadOnly: true })).toHaveLength(0);
    } finally {
      await fresh.close();
    }
  });

  it('leaves a paused schedule alone', async () => {
    const created = await remindOnce({ onDate: '2026-03-10', hour: 9, text: 'Ring the dentist' });
    await harness.services.schedules.patch(created.id, {
      pausedAt: new Date('2026-03-10T08:00:00.000Z'),
      pausedReason: 'Away this week.',
    });

    at('2026-03-10T09:00:30.000Z');
    expect((await harness.services.scheduleService.tick()).delivered).toBe(0);
    expect(await unread()).toHaveLength(0);
  });
});
