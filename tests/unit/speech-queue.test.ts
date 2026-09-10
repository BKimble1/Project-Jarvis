import { describe, expect, it } from 'vitest';

import { MAX_QUEUED_UTTERANCES, createSpeechQueue } from '@/components/voice/use-speech';

/**
 * Everything Jarvis is given to say gets said, once, in order.
 *
 * ## Why this is worth a test at all
 *
 * Because the thing that was wrong here was invisible. `speak()` opened with
 * `speechSynthesis.cancel()`, and the dashboard claims a batch of announcements and reads it in a
 * loop — so each sentence cancelled the one before it and only the last was audible. The server had
 * already stamped every one of them spoken, and that stamp is a watermark: the sentences nobody
 * heard were not waiting to be retried, they were gone. No error, no console line, nothing on
 * screen. The only way to notice was to already know.
 *
 * ## Why there is no browser here
 *
 * The queue is deliberately separate from both React and `window`: it is handed a `play` that
 * starts one utterance and calls back when it ends. That is the whole ordering problem, and it is
 * ordinary logic. A test that drove a real `speechSynthesis` would prove less and would only run
 * where a speaker exists.
 */

/**
 * A speaker that never finishes on its own, so the test decides when each sentence ends.
 *
 * This is the shape the hook supplies: `play` starts one item, and `finished` is wired to both
 * `onend` and `onerror`.
 */
function speaker() {
  const spoken: string[] = [];
  const announced: boolean[] = [];
  let current: (() => void) | null = null;
  let stops = 0;

  const queue = createSpeechQueue({
    play: (item, finished) => {
      spoken.push(item.text);
      current = finished;
    },
    stop: () => {
      stops += 1;
    },
    speakingChanged: (speaking) => announced.push(speaking),
  });

  return {
    queue,
    /** Every sentence handed to the browser, in the order it was handed over. */
    spoken,
    /** Every change of the speaking flag, which is what lights the core's ring. */
    announced,
    stops: () => stops,
    /** The browser's `onend` for whatever is playing. */
    end() {
      const finished = current;
      current = null;
      finished?.();
    },
    /**
     * A failure, as Chrome reports one: `error`, and then `end` for the same utterance.
     *
     * Both are the hook's `finished`, so this is also the case that would eat the sentence after
     * the failed one if the queue advanced on every call it received.
     */
    fail() {
      const finished = current;
      current = null;
      finished?.();
      finished?.();
    },
  };
}

describe('the speech queue', () => {
  it('says all three, each one only after the last has finished', () => {
    const voice = speaker();

    voice.queue.enqueue({ text: 'one' });
    voice.queue.enqueue({ text: 'two' });
    voice.queue.enqueue({ text: 'three' });

    /* The whole defect in one assertion: enqueueing does not start, and does not cancel, a second. */
    expect(voice.spoken).toEqual(['one']);

    voice.end();
    expect(voice.spoken).toEqual(['one', 'two']);

    voice.end();
    expect(voice.spoken).toEqual(['one', 'two', 'three']);

    voice.end();
    expect(voice.spoken).toEqual(['one', 'two', 'three']);
    /* Nothing was cancelled along the way. Cancelling is what lost the batch in the first place. */
    expect(voice.stops()).toBe(0);
  });

  it('carries on to the next sentence when one of them fails', () => {
    const voice = speaker();

    voice.queue.enqueue({ text: 'one' });
    voice.queue.enqueue({ text: 'two' });
    voice.queue.enqueue({ text: 'three' });

    voice.fail();
    /*
     * Two things at once: the failure advanced, and the `end` that followed it did not advance
     * again. A queue without the guard would be saying 'three' here and 'two' would be lost — the
     * same silent loss, arrived at from the other direction.
     */
    expect(voice.spoken).toEqual(['one', 'two']);

    voice.end();
    expect(voice.spoken).toEqual(['one', 'two', 'three']);
  });

  it('drops everything still waiting when it is silenced', () => {
    const voice = speaker();

    voice.queue.enqueue({ text: 'one' });
    voice.queue.enqueue({ text: 'two' });
    voice.queue.enqueue({ text: 'three' });

    voice.queue.drop();
    expect(voice.stops()).toBe(1);
    expect(voice.spoken).toEqual(['one']);

    /*
     * `speechSynthesis.cancel()` makes Chrome fire the cancelled utterance's `onend`, which is
     * precisely the call that would restart a queue that only tracked "am I playing". "Stop
     * speaking" has to mean the rest as well, or the control is a lie.
     */
    voice.end();
    expect(voice.spoken).toEqual(['one']);

    /* Silenced, not broken: the next thing Jarvis has to say is still said. */
    voice.queue.enqueue({ text: 'later' });
    expect(voice.spoken).toEqual(['one', 'later']);
  });

  it('says nothing twice, however often the browser calls back', () => {
    const voice = speaker();

    voice.queue.enqueue({ text: 'one' });
    voice.queue.enqueue({ text: 'two' });

    voice.end();
    voice.end();
    /* A late callback from an utterance that has already been settled, arriving out of nowhere. */
    voice.end();
    voice.end();

    expect(voice.spoken).toEqual(['one', 'two']);
    expect(new Set(voice.spoken).size).toBe(voice.spoken.length);
  });

  it('reports speaking once for a batch, and idle only when the batch is done', () => {
    const voice = speaker();

    voice.queue.enqueue({ text: 'one' });
    voice.queue.enqueue({ text: 'two' });

    voice.end();
    /* Still speaking, mid-batch. A flicker to idle here is a core that reads as "it stopped". */
    expect(voice.announced).toEqual([true]);

    voice.end();
    expect(voice.announced).toEqual([true, false]);
  });

  it('keeps the newest sentences when more arrive than can be said', () => {
    const voice = speaker();

    voice.queue.enqueue({ text: 'playing' });
    const overflowing = MAX_QUEUED_UTTERANCES + 3;
    for (let index = 0; index < overflowing; index += 1) {
      voice.queue.enqueue({ text: `waiting ${index}` });
    }
    for (let index = 0; index < overflowing + 1; index += 1) voice.end();

    expect(voice.spoken).toHaveLength(MAX_QUEUED_UTTERANCES + 1);
    /*
     * What survives is the recent end of the backlog. A narrator reciting a quarter of an hour of
     * stale history is not information, and the sentence the owner is standing there waiting for is
     * the last one, not the first.
     */
    expect(voice.spoken[0]).toBe('playing');
    expect(voice.spoken.at(-1)).toBe(`waiting ${overflowing - 1}`);
    expect(voice.spoken).not.toContain('waiting 0');
  });
});
