/**
 * Which voice Jarvis speaks in.
 *
 * ## Why there is a preference at all
 *
 * The browser's default is whatever the operating system considers first, which on a Windows
 * machine is usually a American female voice. Jarvis is not that. The owner asked for a British
 * voice — George, specifically — and the honest way to give him one is to name the voices that
 * actually exist on the platforms he uses and pick the best available, rather than to bundle a
 * third-party speech service and start sending his conversation to somebody else's server.
 *
 * ## What is actually available
 *
 * `speechSynthesis.getVoices()` returns whatever the device has installed, and the list differs
 * between browsers on the *same* machine. On Windows:
 *
 *  - **Edge** exposes the Microsoft online neural voices, which is where `Ryan` and the other
 *    en-GB names live, alongside the local `George` and `Hazel`.
 *  - **Chrome** exposes the local Windows voices plus its own `Google UK English Male`.
 *  - A machine with no en-GB voice pack installed has none of them, and no amount of preference
 *    changes that.
 *
 * So this is an ordered wish-list, matched loosely against whatever came back, and the caller is
 * told which one it actually got — including when the answer is "none of these, here is the
 * default". Saying "British George" while an American default speaks would be a small lie told
 * every single time Jarvis opens its mouth.
 */

/**
 * The wish-list, best first.
 *
 * Matched case-insensitively as substrings, because vendors decorate the names: Chrome reports
 * `Google UK English Male`, Edge reports `Microsoft George - English (United Kingdom)`, and the
 * Web Speech API on Windows has historically reported the same voice as plain `George`.
 */
export const PREFERRED_VOICES: readonly string[] = [
  /* What was asked for, under each of the names it appears as. */
  'George',
  'Microsoft George',
  /* The other en-GB male voices, in the order they sound closest to it. */
  'Ryan',
  'Thomas',
  'Google UK English Male',
  'Daniel',
  'Arthur',
  'Oliver',
];

export interface VoiceLike {
  readonly name: string;
  readonly lang: string;
}

export interface VoiceChoice {
  /** The voice to use, or null to let the browser choose. */
  readonly voice: VoiceLike | null;
  /**
   * How it was arrived at, so the interface can say so without guessing.
   *
   * `preferred` — one of the names above. `british` — no named match, but a British voice.
   * `default` — nothing British is installed, and the browser's own choice will speak.
   */
  readonly basis: 'preferred' | 'british' | 'default';
  /** One sentence, for the settings panel. Always true of what will actually be heard. */
  readonly explanation: string;
}

const isBritish = (voice: VoiceLike): boolean => /^en[-_]GB/i.test(voice.lang);

/**
 * Pick the voice, and say honestly which one it is.
 *
 * Three passes, narrowing: the exact wish-list among British voices, then the wish-list anywhere
 * (a voice named George that the platform tagged `en-US` is still the voice he asked for), then
 * any British voice at all. Only after all three fail does it hand back to the browser — and it
 * says so, rather than letting an American default speak under a British label.
 */
export function chooseVoice(
  available: readonly VoiceLike[],
  preferred: readonly string[] = PREFERRED_VOICES,
): VoiceChoice {
  const matches = (voice: VoiceLike, wanted: string): boolean =>
    voice.name.toLowerCase().includes(wanted.toLowerCase());

  for (const wanted of preferred) {
    const british = available.find((voice) => isBritish(voice) && matches(voice, wanted));
    if (british) {
      return {
        voice: british,
        basis: 'preferred',
        explanation: `Speaking as ${british.name}.`,
      };
    }
  }

  for (const wanted of preferred) {
    const anywhere = available.find((voice) => matches(voice, wanted));
    if (anywhere) {
      return {
        voice: anywhere,
        basis: 'preferred',
        explanation: `Speaking as ${anywhere.name} (${anywhere.lang}).`,
      };
    }
  }

  const british = available.find(isBritish);
  if (british) {
    return {
      voice: british,
      basis: 'british',
      explanation: `George is not installed on this device, so Jarvis is speaking as ${british.name}.`,
    };
  }

  return {
    voice: null,
    basis: 'default',
    explanation:
      'No British voice is installed on this device, so Jarvis will use the browser default. ' +
      'On Windows, adding an English (United Kingdom) voice under Settings → Time & language → ' +
      'Speech gives it one.',
  };
}
