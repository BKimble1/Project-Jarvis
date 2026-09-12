# Jarvis — Phase 1 Implementation Plan

_Phase 1 scope: the Universal Project Registry and the evidence-based Portfolio Status Brain._

## 0. Repository assessment (performed before any change)

The repository contained a single `README.md` and one commit (`Initial commit`). There was no
source code, no package manifest, no CI configuration and no prior conventions to preserve.
Phase 1 therefore scaffolds the application from scratch while keeping the original README
content (project name and intent) in the rewritten README.

## 1. Stack decision

| Concern       | Choice                                                           | Rationale                                                                                                        |
| ------------- | ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Framework     | Next.js 15 (App Router) + React 19                               | Server components enforce authorization on the server, one deployable for UI + API, first-class Netlify support. |
| Language      | TypeScript, `strict` + `noUncheckedIndexedAccess`                | Required by the brief; catches evidence/provenance mistakes at compile time.                                     |
| Styling       | Tailwind CSS v4 + small local UI primitives over Radix           | Calm, dense, accessible, mobile-first; no heavyweight component framework.                                       |
| Validation    | Zod v4                                                           | Runtime validation at every trust boundary (env, HTTP body, GitHub payloads, AI output).                         |
| Database      | PostgreSQL via Drizzle ORM with SQL migrations                   | Durable hosted storage (Neon/Netlify DB) in production; migration-backed.                                        |
| Local/test DB | PGlite (embedded Postgres, same dialect + same migrations)       | A functioning local path with zero external credentials; **never** used in production.                           |
| GitHub        | `@octokit/rest` behind a `SourceProvider` interface              | Read-only, centralised, mockable.                                                                                |
| AI narration  | Optional `@anthropic-ai/sdk`, schema-validated structured output | Fully optional; deterministic narrator is the default and the fallback.                                          |
| Tests         | Vitest (unit + integration on PGlite) + Playwright (E2E)         | One `npm run verify` gate.                                                                                       |
| Deploy        | Netlify (`@netlify/plugin-nextjs`) + scheduled function for sync | Requested target.                                                                                                |

Persistence is behind `ProjectRepository` / `EvidenceRepository` / … interfaces so the provider
can be replaced without touching feature code.

## 2. Layering

```
app/ (UI, thin)          → server actions & route handlers
  └── server/services    → SyncService, StatusEngine, BriefingService, QueryRouter, ActivityLog
        └── server/repositories (interfaces + Drizzle impls)
        └── server/providers   (SourceProvider → GitHubSourceProvider)
              └── server/db (Drizzle schema + migrations)
domain/  pure types, Zod schemas, status rules — no I/O, no React
```

Hard rules enforced by review + tests:

- No business logic inside React components.
- No GitHub call outside `server/providers/github`.
- No `any` as an architectural shortcut.
- Every timestamp stored in UTC; formatted for display on the client.

## 3. Work breakdown

1. **Foundation** — configs, env schema (fail-closed), logger with redaction, error taxonomy.
2. **Data model** — Drizzle schema for projects, sources, goals, milestones, blockers, decisions,
   updates, next actions, evidence, snapshots, sync runs, activity, sessions. Migration generated.
3. **Repositories** — typed interfaces + Drizzle implementations + indexes.
4. **Auth** — GitHub OAuth restricted to one owner, DB-backed server sessions, `requireOwner()`
   guard used by every private page and route handler. Fail closed in production.
5. **GitHub provider** — read-only Octokit client, bounded pagination, per-category degradation,
   rate-limit + error taxonomy, normalisation into evidence records.
6. **Sync service** — per-project advisory lock, idempotent evidence upserts, partial success,
   preserves last-good data, records `sync_runs`, one failure never blocks other projects.
7. **Status Brain layer 1** — deterministic `StatusEngine` (pure, tested rules) producing a
   `ProjectStatusAssessment` with per-claim provenance and freshness.
8. **Status Brain layer 2** — `BriefingNarrator` interface: deterministic narrator (default) and
   optional Anthropic narrator with schema-validated output, evidence-ID grounding, caching by
   evidence fingerprint, safe fallback.
9. **Snapshots & diffing** — persist snapshots, compare meaningful fields for "What changed".
10. **Query router** — deterministic intent routing, fuzzy project resolution, disambiguation,
    execution requests answered with "Prompt 2" guidance.
11. **UI** — sign-in, dashboard, projects index, add/import flows, project detail, What Needs Me,
    What Changed, Settings. Mobile-first, light/dark, PWA.
12. **Testing** — unit, integration (PGlite), Playwright E2E, single `npm run verify`.
13. **Docs** — README, ARCHITECTURE, setup (local/Windows), Netlify, DB, auth, token scopes, security.

## 4. Deliberately out of scope (Prompt 2+)

Mission execution, Claude Code launching, repo writes, branches/PRs, agents, artifacts, approvals,
playbooks, costs, voice, RAG, integrations, billing, multi-user. Extension points only:
`sourceKind` enum is open for new providers, `evidence.kind` is extensible, and the schema reserves
`projects.id` as the join target for future `missions`/`tasks`/`agent_runs` tables.

---

# Jarvis — Phase 2 Implementation Plan

_Phase 2 scope: Mission Control and the first secure Claude worker._

## 0. Repository assessment (performed before any change)

The baseline was recorded before a line was written: **351 unit tests, 63 integration tests, 28
end-to-end tests**, `npm run verify` green in 337 seconds. Phase 2 extends that suite; it does not
replace it.

Two Phase 1 assertions were deliberately changed rather than preserved, because they encoded a
limitation Phase 2 removes:

- `router.answer('Build a new feature')` no longer answers "Jarvis cannot run that yet". It now
  previews a mission. The _guarantee_ underneath — that answering a question creates nothing — is
  still asserted, and more strictly than before (`missions.total === 0`).
- The export payload is `version: 2`, because it now carries mission history.

The end-to-end assertion on the old wording was updated for the same reason.

## 1. Architecture decisions

| Concern                | Choice                                                      | Rationale                                                                                                                                                                                         |
| ---------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Where the agent runs   | A separate long-lived **worker** process                    | A Netlify function is over in seconds; a mission takes minutes. Nothing else about the deployment needed to change.                                                                               |
| Where the worker lives | `src/worker/**` in this repository                          | Both sides compile against the same domain contract, so a protocol change fails one `tsc`. An ESLint rule stops it importing anything but `@/domain`.                                             |
| Transport              | The worker **polls** over HTTP                              | A serverless control plane cannot hold a socket, and cannot dial out to a worker behind a home router. Polling is also correct after a refresh and after a laptop sleeps.                         |
| Live UI                | Bounded polling of an incremental event endpoint            | Same reasoning, plus: the page must be closable without affecting the mission.                                                                                                                    |
| Agent runtime          | The official Claude Agent SDK behind `AgentRuntime`         | Mission logic imports the interface, never the SDK, so every test drives the real flow against a deterministic fake — and a later runtime is a new file, not a rewrite.                           |
| SDK loading            | A dynamic import of an **optional** dependency              | A worker without the package (or without a key) reports "runtime unavailable" honestly instead of crashing, which is what makes "live execution stays visibly unavailable until configured" real. |
| Workspaces             | A fresh **clone** per mission, never a worktree             | A worktree shares `.git` with the owner's real checkout. A clone is slower and completely separable, and avoids Windows worktree/symlink differences.                                             |
| Concurrency            | One mission, enforced inside the claiming SQL               | The schema models several (`mission_runs.attempt`, `workers.max_concurrency`); the product refuses to use them yet.                                                                               |
| Claiming               | One `UPDATE … WHERE id = (SELECT … FOR UPDATE SKIP LOCKED)` | The concurrency check, the queued check and the write are one statement, so two workers cannot both observe "nothing is running".                                                                 |

## 2. What was built, in order

1. `docs/MISSION_CONTROL.md` and `docs/THREAT_MODEL.md` — the plan and the threat model, first.
2. Domain models: mission, state machine, plan, run, worker, wire protocol, redaction, workspace
   safety, risk classification, intake, clarification. All pure, all unit-tested.
3. `drizzle/0001_missions.sql` — twelve tables, applied through the same runner as `0000_init`.
4. Repositories, then `MissionService` (owner-facing) and `WorkerService` (worker-facing).
5. Owner routes through `ownerRoute`; worker routes through a **separate** `workerRoute` wrapper.
6. The worker runtime: policy, git, workspace, verification, delivery, runtime adapters, runner,
   main loop, Dockerfile.
7. Status Brain integration and the extended query router.
8. UI: inbox, start bar, plan review, live run, clarification, workers, attention.
9. Tests at four layers, then documentation.

## 3. Deliberate omissions

Multi-agent missions, automatic merge, direct default-branch push, production deploys,
TestFlight/App Store, self-approval, unbounded repair loops, autonomous recurring missions. Each is
absent by construction rather than by a flag: there is no code path that could do any of them, and
the four-method `GitHubDelivery` interface is asserted at runtime so adding one fails the suite.
