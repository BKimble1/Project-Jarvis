# Mission Control — architecture

Phase 2 adds the first way for Jarvis to _take action_. Phase 1 could only observe. This document
is the architecture note for that change: what runs where, why each boundary exists, and what is
deliberately still impossible.

## The two processes

```
   ┌──────────────────────────────────────┐        ┌────────────────────────────────────┐
   │  Jarvis Control Plane                │        │  Jarvis Worker                     │
   │  (Next.js, Netlify, serverless)      │        │  (long-lived Node process)         │
   │                                      │        │                                    │
   │  owner auth · projects · missions    │◀──HTTP─│  claim → workspace → agent → PR    │
   │  plans · approvals · commands        │  bearer│                                    │
   │  events · artifacts · Status Brain   │──────▶ │  Claude Agent SDK                  │
   │  worker registry · mission queue     │        │  git · verification · GitHub write │
   └──────────────────────────────────────┘        └────────────────────────────────────┘
              │                                                   │
              ▼                                                   ▼
        PostgreSQL (shared durable state)                Isolated workspace root
```

The control plane never runs an agent. A Netlify function has a request timeout measured in
seconds; a mission takes minutes. Everything long-lived happens in the worker, and everything
_authoritative_ happens in the database.

The worker is a client, not a peer. It polls, it reports, and it is told what to do. It cannot
decide that a mission is approved, cannot pick a project, and cannot tell the control plane which
project a mission belongs to — the control plane re-reads that from its own tables on every call.

## Why polling, not push

The control plane is serverless: it cannot hold a socket open, and it cannot dial out to a worker
that may sit behind a home router. So the worker polls. `POST /api/worker/poll` is one round trip
that returns the worker's current assignment plus any pending owner commands, and doubles as the
heartbeat. The default interval is 3 seconds while idle and 1 second while a mission is active,
which is well inside the "updates within a few seconds" requirement and costs almost nothing on a
single-user instance.

The browser uses the same idea for the same reason: the mission detail screen polls a bounded
`GET /api/missions/:id/stream?after=<seq>` for new events. No socket to lose, correct after a
refresh, and the page can be closed without affecting the mission at all.

## Where the worker lives in the tree

`src/worker/**`, not a separate package. One `tsconfig.json`, one ESLint config, one test runner,
one `@/` alias, and the domain contract types (`src/domain/mission*.ts`) are literally the same
files both sides compile against — a protocol change that breaks the worker fails `tsc` in the
same run. Next.js only bundles what the app imports, so nothing under `src/worker` reaches the
browser build.

An ESLint rule enforces the direction of the dependency: `src/worker/**` may import `@/domain/**`
and nothing else from the application. It has no database handle, no session store and no
`getConfig()`.

## Mission lifecycle

```
draft ─▶ resolving_project ─▶ needs_clarification ─▶ inspecting ─▶ planning
                                                                     │
                                                                     ▼
   cancelled ◀───────────────────────────────────── awaiting_plan_approval
                                                                     │ owner approves this version
                                                                     ▼
                                                                  queued
                                                                     │ worker claims (atomic)
                                                                     ▼
                             claimed ─▶ preparing_workspace ─▶ running ─┬─▶ waiting_for_permission
                                                                        ├─▶ waiting_for_input
                                                                        ├─▶ pausing ─▶ paused ─▶ resuming
                                                                        ├─▶ verifying
                                                                        ├─▶ creating_pull_request ─▶ pull_request_ready
                                                                        ├─▶ stopping ─▶ stopped
                                                                        └─▶ failed / completed
```

Transitions are a table, not a convention: `assertTransition(from, to, actor)` in
`src/domain/mission-state.ts` rejects anything not listed, and records who is allowed to make each
move. A worker cannot move a mission to `completed` from `queued`; an owner cannot move one to
`running`. Every accepted transition writes a `mission_events` row.

Because the table is strict, the worker only names a state when it genuinely has something to say
about one. A report carrying an agent session id or a token count omits `missionState` entirely,
and the control plane records the metadata without touching the state machine. Re-asserting the
last state instead would be wrong twice over: during a read-only inspection it would claim
`running`, which `inspecting` has no move to, and mid-run it would read as a `pausing → running`
move and silently cancel an owner's pause.

Guards live beside the table as pure predicates so they can be unit-tested without a database:

| Guard             | Rule                                                                                                                                                                                       |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `canQueue`        | approval exists **for the current plan version**; project not archived; paused project needs an explicit override; risk is not `prohibited`; `high` risk needs a reduced, review-only plan |
| `canClaim`        | state is `queued`; approved version still current; no other mission occupies the concurrency limit                                                                                         |
| `canPostRunEvent` | the run belongs to the claiming worker and is the mission's active run                                                                                                                     |
| `canResume`       | mission is `paused` (never `stopped`); plan version unchanged; worker healthy                                                                                                              |

## Plans and approval

A plan is an immutable row. Editing produces version _n+1_ and revokes any approval attached to
version _n_ — approval is stored against a specific `(missionId, planVersion)` pair and checked
again at claim time, so a plan edited between approval and execution cannot run.

Two things can produce a plan:

1. **Worker inspection** (the real path). The mission enters `inspecting`; the worker claims an
   inspection run, clones the repository read-only, and runs the agent in a permission mode where
   every mutating tool is denied. It submits the plan through `POST /api/worker/missions/:id/plan`.
2. **Deterministic draft** (the fallback). If no worker is connected — or no Anthropic credential
   is configured — the owner can generate a plan from Jarvis's own evidence. It is labelled
   `inferred`, says so on screen, and is fully editable. This keeps the flow honest and usable
   before the worker exists rather than pretending a plan was researched.

No agent approves its own plan. Approval is an owner-authenticated, same-origin `POST` that
records owner identity, plan version, timestamp, approved risk level, approved scope and an
optional note.

## Isolated workspaces

One clone per mission, under a configured `JARVIS_WORKER_WORKSPACE_ROOT`, at
`<root>/<missionId>/repo`. Not a worktree of the owner's checkout: a worktree shares `.git`, and a
mistake there is a mistake in the owner's real repository. A fresh clone is slower and completely
separable, and on Windows it avoids the worktree/symlink edge cases entirely. Prompt 3 can revisit
this when several agents need to share a fetch cache.

Read-only inspection uses `<root>/<missionId>/inspect` rather than `repo`, because a mission is
normally inspected and then executed: one directory for both would mean every execution run found
the planning clone in its way.

Every path the worker touches is resolved and re-checked against the root
(`assertInsideWorkspace`), so `../` in a mission, a plan or a tool argument cannot escape. Cleanup
is an explicit owner action, never automatic, and never on a branch that is not merged.

## Git and delivery

The worker's git wrapper is an allow-list, not a filter. It runs a fixed set of subcommands with
argument arrays (never a shell string), and `assertPushAllowed` rejects, before `spawn`:

- any push whose ref is not exactly the mission branch,
- any push to the recorded default branch,
- `--force`, `--force-with-lease`, `+refspec` and `--delete`,
- `push --mirror`, `--all` and `--tags`.

`GitHubDelivery` has four methods — push the mission branch, open a draft PR, update that PR's
body, read check status. There is no merge, no release, no deployment, no settings and no secrets
method to call, and a test asserts that at runtime by inspecting the prototype.

## Runtime adapter

`AgentRuntime` (`src/worker/runtime/types.ts`) is the only thing mission code knows about Claude:

```ts
start(session) → AgentSessionHandle
handle.events   → AsyncIterable<AgentEvent>   // message, tool_use, tool_result, permission, usage, done, error
handle.send(text)
handle.interrupt()
handle.sessionId
```

Two implementations ship: `ClaudeAgentRuntime` (the official `@anthropic-ai/claude-agent-sdk`,
loaded through a dynamic import so a missing package degrades to "runtime unavailable" instead of
a crash) and `ScriptedRuntime` (deterministic, used by every automated test). Mission logic imports
neither directly — the factory picks one from configuration.

The Anthropic credential belongs to the worker process and is never sent by the control plane,
never included in a mission prompt, and never written to an event, artifact, transcript or export.

## What Prompt 2 still cannot do

No multi-agent missions, no automatic merge, no direct default-branch push, no production deploy,
no TestFlight or App Store, no self-approval, no autonomous repair loop, no recurring missions.
One mission runs at a time. Those are Prompt 3's problem, and the schema leaves room for them
(`mission_runs.attempt`, `workers.max_concurrency`) without inviting them.
