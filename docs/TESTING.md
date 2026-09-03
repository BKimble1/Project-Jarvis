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

| Layer       | Runner                         | Runs against                                                                                                            | Location             | Tests |
| ----------- | ------------------------------ | ----------------------------------------------------------------------------------------------------------------------- | -------------------- | ----- |
| Unit        | Vitest (`unit` project)        | Pure functions — no I/O                                                                                                 | `tests/unit/`        | 555   |
| Integration | Vitest (`integration` project) | The real services and repositories on a migrated in-memory PostgreSQL, plus the real worker against a local git sandbox | `tests/integration/` | 114   |
| End-to-end  | Playwright                     | The real application, a mock GitHub API and the test-auth endpoint, at a desktop and an iPhone viewport                 | `tests/e2e/`         | 44    |

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

## Mission Control

Three things about the mission tests are worth stating, because they are what makes them worth
having rather than reassuring.

**The worker tests drive the real worker.** `tests/integration/worker-runner.test.ts` runs the
actual `MissionRunner` — the real policy, the real git wrapper, the real verification runner —
against a **real git repository**: a bare repo created under the OS temp directory per test and
deleted afterwards. Cloning, branching, committing and pushing all really happen. Only the model
(a scripted runtime) and GitHub's API (a recording fake) are replaced.

So when the force-push test passes, it passes because `assertPushAllowed` refused the argument
vector — not because a mock agreed to.

**No test touches a repository that exists anywhere else.** Every sandbox is local and
throwaway. The end-to-end smoke test additionally starts the worker with
`JARVIS_WORKER_SANDBOX_REPOS` pointing the mission's repository at a local bare repo, so it has
neither a URL nor a credential for anything real.

**The HTTP tests import the shipping handlers.** `tests/integration/mission-http.test.ts` drives
the same route modules Next.js deploys, with real `Request` objects, so the owner guard, the
same-origin check, the worker bearer check and the idempotency replay are the deployed ones.

### The end-to-end smoke test

`tests/e2e/missions.spec.ts` runs a **real worker process** (`scripts/worker.ts`, the same entry
point a deployment uses) and takes one mission from plain language to a draft pull request. It
asserts what actually happened, not what was reported:

- a `jarvis/<mission-id>-…` branch exists on the remote;
- the default branch's contents are byte-for-byte unchanged;
- exactly one pull request was opened, and it is a draft;
- no merge, release, deploy or settings call was ever attempted;
- Jarvis shows it as "ready for your review, not merged".

Two servers support it: `scripts/mock-github.mts` (read-only, and still 405s **every** write —
that refusal is a Phase 1 guarantee) and `scripts/mock-github-write.mts` on its own port, which
implements only the four operations `GitHubDelivery` can perform and rejects a non-draft pull
request outright.

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

**The multi-agent factory (Phase 3)**

- Task-graph validation by rule id: cycles, review coverage, verification before review,
  overlapping parallel writers, a profile above its role's ceiling, a missing specialist review.
- The nineteen-state task machine: no finish without verification and review, no restart without
  an owner, actor enforcement on every move, and reachability of every state.
- Write sets: subtree containment in both directions, the `src/app` vs `src/apple` prefix trap, a
  `..` escape refused, and the offending files named.
- Roles and profiles: the table is frozen, no reviewer or researcher profile carries a write tool,
  every default is inside its ceiling, and an unknown profile name throws rather than defaulting.
- Review verdicts and finding triage by rule id, including that an unavailable review is never a
  pass and that an approval over a failed required check is overridden.
- The review context: it says an unavailable review is not a pass, and it has no field through
  which a builder transcript or an earlier verdict could arrive.
- Capacity: every ceiling, clamping, reduce-only adjustment, stale tasks, and tokens-not-dollars.
- Receipts: the three stages Jarvis can never reach are always false and always explained, and a
  stage claiming to be reached without evidence fails `receiptIsHonest`.
- CI and TestFlight gates by rule id, including exact-commit binding and a superseded approval.
- Playbooks: all nine built-ins validate and produce valid graphs, versioning does not mutate an
  earlier version, and conditional tasks drop cleanly.

**Real-handler integration (Phase 3)**

- Owner authentication on all fifteen new owner routes, and a cross-origin write refused.
- Worker authentication on all four new worker routes.
- Task claiming under contention: two workers race, at most one claim.
- Concurrency, drain mode, and an owner reducing but never raising a limit.
- Graph approval: an unapproved graph runs nothing, a fingerprint mismatch is refused, and a new
  proposal revokes an earlier approval.
- The lease granted covers the _approved graph's_ write set, not what the worker asked for.
- A worker cannot report on, lease for, or review another worker's run.
- A review verdict from a task that is not a review task is refused.
- Playbook install and versioning; a playbook Jarvis would refuse to run is refused at install.
- CI refused by default; each allow-list rule; an exact-commit TestFlight approval that stops
  applying when the commit moves; an app profile that refuses a pasted private key.
- Display pairing shows the token once, never again, and stops working when revoked.
- The export carries the factory's record and no credential of any kind.

**Knowledge and memory (Phase 4B)**

- Citations survive a re-read: an unchanged refresh creates no revision, a changed one creates a
  new revision and the old one's chunks stay resolvable.
- Exactly one revision is active under six concurrent refreshes — a database guarantee, asserted
  under real concurrency rather than in principle.
- Project A cannot retrieve Project B's material. Asserted with unique canary strings rather than
  with counts: a count-based test passes while one of the results is the wrong project's.
- A wallboard never receives private material and an agent never receives it either, however the
  request is phrased.
- A proposal cannot approve itself — refused on actor kind, and refused again on actor identity
  when a proposer presents as the owner.
- Forgetting removes the text from the row, the generated full-text index, the vector index, a raw
  scan of every text column, the whole audit trail and the export. A later indexing pass does not
  re-embed the tombstone.
- Retrieved text cannot grant authority: it comes back intact (not scrubbed), the evidence object
  has no field through which it could act, and rendering places it inside a fence that names it as
  data.
- An upload is judged by its bytes: a PDF, ZIP, ELF or PNG named `.md` with a matching declared
  type is refused, and a `.pdf` claiming `text/plain` is refused before a row is created.
- Search reports its mode honestly. With no provider configured it says "Full-text only" rather
  than describing text search as hybrid, and the semantic channel returns nothing when nothing is
  actually near.

**Non-vacuity, checked by mutation**

A green suite proves nothing until the assertions are known to bite. Each of these was broken
deliberately, the failure observed, and the code restored:

| mutation | tests that failed |
|----------|-------------------|
| `isActive` hard-coded true in the revision mapper | refresh keeps exactly one active revision |
| the semantic similarity floor removed | an unrelated query returns no semantic candidates |
| the display audience ceiling raised to `private` | a wallboard never sees private memory |
| the project clause replaced with `or true` | the four project-isolation tests |
| chunk overlap reverted to character slicing | four locator-containment assertions |
| a regex scrubber added to the prompt renderer | retrieved text is returned intact |

**The multi-agent smoke test**

`tests/integration/multi-agent-smoke.test.ts` is the one that matters most. It uses a real
database, the real route handlers, the real orchestrator, real `TaskRunner` workers and a real git
repository on disk; only the model (scripted runtime) and GitHub's API (`FakeDelivery`) are
replaced. In one run it proves: a task graph is created and approved; two read-only tasks run
concurrently on two workers; the builder waits for the research it depends on; the builder works on
an isolated branch; verification runs against the integrated result; the reviewer receives cold
context and catches a deliberately seeded defect; repair is bounded; a _fresh_ reviewer evaluates
the repaired work; the integration branch stays separate from `main`; a draft pull request is
produced; nothing is merged; and no forbidden API is called.

It found nine real defects when it was first run, which is the argument for writing it.

## Adding tests

- Put pure logic in `tests/unit/`. If it needs a database, it belongs in `tests/integration/`.
- Use the builders in `tests/helpers/factories.ts` so a test states only the field it exercises.
- Assert on values, provenance labels, rule ids and counts — not on `toBeDefined()`.
- Never assert on wording that is incidental. Do assert on wording that is a product promise, such
  as the command bar explaining that execution arrives in Prompt 2.
