'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  ArrowRight,
  CornerDownLeft,
  Loader2,
  Maximize2,
  Mic,
  Minimize2,
  Settings2,
  Square,
  VolumeX,
} from 'lucide-react';

import { interpretReply } from '@/domain/reply-intent';
import type { NextAction } from '@/domain/next-actions';
import type { MorningBriefing } from '@/domain/briefing-shape';
import type { QueryAnswer } from '@/domain/query';
import { CORE_STATE_TONE, coreState, coreStatusLine, type CoreState } from '@/domain/core-state';
import { AnswerPanel } from '@/components/answer-panel';
import { ReadinessStrip, type ReadinessSummary } from '@/components/readiness-strip';
import { JarvisCore } from '@/components/jarvis/core';
import { CapacityDial, Clock, Panel, Pill } from '@/components/jarvis/chrome';
import { useMicLevel } from '@/components/jarvis/use-mic-level';
import { useSpeech } from '@/components/voice/use-speech';
import { cn } from '@/lib/cn';

/* ------------------------------------------------------------------ the shape of the screen */

export interface ScreenProject {
  readonly id: string;
  readonly name: string;
  readonly statusLabel: string;
  readonly needsAttention: boolean;
  readonly freshnessLabel: string;
  /** The mission genuinely open on this project, if there is one. Never a guess. */
  readonly work: {
    readonly missionId: string;
    readonly title: string;
    readonly state: string;
  } | null;
}

export interface ScreenCompletion {
  readonly id: string;
  readonly title: string;
  readonly detail: string;
  readonly href: string;
}

export interface ScreenCapacityWindow {
  readonly label: string;
  readonly percentUsed: number | null;
  readonly qualityLabel: string;
}

export interface JarvisScreenProps {
  readonly ownerName: string;
  readonly timeZone: string;
  readonly headline: string;
  readonly modeLabel: string;
  readonly modeMeaning: string;
  readonly loopState: string;
  readonly loopExplanation: string;
  readonly standingAuthority: boolean;
  readonly blockedReason: string | null;
  readonly capacityReason: string | null;
  readonly capacityWithheld: boolean;
  readonly workerReady: boolean;
  readonly workerDetail: string;
  readonly running: readonly { missionId: string; title: string; state: string }[];
  readonly actions: readonly NextAction[];
  readonly actionSummary: string;
  readonly projects: readonly ScreenProject[];
  readonly completions: readonly ScreenCompletion[];
  readonly capacity: {
    readonly applicable: boolean;
    readonly authModeLabel: string;
    readonly windows: readonly ScreenCapacityWindow[];
  } | null;
  readonly readiness: ReadinessSummary;
  readonly projectCount: number;
}

/** One turn of the conversation, as it is kept on screen. */
interface Turn {
  readonly id: number;
  readonly who: 'you' | 'jarvis';
  readonly text: string;
  readonly href?: string | null;
}

const GRAPHICS_KEY = 'jarvis-graphics';
const MOTION_KEY = 'jarvis-motion';

/**
 * The immersive Jarvis screen.
 *
 * ## What this is, and what it refuses to be
 *
 * It is the interface an owner walks into a room and reads from three metres away, then sits down
 * and speaks to. Everything on it is a record: a mission in a state, a project the status engine
 * flagged, a capacity window a worker actually reported. The ring geometry and the particle field
 * are decoration and are marked as such — `aria-hidden`, no numbers, no counts — because the one
 * thing an interface like this must never do is make a beautiful animation stand in for a fact.
 *
 * ## The two-axis rule
 *
 * Conversation state and background work state are held apart, all the way through. `coreState`
 * resolves which one the centre of the core shows, but the count of running missions is passed to
 * the core separately as `activity` and rendered on its own ring, so Jarvis speaking never erases
 * three agents working, and three agents working never hides the fact that it is listening.
 *
 * ## Why the numbered list is bound at composition time
 *
 * "Do the first one" resolves against the list the person could see when they started speaking.
 * Between pressing the microphone and the transcript arriving, a poll can land and reorder that
 * list — so the identity of the list is captured when composition starts and checked before an
 * ordinal is acted on. If it changed, nothing runs and the screen says so. Executing a different
 * "first one" than the one that was read out loud is the worst failure this screen could have.
 */
export function JarvisScreen(props: JarvisScreenProps) {
  const router = useRouter();
  const speech = useSpeech();
  const mic = useMicLevel();

  const [reply, setReply] = React.useState('');
  const [turns, setTurns] = React.useState<readonly Turn[]>([]);
  const [answer, setAnswer] = React.useState<QueryAnswer | null>(null);
  /* The words that produced the answer on screen, which a work request has to carry onwards. */
  const [asked, setAsked] = React.useState('');
  const [briefing, setBriefing] = React.useState<MorningBriefing | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [justCompleted, setJustCompleted] = React.useState(false);
  const [selected, setSelected] = React.useState<string | null>(null);
  const [immersive, setImmersive] = React.useState(false);
  const [showSettings, setShowSettings] = React.useState(false);
  const [graphics, setGraphics] = React.useState<'full' | 'lite'>('full');
  const [motion, setMotion] = React.useState(true);
  const [readBack, setReadBack] = React.useState(false);
  const [handsFree, setHandsFree] = React.useState(false);
  const [expanded, setExpanded] = React.useState(false);
  const [showHistory, setShowHistory] = React.useState(false);
  /*
   * The greeting depends on the hour, which the server and the browser disagree about — so the
   * HTML ships with the neutral form and the time-of-day one arrives a frame later. Every other
   * date in this application is rendered the same way, for the same reason.
   */
  const [greeting, setGreeting] = React.useState('Hello');
  /*
   * Whether the browser has taken over yet.
   *
   * `useSpeech` reports what *this* browser can do, which the server cannot know — so rendering a
   * microphone button from `speech.supported` puts a button in the client tree that is not in the
   * server's HTML, and React rejects the whole subtree. Gating on mount makes the first client
   * render identical to the server's and the button appear a frame later, which is invisible.
   */
  const [mounted, setMounted] = React.useState(false);
  /*
   * Why this browser will not offer a microphone, when it will not.
   *
   * `SpeechRecognition` needs a secure context, which is what makes voice quietly disappear the
   * first time somebody opens Jarvis from their phone at `http://192.168.1.20:3000`. Nothing is
   * broken and nothing says so, which is the worst combination. Computed after mount because
   * `isSecureContext` is a browser fact.
   */
  const [voiceNote, setVoiceNote] = React.useState<string | null>(null);

  const inputRef = React.useRef<HTMLInputElement>(null);
  const turnId = React.useRef(0);
  const spokenAlready = React.useRef<string | null>(null);

  /* ---------------------------------------------------------------- graphics preferences */

  /*
   * Read after mount, never during render. The alternative is a different first paint on the
   * server and in the browser, which React rejects — and the pre-hydration theme script exists
   * for the one attribute that genuinely cannot wait. This one can.
   */
  React.useEffect(() => {
    try {
      const storedGraphics = window.localStorage.getItem(GRAPHICS_KEY);
      if (storedGraphics === 'lite' || storedGraphics === 'full') setGraphics(storedGraphics);
      const storedMotion = window.localStorage.getItem(MOTION_KEY);
      if (storedMotion === 'off') setMotion(false);
      else if (
        storedMotion !== 'on' &&
        window.matchMedia('(prefers-reduced-motion: reduce)').matches
      ) {
        /*
         * Reduced motion is honoured by default, and every state stays legible without it: the
         * label under the core, the status line and the pills all say the same thing the movement
         * was saying. Somebody who has asked for stillness gets a still, complete screen.
         */
        setMotion(false);
      }
    } catch {
      /* Storage can be unavailable in a private window. Defaults are already correct. */
    }
  }, []);

  const chooseGraphics = (next: 'full' | 'lite') => {
    setGraphics(next);
    try {
      window.localStorage.setItem(GRAPHICS_KEY, next);
    } catch {
      /* Not worth telling anybody about; the choice still applies for this session. */
    }
  };
  const chooseMotion = (next: boolean) => {
    setMotion(next);
    try {
      window.localStorage.setItem(MOTION_KEY, next ? 'on' : 'off');
    } catch {
      /* As above. */
    }
  };

  /* ---------------------------------------------------------------- the blue surface */

  React.useEffect(() => {
    setMounted(true);
    if (!speech.supported) {
      setVoiceNote(
        window.isSecureContext
          ? 'This browser cannot do speech recognition. Everything here can be typed.'
          : 'Speaking needs a secure connection. Open Jarvis over https, or on this machine at http://127.0.0.1:3000 — everything here can be typed either way.',
      );
    }
    const hour = new Date().getHours();
    setGreeting(hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening');
    /* Once. `speech.supported` is a `useMemo` over the browser's own API and never changes. */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* While this screen is mounted the whole document wears the Jarvis palette, chrome included. */
  React.useEffect(() => {
    document.documentElement.setAttribute('data-jarvis-scope', 'on');
    return () => document.documentElement.removeAttribute('data-jarvis-scope');
  }, []);

  /* ---------------------------------------------------------------- immersive mode */

  /*
   * One control, two mechanisms, and an honest fallback.
   *
   * Browser fullscreen needs a gesture and is refused outright in some embeddings, so the focus
   * attribute — which simply hides the application chrome — is what actually guarantees the
   * immersive view. Fullscreen is requested on top of it where it is available. Escape leaves
   * fullscreen by the browser's own rules; the listener below keeps the button in step with that,
   * and Escape also leaves focus mode so there is never a screen with no way out.
   */
  const setFocus = React.useCallback((on: boolean) => {
    setImmersive(on);
    if (on) document.documentElement.setAttribute('data-jarvis-focus', 'on');
    else document.documentElement.removeAttribute('data-jarvis-focus');
  }, []);

  React.useEffect(() => {
    return () => document.documentElement.removeAttribute('data-jarvis-focus');
  }, []);

  React.useEffect(() => {
    const onChange = () => {
      if (!document.fullscreenElement && immersive) setFocus(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && immersive && !document.fullscreenElement) setFocus(false);
    };
    document.addEventListener('fullscreenchange', onChange);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('fullscreenchange', onChange);
      window.removeEventListener('keydown', onKey);
    };
  }, [immersive, setFocus]);

  const toggleImmersive = () => {
    if (immersive) {
      setFocus(false);
      if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
      return;
    }
    setFocus(true);
    void document.documentElement.requestFullscreen?.().catch(() => undefined);
  };

  /* ---------------------------------------------------------------- keeping the picture fresh */

  /*
   * Polling is entirely separate from the animation, and deliberately so: the core turns sixty
   * times a second and must never cause a request. This is the application's existing live
   * pattern — a visibility-aware interval that calls `router.refresh()` — at two rates, quick
   * while something is actually running and slow when nothing is.
   */
  const busyRef = React.useRef(busy);
  busyRef.current = busy;
  const running = props.running;

  React.useEffect(() => {
    const period = running.length > 0 ? 8000 : 30000;
    const timer = setInterval(() => {
      if (document.hidden || busyRef.current) return;
      router.refresh();
    }, period);
    return () => clearInterval(timer);
  }, [router, running.length]);

  /* ---------------------------------------------------------------- the bound action list */

  /*
   * The identity of the numbered list, captured when the person starts composing.
   *
   * Null means nothing is being composed. It is set on the first keystroke and when the
   * microphone opens, and cleared on every send.
   */
  const boundList = React.useRef<string | null>(null);
  /*
   * Both lists an ordinal or a "continue" can resolve against. The running missions belong in it
   * for the same reason the actions do: a poll that started or finished one changes what
   * "continue" means, and going to a different mission than the one that was on screen is the
   * same failure as opening a different "first one".
   */
  const listKey = [
    ...props.actions.map((action) => action.id),
    '~',
    ...props.running.map((entry) => entry.missionId),
  ].join('|');

  const bind = React.useCallback(() => {
    if (boundList.current === null) boundList.current = listKey;
  }, [listKey]);

  /* ---------------------------------------------------------------- conversation */

  const say = React.useCallback((text: string, href?: string | null) => {
    turnId.current += 1;
    setTurns((current) =>
      [...current, { id: turnId.current, who: 'jarvis' as const, text, href: href ?? null }].slice(
        -24,
      ),
    );
  }, []);

  const heard = React.useCallback((text: string) => {
    turnId.current += 1;
    setTurns((current) =>
      [...current, { id: turnId.current, who: 'you' as const, text }].slice(-24),
    );
  }, []);

  const latest = turns.length > 0 ? turns[turns.length - 1] : undefined;
  const lastFromJarvis = [...turns].reverse().find((turn) => turn.who === 'jarvis') ?? null;

  /* Read an answer aloud only when asked, and only once per answer. */
  React.useEffect(() => {
    const text = lastFromJarvis?.text ?? null;
    if (!readBack || !text || spokenAlready.current === text) return;
    spokenAlready.current = text;
    speech.speak(text);
  }, [readBack, lastFromJarvis, speech]);

  const markCompleted = React.useCallback(() => {
    setJustCompleted(true);
    window.setTimeout(() => setJustCompleted(false), 4000);
  }, []);

  async function runPass() {
    setBusy(true);
    try {
      const response = await fetch('/api/operator/tick', { method: 'PUT' });
      const payload = (await response.json().catch(() => ({}))) as {
        summary?: string;
        error?: { message?: string };
      };
      if (response.ok) markCompleted();
      say(
        response.ok
          ? (payload.summary ?? 'Done — I have had a look.')
          : (payload.error?.message ?? 'That did not work.'),
      );
      router.refresh();
    } catch {
      say('I could not reach the control plane just now.');
    } finally {
      setBusy(false);
    }
  }

  async function brief() {
    setBusy(true);
    try {
      const response = await fetch('/api/briefing/morning');
      const payload = (await response.json().catch(() => ({}))) as {
        briefing?: MorningBriefing;
        error?: { message?: string };
      };
      if (!response.ok || !payload.briefing) {
        say(payload.error?.message ?? 'I could not put a briefing together.');
        return;
      }
      setBriefing(payload.briefing);
      setAnswer(null);
      setExpanded(true);
      say(spokenBriefing(payload.briefing));
    } catch {
      say('I could not reach the control plane just now.');
    } finally {
      setBusy(false);
    }
  }

  async function capture(text: string) {
    setBusy(true);
    try {
      const response = await fetch('/api/knowledge/memories/capture', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      const payload = (await response.json().catch(() => ({}))) as {
        said?: string;
        error?: { message?: string };
      };
      if (response.ok) setReply('');
      say(payload.said ?? payload.error?.message ?? 'That did not work.');
    } catch {
      say('I could not reach the control plane just now.');
    } finally {
      setBusy(false);
    }
  }

  /**
   * A question, answered by the deterministic status router.
   *
   * The same endpoint the command bar has always used, so the routing, the provenance and the
   * citations are unchanged; only where the answer lands is different. The summary becomes the
   * spoken line in the middle of the screen and the full structured answer opens in the panel
   * below, which is what keeps a long reply from covering the scene.
   */
  async function askJarvis(text: string) {
    setBusy(true);
    try {
      const response = await fetch('/api/query', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: text }),
      });
      if (!response.ok) throw new Error('no answer');
      const data = (await response.json()) as { answer: QueryAnswer };
      setAnswer(data.answer);
      setAsked(text);
      setBriefing(null);
      setExpanded(true);
      say(data.answer.summary, data.answer.href ?? null);
    } catch {
      say('I could not answer that just now. Check the connection and try again.');
    } finally {
      setBusy(false);
    }
  }

  /**
   * Something said out loud, put through exactly the gates something typed goes through.
   *
   * Two server steps, unchanged from the panel this replaces: the first says what Jarvis would do
   * with the words, the second does it and re-derives the interpretation from the final text.
   * Anything that would change something outside Jarvis stops at the first step and is handed
   * back for the screen. This redesign adds no approval and removes none.
   */
  async function throughVoiceGate(text: string) {
    setBusy(true);
    try {
      const submitted = await fetch('/api/voice', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ transcript: text }),
      });
      const understood = (await submitted.json().catch(() => ({}))) as {
        id?: string;
        intent?: string;
        consequence?: string;
        requiresVisualApproval?: boolean;
        error?: { message?: string };
      };
      if (!submitted.ok || !understood.id || !understood.intent) {
        say(understood.error?.message ?? 'I could not make sense of that.');
        return;
      }
      if (understood.requiresVisualApproval) {
        setReply(text);
        say(understood.consequence ?? 'That one has to be done on screen.');
        return;
      }
      const confirmed = await fetch(`/api/voice/${understood.id}/confirm`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text, shownIntent: understood.intent }),
      });
      const result = (await confirmed.json().catch(() => ({}))) as {
        outcome?: { said?: string };
        error?: { message?: string };
      };
      if (confirmed.ok) markCompleted();
      say(result.outcome?.said ?? result.error?.message ?? 'That did not work.');
      router.refresh();
    } catch {
      say('I could not reach the control plane just now.');
    } finally {
      setBusy(false);
    }
  }

  /** The one path every message takes, whether it was typed or spoken. */
  async function send(raw: string, spoken: boolean) {
    const text = raw.trim();
    if (text.length === 0) return;
    heard(text);

    const boundTo = boundList.current;
    boundList.current = null;

    if (
      /^(?:please\s+)?(?:remember|note|make a note|keep in mind|jot down|forget|stop remembering)\b/i.test(
        text,
      )
    ) {
      await capture(text);
      return;
    }

    const intent = interpretReply(text, props.actions.length);

    if (intent.kind === 'decline') {
      setReply('');
      say('Alright. Nothing from me, then — it will all still be here.');
      return;
    }

    if (intent.kind === 'ambiguous') {
      say(`${intent.reason} Say which number, or name it.`);
      return;
    }

    if (intent.kind === 'select') {
      /*
       * The check the whole binding exists for. If the list moved between composing and sending,
       * the ordinal no longer means what the person meant, so nothing runs.
       */
      if (boundTo !== null && boundTo !== listKey) {
        say(
          'That list changed while you were speaking, so I have not acted on a number. Here is the list as it stands now — say it again, or name the one you meant.',
        );
        return;
      }
      const chosen = props.actions[intent.index];
      if (!chosen) {
        say('There is nothing at that number.');
        return;
      }
      setReply('');
      if (chosen.kind === 'start_opportunity' && !chosen.requiresOwner) {
        /* Already within standing authority; asking for approval would invent a step. */
        await runPass();
        return;
      }
      say(`Opening ${chosen.label}.`, chosen.href);
      router.push(chosen.href);
      return;
    }

    if (intent.kind === 'continue') {
      if (boundTo !== null && boundTo !== listKey && props.running.length > 0) {
        say(
          'What is running changed while you were speaking, so I have not moved. Say it again and I will go to what is running now.',
        );
        return;
      }
      setReply('');
      const first = props.running[0];
      if (first) {
        say(`Going to ${first.title}.`, `/missions/${first.missionId}`);
        router.push(`/missions/${first.missionId}`);
        return;
      }
      if (props.standingAuthority) {
        await runPass();
        return;
      }
      say(
        'There is nothing running to continue. Pick one of the things waiting, or ask me something.',
      );
      return;
    }

    setReply('');
    /*
     * Spoken words go through the voice gate, which is where the domain's refusal to treat speech
     * as approval lives. Typed words that are not a reply to the list are questions.
     */
    if (spoken) await throughVoiceGate(text);
    else await askJarvis(text);
  }

  /* ---------------------------------------------------------------- microphone */

  const listening = speech.phase === 'listening';
  const speaking = speech.phase === 'speaking';

  /* What was recognised becomes an editable draft in the same box everything else is typed in. */
  React.useEffect(() => {
    if (speech.phase === 'idle' && speech.transcript.trim().length > 0) {
      setReply((current) => (current.length > 0 ? current : speech.transcript.trim()));
      mic.release();
    }
  }, [speech.phase, speech.transcript, mic]);

  const startListening = () => {
    bind();
    speech.start();
    /* The level meter is a bonus, never a prerequisite: a refusal here changes nothing else. */
    void mic.attach();
  };

  const stopListening = () => {
    speech.stop();
    mic.release();
  };

  React.useEffect(() => () => mic.release(), [mic]);

  /* ---------------------------------------------------------------- what the core shows */

  const disconnected =
    !props.workerReady || props.loopState === 'stalled' || props.loopState === 'failing';
  const needsOwner = props.actions.some((action) => action.requiresOwner);

  const state: CoreState = coreState({
    listening,
    thinking: busy,
    speaking,
    workingCount: props.running.length,
    needsOwner,
    limited: props.capacityWithheld || !props.standingAuthority,
    disconnected,
    justCompleted,
  });

  const statusLine = coreStatusLine(state, {
    workingCount: props.running.length,
    waitingCount: props.actions.filter((action) => action.requiresOwner).length,
    limitReason: props.capacityWithheld ? props.capacityReason : props.blockedReason,
    disconnectedReason: !props.workerReady ? props.workerDetail : props.loopExplanation,
  });

  const tone = CORE_STATE_TONE[state];

  /*
   * A level only where one is genuinely measured.
   *
   * Listening reads the analyser. Speaking does not: `speechSynthesis` reports that playback
   * started and stopped and nothing about amplitude, so the speaking animation is driven by those
   * events alone and is never described as a waveform.
   */
  const levelSource = React.useMemo(() => (listening ? mic.read : undefined), [listening, mic]);

  const focusedProject = props.projects.find((project) => project.id === selected) ?? null;

  return (
    <div
      className="jarvis-surface jx-screen relative flex min-h-0 w-full flex-col overflow-hidden"
      data-graphics={graphics}
      data-motion={motion ? 'on' : 'off'}
      data-testid="jarvis-screen"
    >
      <div className="jx-grid" aria-hidden />
      <div className="jx-vignette" aria-hidden />

      {/*
        Scrollable, and the columns below have a floor.

        A long answer opens a drawer inside the command dock, and on a short screen a dock that
        grows without limit would squeeze the row above it to nothing — taking the core, the status
        line and the projects with it. A minimum height on the columns and a scroll here means the
        worst case is a scene you scroll, never a scene that vanishes.
      */}
      <div className="jx-scroll relative flex min-h-0 flex-1 flex-col gap-3 p-3 sm:p-4">
        {/* ------------------------------------------------------------ top strip */}
        <header className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-[color-mix(in_srgb,var(--jx-line)_55%,transparent)] pb-3">
          <div className="flex items-center gap-3">
            <span
              aria-hidden
              className="relative flex h-8 w-8 items-center justify-center rounded-full border"
              style={{
                borderColor: `color-mix(in srgb, var(--jx-${tone === 'blue' ? 'blue' : tone}) 70%, transparent)`,
              }}
            >
              <span
                className="h-2 w-2 rounded-full"
                style={{ background: `var(--jx-${tone === 'blue' ? 'blue' : tone})` }}
              />
            </span>
            <div className="leading-tight">
              <h1 className="jx-label text-[0.6875rem] text-[var(--jx-cyan)]">Jarvis</h1>
              <p className="text-[0.8125rem] text-[var(--jx-ink-dim)]">
                {greeting}, {props.ownerName}.
              </p>
            </div>
          </div>

          <div className="order-last flex min-w-0 basis-full flex-wrap items-center gap-2 xl:order-none xl:basis-auto">
            <Pill tone={tone === 'blue' ? 'blue' : tone}>{props.modeLabel}</Pill>
            <Pill tone={props.workerReady ? 'green' : 'amber'}>
              {props.workerReady ? 'Worker connected' : 'No worker'}
            </Pill>
            <Pill tone={disconnected ? 'red' : props.standingAuthority ? 'green' : 'dim'}>
              {props.standingAuthority ? 'Autonomy on' : 'Autonomy off'}
            </Pill>
            <Pill tone={props.running.length > 0 ? 'cyan' : 'dim'}>
              {props.running.length === 0
                ? 'No mission running'
                : `${props.running.length} mission${props.running.length === 1 ? '' : 's'} running`}
            </Pill>
          </div>

          <div className="ml-auto flex items-center gap-3">
            <Clock timeZone={props.timeZone} />
            <div className="flex items-center gap-1">
              <IconButton
                label={showSettings ? 'Hide display settings' : 'Display settings'}
                onClick={() => setShowSettings((open) => !open)}
                pressed={showSettings}
              >
                <Settings2 className="h-4 w-4" aria-hidden />
              </IconButton>
              <IconButton
                label={immersive ? 'Leave immersive view' : 'Immersive view'}
                onClick={toggleImmersive}
                pressed={immersive}
              >
                {immersive ? (
                  <Minimize2 className="h-4 w-4" aria-hidden />
                ) : (
                  <Maximize2 className="h-4 w-4" aria-hidden />
                )}
              </IconButton>
            </div>
          </div>
        </header>

        {showSettings ? (
          <Panel label="Display" className="shrink-0">
            <div className="flex flex-wrap items-center gap-x-6 gap-y-3 p-3 text-xs text-[var(--jx-ink-dim)]">
              <fieldset className="flex items-center gap-2">
                <legend className="sr-only">Graphics</legend>
                <span className="jx-label">Graphics</span>
                <Choice checked={graphics === 'full'} onSelect={() => chooseGraphics('full')}>
                  Full
                </Choice>
                <Choice checked={graphics === 'lite'} onSelect={() => chooseGraphics('lite')}>
                  Lite
                </Choice>
              </fieldset>
              <fieldset className="flex items-center gap-2">
                <legend className="sr-only">Motion</legend>
                <span className="jx-label">Motion</span>
                <Choice checked={motion} onSelect={() => chooseMotion(true)}>
                  On
                </Choice>
                <Choice checked={!motion} onSelect={() => chooseMotion(false)}>
                  Off
                </Choice>
              </fieldset>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={readBack}
                  onChange={(event) => setReadBack(event.target.checked)}
                />
                Read answers aloud
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={handsFree}
                  onChange={(event) => setHandsFree(event.target.checked)}
                />
                Keep listening after each message. Still starts with a press — there is no wake word
                and Jarvis does not listen for one.
              </label>
              <p className="basis-full text-[0.6875rem] text-[var(--jx-ink-faint)]">
                Lite graphics draws far fewer points and drops the blur, for a modest machine or a
                television. Motion off keeps every state readable — the words and the colours say
                the same thing the movement was saying.
              </p>
            </div>
          </Panel>
        ) : null}

        {/*
          Whether Jarvis can actually do anything, immediately under the system strip rather than
          at the foot of the page. It is the qualifier on everything below it — approving work on
          a deployment with no worker is the failure it exists to prevent — and on a phone an
          answer that needs scrolling past the core is an answer nobody reads in time.
        */}
        <div className="shrink-0">
          <ReadinessStrip readiness={props.readiness} />
        </div>

        {/* ------------------------------------------------------------ the three columns */}
        {/*
          Deliberately in priority order rather than in visual order.
          
          On a phone this is what the column becomes, top to bottom: the core and what Jarvis is
          doing, then what needs a person, then the projects. The three-column desktop arrangement
          is restored below by naming each child's column explicitly, so the wide layout costs the
          narrow one nothing — and a screen reader, which follows the DOM, gets the priority order
          at every size.
        */}
        <div className="grid min-h-[20rem] flex-1 gap-3 xl:grid-cols-[minmax(15rem,19rem)_minmax(0,1fr)_minmax(15rem,21rem)]">
          <CoreStage
            className="xl:col-start-2 xl:row-start-1"

            state={state}
            statusLine={statusLine}
            headline={props.headline}
            activity={props.running.length}
            graphics={graphics}
            motion={motion}
            {...(levelSource ? { levelSource } : {})}
            latest={latest ?? null}
            listening={listening}
            interim={`${speech.transcript}${speech.interim}`}
            micError={speech.error}
          />

          <MattersPanel
            className="xl:col-start-3 xl:row-start-1"
            actions={props.actions}
            actionSummary={props.actionSummary}
            completions={props.completions}
            focused={focusedProject}
            running={props.running}
          />

          <ProjectRail
            className="xl:col-start-1 xl:row-start-1"
            projects={props.projects}
            projectCount={props.projectCount}
            selected={selected}
            onSelect={(id) => setSelected((current) => (current === id ? null : id))}
          />
        </div>

        {/* ------------------------------------------------------------ the dock */}
        <CommandDock
          value={reply}
          onChange={(next) => {
            bind();
            setReply(next);
          }}
          inputRef={inputRef}
          busy={busy}
          listening={listening}
          speaking={speaking}
          supported={mounted && speech.supported}
          onSubmit={() => {
            const typed = inputRef.current?.value ?? reply;
            void send(typed, false);
          }}
          onSpeakSend={() => void send(inputRef.current?.value ?? reply, true)}
          onStartListening={startListening}
          onStopListening={stopListening}
          onSilence={() => speech.silence()}
          onBrief={() => void brief()}
          capacity={props.capacity}
          workerDetail={props.workerDetail}
          voiceNote={mounted ? voiceNote : null}
          turns={turns}
          showHistory={showHistory}
          onToggleHistory={() => setShowHistory((open) => !open)}
          detail={
            expanded && (answer || briefing) ? (
              <div className="jx-scroll max-h-[28vh] border-b border-[color-mix(in_srgb,var(--jx-line)_45%,transparent)]">
                <div className="flex items-center justify-between px-3 pt-2">
                  <p className="jx-label">{briefing ? 'Briefing' : 'Answer'}</p>
                  <button
                    type="button"
                    onClick={() => setExpanded(false)}
                    className="jx-label text-[var(--jx-cyan)] hover:underline"
                  >
                    Close
                  </button>
                </div>
                {briefing ? (
                  <div className="p-3">
                    <BriefingBody briefing={briefing} />
                  </div>
                ) : null}
                {answer ? (
                  <AnswerPanel
                    answer={answer}
                    asked={asked}
                    onPick={(text) => void askJarvis(text)}
                  />
                ) : null}
              </div>
            ) : null
          }
        />

        {/* ------------------------------------------------------------ the rest of Jarvis */}
        <footer className="shrink-0">
          {/*
            The phone's half of the tab-bar contract: whatever the bottom bar leaves out has to be
            reachable from the screen a phone lands on. On a desktop the sidebar already carries
            every one of these, so repeating them there would be the duplicate command surface
            this redesign set out to remove.
          */}
          <nav aria-label="Elsewhere in Jarvis" className="flex flex-wrap gap-1.5 xl:hidden">
            {ELSEWHERE.map(([href, label]) => (
              <Link
                key={href}
                href={href}
                className="rounded-sm border border-[color-mix(in_srgb,var(--jx-line)_70%,transparent)] px-2.5 py-1.5 text-xs text-[var(--jx-ink-dim)] transition-colors hover:border-[var(--jx-blue)] hover:text-[var(--jx-ink)]"
              >
                {label}
              </Link>
            ))}
          </nav>
        </footer>
      </div>

      {/*
        Hands-free restarts recognition after a send, never during one, and only when the person
        asked for it. Kept here rather than inside the send path so the send path stays a single
        readable sequence.
      */}
      <HandsFree
        enabled={handsFree && speech.supported}
        busy={busy}
        listening={listening}
        onListen={startListening}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ the left column */

/**
 * Projects and the work actually open on each of them.
 *
 * Selecting one focuses the panels around it. It deliberately does **not** scope what a typed or
 * spoken command means: a selection that silently retargeted "do the first one" would be a way to
 * act on the wrong project without ever seeing its name, so the selection changes what is *shown*
 * and the words a person says are the only thing that chooses what is *done*.
 */
function ProjectRail({
  projects,
  projectCount,
  selected,
  onSelect,
  className,
}: {
  projects: readonly ScreenProject[];
  projectCount: number;
  selected: string | null;
  onSelect: (id: string) => void;
  className?: string;
}) {
  const attention = projects.filter((project) => project.needsAttention).length;

  return (
    <Panel
      label="Where we are"
      className={cn('min-h-0', className)}
      bodyClassName="jx-scroll flex flex-col"
      right={
        <Link href="/portfolio" className="jx-label text-[var(--jx-cyan)] hover:underline">
          All {projectCount}
        </Link>
      }
    >
      {projects.length === 0 ? (
        <div className="p-3">
          <p className="text-sm text-[var(--jx-ink-dim)]">No projects yet.</p>
          <Link
            href="/projects/new"
            className="mt-2 inline-flex items-center gap-1 text-sm text-[var(--jx-cyan)] hover:underline"
          >
            Add the first one
            <ArrowRight className="h-3.5 w-3.5" aria-hidden />
          </Link>
        </div>
      ) : (
        <ul className="flex flex-col">
          {projects.map((project) => {
            const active = selected === project.id;
            return (
              <li
                key={project.id}
                className="border-b border-[color-mix(in_srgb,var(--jx-line)_35%,transparent)] last:border-b-0"
              >
                <div
                  className={cn(
                    'flex flex-col gap-1 px-3 py-2.5 transition-colors',
                    active ? 'bg-[color-mix(in_srgb,var(--jx-blue)_14%,transparent)]' : null,
                  )}
                >
                  <div className="flex items-start gap-2">
                    <button
                      type="button"
                      onClick={() => onSelect(project.id)}
                      aria-pressed={active}
                      className="min-w-0 flex-1 rounded-sm text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--jx-cyan)]"
                    >
                      <h3 className="truncate text-sm font-medium text-[var(--jx-ink)]">
                        {project.name}
                      </h3>
                      <p className="jx-label mt-0.5 truncate">
                        {project.statusLabel} · {project.freshnessLabel}
                      </p>
                    </button>
                    {project.needsAttention ? <Pill tone="amber">Needs you</Pill> : null}
                  </div>
                  {project.work ? (
                    <Link
                      href={`/missions/${project.work.missionId}`}
                      className="truncate text-xs text-[var(--jx-cyan)] hover:underline"
                    >
                      {project.work.title} · {project.work.state.replace(/_/g, ' ')}
                    </Link>
                  ) : null}
                  {active ? (
                    <Link
                      href={`/projects/${project.id}`}
                      className="inline-flex items-center gap-1 text-xs text-[var(--jx-ink-dim)] hover:text-[var(--jx-ink)] hover:underline"
                    >
                      Open {project.name}
                      <ArrowRight className="h-3 w-3" aria-hidden />
                    </Link>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <p className="jx-label mt-auto border-t border-[color-mix(in_srgb,var(--jx-line)_35%,transparent)] px-3 py-2">
        {projectCount} project{projectCount === 1 ? '' : 's'}
        {attention > 0 ? ` · ${attention} need${attention === 1 ? 's' : ''} you` : ' · all clear'}
      </p>
    </Panel>
  );
}

/* ------------------------------------------------------------------ the centre */

function CoreStage({
  state,
  statusLine,
  headline,
  activity,
  graphics,
  motion,
  levelSource,
  latest,
  listening,
  interim,
  micError,
  className,
}: {
  state: CoreState;
  statusLine: string;
  headline: string;
  activity: number;
  graphics: 'full' | 'lite';
  motion: boolean;
  levelSource?: () => number | null;
  latest: Turn | null;
  listening: boolean;
  interim: string;
  micError: string | null;
  className?: string;
}) {
  return (
    <section
      aria-label="Jarvis"
      className={cn(
        'relative flex min-h-0 flex-col items-center justify-center gap-4 py-2',
        className,
      )}
    >
      {/*
        The core takes whatever room is left after the words below it, rather than the other way
        round. On a 1366×768 laptop a core sized from the viewport width overflows its row and
        pushes the status line under the command dock — so the wrapper flexes, the core fills it,
        and the sentence that says what Jarvis is doing is the part that never moves.
      */}
      <div className="flex min-h-0 w-full flex-1 items-center justify-center">
        <JarvisCore
          state={state}
          activity={activity}
          graphics={graphics}
          motion={motion}
          {...(levelSource ? { levelSource } : {})}
          className="h-auto w-full max-w-[min(64vw,17rem)] sm:max-w-[min(56vw,22rem)] xl:h-full xl:w-auto xl:max-w-full"
        />
      </div>

      <div className="flex w-full max-w-2xl shrink-0 flex-col items-center gap-2 px-2 text-center">
        {/*
          The state, in words, for everyone who is not going to interpret a rotation speed — and
          for every screenshot, and for reduced motion, and for a screen reader.
        */}
        <p
          role="status"
          aria-live="polite"
          className="text-base font-medium text-[var(--jx-ink)] sm:text-lg"
        >
          {statusLine}
        </p>
        <p className="text-sm text-[var(--jx-ink-dim)]">{headline}</p>

        {listening ? (
          <p className="min-h-[1.5rem] text-sm text-[var(--jx-cyan)]" aria-live="polite">
            {interim.trim().length > 0 ? interim : 'The microphone is open.'}
          </p>
        ) : latest ? (
          <p
            className={cn(
              'max-h-24 overflow-y-auto text-sm',
              latest.who === 'you' ? 'text-[var(--jx-ink-faint)] italic' : 'text-[var(--jx-ink)]',
            )}
          >
            {latest.who === 'you' ? `“${latest.text}”` : latest.text}
            {latest.href ? (
              <>
                {' '}
                <Link href={latest.href} className="text-[var(--jx-cyan)] hover:underline">
                  Open
                </Link>
              </>
            ) : null}
          </p>
        ) : null}

        {micError ? <p className="text-xs text-[var(--jx-amber)]">{micError}</p> : null}
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ the right column */

function MattersPanel({
  actions,
  actionSummary,
  completions,
  focused,
  running,
  className,
}: {
  actions: readonly NextAction[];
  actionSummary: string;
  completions: readonly ScreenCompletion[];
  focused: ScreenProject | null;
  running: readonly { missionId: string; title: string; state: string }[];
  className?: string;
}) {
  return (
    <div className={cn('flex min-h-0 flex-col gap-3', className)}>
      <Panel
        label="What needs me"
        className="min-h-0 flex-1"
        bodyClassName="jx-scroll p-3"
        right={
          <Link href="/attention" className="jx-label text-[var(--jx-cyan)] hover:underline">
            All
          </Link>
        }
      >
        {focused ? (
          <p className="mb-2 rounded-sm border border-[color-mix(in_srgb,var(--jx-blue)_45%,transparent)] px-2 py-1 text-[0.6875rem] text-[var(--jx-ink-dim)]">
            Focused on <span className="text-[var(--jx-ink)]">{focused.name}</span>. This changes
            what is shown, not what a command does.
          </p>
        ) : null}

        {actions.length === 0 ? (
          <p className="text-sm text-[var(--jx-ink-dim)]">Nothing needs you right now.</p>
        ) : (
          <ol className="flex flex-col gap-2">
            {actions.map((action, index) => (
              <li key={action.id} className="flex gap-2 text-sm">
                <span className="jx-num text-[var(--jx-cyan)]">{index + 1}</span>
                <span className="flex min-w-0 flex-col">
                  <Link href={action.href} className="text-[var(--jx-ink)] hover:underline">
                    {action.label}
                  </Link>
                  <span className="text-xs text-[var(--jx-ink-faint)]">{action.detail}</span>
                </span>
              </li>
            ))}
          </ol>
        )}
        <p className="mt-2 text-[0.6875rem] text-[var(--jx-ink-faint)]">{actionSummary}</p>
      </Panel>

      <Panel label="Running now" className="min-h-0 shrink-0" bodyClassName="p-3">
        {running.length === 0 ? (
          <p className="text-sm text-[var(--jx-ink-dim)]">Nothing is running.</p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {running.slice(0, 4).map((entry) => (
              <li key={entry.missionId} className="text-sm">
                <Link href={`/missions/${entry.missionId}`} className="hover:underline">
                  {entry.title}
                </Link>
                <span className="ml-1 text-xs text-[var(--jx-ink-faint)]">
                  {entry.state.replace(/_/g, ' ')}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel
        label="Recently finished"
        className="min-h-0 shrink-0"
        bodyClassName="jx-scroll max-h-40 p-3"
      >
        {completions.length === 0 ? (
          <p className="text-sm text-[var(--jx-ink-dim)]">Nothing has finished yet.</p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {completions.map((entry) => (
              <li key={entry.id} className="text-sm">
                <Link href={entry.href} className="hover:underline">
                  {entry.title}
                </Link>
                <span className="ml-1 text-xs text-[var(--jx-ink-faint)]">{entry.detail}</span>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}

/* ------------------------------------------------------------------ the dock */

/**
 * Everything that sends something, and the capacity it will be spent from.
 *
 * ## Why "Stop speaking" is not the same control as anything else
 *
 * Stopping playback cancels an utterance and nothing else. Pausing Jarvis stops autonomous work
 * and lives on Operations, where it is a deliberate decision with an explanation beside it. They
 * are one press apart on some interfaces, which is how somebody silences a sentence and finds
 * their agents stopped an hour later. Here the dock only ever silences audio.
 */
function CommandDock({
  value,
  onChange,
  inputRef,
  busy,
  listening,
  speaking,
  supported,
  onSubmit,
  onSpeakSend,
  onStartListening,
  onStopListening,
  onSilence,
  onBrief,
  capacity,
  workerDetail,
  detail,
  voiceNote,
  turns,
  showHistory,
  onToggleHistory,
}: {
  value: string;
  onChange: (next: string) => void;
  inputRef: React.RefObject<HTMLInputElement | null>;
  busy: boolean;
  listening: boolean;
  speaking: boolean;
  supported: boolean;
  onSubmit: () => void;
  onSpeakSend: () => void;
  onStartListening: () => void;
  onStopListening: () => void;
  onSilence: () => void;
  onBrief: () => void;
  capacity: JarvisScreenProps['capacity'];
  workerDetail: string;
  /** The answer or briefing, rendered inside this region so one thing owns the conversation. */
  detail: React.ReactNode;
  /** Why there is no microphone button, when there is not. Null when there is one. */
  voiceNote: string | null;
  turns: readonly Turn[];
  showHistory: boolean;
  onToggleHistory: () => void;
}) {
  /*
   * Recover anything typed before this component came alive.
   *
   * The field is controlled, so React's hydration writes its empty initial state into the DOM and
   * whatever was typed in the gap is wiped. Reading the field on mount recovers it where it
   * survived; submitting reads the field rather than the state, which removes the whole class of
   * bug rather than narrowing the window in which it happens.
   */
  React.useEffect(() => {
    const typedBeforeHydration = inputRef.current?.value ?? '';
    if (typedBeforeHydration.length > 0) onChange(typedBeforeHydration);
    /* Once, on mount. Re-running this would fight the person typing. */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <section aria-label="Ask Jarvis" className="jx-panel shrink-0" data-testid="jarvis-dock">
      {/*
        Recent dialogue, folded away by default.

        The centre of the screen shows the last thing said and nothing more, because a growing
        transcript there would slowly cover the scene this redesign exists to show. Everything
        before it is one press away, in the region that already owns the conversation.
      */}
      {showHistory && turns.length > 0 ? (
        <ol
          data-testid="jarvis-history"
          className="jx-scroll max-h-48 border-b border-[color-mix(in_srgb,var(--jx-line)_45%,transparent)] p-3"
        >
          {turns.map((turn) => (
            <li
              key={turn.id}
              className={cn(
                'py-0.5 text-sm',
                turn.who === 'you'
                  ? 'text-[var(--jx-ink-faint)] italic'
                  : 'text-[var(--jx-ink-dim)]',
              )}
            >
              <span className="jx-label mr-2">{turn.who === 'you' ? 'You' : 'Jarvis'}</span>
              {turn.text}
            </li>
          ))}
        </ol>
      ) : null}

      {detail}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit();
        }}
        className="flex flex-wrap items-center gap-2 p-2.5"
      >
        <label htmlFor="jarvis-query" className="sr-only">
          Ask Jarvis about your projects
        </label>
        <input
          id="jarvis-query"
          ref={inputRef}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder="Where are we? · What needs me? · Do the first one · Remember that…"
          enterKeyHint="go"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          className="h-11 min-w-0 flex-1 basis-56 rounded-sm border border-[color-mix(in_srgb,var(--jx-line)_70%,transparent)] bg-[color-mix(in_srgb,var(--jx-void)_60%,transparent)] px-3 text-sm text-[var(--jx-ink)] outline-none placeholder:text-[var(--jx-ink-faint)] focus-visible:border-[var(--jx-blue)]"
        />

        {supported ? (
          <DockButton
            type="button"
            tone={listening ? 'alert' : 'quiet'}
            onClick={listening ? onStopListening : onStartListening}
            aria-pressed={listening}
            aria-label={listening ? 'Stop listening' : 'Speak to Jarvis'}
          >
            {listening ? (
              <Square className="h-4 w-4" aria-hidden />
            ) : (
              <Mic className="h-4 w-4" aria-hidden />
            )}
            <span className="hidden sm:inline">{listening ? 'Stop' : 'Speak'}</span>
          </DockButton>
        ) : null}

        {/*
          A spoken message and a typed one take different server paths — speech goes through the
          voice gate that refuses to treat words as approval — so the person is told which one
          they are sending rather than having it inferred from how the text got into the box.
        */}
        {supported && value.trim().length > 0 && !listening ? (
          <DockButton type="button" tone="quiet" onClick={onSpeakSend} disabled={busy}>
            Send as spoken
          </DockButton>
        ) : null}

        <DockButton type="submit" tone="primary" disabled={busy}>
          {busy ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
          ) : (
            <CornerDownLeft className="h-4 w-4" aria-hidden />
          )}
          Ask
        </DockButton>

        <DockButton type="button" tone="quiet" onClick={onBrief} disabled={busy}>
          Brief me
        </DockButton>

        {turns.length > 0 ? (
          <DockButton
            type="button"
            tone="quiet"
            onClick={onToggleHistory}
            aria-pressed={showHistory}
          >
            {showHistory ? 'Hide conversation' : 'Recent conversation'}
          </DockButton>
        ) : null}

        {speaking ? (
          <DockButton type="button" tone="quiet" onClick={onSilence} aria-label="Stop speaking">
            <VolumeX className="h-4 w-4" aria-hidden />
            Stop speaking
          </DockButton>
        ) : null}
      </form>

      <div className="flex flex-wrap items-end gap-x-6 gap-y-2 border-t border-[color-mix(in_srgb,var(--jx-line)_45%,transparent)] px-3 py-2">
        {capacity && capacity.applicable ? (
          capacity.windows.map((window) => (
            <CapacityDial
              key={window.label}
              label={window.label}
              percentUsed={window.percentUsed}
              quality={window.qualityLabel}
            />
          ))
        ) : (
          <p className="text-[0.6875rem] text-[var(--jx-ink-faint)]">
            {capacity
              ? `${capacity.authModeLabel} — no shared capacity window to report.`
              : 'Capacity is not available yet.'}
          </p>
        )}
        <p className="jx-label basis-full truncate sm:basis-auto">{workerDetail}</p>
        {voiceNote ? (
          <p className="basis-full text-[0.6875rem] text-[var(--jx-ink-faint)]">{voiceNote}</p>
        ) : null}
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ small parts */

const ELSEWHERE = [
  ['/portfolio', 'Portfolio'],
  ['/missions', 'Missions'],
  ['/ask', 'Ask Jarvis'],
  ['/changes', 'What changed'],
  ['/knowledge', 'What Jarvis knows'],
  ['/operations', 'Operations'],
  ['/workers', 'Workers'],
] as const;

function IconButton({
  label,
  onClick,
  pressed,
  children,
}: {
  label: string;
  onClick: () => void;
  pressed?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      aria-pressed={pressed}
      className={cn(
        'flex h-9 w-9 items-center justify-center rounded-sm border transition-colors',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--jx-cyan)]',
        pressed
          ? 'border-[var(--jx-blue)] bg-[color-mix(in_srgb,var(--jx-blue)_20%,transparent)] text-[var(--jx-cyan)]'
          : 'border-[color-mix(in_srgb,var(--jx-line)_70%,transparent)] text-[var(--jx-ink-dim)] hover:border-[var(--jx-blue)] hover:text-[var(--jx-ink)]',
      )}
    >
      {children}
    </button>
  );
}

function DockButton({
  tone,
  className,
  children,
  ...rest
}: { tone: 'primary' | 'quiet' | 'alert' } & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      {...rest}
      className={cn(
        'inline-flex h-11 items-center justify-center gap-1.5 rounded-sm border px-3 text-sm font-medium transition-colors disabled:opacity-60',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--jx-cyan)]',
        tone === 'primary'
          ? 'border-[var(--jx-blue)] bg-[color-mix(in_srgb,var(--jx-blue)_28%,transparent)] text-[var(--jx-ink)] hover:bg-[color-mix(in_srgb,var(--jx-blue)_40%,transparent)]'
          : tone === 'alert'
            ? 'border-[var(--jx-red)] bg-[color-mix(in_srgb,var(--jx-red)_22%,transparent)] text-[var(--jx-ink)]'
            : 'border-[color-mix(in_srgb,var(--jx-line)_70%,transparent)] text-[var(--jx-ink-dim)] hover:border-[var(--jx-blue)] hover:text-[var(--jx-ink)]',
        className,
      )}
    >
      {children}
    </button>
  );
}

function Choice({
  checked,
  onSelect,
  children,
}: {
  checked: boolean;
  onSelect: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={checked}
      className={cn(
        'rounded-sm border px-2 py-1 text-xs transition-colors',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--jx-cyan)]',
        checked
          ? 'border-[var(--jx-blue)] bg-[color-mix(in_srgb,var(--jx-blue)_22%,transparent)] text-[var(--jx-ink)]'
          : 'border-[color-mix(in_srgb,var(--jx-line)_70%,transparent)] text-[var(--jx-ink-dim)]',
      )}
    >
      {children}
    </button>
  );
}

/**
 * Hands-free, expressed as a component so the effect has one clear owner.
 *
 * It restarts recognition after a send has completely finished, never during one, and it still
 * only ever runs because somebody ticked the box. Nothing here opens a microphone on its own.
 */
function HandsFree({
  enabled,
  busy,
  listening,
  onListen,
}: {
  enabled: boolean;
  busy: boolean;
  listening: boolean;
  onListen: () => void;
}) {
  const wasBusy = React.useRef(false);
  React.useEffect(() => {
    const finished = wasBusy.current && !busy;
    wasBusy.current = busy;
    if (enabled && finished && !listening) onListen();
  }, [enabled, busy, listening, onListen]);
  return null;
}

function BriefingBody({ briefing }: { briefing: MorningBriefing }) {
  return (
    <div className="flex flex-col gap-3 text-sm">
      <p className="font-medium text-[var(--jx-ink)]">
        {briefing.greeting}. {briefing.headline}
      </p>
      <BriefingSection title="Since you last looked" lines={briefing.overnight} />
      <BriefingSection title="Waiting for you" lines={briefing.needsYou} />
      <BriefingSection title="Where things stand" lines={briefing.projects} />
      <p className="text-xs text-[var(--jx-ink-dim)]">{briefing.next}</p>
      {briefing.notConnected ? (
        <p className="text-xs text-[var(--jx-amber)]">{briefing.notConnected}</p>
      ) : null}
    </div>
  );
}

function BriefingSection({ title, lines }: { title: string; lines: MorningBriefing['overnight'] }) {
  if (lines.length === 0) return null;
  return (
    <div className="flex flex-col gap-0.5">
      <p className="jx-label">{title}</p>
      <ul className="flex flex-col gap-0.5">
        {lines.map((line, index) => (
          <li key={`${title}:${index}`} className="text-sm text-[var(--jx-ink-dim)]">
            {line.href ? (
              <Link href={line.href} className="hover:underline">
                {line.text}
              </Link>
            ) : (
              line.text
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * The briefing as one paragraph, for reading aloud.
 *
 * Shorter than what is on screen on purpose: a list is easy to skim and painful to listen to.
 */
function spokenBriefing(briefing: MorningBriefing): string {
  const waiting = briefing.needsYou.length;
  return [
    `${briefing.greeting}. ${briefing.headline}`,
    waiting === 0
      ? 'Nothing is waiting for you.'
      : `${waiting} thing${waiting === 1 ? '' : 's'} waiting for you.`,
    briefing.next,
  ].join(' ');
}
