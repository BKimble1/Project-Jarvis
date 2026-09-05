import { describe, expect, it } from 'vitest';

import {
  CORE_MOTION,
  CORE_STATES,
  CORE_STATE_LABELS,
  CORE_STATE_TONE,
  coreState,
  coreStatusLine,
  type CoreInput,
} from '@/domain/core-state';

/**
 * What the animated core is allowed to say.
 *
 * These are honesty tests, not rendering tests. The core is the most persuasive element on the
 * screen, so the mapping from real system state to visual state is a deterministic function with
 * its own coverage — a canvas renderer is not somewhere anyone would ever look for this rule, and
 * "the animation implied three agents were running" is not a defect a screenshot would catch.
 */

const CALM: CoreInput = {
  listening: false,
  thinking: false,
  speaking: false,
  workingCount: 0,
  needsOwner: false,
  limited: false,
  disconnected: false,
  justCompleted: false,
};

describe('the state the core shows', () => {
  it('is ready when nothing at all is happening', () => {
    expect(coreState(CALM)).toBe('ready');
  });

  it('says disconnected over everything else, however busy the rest looks', () => {
    /*
     * The single most misleading thing this screen could do is animate confidently on a
     * deployment that cannot run anything. Every other signal loses to this one.
     */
    expect(
      coreState({
        ...CALM,
        disconnected: true,
        listening: true,
        thinking: true,
        speaking: true,
        workingCount: 4,
        needsOwner: true,
        limited: true,
      }),
    ).toBe('disconnected');
  });

  it('lets the conversation win over background work, without losing the work', () => {
    /*
     * The two axes stay independent: `coreState` picks what the centre shows and the caller still
     * passes `workingCount` to the renderer as its own accent ring. Speaking must not erase three
     * running agents, and three running agents must not hide that Jarvis is listening.
     */
    expect(coreState({ ...CALM, speaking: true, workingCount: 3 })).toBe('speaking');
    expect(coreState({ ...CALM, listening: true, workingCount: 3 })).toBe('listening');
    expect(coreState({ ...CALM, workingCount: 3 })).toBe('working');
  });

  it('puts what needs a person ahead of routine work', () => {
    expect(coreState({ ...CALM, needsOwner: true, workingCount: 2 })).toBe('attention');
  });

  it('never reports work from a count of zero', () => {
    expect(coreState({ ...CALM, workingCount: 0 })).toBe('ready');
  });

  it('shows the completion accent only when something really finished', () => {
    expect(coreState({ ...CALM, justCompleted: true })).toBe('complete');
    expect(coreState(CALM)).not.toBe('complete');
  });
});

describe('the line beside the core', () => {
  const quiet = { workingCount: 0, waitingCount: 0, limitReason: null, disconnectedReason: null };

  it('prefers the specific truth to the generic label', () => {
    expect(coreStatusLine('working', { ...quiet, workingCount: 2 })).toBe('Working on 2 missions.');
    expect(coreStatusLine('working', { ...quiet, workingCount: 1 })).toBe('Working on 1 mission.');
    expect(coreStatusLine('attention', { ...quiet, waitingCount: 3 })).toBe(
      '3 things waiting for you.',
    );
  });

  it('carries the real reason when there is one, and the label when there is not', () => {
    expect(
      coreStatusLine('limited', { ...quiet, limitReason: 'Waiting for Claude capacity.' }),
    ).toBe('Waiting for Claude capacity.');
    expect(coreStatusLine('limited', quiet)).toBe(CORE_STATE_LABELS.limited);
    expect(
      coreStatusLine('disconnected', { ...quiet, disconnectedReason: 'No worker is enrolled.' }),
    ).toBe('No worker is enrolled.');
  });

  it('has something true to say in every state', () => {
    for (const state of CORE_STATES) {
      expect(coreStatusLine(state, quiet).length, `the line for ${state}`).toBeGreaterThan(0);
    }
  });
});

describe('how the core is allowed to move', () => {
  it('reacts to a level only where a real one exists', () => {
    /*
     * Listening has a microphone analyser behind it and speech playback has playback events, so
     * both may respond to an input. Everything else has no measurement at all, and a non-zero
     * reactivity there would let a stale number animate a core that is doing nothing.
     */
    for (const state of CORE_STATES) {
      const reactive = CORE_MOTION[state].reactivity > 0;
      expect(reactive, `${state} must not react to a level it cannot measure`).toBe(
        state === 'listening' || state === 'speaking',
      );
    }
  });

  it('keeps every state visible rather than fading a quiet one to nothing', () => {
    for (const state of CORE_STATES) {
      expect(CORE_MOTION[state].glow, `${state} must stay legible`).toBeGreaterThanOrEqual(0.4);
    }
  });

  it('keeps the particle field a sphere rather than letting it boil', () => {
    for (const state of CORE_STATES) {
      expect(CORE_MOTION[state].agitation, `${state} agitation`).toBeLessThanOrEqual(0.25);
    }
  });

  it('reserves amber and red for attention and failure', () => {
    expect(CORE_STATE_TONE.attention).toBe('amber');
    expect(CORE_STATE_TONE.limited).toBe('amber');
    expect(CORE_STATE_TONE.disconnected).toBe('red');
    for (const state of ['ready', 'thinking', 'working'] as const) {
      expect(CORE_STATE_TONE[state], `${state} is an ordinary state`).toBe('blue');
    }
  });
});
