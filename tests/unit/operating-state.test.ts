import { describe, expect, it } from 'vitest';

import {
  allowedOperatingStates,
  canMoveOperatingState,
  operatingIsActive,
  operatingNeedsOwner,
  OPERATING_STATES,
  OPERATING_STATE_LABELS,
  type OperatingState,
} from '@/domain/operating-state';

/**
 * The outer machine: where an idea is, as distinct from where a mission is.
 *
 * These are the rules the dashboard reads and the narrator speaks from, so a wrong transition is
 * not a cosmetic problem — it is Jarvis saying it is building something it has not planned.
 */
describe('the operating state machine', () => {
  it('carries an idea from the sentence to the thing it produced', () => {
    const path: readonly OperatingState[] = [
      'captured',
      'evaluating',
      'waiting_for_input',
      'approved',
      'planning',
      'executing',
      'verifying',
      'delivered',
    ];
    for (let index = 0; index < path.length - 1; index += 1) {
      const from = path[index]!;
      const to = path[index + 1]!;
      expect(canMoveOperatingState(from, to), `${from} → ${to}`).toBe(true);
    }
  });

  it('lets anything live be interrupted, and nothing finished be resumed', () => {
    for (const state of OPERATING_STATES) {
      const finished = state === 'delivered' || state === 'cancelled';
      expect(allowedOperatingStates(state).length === 0, `${state} is terminal`).toBe(finished);
    }
    /* An idea can be blocked or cancelled from wherever it happens to be. */
    expect(canMoveOperatingState('executing', 'blocked')).toBe(true);
    expect(canMoveOperatingState('evaluating', 'cancelled')).toBe(true);
    expect(canMoveOperatingState('planning', 'needs_decision')).toBe(true);
    /* And nothing comes back from delivered or cancelled. */
    expect(canMoveOperatingState('delivered', 'executing')).toBe(false);
    expect(canMoveOperatingState('cancelled', 'planning')).toBe(false);
  });

  it('refuses to skip the work', () => {
    /* Building something nobody approved, or delivering something never built. */
    expect(canMoveOperatingState('captured', 'executing')).toBe(false);
    expect(canMoveOperatingState('approved', 'delivered')).toBe(false);
    expect(canMoveOperatingState('evaluating', 'verifying')).toBe(false);
  });

  it('treats a repeated report of the same phase as a no-op rather than an error', () => {
    /*
     * A worker that reports "still executing" twice is not a bug, and turning it into one would
     * make progress narration unsafe: every "I am still building" would have to check first.
     */
    for (const state of OPERATING_STATES) {
      expect(canMoveOperatingState(state, state), `${state} → ${state}`).toBe(true);
    }
  });

  it('resumes into the phase that was interrupted, not into the beginning', () => {
    expect(canMoveOperatingState('blocked', 'executing')).toBe(true);
    expect(canMoveOperatingState('paused', 'verifying')).toBe(true);
    expect(canMoveOperatingState('needs_decision', 'planning')).toBe(true);
    /* A failure is retried from a phase that can produce work, never straight to delivered. */
    expect(canMoveOperatingState('failed', 'delivered')).toBe(false);
  });

  it('separates waiting for a person from working, and says which is which', () => {
    expect(operatingNeedsOwner('waiting_for_input')).toBe(true);
    expect(operatingNeedsOwner('needs_decision')).toBe(true);
    expect(operatingNeedsOwner('blocked')).toBe(false);
    expect(operatingNeedsOwner('executing')).toBe(false);

    expect(operatingIsActive('executing')).toBe(true);
    expect(operatingIsActive('evaluating')).toBe(true);
    /* Blocked and paused are stopped, however active they may look. */
    expect(operatingIsActive('blocked')).toBe(false);
    expect(operatingIsActive('paused')).toBe(false);
    expect(operatingIsActive('waiting_for_input')).toBe(false);
  });

  it('gives every state words, because colour is never the only carrier', () => {
    for (const state of OPERATING_STATES) {
      expect(OPERATING_STATE_LABELS[state], `${state} has a label`).toBeTruthy();
    }
  });
});
