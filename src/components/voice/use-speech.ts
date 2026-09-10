'use client';

import * as React from 'react';

import { chooseVoice, type VoiceChoice } from '@/domain/speaking-voice';

/**
 * The browser's own speech recognition and synthesis, and nothing else.
 *
 * ## Why browser-native
 *
 * It works today, on the devices this is for, without a key, without an upload and without a bill.
 * Recognition happens on the device or through the browser vendor's own service; either way no
 * audio reaches Jarvis, which removes an entire class of things to get wrong — a retention policy,
 * an upload endpoint, a recording somebody forgot to delete.
 *
 * ## Why there is no wake word
 *
 * Because a browser cannot do one. Implementing "Hey Jarvis" in a web page means holding the
 * microphone open indefinitely and matching text — which is a permanently live microphone
 * described as something else. A button that claimed to be listening for a name would be a lie
 * about a microphone, and that is not a thing to be casual about. Push-to-talk is the default and
 * hands-free is an explicit choice that still starts with a press.
 *
 * ## Why the microphone is never touched before a gesture
 *
 * `start()` is only ever called from a click or a key press. Nothing here runs on mount, and
 * `supported` is computed from the presence of the API rather than by constructing anything — so a
 * page that merely renders the button has not asked for permission and has not turned anything on.
 */

export type SpeechPhase = 'idle' | 'listening' | 'thinking' | 'speaking' | 'unsupported';

interface RecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: { error?: string }) => void) | null;
  onend: (() => void) | null;
}

interface SpeechRecognitionEventLike {
  resultIndex: number;
  results: ArrayLike<ArrayLike<{ transcript: string; confidence: number }> & { isFinal: boolean }>;
}

type RecognitionConstructor = new () => RecognitionLike;

function recognitionConstructor(): RecognitionConstructor | null {
  if (typeof window === 'undefined') return null;
  const candidate = window as unknown as {
    SpeechRecognition?: RecognitionConstructor;
    webkitSpeechRecognition?: RecognitionConstructor;
  };
  return candidate.SpeechRecognition ?? candidate.webkitSpeechRecognition ?? null;
}

export interface SpeechState {
  readonly supported: boolean;
  readonly canSpeak: boolean;
  readonly phase: SpeechPhase;
  /** What has been recognised so far, including the unstable tail. */
  readonly transcript: string;
  readonly interim: string;
  readonly error: string | null;
  readonly voices: readonly { readonly name: string; readonly lang: string }[];
  /** The voice that will actually speak, and how that was decided. */
  readonly voiceChoice: VoiceChoice;
}

export interface SpeechControls extends SpeechState {
  start(): void;
  /** Stop listening and keep what was heard. */
  stop(): void;
  /** Stop listening and throw it away. */
  cancel(): void;
  reset(): void;
  speak(text: string, options?: { voice?: string; rate?: number }): void;
  silence(): void;
  setPhase(phase: SpeechPhase): void;
}

/* ------------------------------------------------------------------ saying things in order */

/** One thing to say, in the caller's words and with the delivery it asked for. */
export interface SpeechItem {
  readonly text: string;
  readonly voice?: string;
  readonly rate?: number;
}

export interface SpeechQueueDeps {
  /**
   * Say one item, and call `finished` when it has finished or failed.
   *
   * Both outcomes advance the queue, because a sentence the voice cannot manage must not take the
   * rest of the batch down with it. `finished` may arrive more than once for the same item —
   * browsers disagree about whether a failure fires `error` alone or `error` and then `end` — and
   * every call after the first is ignored.
   */
  readonly play: (item: SpeechItem, finished: () => void) => void;
  /** Stop whatever is being said this instant. Only ever called by `drop`. */
  readonly stop: () => void;
  /** Reported when playback starts and when the queue runs dry, and at no other time. */
  readonly speakingChanged: (speaking: boolean) => void;
}

export interface SpeechQueue {
  /** Say this after everything already waiting, and start playing if nothing is. */
  readonly enqueue: (item: SpeechItem) => void;
  /** Stop now and abandon the rest — what the "Stop speaking" control promises. */
  readonly drop: () => void;
}

/**
 * How many sentences may wait behind the one being spoken.
 *
 * The dashboard claims up to three operating events and up to three reminders in a single poll and
 * polls every six seconds, so a machine that has been busy hands this queue six sentences at a
 * time — faster than they can be said, because a sentence takes a few seconds. Unbounded, a long
 * unattended run builds a monologue that outlives its own subject: the owner walks up, presses
 * nothing, and is read several minutes of history whose oldest line describes a mission that has
 * since finished.
 *
 * Twelve is two of those polls' worth, roughly a minute of talking: long enough that a genuine
 * burst of activity is narrated whole, short enough that what is being said is still approximately
 * what is happening. Beyond it the *oldest* waiting sentence is dropped rather than the newest,
 * because this is a narrator of what just happened and the newest line is the one the owner is
 * standing there waiting for.
 */
export const MAX_QUEUED_UTTERANCES = 12;

/**
 * Speech in the order it was asked for, one sentence at a time.
 *
 * ## Why a queue and not `speechSynthesis.speak`
 *
 * Because `speak` used to open with `speechSynthesis.cancel()`, and the dashboard says a *batch*:
 * it claims everything unspoken and reads it in a loop. Every sentence in that loop killed the one
 * before it, so only the last was ever heard — and the claim is a watermark, so the server had
 * already stamped all of them spoken. The ones nobody heard were not pending any more. They were
 * gone, silently, with nothing on screen to say so.
 *
 * ## Why a run counter rather than a flag
 *
 * `speechSynthesis.cancel()` does not merely stop the current utterance: Chrome then fires that
 * utterance's `onend`. A queue that advanced on `onend` would answer "Stop speaking" by starting
 * the next sentence. Each callback carries the run it was made in, `drop` moves the run on, and a
 * callback from an abandoned run is ignored — which is what makes `drop` mean "and nothing after
 * this" rather than "skip one".
 *
 * ## Why it is not React
 *
 * The ordering is the part that broke, and ordering is testable without a browser. Nothing in here
 * touches `window`: the utterance is built by `play`, which the hook supplies.
 */
export function createSpeechQueue(deps: SpeechQueueDeps): SpeechQueue {
  const waiting: SpeechItem[] = [];
  let speaking = false;
  let run = 0;

  const advance = (): void => {
    const next = waiting.shift();
    if (!next) {
      if (speaking) {
        speaking = false;
        deps.speakingChanged(false);
      }
      return;
    }
    /*
     * Reported once for a batch, not once per sentence. The core's ring is driven by this, and a
     * ring that blinks out between two sentences of the same announcement reads as "it stopped".
     */
    if (!speaking) {
      speaking = true;
      deps.speakingChanged(true);
    }
    const mine = run;
    let settled = false;
    deps.play(next, () => {
      if (settled || mine !== run) return;
      settled = true;
      advance();
    });
  };

  return {
    enqueue(item) {
      waiting.push(item);
      while (waiting.length > MAX_QUEUED_UTTERANCES) waiting.shift();
      if (!speaking) advance();
    },
    drop() {
      /* Before `stop`, because cancelling is itself something the browser answers with `onend`. */
      run += 1;
      waiting.length = 0;
      const wasSpeaking = speaking;
      speaking = false;
      deps.stop();
      if (wasSpeaking) deps.speakingChanged(false);
    },
  };
}

export function useSpeech(options: { readonly lang?: string } = {}): SpeechControls {
  const [phase, setPhase] = React.useState<SpeechPhase>('idle');
  const [transcript, setTranscript] = React.useState('');
  const [interim, setInterim] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const [voices, setVoices] = React.useState<readonly { name: string; lang: string }[]>([]);
  const recognition = React.useRef<RecognitionLike | null>(null);
  const keeping = React.useRef(true);
  const playback = React.useRef<SpeechQueue | null>(null);

  const supported = React.useMemo(() => recognitionConstructor() !== null, []);
  const canSpeak = typeof window !== 'undefined' && 'speechSynthesis' in window;

  React.useEffect(() => {
    if (!canSpeak) return;
    const load = () => {
      setVoices(
        window.speechSynthesis.getVoices().map((voice) => ({ name: voice.name, lang: voice.lang })),
      );
    };
    load();
    window.speechSynthesis.addEventListener('voiceschanged', load);
    return () => window.speechSynthesis.removeEventListener('voiceschanged', load);
  }, [canSpeak]);

  /* Leaving the page must not leave a microphone running. */
  React.useEffect(() => {
    return () => {
      recognition.current?.abort();
      recognition.current = null;
      /*
       * The queue is dropped, not merely cancelled. An utterance already playing fires its end
       * callback after the page has gone, and a queue still holding items would answer that by
       * starting the next one — a voice narrating a screen nobody is looking at.
       */
      playback.current?.drop();
      playback.current = null;
      if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
        window.speechSynthesis.cancel();
      }
    };
  }, []);

  const start = React.useCallback(() => {
    const Constructor = recognitionConstructor();
    if (!Constructor) {
      setPhase('unsupported');
      return;
    }
    if (recognition.current) return;

    setError(null);
    setTranscript('');
    setInterim('');
    keeping.current = true;

    const instance = new Constructor();
    instance.lang = options.lang ?? 'en-GB';
    /*
     * Not continuous. One utterance, then it stops on its own — which is what push-to-talk means,
     * and what keeps the microphone from staying open because somebody walked away mid-sentence.
     */
    instance.continuous = false;
    instance.interimResults = true;
    instance.maxAlternatives = 1;

    instance.onresult = (event) => {
      let settled = '';
      let pending = '';
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results[index];
        const alternative = result?.[0];
        if (!result || !alternative) continue;
        if (result.isFinal) settled += alternative.transcript;
        else pending += alternative.transcript;
      }
      if (settled) setTranscript((current) => `${current}${settled}`);
      setInterim(pending);
    };

    instance.onerror = (event) => {
      setError(describeError(event.error));
      setPhase('idle');
    };

    instance.onend = () => {
      recognition.current = null;
      setInterim('');
      if (!keeping.current) setTranscript('');
      setPhase((current) => (current === 'listening' ? 'idle' : current));
    };

    recognition.current = instance;
    setPhase('listening');
    try {
      instance.start();
    } catch {
      /* Already started, which is harmless: the browser is already listening. */
    }
  }, [options.lang]);

  const stop = React.useCallback(() => {
    keeping.current = true;
    recognition.current?.stop();
  }, []);

  const cancel = React.useCallback(() => {
    keeping.current = false;
    recognition.current?.abort();
    recognition.current = null;
    setInterim('');
    setTranscript('');
    setPhase('idle');
  }, []);

  const reset = React.useCallback(() => {
    setTranscript('');
    setInterim('');
    setError(null);
    setPhase('idle');
  }, []);

  /**
   * The one queue this hook speaks through, built on first use.
   *
   * Held in a ref rather than a `useMemo` because React is allowed to throw a memoised value away
   * and rebuild it, and a rebuilt queue is an empty queue that has forgotten a callback the browser
   * is still going to call — the sentences waiting behind the one playing would simply never be
   * said, which is the failure this queue exists to end.
   */
  const playbackQueue = React.useCallback((): SpeechQueue => {
    playback.current ??= createSpeechQueue({
      play: (item, finished) => {
        const utterance = new SpeechSynthesisUtterance(item.text);
        utterance.rate = item.rate ?? 1;

        const installed = window.speechSynthesis.getVoices();
        /*
         * A name the owner picked wins outright; otherwise the British preference decides.
         *
         * `chooseVoice` is deliberately a pure function over the list rather than a lookup here, so
         * the fallback order — George, then the other en-GB male voices, then any British voice,
         * then the browser's own — is testable without a browser, and so the sentence shown in
         * settings is generated from the same decision that picks the voice rather than written
         * beside it.
         */
        const named = item.voice ? installed.find((voice) => voice.name === item.voice) : undefined;
        const chosen =
          named ?? installed.find((voice) => voice.name === chooseVoice(installed).voice?.name);
        if (chosen) utterance.voice = chosen;

        /*
         * A slightly slower, slightly lower delivery.
         *
         * Only applied when the caller did not ask for a rate. The default 1.0 on the Windows en-GB
         * voices is a touch brisk for a sentence you are hearing rather than reading, and the pitch
         * drop is what stops it sounding like a station announcement.
         */
        if (item.rate === undefined) utterance.rate = 0.96;
        utterance.pitch = 0.95;

        utterance.onend = () => finished();
        /* A failure ends this sentence and no other: the queue owes the owner the rest of them. */
        utterance.onerror = () => finished();
        window.speechSynthesis.speak(utterance);
      },
      stop: () => window.speechSynthesis.cancel(),
      speakingChanged: (speaking) =>
        setPhase((current) => (speaking ? 'speaking' : current === 'speaking' ? 'idle' : current)),
    });
    return playback.current;
  }, []);

  const speak = React.useCallback(
    (text: string, speakOptions: { voice?: string; rate?: number } = {}) => {
      if (!canSpeak || text.trim().length === 0) return;
      /*
       * Queued, never interrupting. Interrupting is `silence`, which the microphone button calls
       * before it opens — so "stop talking now" is still something this hook does; it is simply no
       * longer what every ordinary sentence does to the sentence in front of it.
       */
      playbackQueue().enqueue({ text, ...speakOptions });
    },
    [canSpeak, playbackQueue],
  );

  /*
   * Which voice this device will actually use, recomputed as voices arrive.
   *
   * `getVoices()` is famously empty on first call in Chrome and fills in asynchronously, which is
   * why this is derived from the `voices` state the `voiceschanged` listener maintains rather than
   * read directly. Exposed so the settings panel can say what will be heard instead of promising
   * a voice the machine may not have.
   */
  const voiceChoice: VoiceChoice = React.useMemo(() => chooseVoice(voices), [voices]);

  const silence = React.useCallback(() => {
    if (!canSpeak) return;
    /* Everything, not just the sentence in the air — the control says "Stop speaking", not "Skip". */
    playbackQueue().drop();
  }, [canSpeak, playbackQueue]);

  return {
    supported,
    canSpeak,
    phase: supported ? phase : 'unsupported',
    transcript,
    interim,
    error,
    voices,
    voiceChoice,
    start,
    stop,
    cancel,
    reset,
    speak,
    silence,
    setPhase,
  };
}

/**
 * The browser's error codes, in words that say what to do.
 *
 * `not-allowed` is the one that matters: it means the person declined the microphone, and the
 * right response is to say so once and leave the text box working — not to ask again.
 */
function describeError(code: string | undefined): string {
  switch (code) {
    case 'not-allowed':
    case 'service-not-allowed':
      return 'Your browser is not allowing the microphone. Type instead, or allow it in the address bar.';
    case 'no-speech':
      return 'Jarvis did not hear anything.';
    case 'audio-capture':
      return 'No microphone was found.';
    case 'network':
      return 'Speech recognition needs the network and could not reach it.';
    case 'aborted':
      return 'Stopped.';
    default:
      return 'Speech recognition stopped unexpectedly. Type instead.';
  }
}
