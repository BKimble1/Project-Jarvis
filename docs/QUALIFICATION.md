# Qualification

Jarvis does not have a health flag. It has six separate claims, and it will tell you which of
them it has actually earned.

| Level                               | What it means                                                                                                                     |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| **Built**                           | The functionality exists in the code. Nothing has been run to prove it behaves.                                                   |
| **Automated verification passed**   | The full test gate passed on this build.                                                                                          |
| **Simulated runtime passed**        | The multi-agent smoke test ran the real orchestrator, real routes, real workers and real git, with the model and GitHub replaced. |
| **Live read qualification passed**  | A real model inspected a real sandbox repository with no write authority, and produced a report.                                  |
| **Live write qualification passed** | A real model produced a branch and a draft pull request in an approved sandbox repository. Nothing was merged.                    |
| **Production-qualified**            | Every required live check, recovery check and security check has passed.                                                          |

These are never collapsed into one number. The Operations screen shows the whole ladder, and the
activation lock consults it before anything runs unattended.

## What the level controls

The ladder is not decorative. Each rung unlocks specific unattended behaviour:

| Capability                           | Needs      |
| ------------------------------------ | ---------- |
| Refresh evidence on a schedule       | Automated  |
| Produce a briefing on a schedule     | Automated  |
| Send a notification on a schedule    | Automated  |
| Run read-only research on a schedule | Live read  |
| Draft a mission on a schedule        | Live read  |
| Run a read-only agent task           | Live read  |
| Run an agent task that writes        | Live write |
| Push a branch or open a pull request | Live write |
| Start a CI workflow                  | Production |
| Send a build to TestFlight           | Production |

**"Unattended" is the operative word.** A mission you approved yourself is attended: you read the
plan, you read the task graph, you pressed approve. The lock exists for the things that happen
while you are asleep.

When a capability is locked, Jarvis degrades rather than breaking. The scheduled sync still
refreshes evidence and still produces a briefing — deterministically, without a model — and says
so in its response and in the audit trail. A control that switches the morning briefing off
entirely is a control that gets switched off.

## Running it

From the interface: **Operations → Qualification**.

From a terminal, against whichever database the environment is configured for:

```bash
npm run qualify                 # show the ladder, every check, and what is locked
npm run qualify -- run          # run every self-evaluable check and record the result
```

Neither prints a credential. The checks establish presence, identity and behaviour; there is no
field on a result that could hold a secret value.

## The seventeen checks

Each check says what a pass would establish, and what would fix it if it does not.

**For live read**

- `worker_enrolled` — a worker is enrolled and sending heartbeats.
- `worker_version` — every worker's build matches this control plane's major version.
- `model_provider` — a worker reports a usable model runtime. Jarvis knows only that; the key
  never leaves the worker.
- `github_read` — the read credential works, and reports which identity it authenticated as.
- `sandbox_selected` — a sandbox repository has been chosen.
- `sandbox_allow_listed` — that repository is in `JARVIS_QUALIFICATION_REPOS`.
- `live_read_audit` — a recorded live read against the sandbox.

**For live write**

- `github_write_credential` — a write credential exists at the delivery boundary: the worker's,
  or the CI controller's. Never the read token widened, and never in the browser.
- `verification_discoverable` — the sandbox defines checks the worker can find and run.
- `delivery_restricted` — asserted against the objects, not the documentation. The delivery client
  exposes exactly four methods and the CI dispatcher three; neither has a generic request method,
  because one call taking an arbitrary path and body is every forbidden operation at once.
- `live_write_draft_pr` — a recorded live write against the sandbox, with a draft pull request.

**For production**

- `backup_configured` — backups exist _and_ a restore has been rehearsed. An untested backup is a
  belief, not a control.
- `migrations_applied` — every migration this build expects is applied.
- `notification_destination` — there is at least one way to reach you. In-app satisfies this, and
  the check says plainly that in-app alone means finding out when you next open Jarvis.
- `display_read_only` — the display-authenticated routes answer only the methods a wallboard may.
- `recovery_drill` — a worker crash, a failed deployment and a database restore have been walked
  through.
- `security_review` — the current build was reviewed against the threat model. Recorded against a
  build ref, and it stops counting when the build changes.

## Three ways a level cannot be faked

**An absent answer is never a pass.** A check that cannot run reports `unavailable`. An
environment with no model credential lands honestly on _automated_ rather than on a rung it has
not earned. `not_applicable` counts only when it carries a reason of at least ten characters —
without that, every check eventually becomes optional.

**A later rung cannot carry an earlier one.** `evaluateQualification` walks upward and stops at
the first unsatisfied rung. Every live check passing while the test suite has never reported still
leaves the system at _built_.

**Live rungs are read, not asserted.** There is no form where you tell Jarvis a live run happened.
You point at a finished mission and it reads what that mission actually produced:

- **R-QL1** — the mission has to have succeeded.
- **R-QL2** — it has to have run against the selected sandbox.
- **R-QL3** — a write qualification needs a pull request that exists.
- **R-QL4** — a read qualification is refused if the mission opened one, and refused if it
  produced no report. A read-only run that wrote something is a failed read-only run.
- **R-QL5** — one mission produces one piece of evidence.

There is deliberately no endpoint, button or CLI flag that sets the level directly.

## Requalification

A qualification is a dated claim about a specific system. When the system changes underneath it,
the honest answer is that the claim no longer applies — so Jarvis compares the assumptions a run
was earned under against the ones that hold now, and demotes to _built_ when they differ.

Triggers: the worker protocol changed, the permission policy changed, the delivery credential
moved, the runtime changed, the integration or review algorithm changed, the sandbox changed, the
recovery or security check stopped passing, or ninety days elapsed.

An assumption that cannot be fingerprinted on either side does not trigger requalification. An
environment that cannot identify its runtime should land on `unavailable` for that check rather
than thrash between qualified and not.

Fingerprints record _that_ something changed, never _what to_. The credential assumption records
`worker+ci`, `worker+none` and so on — where a credential lives, never a hash of one. A hash of a
secret is still derived from a secret.

## Recording the suite

The _automated_ and _simulated_ rungs are earned by tests reporting, not by configuration.

```bash
npm run verify -- --record
```

records both against the configured database: the full gate for _automated_, and the multi-agent
smoke test — which runs inside the integration project the gate just passed — for _simulated_.

Recording is opt-in for a reason. A green run on a laptop says nothing about a production
deployment, so a developer running `npm run verify` cannot lift production's qualification.

A suite outcome carries the build ref it was recorded for. When the deployment moves to a new
commit, yesterday's green run stops counting.

## Configuration

| Variable                          | What it does                                                                                                                                                      |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `JARVIS_QUALIFICATION_REPOS`      | Repositories where a live rehearsal may happen. Jarvis having read access to a repository is not the same as that repository being somewhere to practise writing. |
| `JARVIS_BUILD_REF`                | The commit this build came from. Falls back to `COMMIT_REF` (Netlify). Without it, suite outcomes and security reviews cannot be tied to a build.                 |
| `JARVIS_BACKUP_CONFIGURED`        | Whether backups exist.                                                                                                                                            |
| `JARVIS_BACKUP_TARGET`            | A _label_ — `neon-pitr`, `nightly-s3`. Never a connection string; Jarvis has no reason to hold backup credentials and no field for them.                          |
| `JARVIS_BACKUP_RESTORE_TESTED_AT` | When a restore was last rehearsed. An unparseable value is ignored with a warning rather than read as evidence of a drill.                                        |

## If live credentials are not available

Everything except the live rungs still works, and the ladder says so accurately. The environment
sits at _automated verification complete; live qualification pending_, no scheduled job can run
model or write work, and every unavailable check names what would fix it.

That is the intended state for a deployment that has not yet been given a model provider. It is
not a degraded mode to work around.
