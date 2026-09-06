import { describe, expect, it } from 'vitest';

import { PREFERRED_VOICES, chooseVoice } from '@/domain/speaking-voice';

/**
 * Which voice Jarvis speaks in, and whether it tells the truth about it.
 *
 * The owner asked for a British voice — George. What makes this worth testing rather than
 * hard-coding is that the answer depends on the device: `speechSynthesis.getVoices()` returns
 * different lists in Edge and Chrome on the *same* Windows machine, and a laptop with no en-GB
 * voice pack has none of them. The failure to avoid is not "picks the wrong voice"; it is
 * "promises George and an American default speaks".
 */

const voice = (name: string, lang = 'en-GB') => ({ name, lang });

/* Roughly what Chrome on Windows reports. */
const CHROME_WINDOWS = [
  voice('Microsoft David - English (United States)', 'en-US'),
  voice('Microsoft Zira - English (United States)', 'en-US'),
  voice('Microsoft Hazel - English (United Kingdom)'),
  voice('Microsoft George - English (United Kingdom)'),
  voice('Google UK English Male'),
  voice('Google US English', 'en-US'),
];

describe('choosing a voice', () => {
  it('finds George on a Windows machine that has him', () => {
    const chosen = chooseVoice(CHROME_WINDOWS);
    expect(chosen.voice?.name).toContain('George');
    expect(chosen.basis).toBe('preferred');
    expect(chosen.explanation).toContain('George');
  });

  it('prefers George over the other British voices, not merely a British one', () => {
    /*
     * Hazel is British and comes first in the list. Order in the device list must not decide this
     * — the wish-list does.
     */
    const chosen = chooseVoice(CHROME_WINDOWS);
    expect(chosen.voice?.name).not.toContain('Hazel');
  });

  it('falls to the next British male voice when George is not installed', () => {
    const withoutGeorge = CHROME_WINDOWS.filter((entry) => !entry.name.includes('George'));
    const chosen = chooseVoice(withoutGeorge);
    expect(chosen.voice?.name).toBe('Google UK English Male');
    expect(chosen.basis).toBe('preferred');
  });

  it('takes any British voice over an American one', () => {
    const chosen = chooseVoice([
      voice('Microsoft David - English (United States)', 'en-US'),
      voice('Microsoft Hazel - English (United Kingdom)'),
    ]);
    expect(chosen.voice?.name).toContain('Hazel');
    expect(chosen.basis).toBe('british');
    /* And it says why, rather than letting the owner think this is what he asked for. */
    expect(chosen.explanation).toContain('George is not installed');
  });

  it('admits when the device has no British voice at all', () => {
    /*
     * The honest case, and the one that matters most. Returning null hands the choice back to the
     * browser — and the explanation says so, and says what to install, instead of describing an
     * American default as British.
     */
    const chosen = chooseVoice([
      voice('Microsoft David - English (United States)', 'en-US'),
      voice('Google US English', 'en-US'),
    ]);
    expect(chosen.voice).toBeNull();
    expect(chosen.basis).toBe('default');
    expect(chosen.explanation).toContain('No British voice');
    expect(chosen.explanation).toContain('English (United Kingdom)');
  });

  it('copes with a device that reports nothing yet', () => {
    /* Chrome's first `getVoices()` is empty and fills in later. It must not throw meanwhile. */
    const chosen = chooseVoice([]);
    expect(chosen.voice).toBeNull();
    expect(chosen.basis).toBe('default');
  });

  it('matches the plain name some platforms report', () => {
    /* The Web Speech API on Windows has reported this voice as bare "George". */
    expect(chooseVoice([voice('George')]).voice?.name).toBe('George');
  });

  it('never returns an explanation that does not match what will be heard', () => {
    for (const available of [CHROME_WINDOWS, [voice('Hazel')], [voice('David', 'en-US')], []]) {
      const chosen = chooseVoice(available);
      if (chosen.voice) expect(chosen.explanation).toContain(chosen.voice.name);
      else expect(chosen.explanation).toContain('browser default');
    }
  });

  it('asks for George first', () => {
    expect(PREFERRED_VOICES[0]).toBe('George');
  });
});
