# Jarvis V1 — launch handoff

What was built, what was proved, and exactly what is left for you to do.

Read the honest summary first. Everything below it is detail.

---

## Where V1 actually stands

| State                              | Reached? | What it would take                                         |
| ---------------------------------- | :------: | ---------------------------------------------------------- |
| **Code ready**                     |   Yes    | —                                                          |
| **Locally running**                |   Yes    | `npm run dev` against a database; the E2E suite does this  |
| **Worker connected**               |    No    | Enrol a worker and start it (SETUP_V1 steps 5–7)           |
| **Real Claude qualified**          |    No    | An Anthropic key in the worker's environment               |
| **GitHub read qualified**          |    No    | `GITHUB_READ_TOKEN` on the control plane                   |
| **GitHub sandbox write qualified** |    No    | A sandbox repository and the worker's write token          |
| **Draft pull request delivered**   |    No    | The above, then the write qualification mission            |
| **Display verified**               |    No    | A running deployment and a paired screen                   |
| **Restart verified**               | In code  | Proved by tests; the live rehearsal needs a running worker |

**This is V1-ready, not V1-live.** No credential was available in this environment, so no model
ran, no repository was read, and no pull request was opened. Every live row above is blocked on a
credential and nothing else — the code paths behind them are written, tested against real HTTP
handlers and a real git repository, and waiting.

Do not read "the tests pass" as "it is operational". Those are different claims, and keeping them
different is most of what this system is for.

---

## The topology

One arrangement, described in full in [V1_TOPOLOGY.md](V1_TOPOLOGY.md).

| Role            | Runs on                                         |
| --------------- | ----------------------------------------------- |
| Web app         | Netlify, or any Node host running `next start`  |
| Database        | Hosted PostgreSQL (Neon, Supabase, RDS)         |
| Worker          | A machine that stays on — laptop, mini PC, VPS  |
| Git operations  | The worker. Never the web app                   |
| Browser display | An Android tablet or a Raspberry Pi in Chromium |

The Netlify deployment never runs an agent. A mission is not a request — it clones, runs a model
for minutes, runs a test suite, commits, pushes and opens a pull request, and must survive the
browser tab closing. That is why the worker is a separate long-lived process, and it is why the
credentials it holds never appear in the control plane's environment.

### Commands

```bash
# Start
npm run db:migrate && npm run start      # control plane (Netlify does this on deploy)
npm run worker                           # worker, on its own machine

# Stop safely — SIGTERM drains: the current mission finishes and reports honestly
Ctrl-C  /  systemctl stop jarvis-worker

# Update
git pull && npm install && npm run db:migrate    # then restart the worker, redeploy the site

# Diagnose
npm run doctor                # every check, one pass, exits non-zero if Jarvis cannot operate
npm run worker:health         # the worker's own view of itself
npm run worker:workspaces     # what is preserved on disk
npm run qualify               # the ladder, and what each rung would take
```

### Where the data is

All of it is in PostgreSQL, at `DATABASE_URL`. The worker's disk holds mission workspaces, which
are working copies rather than records. Backups and the restore drill are in
[RECOVERY.md](RECOVERY.md); a backup nobody has restored is a belief, and qualification treats it
as one.

---

## Credentials — where each lives, and nowhere else

Values are never in this document, in the repository, or in any log. This is the map.

| Credential                   | Set on               | Reaches a model? |
| ---------------------------- | -------------------- | :--------------: |
| `SESSION_SECRET`             | Control plane        |        No        |
| `DATABASE_URL`               | Control plane        |        No        |
| `GITHUB_OAUTH_CLIENT_SECRET` | Control plane        |        No        |
| `GITHUB_READ_TOKEN`          | Control plane        |        No        |
| `CRON_SECRET`                | Control plane        |        No        |
| `ANTHROPIC_API_KEY` (Ask)    | Control plane        |        No        |
| `ANTHROPIC_API_KEY` (worker) | Worker               |    **Yes** ¹     |
| `JARVIS_WORKER_TOKEN`        | Worker               |        No        |
| `JARVIS_WORKER_GITHUB_TOKEN` | Worker               |        No        |
| Display token                | The screen's browser |        No        |

¹ The only one, because the agent cannot work without it. Every other variable is removed from the
environment handed to the agent process — by name for the ones Jarvis defines, and by value shape
for ones it cannot know the names of, so an owner's own `MY_GH_PAT` does not travel either
(`src/worker/child-env.ts`).

### GitHub scopes

**Read token** (control plane): Contents read-only, Metadata read-only, on the repositories you
choose. Nothing else.

**Worker write token**: Contents read/write (push a branch), Pull requests read/write (open a
draft). Not Administration, Secrets, Environments, Actions, Workflows, Webhooks, Deployments or
Packages — Jarvis contains no code that could use them, and the delivery client has five methods,
three of which write.

**Second lock**: `JARVIS_WORKER_ALLOWED_REPOS` on the worker refuses delivery to anything not on
it, before a request is made.

### Sandbox repository

Not yet chosen. `JARVIS_QUALIFICATION_REPOS` is empty, so no live write can be attempted at all —
which is the safe default rather than an oversight. Choose a **new, empty, private** repository,
allow-list it, then `npm run qualify -- sandbox you/jarvis-sandbox`.

---

## What was verified

### Automated verification

Complete suite, run against real HTTP handlers, a real local git repository and an embedded
database. No live model, no real GitHub.

| Suite                           | Result                                  |
| ------------------------------- | --------------------------------------- |
| `npm test` (unit + integration) | 1177 tests across 32 files, all passing |
| `npm run test:e2e` desktop      | 49 passed, 4 skipped                    |
| `npm run test:e2e` iPhone       | 47 passed, 6 skipped                    |
| `npx tsc --noEmit`              | Clean                                   |
| `npx next lint`                 | Clean                                   |
| `npx prettier --check`          | Clean                                   |

The end-to-end suite runs as two Playwright invocations, one per browser project. That is the
topology Phase 4C stabilised over five consecutive clean runs, and `npm run verify` now runs it the
same way so the two cannot drift apart.

The skipped cases are deliberate: the mission smoke test and the viewport sweep each run once, under
the desktop project, because they prove a backend property and set their own viewports respectively.
Each says so in the file.

### Diagnostics

`npm run doctor` was run against a scratch database with no credentials configured. It reported
correctly: runtime and database working, migrations applied, access settings present-but-unproved,
and every credential-dependent check as **not configured** with the exact next action — never as a
pass. Its exit status was non-zero, as it should be when no worker is enrolled.

### Live qualification

| Test                       | Result                                            |
| -------------------------- | ------------------------------------------------- |
| A — live read-only mission | **Not attempted.** No Anthropic key available.    |
| B — live Ask               | **Not attempted.** No Anthropic key available.    |
| C — live write mission     | **Not attempted.** No key, no sandbox repository. |
| D — restart recovery       | **Proved in tests, not rehearsed live.**          |

No result above was simulated, inferred, or written down as though it had happened.

Test D's properties are covered by tests that drive the real mission runner and the real state
machine: a restarted worker resumes rather than failing its mission; a run interrupted at the pull
request delivers without re-running the agent; a mission already stopping is confirmed stopped
rather than resumed; and delivery adopts an existing pull request instead of opening a second.

---

## Known limitations

- **Nothing is live-qualified.** The ladder is at "built". Every capability the activation lock
  gates is held back, which is the lock working, not a fault.
- **The CI dispatch and TestFlight paths require "production"**, which needs live read, live
  write, a recovery drill and a security review. They are unreachable until then, deliberately.
- **`/api/health` (owner POST) and `npm run doctor` walk the whole ladder**, which reaches GitHub.
  Expect them to take a minute rather than a second; that is why the Operations panel puts them
  behind a button.
- **Recently-finished missions on the landing page** are the newest-created terminal missions
  re-sorted by finish time across a window, not a true "most recently finished" query. A mission
  created long ago and finished yesterday can fall outside the window.
- **An ambiguous project name loses its preview.** Handing a project from the command bar to
  `/missions` carries the id, but `POST /api/query` accepts only the question text, so the
  preview is re-derived without it and hits the same ambiguity. The words survive; the preview
  does not.
- **Semantic retrieval is off by default.** Without `JARVIS_KNOWLEDGE_EMBEDDINGS`, retrieval is
  lexical — honest rather than degraded, but worth knowing.

## Deferred to V2

Explicitly out of scope for this release, and not started: the durable scheduler and delta-focused
briefings, notifications with redacted payloads, voice capture, cost accounting and enforceable
budgets, the connector framework, and multi-user access. Autonomous unattended execution stays
behind the activation lock regardless.

---

## What is left for you to do

In order. Each step is written out in [SETUP_V1.md](SETUP_V1.md).

1. **Create the database** and run `npm run db:migrate` (steps 1–2).
2. **Configure owner sign-in** and sign in (step 4).
3. **Enrol a worker**, put its token and an Anthropic key in the worker machine's environment, and
   start it (steps 5–7).
4. **Add `GITHUB_READ_TOKEN`** to the control plane and connect one project (step 8).
5. **Create an empty private sandbox repository**, add it to `JARVIS_QUALIFICATION_REPOS`, give the
   worker a write token scoped to it and `JARVIS_WORKER_ALLOWED_REPOS` naming it (steps 9–10, 12).
6. **Run `npm run doctor`** and resolve anything it names (step 11).
7. **Qualify read-only, then Ask, then write** (steps 13–15), recording each with
   `npm run qualify -- record-live <missionId> read|write`.
8. **Restart the worker mid-mission once**, deliberately, and confirm the mission resumes rather
   than failing (this is Test D, live).
9. **Pair a display** and follow [WALLBOARD.md](WALLBOARD.md) (step 17).
10. **Turn on backups and rehearse a restore**, then record it (step 19,
    [RECOVERY.md](RECOVERY.md)).

Only after 7 will Jarvis be live-qualified, and only after 10 will it be production-qualified.
Until then it will tell you so on every screen that matters, which is the point.
