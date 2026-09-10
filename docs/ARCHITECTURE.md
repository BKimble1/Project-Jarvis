# Jarvis architecture

Jarvis is a chat-first autonomous build agent. One sentence in chat should be
enough to get a project planned, built, verified, reviewed, repaired and
delivered — and the operator should be able to change direction mid-build
without losing scope or ending up with two projects.

## Shape

```
                    ┌──────────────────────────────────────────┐
  browser  ───────▶ │  src/server.js   static + JSON + SSE      │
  (public/)  ◀───── │  src/api/routes.js                        │
                    └───────────────┬──────────────────────────┘
                                    │
                            src/app.js  (composition root)
                                    │
        ┌───────────────┬───────────┼────────────┬───────────────┐
        │               │           │            │               │
  ChatDispatcher   Orchestrator  Scheduler   UsageService   SpeechService
   src/chat/*      src/orchestrator/*  ▲      src/telemetry/*   src/voice/*
        │               │              │            │
        │          WorkerPool ─────────┘     ClaudeSubscriptionProvider
        │          src/workers/*                (OAuth, real endpoint)
        │
        └──────────────── EventBus + Store (src/core/*) ─────────────┘
```

Every collaborator is injected. Nothing reaches for a singleton, a real clock,
the network or `$HOME` on its own, which is why the whole system can be driven
end to end in tests in milliseconds.

## The autonomous loop

`Orchestrator` is a phase machine over persisted records:

```
planning → implementing → verifying → reviewing → delivering → idle
                ▲              │           │
                └── repairing ─┴───────────┘
```

- **A plan is not a deliverable.** `planning` always falls through to real work.
- Any failed task routes to `repairing`, whichever phase found it. A repair
  re-opens the checks it was meant to fix, so repaired work is re-proven rather
  than assumed good. Repair rounds are capped; exceeding the cap blocks with a
  precise ask instead of spinning.
- Transient and capacity errors are retried on a bounded budget
  (`RetryBudget`). Credential and permission errors never retry — they block
  the project with a sentence naming exactly what is needed.
- A question parks only the task that raised it. Independent tasks keep going.
  Answering emits `question.answered`, which the orchestrator listens for and
  resumes on its own — the operator never has to also say "continue".
- Routine choices that carry a sensible default are decided, not asked
  (`QuestionGate.isMaterial`).
- After delivery, `drain()` works the authorized backlog and stops when it is
  empty. It never synthesizes work.

### Operating modes

The dashboard's mode control is real behaviour, not decoration:

- `autonomous` — the loop above, unattended.
- `ask-first` — Jarvis plans, then shows the plan as a decision card and waits.
  Approving builds it; declining pauses the project rather than building anyway.
  This is a deliberate setting, not a routine approval stop.
- `paused` — new requests are recorded as projects and left unstarted.

## Chat as the interface

`ChatDispatcher` is the only entry point the dashboard needs:
`classify()` picks the intent (explicit stop/pause/evaluate markers always beat
build language), `resolveReference()` binds "change that", "the second option"
and "continue" to the right project — and returns `ambiguous` rather than
guessing when two candidates are equally likely.

## Telemetry

The capacity path is four real hops:

1. **provider measurement** — `ClaudeSubscriptionProvider` does an OAuth-
   authenticated `GET /api/oauth/usage`. It resolves the token from
   `CLAUDE_CODE_OAUTH_TOKEN`, `~/.claude/.credentials.json`, or the macOS
   keychain. It will **not** fall back to `ANTHROPIC_API_KEY`, because that
   silently spends paid API credit instead of reading the subscription.
2. **worker report** — `UsageService.ingestWorkerReport()` accepts the same
   measurement shape from a background worker.
3. **stored capacity** — the last good snapshot is persisted and reloaded on
   restart, so a restart never loses the reading nor pretends it is fresh.
4. **dashboard circles** — `report()` returns `live` / `stale` / `unavailable`
   with per-window percent used, remaining, reset time in the operator's
   timezone, and freshness. Unknown is `unavailable` with an explanation and a
   recovery action; it is never rendered as 0%.

`Scheduler` reads the same numbers and changes real behaviour: concurrency
bands from full width down to one at a time, plus an inter-task pace delay that
`WorkerPool` actually awaits. Unknown capacity is treated conservatively.

## Speech

`SpeechService` is the single source of spoken output; `src/app.js` subscribes
it to the bus once. It dedupes by event key, batches minor progress into one
sentence, speaks blockers and questions immediately even in quiet hours, obeys
mute, and persists acknowledgements so a refresh never replays.

## Storage

`Store` is a JSONL journal plus an atomically-written snapshot. Mutations are
journalled first, so a crash before the snapshot still replays cleanly, and a
corrupt snapshot is set aside and rebuilt from the journal.
