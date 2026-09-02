# Testing

One command is the gate:

```bash
npm run verify
```

Format check → lint → type check → unit tests → integration tests → production build → end-to-end
tests. It stops at the first failure. `npm run verify:ci` runs the same sequence without the
browser step, for environments with no Chromium.

Nothing is skipped or weakened to make the gate pass. If a check fails, the phase is not done.

## Layers

| Layer       | Runner                         | Runs against                                                                                            | Location             | Tests |
| ----------- | ------------------------------ | ------------------------------------------------------------------------------------------------------- | -------------------- | ----- |
| Unit        | Vitest (`unit` project)        | Pure functions — no I/O                                                                                 | `tests/unit/`        | 351   |
| Integration | Vitest (`integration` project) | The real services and repositories on a migrated in-memory PostgreSQL                                   | `tests/integration/` | 63    |
| End-to-end  | Playwright                     | The real application, a mock GitHub API and the test-auth endpoint, at a desktop and an iPhone viewport | `tests/e2e/`         | 28    |

Individually:

```bash
npm run test:unit
npm run test:integration
npm run test:e2e          # first time: npm run test:e2e:install
npx vitest                # watch mode
```

## What integration tests run against

`tests/helpers/test-db.ts` creates a fresh **PGlite** database per test file and applies the very
same `drizzle/*.sql` migrations production uses. Integration tests therefore exercise the real
schema, the real indexes and the real SQL — not a hand-written approximation.

`tests/helpers/services.ts` wires the complete service graph with only the network replaced: a
`FakeSourceProvider` that can be scripted to return successful, partial or failed snapshots.

## What end-to-end tests run against

Playwright starts two servers (see `playwright.config.ts`):

1. `scripts/mock-github.mts` — a small read-only mock of the GitHub REST API with fixtures for a
   healthy repository, an archived repository, a failing workflow, a merged and an open pull
   request, an issue and a release. **It returns 405 for any non-GET request**, so an accidental
   write attempt fails the suite rather than passing unnoticed.
2. The Next.js server with a file-backed PGlite database, migrated fresh on each run, and the
   signed test-auth endpoint enabled.

No network access and no real credentials are involved.

## Coverage of the product's promises

The suite is organised around the claims the product makes, not around file structure:

**Truthfulness**

- Provenance classification: verified vs manual vs inferred vs unknown.
- The narrator cannot invent work: schema failure, uncited evidence, invented blockers or completed
  work, excess counts and any completion percentage are all rejected, with a deterministic fallback.
- No fabricated completion percentage or health score appears anywhere in an assessment.

**Deterministic rules**

- Every `R-*` rule in `src/server/status/engine.ts` (see [STATUS_RULES.md](STATUS_RULES.md)),
  including the ones that are easy to get wrong: a paused project is never progressing, a completed
  project gets no development advice, a failed-then-succeeded workflow is not a failing build, a
  stale open pull request is not active work, and a manual milestone stays manual.

**Resilience**

- Idempotent synchronisation: the same snapshot twice produces the same rows.
- The failed-refresh journey end to end: the interface says "Sync failing", names the
  problem, and still shows every piece of evidence gathered before the failure.
- A failed synchronisation preserves previously verified evidence and marks it `failing`, never
  `never` and never empty.
- Partial permissions produce a partial sync with named unavailable categories, not a failure.
- One failing repository does not stop the others.
- Per-project locking, including stealing an expired lock.
- GitHub error taxonomy: revoked credential, rate limit, renamed repository, empty repository,
  Actions or Issues disabled, network failure, timeout, malformed payload.

**Security**

- Authorisation is enforced by driving the real route handlers: an unauthenticated call to
  `/api/projects`, `/api/export` or `/api/query` returns 401 before anything is read or
  written, an expired session is refused and purged, and a cross-origin write is rejected
  with 403 while a same-origin one and a header-less non-browser call both succeed.
- The single-owner check rejects every other GitHub identity, with the numeric id authoritative.
- The scheduled-sync endpoint rejects a missing or wrong secret, and is closed when unset.
- Configuration fails closed in production for every required variable.
- Secrets never appear in logs, in `describeConfigHealth`, or in an export — the export
  assertion runs against the shipping route's own payload, with a live session token and
  OAuth state present in the database for it to catch.
- **The GitHub integration has no write operation**: asserted at the client (non-GET throws before
  any fetch), at the interface (`SourceProvider` declares only reads) and end-to-end (the mock
  rejects writes).

**The experience**

- The twelve-step journey: sign in, create a manual project, import a repository, view the
  dashboard, open a project, add a blocker, see it under _What needs me_, ask the command bar about
  a project, open evidence behind a briefing, trigger a synchronisation, view meaningful changes —
  and the same journey at an iPhone viewport, with no horizontal overflow.

## Adding tests

- Put pure logic in `tests/unit/`. If it needs a database, it belongs in `tests/integration/`.
- Use the builders in `tests/helpers/factories.ts` so a test states only the field it exercises.
- Assert on values, provenance labels, rule ids and counts — not on `toBeDefined()`.
- Never assert on wording that is incidental. Do assert on wording that is a product promise, such
  as the command bar explaining that execution arrives in Prompt 2.
