# Project Jarvis

A chat-first autonomous build agent. Describe work in one sentence; Jarvis
plans it, builds it, verifies it, reviews it, repairs what fails and delivers
it — and tells you what it is doing in one short sentence at a time.

## Run it

```bash
npm start                 # http://127.0.0.1:8787
npm test                  # unit + acceptance suites
npm run usage             # diagnose the real subscription telemetry path
```

No dependencies. Node 22+, `node:` builtins only, no build step.

## What it does

- **Keeps working after a request.** A plan is not a deliverable. Jarvis
  carries a request through planning, implementation, verification, review,
  repair and delivery without further prompting, then picks up the next
  authorized backlog item and stops when the backlog is empty.
- **Chat is the whole interface.** Describe work, change direction mid-build,
  answer a question, approve, pause, stop, ask for status — all in chat.
  "Change that", "the second option" and "continue" resolve to the right thing,
  and genuinely ambiguous references get a question rather than a guess.
- **Speaks plainly.** First person, one to three short sentences, the same text
  on screen and aloud. Minor progress is batched; delivery, blockers and
  questions are announced. Nothing is ever spoken twice or replayed on refresh.
- **Voice both ways.** Replies and announcements are read aloud by default,
  with mute, quiet hours and the browser's activation requirement handled
  explicitly. A question can be answered by voice or by typing; the dictation
  button hides itself entirely where speech recognition is unavailable.
- **Modes that mean something.** `Autonomous` runs unattended. `Ask first`
  shows you the plan and waits — approve and it builds, decline and it pauses
  rather than building anyway. `Paused` records new requests without starting
  them.
- **Reminders you manage in chat.** "Remind me to renew the domain" holds it
  without authorizing it; "what are my reminders?", "go ahead with the domain
  reminder" and "drop the logs reminder" do the rest.
- **A clean dashboard.** The animated core, one current-action sentence, chat,
  compact mode and health controls, and the usage circles. A decision card only
  when you need to act; deliverables only when they exist; diagnostics in a
  drawer.
- **Real usage circles.** Percent used, remaining, reset time in your timezone
  and measurement freshness, read from the authenticated subscription usage
  endpoint. A stale reading is labelled stale with its age; no reading at all
  says "Unavailable" with a recovery action. Unknown never looks like 0%.
  Those same numbers pace real work: concurrency drops band by band as the plan
  fills up, and once a window is spent the work is held and picked back up by
  itself when the window resets.

## Doing real work

The shipped executor is deterministic, so Jarvis runs and is fully testable
with no credentials. To have it actually write code through the Claude Code
CLI, in a per-project workspace under `data/workspaces/`:

```bash
JARVIS_EXECUTOR=claude npm start
```

Failures from the CLI are classified, so an expired login blocks the project
with a precise ask rather than burning retries, while a dropped connection is
retried.

## Credentials

Subscription usage needs a Claude subscription OAuth token:

```bash
claude setup-token        # or export CLAUDE_CODE_OAUTH_TOKEN=...
```

Jarvis deliberately will not read usage with `ANTHROPIC_API_KEY` — that bills
paid API credit instead of reporting your plan. Without a token the circles
read "Unavailable" and say exactly this.

## Layout

| Path | What lives there |
| --- | --- |
| `src/core/` | clock, event bus, crash-safe store, ids, logger |
| `src/orchestrator/` | the autonomous loop, planner, scheduler, retries, questions, backlog |
| `src/workers/` | worker pool with crash recovery |
| `src/chat/` | intent classification, reference resolution, conversation, dispatcher |
| `src/voice/` | speech policy and the dedupe/batch/acknowledge queue |
| `src/telemetry/` | subscription provider, capacity service, speech summaries |
| `src/api/`, `src/server.js` | JSON API, resumable SSE, static hosting |
| `public/` | the dashboard (no build step, no CDN) |
| `docs/` | [architecture](docs/ARCHITECTURE.md), [contracts](docs/CONTRACTS.md), [acceptance](docs/ACCEPTANCE.md) |
