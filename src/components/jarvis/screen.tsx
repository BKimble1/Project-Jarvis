'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  ArrowRight,
  CornerDownLeft,
  ExternalLink,
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
import { WorkDrawer } from '@/components/jarvis/work-drawer';
import { RelativeTime } from '@/components/relative-time';
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
  /** Which project it belongs to. Shown, because "what finished" is meaningless without it. */
  readonly projectName: string | null;
  /** What it was supposed to produce, in the words agreed when the work was authorised. */
  readonly deliverable: string | null;
  /**
   * A real pull request, or null.
   *
   * Never fabricated and never inferred from a branch name. A card that offers "View pull request"
   * when there is no pull request is worse than a card that offers nothing.
   */
  readonly pullRequestUrl: string | null;
  /** ISO, formatted in the browser — the server's clock must not reach the HTML. */
  readonly finishedAt: string | null;
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
  /** The raw operating mode, so the screen can tell "paused" from "supervised" without parsing a label. */
  readonly mode: string;
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
  /**
   * The standing proposal and the state of the question asked about it, read from the database.
   *
   * The thinking panel was pure client state, so a reload — or answering from a phone instead —
   * lost an in-flight evaluation even though the row was still queued and the worker still
   * answered it. These are how the screen finds its way back to a conversation it was already
   * having, which is the reconnection the owner asked for.
   */
  readonly standingProposal: { readonly id: string; readonly summary: string } | null;
  readonly standingThinking: ThinkingSnapshot | null;
  readonly standingEvaluation: ConversationEvaluation | null;
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
 * Reading answers aloud, remembered.
 *
 * Defaults to on for somebody who has never chosen, which is the opposite of what it did. A screen
 * meant to be worked through from across a room that says nothing until a setting is found is a
 * silent screen for everybody who never went looking.
 *
 * Stored as the string the owner chose rather than as "not off", so turning it off survives a
 * reload — a default-on preference that cannot be turned off permanently is worse than one that
 * starts silent.
 */
const READ_ALOUD_KEY = 'jarvis-read-aloud';

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
  const [showStatus, setShowStatus] = React.useState(false);
  /** The mission whose drawer is open, or null. One at a time, by design. */
  const [openWorkId, setOpenWorkId] = React.useState<string | null>(null);
  const [graphics, setGraphics] = React.useState<'full' | 'lite'>('full');
  const [motion, setMotion] = React.useState(true);
  const [readBack, setReadBack] = React.useState(true);
  const [handsFree, setHandsFree] = React.useState(false);
  /*
   * Open on arrival when there is a standing question or a standing assessment.
   *
   * Reconnecting to a conversation and then hiding it behind a closed drawer would be the same
   * failure in a politer form.
   */
  const [expanded, setExpanded] = React.useState(
    props.standingThinking !== null || props.standingEvaluation !== null,
  );
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
  /**
   * Whether what is in the composer arrived through the microphone.
   *
   * ## Why one Send needs this
   *
   * The dock used to carry two: "Ask", and "Send as spoken". They are genuinely different — speech
   * goes through the voice gate, which refuses to treat spoken words as approval — so the second
   * button was not decoration, and deleting it to satisfy "one Send" would have quietly removed a
   * required authorisation step.
   *
   * So the routing follows the words instead of the button. A transcript lands in the composer as
   * an editable draft, and that draft stays *spoken* while it is edited: correcting what was heard
   * is still answering by voice, and downgrading it on the first keystroke would be exactly the
   * silent removal being avoided. Typing from scratch is typing, and takes the ordinary path.
   */
  const [fromMic, setFromMic] = React.useState(false);
  /*
   * The thing Jarvis last offered to do, kept so "go ahead" means something.
   *
   * Held here rather than on the server because it is a property of *this* conversation, and
   * because the server must not be able to decide what the person was looking at when they
   * answered. It is sent back with the next message and re-read there through every gate a typed
   * sentence goes through, so it supplies the subject of a yes, never the permission for one.
   */
  const [proposal, setProposal] = React.useState<{ id: string; summary: string } | null>(
    props.standingProposal,
  );
  /*
   * The structured half of an idea assessment.
   *
   * The spoken line carries the verdict; this carries the parts that are worth *reading* — the
   * V1, the assumptions, and the questions Blake is being asked. Putting the questions only in
   * speech would mean the one thing he has to answer scrolls past and is gone.
   */
  const [evaluation, setEvaluation] = React.useState<ConversationEvaluation | null>(
    props.standingEvaluation,
  );
  const [thinking, setThinking] = React.useState<ThinkingSnapshot | null>(props.standingThinking);

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
      const storedAloud = window.localStorage.getItem(READ_ALOUD_KEY);
      /* Only an explicit "off" turns it off. Anything else — including nothing — leaves it on. */
      if (storedAloud === 'off') setReadBack(false);

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
  /*
   * Shown whenever the current question has no answer yet — not merely when no assessment happens
   * to be in state. Those are different conditions, and conflating them is what let an old verdict
   * sit on screen while a new request was pending behind it.
   *
   * And while it is shown, the assessment panel is not. A pending or failed request beside a
   * verdict from an earlier one reads as though the verdict is the answer to what was just asked,
   * which is exactly the confusion this whole path exists to avoid. One state at a time, and the
   * current one wins.
   */
  const pendingThought = thinking && thinking.state !== 'ready' ? thinking : null;

  /**
   * Wait for the worker to finish thinking, and say so while it does.
   *
   * ## Why the browser polls rather than the request blocking
   *
   * Because the model is not here. It runs on Blake's worker, on his Claude subscription, and the
   * answer comes back through the control plane seconds or minutes later. Holding the POST open
   * for that would tie a browser request to another machine's availability: close the tab, lose
   * the network, redeploy the control plane, and the answer is gone. Polling a row means none of
   * those lose it.
   *
   * ## Why it stops on its own
   *
   * `blocked` and `ready` are both ends. A question that cannot be answered right now says why —
   * no worker, no runtime, no capacity — and the poll stops rather than spinning against a
   * condition that needs Blake to change something. The row stays queued either way, so starting
   * the worker later finishes the thought without him asking again.
   */
  React.useEffect(() => {
    if (thinking?.state !== 'thinking' && thinking?.state !== 'blocked') return;
    const requestId = thinking.requestId;
    let cancelled = false;

    /*
     * A blocked question is watched too, just slowly.
     *
     * The poll used to stop outright on `blocked`, which left the screen saying "no worker" for
     * ever — including after the worker started. The row stays queued and really is answered
     * later, so the copy's promise that the question "will be answered without you asking again"
     * was true of the database and false of the screen. Watching it at a much longer interval
     * costs one request a quarter-minute and makes the promise true in both places.
     */
    const period = thinking.state === 'blocked' ? BLOCKED_POLL_MS : THINKING_POLL_MS;

    const timer = setInterval(() => {
      void (async () => {
        try {
          const response = await fetch(
            `/api/conversation/thinking?request=${encodeURIComponent(requestId)}`,
          );
          if (!response.ok || cancelled) return;
          const body = (await response.json()) as { thinking: ThinkingSnapshot };
          if (cancelled || body.thinking.state === 'thinking') return;
          /* Still blocked for the same reason is not news, and must not re-announce itself. */
          if (body.thinking.state === 'blocked' && thinking.state === 'blocked') return;

          setThinking(body.thinking);
          if (body.thinking.state === 'ready') {
            setEvaluation(body.thinking.evaluation);
            setExpanded(true);
            say(body.thinking.evaluation.verdict, null);
          } else {
            say(body.thinking.detail, null);
          }
        } catch {
          /* A missed poll is not news. The next one will say the same thing or a better one. */
        }
      })();
    }, period);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
    /* `say` is stable for the life of the screen; re-subscribing on it would restart the timer. */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [thinking]);

  /**
   * Ask again after a failure, on the same proposal.
   *
   * Only offered when the server says a retry would do something — the ceiling lives there, so the
   * button cannot become a loop. On success the panel goes back to thinking and the poller above
   * picks the answer up; on refusal the sentence explains why rather than doing nothing visible.
   */
  async function retryThinking(requestId: string) {
    try {
      const response = await fetch('/api/conversation/thinking/retry', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ request: requestId }),
      });
      if (!response.ok) {
        say('That question cannot be tried again right now.', null);
        return;
      }
      const body = (await response.json()) as { thinking: ThinkingSnapshot };
      setThinking(body.thinking);
      setEvaluation(null);
      setExpanded(true);
    } catch {
      say('I could not reach the control plane to try that again.', null);
    }
  }

  async function askJarvis(text: string) {
    setBusy(true);
    try {
      const response = await fetch('/api/conversation', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          message: text,
          context: {
            actions: props.actions.map((action) => ({ id: action.id, label: action.label })),
            proposal,
            lastJarvisTurn: turns[turns.length - 1]?.text ?? null,
          },
        }),
      });
      if (!response.ok) throw new Error('no answer');
      const turn = (await response.json()) as {
        said: string;
        href: string | null;
        answer: QueryAnswer | null;
        started: { missionId: string } | null;
        proposal: { id: string; summary: string } | null;
        evaluation: ConversationEvaluation | null;
        thinking: ThinkingSnapshot | null;
        notes: readonly string[];
      };

      setAnswer(turn.answer);
      setAsked(text);
      setBriefing(null);
      /*
       * Open for anything there is to show.
       *
       * This was `turn.answer !== null`, and an `idea` turn always answers null — the assessment
       * arrives from the worker seconds or minutes later. So the one turn that most needs the
       * drawer, the one where Jarvis says "I am thinking about it", was the one turn that never
       * opened it: the spoken line promised the words were on screen and nothing was.
       */
      setExpanded(turn.answer !== null || turn.thinking !== null || turn.evaluation !== null);
      /*
       * Carried forward only while there is something to say yes to. Clearing it on every other
       * turn is what stops a "go ahead" said ten minutes later from accepting something the person
       * has long since stopped thinking about.
       */
      setProposal(turn.proposal);
      /*
       * Cleared together, always. An idea turn that is thinking or blocked has *no* assessment yet,
       * and leaving the previous one on screen is how a live QuickPick spent weeks showing a
       * verdict from a path that no longer exists. The current request's state is the truth.
       */
      setEvaluation(turn.evaluation ?? null);
      setThinking(turn.thinking ?? null);
      if (turn.started) {
        markCompleted();
        router.refresh();
      }
      say(turn.notes.length > 0 ? `${turn.said} ${turn.notes.join(' ')}` : turn.said, turn.href);
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
    /*
     * The routing was decided by the caller from the origin of these words. Once they are gone the
     * composer is empty and holding nothing that was heard, so the next thing typed into it is
     * typed, not spoken.
     */
    setFromMic(false);

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

    /*
     * A yes to something Jarvis offered goes to the server, not to the list reader.
     *
     * `interpretReply` reads a bare "go ahead" against a list of *actions*, and with none showing
     * it calls that "continue" — carry on with what is running. That is right when there is nothing
     * on offer and wrong the moment there is: an idea Jarvis has just proposed is exactly the thing
     * "go ahead" means, and sending it to the running-mission branch would answer a different
     * question. The proposal wins while it is standing.
     */
    if (proposal && (intent.kind === 'continue' || intent.kind === 'ambiguous')) {
      setReply('');
      await askJarvis(text);
      return;
    }

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

  /**
   * Say what has happened since the last time anything was said.
   *
   * ## Why the server decides what is unspoken
   *
   * Because a browser cannot. Two tabs are two browsers, and a refresh is a third with no memory of
   * the other two — so any list of "already spoken" kept in the page is lost by exactly the event
   * this requirement is about. The claim endpoint returns only the rows whose `spoken_at` this
   * request won, so what comes back is safe to speak without asking whether it already was.
   *
   * Nothing is claimed while read-aloud is off or while the microphone is open: claiming marks a
   * sentence spoken, and marking one spoken without speaking it loses it for good.
   */
  React.useEffect(() => {
    if (!mounted || !readBack || listening) return;
    let cancelled = false;

    const say = async () => {
      try {
        const response = await fetch('/api/operating/events', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ limit: 3 }),
        });
        if (!response.ok || cancelled) return;
        const body = (await response.json()) as {
          events: readonly { id: string; message: string }[];
        };
        for (const event of body.events) {
          if (cancelled) break;
          /* The words in the transcript and the words spoken are the same string, stored once. */
          setTurns((current) => [
            ...current,
            { id: Date.now() + Math.random(), who: 'jarvis', text: event.message },
          ]);
          speech.speak(event.message);
        }
      } catch {
        /* A missed round says the same thing a moment later. The rows are still unspoken. */
      }
    };

    void say();
    const timer = setInterval(() => void say(), NARRATION_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
    /* `speech` is stable for the life of the screen; re-subscribing on it would restart the timer. */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mounted, readBack, listening]);

  /* What was recognised becomes an editable draft in the same box everything else is typed in. */
  React.useEffect(() => {
    if (speech.phase === 'idle' && speech.transcript.trim().length > 0) {
      setReply((current) => {
        if (current.length > 0) return current;
        setFromMic(true);
        return speech.transcript.trim();
      });
      mic.release();
    }
  }, [speech.phase, speech.transcript, mic]);

  const startListening = () => {
    bind();
    /*
     * Silence Jarvis before opening the microphone.
     *
     * Without this the microphone hears the speakers and transcribes Jarvis's own sentence back
     * into the box — which reads as the machine talking to itself, and in hands-free mode is a
     * genuine loop: it answers, hears the answer, and answers that. Cancelling playback first is
     * the whole fix, and it is the right behaviour anyway: pressing Speak means "I would like to
     * say something now", which is a reason to stop talking.
     */
    speech.silence();
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

  /*
   * Three different bad states, told apart.
   *
   * `failing` used to be folded into `disconnected`, which reported a loop whose last pass errored
   * as though nothing were connected at all. They need different words and a different recovery,
   * so they are now different states.
   */
  const disconnected = !props.workerReady || props.loopState === 'stalled';
  const failing = props.loopState === 'failing';
  const paused = props.mode === 'paused' || props.mode === 'emergency_stop';
  const needsOwner = props.actions.some((action) => action.requiresOwner);

  const state: CoreState = coreState({
    listening,
    thinking: busy,
    speaking,
    workingCount: props.running.length,
    needsOwner,
    /*
     * Capacity only. Supervised is a setting, not a restriction: including it here painted every
     * healthy supervised screen amber, which is the one thing the palette must not do.
     */
    limited: props.capacityWithheld,
    paused,
    failed: failing,
    disconnected,
    justCompleted,
  });

  const statusLine = coreStatusLine(state, {
    workingCount: props.running.length,
    waitingCount: props.actions.filter((action) => action.requiresOwner).length,
    limitReason: props.capacityReason,
    disconnectedReason: !props.workerReady ? props.workerDetail : props.loopExplanation,
    pausedReason: props.blockedReason,
    failedReason: props.loopExplanation,
  });

  const tone = CORE_STATE_TONE[state];

  /*
   * One sentence about the system, and a count of what is unresolved.
   *
   * Deliberately about the *deployment* rather than about the conversation: the core already says
   * what Jarvis is doing this second, and repeating it here is what produced four pills saying one
   * thing. This answers the different question — can it do anything at all, and how many things
   * are standing in the way.
   *
   * Supervised is not counted. It is a setting the owner chose, and an issue count that includes
   * the owner's own preferences is a count nobody reads twice.
   */
  const issues: readonly string[] = [
    !props.workerReady ? props.workerDetail : null,
    props.loopState === 'stalled' || props.loopState === 'failing' ? props.loopExplanation : null,
    props.capacityWithheld ? (props.capacityReason ?? 'Capacity is being withheld.') : null,
  ].filter((issue): issue is string => issue !== null);
  const issueCount = issues.length;

  const systemLabel = !props.workerReady
    ? 'No worker'
    : props.loopState === 'stalled'
      ? 'Loop stopped'
      : props.loopState === 'failing'
        ? 'Loop failing'
        : props.capacityWithheld
          ? 'Holding back'
          : paused
            ? 'Paused'
            : 'All clear';
  const systemTone =
    !props.workerReady || props.loopState === 'stalled' || props.loopState === 'failing'
      ? 'red'
      : props.capacityWithheld
        ? 'amber'
        : 'green';

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

          {/*
            One mode control and one status indicator.

            There used to be four pills here, and on a default install they said "Off", "No
            worker", "Autonomy off" and "No mission running" — which is the same fact four times,
            in four colours, above a banner that said two of them again and a status line under the
            core that said them a third time. The count of ways to learn one thing is not a measure
            of how well it is communicated.

            The mode is a link to the control that changes it rather than a new control; the status
            is a button that opens the detail, so the whole readiness picture stays one press away
            instead of occupying the top of the screen permanently.
          */}
          <div className="order-last flex min-w-0 basis-full flex-wrap items-center gap-2 xl:order-none xl:basis-auto">
            <Link
              href="/operations"
              title={props.modeMeaning}
              className="rounded-full border border-[color-mix(in_srgb,var(--jx-line)_75%,transparent)] px-2.5 py-1 text-[0.6875rem] tracking-[0.08em] text-[var(--jx-ink-dim)] uppercase transition-colors hover:border-[var(--jx-blue)] hover:text-[var(--jx-ink)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--jx-cyan)]"
            >
              {props.modeLabel}
            </Link>

            <button
              type="button"
              onClick={() => setShowStatus((open) => !open)}
              aria-expanded={showStatus}
              aria-controls="jx-status-details"
              className="flex items-center gap-2 rounded-full border border-[color-mix(in_srgb,var(--jx-line)_75%,transparent)] px-2.5 py-1 text-[0.75rem] text-[var(--jx-ink-dim)] transition-colors hover:border-[var(--jx-blue)] hover:text-[var(--jx-ink)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--jx-cyan)]"
            >
              <span
                aria-hidden
                className="h-2 w-2 rounded-full"
                style={{ background: `var(--jx-${systemTone})` }}
              />
              <span>{systemLabel}</span>
              {issueCount > 0 ? (
                <span className="rounded-full bg-[color-mix(in_srgb,var(--jx-amber)_22%,transparent)] px-1.5 text-[0.6875rem] font-semibold text-[var(--jx-amber)]">
                  {issueCount}
                </span>
              ) : null}
            </button>
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
                  onChange={(event) => {
                    const next = event.target.checked;
                    setReadBack(next);
                    try {
                      window.localStorage.setItem(READ_ALOUD_KEY, next ? 'on' : 'off');
                    } catch {
                      /* A preference that cannot be stored still applies for this session. */
                    }
                  }}
                />
                Read answers aloud
              </label>
              {readBack && mounted ? (
                <p className="basis-full text-[0.6875rem] text-[var(--jx-ink-faint)]">
                  {speech.voiceChoice.explanation}
                </p>
              ) : null}
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
          The readiness detail, on request.

          It used to be a permanent full-width two-tile banner between the strip and the columns,
          restating the worker fact the pill above had already given. The fact itself has not moved
          further away — it is in the status indicator, which is on screen before anything scrolls —
          but the diagnostics behind it now open when they are asked for.
        */}
        {showStatus ? (
          <div id="jx-status-details" className="shrink-0">
            <ReadinessStrip readiness={props.readiness} />
            <p className="mt-2 text-[0.75rem] text-[var(--jx-ink-dim)]">{props.modeMeaning}</p>
          </div>
        ) : null}

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
            completions={props.completions}
            focused={focusedProject}
            running={props.running}
          />

          {openWorkId ? (
            <div className="xl:col-start-1 xl:row-start-2">
              <WorkDrawer
                missionId={openWorkId}
                onClose={() => {
                  setOpenWorkId(null);
                  /*
                   * Focus goes back where it was typed from.
                   *
                   * Closing a drawer used to drop focus onto the document, which for anyone
                   * navigating by keyboard means starting again at the top of the screen.
                   */
                  inputRef.current?.focus();
                }}
              />
            </div>
          ) : null}

          <ProjectRail
            className="xl:col-start-1 xl:row-start-1"
            projects={props.projects}
            projectCount={props.projectCount}
            selected={selected}
            onSelect={(id) => setSelected((current) => (current === id ? null : id))}
            onOpenWork={(missionId) =>
              setOpenWorkId((current) => (current === missionId ? null : missionId))
            }
            openWorkId={openWorkId}
          />
        </div>

        {/* ------------------------------------------------------------ the dock */}
        <CommandDock
          value={reply}
          onChange={(next) => {
            bind();
            setReply(next);
            /* Cleared by hand means the transcript is gone, and with it the reason to gate it. */
            if (next.trim().length === 0) setFromMic(false);
          }}
          inputRef={inputRef}
          busy={busy}
          listening={listening}
          speaking={speaking}
          supported={mounted && speech.supported}
          onSubmit={() => {
            const typed = inputRef.current?.value ?? reply;
            void send(typed, fromMic);
          }}
          spoken={fromMic}
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
            expanded && (answer || briefing || evaluation || pendingThought) ? (
              <div className="jx-scroll max-h-[28vh] border-b border-[color-mix(in_srgb,var(--jx-line)_45%,transparent)]">
                <div className="flex items-center justify-between px-3 pt-2">
                  <p className="jx-label">
                    {briefing
                      ? 'Briefing'
                      : evaluation
                        ? 'What I make of it'
                        : pendingThought
                          ? 'Thinking'
                          : 'Answer'}
                  </p>
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
                {pendingThought ? (
                  <ThinkingBody
                    thinking={pendingThought}
                    onRetry={(id) => void retryThinking(id)}
                  />
                ) : null}
                {evaluation && !pendingThought ? <EvaluationBody evaluation={evaluation} /> : null}
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
        speaking={speaking}
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
  onOpenWork,
  openWorkId,
  className,
}: {
  projects: readonly ScreenProject[];
  projectCount: number;
  selected: string | null;
  onSelect: (id: string) => void;
  onOpenWork: (missionId: string) => void;
  openWorkId: string | null;
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
                    /*
                      Opens the drawer rather than leaving the screen.

                      The row used to be a link to the mission page, which answered "what is it
                      doing" by navigating away from the screen the owner was watching it from.
                      The drawer keeps the core, the conversation and the composer where they are.
                    */
                    <button
                      type="button"
                      onClick={() => onOpenWork(project.work!.missionId)}
                      aria-expanded={openWorkId === project.work.missionId}
                      className="truncate rounded-sm text-left text-xs text-[var(--jx-cyan)] hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--jx-cyan)]"
                    >
                      {project.work.title} · {project.work.state.replace(/_/g, ' ')}
                    </button>
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
        A diameter with a floor and a ceiling, rather than whatever was left over.

        The core used to be capped at 272px below `xl` and then sized purely by leftover row height
        above it — about 300px on a 1366×768 laptop and well past 600px on a 1920×1080 monitor. The
        same interface therefore had a small, apologetic core on the machine it is used on and an
        overbearing one on the machine it is watched on.

        `clamp` gives it the band it was asked for: 48vh is 369px at 768 tall and 518px at 1080,
        which the 30rem ceiling brings back to 480. The 72vw term is what keeps it sane on a phone,
        and the 14rem floor is what stops it collapsing in a short landscape window.
      */}
      <div className="flex min-h-0 w-full flex-1 items-center justify-center">
        <JarvisCore
          state={state}
          activity={activity}
          graphics={graphics}
          motion={motion}
          {...(levelSource ? { levelSource } : {})}
          className="h-auto w-[clamp(14rem,min(72vw,48vh),30rem)] max-w-full"
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
          /*
            Clamped, not scrollable.

            A 96px-tall scroll region under the core is one of the nested scrollbars the redesign is
            meant to remove: it puts a second, hidden scroll axis inside the one panel that must
            stay whole. Two lines here, and the full exchange in the dock's history where there is
            room to read it.
          */
          <p
            className={cn(
              'line-clamp-2 text-sm',
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
  completions,
  focused,
  running,
  className,
}: {
  actions: readonly NextAction[];
  completions: readonly ScreenCompletion[];
  focused: ScreenProject | null;
  running: readonly { missionId: string; title: string; state: string }[];
  className?: string;
}) {
  /*
   * One decision, then the rest.
   *
   * The owner asked for "one focused card with its relevant choices" rather than a numbered list of
   * everything at once. The first thing genuinely requiring a person is that card; anything else
   * that needs them is listed under it, quietly, so nothing is hidden and nothing shouts.
   */
  const decision = actions.find((action) => action.requiresOwner) ?? null;
  const rest = actions.filter((action) => action.id !== decision?.id);

  return (
    <div className={cn('flex min-h-0 flex-col gap-3', className)}>
      {focused ? (
        <p className="shrink-0 rounded-sm border border-[color-mix(in_srgb,var(--jx-blue)_45%,transparent)] px-2 py-1 text-[0.6875rem] text-[var(--jx-ink-dim)]">
          Focused on <span className="text-[var(--jx-ink)]">{focused.name}</span>. This changes what
          is shown, not what a command does.
        </p>
      ) : null}

      {/* ---------------------------------------------------------- the decision */}
      {decision ? (
        <section
          aria-label="Needs a decision"
          className="shrink-0 rounded-sm border border-[color-mix(in_srgb,var(--jx-amber)_55%,transparent)] bg-[color-mix(in_srgb,var(--jx-amber)_8%,transparent)] p-3"
        >
          <p className="jx-label text-[var(--jx-amber)]">Needs a decision</p>
          <p className="mt-1 text-sm text-[var(--jx-ink)]">{decision.label}</p>
          <p className="mt-0.5 text-xs text-[var(--jx-ink-dim)]">{decision.detail}</p>
          <Link
            href={decision.href}
            className="mt-2 inline-flex min-h-11 items-center text-sm text-[var(--jx-cyan)] hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--jx-cyan)]"
          >
            Open it
          </Link>
        </section>
      ) : (
        /*
         * Calm, and one line of it.
         *
         * This used to be a flex-1 framed panel holding a single negative sentence, stretched to
         * the full height of the column — an empty box the size of the work it was reporting the
         * absence of.
         */
        <p className="shrink-0 text-sm text-[var(--jx-ink-dim)]">Nothing needs you.</p>
      )}

      {rest.length > 0 ? (
        <Panel label="Also waiting" className="min-h-0 shrink-0" bodyClassName="p-3">
          <ol className="flex flex-col gap-2">
            {rest.map((action, index) => (
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
        </Panel>
      ) : null}

      {/* ---------------------------------------------------------- what is running */}
      {running.length > 0 ? (
        <Panel label="Running now" className="min-h-0 shrink-0" bodyClassName="p-3">
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
        </Panel>
      ) : null}

      {/* ---------------------------------------------------------- what it produced */}
      {completions.length > 0 ? (
        <section aria-label="Results" className="flex min-h-0 flex-col gap-2">
          <p className="jx-label shrink-0 text-[var(--jx-ink-faint)]">Results</p>
          <ul className="flex flex-col gap-2">
            {completions.slice(0, 4).map((entry) => (
              <li
                key={entry.id}
                className="rounded-sm border border-[color-mix(in_srgb,var(--jx-line)_70%,transparent)] bg-[color-mix(in_srgb,var(--jx-panel)_60%,transparent)] p-2.5"
              >
                {entry.projectName ? (
                  <p className="jx-label truncate text-[var(--jx-cyan)]">{entry.projectName}</p>
                ) : null}
                <Link
                  href={entry.href}
                  className="mt-0.5 block truncate text-sm text-[var(--jx-ink)] hover:underline"
                >
                  {entry.title}
                </Link>
                {entry.deliverable ? (
                  <p className="mt-0.5 line-clamp-2 text-xs text-[var(--jx-ink-dim)]">
                    {entry.deliverable}
                  </p>
                ) : null}
                <p className="mt-1 flex flex-wrap items-center gap-x-3 text-[0.6875rem] text-[var(--jx-ink-faint)]">
                  <span>{entry.detail}</span>
                  {entry.finishedAt ? <RelativeTime iso={entry.finishedAt} /> : null}
                </p>
                {/*
                  A real action, or none.

                  `pullRequestUrl` is a row the worker wrote after GitHub answered, so the button is
                  offered only where one genuinely exists. There is deliberately no Preview and no
                  screenshot here: artifacts in this system are text, and inventing a preview URL to
                  fill the card is the kind of thing that makes a draft PR look like a deployment.
                */}
                {entry.pullRequestUrl ? (
                  <a
                    href={entry.pullRequestUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="mt-1.5 inline-flex min-h-11 items-center gap-1 text-xs text-[var(--jx-cyan)] hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--jx-cyan)]"
                  >
                    View pull request
                    <ExternalLink className="h-3 w-3" aria-hidden />
                  </a>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
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
  spoken,
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
  /** True when the composer is holding words that arrived through the microphone. */
  spoken: boolean;
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
          One Send, and it says which path it will take.

          A spoken message and a typed one still reach different server paths — speech goes through
          the voice gate that refuses to treat words as approval — but which one is a fact about
          where the words came from, not a choice to put to the person mid-sentence. So the button
          reads the origin and labels itself, and the person is still told, which was the whole
          point of having had two.
        */}
        <DockButton type="submit" tone="primary" disabled={busy}>
          {busy ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
          ) : (
            <CornerDownLeft className="h-4 w-4" aria-hidden />
          )}
          {spoken ? 'Send as spoken' : 'Send'}
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

        {/*
          The way into the full workspace.

          Asking folded into this dock, and the standalone page stopped being a rail destination —
          but it did not stop being the place a long answer is read with its citations, its earlier
          questions and a readable width. The dock is where a conversation happens; that page is
          where one is studied. Without this link the second was reachable only by typing its URL.
        */}
        <Link
          href="/ask"
          className="inline-flex min-h-11 items-center rounded-sm px-2.5 text-xs text-[var(--jx-ink-dim)] transition-colors hover:text-[var(--jx-ink)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--jx-cyan)]"
        >
          Full conversation
        </Link>

        {speaking ? (
          <DockButton type="button" tone="quiet" onClick={onSilence} aria-label="Stop speaking">
            <VolumeX className="h-4 w-4" aria-hidden />
            Stop speaking
          </DockButton>
        ) : null}
      </form>

      <div className="flex flex-wrap items-end gap-x-6 gap-y-2 border-t border-[color-mix(in_srgb,var(--jx-line)_45%,transparent)] px-3 py-2">
        {/*
          Three dials, or one sentence.

          The dials were honest about each value — "—" and "Not measured", never a fabricated 0% —
          but drawing three of them for a subscription that reports no window at all is a picture of
          instrumentation rather than of usage. When nothing is measured, the screen now says so
          once, in the words the owner asked for, and keeps the space.
        */}
        {(() => {
          const measured =
            capacity && capacity.applicable
              ? capacity.windows.filter((window) => window.percentUsed !== null)
              : [];
          if (measured.length > 0) {
            return measured.map((window) => (
              <CapacityDial
                key={window.label}
                label={window.label}
                percentUsed={window.percentUsed}
                quality={window.qualityLabel}
              />
            ));
          }
          return (
            <p className="text-[0.6875rem] text-[var(--jx-ink-faint)]">
              {capacity && capacity.applicable
                ? 'Usage unavailable · one task at a time'
                : capacity
                  ? `${capacity.authModeLabel} — no shared capacity window to report.`
                  : 'Capacity is not available yet.'}
            </p>
          );
        })()}
        <p className="jx-label basis-full truncate sm:basis-auto">{workerDetail}</p>
        {voiceNote ? (
          <p className="basis-full text-[0.6875rem] text-[var(--jx-ink-faint)]">{voiceNote}</p>
        ) : null}
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ small parts */

/**
 * Where else to go, from the screen a phone lands on.
 *
 * The same five destinations the rail carries, deliberately. This used to be a hand-kept second
 * copy of a thirteen-item list that had to be updated in step with two others; a list of five that
 * matches the rail exactly is one an owner can check at a glance instead of one that silently rots.
 */
const ELSEWHERE = [
  ['/work', 'Work'],
  ['/knowledge', 'Knowledge'],
  ['/connections', 'Connections'],
  ['/operations', 'Operations'],
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
        /* 44px: the touch target the accessibility pass asks for, not the 36px it was. */
        'flex h-11 w-11 items-center justify-center rounded-sm border transition-colors',
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
  speaking,
  onListen,
}: {
  enabled: boolean;
  busy: boolean;
  listening: boolean;
  speaking: boolean;
  onListen: () => void;
}) {
  const wasBusy = React.useRef(false);
  React.useEffect(() => {
    const finished = wasBusy.current && !busy;
    wasBusy.current = busy;
    /*
     * Not while Jarvis is still speaking. Re-opening the microphone during the read-back is how
     * hands-free turns into a machine transcribing itself, so the restart waits for silence — and
     * because `speaking` is a state this component already receives, waiting costs nothing but an
     * extra term in the condition.
     */
    if (enabled && finished && !listening && !speaking) onListen();
  }, [enabled, busy, listening, speaking, onListen]);
  return null;
}

function BriefingBody({ briefing }: { briefing: MorningBriefing }) {
  return (
    <div className="flex flex-col gap-3 text-sm">
      <p className="font-medium text-[var(--jx-ink)]">
        {briefing.greeting}. {briefing.headline}
      </p>
      <BriefingSection title="On today" lines={briefing.yourDay} />
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
    /*
     * Only when something was actually read. An empty day section means Jarvis did not look, not
     * that the day is clear, and "nothing on today" is precisely the sentence it must not say.
     */
    ...(briefing.yourDay.length > 0 ? [`On today: ${briefing.yourDay[0]!.text}`] : []),
    waiting === 0
      ? 'Nothing is waiting for you.'
      : `${waiting} thing${waiting === 1 ? '' : 's'} waiting for you.`,
    briefing.next,
  ].join(' ');
}

/** How often the browser asks whether the worker has finished thinking. */
const THINKING_POLL_MS = 2000;
/**
 * How often the screen asks whether there is anything new to say.
 *
 * Slower than the thinking poll, because these are sentences a person listens to rather than a
 * spinner they watch, and a narrator that interrupts itself every two seconds is not company.
 */
const NARRATION_POLL_MS = 6000;
/*
 * How often a blocked question is re-checked.
 *
 * Long, because nothing about it changes until a person starts a worker or capacity returns, and
 * short enough that when they do the screen notices without being reloaded.
 */
const BLOCKED_POLL_MS = 15_000;

/**
 * Where a question put to the worker has got to.
 *
 * Structural rather than imported: components may not import from `@/server`, and this is the
 * shape that arrives over the wire from `ReasoningService`.
 */
export type ThinkingSnapshot =
  | {
      readonly state: 'thinking';
      readonly requestId: string;
      readonly since: string;
      readonly detail: string;
    }
  | {
      readonly state: 'ready';
      readonly requestId: string;
      readonly evaluation: ConversationEvaluation;
    }
  | {
      readonly state: 'blocked';
      readonly requestId: string;
      readonly reason: string;
      readonly detail: string;
      readonly retryable: boolean;
      readonly canRetry: boolean;
    };

/** The structured half of an idea assessment, laid out to be read rather than heard. */
export interface ConversationEvaluation {
  readonly likelyUser: string;
  readonly problem: string;
  readonly verdict: string;
  readonly smallestV1: readonly string[];
  readonly assumptions: readonly string[];
  readonly uncertainties: readonly string[];
  readonly questions: readonly string[];
  readonly basis: 'reasoned' | 'not_assessed';
}

/**
 * The honest half-second — or half-minute — between asking and knowing.
 *
 * This panel exists because the alternative is a spinner, and a spinner says nothing about *why*
 * you are waiting. Waiting for a worker that is running the question on your own Claude
 * subscription is a different thing from waiting for a worker that is not running at all, and the
 * second one needs you to go and start it.
 *
 * A blocked state is not an error page. The question is still queued — that is what `retryable`
 * says — so the note tells Blake what to change and promises that the answer will arrive without
 * him asking again.
 */
function ThinkingBody({
  thinking,
  onRetry,
}: {
  thinking: ThinkingSnapshot;
  onRetry: (requestId: string) => void;
}) {
  if (thinking.state === 'ready') return null;
  const blocked = thinking.state === 'blocked';
  return (
    <div className="p-3" data-thinking={thinking.state}>
      <p className="jx-label">{blocked ? 'Not thinking yet' : 'Jarvis is thinking'}</p>
      <p className="mt-1 text-sm text-[var(--jx-ink-soft)]">{thinking.detail}</p>
      {blocked && thinking.retryable ? (
        <p className="mt-2 text-xs text-[var(--jx-ink-soft)]">
          The question is still queued. Nothing has been created, and you do not need to ask again.
        </p>
      ) : null}
      {blocked && thinking.canRetry ? (
        <button
          type="button"
          data-thinking-retry
          onClick={() => onRetry(thinking.requestId)}
          className="mt-2 text-sm text-[var(--jx-cyan)] hover:underline"
        >
          Try that again
        </button>
      ) : null}
    </div>
  );
}

/**
 * What Jarvis makes of an idea.
 *
 * The questions come first. They are the only part that needs Blake to do something, and burying
 * them under three paragraphs of assessment is how a question goes unanswered. The basis line is
 * not decoration: an assessment that looks like research and is not would make everything else on
 * this screen less believable.
 */
function EvaluationBody({ evaluation }: { evaluation: ConversationEvaluation }) {
  const block = (label: string, items: readonly string[]) =>
    items.length === 0 ? null : (
      <div key={label}>
        <p className="jx-label">{label}</p>
        <ul className="mt-1 space-y-1">
          {items.map((item) => (
            <li key={item} className="text-sm text-[var(--jx-ink-soft)]">
              {item}
            </li>
          ))}
        </ul>
      </div>
    );

  return (
    <div className="space-y-3 p-3">
      {evaluation.questions.length > 0 ? (
        <div>
          <p className="jx-label text-[var(--jx-cyan)]">Questions that would change the V1</p>
          <ul className="mt-1 space-y-1">
            {evaluation.questions.map((question) => (
              <li key={question} className="text-sm text-[var(--jx-ink)]">
                {question}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {evaluation.basis === 'reasoned' ? (
        <>
          <div>
            <p className="jx-label">Likely user</p>
            <p className="mt-1 text-sm text-[var(--jx-ink-soft)]">{evaluation.likelyUser}</p>
          </div>
          <div>
            <p className="jx-label">Problem</p>
            <p className="mt-1 text-sm text-[var(--jx-ink-soft)]">{evaluation.problem}</p>
          </div>
          <div>
            <p className="jx-label">Worth building?</p>
            <p className="mt-1 text-sm text-[var(--jx-ink-soft)]">{evaluation.verdict}</p>
          </div>
        </>
      ) : (
        <div>
          <p className="jx-label">Not assessed</p>
          <p className="mt-1 text-sm text-[var(--jx-ink-soft)]">{evaluation.verdict}</p>
        </div>
      )}

      {block('Smallest useful V1', evaluation.smallestV1)}
      {block('Assuming', evaluation.assumptions)}
      {block('Not known', evaluation.uncertainties)}

      <p className="text-[0.6875rem] text-[var(--jx-ink-faint)]">
        Reasoning about what you described — nothing external was consulted, and no project,
        repository or mission has been created.
      </p>
    </div>
  );
}
