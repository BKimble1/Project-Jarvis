# Multi-agent rules

Every deterministic rule Phase 3 adds, with its identifier. The identifiers are in the code, in
the tests and in the error messages an owner sees, so a refusal can always be traced to the rule
that produced it. `MISSION_RULES.md` covers the Phase 2 rules, which all still apply.

## Task graphs — `validateTaskGraph`

| Rule   | What it refuses                                                 |
| ------ | --------------------------------------------------------------- |
| R-TG01 | A graph with no tasks.                                          |
| R-TG02 | More tasks than the configured maximum.                         |
| R-TG03 | A duplicate task key.                                           |
| R-TG04 | A task key that is not a valid identifier.                      |
| R-TG05 | A dependency on a task that does not exist.                     |
| R-TG06 | A task that depends on itself.                                  |
| R-TG07 | A role that is not one of the known roles.                      |
| R-TG08 | A permission profile wider than the role's ceiling.             |
| R-TG09 | A write set on a role that may not write.                       |
| R-TG10 | A write task with no write set at all.                          |
| R-TG11 | A write-set path that escapes the repository.                   |
| R-TG12 | A task requiring a repository when the mission has none.        |
| R-TG13 | More writing tasks than the configured maximum.                 |
| R-TG14 | A cycle. The cycle is named in the error.                       |
| R-TG15 | A wave wider than the parallelism limit.                        |
| R-TG16 | A mission that writes with no review task.                      |
| R-TG17 | A review task that reviews nothing.                             |
| R-TG18 | A review task that reviews a task it does not depend on.        |
| R-TG19 | A delivery task that does not depend on a review.               |
| R-TG20 | A review that is not preceded by verification.                  |
| R-TG21 | A missing specialist review the mission's risk requires.        |
| R-TG22 | Two tasks that may run in parallel with overlapping write sets. |
| R-TG23 | More repair rounds than allowed.                                |
| R-TG24 | A repair task with no findings to repair.                       |
| R-TG25 | An integration task that merges nothing.                        |
| R-TG26 | A task whose usage ceiling exceeds the configured maximum.      |

## Task state machine — `assertTaskTransition`

Nineteen states, and a table of legal moves with the actors allowed to make each. The table is
the guarantee, not a convention: a task cannot reach `succeeded` from `claimed`, a worker cannot
restart a cancelled task, and an owner cannot declare work finished.

The moves that matter most:

- `claimed → preparing → running → succeeded` — ordinary work.
- `preparing → verifying` — a verifier has no agent to start.
- `preparing → integrating` — an integrator has no agent at all.
- `verifying → awaiting_review` — verification always precedes review.
- `awaiting_review → succeeded` is **system only**. A worker cannot close its own review.
- `repair_required → awaiting_review` — a repair round, materialised by the system.

## Review verdicts — `decideVerdict`

| Rule  | Behaviour                                                                                                                                            |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| R-RV1 | An approval standing on a failed required check becomes `repair_required`, and the failing checks become a blocking finding so the repair has scope. |
| R-RV2 | A review that files blocking findings and then approves is overridden.                                                                               |
| R-RV3 | An unavailable review is `unavailable`, never a pass.                                                                                                |
| R-RV4 | A block with no finding becomes `owner_decision_required`.                                                                                           |

## Finding triage — `triageFindings`

| Rule  | Behaviour                                                       |
| ----- | --------------------------------------------------------------- |
| R-FT1 | A critical finding is accepted into repair scope automatically. |
| R-FT2 | A finding that blocks delivery is accepted.                     |
| R-FT3 | A security finding is accepted regardless of severity.          |
| R-FT4 | A product-judgement finding goes to the owner, not to a repair. |
| R-FT5 | Everything else is noted and carried forward.                   |

## Specialist reviews — `requiredSpecialistReviews`

| Rule  | Behaviour                                                                                     |
| ----- | --------------------------------------------------------------------------------------------- |
| R-SP1 | A change touching authentication, sessions, secrets or migrations requires a security review. |
| R-SP2 | A change touching user-facing screens requires a UI/UX review.                                |
| R-SP3 | A mission that may dispatch an external build requires a release review.                      |

## Capacity — `canStartTask` / `taskExceedsLimits`

| Rule    | Behaviour                                                    |
| ------- | ------------------------------------------------------------ |
| R-CAP1  | Nothing starts while the posture is `stopped` or `draining`. |
| R-CAP2  | Not past the global agent ceiling.                           |
| R-CAP3  | Not past the per-mission agent ceiling.                      |
| R-CAP4  | Not past the writer ceiling.                                 |
| R-CAP5  | Not past the read-only ceiling.                              |
| R-CAP6  | Not past the mission ceiling.                                |
| R-CAP7  | Not while an overlapping write lease is held.                |
| R-CAP8  | Not while a dependency is unfinished.                        |
| R-CAP9  | Not a task in a terminal state.                              |
| R-CAP10 | Not a task in an unapproved graph.                           |
| R-CAP11 | Not a task whose attempts are used up.                       |
| R-CAP12 | A task past its runtime ceiling is stopped.                  |
| R-CAP13 | A task past its output-token ceiling is stopped.             |

## CI dispatch — `evaluateCiDispatch`

| Rule   | Behaviour                                                            |
| ------ | -------------------------------------------------------------------- |
| R-CI1  | The controller must be enabled.                                      |
| R-CI2  | It must have a credential of its own. It never borrows the worker's. |
| R-CI3  | The repository name must be a repository name.                       |
| R-CI4  | The repository must be on the allow-list.                            |
| R-CI5  | The workflow must be named by its file.                              |
| R-CI6  | The workflow must be on the allow-list.                              |
| R-CI7  | The ref must be a git ref.                                           |
| R-CI8  | The ref must be on the allow-list.                                   |
| R-CI9  | An exact 40-character commit is required.                            |
| R-CI10 | At most the configured number of inputs.                             |
| R-CI11 | Input names must be valid.                                           |
| R-CI12 | Input values are bounded.                                            |
| R-CI13 | Not past the hourly dispatch ceiling.                                |

Policy is re-evaluated immediately before the call to GitHub, not trusted from when the request
was recorded — an allow-list edited in between has to take effect.

## TestFlight — `evaluateTestFlightDispatch`

| Rule   | Behaviour                                                                               |
| ------ | --------------------------------------------------------------------------------------- |
| R-TF1  | Software or iOS projects only.                                                          |
| R-TF2  | The repository must be allow-listed for external builds.                                |
| R-TF3  | The project must have an app profile naming a TestFlight workflow.                      |
| R-TF4  | The signing configuration must be present — by _name_, never by value.                  |
| R-TF5  | There must be an exact commit to build.                                                 |
| R-TF6  | Required checks must have passed for that commit.                                       |
| R-TF7  | The commit must have passed independent review.                                         |
| R-TF8  | You must have approved a TestFlight build **for that exact commit**.                    |
| R-TF9  | A revoked approval does not apply.                                                      |
| R-TF10 | A used approval does not apply again.                                                   |
| R-TF11 | An approval for a different repository, workflow, ref, commit or inputs does not apply. |
| R-TF12 | An approval that is not in force does not apply.                                        |

Approving requires typing `upload to testflight`. Approving supersedes every other live approval
for the project, and a moved commit supersedes the approval rather than leaving it live.

## Playbooks — `validatePlaybook`

| Rule   | Behaviour                                                                |
| ------ | ------------------------------------------------------------------------ |
| R-PB1  | A key that is not a valid identifier.                                    |
| R-PB2  | No tasks.                                                                |
| R-PB3  | A duplicate task key.                                                    |
| R-PB4  | A dependency on a task the playbook does not define.                     |
| R-PB5  | A task whose profile exceeds its role's ceiling.                         |
| R-PB6  | A playbook that writes without requiring a review.                       |
| R-PB7  | More repair rounds than the absolute ceiling.                            |
| R-PB8  | A duplicate check id.                                                    |
| R-PB9  | A playbook that claims it can dispatch a build without a release review. |
| R-PB10 | An input referenced by a task but not declared.                          |
| R-PB11 | A parallelism setting above the absolute ceiling.                        |

A playbook that fails its own validator is never installed — shipping one Jarvis would refuse to
run is a bug worth seeing, and installing it anyway would make the validator advisory.

## Status Brain — mission and agent claims

| Rule         | Claim                                                                                                           |
| ------------ | --------------------------------------------------------------------------------------------------------------- |
| R-MS1–R-MS13 | Phase 2 mission-state claims. See `MISSION_RULES.md`.                                                           |
| R-MS14       | How many agents are working, how many may write, whether a review is under way, whether this is a repair round. |
| R-MS15       | The repair budget was used up and the work still does not pass review. Jarvis stopped.                          |
| R-MS16       | An agent changed files outside the approved write set. It was stopped and the workspace preserved.              |
| R-MS17       | Agents are waiting on the owner before continuing.                                                              |

R-MS14–R-MS17 are the only mission claims folded into a project's attention; R-MS1–R-MS13 already
have a home in Mission Control and would otherwise appear twice on one screen.

## Display payloads

A wallboard payload is built from scratch rather than filtered from the owner's, and
`findForbiddenDisplayKeys` scans the finished object. A field named `pullRequestUrl`,
`repositoryName`, `branch`, `diff`, `transcript`, `token`, `filePath` or similar fails the request
rather than reaching a screen in a shared room.
