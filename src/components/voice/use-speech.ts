'use client';

import * as React from 'react';

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

export function useSpeech(options: { readonly lang?: string } = {}): SpeechControls {
  const [phase, setPhase] = React.useState<SpeechPhase>('idle');
  const [transcript, setTranscript] = React.useState('');
  const [interim, setInterim] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const [voices, setVoices] = React.useState<readonly { name: string; lang: string }[]>([]);
  const recognition = React.useRef<RecognitionLike | null>(null);
  const keeping = React.useRef(true);

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

  const speak = React.useCallback(
    (text: string, speakOptions: { voice?: string; rate?: number } = {}) => {
      if (!canSpeak || text.trim().length === 0) return;
      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.rate = speakOptions.rate ?? 1;
      const chosen = window.speechSynthesis
        .getVoices()
        .find((voice) => voice.name === speakOptions.voice);
      if (chosen) utterance.voice = chosen;
      utterance.onend = () => setPhase((current) => (current === 'speaking' ? 'idle' : current));
      utterance.onerror = () => setPhase('idle');
      setPhase('speaking');
      window.speechSynthesis.speak(utterance);
    },
    [canSpeak],
  );

  const silence = React.useCallback(() => {
    if (!canSpeak) return;
    window.speechSynthesis.cancel();
    setPhase((current) => (current === 'speaking' ? 'idle' : current));
  }, [canSpeak]);

  return {
    supported,
    canSpeak,
    phase: supported ? phase : 'unsupported',
    transcript,
    interim,
    error,
    voices,
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
