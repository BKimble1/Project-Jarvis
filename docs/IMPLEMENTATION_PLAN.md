# Jarvis — Phase 1 Implementation Plan

_Phase 1 scope: the Universal Project Registry and the evidence-based Portfolio Status Brain._

## 0. Repository assessment (performed before any change)

The repository contained a single `README.md` and one commit (`Initial commit`). There was no
source code, no package manifest, no CI configuration and no prior conventions to preserve.
Phase 1 therefore scaffolds the application from scratch while keeping the original README
content (project name and intent) in the rewritten README.

## 1. Stack decision

| Concern | Choice | Rationale |
| --- | --- | --- |
| Framework | Next.js 15 (App Router) + React 19 | Server components enforce authorization on the server, one deployable for UI + API, first-class Netlify support. |
| Language | TypeScript, `strict` + `noUncheckedIndexedAccess` | Required by the brief; catches evidence/provenance mistakes at compile time. |
| Styling | Tailwind CSS v4 + small local UI primitives over Radix | Calm, dense, accessible, mobile-first; no heavyweight component framework. |
| Validation | Zod v4 | Runtime validation at every trust boundary (env, HTTP body, GitHub payloads, AI output). |
| Database | PostgreSQL via Drizzle ORM with SQL migrations | Durable hosted storage (Neon/Netlify DB) in production; migration-backed. |
| Local/test DB | PGlite (embedded Postgres, same dialect + same migrations) | A functioning local path with zero external credentials; **never** used in production. |
| GitHub | `@octokit/rest` behind a `SourceProvider` interface | Read-only, centralised, mockable. |
| AI narration | Optional `@anthropic-ai/sdk`, schema-validated structured output | Fully optional; deterministic narrator is the default and the fallback. |
| Tests | Vitest (unit + integration on PGlite) + Playwright (E2E) | One `npm run verify` gate. |
| Deploy | Netlify (`@netlify/plugin-nextjs`) + scheduled function for sync | Requested target. |

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
