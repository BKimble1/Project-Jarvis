'use client';

import * as React from 'react';

/**
 * A genuinely measured microphone level, or nothing at all.
 *
 * ## Why this exists
 *
 * Because the core reacts to how loudly somebody is speaking, and the only honest way to do that
 * is to measure it. The alternative — a sine wave that looks like a voice — is the exact thing the
 * brief for this screen forbids, and it is worth being blunt about why: a fake waveform is
 * indistinguishable from a real one to the person watching, so it teaches them to trust a signal
 * that is not connected to anything. The first time they rely on it to tell whether the microphone
 * is picking them up, it lies.
 *
 * ## Why it is separate from recognition
 *
 * `useSpeech` owns the browser's `SpeechRecognition`, which holds its own capture internally and
 * exposes no audio. Getting a level therefore means a second `getUserMedia` stream. That is a real
 * cost — a second permission-gated capture — so this is built to be entirely optional:
 *
 *  - It is only ever started from the same gesture that starts listening.
 *  - Every failure is soft. A refused permission, a browser with no `AudioContext`, a device that
 *    disappears mid-sentence: all of them end with `level()` returning null and recognition
 *    completely unaffected. Speaking to Jarvis must never depend on the decoration working.
 *  - `null` means "no measurement", and the core treats that as no movement rather than as zero.
 *
 * ## Why it returns a function
 *
 * An analyser produces a new figure every frame. Putting that in React state would re-render the
 * screen sixty times a second to move one circle. The value lives in a ref and the animation loop
 * reads it where it already is, so this hook causes no renders at all once started.
 */
export interface MicLevel {
  /** The latest RMS level in 0..1, or null when nothing is being measured. */
  readonly read: () => number | null;
  /** Attach to the microphone. Safe to call twice; the second call is a no-op. */
  readonly attach: () => Promise<void>;
  /** Release the microphone, the analyser and the audio context. */
  readonly release: () => void;
}

type AudioContextConstructor = new () => AudioContext;

function audioContextConstructor(): AudioContextConstructor | null {
  if (typeof window === 'undefined') return null;
  const candidate = window as unknown as {
    AudioContext?: AudioContextConstructor;
    webkitAudioContext?: AudioContextConstructor;
  };
  return candidate.AudioContext ?? candidate.webkitAudioContext ?? null;
}

export function useMicLevel(): MicLevel {
  const value = React.useRef<number | null>(null);
  const stream = React.useRef<MediaStream | null>(null);
  const context = React.useRef<AudioContext | null>(null);
  const analyser = React.useRef<AnalyserNode | null>(null);
  const frame = React.useRef<number | null>(null);
  const attaching = React.useRef(false);

  const release = React.useCallback(() => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
    value.current = null;
    analyser.current = null;
    /*
     * Stopping every track, not just dropping the reference. A MediaStream that is garbage
     * collected without this leaves the browser's recording indicator on, which is precisely the
     * kind of thing that makes people distrust an interface that listens.
     */
    stream.current?.getTracks().forEach((track) => track.stop());
    stream.current = null;
    void context.current?.close().catch(() => undefined);
    context.current = null;
  }, []);

  const attach = React.useCallback(async () => {
    if (stream.current || attaching.current) return;
    const Constructor = audioContextConstructor();
    if (!Constructor || typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      return;
    }
    attaching.current = true;
    try {
      const captured = await navigator.mediaDevices.getUserMedia({ audio: true });
      const ctx = new Constructor();
      const node = ctx.createAnalyser();
      /*
       * Small and heavily smoothed. This is driving a glow, not a spectrogram: a long window would
       * lag behind the voice, and an unsmoothed one would make the core flicker on consonants.
       */
      node.fftSize = 512;
      node.smoothingTimeConstant = 0.75;
      ctx.createMediaStreamSource(captured).connect(node);

      stream.current = captured;
      context.current = ctx;
      analyser.current = node;

      /*
       * The sample buffer is a closure variable rather than a ref, so its element type stays
       * exactly what `new Float32Array(n)` produces. A ref widens it to a shared-memory-capable
       * array, which `getFloatTimeDomainData` will not accept.
       */
      const data = new Float32Array(node.fftSize);

      /* A device unplugged mid-sentence ends the track; treat that as "no measurement". */
      captured.getAudioTracks().forEach((track) => {
        track.addEventListener('ended', () => release());
      });

      const sample = () => {
        /* Identity, not truthiness: a release followed by a re-attach must not be fed by this. */
        if (analyser.current !== node) return;
        node.getFloatTimeDomainData(data);
        let sum = 0;
        for (let index = 0; index < data.length; index += 1) {
          const point = data[index] ?? 0;
          sum += point * point;
        }
        const rms = Math.sqrt(sum / data.length);
        /*
         * Speech RMS sits around 0.02–0.2, so the raw figure would barely move the core. Scaled
         * to fill the range a person actually produces — this is a gain, not an invention: at
         * silence it is still zero, and it is still measuring the room.
         */
        value.current = Math.min(1, rms * 6);
        frame.current = requestAnimationFrame(sample);
      };
      frame.current = requestAnimationFrame(sample);
    } catch {
      /* Refused, unavailable, or gone. The level stays null and speaking still works. */
      release();
    } finally {
      attaching.current = false;
    }
  }, [release]);

  React.useEffect(() => release, [release]);

  const read = React.useCallback(() => value.current, []);

  return React.useMemo(() => ({ read, attach, release }), [read, attach, release]);
}
