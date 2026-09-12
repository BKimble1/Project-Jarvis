'use client';

import * as React from 'react';
import { Mic, MicOff, Square, Volume2, VolumeX } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { useSpeech, type SpeechPhase } from './use-speech';

/**
 * Speaking to Jarvis, with the text box still doing everything it did.
 *
 * ## The two-step is the design, not an obstacle
 *
 * A browser mishears. So nothing happens on the first pass: what was heard comes back as editable
 * text with a plain sentence about what Jarvis would do with it, and the person presses Send.
 * That single extra press is what makes it safe to speak to something that can change files.
 *
 * ## What is deliberately absent
 *
 * **A wake word.** Browsers cannot do one without holding the microphone open indefinitely, and a
 * control that claimed to be listening for a name while doing exactly that would be a lie about a
 * microphone. Push-to-talk is the default; hands-free keeps the microphone on between utterances
 * and still starts with a press, and says so.
 *
 * **Any approval.** The domain refuses to treat spoken words as approval, twice, and there is no
 * setting that changes it. Approvals happen on screen where a person can read what they agree to.
 *
 * ## When the browser cannot do this
 *
 * The button is not rendered and the text box is untouched. Speech is an addition to this
 * interface and never a route through it — every single thing that can be done by voice can be
 * done by typing, which is what makes the absence of the feature a non-event.
 */
export function VoiceControl({
  onTranscript,
  speakThis,
  disabled,
}: {
  /** Called with the final, edited text when the person sends it. */
  onTranscript: (text: string) => void | Promise<void>;
  /** Something for Jarvis to read back, when the person asked for that. */
  speakThis?: string | null;
  disabled?: boolean;
}) {
  const speech = useSpeech();
  const [draft, setDraft] = React.useState('');
  const [handsFree, setHandsFree] = React.useState(false);
  const [readBack, setReadBack] = React.useState(false);
  const [rate, setRate] = React.useState(1);
  const [voiceName, setVoiceName] = React.useState('');
  const [sending, setSending] = React.useState(false);
  const spoken = React.useRef<string | null>(null);

  /* What was recognised becomes an editable draft, once, when listening stops. */
  React.useEffect(() => {
    if (speech.phase === 'idle' && speech.transcript.trim().length > 0) {
      setDraft((current) => (current.length > 0 ? current : speech.transcript.trim()));
    }
  }, [speech.phase, speech.transcript]);

  /*
   * Read an answer back only when asked, and only once per answer.
   *
   * The ref is the whole defence against the most annoying possible bug: a component that
   * re-renders while an answer is on screen and starts reading it again from the top.
   */
  React.useEffect(() => {
    if (!readBack || !speakThis || spoken.current === speakThis) return;
    spoken.current = speakThis;
    speech.speak(speakThis, { rate, ...(voiceName ? { voice: voiceName } : {}) });
  }, [readBack, speakThis, rate, voiceName, speech]);

  async function send() {
    const text = draft.trim();
    if (text.length === 0 || sending) return;
    setSending(true);
    try {
      await onTranscript(text);
      setDraft('');
      speech.reset();
      /* Hands-free listens again for the next thing, after the send, never during it. */
      if (handsFree && speech.supported) speech.start();
    } finally {
      setSending(false);
    }
  }

  if (!speech.supported) {
    /*
     * Nothing at all, rather than a disabled button. A control that cannot work is noise, and the
     * text box beside it already does everything this would have done.
     */
    return null;
  }

  const listening = speech.phase === 'listening';

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant={listening ? 'danger' : 'secondary'}
          disabled={disabled}
          aria-pressed={listening}
          aria-label={listening ? 'Stop listening' : 'Speak to Jarvis'}
          onClick={() => (listening ? speech.stop() : speech.start())}
        >
          {listening ? (
            <Square className="h-4 w-4" aria-hidden />
          ) : (
            <Mic className="h-4 w-4" aria-hidden />
          )}
          {listening ? 'Stop' : 'Speak'}
        </Button>

        {listening ? (
          <Button type="button" variant="ghost" onClick={() => speech.cancel()}>
            <MicOff className="h-4 w-4" aria-hidden />
            Discard
          </Button>
        ) : null}

        <Indicator phase={speech.phase} />

        {speech.phase === 'speaking' ? (
          <Button type="button" variant="ghost" onClick={() => speech.silence()}>
            <VolumeX className="h-4 w-4" aria-hidden />
            Stop reading
          </Button>
        ) : null}
      </div>

      {/*
       * The unstable tail, shown greyed while it is still changing. Seeing the words appear is
       * what tells a person the microphone is actually working — an indicator alone does not.
       */}
      {listening ? (
        <p className="text-sm" aria-live="polite">
          {speech.transcript}
          <span className="text-[var(--color-text-subtle)]">{speech.interim}</span>
          {speech.transcript.length === 0 && speech.interim.length === 0 ? (
            <span className="text-[var(--color-text-subtle)]">Listening…</span>
          ) : null}
        </p>
      ) : null}

      {draft.length > 0 && !listening ? (
        <div className="flex flex-col gap-2 rounded-[var(--radius-card)] border border-[var(--color-border)] p-3">
          <label className="text-xs text-[var(--color-text-muted)]" htmlFor="voice-draft">
            Jarvis heard this. Correct it if it is wrong — nothing has happened yet.
          </label>
          <textarea
            id="voice-draft"
            value={draft}
            rows={2}
            onChange={(event) => setDraft(event.target.value)}
            className="w-full rounded-[var(--radius-control)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm"
          />
          <div className="flex flex-wrap gap-2">
            <Button type="button" onClick={() => void send()} disabled={sending}>
              {sending ? 'Sending…' : 'Send'}
            </Button>
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                setDraft('');
                speech.reset();
              }}
            >
              Discard
            </Button>
          </div>
        </div>
      ) : null}

      {speech.error ? (
        <p className="text-xs text-[var(--color-caution-text)]">{speech.error}</p>
      ) : null}

      <details className="text-xs text-[var(--color-text-muted)]">
        <summary className="cursor-pointer">Voice settings</summary>
        <div className="mt-2 flex flex-col gap-2">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={handsFree}
              onChange={(event) => setHandsFree(event.target.checked)}
            />
            Keep listening after each message (hands-free). Still starts with a press — Jarvis has
            no wake word and does not listen for one.
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={readBack}
              onChange={(event) => setReadBack(event.target.checked)}
            />
            <Volume2 className="h-3.5 w-3.5" aria-hidden />
            Read answers back
          </label>
          {speech.canSpeak ? (
            <div className="flex flex-wrap items-center gap-2">
              <label className="flex items-center gap-1">
                Voice
                <select
                  value={voiceName}
                  onChange={(event) => setVoiceName(event.target.value)}
                  className="rounded-[var(--radius-control)] border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1"
                >
                  <option value="">Browser default</option>
                  {speech.voices.map((voice) => (
                    <option key={`${voice.name}:${voice.lang}`} value={voice.name}>
                      {voice.name} ({voice.lang})
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex items-center gap-1">
                Speed
                <input
                  type="range"
                  min={0.6}
                  max={1.6}
                  step={0.1}
                  value={rate}
                  onChange={(event) => setRate(Number(event.target.value))}
                />
                {rate.toFixed(1)}×
              </label>
            </div>
          ) : (
            <p>This browser cannot read answers aloud.</p>
          )}
        </div>
      </details>
    </div>
  );
}

const PHASE_LABELS: Record<SpeechPhase, string> = {
  idle: '',
  listening: 'Listening',
  thinking: 'Thinking',
  speaking: 'Speaking',
  unsupported: '',
};

function Indicator({ phase }: { phase: SpeechPhase }) {
  const label = PHASE_LABELS[phase];
  if (!label) return null;
  return (
    <span
      role="status"
      aria-live="polite"
      className="flex items-center gap-1.5 text-xs text-[var(--color-text-muted)]"
    >
      <span
        aria-hidden
        className={`inline-block h-2 w-2 rounded-full ${
          phase === 'listening'
            ? 'animate-pulse bg-[var(--color-critical-text)]'
            : 'bg-[var(--color-accent)]'
        }`}
      />
      {label}
    </span>
  );
}
