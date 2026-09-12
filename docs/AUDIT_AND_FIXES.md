# System audit, and what it changed

A full pass over the running system, looking for anything that would stop it working — not a
review of the code, but a search for things that were already broken. Everything below was
reproduced against the real application before being changed, and every fix has a test that fails
when the fix is reverted.

The baseline is `07ec0465`. Everything here is on top of it.

## What was actually broken

Ordered by how likely you were to meet it.

### It would not start from the documented setup

`cp .env.example .env.local`, which three documents tell you to do, produced a Jarvis that
answered every page with a blank 500. `dotenv` turns a bare `KEY=` line into the empty string,
`z.enum([...]).optional()` accepts `undefined` and not `''`, and `buildConfig` throws while a page
is rendering. A blank value now means unset, everywhere, for both the control plane's schema and
the worker's.

The same shape had a quieter version. `PGLITE_DATA_DIR=` was a configured data directory to the
config, no directory at all to the PGlite client, and "survives a restart" to the readiness
report — three answers, and you were shown the reassuring one while the database was in memory.

### The scripts read the wrong file, and one never exited

Every `scripts/*.ts` said `import 'dotenv/config'`, which reads `.env` and nothing else, while the
setup documents tell you to create `.env.local`. So `npm run doctor` reported no owner and no
OAuth beside an application running fine on the same machine — and `npm run db:migrate` with
`DATABASE_URL` in `.env.local` migrated the local PGlite instead and exited 0 reporting success.

`npm run doctor` also never returned: PGlite holds the event loop open until its client is closed.
The first run against a fresh directory finished; every run after that had to be killed.

### Signing in was optional

Every page under `(app)` was guarded by its layout, and a React Server Component request skips the
layout. With no cookie at all, `/portfolio` returned 50 KB of the real page and `/settings`
123 KB — projects, missions, connection names. Each page now guards itself, and a test walks the
directory to make sure a page added tomorrow does too.

### The agent could read the key the vault exists to protect

The worker strips credentials from every child process by name and by shape. Five credentials had
been added to Jarvis since that list was written, and none of them looks like a token:
`JARVIS_CREDENTIAL_KEY` (which encrypts the Microsoft refresh token at rest), its previous
version, both OAuth client secrets, and the push signing key. The agent has Bash and nothing
blocks `env`. They are named now, and a `JARVIS_`-prefixed variable whose name contains SECRET,
TOKEN, KEY, PASSWORD or CREDENTIAL is stripped by default.

### Work stopped and stayed stopped

- **A charter with a spending limit refused every plan.** The operator offered no estimate, and
  "I don't know" must not be the cheapest possible answer, so `checkLimits` refused. Setting
  `dailySpendUsd: 20` meant nothing was ever approved again.
- **A subscription worker made the ledger unmeasurable.** Its runs carry tokens and no money by
  design, so one run made the window 100% unpriced and the same limit refused everything. Runs now
  carry which credential paid, and a subscription run is recorded as a measured zero rather than a
  missing figure.
- **Three finished pull requests pinned the mission ceiling at zero.** `pull_request_ready` is the
  _successful_ ending of a write mission and was being counted as a slot in use. The loop reported
  "Every mission slot is in use." with nothing running.
- **Missions could not end.** A task parked in `awaiting_review` or `repair_required` is not
  terminal and nothing moves it, so the mission stayed open for ever; and a mission whose tasks all
  failed before a worker claimed one never became `running`, so no terminal branch applied.
- **Pause did not pause.** `WorkerService.claim` read no mode at all, and the task protocol had no
  gate either.

### Live workers had their work taken away

The reclaim sweep measured its ten-minute window against the _task's_ silence, and a task is quiet
for as long as its agent is thinking — tens of minutes on a real session, with nothing wrong. So
the only thing between a running agent and having its task re-queued under another worker was a
two-minute gap in heartbeats, which a closed laptop lid crosses. The window is measured on the
heartbeat now.

The mirror image was also true: a worker that crashed and was restarted came back with no memory
of the task, beat immediately, and so kept the task for ever. The heartbeat says which run a
worker is executing, and a worker that names a different one has let go.

A worker also established `runtimeAvailable` and `workspaceHealthy` once at boot and never again,
so a Claude login that expired at lunchtime left it heartbeating "available" while refusing every
claim in silence.

### Reminders were never delivered

`/api/cron/schedules` was written, documented, and called by nothing — no timer, no worker loop, no
scheduled function. Every reminder you set was accepted, stored, and never delivered, while the
interface said it was on. The operating loop takes the pass now, because the enrolled worker
already drives it on a timer.

Three more faults in the same machinery: one schedule that threw aborted the whole pass, a snooze
was consumed by a delivery that failed (which stops that schedule permanently), and two callers
both did the work.

### Chat could not hear its own question

The first message describing something to build creates the project and the mission and then asks
one question — "Before I start: how will you know this is done and right?" — in the conversation.
Typing the answer back did nothing. The screen read it against the numbered list, could not pin it
to a row, and never sent it; and when it did reach the server, an ordinary sentence is a question,
so the status router looked for a project by that name and answered "no matching project".

### A pool of workers ran the same mission several times

`JARVIS_WORKER_POOL=3` spawned three processes with the same token. A token names one enrolled
worker, and `claim` hands a worker that already holds a run that same run back — so all three were
handed one mission and ran three agent sessions over one checkout, while the log said
"3 worker(s)". Each child needs its own token now, and the supervisor runs the number it has.

### Smaller things

- The numbers shown on the screen and the numbers a typed reply counted were off by one, so "1"
  opened whatever was second.
- A file-backed database in a directory that did not exist yet failed to open on a fresh clone.
- An error's HTTP status was read out of the message text as a retry verdict, and process exit
  codes were being read as HTTP statuses.
- A batch of announcements spoke only its last line, because each `speak()` cancels the one before.

## What was looked at and left alone

Several things named in earlier notes turned out to be right already, and saying so is part of the
record: the four retry mechanisms are deliberately layered and do not multiply; `percentage()`
refuses out-of-range telemetry rather than clamping it; the capacity governor really does narrow
the operator's ceiling rather than only being displayed; replies are already one or two sentences.

## What is still known to be wrong

Not fixed, and not hidden. In rough order of how much they matter.

- **A mid-conversation change is answered as a status question.** "Actually make the background
  dark" while a mission is planning gets "X is active, but I have no evidence of work in progress"
  rather than being attached to the work.
- **`ASSUMED_MISSION_SPEND_USD` is re-offered within one tick** against a total that cannot have
  moved, so a tick can authorise more assumed work than the daily limit allows. Bounded by the
  tick's room ceiling, and the measured total catches up.
- **`npm run db:generate` emits a destructive migration**; the generated SQL needs reading before
  it is applied.
- **`/projects/[id]` and similar routes answer 500 for a non-UUID id** rather than 404.
- **A mission with no project cannot be repaired from the interface.**
- **Retention windows are configured and not enforced**; the idempotency table is never purged.
- **The briefing says "Nothing changed in this window."** unconditionally, and the greeting is
  computed in UTC.
- **Session revocation is documented incorrectly.**

## How it was verified

`npm run verify` — format, lint, type check, 1558 unit tests, 619 integration tests, a production
build, and the end-to-end suite on desktop and iPhone — passes.

Beyond the gate: `npm run dev` on `http://localhost:3000` from an empty data directory, signed in,
an idea typed into the dashboard creating a project and a mission, the question answered in the
conversation, "Evaluate only:" creating nothing; `npm run doctor` returning; and
`npm run worker:supervise` connecting an enrolled worker and claiming work.
