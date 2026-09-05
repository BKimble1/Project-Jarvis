# Phase 3 handoff — the multi-agent factory

What was built, what is proved and how, what is real versus simulated, and what is left.

## 1. What Jarvis can do now that it could not before

A mission is no longer one agent doing one thing. It is a small, acyclic graph of tasks, each with
a role, a permission ceiling, an isolated workspace and a declared write set — and you approve that
graph, agent by agent, before anything starts.

|                    | Phase 2              | Phase 3                                                           |
| ------------------ | -------------------- | ----------------------------------------------------------------- |
| Agents per mission | 1                    | Up to the ceiling you set (default 3)                             |
| Parallelism        | None                 | Read-only tasks run together; overlapping writers never do        |
| Workspace          | One per mission      | One per task, plus one integration workspace                      |
| Branches           | One mission branch   | One branch per writing task, merged into an integration branch    |
| Verification       | Once, after the work | Once per round, against the integrated result                     |
| Review             | None                 | Independent, cold-context, before delivery — with policy override |
| Failure handling   | Stop                 | Bounded repair rounds, then stop                                  |
| Delivery record    | A pull request       | A completion receipt with eight evidenced stages                  |
| Reusability        | None                 | Versioned playbooks                                               |
| Oversight          | Mission page         | Operations page, and a scoped read-only wallboard                 |

## 2. Verification categories — what is actually true

§29 asks these to be distinguished rather than blurred. They are.

### Automated verification — **complete and green**

`npm run verify`: format → lint → type check → unit → integration → production build → end-to-end.

| Suite                    | Files | Tests                |
| ------------------------ | ----- | -------------------- |
| Unit                     | 11    | 656                  |
| Integration              | 9     | 146                  |
| End-to-end (2 viewports) | 8     | 55 passed, 7 skipped |

The whole gate takes about 21 minutes. The seven skipped end-to-end cases are the viewport sweep
under the iPhone project: it sets its own viewport for every case, so running it a second time
would take twice as long to prove the same thing.

No test was weakened or quarantined to make this pass. Two Phase 2 assertions changed and
both are documented in the commit that changed them, with the underlying guarantee preserved:

- `allowedNextStates('queued', 'worker')` was rewritten to assert the _asymmetry_ it existed to
  protect (a worker may start a queued mission and an owner may not) rather than an exact array
  that a new legal transition would have broken.
- The export test's key scan gained a three-name allow-list — `credentialConfigured`,
  `tokenPrefix`, `signingSecretNames` — each of which is _about_ a credential rather than being
  one, with the reason written next to it.

### Scripted-runtime verification — **complete**

`tests/integration/multi-agent-smoke.test.ts` is the §30 test. It uses a real PGlite database, the
real shipping route handlers, the real orchestrator, real `TaskRunner` workers and a real git
repository on disk. Only the model (a scripted runtime) and GitHub's API (`FakeDelivery`) are
replaced. In one run it proves all thirteen §30 claims:

1. a task graph is created; 2. two read-only tasks run concurrently on two workers; 3. the builder
   waits for required research; 4. the builder uses an isolated branch; 5. verification runs;
2. the reviewer receives cold context; 7. the reviewer catches a deliberately seeded defect;
3. repair is bounded; 9. a _fresh_ reviewer evaluates the repaired work; 10. the integration branch
   stays separate from `main`; 11. a draft pull request is produced; 12. no merge occurs; 13. no
   forbidden API is called — asserted by enumerating `GitHubDelivery`'s prototype, because a
   capability that does not exist cannot be used by mistake.

### Real Git verification — **complete**

Every clone, branch, commit, merge, push and refusal in the smoke test and in
`tests/integration/worker-runner.test.ts` is real `git` against a bare repository created fresh
under the OS temp directory. Nothing leaves the machine, and no test touches a repository that
exists anywhere else.

### Live-Claude verification — **NOT PERFORMED**

No Anthropic credential is configured in this environment. Per §2 no secret was requested, none was
fabricated, and no environment value was exposed. **The live Prompt 2 worker path therefore remains
unverified, and so does the live Prompt 3 path.** Everything above ran against the scripted runtime.

What this means concretely: the _orchestration_ is proved — claiming, dependencies, leases,
isolation, integration, verification, the review gate, repair bounds, delivery and every refusal.
What is _not_ proved is that a real Claude session produces useful work inside that orchestration,
or that its output parses as expected in the shapes a real model produces.

Jarvis is honest about this at runtime, not just here: a worker reports `runtimeAvailable` in its
heartbeat, the workers page shows it, and a worker with no model credential accepts only the
deterministic roles (`verifier`, `integrator`) rather than claiming a task it cannot perform.

### Real GitHub verification — **NOT PERFORMED**

No GitHub write credential is configured. The delivery client is exercised against a local mock in
end-to-end tests and against `FakeDelivery` in integration tests. The CI controller has never
called GitHub Actions.

### Local Git mock verification — **not applicable**

Nothing is mocked at the git layer. Git is real everywhere; only the _remote_ is local.

### TestFlight — **controller mocked only**

No TestFlight upload has ever been attempted. `WorkflowDispatcher` has been exercised only through
its interface. The gates (R-TF1–R-TF12) are unit- and integration-tested; the dispatch itself is
not, and the receipt reports App Store Connect processing as `unknown` because Jarvis cannot see it.

## 3. What the tests found

The tests are the reason to trust the above, so it is worth recording what they caught. Fifteen
real defects, none of which were visible by reading the code:

**From the real-handler suite**

1. `dispatchIdentity` joined its components with NUL — the one character a PostgreSQL `text` column
   refuses — so no release approval could ever be stored.
2. `WorkerService.enrol` wrote a placeholder row whose `token_hash` was the constant `'pending'`,
   which collides on the unique index whenever two workers are enrolled at once.
3. The TestFlight gate refused every `ios_app` project — the one type it exists for.
4. Four playbooks, including both iOS ones, declared `supportedProjectTypes: ['software']` and so
   would never run on the project type they were written for.
5. `MissionRun` never surfaced the `task_id`, `role`, `permission_profile_id` or `repair_round`
   columns the migration added, so nothing could tell which agent ran which task.

**From the multi-agent smoke test**

6. Nothing ever wrote `mission.repository_owner`, and both the task assignment and the graph
   proposer read it — so every task would have been handed no repository at all.
7. The independent reviewer was given no diff and a clone that did not contain the work.
8. Task branches and the integration branch were never published, so no other agent could see them.
9. A repair round produced only repairer + reviewer: the fix never reached the integration branch,
   and an approval would have opened a pull request for a branch without it.
10. R-RV1 overrode an approval standing on a failed required check, and then "no blocking findings"
    let delivery through anyway.
11. When review blocked or the repair limit was reached, the review task was marked succeeded —
    which satisfied delivery's dependency and shipped the work regardless.
12. `preparing → verifying` was missing from the task state machine.
13. The task runner looked up sandbox redirects without lower-casing, so a repository with a capital
    letter would have escaped the sandbox and cloned the real thing.
14. `MissionReview` dropped the proposed verdict and the override rule.
15. Integration reset to the base every round, making the second push a non-fast-forward.

**From visual QA**

16. The wallboard showed a green health dot with zero workers connected.
17. The operations page gave no hint that an approved graph would simply wait with no worker.

## 4. Migration

`drizzle/0002_factory.sql` adds thirteen tables, thirty-eight indexes, eleven columns and
twenty-one constraints, and is idempotent throughout (`IF NOT EXISTS`, and constraints wrapped in
`DO $ … EXCEPTION WHEN duplicate_object`), so a half-applied migration recovers rather than
wedging.

The one change that needed care: `mission_runs` gained `task_id`, and Phase 2's one-run-per-attempt
uniqueness had to survive. Widening the existing index would have destroyed it, because PostgreSQL
treats NULLs as distinct. Two **partial** unique indexes were used instead — one `where task_id is
null` preserving the Phase 2 rule exactly, one `where task_id is not null` for task runs.

Run with `npm run db:migrate`. PGlite migrates itself on first use.

## 5. Configuration

Nothing new is required. Every Phase 3 variable has a default, and the factory works with none of
them set. See `.env.example` and `docs/OPERATIONS.md`.

The two that change behaviour meaningfully:

- `JARVIS_MAX_PARALLEL_WRITERS` (default 1). Raising it lets two agents write at once _when their
  write sets do not overlap_. Overlapping writers are still serialised.
- `JARVIS_CI_ENABLED` (default false). External builds are inert until this, a controller
  credential, and the three allow-lists are all set.

## 6. What is deliberately still impossible

Unchanged from Phase 2 and re-proved here: no merge to a default branch, no force push, no
deployment, no App Store submission, no public release, no repository-settings or secrets access.

New in Phase 3, and structural rather than checked: an agent cannot assign itself another role,
increase concurrency, increase a budget, add a repair attempt, modify security policy, modify a
mandatory review requirement, enable a CI controller, add a repository to an allow-list, create a
display token, approve a plan, approve a task graph, approve a TestFlight build, or approve its own
output. In every case there is no worker-authenticated route that could do it.

## 7. Known limitations

- **No live model has run through this.** See §2 above. This is the single biggest gap.
- **Task branches live in the repository.** They are the durable record and the only way an
  integrator on another machine can reach them, but a mission's intermediate work is visible under
  `jarvis/…` until it is cleaned up. Nothing deletes them.
- **A worker with no GitHub write credential can build but cannot hand its work to anyone.** It
  says so, and the integrator that cannot see the branch says so too, but the mission stops there.
- **Repair scope is the accepted findings, and nothing wider.** A repair that genuinely needs a
  change outside its scope is meant to stop and say so rather than widen itself. Whether a real
  model does that reliably is exactly what live verification would tell us.
- **`estimatedCostUsd` is whatever the runtime reported.** Jarvis counts tokens and does not
  convert them to money.
- **The wallboard is a summary, not a monitor.** It refreshes on an interval and says how old its
  data is. It is not a real-time feed and does not claim to be.
- **One owner.** No roles, no sharing, no delegation, and none planned.

## 8. Suggested next steps, in order

1. **Configure a live worker and run one real mission end to end.** Everything else is downstream
   of this. The scripted runtime proves the orchestration; only a real session proves the work.
   Start with a low-risk `repository_audit` — read-only, no branch, no pull request — then a
   `software_feature` on a repository you do not mind branches appearing in.
2. **Watch the first review closely.** Whether `parseReview` copes with what a real model emits,
   and whether the cold context is enough to review from, are the two things most likely to need
   adjustment.
3. **Decide on branch cleanup.** Task branches accumulate. A deliberate policy — delete on
   successful delivery, keep on failure — is a small change and worth making before there are
   fifty of them.
4. **Only then consider CI.** The gates are tested but the dispatch has never run. Configure it
   against a repository whose workflows you are happy to have triggered, and watch the first one.

Do not enable TestFlight until 1–4 are done.
