import { describe, expect, it } from 'vitest';

import {
  decideRestart,
  LOG_KEEP,
  LOG_ROTATE_BYTES,
  MAX_RESTARTS_IN_WINDOW,
  RESTART_WINDOW_MS,
  rolledLogName,
  shouldRotate,
} from '@/domain/process-supervision';
import {
  ASSUMED_TICK_INTERVAL_MS,
  supervisorHealth,
  type SupervisorTick,
} from '@/domain/supervisor-health';
import { absenceSentence, summariseConnectors } from '@/domain/data-connections';

/**
 * The three rules that decide whether an owner wakes up to a Jarvis that is running.
 *
 * All pure, all tested here rather than by starting processes, because the interesting behaviour
 * is entirely in the boundaries — restart once versus restart for ever, late versus stopped, a
 * connection that is absent versus one that is broken — and none of those need a real process to
 * get wrong.
 */

const NOW = Date.parse('2026-04-01T12:00:00.000Z');

describe('restarting a process that died', () => {
  it('restarts the first time, with a short wait', () => {
    const decision = decideRestart({
      restarts: [],
      now: NOW,
      cleanExit: false,
      shuttingDown: false,
      name: 'worker',
    });
    expect(decision.restart).toBe(true);
    expect(decision.delayMs).toBe(2_000);
  });

  it('waits longer each time', () => {
    const delays = [0, 1, 2, 3].map(
      (count) =>
        decideRestart({
          restarts: Array.from({ length: count }, (_, index) => NOW - index * 1_000),
          now: NOW,
          cleanExit: false,
          shuttingDown: false,
          name: 'worker',
        }).delayMs,
    );
    expect(delays).toEqual([...delays].sort((left, right) => left - right));
    expect(new Set(delays).size).toBe(delays.length);
  });

  it('gives up rather than looping on something restarting will not fix', () => {
    const decision = decideRestart({
      restarts: Array.from({ length: MAX_RESTARTS_IN_WINDOW }, (_, index) => NOW - index * 1_000),
      now: NOW,
      cleanExit: false,
      shuttingDown: false,
      name: 'control plane',
    });
    expect(decision.restart).toBe(false);
    expect(decision.reason).toContain('restarting will not fix');
  });

  it('forgives restarts that fall outside the window', () => {
    const old = Array.from(
      { length: MAX_RESTARTS_IN_WINDOW },
      (_, index) => NOW - RESTART_WINDOW_MS - index * 1_000,
    );
    expect(
      decideRestart({
        restarts: old,
        now: NOW,
        cleanExit: false,
        shuttingDown: false,
        name: 'worker',
      }).restart,
    ).toBe(true);
  });

  it('never restarts anything while shutting down', () => {
    expect(
      decideRestart({
        restarts: [],
        now: NOW,
        cleanExit: true,
        shuttingDown: true,
        name: 'worker',
      }).restart,
    ).toBe(false);
  });

  it('treats a clean exit as a surprise, because a service should not end', () => {
    const decision = decideRestart({
      restarts: [],
      now: NOW,
      cleanExit: true,
      shuttingDown: false,
      name: 'worker',
    });
    expect(decision.restart).toBe(true);
    expect(decision.reason).toContain('should not do while Jarvis is running');
  });
});

describe('rolling the log', () => {
  it('rolls only once the file is actually large', () => {
    expect(shouldRotate(LOG_ROTATE_BYTES - 1)).toBe(false);
    expect(shouldRotate(LOG_ROTATE_BYTES)).toBe(true);
  });

  it('numbers the generations so the set of files stays bounded', () => {
    expect(rolledLogName('jarvis.log', 0)).toBe('jarvis.log');
    expect(rolledLogName('jarvis.log', 1)).toBe('jarvis.1.log');
    expect(rolledLogName('jarvis.log', LOG_KEEP)).toBe(`jarvis.${LOG_KEEP}.log`);
  });
});

describe('is the operating loop running', () => {
  const tick = (minutesAgo: number, overrides: Partial<SupervisorTick> = {}): SupervisorTick => ({
    startedAt: new Date(NOW - minutesAgo * 60_000).toISOString(),
    finishedAt: new Date(NOW - minutesAgo * 60_000).toISOString(),
    outcome: 'observed',
    summary: 'Nothing to do.',
    ...overrides,
  });

  const now = new Date(NOW);

  it('says so plainly when nothing has ever run', () => {
    const health = supervisorHealth([], now);
    expect(health.state).toBe('never_run');
    expect(health.lastTickAt).toBeNull();
    expect(health.nextExpectedAt).toBeNull();
  });

  it('measures the cadence from the passes themselves', () => {
    const health = supervisorHealth([tick(0), tick(5), tick(10), tick(15)], now);
    expect(health.state).toBe('healthy');
    expect(health.typicalGapMs).toBe(5 * 60_000);
    expect(health.nextExpectedAt).toBe(new Date(NOW + 5 * 60_000).toISOString());
  });

  it('is not fooled by one very long pass', () => {
    /* A mean would be dragged past the real cadence by the outlier; the median ignores it. */
    const health = supervisorHealth([tick(0), tick(1), tick(2), tick(3), tick(180)], now);
    expect(health.typicalGapMs).toBe(60_000);
  });

  it('calls it late before it calls it stopped', () => {
    const late = supervisorHealth([tick(4), tick(5), tick(6), tick(7)], now);
    expect(late.state).toBe('late');

    const stalled = supervisorHealth([tick(60), tick(61), tick(62), tick(63)], now);
    expect(stalled.state).toBe('stalled');
    expect(stalled.explanation).toContain('check that a worker is running');
  });

  it('reports a failing pass, and keeps the last error even after a good one', () => {
    const failing = supervisorHealth(
      [tick(0, { outcome: 'failed', summary: 'The database refused.' }), tick(1), tick(2)],
      now,
    );
    expect(failing.state).toBe('failing');
    expect(failing.lastError?.summary).toBe('The database refused.');

    const recovered = supervisorHealth(
      [tick(0), tick(1), tick(2, { outcome: 'failed', summary: 'The database refused.' })],
      now,
    );
    expect(recovered.state).toBe('healthy');
    expect(recovered.lastError?.summary).toBe('The database refused.');
  });

  it('will not invent a cadence from two passes', () => {
    const health = supervisorHealth([tick(0), tick(1)], now);
    expect(health.typicalGapMs).toBeNull();
    expect(health.nextExpectedAt).toBeNull();
    expect(health.explanation).toContain('Too few passes');
    /* It still answers "is this alarmingly old?", from the worker's documented default. */
    const old = supervisorHealth(
      [tick(ASSUMED_TICK_INTERVAL_MS / 60_000 + 30), tick(ASSUMED_TICK_INTERVAL_MS / 60_000 + 31)],
      now,
    );
    expect(old.state).toBe('stalled');
  });
});

describe('what Jarvis can see', () => {
  const nothingPersonal = { kind: 'unavailable' } as const;

  it('reports an absent connection as absent, never as zero', () => {
    const statuses = summariseConnectors({
      repositories: { configured: 0, synced: 0 },
      telephonyConfigured: false,
      personal: nothingPersonal,
    });
    const calendar = statuses.find((status) => status.kind === 'calendar');
    expect(calendar?.state).toBe('not_connected');
    expect(calendar?.detail).toContain('rather than guess');
    expect(statuses.every((status) => status.state !== 'connected')).toBe(true);
  });

  it('gives a briefing one sentence to use instead of a made-up number', () => {
    const sentence = absenceSentence(
      summariseConnectors({
        repositories: { configured: 2, synced: 2 },
        telephonyConfigured: false,
        personal: nothingPersonal,
      }),
    );
    expect(sentence).toContain('Not connected');
    expect(sentence).toContain('calendar');
    expect(sentence).toContain('revenue and finance');
    expect(sentence).toContain('Nothing here is estimated.');
  });

  it('has nothing to disclaim once everything is connected', () => {
    expect(absenceSentence([])).toBeNull();
  });

  /**
   * The half of the contract that only became testable once a reader existed.
   *
   * "Planned" was true while Jarvis had no mail integration and became a falsehood the moment it
   * had one. These cases pin the three states apart: nothing authorized, authorized but not read
   * here, and read — with a declined permission distinguishable from an outage, because they need
   * different things from Blake.
   */
  it('says a connected account is connected rather than planned', () => {
    const statuses = summariseConnectors({
      repositories: { configured: 1, synced: 1 },
      telephonyConfigured: false,
      personal: { kind: 'connected' },
    });
    const email = statuses.find((status) => status.kind === 'email');
    expect(email?.state).toBe('configured');
    expect(email?.detail).toContain('Outlook is connected');
    expect(absenceSentence(statuses)).not.toContain('email');
  });

  it('reports what a read actually returned, per source', () => {
    const statuses = summariseConnectors({
      repositories: { configured: 1, synced: 1 },
      telephonyConfigured: false,
      personal: {
        kind: 'read',
        outcomes: {
          mail: { state: 'ok', count: 3 },
          calendar: { state: 'ok', count: 0 },
          tasks: { state: 'not_permitted', scope: 'Tasks.Read' },
        },
      },
    });

    expect(statuses.find((status) => status.kind === 'email')?.state).toBe('connected');
    expect(statuses.find((status) => status.kind === 'calendar')?.detail).toContain(
      'Nothing in your day',
    );

    const tasks = statuses.find((status) => status.kind === 'tasks');
    expect(tasks?.state).toBe('not_connected');
    expect(tasks?.detail).toContain('Tasks.Read');
  });

  it('does not tell Blake to reconnect an account that is already connected', () => {
    const statuses = summariseConnectors({
      repositories: { configured: 1, synced: 1 },
      telephonyConfigured: false,
      personal: {
        kind: 'read',
        outcomes: {
          mail: { state: 'failed', reason: 'Microsoft is temporarily unavailable.' },
          calendar: { state: 'ok', count: 1 },
          tasks: { state: 'ok', count: 0 },
        },
      },
    });
    const email = statuses.find((status) => status.kind === 'email');
    /* `configured`, not `not_connected`: the authorization is fine, the network was not. */
    expect(email?.state).toBe('configured');
    expect(email?.detail).toContain('the last read failed');
  });
});
