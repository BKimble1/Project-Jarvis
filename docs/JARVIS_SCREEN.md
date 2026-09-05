# The Jarvis screen

The immersive dashboard at `/dashboard`, the design language it is built from, and — the part that
matters most — the rules that keep a very persuasive animation from saying something untrue.

---

## 1. What it is

One screen, designed for a large monitor across a room and recomposed deliberately for a laptop, a
tablet and a phone. It carries everything an owner needs to walk in, read the state, speak, and
choose what happens next:

| Region    | What it holds                                                                      |
| --------- | ---------------------------------------------------------------------------------- |
| Top strip | Identity, greeting, operating mode, worker/autonomy/mission pills, clock, controls |
| Under it  | Readiness: is a worker connected, what has this deployment actually qualified for  |
| Left      | Projects, their status, the mission genuinely open on each, who needs attention    |
| Centre    | The core, the status line, and the last thing said                                 |
| Right     | What needs me (numbered), what is running, what just finished                      |
| Bottom    | One command box: type, speak, send, **Brief me**, and how much Claude is left      |

The detailed portfolio — the filtered grid, the count tiles, the mission strip, the whole-portfolio
briefing — moved to `/portfolio` intact. It was not duplicated here: two command surfaces on one
screen is exactly what this redesign set out to remove.

## 2. The design language

Lives in one place: the `.jarvis-surface` block in `src/app/globals.css`. It works by **re-pointing
the application's existing `--color-*` tokens** rather than by forking component styles, so every
`Button`, `Card`, `Badge` and `Field` already built against those tokens adopts the blue language
with nothing to maintain per component.

```
--jx-void  #030916   --jx-blue  #278CFF   --jx-ink       #E5F5FF
--jx-deep  #071A38   --jx-cyan  #79E8FF   --jx-ink-dim   #9CC2E8
--jx-panel #0A2041   --jx-amber #FFB84D   --jx-ink-faint #6E92BC
--jx-line  #16406F   --jx-red   #FF6B7E   --jx-green     #4FE0A8
```

Amber and red are reserved for something that genuinely needs a person or has genuinely failed.
Every state that uses them also says so in words, so nothing on this screen depends on being able
to separate two colours — or on the glow being on at all.

`.jarvis-surface` is always dark. A light variant would be a different product and would mean every
contrast decision had to hold twice. While the screen is mounted it sets `data-jarvis-scope` on the
document so the sidebar and tab bar wear the same palette instead of framing it in white.

## 3. The core, and what it is allowed to say

`src/domain/core-state.ts` maps real system state to visual state, as a pure function with its own
tests. It is domain code rather than renderer code on purpose: nobody looks for an honesty rule
inside a canvas loop.

**The two axes never collapse.** Conversation and background work are independent inputs.
`coreState` resolves which one the centre shows, by precedence — disconnected beats everything,
conversation beats background work, attention beats routine work — and the count of running
missions is passed to the renderer _separately_ as `activity`, on its own ring. Jarvis speaking
never erases three agents working, and three agents working never hides that it is listening.

| State          | What has to be true                         | How it moves                         |
| -------------- | ------------------------------------------- | ------------------------------------ |
| `ready`        | Nothing is happening                        | Slow turn, gentle breathing glow     |
| `listening`    | The microphone is genuinely open            | Reacts to a **measured** level       |
| `thinking`     | A real request is in flight                 | Faster rings, and the only sweep     |
| `speaking`     | Speech synthesis is genuinely playing       | Driven by playback events            |
| `working`      | Missions are actually running               | Outer accents, one per agent, max 4  |
| `attention`    | Something is genuinely waiting on the owner | Amber, quieter                       |
| `limited`      | Capacity withheld, or Jarvis paused         | Slow, dim, with the real reason      |
| `disconnected` | No worker, or the loop has stopped          | Red, nearly still, unmistakable      |
| `complete`     | Something really finished, for four seconds | One green accent, then back to truth |

Three rules the code enforces rather than merely intends:

- **A level is only ever a measurement.** `useMicLevel` opens a second `getUserMedia` stream and
  reads RMS from an `AnalyserNode`. When it is refused, unavailable, or the device disappears, it
  returns `null` and the core does not move — it does not fall back to a synthetic waveform.
  `CORE_MOTION[state].reactivity` is zero for every state where no trustworthy level exists, so a
  stale number cannot leak into the animation.
- **Speaking is animated from playback events, not from amplitude.** `speechSynthesis` reports that
  an utterance started and stopped and nothing about volume. That is what drives the speaking
  state, and it is never described as a waveform.
- **Nothing decorative implies work.** The activity accents are absent entirely at zero — an empty
  ring is the honest picture of nothing running — and the radar sweep exists only while a request
  is genuinely pending. A permanent sweep is the most common way an interface like this starts
  lying.

The core is `aria-hidden` with no numbers in it. Every state is also carried by the status line,
the pills and the panel text, which is what makes reduced motion, a screenshot and a screen reader
all equally complete.

## 4. Talking to it

One path, whether it was typed or spoken:

1. `remember that…` / `forget…` → the existing memory capture endpoint.
2. Otherwise `interpretReply` — the same pure function the old panel used — resolves an ordinal, a
   decline, or "continue" against the numbered list on the right.
3. Anything else: typed text becomes a question through `/api/query`; **spoken** text goes through
   `/api/voice` and its confirm step, which is where the domain's refusal to treat speech as
   approval lives. This redesign added no approval step and removed none.

**Numbered follow-ups are bound at composition time.** The identity of the action list is captured
when someone starts typing or opens the microphone, and checked before an ordinal is acted on. If a
poll reordered the list in between, nothing runs and the screen says so. Executing a different
"first one" than the one that was read out is the worst failure this screen could have.

**Selecting a project focuses what is shown, never what a command means.** A selection that
silently retargeted "do the first one" would be a way to act on the wrong project without ever
seeing its name.

**Stopping speech and pausing Jarvis are different controls.** The dock only ever silences audio.
Pausing autonomous work lives on Operations, where it has an explanation beside it.

There is no wake word, and the hands-free option says so where it is offered. A browser cannot have
one without holding the microphone open indefinitely, and a control that claimed otherwise would be
a lie about a microphone.

## 5. Truthfulness of the operational displays

Everything comes from `buildOperatingPicture` — the same assembly the briefing and the answer
pipeline use — plus `quickReadiness` and `buildCapacityView`, all read on the server behind the
owner guard. The client receives a finished picture and never fetches a second, subtly different
one.

Kept visibly distinct, because a working dashboard is not evidence of any of the others: the web
interface being up, a worker being connected, Claude being available, autonomy being enabled, and a
mission actually running.

Capacity is always stated as **used**, in words, next to the figure; an unmeasured window renders as
a hatched ring and "Not measured", never as an empty meter that reads as "plenty left" from three
metres away. Account-wide windows and per-session context are never mixed.

## 6. The wallboard

`/display` wears the same surface, the same panels and the same core. Only the stylesheet is
shared: it still authenticates with its display credential, still renders exclusively from
`/api/display`, and has no control on it. Its core state is derived from that payload alone —
`boardState` in `display-board.tsx` — and `listening`, `thinking` and `speaking` are unreachable
there, because a wall has no conversation and inventing one would be the easiest lie in the
building. Pairing, loading, disconnected and stale all render as finished screens.

## 7. Efficiency

- One `requestAnimationFrame` loop for the whole core. The rings are CSS animations on SVG groups,
  so they cost one composited layer and no JavaScript per frame.
- Bounded particles: 1600 in full graphics, 320 in lite. Device pixel ratio is capped at 2 and 1.
- The loop stops when the tab is hidden (`visibilitychange`) and when the core scrolls out of view
  (`IntersectionObserver`). With motion off it draws exactly one frame.
- **Polling is completely separate from animation.** A visibility-aware interval calls
  `router.refresh()` — 8s while something is running, 30s when nothing is — and is skipped while a
  request is in flight. Rotating a ring never causes a request.
- Graphics mode and motion are owner choices, kept in `localStorage`; reduced motion is honoured by
  default and every state stays legible standing still.

## 8. Controls

| Control          | Where              | What it does                                                    |
| ---------------- | ------------------ | --------------------------------------------------------------- |
| Immersive view   | Top right, arrows  | Hides the app chrome and requests browser fullscreen            |
| Escape           | Anywhere           | Leaves both                                                     |
| Display settings | Top right, sliders | Graphics full/lite, motion on/off, read aloud, hands-free       |
| Speak / Stop     | Command dock       | Opens and closes the microphone                                 |
| Send as spoken   | Command dock       | Sends the text through the voice gate rather than as a question |
| Stop speaking    | Command dock       | Cancels playback, and only playback                             |
| Pause Jarvis     | **Operations**     | Stops autonomous work — deliberately not on this screen         |

Immersive mode is a document attribute, not a different route, so one React tree and one state
survive the switch — a half-typed sentence and the selected project both come back.

## 9. What has and has not been proved

Verified in a real browser at 1920×1080, 1366×768, 1024×768 and 390×844, against the running
application with a live database: composition, contrast, the empty and disconnected states, the
answer path, immersive entry and exit with input preserved, the graphics and motion settings
surviving a reload, the pre-hydration typing defence, and the capacity wording. Covered by
`tests/unit/core-state.test.ts` and `tests/e2e/jarvis-screen.spec.ts`.

**Not proved here, and not claimed:** no microphone and no audio output exist in this environment,
so the listening and speaking states have never been exercised against a real voice — the analyser
path, the level it produces and the speech playback events are implemented and typed but not
live-tested. No worker has ever enrolled here, so `working` and `complete` have not been seen with
real missions behind them. Performance was measured on this development container only; no
Raspberry Pi or Android tablet was available, so the lite graphics mode is built and switchable but
its frame rate on that hardware is unmeasured.
