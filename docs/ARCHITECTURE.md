# Architecture

## The shape of the problem

Jarvis makes claims about the state of your work. The whole design follows from one constraint:
**a claim must never be more confident than the evidence behind it.** That is why the evidence
store, the deterministic engine and the narrator are three separate things, and why the narrator
is the only optional one.

## Layers

```
src/app/            Next.js App Router — pages (server components) and route handlers.
                    Thin: they authorise, call a service, and render.

src/components/     Presentational React. No business logic, no data access.
                    ESLint forbids importing anything from src/server here.

src/domain/         Pure model: types, Zod schemas, enums, freshness rules, provenance.
                    No I/O, no React, no framework. Shared by server and client.

src/server/
  config/           The only reader of process.env. Fails closed in production.
  logging/          Structured logs with mandatory secret redaction.
  db/               Drizzle schema, driver factory (neon | pg | pglite), migration runner.
  repositories/     Typed persistence interfaces + their Drizzle implementations.
  providers/        SourceProvider interface; GitHubSourceProvider is the only implementation.
  status/           The deterministic status engine, portfolio aggregation, snapshot diffing.
  briefing/         BriefingNarrator interface; deterministic + Anthropic implementations.
  query/            Command-bar parsing, project-name resolution, intent routing.
  services/         Sync, import, briefing, attention — orchestration across the above.
  auth/             Sessions, GitHub OAuth, single-owner check, request guards.
  http/             Route-handler plumbing (auth, same-origin, validation, error mapping).
  container.ts      The composition root. Every dependency is injected explicitly.
```

The dependency direction is strictly downward. `domain` depends on nothing; `components` depend
only on `domain`; `app` depends on `server` and `components`; `server` depends on `domain`.

## Data flow

### Reading a status

```
page (server component)
  → requireOwnerPage()            authorisation, on the server, before any data is loaded
  → BriefingService.briefProject()
      → ProjectRepository.aggregate()      project + goals, milestones, blockers, decisions,
      → EvidenceRepository.list()          updates, next actions, and bounded evidence
      → assessProject()                    LAYER 1: deterministic rules → ProjectAssessment
      → snapshot fingerprint unchanged?    reuse the stored narrative (no model call)
      → BriefingNarrator.narrateProject()  LAYER 2: wording only, schema-validated
      → SnapshotRepository.save()          history, so "what changed" has a baseline
  → render, with a provenance label on every claim
```

### Synchronising

```
POST /api/projects/:id/sync
  → ownerRoute            authorisation + same-origin
  → ProjectSyncService.syncProject()
      → SyncLockService.acquire()          single-flight per project; the lock self-expires
      → SourceProvider.fetchSnapshot()     read-only, per-category, bounded, timed out
      → EvidenceRepository.upsertMany()    idempotent on (project, system, kind, externalId)
      → SourceRepository.recordSyncOutcome()
      → SyncRunRepository.finish()         status, per-category results, rate limit
      → ActivityLogService.record()
      → SyncLockService.release()
```

A failure at any point leaves prior evidence untouched. Failure is recorded as _freshness_, never
as an absence of activity.

## The Status Brain

### Layer 1 — deterministic engine (`src/server/status/engine.ts`)

Pure functions over a `ProjectAggregate` plus its evidence. Every conclusion carries a rule id
(`R-ST4-active-blocker-implies-blocked`, `R-PR2-active-open-pr`, …) so a status can be explained
and each rule can be unit-tested in isolation. See [STATUS_RULES.md](STATUS_RULES.md).

The engine produces a `ProjectAssessment`: derived status and its provenance, phase, headline,
recently completed work, current work, blockers, decisions needed, recommended actions, attention
reasons, freshness, unknowns, key evidence ids, and a **fingerprint**.

The fingerprint is a hash of everything a person would consider meaningful — deliberately
excluding generated timestamps. It is what makes "nothing has changed" a computable statement.

### Layer 2 — narration (`src/server/briefing/`)

`BriefingNarrator` has two implementations:

- `DeterministicNarrator` — the default and the fallback. Always available.
- `AnthropicNarrator` — optional. Receives only normalised evidence, is given **no tools**, and
  must return JSON matching the briefing schema.

Narrated output passes through `validate.ts` before it is accepted. It is rejected if it cites
evidence that was not supplied, claims blockers/decisions/completed work the assessment did not
find, exceeds the assessment's counts, or contains a completion percentage. A rejected narration
falls back to the deterministic text and is recorded as `ai_failed_fallback`, so the interface can
say what produced the words on screen.

## Evidence and provenance

`evidence` is an append-and-update store, never a delete-and-replace one. Its identity key is
`(projectId, sourceSystem, kind, externalId)`, which is what makes synchronisation idempotent.

Four provenance levels are used everywhere:

| Level    | Meaning                                    | Example                                        |
| -------- | ------------------------------------------ | ---------------------------------------------- |
| Verified | Directly observed from a connected source  | A failed GitHub Actions run                    |
| Manual   | Entered by the owner                       | “Waiting for Apple review”                     |
| Inferred | Derived from evidence, stated by no source | “This project appears blocked by CI”           |
| Unknown  | Insufficient evidence                      | The active feature, when nothing indicates one |

An inference is never rendered as a verified fact: the level is part of the data structure
(`Claim`), not a presentation choice.

## Persistence

PostgreSQL through Drizzle, behind repository interfaces. Three interchangeable drivers share one
set of migrations, so local, test and production schemas cannot drift:

| Driver   | Where                                  | Why                                                           |
| -------- | -------------------------------------- | ------------------------------------------------------------- |
| `neon`   | Netlify production                     | Serverless-friendly pooled connections                        |
| `pg`     | Any hosted PostgreSQL                  | Supabase, RDS, Neon's pooled endpoint                         |
| `pglite` | Local dev, unit/integration tests, E2E | Real PostgreSQL, zero credentials. **Refused in production.** |

## Extension points for later phases

The model is already shaped for what comes next, without implementing any of it:

- `projects.id` is the join target for future `missions`, `tasks`, `agent_sessions`, `agent_runs`,
  `artifacts`, `approvals`, `playbooks` and `costs` tables.
- `SOURCE_KINDS` and `EVIDENCE_KINDS` are `text` columns with TypeScript unions, so adding App
  Store Connect or Netlify as a provider is an additive migration.
- `SourceProvider` is the seam a new integration implements; nothing above it is GitHub-aware.
- `BriefingNarrator` is the seam for a different or better narrator.
- `StatusQueryRouter` already recognises execution requests and answers them with an explicit
  “this arrives in Prompt 2”, which is where mission dispatch will attach.
- `ActivityLogService` is the audit spine that agent runs will write into.

Nothing in this phase creates a write-capable GitHub client, so adding one later is a deliberate,
reviewable change rather than an accident.

## Conventions

- Strict TypeScript with `noUncheckedIndexedAccess`. `any` is an ESLint error.
- Runtime validation with Zod at every trust boundary: environment, HTTP bodies, provider
  payloads, AI output.
- All instants stored in UTC as `timestamp with time zone`; formatted in the browser's locale.
- Errors are `JarvisError` subclasses with a code, mapped to HTTP once, in `http/handler.ts`.
- Logs are single-line JSON, redacted by key name and by value shape.
- No business logic in React components; no provider calls outside `providers/`; no silent catch.
