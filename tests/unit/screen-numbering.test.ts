import { describe, expect, it } from 'vitest';

import { interpretReply } from '@/domain/reply-intent';
import type { NextAction } from '@/domain/next-actions';
import { splitDecision } from '@/lib/screen-actions';

/**
 * The number on the screen and the number the command reads are the same number.
 *
 * ## The failure this exists to stop
 *
 * The Jarvis screen shows the first action that needs a person as an unnumbered "Needs a decision"
 * card and numbers everything else from 1. The reply path resolved that number against the
 * *unsplit* list, so the visible item N ran `actions[N-1]` while the screen had labelled
 * `rest[N-1]`. On a default install the decision is `actions[0]`, so every number on the screen
 * acted on the item above the one carrying it.
 *
 * Measured in a browser against the real app, before the fix:
 *
 *     screen shows: «1 Let me start work again»   (decision card above it: "Start a worker")
 *     typed "1" -> /workers      <- the decision card, which carries no number
 *     typed "2" -> /operations   <- the item labelled 1
 *     typed "4" -> accepted, with nothing on screen numbered 4
 *
 * and after:
 *
 *     typed "1" -> /operations   <- the item labelled 1
 *     typed "2" -> nothing happens
 *
 * The last line is the second half of the bug: `interpretReply` was told the *unsplit* length, one
 * more than the numbered list, so an out-of-range ordinal passed its own range guard.
 *
 * `splitDecision` is exported and pure so that the panel, the local reply path and the snapshot
 * sent to `/api/conversation` all ask one function what "2" means, rather than each deriving it.
 */

const action = (id: string, requiresOwner: boolean): NextAction => ({
  id,
  kind: 'answer_clarification',
  label: `Do ${id}`,
  detail: `Because of ${id}`,
  href: `/${id}`,
  subjectId: id,
  requiresOwner,
});

describe('what a number on the Jarvis screen refers to', () => {
  it('takes the first owner-decision out of the numbered list', () => {
    const actions = [action('a', true), action('b', false), action('c', false)];
    const { decision, numbered } = splitDecision(actions);

    expect(decision?.id, 'the decision card is the first thing needing a person').toBe('a');
    expect(
      numbered.map((entry) => entry.id),
      'and it is not also numbered',
    ).toEqual(['b', 'c']);
  });

  it('resolves each visible number to the item carrying it', () => {
    const actions = [action('decision', true), action('first', false), action('second', false)];
    const { numbered } = splitDecision(actions);

    /* Exactly the two calls the screen makes, with the list it actually numbered. */
    const one = interpretReply('1', numbered.length);
    const two = interpretReply('do the second one', numbered.length);

    expect(one).toMatchObject({ kind: 'select', index: 0 });
    expect(two).toMatchObject({ kind: 'select', index: 1 });
    expect(numbered[(one as { index: number }).index]?.id).toBe('first');
    expect(numbered[(two as { index: number }).index]?.id).toBe('second');
  });

  it('refuses a number the screen does not show', () => {
    const actions = [action('decision', true), action('only', false)];
    const { numbered } = splitDecision(actions);

    /*
     * One row is numbered, so "2" is out of range. Told the unsplit length instead, this passed the
     * range guard and acted on something the owner never read.
     */
    expect(numbered).toHaveLength(1);
    expect(interpretReply('2', numbered.length).kind).not.toBe('select');
  });

  it('numbers from 1 when nothing needs a decision', () => {
    const actions = [action('a', false), action('b', false)];
    const { decision, numbered } = splitDecision(actions);

    expect(decision).toBeNull();
    expect(numbered.map((entry) => entry.id)).toEqual(['a', 'b']);
    const one = interpretReply('1', numbered.length);
    expect(numbered[(one as { index: number }).index]?.id).toBe('a');
  });

  it('only ever lifts one decision out, however many need a person', () => {
    /* Two owner actions: the first is the card, the second is still numbered and still reachable. */
    const actions = [action('a', true), action('b', true), action('c', false)];
    const { decision, numbered } = splitDecision(actions);

    expect(decision?.id).toBe('a');
    expect(numbered.map((entry) => entry.id)).toEqual(['b', 'c']);
  });
});
