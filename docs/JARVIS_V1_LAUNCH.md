# Jarvis V1 — launch

What this is, how to run it, what it will and will not do, and — the part worth reading twice —
what has actually been proved as opposed to merely built.

For the two-minute version, see [TOMORROW_MORNING.md](./TOMORROW_MORNING.md). For how the main
screen is built and what its animation is and is not allowed to claim, see
[JARVIS_SCREEN.md](./JARVIS_SCREEN.md).

---

## 1. Starting it

```sh
npm run jarvis:live
```

One command. It reads `.env.local` then `.env`, refuses to start if a credential that would fail
seconds later is missing, applies migrations when the database is hosted, starts the control plane,
waits until it answers, then starts the worker. Ctrl-C stops both — the worker first, with fifteen
seconds to finish what it is holding.

**Run it as the account that ran `claude login`.** A subscription worker authenticates from that
account's own Claude credentials. Running as `root` or a dedicated user gives you a worker that
starts, finds nothing, and refuses every mission.

- One instance per checkout, held by a lock in `.jarvis-live/live.lock`. Two launchers is two
  control planes on one port, two workers with one token, and two writers on a single-writer
  database.
- A process that dies is restarted, with a growing wait, five times in ten minutes. Then everything
  stops, so the error can be read rather than watched scrolling past.
- Everything both processes print goes to `.jarvis-live/jarvis.log`, redacted, rolled at 8MB.
- To survive a reboot: `deploy/jarvis.service`. See [OPERATIONS.md](./OPERATIONS.md).

## 2. Using it

**The dashboard** is the whole screen. A luminous core in the middle, which says what Jarvis is
actually doing and nothing else; your projects and their current work down the left; what needs
you, what is running and what just finished down the right; and one command box along the bottom
with the microphone, **Brief me**, and how much Claude is left. Nothing on it is decorative
arithmetic — the core is quiet when nothing is running, and says so in words as well as in colour.

Two controls at the top right: **fullscreen** (Escape leaves it), and **display settings**, which
hold a lighter graphics mode for a Raspberry Pi or an old tablet and a switch that stops the
movement while keeping every state readable.

The detailed portfolio — the filtered grid, the mission strip, the whole-portfolio briefing — is
one click away at **/portfolio**, or "Portfolio" in the sidebar.

Type into the box:

| You say                                 | What happens                                                                      |
| --------------------------------------- | --------------------------------------------------------------------------------- |
| `do the first one` / `the second` / `3` | Opens that item, or — if the charter already covers it — gets on with it          |
| `continue`                              | Goes to what is running; under standing authority, runs a pass now                |
| `not tonight` / `no` / `later`          | Nothing. It will all still be there tomorrow                                      |
| `remember that …`                       | Saves it as a memory, categorised, with any dates it mentioned                    |
| `forget …`                              | Finds candidates. Deleting still needs a typed confirmation                       |
| anything else                           | Becomes a question, and goes to Ask with evidence and citations                   |
| **Brief me**                            | The morning briefing: what finished, what waits, where things stand, what is next |

**Speaking** works where the browser supports it. Press **Speak**, say one thing, correct the text
in the box if it came out wrong, then **Send as spoken**. The core reacts to your voice while the
microphone is open, and only then — that movement is a real measurement of the microphone, and
when the browser will not give one it simply does not move. Push-to-talk by default; hands-free keeps listening between messages and
still starts with a press. There is no wake word and Jarvis does not listen for one — a browser
cannot do that without holding the microphone open indefinitely.

**Operations** is the other screen worth knowing: is Jarvis running, how much Claude is left, what
happened in the last day, what it started for itself and whether that helped, and **Pause Jarvis**.

## 3. What it will not do

These are refusals in code. There is no setting that turns them off.

- **Merge anything, or push to a default branch.** Work arrives as a draft pull request.
- **Approve itself.** Spoken words are never an approval, checked twice.
- **Write outside its declared scope.** The write set is derived by the deterministic layer, fixed
  for the attempt, enforced at the tool boundary, and re-checked against the real git diff —
  including anything the agent committed — before integration.
- **Buy anything, move money, enter an agreement, act as you, or publish a claim.** Refused at the
  point a goal is written down.
- **Claim revenue.** No financial source is connected, so no result can say money was made.
- **Call anybody but your own verified number**, and not without a provider you configured. See
  [CALL_BRIDGE.md](./CALL_BRIDGE.md).
- **File sensitive things it merely overheard.** A password, a card number, a diagnosis, somebody's
  pay: kept when you ask in so many words, never because it came up.
- **Fill a gap with a plausible sentence.** A briefing names what it cannot see, every time.

## 4. What bounds it

| Bound                                 | Where                                                           | What happens at the edge                                                                            |
| ------------------------------------- | --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Mission runtime, output tokens, turns | Per task, tighter of assignment and role profile                | The session is interrupted at a safe point, work is checkpointed, the task fails as `limit_reached` |
| A hung session                        | Watchdog, every 5s                                              | Interrupted from outside; a model call that never returns cannot outlast its time limit             |
| Write scope                           | Declared set, enforced at the tool and against the final diff   | `write_scope_violation`, workspace preserved                                                        |
| Claude capacity                       | 5-hour and 7-day windows, with your reserve                     | Nothing new starts; running work continues                                                          |
| Concurrency                           | Deployment limit, capacity, and **three self-started missions** | The queue waits                                                                                     |
| Self-started work                     | 3 in flight                                                     | Your own work is never queued behind Jarvis's                                                       |
| Calls                                 | 3 a day, 90s, quiet hours                                       | Refused with a reason                                                                               |
| Crashed worker                        | 10 minutes silent                                               | Task taken back, lease released, late results fenced out                                            |

## 5. Qualifying it

Run `npm run qualify -- run`. It climbs a ladder by _demonstrating_ capability rather than by being
configured, and the rung it reaches is what unlocks unattended work. Each check reports pass, fail
or "nothing here to ask" with the reason, and nothing is ever inferred from a value being present.

Never point it at a repository you care about. The sandbox exists so being wrong costs nothing.

On this deployment it currently reports **nothing qualified**: no worker has ever enrolled, no
sandbox is allow-listed, and no automated suite result has been recorded against this build. That is
the honest state of a checkout, not a fault — and it is why nothing runs unattended here.

## 6. What is proved, and what is not

The distinction this section exists for: **implemented**, **mock-tested**, and **live-proven** are
three different claims, and collapsing them is how a handoff becomes a lie.

### Live-proven — observed working, here, with real components

1. **The database, migrations and every repository.** All seventeen migrations apply to a real
   Postgres, and every integration test runs against one.
2. **The task protocol end to end.** A real git repository on disk: real clones, branches, commits,
   merges, and real refusals. Only the model and GitHub's API are replaced.
3. **Write-scope enforcement.** Against a real repository: a committed change, a committed rename,
   mixed committed and uncommitted work, and a filename with a space in it.
4. **Concurrency.** Four workers claiming at one instant and never getting the same row, against
   the real `FOR UPDATE SKIP LOCKED` claim.
5. **Crash recovery and fencing.** A worker that crashes after claiming, a second taking over, and
   the first worker's late report refused.
6. **Ceiling enforcement.** A scripted agent that will not stop, stopped by its own time and token
   ceilings, with the work checkpointed.
7. **The usage ledger.** Written exactly once per run through the task protocol.
8. **Voice, server-side.** Submit, confirm, refuse an approval, refuse a confirmation whose text
   changed, act once however many times it arrives.
9. **Memory.** Capture, supersession, conflicts, forgetting — including scrubbing the copies an
   answer kept.
10. **A worker connecting to this control plane** and driving `POST /api/worker/operator-tick`.

### Mock-tested — the real code path, with one component replaced

11. **Model behaviour**, by the scripted runtime. Every decision the worker makes around a model is
    real; what the model says is not.
12. **GitHub delivery**, by `FakeDelivery`. The push refusals are real; the API call is not.
13. **The call bridge**, by `CallSimulator` — a real provider implementation, not a mock, so the
    bridge runs its production path.
14. **Claude capacity telemetry**, from crafted heartbeats. The parsing, merging and governing are
    real; the readings are not.

### Implemented, never run against the real thing

15. **A real Claude subscription mission.** The worker's subscription auth path is written and its
    preflight tested; no mission has been executed by a real Claude session from a subscription
    login. This is the single largest untested claim, and it needs one machine with `claude login`
    and one mission.
16. **A real outbound telephone call.** No provider configured, ever. Step 7 of the checklist in
    [CALL_BRIDGE.md](./CALL_BRIDGE.md).

## 7. If something is wrong

```sh
npm run doctor          # the full readiness report — the same one /setup and Operations render
npm run worker:health   # what the worker itself thinks it can do
```

Then: **Setting up** for what to fix, **Operations** for what is happening, and
`.jarvis-live/jarvis.log` for what happened while you were asleep.
