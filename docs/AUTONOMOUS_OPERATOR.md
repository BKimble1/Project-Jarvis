# The autonomous operator

How Jarvis decides what it may do on its own, what it decides to do, and when it stops.

This document describes what is **built and enforced today**. Where something is designed but not
yet wired, it says so in those words. Nothing here describes a capability Jarvis does not have.

---

## The three questions

Every autonomous act has to get past three separate gates. They are separate because they answer
different questions, and none of them implies the others.

| Question                                        | Who answers               | Where                                                     |
| ----------------------------------------------- | ------------------------- | --------------------------------------------------------- |
| Is Jarvis operating at all right now?           | The **operating mode**    | `src/domain/operating-mode.ts`                            |
| Did the owner permit this?                      | The **charter**           | `src/domain/charter.ts`                                   |
| Has this deployment proved it can do it safely? | The **activation ladder** | `src/domain/qualification.ts`, `src/domain/unattended.ts` |

A charter granting `code.change` across every repository still cannot make an unqualified
deployment safe to write. A deployment qualified to `production` still may not touch a repository
the owner never granted. Both are asked, in either order, every time.

The decision procedure that combines them is `authorize()` in `src/domain/authorization.ts`. It is
a pure function. **It contains no model, and never will** — an operator that decides its own
authority by asking a model is an operator whose authority cannot be explained afterwards.

---

## The operating mode

Six modes, and the order is the meaning.

| Mode             | What happens                                                                  |
| ---------------- | ----------------------------------------------------------------------------- |
| `off`            | Nothing. Jarvis does not even look.                                           |
| `observer`       | Looks and reports. Creates nothing.                                           |
| `supervised`     | Proposes missions and waits for you on each one. This is Phase 2–4 behaviour. |
| `operator`       | Creates and runs missions inside the charter, without asking again.           |
| `paused`         | Finishes or safely stops what is running. Begins nothing new.                 |
| `emergency_stop` | Stops everything that can be safely stopped.                                  |

The transition table has one safety property, and it is deliberate: **every move toward less
autonomy is available from anywhere and to the system; every move toward more autonomy is
owner-only.** A stuck, confused or failing Jarvis can always be brought down, and can never bring
itself up.

Moving into `operator` additionally requires a charter in force that has not expired, and — through
the HTTP route — a typed confirmation phrase. The phrase is not a second factor; the session
already authenticated the owner. It is there so the move that stops a person approving each mission
cannot be made by a mis-click on a page somebody was skimming. Reaching for the brake never
requires typing anything.

**Routes:** `GET /api/operator`, `POST /api/operator/mode`.

---

## The charter

The owner's standing authority, written down, versioned and never edited in place.

- **25 capability classes**, ordered by blast radius, from `research.read` to `testflight.dispatch`.
  Each names what it means, whether it writes, how far it reaches, which activation capability it
  needs, and which scope dimensions it _must_ enumerate. `code.change` cannot be granted with
  `repositories: ['*']` — naming three repositories is a small cost; naming all of them by accident
  is not a small consequence.
- **Eight exceptional actions** — moving money, signing an agreement, changing authentication,
  revealing a credential, deleting irreplaceable data, disabling recovery, and two more. These are
  not a category the owner can add to a charter. They are the category a charter cannot hold, and
  `authorize` refuses them under R-AU6 even against a charter that grants everything else.
- **Limits**: daily and weekly spend, mission minutes, attempts, repair rounds, parallel agents,
  and the reserve percentages to keep back in each Claude window.
- **A content digest.** Every authorisation decision records the charter version id _and_ its
  digest, so a later reader can prove the charter was not edited underneath a decision that cited
  it. It is not a signature — anyone who can write the table can rewrite both — but it makes silent
  editing something that shows.

Charters are drafted and activated as two separate owner actions. Writing a document must not
switch Jarvis on. Activation supersedes the incumbent inside one transaction, and a partial unique
index — not the ordering of the statements — is what makes two racing activations unable to leave
two charters in force.

**What the model cannot do:** edit the charter, expand it, change its own permissions, raise its own
budget, add a repository to the allow list, or grant itself a connector. The enforcement is the
absence of a code path, not a flag. Every charter route is an owner route and there is no other kind.

**Routes:** `POST /api/operator/charter`, `POST /api/operator/charter/{id}/activate`.

---

## Standing authority, applied

A charter approval is **not** a shortcut past mission approval. It is `MissionService.approvePlan`
with a different authority. Every check still runs — the mission state, the plan version being
current, the risk level being the one the approver was shown, and `canQueueMission`.

Three things change and nothing else:

1. The recorded authorisation decision is **re-read and re-proved**. `confirmDecision` checks that
   it exists, that it came out `authorized`, that it was made for _this_ mission, and that it cites
   the charter still in force with the same digest. A decision id is a string until somebody looks
   it up.
2. The approval and the mission record which charter said so.
3. The state moves under the `charter` actor, so the timeline shows that nobody was watching.

And one comparison the other checks do not make: **does the authorisation cover what this mission
will actually do?** `coversPlan` derives the capability set from the mission's type and its plan —
never from anything the caller supplies — and refuses a decision that falls short. Without it, an
operator could ask for permission to update a project's status, be granted it, and then run a
mission that rewrites a repository, with every other check passing because nothing had compared the
two.

`manual_task` is refused as a _type_ rather than by an empty capability list, because an empty list
would read as full coverage. No charter grants the ability to do something only a person can do.

`acknowledgedRiskLevel` is deliberately **not** relaxed for a machine. A decision made at T and
applied at T+1 against a mission whose risk changed in between is exactly the staleness that check
was written for; a machine reaches it by deciding early rather than by leaving a tab open.

### The `charter` actor

`charter` is its own mission actor, not a synonym for `owner`. It may make exactly four moves:

- `awaiting_plan_approval → queued`
- `awaiting_plan_approval → planning`
- `failed → queued`
- `failed → awaiting_plan_approval`

It cannot cancel a mission, cannot stop or pause one, and **cannot re-queue a mission a person
stopped** — that last is the one move that would let standing authority overrule a live owner
decision. When the supervisor decides a mission has become a rabbit hole it ends it through
`running → failed`, which the system may already do, and the partial work stays on its branch.

---

## The activation ladder, applied to real work

Phase 4A built the lock and wired it to one caller. That was survivable only while a person
approved every mission and therefore _was_ the gate.

`src/domain/unattended.ts` maps the concrete things a worker is handed onto the capabilities they
consume:

- Every mission needs `model_task_readonly`. A mission type that is not read-only also needs
  `model_task_write` and `github_write`.
- A task's **role** decides whether a model runs and whether it may edit files. `verifier` and
  `integrator` run no model and contribute nothing — not a loophole, because whatever they operate
  on was produced by a builder whose own claim was gated.
- A task's **type** decides where the result goes. `delivery` needs `github_write` and
  `ci_dispatch` needs `ci_dispatch`, regardless of how little model latitude either involves.

Both claim paths now filter inside the one SQL statement that claims — so an unqualified deployment
starts no run it would have to unwind — and assert exactly afterwards, so the filter cannot silently
drift from the mapping. If the assertion ever fires, the claim is unwound and the work goes back to
the queue with the refusal on its timeline.

**Only unattended work is gated.** A mission a person approved is attended, and a qualification
ladder is not entitled to overrule them. This is also why supervised operation is untouched.

---

## Money

A charter limit of "$20 a day" used to be a comparison between one plan's estimate and $20, so
twenty $19 missions would each be authorised and each reported as within budget.

Now:

- Every run writes the spend ledger through `upsertForRun`, which **replaces** one row per run.
  The worker reports a running total, not a delta, so appending would count the same tokens once
  per report.
- An absent cost is recorded as **unknown, never zero**. Zero is a claim that something was free.
- `spendIsMeasurable` refuses to enforce a limit against a total it cannot trust. A charter that
  sets a spending limit on a system that cannot see its own spending is a refusal, not a pass.
- Windows are **rolling**, not calendar days. A calendar day needs a time zone, and a time zone can
  be gamed by spending the limit at 23:00 and again at 00:01.

---

## The operating loop

`POST /api/operator/tick` — bounded, idempotent, lease-protected. Designed to be driven from more
than one place at once: the long-lived worker every few seconds (which is what makes Jarvis feel
continuous), with a schedule as a backstop so a stopped worker degrades to a slow Jarvis rather than
a silent one. The Netlify control plane never runs an agent.

The loop observes, understands, prioritises and — in `supervised` and `operator` mode — starts
work.

### Observe

Every project's deterministic assessment, plus a **coverage record** saying what Jarvis actually
managed to see: `observed`, `stale`, `failed` or `unwatched`.

> A project whose source failed produces no opportunities, which looks exactly like a project with
> nothing wrong. Treating "we saw nothing" as "nothing is wrong" is the single most expensive
> mistake an unattended operator can make, and it is a very easy one to make by accident.

An unobserved project's backlog is deliberately left alone rather than closed as resolved.

### Understand

Opportunities are **derived, never invented**. Every one carries the deterministic rule that
produced it and the evidence ids behind that rule. There is no constructor that takes free text
with no rule attached, because "keep the agents busy" is the failure mode of an autonomous system.

Identity is a hash of what the opportunity is _about_ — project, rule, subject — and never of when
it was noticed or how it was worded, so the same failing workflow seen on twenty consecutive ticks
is one row with a newer `last_seen_at`. `first_seen_at` is never updated: it is what the age factor
reads, and the reason a problem nobody has dealt with eventually rises.

### Prioritise

Four bands: `now`, `next`, `later`, `watch`. The score is **an ordering device with no units** — not
a probability, an expected value, a confidence, or money — and every point it carries is attributed
to a named factor, so "why is this first?" has an answer made of sentences.

Three conditions override the band downwards whatever the arithmetic says:

- **Only a person can settle it.** An operator that "handles" a decision the owner has to make has
  not handled it.
- **Jarvis cannot see the project properly.** Acting on stale or failed observation is acting on a
  guess, and the guess is invisible by the time anything goes wrong.
- **The charter does not name the project.**

`watch` never becomes a mission.

**Routes:** `GET /api/operator/backlog` (the queue and the last twenty ticks, including the quiet
ones), `POST /api/operator/backlog` to dismiss.

### Execute

Every mission goes through `MissionService`, the same path a person's mission takes, so the risk
classification, the project gate, the clarification pass and the state machine all apply unchanged.
A second creation path for autonomous missions would be a second set of guards, and the one nobody
is looking at is the one that drifts.

An opportunity is **claimed before anything is created** — `take` matches only one still `open`, so
two ticks that both selected it cannot both raise a mission. Three things can then happen, and all
three are recorded on the opportunity:

- It becomes a **queued** mission, because the charter authorised exactly what the plan will do.
- It becomes a **proposal** waiting for the owner — either because Jarvis is supervised, or because
  the charter fell short of what the plan turned out to need. That second case matters: the plan is
  only knowable _after_ planning, so an operator that decided authorisation up front would be
  deciding about work it had not yet described.
- It is **declined**, with the reason. Failures are caught per opportunity rather than allowed to
  end the tick: one project with a prohibited request must not stop Jarvis looking after the other
  nine.

**Planning is asynchronous**, so a mission raised on one tick is inspected by a worker and only
becomes approvable on a later one. Each tick therefore finishes what is already in flight before
taking on anything new — otherwise the loop would raise missions forever and run none of them. Only
missions attached to a `taken` opportunity are picked up this way: a mission a person created and
left waiting is theirs, and approving it would be standing authority reaching past what it was
granted for.

An opportunity carries **its own definition of done**, written per topic. An empty one is not a
formality — the clarification pass then asks the owner and the mission waits, which is the correct
outcome. An operator that cannot say how it will know it has finished cannot tell success from
giving up.

The status engine deliberately produces both an attention reason and a recommended action for the
same situation ("Blocked: X" and "Clear the blocker: X"). They share a **topic**, so they become one
opportunity rather than two missions solving one problem — which is exactly the "keep the agents
busy" failure this is meant to avoid.

### Text Jarvis did not write

An opportunity's wording comes from evidence, and evidence comes from repositories. A pull request
title, a workflow name, a branch name and a commit message are all written by whoever opened them,
which on a public repository is anybody.

Under supervision a person reads the mission before anything happens. **Under standing authority
nobody does**, and that text ends up in the prompt of an agent holding a write capability. So it
arrives as quoted data rather than as part of the instruction: bounded, redacted through the same
helper every other boundary uses, delimited, and explicitly labelled as something somebody else
wrote.

That framing is not a guarantee — prompt-level framing never is. The real bound is elsewhere, and it
is worth being clear about what actually holds:

- The **charter** decides which repositories and branches can be touched at all.
- The **activation ladder** decides whether writing is permitted on this deployment.
- **Delivery is a draft pull request and nothing else** — the delivery client has no method that
  could merge, release or deploy, and a qualification check asserts that by reading its shape.
- The **capabilities and the acceptance criteria come from the rule**, never from the observed text.

The framing stops the easy version of the attack. The layers above are what stop the rest.

---

## Knowing when to stop

`src/domain/progress.ts`. **Designed and tested; not yet wired to a running mission.**

Eleven bounded-exploration limits — four from the charter, because they are the owner's to choose;
seven fixed, because an owner should not have to reason about "how many turns before an agent is
looping" to use Jarvis safely.

Ten no-progress signals, every one read from what a mission already recorded rather than by asking a
model whether it thinks it is progressing. _A stalled agent asked that question says yes, sincerely,
every time._

The supervisor's escalation is one-way and shallow: `continue → narrow → escalate`/`stop`, with
`narrow` offered at most once. **There is no outcome that adds an agent.** The tempting fix for "the
builder is stuck" is another reviewer, then a researcher to explain the reviewer, and the result is
a stalled mission that costs four times as much.

Every verdict says what to keep. A mission stopped for going nowhere still produced a branch, a
diagnosis and a list of things that did not work, and the next attempt should not pay for the same
lesson twice.

---

## Claude capacity

`src/domain/claude-capacity.ts`. **Designed and tested; no worker reports telemetry yet**, so the
governor currently resolves to "auth mode unknown, so no subscription window is assumed and money is
the constraint" — which is the honest answer rather than a confident number about a limit that may
not exist.

One rule shapes the module: **absence is unknown, never zero and never unlimited.** Every value
carries whether it was measured, estimated, stale or unknown, all the way to the screen.

Two mistakes it exists to prevent:

- **Summing a shared limit across workers.** Rate limits on a subscription are per _account_. Three
  workers each reporting 42% means the account is at 42%, not 126%. There is no code path that adds
  two utilisation figures together.
- **Applying subscription assumptions to API workers.** A worker on an API key has no five-hour
  window; its constraint is spend. Observations are partitioned by auth mode and never cross.

Unknown capacity **holds** — finish what is running, start nothing new — rather than proceeding or
stopping. Proceeding is how an operator gets rate-limited halfway through a mission it cannot
resume; stopping is how a missing telemetry field silently switches Jarvis off for a day.

Nothing reads a screen or patches a binary. The inputs are documented interfaces.

---

## What is not built yet

Stated plainly so nobody has to discover it by trying:

- **No worker reports Claude capacity**, so the governor has nothing to govern with.
- **The supervisor is not wired to running missions.** `superviseMission` has no caller.
- **Charters and authorisation decisions are not in the owner data export.** They contain no
  secrets and arguably belong there; it was left out of scope rather than decided against.
- **There is no operator interface.** The routes exist; the pages do not.
- **Nothing measures whether the work helped.** Missions are started and finished; no objective,
  experiment or revenue figure is recorded against them, so "did this help?" is not yet answerable.
- **The loop's own no-progress detection is not connected.** A mission that goes nowhere is still
  bounded by the existing per-mission ceilings, but the ten stall signals are not consulted.
