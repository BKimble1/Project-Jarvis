# Mission rules

Every decision Mission Control makes carries a rule id. This is the list. If Jarvis refuses
something, or classifies it in a way that surprises you, the rule id in the message points here.

Nothing on this page involves a model. These are deterministic pattern and state rules, so the
same request always produces the same verdict.

---

## Risk classification — `R-RISK-*`

Run on the mission text and the owner's constraints, at intake and again after any edit.

### Prohibited

Jarvis will not plan or execute these at all. Each is either irreversible, outside the
review-before-merge model the product is built on, or an attempt to weaken Jarvis itself.

| Rule         | What it catches                                                                 |
| ------------ | ------------------------------------------------------------------------------- |
| `R-RISK-P01` | Force pushing                                                                   |
| `R-RISK-P02` | Rewriting git history, `filter-branch`, rebase-and-force                        |
| `R-RISK-P03` | Merging into a default branch; auto-merge                                       |
| `R-RISK-P04` | Deleting a repository                                                           |
| `R-RISK-P05` | Reading or changing repository/Actions secrets                                  |
| `R-RISK-P06` | Repository settings, branch protection, collaborator access                     |
| `R-RISK-P07` | TestFlight, App Store submission                                                |
| `R-RISK-P08` | Apple signing certificates and provisioning profiles                            |
| `R-RISK-P09` | Publishing a release or a package                                               |
| `R-RISK-P10` | Deploying to production; production infrastructure; `terraform apply`           |
| `R-RISK-P11` | Financial transactions                                                          |
| `R-RISK-P12` | Sending external communications                                                 |
| `R-RISK-P13` | Disabling authentication or authorization                                       |
| `R-RISK-P14` | Skipping, disabling or deleting tests or CI to get a green build; `--no-verify` |
| `R-RISK-P15` | Modifying Jarvis's own security policy                                          |

A prohibited request never becomes a mission at all — there is no row that could later be approved
by mistake. It is refused with the rule that caught it, whatever else the sentence says: _"just
research how to force push to main"_ is still refused.

### High risk

Plannable, but only executable when the approved plan is reduced to a review-only draft pull
request that publishes and deploys nothing (`R-MQ8`).

| Rule         | What it catches                                     |
| ------------ | --------------------------------------------------- |
| `R-RISK-H01` | Authentication, authorization, sessions, passwords  |
| `R-RISK-H02` | Payments, billing, subscriptions, checkout, pricing |
| `R-RISK-H03` | Database schema changes and migrations              |
| `R-RISK-H04` | Continuous-integration configuration                |
| `R-RISK-H05` | Infrastructure and deployment configuration         |
| `R-RISK-H06` | Cryptography and certificates                       |
| `R-RISK-H07` | Deleting data                                       |

### Moderate, low and read-only

| Rule         | Level     | What it catches                             |
| ------------ | --------- | ------------------------------------------- |
| `R-RISK-M01` | Moderate  | New user-facing behaviour                   |
| `R-RISK-M02` | Moderate  | Refactors and restructuring                 |
| `R-RISK-M03` | Moderate  | Dependency changes                          |
| `R-RISK-M04` | Moderate  | The bare verb "fix"                         |
| `R-RISK-L01` | Low       | Documentation, wording, comments            |
| `R-RISK-L02` | Low       | Adding tests                                |
| `R-RISK-L03` | Low       | Formatting and linting                      |
| `R-RISK-R01` | Read-only | Research, investigation, review, comparison |
| `R-RISK-R02` | Read-only | Planning only                               |

### Refinements

| Rule         | What it does                                                                                                                                                                              |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `R-RISK-D01` | Nothing matched, so Jarvis assumes an ordinary code change rather than assuming it is harmless                                                                                            |
| `R-RISK-T01` | A read-only mission type forces read-only, whatever the text says                                                                                                                         |
| `R-RISK-T02` | A file-changing mission type raises a read-only-sounding request to low                                                                                                                   |
| `R-RISK-X01` | When only the bare verb "fix" made a request moderate and something specific says documentation, tests or formatting, the specific signal wins — _"fix a typo in the readme"_ is low risk |

---

## Queueing — `R-MQ*`

Checked before a mission can be queued, and again by the worker at claim time.

| Rule    | Refuses when                                                     |
| ------- | ---------------------------------------------------------------- |
| `R-MQ1` | The mission is prohibited                                        |
| `R-MQ2` | There is no project                                              |
| `R-MQ3` | The project is archived                                          |
| `R-MQ4` | There is no plan                                                 |
| `R-MQ5` | The plan is not approved                                         |
| `R-MQ6` | The approved version is not the current version                  |
| `R-MQ7` | The project is paused and there is no explicit one-time override |
| `R-MQ8` | The mission is high risk and the plan is not review-only         |

## Claiming — `R-MC*`

| Rule    | Refuses when                                      |
| ------- | ------------------------------------------------- |
| `R-MC1` | The worker is revoked                             |
| `R-MC2` | The mission is not queued                         |
| `R-MC3` | The approved plan version moved on since queueing |
| `R-MC4` | The mission already has an active run             |
| `R-MC5` | The concurrency limit is already used             |

## Resuming — `R-MR*`

| Rule    | Refuses when                                                                                        |
| ------- | --------------------------------------------------------------------------------------------------- |
| `R-MR1` | The mission was **stopped** — a stopped mission is retried as a new attempt, never silently resumed |
| `R-MR2` | The mission is not paused                                                                           |
| `R-MR3` | The plan changed while it was paused                                                                |
| `R-MR4` | The worker that holds it is not connected                                                           |
| `R-MR5` | The workspace is no longer available, so it needs a fresh session                                   |

---

## Clarification — `R-CL*`

Jarvis asks at most three questions at a time, and only where a different answer would produce
different work.

| Rule     | Asks about                                                                             |
| -------- | -------------------------------------------------------------------------------------- |
| `R-CL1`  | Which project — Jarvis never guesses between projects                                  |
| `R-CL2`  | An archived project                                                                    |
| `R-CL3`  | A paused project                                                                       |
| `R-CL4`  | A completed project                                                                    |
| `R-CL5`  | Research versus implementation, when the request reads as both                         |
| `R-CL6`  | Which repository, when the project genuinely has more than one                         |
| `R-CL7`  | Acceptance criteria, on moderate-or-above write work                                   |
| `R-CL8`  | Areas that must not change, on high-risk work                                          |
| `R-CL9`  | The desired outcome, when the request is too short to act on                           |
| `R-CL10` | The platform target, for an iOS app — because it decides what can honestly be verified |

Answering "let Jarvis decide" records the answer as **inferred**, never as **manual**. An
assumption Jarvis made on your behalf must never later read as a decision you took.

## Project gates — `R-PG*`

| Rule    | Effect                                                                                    |
| ------- | ----------------------------------------------------------------------------------------- |
| `R-PG0` | No project: cannot plan                                                                   |
| `R-PG1` | Archived: cannot plan or execute; restore it first                                        |
| `R-PG2` | Prohibited: not planned either                                                            |
| `R-PG3` | Paused: may plan; executing needs an explicit override                                    |
| `R-PG4` | Completed: may plan; reopening needs confirmation                                         |
| `R-PG5` | Blocked: may plan and execute, but Jarvis does not claim the mission resolves the blocker |
| `R-PG6` | Unknown status: surfaced as reduced context, not hidden                                   |

---

## Status Brain — `R-MS*`

How a mission becomes something the Status Brain says. Every conclusion is `verified` — Jarvis
wrote the rows itself — but what each state _implies_ is carefully hedged.

| Rule     | Conclusion                                                                               |
| -------- | ---------------------------------------------------------------------------------------- |
| `R-MS1`  | A mission needs clarification → decision required                                        |
| `R-MS2`  | A plan awaits approval → decision required                                               |
| `R-MS3`  | Waiting for permission → **critical**: an agent is stopped dead                          |
| `R-MS4`  | Waiting for an answer → decision required                                                |
| `R-MS5`  | A draft pull request is ready → for review, explicitly **not merged**                    |
| `R-MS6`  | Failed → with what was preserved                                                         |
| `R-MS7`  | Stopped → not active; work preserved                                                     |
| `R-MS8`  | Completed in the last week → recently completed                                          |
| `R-MS9`  | Queued → approved and waiting for a worker                                               |
| `R-MS10` | Paused → workspace and branch preserved                                                  |
| `R-MS11` | Active but the worker is silent → flagged, and listed as an **unknown**, not as progress |
| `R-MS12` | Active and reporting → current work                                                      |
| `R-MS13` | Inspecting or planning → current work                                                    |

`R-MS11` is the one worth reading twice. A mission whose worker has gone quiet is never described
as progressing, and it is never marked complete or failed on the strength of silence.

---

## Push safety — `R-PUSH*`

Evaluated on the exact argument vector, before `git` is started.

| Rule      | Refuses                                                                                     |
| --------- | ------------------------------------------------------------------------------------------- |
| `R-PUSH1` | Any branch that is not `jarvis/<mission-id>-<slug>`                                         |
| `R-PUSH2` | A push to the recorded default branch                                                       |
| `R-PUSH3` | `--force`, `-f`, `--force-with-lease`, `--mirror`, `--all`, `--tags`, `--delete`, `--prune` |
| `R-PUSH4` | A forcing refspec (`+ref`)                                                                  |
| `R-PUSH5` | A deleting refspec (`:ref`)                                                                 |
| `R-PUSH6` | A refspec that updates any branch other than the mission branch                             |

## Worker policy — `P-*`

Runs inside the worker, on every tool call, whatever the model believes.

| Rule                  | Denies                                                               |
| --------------------- | -------------------------------------------------------------------- |
| `P-CMD01`–`P-CMD02`   | Force pushes and multi-ref pushes                                    |
| `P-CMD03`             | `merge`, `rebase`, `reset --hard`, `filter-branch`                   |
| `P-CMD04`             | Changing git remotes or global configuration                         |
| `P-CMD05`             | `sudo`, `doas`, `su`                                                 |
| `P-CMD06`             | Broad recursive deletion                                             |
| `P-CMD07`             | `gh pr merge`, `gh release`, `gh secret`, `gh repo delete`           |
| `P-CMD08`             | Publishing a package                                                 |
| `P-CMD09`             | Infrastructure and deployment tools                                  |
| `P-CMD10`             | Build upload and App Store tooling                                   |
| `P-CMD11`             | Credential stores, SSH keys, `.aws/credentials`, `.netrc`, `.npmrc`  |
| `P-CMD12`             | Piping a download into a shell                                       |
| `P-CMD13`             | Broad permission changes                                             |
| `P-CMD14`             | _Any_ push — the worker performs the push itself, after verification |
| `P-PATH01`–`P-PATH02` | Anything outside the mission workspace                               |
| `P-RO01`–`P-RO02`     | Writes and mutating commands on a read-only run                      |
| `P-SEC01`             | Reading a `.env` or secrets file → **asks** the owner                |
| `P-SEC02`             | Writing one → denied outright                                        |
| `P-DNT01`             | An area the owner marked off limits → **asks**                       |
| `P-WEB01`             | Web access when it is not enabled → **asks**                         |
| `P-UNK01`             | An unrecognised tool → **asks**, never a silent allow                |
