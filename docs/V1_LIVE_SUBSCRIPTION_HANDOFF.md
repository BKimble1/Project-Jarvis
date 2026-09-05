# Jarvis V1 — live on a Claude subscription

What was built, what was proved, what was not, and exactly what you need to do to
finish activating it.

---

## Contents

1. [The honest state of it](#1-the-honest-state-of-it)
2. [What changed, and why](#2-what-changed-and-why)
3. [Activating it on your machine](#3-activating-it-on-your-machine)
4. [What Jarvis can really see about your Claude capacity](#4-what-jarvis-can-really-see-about-your-claude-capacity)
5. [How the governor decides](#5-how-the-governor-decides)
6. [The operating loop, and who drives it](#6-the-operating-loop-and-who-drives-it)
7. [Launch, stop, health](#7-launch-stop-health)
8. [Known gaps, and which ones matter](#8-known-gaps-and-which-ones-matter)
9. [The next decisions that are yours](#9-the-next-decisions-that-are-yours)

---

## 1. The honest state of it

Ten separate things could be true. Here is which are.

| #   | State                                             | Verdict                                                                          |
| --- | ------------------------------------------------- | -------------------------------------------------------------------------------- |
| 1   | Code implemented                                  | **Yes**                                                                          |
| 2   | Automated suite green                             | **Yes** — see the run recorded in the commit that added this file                |
| 3   | Subscription login verified                       | **Not on your account.** See below                                               |
| 4   | Real telemetry observed                           | **No**                                                                           |
| 5   | Live Claude worker qualified                      | **No**                                                                           |
| 6   | Read-only live mission completed                  | **No**                                                                           |
| 7   | Safe write mission completed or blocked           | **No**                                                                           |
| 8   | Autonomous operating loop running                 | **Yes, against a stand-in runtime.** The worker drove real passes; no Claude ran |
| 9   | Dashboard reachable                               | **Yes, on the machine that ran it.** Not tested from a second device             |
| 10  | Wallboard reachable from a Raspberry Pi or tablet | **No**                                                                           |

**Why 3 to 7 and 10 are not done here.** This work was carried out inside a
Claude Code cloud container. There is a Claude login on it, and the worker would
have authenticated against it — which is exactly why it was not used. That login
was provisioned for a coding session, not for your product; the container is
discarded when the session ends, so nothing "live" in it would be the repeatable
launch you asked for; and a subscription worker is meant to run under the
operating-system account that _you_ signed into Claude Code with. Running your
Jarvis against somebody else's credential would have produced a green tick and told
you nothing true.

So the live sequence is written down rather than performed, in §3. It is short.

**What was genuinely run here**, with a stand-in runtime and a throwaway local
database: `npm run jarvis:live` started the control plane, waited for
`GET /api/health`, started the worker, and the worker connected and heartbeated.
The poll and work loops interleaved. A minute later the worker drove a pass of the
operating loop — `POST /api/worker/operator-tick 200` — which is the caller that
did not exist before this work. `SIGTERM` drained the worker and left nothing
running. Two defects in the launcher were found by that run and fixed; they are
described in §7.

---

## 2. What changed, and why

**A worker can run on your subscription at all.** It could not before. One line in
the agent runtime returned "ANTHROPIC_API_KEY is not set" before the SDK was even
loaded, and that cascaded the whole way down — runtime unavailable, heartbeat
unhealthy, no mission ever claimed, and the `live_read` rung of the qualification
ladder permanently out of reach.

**Jarvis knows which credential is in force, and refuses ambiguity.** A worker
holding both a subscription login and a stray `ANTHROPIC_API_KEY` is refused —
_because_ it would silently run on the key. A key outranks a login, so an owner who
believed they were inside a subscription they had already paid for would be quietly
invoiced per token. Jarvis states the remedy and does not act on it: it will not
unset your variable, and it says so.

**Capacity telemetry is real.** Windows come from the Agent SDK's usage call and
from the rate-limit events that arrive mid-session. §4 covers what that does and
does not mean.

**The governor governs.** It was written, tested and connected to nothing. §5.

**The operating loop has a caller.** It had none — Jarvis could raise its own work
and never did. §6.

**The supervisor has a caller.** `superviseMission` had none either, so a mission
that had used every attempt, or had not moved for forty minutes, went unremarked.

**The worker no longer goes silent during a mission.** It used to poll, claim, run
the mission to completion, then poll again — so for the whole length of every
mission it said nothing, and after two minutes the control plane concluded it had
died. That one silence made four things dishonest at once: the workers page showed
a healthy worker as disconnected, your Stop was confirmed as "stopped, branch
untouched" while the agent was still running and would still open a pull request,
the qualification ladder demoted itself mid-mission, and no owner command could
reach the running agent. Every real Claude mission takes longer than two minutes,
so this was a launch blocker rather than a rough edge.

**A subscription mission no longer reports a dollar cost.** Claude Code reports
`total_cost_usd` on a subscription session too, and there it is not a bill — it is
what those tokens would have cost at API rates. Nothing is the accurate number.

---

## 3. Activating it on your machine

Six steps. Stop after step 1 if `claude auth status` says you are not logged in.

**1. Check your Claude Code is recent enough.**

```bash
claude --version
claude auth status --json
```

You want `"loggedIn": true` and `"authMethod": "oauth_token"`. That is the whole
proof Jarvis needs, and it is the exact command Jarvis runs — it reads three fields
and deliberately discards the rest, including the path to your projects directory.

If it says you are not logged in:

```bash
claude          # then /login, and follow the browser prompt
```

That is the one step nobody can do for you. Jarvis will not automate a browser
login, and you should never paste a token into a chat, this repository, or the
Jarvis database.

**2. Make sure there is no stray API key.**

```bash
env | grep -c ANTHROPIC_API_KEY     # you want 0
```

If there is one and you want to keep it for something else, start the worker
without it:

```bash
env -u ANTHROPIC_API_KEY npm run jarvis:live
```

Jarvis refuses to run model work while both exist rather than picking one.

**3. Configure and enrol.** Follow [docs/LAUNCH.md](./LAUNCH.md) — copy
`.env.example` to `.env.local`, fill it in, enrol a worker in **Operations →
Workers**, and put its token in `.env.local`.

Run the worker under **the same operating-system account you signed into Claude
Code with.** It uses that account's stored login. On a headless machine, run
`claude setup-token` as that user and put the result in `.env.local` as
`CLAUDE_CODE_OAUTH_TOKEN`.

**4. Run the live checks.**

```bash
npm run test:live
```

Five checks against your real account: that the login is readable through the
documented command, that Jarvis resolves it to a subscription and says who pays,
that the runtime reports itself available with no API key, and that a real
one-turn session runs, reports no dollar figure, and yields real capacity
percentages carrying nothing personal.

They spend a small amount of your subscription — one trivial turn. They are not in
`npm test` and never will be: a suite that sometimes costs money and sometimes fails
because a login expired is a suite people stop running, and they stop running the
free deterministic tests along with it.

If the last one reports that no capacity reading arrived, that is a real answer and
not a failure: your Claude Code may not expose the usage interface yet. The governor
treats that as a capability gap and narrows to one thing at a time rather than
stopping — see §5.

**5. Launch, and check.**

```bash
npm run jarvis:live
```

then, in another terminal:

```bash
npm run worker:health
```

The runtime detail is the sentence to read. On a subscription worker it says the
credential in force and who pays. If it mentions a key, go back to step 2.

**6. Run one read-only mission.** Pick a repository you do not mind Jarvis reading
— the qualification ladder wants a designated sandbox, not something important —
and raise an inspection mission from Mission Control. Watch Operations while it
runs. Three things should happen that could not have happened before: the worker
stays connected for the whole mission, the **Claude capacity** card fills in with
real percentages once the session ends, and the governor's sentence changes to
reflect them.

That single mission is what turns states 3, 4, 5 and 6 green.

---

## 4. What Jarvis can really see about your Claude capacity

**It can see percentages.** Five-hour, weekly, and weekly-Opus utilisation, with
the times they reset, from the Agent SDK's usage interface and from the rate-limit
events that arrive during a session.

**It cannot see a token allowance, and does not pretend to.** Anthropic does not
publish "tokens remaining on your subscription". It would be easy to manufacture
one — tokens spent, subtracted from a plan size read off a pricing page — and that
number would be wrong in a way nobody could check, because it would ignore every
other machine and every conversation you had in the app. There is no such figure
anywhere in Jarvis.

**Percentages are account-wide.** They belong to your account, not to a machine.
Three workers each reporting 42% means your account is at 42%; summing them would
produce 126%, a number that cannot exist, stated with total confidence. Jarvis
takes the newest reading and never adds them.

**Session context is not account capacity.** A session 90% through its context
window says nothing about how much subscription is left. The two are carried in
separate fields, with separate names, the whole way to the screen.

**A missing figure stays missing.** Null means unknown and never becomes zero. A
window Jarvis could not read renders as a sentence rather than as an empty bar,
because on a screen glanced at from across a room a bar at zero and a bar that is
missing look identical — and only one of them means you are out.

**A reading ages.** Capacity can only be read from a live Claude session, so
between missions there is nothing new. Jarvis keeps the last reading, marks it
"last known" after fifteen minutes, and does not blank it on every quiet
heartbeat — which would erase a measurement within moments of taking it.

**It reads none of the rest.** The same payloads carry an email address, an
organisation name, a list of memory-file paths and a breakdown of MCP tool names.
None of that is capacity, and none of it is stored.

**Overage is reported and never acted on.** If your account is spending beyond the
included subscription, Jarvis will show you. It will not enable credits, change a
billing setting, or accept paid overflow. When included capacity is exhausted it
checkpoints and waits for the reset.

---

## 5. How the governor decides

The reserve is yours, in the charter: `reserveFiveHourPercent` (25% by default) and
`reserveSevenDayPercent` (20%). It is expressed as capacity the operator _may not
touch_, because autonomous work is the thing that should yield when you want to use
Claude yourself.

| Situation                                 | What Jarvis does                                               |
| ----------------------------------------- | -------------------------------------------------------------- |
| Room in every window                      | Works normally; your concurrency limit is the ceiling          |
| Getting tight (within twice the reserve)  | One thing at a time                                            |
| Inside the reserve                        | Finishes what is running, starts nothing new                   |
| A window used up                          | Starts nothing until it resets                                 |
| No such window (API key, Bedrock, Vertex) | Works; money is the constraint, and spend limits enforce that  |
| Never managed to read a window            | **Works, one thing at a time**, and says the figure is missing |
| Read it, and it has gone stale            | Uses the value, one thing at a time                            |

The sixth row is the one worth understanding. An unreadable window used to stop all
work, on the reasoning that holding is wrong in the recoverable direction. That is
true only if the unknown is temporary, and the commonest cause is not: an older
Claude Code with no usage interface never starts reporting, so Jarvis would have sat
there indefinitely explaining that it was holding rather than guessing. A gap in
what Jarvis can see is a capability gap, not a capacity signal.

It also does not flap. A window resting on the reserve boundary would otherwise
alternate between holding and starting on every pass, and an operator that starts a
mission, defers, starts and defers produces half-finished work and a log nobody can
read. Coming out of a hold needs a margin of clear air.

Every decision is written to the tick record with the sentence that explains it, and
the last one is shown on Operations. On a quiet day that sentence is the only thing
that distinguishes "there was nothing worth doing" from "Jarvis was keeping your
capacity back for you".

---

## 6. The operating loop, and who drives it

The control plane runs on Netlify, where nothing holds a loop open — a request
arrives, is answered, and the process goes away. The worker is the only part of
Jarvis that keeps existing, so the worker asks the control plane to take a pass, on
its own timer.

- **Every minute**, by default. Set `JARVIS_WORKER_OPERATOR_TICK_SECONDS` to change
  it, or `0` to turn it off on a worker that should only run missions. A pass reads
  every project and rewrites the backlog; doing that continuously would spend more
  on watching than on working.
- **Its own endpoint**, authenticated by the worker's own token. The cron endpoint
  remains for the scheduled backstop. Handing the shared cron secret to every
  machine you run a worker on would spread a control-plane credential for no gain —
  and worse, the worker treats a 403 as fatal, so a stale secret would shut the
  worker down rather than merely fail to drive the loop.
- **Safe to overlap.** A pass takes a lease, so two callers do not both run.

Each pass now begins by supervising what is already running, and writes its verdict
into that mission's own timeline. **It reports and does not intervene**, and that is
deliberate: the mission state table withholds stopping and pausing from standing
authority, on the reasoning that stopping is your decision. See §9.

---

## 7. Launch, stop, health

`npm run jarvis:live`. Full detail in [docs/LAUNCH.md](./LAUNCH.md).

Two defects were found by actually running it, which is the reason to actually run
things:

- **Stopping did not stop anything.** `npx next dev` is not one process — it is
  `npm exec`, which spawns a shell, which spawns node, which spawns the server — so
  signalling the child killed the shim and left the server running while the
  terminal said it had stopped. Each child now runs in its own process group.
- **It stopped things in the wrong order.** Draining means the worker finishes its
  mission and _reports_ that it finished, so killing the control plane at the same
  moment takes away the endpoint it needs. The first test printed the drain message
  and "Poll failed: fetch failed" one line apart. The worker is now stopped first
  and waited for.

| Question                                        | Command                                 |
| ----------------------------------------------- | --------------------------------------- |
| Is everything configured?                       | `npm run doctor`                        |
| Is the worker healthy, and on which credential? | `npm run worker:health`                 |
| Is the control plane up?                        | `curl http://127.0.0.1:3000/api/health` |
| How much Claude is left?                        | Operations → Claude capacity            |

---

## 8. Known gaps, and which ones matter

These were found while exercising the live path. None is fixed here; each is stated
so you are not surprised by it.

**Worth knowing before you rely on autonomous writing:**

- **Mission runtime and token ceilings are not enforced.** `MissionOrchestrator.canStart`
  has no callers, so `maxMissionRuntimeMs` and `maxMissionOutputTokens` are never
  checked. The supervisor now _notices_ a mission that has exceeded them; nothing
  stops it.
- **A deterministically-planned write mission widens its write set to the whole
  repository.** The planner's only `affectedAreas` entry is prose, so `deriveWriteSet`
  cannot narrow it — which turns the write-set control off end to end for that path.
- **The task protocol never writes to the usage ledger**, so the charter's rolling
  daily and weekly spend caps are computed over a table that contains none of the
  factory's spend.
- **There is no reclaim path for a crashed worker's task or write lease.** One
  crashed worker permanently consumes a concurrency slot.

**Smaller:**

- A Stop pressed while the workspace is still being prepared fails the mission
  rather than stopping it cleanly.
- `live_read` evidence records the _control plane's_ model and provider settings,
  not the worker's — so a subscription worker's qualification evidence names a model
  that never ran.
- The operator tick has no limit on projects or backlog size and never renews its
  120-second lease.
- Three supervisor stall signals are dormant because nothing records a per-turn view
  of the working tree. They are named in the code rather than approximated.

---

## 9. The next decisions that are yours

**Should the supervisor be able to stop a mission?** Right now it notices and
records. The mission state table deliberately withholds stopping from standing
authority: "when the supervisor decides a mission has become a rabbit hole it ends
it through `running → failed`, which `system` may already do, and the partial work
stays on its branch." Wiring that up is a small change and a real widening of what
Jarvis may do without you. It was not done as a side effect of building the caller.

**Which repository is the sandbox?** The ladder needs one designated low-risk
repository before a live write mission. Choose it deliberately; do not point it at
something you would mind being wrong about.

**Whether the enforcement gaps in §8 block operator mode for you.** Read-only
autonomy is safe today. Autonomous _writing_, with the write-set control off for
deterministic plans and no runtime ceiling enforced, is a bigger step than the
charter makes it look.
