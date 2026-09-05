import { describe, expect, it } from 'vitest';

import {
  assertCallAllowed,
  assertScriptSpeakable,
  buildCallScript,
  inQuietHours,
  interpretCallResponse,
  MAX_CALLS_PER_DAY,
  MAX_CHOICES,
  maskNumber,
  type CallPermission,
} from '@/domain/call-bridge';
import { CallBridge, CallSimulator } from '@/server/calls/simulator';

/**
 * A system that can telephone people, tested for the things it must never do.
 *
 * Almost every test here is a refusal. That is the right ratio: placing a call is one line of
 * provider code, and everything that makes it safe to have at all is the set of circumstances in
 * which it does not happen.
 */

const OWNER = '+447700900812';

function permission(overrides: Partial<CallPermission> = {}): CallPermission {
  return {
    providerConfigured: true,
    ownerNumber: OWNER,
    to: OWNER,
    quietHours: { from: 22, to: 8 },
    hourLocal: 14,
    callsToday: 0,
    ownerRequested: false,
    ...overrides,
  };
}

const script = buildCallScript({
  purpose: 'decision',
  situation: 'The nightly build has failed three times. Should Jarvis look at it now?',
  choices: [
    { spoken: 'Yes, look at it now', action: 'start' },
    { spoken: 'No, leave it', action: 'defer' },
  ],
});

describe('when Jarvis will not call', () => {
  it('will not call at all without a provider', () => {
    expect(() => assertCallAllowed(permission({ providerConfigured: false }))).toThrow(
      /No calling provider is configured/,
    );
  });

  it('will not call a number that is not yours', () => {
    expect(() => assertCallAllowed(permission({ to: '+447700900999' }))).toThrow(
      /only ever calls your own verified number/,
    );
  });

  it('will not call when no number of yours is verified', () => {
    expect(() => assertCallAllowed(permission({ ownerNumber: null }))).toThrow(
      /Jarvis calls you and nobody else/,
    );
  });

  it('stops at the daily cap', () => {
    expect(() => assertCallAllowed(permission({ callsToday: MAX_CALLS_PER_DAY }))).toThrow(
      /which is its limit/,
    );
  });

  it('respects quiet hours, including across midnight', () => {
    expect(inQuietHours({ from: 22, to: 8 }, 23)).toBe(true);
    expect(inQuietHours({ from: 22, to: 8 }, 3)).toBe(true);
    expect(inQuietHours({ from: 22, to: 8 }, 9)).toBe(false);
    expect(() => assertCallAllowed(permission({ hourLocal: 3 }))).toThrow(/hours you asked not/);
  });

  it('lets you ring yourself at 3am if you asked for it just now', () => {
    expect(() =>
      assertCallAllowed(permission({ hourLocal: 3, ownerRequested: true })),
    ).not.toThrow();
    /* But an owner request still cannot exceed the cap or reach somebody else's phone. */
    expect(() =>
      assertCallAllowed(permission({ ownerRequested: true, to: '+447700900999' })),
    ).toThrow();
  });
});

describe('what gets said', () => {
  it('always identifies itself, word for word', () => {
    expect(script.identification).toContain('automated call from Jarvis');
    expect(script.identification).toContain('hang up at any time');
  });

  it('offers no more than three choices', () => {
    expect(() =>
      buildCallScript({
        purpose: 'decision',
        situation: 'Pick one.',
        choices: Array.from({ length: MAX_CHOICES + 1 }, (_, index) => ({
          spoken: `Option ${index}`,
          action: `a${index}`,
        })),
      }),
    ).toThrow(/stops being a menu/);
  });

  it('refuses to read out anything that looks like a credential', () => {
    const dangerous = buildCallScript({
      purpose: 'alert',
      situation: 'The deploy failed: bad token gh' + 'p_abcdefghijklmnop rejected.',
      choices: [{ spoken: 'Understood', action: 'ack' }],
    });
    expect(() => assertScriptSpeakable(dangerous)).toThrow(/looks like a credential/);
    expect(() => assertScriptSpeakable(script)).not.toThrow();
  });

  it('ends rather than looping when nobody answers', () => {
    expect(script.noAnswer).toContain('changed nothing');
    expect(script.noAnswer).toContain('Goodbye');
  });
});

describe('what the owner said', () => {
  it('takes a keypad digit exactly', () => {
    expect(interpretCallResponse({ digits: '1' }, script)).toMatchObject({
      kind: 'chose',
      by: 'keypad',
    });
    expect(interpretCallResponse({ digits: '9' }, script).kind).toBe('unclear');
  });

  it('takes speech only when it is unambiguous', () => {
    expect(interpretCallResponse({ speech: 'yes' }, script)).toMatchObject({
      kind: 'chose',
      by: 'speech',
    });
    /* Two matches on a phone line is a person being misheard, not a decision. */
    expect(interpretCallResponse({ speech: 'yes, no, sorry' }, script).kind).toBe('unclear');
    expect(interpretCallResponse({ speech: 'mmm hold on' }, script).kind).toBe('unclear');
  });

  it('reports silence as silence rather than as a choice', () => {
    expect(interpretCallResponse({}, script).kind).toBe('no_answer');
  });
});

describe('the bridge, end to end, without a telephone', () => {
  it('places nothing when no provider is configured', async () => {
    const bridge = new CallBridge({ provider: null });
    expect(bridge.configured).toBe(false);
    await expect(bridge.call({ permission: permission(), script })).rejects.toThrow(
      /No calling provider/,
    );
  });

  it('runs the whole path and never writes the number down', async () => {
    const simulator = new CallSimulator([{ digits: '1' }]);
    const bridge = new CallBridge({ provider: simulator });

    const { response } = await bridge.call({ permission: permission(), script });
    expect(response).toMatchObject({ kind: 'chose', by: 'keypad' });
    if (response.kind === 'chose') expect(response.choice.action).toBe('start');

    expect(simulator.placed).toHaveLength(1);
    expect(simulator.placed[0]?.to).toBe(maskNumber(OWNER));
    expect(simulator.placed[0]?.to).not.toContain('7700900');
    expect(maskNumber(OWNER)).toContain('812');
  });

  it('does not dial at all when the script is unspeakable', async () => {
    const simulator = new CallSimulator([{ digits: '1' }]);
    const bridge = new CallBridge({ provider: simulator });
    const dangerous = buildCallScript({
      purpose: 'alert',
      situation: 'Set the password to hunter2.',
      choices: [{ spoken: 'Understood', action: 'ack' }],
    });

    await expect(bridge.call({ permission: permission(), script: dangerous })).rejects.toThrow();
    expect(simulator.placed).toHaveLength(0);
  });

  it('treats a phone nobody picks up as the normal case', async () => {
    const simulator = new CallSimulator([]);
    const bridge = new CallBridge({ provider: simulator });
    const { response } = await bridge.call({ permission: permission(), script });
    expect(response.kind).toBe('no_answer');
  });
});
