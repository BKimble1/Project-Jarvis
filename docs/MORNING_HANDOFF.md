# Morning handoff

What changed overnight, what was verified, what was not, and the exact commands to run.

Branch: `claude/jarvis-registry-status-brain-qytwy3`.

## What this branch now contains

Two branches had diverged from `64af7de` and both had fixed the same bug. They are now one history.

- `db181d4` — the screen: five destinations, the dashboard composition, honest state, one Send.
- `d7d3a52` — the handoff repair: the build brief, the naming fix, and `repair:project-name`.

Both are ancestors of the tip. Nothing was force-pushed and nothing went near `main`.

## The QuickPick handoff

The failure was: "Re-evaluate my QuickPick idea using Claude … Do not build anything yet." then
"Go ahead", which produced a project called **Yet**, a private repository `yet`, and a mission whose
objective was the request to evaluate it — which then asked whether it should be researched or
implemented.

Five defects, all fixed and all pinned by tests:

| What went wrong                                                                                                | Where it is fixed                                                                                |
| -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| The prohibition named the project. "Do not build anything **yet**" held the only creation verb in the message. | `deriveProjectName` drops instruction sentences before reading a name out of them.               |
| The name the owner wrote was never preserved.                                                                  | Four ordered readings; `QuickPick` survives as written.                                          |
| The agreed V1 was wiped whenever the idea was described again.                                                 | `open` no longer overwrites the evaluation's lists with the empty ones a fresh proposal carries. |
| The evaluation request became the mission objective.                                                           | `buildBrief` composes an objective for the build from the assessment.                            |
| "Researched or implemented?" was asked of a build already agreed.                                              | Not asked when the mission already carries acceptance criteria.                                  |

Two further holes found on the way:

- `describesNewProject` read "Do not build an app yet" as a request to build an app. That is the
  guard standing in front of the one act that creates a repository on your account.
- Two different phrasings of one idea opened two proposals, so "go ahead" had two things it could
  mean. Ideas are now keyed on the product they name.

The `Yet` project and `BKimble1/yet` were not touched. Repairing them is a deliberate act with its
own command, below.

## The screen

**Five destinations** — Jarvis, Work, Knowledge, Connections, Operations — on a collapsible rail,
with a five-tab bar on the phone.

No route was deleted. Every one of the thirteen former destinations is still a route inside `(app)`
and therefore still behind the same `requireOwnerPage`. Two of them (`/settings`, `/setup`) were
linked from nowhere but the old rail, and two more (`/attention`, `/changes`) from nowhere but the
dashboard; Operations and Work now carry those links, and an end-to-end test walks to each of them.

| Destination | Route          | What it absorbed                                                 |
| ----------- | -------------- | ---------------------------------------------------------------- |
| Jarvis      | `/dashboard`   | `/ask` (the conversation is the dock)                            |
| Work        | `/work`        | `/portfolio`, `/projects`, `/missions`, `/attention`, `/changes` |
| Knowledge   | `/knowledge`   | —                                                                |
| Connections | `/connections` | —                                                                |
| Operations  | `/operations`  | `/workers`, `/setup`, `/settings`, `/operations/qualification`   |

**The dashboard.** Four status pills that said one fact four times are now one mode control and one
status indicator with an unresolved-issue count; the permanent full-width readiness banner opens
from that indicator instead. The core is bounded to 369–480px at the two desktop sizes rather than
272px on the laptop and 600px+ on the monitor. The right column leads with one decision card and
then real deliverable cards. A work row opens a drawer beside the core rather than navigating away.

**Honest state.** A healthy Supervised deployment is no longer painted amber end to end — `limited`
now means capacity is genuinely withheld, and `paused` and `failed` are their own states. Three
capacity dials for an unmeasured subscription are one line: _Usage unavailable · one task at a time_.

**Reasoning.** An in-flight question survives a reload: the dashboard reads the standing proposal
and its reasoning state on the server. A blocked question keeps being watched, so starting the
worker finishes the thought without asking again — which the copy already promised and the screen
did not deliver.

**One Send.** The dock had "Ask" and "Send as spoken". The second was not decoration: a transcript
arrives as an editable draft, and that button was its only route to the voice gate. There is now one
button that follows the origin of the words and relabels itself, so no authorisation step was lost.

## Exact commands

### 1. Update and launch, without touching `.env.local` or your data

```bash
cd ~/Project-Jarvis            # wherever your checkout is
git fetch origin claude/jarvis-registry-status-brain-qytwy3
git checkout claude/jarvis-registry-status-brain-qytwy3
git pull --ff-only origin claude/jarvis-registry-status-brain-qytwy3
npm ci
npm run dev
```

`npm ci` does not touch `.env.local`, and PGlite keeps your data in `.jarvis-data/dev`. There is no
migration step for a local PGlite database — it migrates itself on start. `npm run db:migrate` is
only for a hosted database.

If `git pull --ff-only` refuses, you have local commits; `git log --oneline HEAD..origin/claude/jarvis-registry-status-brain-qytwy3`
will show what is waiting, and a plain `git merge` will bring it in without discarding yours.

### 2. Start the worker and confirm it

In a second terminal:

```bash
cd ~/Project-Jarvis
export JARVIS_WORKER_TOKEN=jarvisw_…    # the enrolment token from Operations → Workers
npm run worker:health                   # configuration, runtime, workspace
npm run worker                          # leave it running
```

Then on the dashboard, the status indicator in the top strip should read **All clear** rather than
**No worker**. Click it for the readiness detail.

### 3. Prove reasoning end to end, without building anything

```bash
npm run worker:think
```

Then on the dashboard, say the real sentence and watch the drawer open while it thinks:

> Re-evaluate my QuickPick idea using Claude: two choices, one randomly selected with a clean
> animation. Give your assessment and the smallest useful V1. Do not build anything yet.

Nothing is created by this turn. Reload the page while it is still thinking — the question and its
state come back, which is the reconnection that did not exist before.

### 4. Say "Go ahead" once

Expect a project named **QuickPick**, a repository slug `quickpick`, and a mission titled
_Build the first version of QuickPick_ whose objective is an instruction rather than your
evaluation request. If the deployment is Supervised, the plan waits for you and the reply says so.

### 5. Say "Go ahead" again

Nothing new is created; it names the same mission.

## Repairing the "Yet" project

Dry run first — it changes nothing without `--apply`:

```bash
npx tsx scripts/repair-project-name.ts --project="Yet" --name="QuickPick"
```

Then apply:

```bash
npx tsx scripts/repair-project-name.ts --project="Yet" --name="QuickPick" --apply
```

It renames in place and refuses rather than guesses. It will not delete anything, will not create a
second project, and will not rename the repository on GitHub — that is a deliberate act with
consequences for anything already cloned, and the provisioning credential is scoped to create
rather than rename. It prints the exact GitHub steps; once you have renamed
`BKimble1/yet` → `BKimble1/quickpick` in the repository settings, re-point the source row:

```bash
npx tsx scripts/repair-project-name.ts --project="QuickPick" --name="QuickPick" \
  --repository=BKimble1/quickpick --apply
```

A mission that has already run is left alone: changing its objective underneath its own history
would make the record a lie.

## The autonomous operating mode

Four pieces were built on top of the screen work. Each is verified by the repository's own gate;
none of them is the whole brief, and what is missing is named at the end.

**A persisted operating state machine.** One row per idea, from the sentence to the thing it
produced: `captured → evaluating → waiting_for_input → approved → planning → executing → verifying
→ delivered`, plus `blocked`, `needs_decision`, `paused`, `failed` and `cancelled`. It exists
because a mission state starts at `draft`, which is already past the part you ask about — between
your sentence and a mission there is an evaluation, possibly a question, an approval, and the
project and repository the mission needs. Every step is a row carrying the proposal, project and
mission ids, so the screen asks "where is _this_ idea" rather than "what happened most recently".

**Two ideas never mix.** `operating_states.proposal_id` is unique, and every answer is routed by the
request's own proposal id rather than by recency. `tests/integration/two-ideas.test.ts` runs
QuickPick and Pomodoro in both orders through the real queue, lease and worker claim-and-report
pair, including across a worker restart.

**Progress is said once.** The page cannot decide what it has already spoken — two tabs are two
pages and a refresh is a third with no memory — so `POST /api/operating/events` returns only the
rows whose `spoken_at` this request won. Nothing is claimed while read-aloud is off or the
microphone is open, because a sentence marked spoken but never said is lost. Reading aloud now
defaults to on and is remembered.

**An approval policy you can configure.** Eight categories at `GET`/`PUT /api/operating/policy`,
each carrying the sentence saying what pre-authorising it permits, with `spend`,
`credential_change` and `destructive_delete` marked irreversible. Off by default. When routine
plans are allowed, low-risk work is approved through `approvePlan` rather than around it — the
version check, the risk acknowledgement and the queue guard all still run — and the approval is
recorded under a `policy` authority so it is never mistaken for one you read.

### What the live test proves

`npm run test:live` runs two tests against the real Claude subscription with no API key set. The
second one puts two ideas in through the route the browser posts to, has a real worker process
answer both with the real runtime, and asserts that the two judgements differ, that each idea's
trail names only itself, and that claiming the spoken events a second time returns nothing.

### What it does not prove

The GitHub leg. `GITHUB_PROVISION_TOKEN` is not set in the environment this was built in, so no
real repository was created by these tests. `tests/live-github/provisioning.live.test.ts` covers it
and needs your credential.

## What was not done, and why

- **No running or completed state was photographed.** The demo seed deliberately refuses to fabricate
  a running mission, because a mission cannot be running without a worker genuinely holding it. The
  captured states are the ones that honestly exist in a sandbox with no worker: calm, needs-a-decision,
  and disconnected. Working, completed-with-artifact and speaking states need your machine with a
  real worker attached.
- **No screenshot or preview action on result cards.** Artifacts in this system are text columns —
  `ARTIFACT_KINDS` has no screenshot or preview kind — so a Preview button would have been a label
  with nothing behind it. Result cards offer _View pull request_ only where `pullRequestUrl` exists.
- **No per-agent pause or resume in the work drawer.** The task API accepts `skip`, `cancel` and
  `retry` and nothing else. Pause, resume, stop, retry and cancel are offered at mission level,
  where they are real, and derived from the same state table the server validates against.
- **The core unmounts when you leave the dashboard.** It stays mounted across panel changes,
  drawers and fullscreen, which is what was asked for; keeping it mounted across destinations would
  mean rendering it on Work and Knowledge too.
- **Voice was not tested on hardware.** No microphone, speaker or browser speech engine exists in
  the sandbox. The contracts around them are tested; the devices are not.
- **`/display` was not re-tested by hand.** It was not modified, and its boundary tests still pass.
- **No worker supervisor.** Nothing restarts a dead worker, there is no worker pool, and there is no
  mission-level lease — a worker that dies holding a mission leaves it claimed. `scripts/jarvis-live.mts`
  is a foreground development launcher that dies with its terminal.
- **No reminders, and no scheduler.** There is no reminder model at all. The `schedules`,
  `schedule_executions`, `briefings` and `notifications` tables exist and have no callers, so this is
  wiring rather than building from nothing.
- **Outlook write and Apple are not connected.** Outlook _read_ is real. Apple calendar and reminders
  cannot work through an Apple API from Windows or WSL — the connection catalogue documents this and
  designs an inbound bridge instead — so nothing was built that would claim otherwise.
- **Memory is not read during planning**, tool actions are not written to `audit_events`, and App
  Store Connect still shows a Connect button that leads nowhere.

## What was proved, and by what

- **Real Claude subscription:** not exercised here. No worker ran in this environment, so every
  reasoning path was tested through the scripted worker harness the suite already uses.
- **Real GitHub:** not exercised. Repository provisioning was tested through the recording
  provisioner and, separately, an opt-in live test that is not run by the gate.
- **Real microphone or speaker:** not exercised.
- **Everything else:** the repository's own `npm run verify` on the final tree — format, lint, type
  check, unit, integration, a production build, and the Playwright suites at desktop and phone.
