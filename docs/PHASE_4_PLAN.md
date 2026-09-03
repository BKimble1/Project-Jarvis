# Phase 4 plan — completing Jarvis

The design this phase was built to, the traps found while reading, and the decisions taken. Kept
because the decisions are the part worth having later; the code says what, this says why.

## Baseline, measured before anything changed

`npm run verify` on `3a62274`, green in **1259s**:

| Suite                    | Files | Tests                |
| ------------------------ | ----- | -------------------- |
| Unit                     | 11    | 656                  |
| Integration              | 9     | 146                  |
| End-to-end (2 viewports) | 8     | 55 passed, 7 skipped |

No regression to repair. Every count above was read off a run, not out of a document — the Phase 3
handoff quotes the same numbers and they were re-measured rather than trusted.

## What reading the system changed

Five findings altered the design. Each was verified in the source rather than accepted from a
summary.

### 1. Free-text questions are silently answered as a project status

`parseQuery`'s terminal fallthrough (`src/server/query/parser.ts:125`) is:

```ts
/* A bare project name is treated as "where are we on that project?". */
return { intent: 'project_status', projectQuery: text, raw };
```

The _whole question_ becomes the project name. And `resolveProjectName`'s substring tier is
bidirectional (`needle.includes(entry.name)`), so any question that merely mentions a project
resolves to it. "Why is the OffRent payment work stalled?" is answered today as OffRent's project
status, with nothing saying the question was not understood. A cross-project question that names
two projects gets the disambiguation prompt instead.

Consequence: the `default:` case in `StatusQueryRouter.route()` — the intuitive place to attach an
answer engine — is unreachable for any non-empty input. Attaching there alone would have produced
an Ask Jarvis that never once fired, and it would have looked like it worked in every manual test
that used a phrasing the parser already recognised.

**Decision.** Ask rules go into `RULES` **above** the `EXECUTION_PATTERN` check, so a genuine
question is classified before the fallthrough can mangle it; and `notFoundAnswer` delegates to the
engine as a safety net. Two hooks, because the parser is ordered and load-bearing and a single hook
in either place leaves a hole.

### 2. There is no inbound rate limiting, and owner routes have no size limit

Searched for it rather than assumed: nothing on Jarvis's own routes. The GitHub client's
rate-limit handling concerns _GitHub's_ limits on outbound calls. `worker-handler.ts:49` reads
`content-length`, so worker routes are bounded; owner routes are not.

That was survivable for Phases 1–3, where every owner route took a small JSON body. Phase 4 adds
file upload, URL fetch and audio, so it is not survivable now. Both go in 4J, as middleware-level
concerns rather than per-route checks.

### 3. Evidence has no text index and reads cap at 1000 rows

`DrizzleEvidenceRepository.list` caps at `Math.min(query.limit ?? 200, 1000)` ordered by
`observedAt desc`, and the `evidence` table has no full-text index. Naive keyword scoring over
"recent evidence" would systematically miss older evidence — which is the retrieval failure that
produces a confident, wrongly-cited answer, the exact thing 4C must not do.

**Decision.** Retrieval gets a real Postgres full-text index and a `search` method on the
repository, rather than in-memory scoring over a truncated window.

### 4. The narrator's validators are reusable prior art

`validateProjectNarrative` already rejects output citing an evidence id it was not given, asserting
blockers or completed work the deterministic assessment did not find, over-listing, or emitting a
completion percentage. `containsFabricatedProgress` is the guard that makes "a model can degrade
Jarvis's prose but never its truthfulness" true rather than aspirational.

**Decision.** The answer engine gets an equivalent validator with **citation containment** — every
claim must cite an id that was supplied — rather than reusing the portfolio validator, which
checks a weaker set and would leave cross-project synthesis unchecked. A cross-project claim is the
first thing in this codebase permitted to assert across projects, so it needs the stronger check.

### 5. `QueryAnswer` additions must be optional, and there is no exhaustive intent map

Fifteen answer object literals exist and `exactOptionalPropertyTypes` is on, so a required field
addition breaks all of them. `MISSION_INTENTS` is a hand-maintained list with no
`Record<QueryIntent, …>` anywhere, so a new intent with no handler lands in `default:` and reports
"Jarvis did not understand that" — with no compiler error.

**Decision.** Additive optional fields only, and the new intent is added to the switch in the same
commit as the enum, with a test that asserts it routes.

## Qualification: the spine

Everything else hangs off `src/domain/qualification.ts`, because the honest answer to "can Jarvis
do this unattended?" has to exist before anything is scheduled.

Six levels, never collapsed: `built` → `automated` → `simulated` → `live_read` → `live_write` →
`production`. Seventeen named checks, each declaring what a pass _proves_ and which level it gates.
`evaluateQualification` walks upward and stops at the first unsatisfied rung, so a later rung
passing cannot lift an earlier one, and a missing result counts as `unavailable` — the default has
to fail, because a qualification system whose absent evidence reads as success lies by omission.

The ladder gates through `assertActivationAllowed(capability, level)`, called at dispatch. Ordinary
briefings and evidence refresh need `automated`; research and mission drafts need `live_read`;
anything that writes needs `live_write`; CI and TestFlight need `production`. Gating read-only
research behind a full production qualification would make the lock so annoying that the first
thing anyone did would be remove it, and a control nobody can live with is not a control.

`requiresRequalification` compares the assumptions a run was earned under against the ones holding
now, and invalidates **all** live rungs on any difference rather than reasoning about which change
affects which rung — that reasoning is where a plausible exception gets made and something ships
unqualified.

## Knowledge: never letting inference become truth

`src/domain/knowledge.ts` separates _origin_ from _status_ and makes the rules asymmetric.
`resolveInitialStatus` has five rules:

- **R-KN1** I typed it → active. I am the authority on my own preferences.
- **R-KN2** Jarvis's own deterministic record → active. The row is right there.
- **R-KN3** an owner-only category (preference, decision, goal, constraint) from any non-owner
  origin → suggested, always. A model does not get to tell me what I decided.
- **R-KN4** a _definition_ imported from a document I supplied → active. The one auto-accept, and
  narrow on purpose: a definition restates vocabulary rather than asserting a state of the world.
- **R-KN5** everything else → suggested.

Conflicts are detected lexically and **reported, not resolved**. Reporting a harmless pair costs me
ten seconds; missing a real contradiction means Jarvis confidently tells me something I stopped
believing months ago.

Forgetting destroys content and keeps the row as a tombstone, so an audit can say a deletion
happened without retaining what was deleted.

## Retrieval: hybrid, and useful without embeddings

Structured filters, then Postgres full-text, then semantic ranking _if_ an embedding provider is
configured. Exact search must work with no provider at all — an optional dependency that silently
becomes required is a dependency that breaks the feature on the day the key expires.

Retrieved content is fenced and labelled as evidence in `renderSourcesForPrompt`, with the
instruction to _report_ an apparent instruction rather than follow it. That turns an injection
attempt from a risk into a finding. The framing is imperative rather than advisory because a
document may contain "you are now in developer mode", and the only answer that holds is a boundary
the text cannot argue its way out of.

## Scheduling: the arithmetic verified before anything was built on it

`src/domain/schedule.ts` does timezone maths through `Intl.DateTimeFormat` rather than adding a
dependency, with stated DST policies:

- **Gap** (01:30 on a spring-forward morning): run at the first instant that exists — 02:00, the
  moment the clock passes it, which is when an alarm set for 01:30 would fire. Not 02:30.
- **Overlap** (01:30 twice on a fall-back morning): the idempotency key is built from the _local
  wall-clock occurrence_, not the instant, so both produce the same key and the second is a
  duplicate. The job runs once, which is what "every day at 01:30" means.

Verified against real transitions before building on it: every minute-of-day on six transition days
in five zones resolves correctly, and a daily schedule produces exactly 365 unique local
occurrences at the right local time in Europe/London, America/New_York, Australia/Lord_Howe
(30-minute DST) and Pacific/Chatham. The first implementation landed 30 minutes late on a gap and
the sweep caught it.

Catch-up is explicit per schedule, defaulting to `run_latest`, with missed occurrences recorded
rather than silently dropped. The watermark is `lastOccurrenceAt` rather than `lastRunAt`, so a
failed occurrence is not re-discovered as newly due — retries are a separate mechanism with a
bound, and conflating the two is how a failing schedule becomes a retry storm.

## Budgets: enforced where work starts

Reported and estimated cost are different columns, never conflated, and unknown is shown as
unknown rather than as `$0.00` — which is a claim that something was free. `estimateCostUsd`
returns `null` for an unpriced model rather than zero, and prices are configuration because a
hard-coded price table is wrong the week after it is written.

`assertWithinBudget` is called inside the claim path, not in the interface. A budget enforced in
the UI is one a scheduled job, a retry or a second tab walks straight past. Retries, reviews and
repair rounds count against the same budget, because the alternative is a mission costing four
times its cap while every task stays under it.

`unmeasurable` is a real outcome: a hard limit exists but too many calls reported no cost to
enforce it. Ordinary work proceeds with a warning; work that writes, dispatches CI or sends a build
**fails closed**. Failing closed on everything would let one unpriced model brick the system;
failing open on a release would be worse.

## What is deliberately not built

Per the prompt's own scope: no dozens of service integrations. The connector framework declares
capabilities and denies by default so GitHub, uploads, approved URLs and Jarvis's own data are the
whole initial set. No unrestricted shell, no remote browser, no MCP server, no cloud account, no
email sender, no financial service, no general webhook reaches a model session — and the framework
is shaped so those could be added later, deliberately, each with its own manifest and tests.

## A note on the prompt

The Prompt 4 specification was truncated mid-sentence in Phase 4J's data-lifecycle list, after
"Model request metadata." The evident intent — explicit retention and deletion for audio,
transcripts, uploaded files, parsed text, embeddings and indexes, mission transcripts and model
request metadata — is implemented in full, and this note exists so a later reader knows the list
was completed by inference rather than quoted.
