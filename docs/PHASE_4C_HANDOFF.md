# Phase 4C — handoff

Ask Jarvis: what was built, what is actually proved, and what 4D may rely on.

Read `docs/PHASE_4B_HANDOFF.md` first for the retrieval contract this phase consumes. This
document covers the finished state of 4C and the stabilization work that had to come before it.

---

## Part 1 — the E2E contention, and what it actually was

Phase 4B ended with a suite that failed once per full run, in a **different test each time**,
while every one of those tests passed comfortably alone. It was diagnosed then as "contention from
added load". That was directionally right and mechanically wrong, and the mechanism matters
because it points at a completely different fix.

### Cause 1 — routes compile inside the first test that needs them

The suite runs against `next dev`. Playwright's `webServer.port` probe calls the server ready when
the port accepts a TCP connection, but `next dev` compiles routes **lazily, on first request**. The
first test to navigate somewhere therefore pays for compiling it, inside its own timeout.

Measured directly, cold first request against warm subsequent request:

| route        | first request | subsequent | ratio |
| ------------ | ------------- | ---------- | ----- |
| `/signin`    | 24 s          | —          | —     |
| `/knowledge` | 12.8 s        | 160 ms     | 80×   |
| `/missions`  | 6.9 s         | 155 ms     | 45×   |
| `/attention` | 4.5 s         | 126 ms     | 36×   |

35.2 s of pure compilation across the pages alone. "Ready in 3.7s" in the Next log means ready to
_begin_ compiling. That accounts for every symptom: the victim is whoever touches an uncompiled
route first, so it moves between runs; alone there is far less to compile, so it does not
reproduce; and 4A was clean because `/knowledge` — now the most expensive route in the application
— did not exist.

**Rejected fix: a production build.** `next build && next start` compiles everything ahead of time
but forces `NODE_ENV=production`, where this application deliberately refuses the signed test-auth
endpoint and a plain-`http` base URL. Those refusals are load-bearing security behaviour and the
test runner does not get to weaken them.

### Cause 2 — the dev server restarts itself when it runs out of heap

Warming _all ninety_ routes fixed cause 1 and created cause 2. Next's dev server holds every
compiled route in memory; with all ninety loaded it approached its heap limit mid-run and did what
it does then — logged plainly on the server side:

```
⚠ Server is approaching the used memory threshold, restarting...
```

(`next/dist/server/lib/start-server.js`: it restarts when used heap passes 80% of the limit.) An
in-flight request during that restart fails with `ECONNRESET`, and the restart discards every
compiled route so the run pays the whole compile bill a second time.

The correlation was unambiguous across three runs of that configuration:

| run | duration | peak memory | result                                    |
| --- | -------- | ----------- | ----------------------------------------- |
| 1   | 353 s    | 7.9 GB      | 58 passed                                 |
| 2   | 573 s    | **12.1 GB** | **1 failed** (ECONNRESET, server restart) |
| 3   | 365 s    | 8.7 GB      | 58 passed                                 |

Node's default heap ceiling on this machine is 8240 MB, so Next's guard trips at about 6.6 GB.

### Cause 3 — editing the repository during a run

One earlier run failed with `ReferenceError: numeric is not defined`. That was not the suite: the
schema was being edited while the run was live and the dev server hot-reloaded a half-applied
edit. Recorded because it is a standing hazard — **a dev-server-backed E2E run must not be started
while the repository is being edited**, and any run that overlaps an edit should be discarded
rather than interpreted. It also means some of the four "flaky" runs recorded at the end of 4B
cannot be cleanly attributed.

### The stabilization fix

Three changes, each addressing one cause:

1. **`tests/e2e/global-setup.ts`** replaces the readiness condition. Every _page_ is requested
   once, authenticated, before any test starts. Pages are enumerated from the filesystem, so a page
   added later is covered without anyone remembering.
2. **Pages, not everything.** API handlers measured one to two seconds each and only the handful a
   test calls are paid for, while roughly forty-five of the ninety routes are never touched at all.
   A short explicit list of API endpoints _is_ warmed — the ones the fixtures call — because a
   compile charged to a fixture surfaces as a **teardown** timeout against an unrelated test.
   (That is exactly how this instability disguised itself, and it recurred during 4C: deleting the
   scenario project timed out at 20 s because `/api/projects/[id]` had never been compiled.)
3. **`NODE_OPTIONS=--max-old-space-size=10240`** in the E2E app env, plus
   `experimental.webpackMemoryOptimizations` in `next.config.ts`. The first moves Next's restart
   trigger from ~6.6 GB to ~8.2 GB; the second lowers what is needed in the first place.

**An unexplained timeout increase would not have been a fix, and none was applied.** `retries` is
`process.env.CI ? 1 : 0`, and every run reported here ran with **retries: 0** — every result is a
first-attempt result.

### Five consecutive clean runs, before any 4C feature

`git stash`ed 4C work, full suite, both projects, identical configuration, zero concurrent edits:

| run  | duration | peak memory | dev-server restarts | result    |
| ---- | -------- | ----------- | ------------------- | --------- |
| g3-1 | 456 s    | 11.9 GB     | 0                   | 58 passed |
| g3-2 | 440 s    | 11.5 GB     | 0                   | 58 passed |
| g3-3 | 457 s    | 11.8 GB     | 0                   | 58 passed |
| g3-4 | 444 s    | 11.5 GB     | 0                   | 58 passed |
| g3-5 | 443 s    | 11.7 GB     | 0                   | 58 passed |

Duration variance across the five: 17 s (previously 353–574 s). No stray processes after any run.

---

## Part 2 — the answer architecture

### The order, and why every step is where it is

`AnswerService.ask()` runs seven steps in this order, and the order is the security property:

1. **Authorize and resolve scope** — from the _conversation's stored scope_ against the owner's
   real project list. Nothing has been read; no model exists yet.
2. **Route** — deterministically, from the question text alone (`routeQuestion`), deciding which
   _sources_ to consult.
3. **Gather** — structured status from the engine; documents through the 4B retrieval contract.
4. **Freeze** — the evidence becomes a snapshot and the set of legal citations is fixed.
5. **Generate** — only if a provider exists.
6. **Validate** — containment first. A citation the model was not given means it invented
   something, and the answer is rejected rather than shown with a caveat.
7. **Persist** — guarded by the state machine, so a late result cannot overwrite a cancellation.

Steps 1–4 happen whether or not a model is involved. That is what makes the no-provider mode
useful rather than an apology: the evidence is the same evidence and only the prose is missing.

### Structured questions are answered from structured records

`EvidenceGatherer` reads project status from `BriefingService.assessMany` — the deterministic
engine over real repository evidence — and never from prose that happens to discuss the project.
An integration test plants a document claiming "everything is finished and nothing is blocked" and
asserts the portfolio answer is built from `status_engine` items, not from that note.

Each piece of an assessment becomes a **separate citable reference**, so a claim can cite the
blocker rather than "the project":

```
project:<id>                  the current status line
project:<id>#attention-<n>    one attention reason
project:<id>#blocker-<n>      one active blocker
project:<id>#decision-<n>     one decision awaiting the owner
project:<id>#work-<n>         one item in progress
project:<id>#done-<n>         one recently completed item
project:<id>#unknown-<n>      one thing the engine does not know
evidence:<id>                 a repository evidence row the engine relied on
mission:<id>                  a mission record
source:<id>                   a retrieved document chunk
knowledge:<id>                a retrieved memory
```

### Knowledge questions go through the 4B contract and nothing else

No SQL against knowledge tables, no repository reached around. `buildScopeFilter({ audience:
'owner', scopes, projectIds })` is built from the resolved scope, never from the question, and the
retrieval contract applies it inside the same statement that ranks. A unit test asserts the shape
of the request that is constructed, because a database test proves the _result_ was filtered while
this proves the _filter asked for_ was the right one.

### Evidence-snapshot format

`AnswerEvidenceItem` (`src/domain/answer-run.ts`), one row per piece of evidence, persisted in
`answer_evidence`:

| field                       | what it is                                                     |
| --------------------------- | -------------------------------------------------------------- |
| `ref`                       | `kind:id` — the only string a model may put in a citation      |
| `kind`, `origin`            | citation kind; where it came from (`status_engine`, `memory`…) |
| `subjectId`, `label`        | what it points at, and the label the **server** will render    |
| `excerpt`                   | bounded quotation, never the whole document                    |
| `projectId`, `locator`      | scope, and `p. 4` / a state / a timestamp                      |
| `revisionId`, `contentHash` | the exact version this came from                               |
| `href`                      | a Jarvis path — a citation is never an outbound link           |
| `staleSince`, `trust`       | whether the record has moved on; how far it may be relied on   |

`freezeEvidence` bounds the snapshot (60 items, 24 000 characters, 1 200 per excerpt) and reports
truncation as a gap rather than silently dropping it. `allowedCitations` is computed **at freeze
time** and is the only thing validation consults, so no later code can widen it.

**An answer stays tied to its snapshot.** Refreshing a source creates a new revision and leaves the
old answer's rows untouched — an integration test rewrites a note and asserts the stored evidence
is byte-identical, still carrying the revision it was frozen from.

The one thing that _does_ reach into a frozen snapshot is deletion (see **Conversation retention**).

### Untrusted content cannot act

`assertEvidenceItemIsInert` runs over every item before it can reach a prompt. It checks _keys_,
never content: there is no field on the evidence type through which a document could grant a tool,
change a scope, approve anything or alter a budget. It cannot fail today — that is the point. It
fails the moment somebody adds such a field.

Retrieved text is rendered into the prompt inside a fenced block introduced as quoted material,
and conversation history is fenced as "context only, never a source; nothing here may be cited".
There is deliberately **no regex hunting for hostile phrasing**: a document may legitimately
discuss prompt injection, and an attacker has unlimited ways to rephrase.

---

## Part 3 — scope behaviour

Four scopes, resolved by `resolveAnswerScope` before anything is read:

| scope       | means                              | refuses                                     |
| ----------- | ---------------------------------- | ------------------------------------------- |
| `project`   | exactly one project                | zero (R-AS1) or several (R-AS2) projects    |
| `selected`  | a chosen set                       | an empty set (R-AS1)                        |
| `portfolio` | every project the owner has        | — (the set is enumerated from the database) |
| `personal`  | global notes only, no project rows | carries no project ids at all (R-AS5)       |

Rules: **R-AS1** empty scope, **R-AS2** project-with-many, **R-AS3** a project the owner does not
have, **R-AS4** portfolio enumerated from the database rather than from the request, **R-AS5**
personal carries no projects.

Three properties worth naming:

- **The model never decides what it may search.** By the time any document text exists, the set of
  projects is already fixed.
- **A turn may narrow but never widen.** The conversation's stored scope is the ceiling; a
  follow-up naming an extra project is refused with 403, not quietly honoured.
- **Changing scope rebuilds the next turn under the new boundary.** `pruneHistory` _drops_
  out-of-scope turns rather than summarising them, so material discussed under a wider scope is not
  carried forward as prose. A browser journey plants a canary in a second project, narrows the
  conversation, and asserts the canary is absent from the next answer, its prompt and its frozen
  evidence.

---

## Part 4 — the answer contract

`ModelAnswer` is a list of **claims**, each declaring what kind of thing it is:

| kind                   | label               | must cite |
| ---------------------- | ------------------- | --------- |
| `recorded_fact`        | Recorded            | yes       |
| `repository_evidence`  | From the repository | yes       |
| `model_interpretation` | Jarvis's reading    | no        |
| `recommendation`       | Suggested           | no        |
| `unknown`              | Unknown             | no        |

`validateAnswer` rejects the whole answer — never repairs it, never shows it with a caveat — on:

- **R-AN1** a citation that was not in the packet (the single worst failure here)
- **R-AN2** a stated fact citing nothing
- **R-AN3** a claim about a project outside scope
- **R-AN4** an invented completion percentage or health score
- **R-AN5** an answer that is nothing but interpretation
- **R-AN6** a recommendation written as an accomplished fact (both "has been merged" and "I have
  opened a pull request" — the second matters more here, because Ask cannot do anything)
- **R-AN7** a mission suggestion for a project outside scope

There is **no grounding score**. A number like "94% grounded" would be a fabricated metric of
exactly the kind R-AN4 exists to reject. What is reported instead is the mode, the evidence count,
the gaps and the rejection reason if there was one.

**Repair is bounded at one retry** (`MAX_GENERATION_ATTEMPTS = 2`) and then stops. An unbounded
repair loop turns a model that cannot answer into a bill that does not stop.

### Citation validation

Citations are **generated from server-issued identifiers**, never from free-form model text:

1. The model may emit only `ref` strings present in the snapshot; anything else is R-AN1.
2. `toClaims` resolves each surviving ref back to the frozen row and builds the citation from _it_
   — the label a person reads and the href they click are the server's, not the model's.
3. Resolution for display goes through `POST /api/ask/answers/:id/citation`, which joins the
   evidence row to its answer and requires that answer to have been asked by this owner.

**The citation route cannot be used to enumerate.** There is no route that resolves a reference on
its own: without the answer, a reference is not a key to anything. A reference that is real but
belongs to another answer returns the same 404 as an invented one — a route test asserts the two
response bodies are identical. It is a `POST` so the identifier never reaches an access log, a
browser history entry or a `Referer` header.

---

## Part 5 — conversation retention

- Conversations belong to an owner; ownership is a predicate **inside** every query, so a
  conversation id belonging to somebody else returns null rather than a row to compare afterwards.
- **Conversation history is not memory.** Nothing a conversation contains becomes a memory; the
  memory path is `MemoryService.remember`, owner-only, and Ask has no access to it.
- Bounded context: 8 turns, 4 000 characters (`CONVERSATION_LIMITS`), and only headlines — never
  evidence — are carried forward, fenced as non-authoritative.
- Every turn is re-authorized; nothing is inherited from the previous one.
- Deleting a conversation deletes its answers and their evidence by cascade, and tombstones the
  conversation row (title `(deleted)`, no project ids) so the deletion itself stays auditable.
  A route test asserts the answers are gone.
- `retain_until` exists on the row for a retention policy 4D can enforce; nothing prunes on it yet
  (see **Known limitations**).

### Deletion reaches the copies an answer kept

A snapshot is deliberately a _copy_ — that is what makes an old answer checkable — and therefore a
second place private content lives. Both deletion paths now reach it:

- `MemoryService.forget` scrubs `answer_evidence` rows whose subject is that memory **and** the
  claim texts that quoted it (in evidence-only mode a claim's text _is_ the excerpt, so scrubbing
  one and not the other would delete the citation and keep the sentence).
- `IngestionService.deleteSource` scrubs by revision id, before the revisions are purged.

The row survives as a tombstone saying what happened, so a citation still resolves and says the
source is gone rather than failing in a way that reads as a bug. The deletion receipt names
`answer_evidence.excerpt` and `answers.claims` among its scrubbed targets.

---

## Part 6 — the mission-proposal boundary

**`AnswerService` has no mission service, no orchestrator, no delivery client and no CI
dispatcher — not as a policy but as a fact about its constructor.** An answer physically cannot
create a mission; the most it can produce is a `MissionSuggestion`, which is a description with
`started: false` on a path that has nothing to set it true.

An integration test walks the service's object graph at runtime and fails if any reachable method
is named `start`, `dispatch`, `enqueue`, `approve`, `enroll`, `claim`, `lease`, `merge`,
`createBranch`, `createPullRequest`, `trigger`, `runNow` or `execute`. "We would never call that"
is a promise; "there is nothing to call" is a property.

Turning a proposal into a draft is a separate owner-initiated `POST` to
`/api/ask/answers/:id/mission-draft`, which:

- re-reads the suggestion from the **stored answer** rather than trusting the request body, so a
  caller cannot post an arbitrary mission through this path and have it look like a Jarvis proposal;
- refuses a project that was not in the answer's scope (403);
- calls the same `missions.create` every other caller uses, landing in `draft` or
  `needs_clarification` — never in an active state;
- returns `started: false, needsApproval: true`.

A browser journey creates a draft, then opens it in the mission UI and asserts no pause, stop or
retry control exists — because nothing is running.

---

## Part 7 — provider and no-provider modes

Six modes, each with a label and a meaning shown in words on every answer:

| mode                                 | label                                     | when                               |
| ------------------------------------ | ----------------------------------------- | ---------------------------------- |
| `evidence_only`                      | Records only                              | no provider configured             |
| `model_generated`                    | Written by Jarvis from records            | generated and validated            |
| `model_generated_degraded_retrieval` | Written by Jarvis, with incomplete search | part of the index was unavailable  |
| `generation_failed`                  | Records only — writing failed             | provider failed, or draft rejected |
| `cancelled`                          | Stopped                                   | the owner stopped it               |
| `unavailable`                        | Unavailable                               | nothing could be produced          |

**Evidence-only mode is not a stub.** It resolves scope, gathers structured status, retrieves
documents, freezes the snapshot and returns claims with real citations — the same pipeline, minus
the sentence-writing. What it will not do is pretend: every claim is labelled `recorded_fact` or
`repository_evidence`, **nothing** is labelled `model_interpretation`, and the mode meaning says
plainly that nothing was generated.

It also still proposes. "Build the onboarding screen" produces a mission draft proposal built from
**the owner's own sentence** — not a paraphrase, so it cannot misrepresent what they asked for —
and a research question is proposed as read-only research with the caveat that current information
cannot be verified.

**A provider becoming unavailable never destroys the evidence.** The failure path finishes with
the gathered snapshot and says which of the three situations occurred: no provider, a provider
that failed, or a draft the validator rejected.

**The activation lock stays authoritative.** With nothing configured, Jarvis does not invent a
narrator. The only substitute that exists is `ScriptedAnswerProvider`, and it is constructed only
when `config.ask.scriptedProvider` is true — which `buildConfig` sets only outside production and
only where a test-auth secret is already configured, so it rides on the same gate that keeps the
signed test-login endpoint inert in a real deployment.

---

## Part 8 — usage and audit

Usage is recorded **per attempt**, because every attempt cost money whether or not it was accepted:

- `inputTokens`, `outputTokens`, `cachedInputTokens`, `reportedCostUsd` are passed through exactly
  as reported, **nulls included**. A missing token count is not zero tokens.
- `costBasis` is `'reported'` when a cost was given and `'unknown'` when it was not — never
  `'estimated'` with a made-up number.
- The idempotency key is `${runId}:${attempt}`, so a retry records a second real call rather than
  overwriting the first.
- Tests assert the numbers survive as numbers through the usage row, the answer row and the export.

Audited: conversation creation, scope changes, the question (its intent and rule), evidence-snapshot
creation, cancellation, deletion and mission-draft proposals. Audit records carry **counts and
modes, never excerpts** — an integration test asks a question whose evidence contains a canary and
asserts the canary appears nowhere in the audit trail.

---

## Part 9 — the interface

`/ask` is a first-class page with the scope selector beside the composer and visible before
anything is typed, so an empty answer is never ambiguous about what was searched.

- Scope: **Everything / One project / Some projects / My notes**, with a checkbox list for the
  selected set and a plain sentence — "Jarvis will look at …" — under it.
- Progressive status from the **real persisted state machine**, polled by the idempotency key the
  client mints before sending (`GET /api/ask/answers?key=…`), with a **Stop** control.
- Answers render mode, meaning, evidence count, claims with server-built citations, limitations,
  and action proposals in a separate bordered section labelled "A proposal, not work".
- "What Jarvis looked at (n)" expands the frozen evidence.
- Conversations continue: the console carries the conversation id, rescopes it on the server when
  the scope changes, and offers "Ask something new".
- **No `dangerouslySetInnerHTML` anywhere in the file**, asserted by a unit test that reads the
  shipping source, and by a browser journey that plants `<img src=x onerror=…>` in a document and
  asserts the characters are displayed and no element was created.
- Entry points from the dashboard and from five scoped links on a project page.
- **`/display` has no Ask control and no Ask authority.** A journey pairs a real display
  credential in a browser context of its own and asserts `POST /api/ask` answers 401.

Why polling rather than server-sent events: with no provider there are no tokens to stream, and
streaming state changes through a reconnecting transport would be a much larger mechanism carrying
the same information. The persisted state machine is already the right shape for SSE if 4D wants
it.

---

## Part 10 — test counts

| suite                                    | tests | what it covers                                                                        |
| ---------------------------------------- | ----- | ------------------------------------------------------------------------------------- |
| `tests/unit/ask-rules.test.ts`           | 40    | scope, routing, state machine, snapshot, validation, retrieval request, render safety |
| `tests/integration/ask-pipeline.test.ts` | 32    | isolation canaries, memories, snapshot pinning, cancellation, usage, audit, scrubbing |
| `tests/integration/ask-http.test.ts`     | 14    | the real shipping handlers                                                            |
| `tests/e2e/ask.spec.ts`                  | 17    | owner journeys, evidence-only                                                         |
| `tests/e2e/ask-model.spec.ts`            | 4     | owner journeys with a stand-in model                                                  |

Repository totals after 4C: **1160** unit and integration tests across **31** files, all passing;
**91** end-to-end tests across two viewports, plus **4** in the separate generated-answer run.

---

## Part 11 — five consecutive clean runs, after 4C

Full suite, both viewports, identical configuration, first attempts, `retries: 0`, zero
concurrent edits:

| run  | duration | peak memory | dev-server restarts | result                          |
| ---- | -------- | ----------- | ------------------- | ------------------------------- |
| g5-1 | 615 s    | 9.3 GB      | 0                   | 47 + 44 = 91 passed             |
| g5-2 | 608 s    | 9.2 GB      | 0                   | 91 passed (one transport retry) |
| g5-3 | 617 s    | 9.6 GB      | 0                   | 91 passed                       |
| g5-4 | 605 s    | 8.8 GB      | 0                   | 91 passed                       |
| g5-5 | 615 s    | 9.3 GB      | 0                   | 91 passed (one transport retry) |

Duration variance across the five: 12 s. No stray processes after any run. `retries` is
`process.env.CI ? 1 : 0` and these ran locally, so every result is a first-attempt result; no
Playwright retry was configured or used.

### Getting there took three more findings, and they are worth recording

**Run 2 of the first attempt restarted the dev server.** 4C's added load pushed it back into the
memory guard: `ECONNRESET`, one restart logged, one test failed. Raising the heap again would have
been treating the same symptom twice.

**A restart was invisible.** The application server's stdout was discarded, and that is where Next
announces both a memory restart and "Found a change in package.json. Restarting…". It is piped
now. That single change is what turned the next failure from a mystery into a diagnosis.

**The fix was structural, not a bigger number.** `npm run test:e2e` now runs the two viewport
projects as two invocations, each starting its own server, so each holds half the compiled work.
Measured on the same suite and machine:

| configuration             | peak memory | restarts | result    |
| ------------------------- | ----------- | -------- | --------- |
| one server, both projects | 12.4 GB     | 1        | 1 failed  |
| one server per viewport   | 8.8–9.6 GB  | 0        | 91 passed |

Alongside it: `.jarvis-data` is excluded from the file watcher (the embedded database and the
mission worker's sandbox repository both write there, inside the project, all run long), and
source maps are off **for the end-to-end run only** — they are the dev server's largest single
heap consumer and this suite never reads one. Ordinary `next dev` keeps them.

### The one retry that exists, and what it is

Twice across ten full runs a fixture failed with `ECONNRESET` on a request **the server has no
record of receiving**. Node closes an idle keep-alive connection after five seconds; Playwright's
request context pools connections and does not retry; a fixture acting a few seconds after the
last request can therefore pick a socket the server has already closed.

`tests/e2e/fixtures.ts` retries once, and **only when the connection itself failed** — a response
that arrives and says the wrong thing still fails on the first attempt. It prints a line when it
fires, so a run that needed it says so. It fired in two of the five runs above (once each, in
sign-in and in project cleanup), and both lines are in the logs.

This is deliberately not a test retry. `retries` remains 0 locally, and no timeout was raised
anywhere in this phase.

---

## Part 12 — live-model qualification

**Not performed, and not claimed.** No real answer provider is configured in this repository, so
Part 4 of the phase specification does not apply. Everything reported above is automated-test
evidence; the only non-automated substitute is `ScriptedAnswerProvider`, which is a deterministic
stand-in and is described as one everywhere it appears.

When a real provider is added, the qualification to run is the one the specification names: a
factual question with one citation, a multi-source synthesis, an unanswerable question, conflicting
evidence, a hostile document, an action request, and cancellation — inspecting the actual bounded
evidence sent to the model.

---

## Part 13 — missing configuration

| what                           | effect while absent                                                           |
| ------------------------------ | ----------------------------------------------------------------------------- |
| An answer provider             | Every answer is `evidence_only`. Honest, and useful.                          |
| An embedding provider          | Retrieval is `lexical_only` and says so in every answer's gaps.               |
| `JARVIS_ASK_SCRIPTED_PROVIDER` | Only meaningful outside production, only with a test-auth secret.             |
| `JARVIS_E2E`                   | Read only by `next.config.ts`, to drop source maps during the end-to-end run. |

---

## Part 14 — known limitations

1. **No streaming.** Progress is polled, not streamed. Deliberate (see Part 9), and the state
   machine is shaped so SSE could be added without changing the contract.
2. **Retention is stored but not enforced.** `retain_until` exists on conversations and answers;
   nothing prunes on it yet. Deleting a conversation works and is the only enforcement today.
3. **Conflict detection is lexical.** Two notes that disagree in words Jarvis cannot match are not
   flagged. What is flagged is presented honestly; what is missed is missed silently.
4. **Routing is keyword-based.** A question phrased unusually falls to the general branch, which
   gathers everything — over-gathering rather than under-gathering, which is the safe direction.
5. **One conversation per question in the console until you follow up.** Asking a fresh question
   after "Ask something new" starts a new conversation; there is no conversation switcher yet.
6. **`personal` scope is reachable through the API and the console** but has no dedicated entry
   point from the notes surface.

---

## Part 15 — defects found during implementation and audit

Nine, all fixed, all with regression coverage:

1. **`ON CONFLICT` could not use the partial idempotency index.** `answers_idempotency_idx` is
   partial (`where idempotency_key is not null`), and Postgres only selects a partial index as the
   conflict arbiter when the statement repeats its predicate. Every ask raised `42P10`; the
   duplicate-submission guarantee had never been in force. Found by the first integration test that
   asked a question.
2. **Forgetting did not reach frozen answer evidence.** A forgotten memory survived in
   `answer_evidence` and in the claim texts of answers that quoted it. Both are scrubbed now, and
   the deletion receipt names them.
3. **Deleting a source did not reach it either.** Same fix, keyed on revision id.
4. **PDF ingestion was broken outside the test process.** `pdfjs-dist` was being bundled by
   webpack; the bundled module throws at `getDocument`, so every PDF upload failed with "this PDF
   could not be read" — which reads like a bad file rather than a broken parser. It is now a
   server external package. A 4B defect that only a browser test could find.
5. **Evidence-only mode never said what it had not found.** A document question that matched
   nothing still returned project status, which looks like an answer. Every gap is now an explicit
   `unknown` claim.
6. **"What did we decide about auth?" routed to the attention queue.** A bare `decide|approve`
   alternative swallowed recorded decisions into pending ones. Past and pending are now separated.
7. **R-AN6 missed first-person completion claims.** "I have opened a pull request" passed. It is
   the more dangerous phrasing on a surface that cannot do anything.
8. **The console started a new conversation for every question**, so there were no follow-ups and
   no way to change scope mid-conversation.
9. **A compile was charged to a fixture.** `/api/projects/[id]` was never warmed, so deleting the
   scenario project timed out in teardown — the original instability wearing a different hat.

Two documentation corrections: the mission-draft route claimed `missions.create` sets state
`draft` (intake may answer `needs_clarification`), and the global-setup comment said "pages only"
after a short API list was added.

---

## Part 16 — the audit, item by item

The twenty failure modes the phase specification named, and what was found:

| #   | failure mode                                      | verdict                                                                                                                                           |
| --- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | E2E instability returning under Ask's load        | Found once (fixture compile, defect 9); fixed and re-verified over five runs                                                                      |
| 2   | Scope decided by the model                        | Not possible: scope is resolved before retrieval and the model has no channel to change it                                                        |
| 3   | Raw knowledge-table access bypassing retrieval    | None. `EvidenceGatherer` imports no knowledge repository                                                                                          |
| 4   | Status inferred from prose                        | None. Integration test plants a lying document and asserts the engine answers                                                                     |
| 5   | Private memory included automatically             | Only in an owner-audience scope, and never a `suggested` one; a canary proves a display audience cannot reach one                                 |
| 6   | Forgotten source content retained                 | **Found** (defects 2 and 3); fixed                                                                                                                |
| 7   | Citations invented by the provider                | Rejected by R-AN1; a browser journey drives the rejection through the UI                                                                          |
| 8   | Citation routes lacking authorization             | Owner-joined; cross-answer replay returns an identical 404                                                                                        |
| 9   | Prompt injection entering privileged instructions | Fenced as quoted material; journeys assert nothing happened                                                                                       |
| 10  | Conversation summaries crossing scopes            | No summaries. Out-of-scope turns are dropped, not summarised                                                                                      |
| 11  | Recommendations presented as facts                | R-AN6, widened during the audit (defect 7)                                                                                                        |
| 12  | Evidence-only mislabelled as AI analysis          | Mode label and meaning on every answer; no `model_interpretation` claims in that mode                                                             |
| 13  | Partial output marked complete before validation  | R-AR2: `complete` is reachable only from `validating`                                                                                             |
| 14  | Duplicate paid calls                              | **Found** (defect 1); fixed, with a test asserting one provider call for two submissions                                                          |
| 15  | Late completions resurrecting cancelled answers   | R-AR1 plus an expected-state guard in the UPDATE; tested at both levels                                                                           |
| 16  | Mission drafts that enqueue tasks                 | None. No plan, no run, no branch — asserted after creating one                                                                                    |
| 17  | Raw provider output rendered as HTML              | No `dangerouslySetInnerHTML`; asserted by source scan and by an injection journey                                                                 |
| 18  | Numeric usage damaged by redaction                | Nulls stay null, numbers stay numbers, through usage row, answer row and export                                                                   |
| 19  | Tests asserting only headings or empty states     | Every negative is a canary paired with a positive control                                                                                         |
| 20  | New retries or raised timeouts hiding failures    | No test retry and no raised timeout. One **transport** retry was added in the fixtures — connection-level only, announced in the log; see Part 11 |

Two more canaries were added during the audit, beyond the twenty:

- **A credential reaching the prompt.** A token-shaped value in the environment appears in neither
  the prompt nor the snapshot. "There is no path from configuration into the packet" is a claim;
  this is the test of it.
- **A suggestion stored as a fact.** A `recommendation` claim survives the round trip as a
  recommendation, citing nothing, rather than being promoted on the way through.

---

## Part 17 — the contracts Phase 4D may consume

**`AnswerService`** (`src/server/ask/answer-service.ts`) — the only supported way to produce an
answer:

```ts
const result = await services.answerService.ask(
  askTurnSchema.parse({
    question,
    scope: 'project',
    projectIds: [projectId],
    idempotencyKey, // client-minted; a repeat is the same request, not a second bill
    proposeAction: false, // opt in; a question answers a question
  }),
  ownerId,
);
```

Also: `startConversation`, `rescopeConversation`, `renameConversation`, `deleteConversation`,
`listConversations`, `history`, `evidenceFor`, `resolveCitation`, `cancel`.

**`EvidenceGatherer.gather()`** returns a frozen `AnswerEvidenceSnapshot` plus coverage counts. 4D
should call this rather than assembling evidence itself — a briefing that gathered its own evidence
would be a second, unvalidated path to the same private material.

**`AnswerProvider`** (`src/server/ask/answer-provider.ts`) — `name`, `model`, `isConfigured()`,
`generate(request)`. A real provider implements this and nothing else. Note what the interface does
not have: no tools parameter, no tool loop, no channel through which generated text could request
an action.

**State machine** — `ANSWER_STATES`, `applyTerminalTransition`, `isPresentableAnswer`. R-AR1:
nothing leaves a terminal state. R-AR2: `complete` and `complete_with_limitations` are reachable
only from `validating`.

**What 4D must not do**

- Do not read `answer_evidence` or `answers` directly; go through the repositories, which take the
  owner as a predicate.
- Do not construct a citation. Resolve one through `resolveCitation`, or render the ones on the
  claim, which the server already built.
- Do not add a briefing path that writes to `answers`. A briefing is a different record; sharing
  the table would put two lifecycles on one state machine.
- Do not treat a conversation as memory. If a briefing should remember something, it goes through
  `MemoryService.remember` and the owner confirms it.
