# Deterministic status rules

Every rule below lives in `src/server/status/` and is unit-tested by id. Jarvis attaches the rule
id to the claim, attention reason or recommendation it produced, so any displayed status can be
traced back to the exact rule that produced it.

Thresholds are in `src/server/status/constants.ts`; freshness windows are per project type in
`src/domain/freshness.ts`.

## Status derivation (`deriveStatus`)

| Rule                                   | Behaviour                                                                                                                                                       | Provenance |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| `R-ST1-archived-project`               | An archived project reports **archived**.                                                                                                                       | Manual     |
| `R-ST2-archived-repository`            | A project whose repository is archived on GitHub reports **archived** unless the owner marked it complete.                                                      | Verified   |
| `R-ST3-owner-declared-terminal-state`  | `completed`, `paused` and `archived` are never overridden by evidence. A paused project is never described as progressing; a stray commit does not un-pause it. | Manual     |
| `R-ST4-active-blocker-implies-blocked` | An active blocker on an otherwise active project reports **blocked**.                                                                                           | Inferred   |
| `R-ST5-no-status-recorded`             | An unset status stays **unknown**.                                                                                                                              | Unknown    |
| `R-ST6-owner-declared-status`          | Otherwise the owner's status stands.                                                                                                                            | Manual     |

## Evidence interpretation

| Rule                                  | Behaviour                                                                                                                                      | Provenance                           |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| `R-WF1` (`latestWorkflowStates`)      | Only the newest run per workflow name counts. A failure followed by a success is **not** a failing build.                                      | Verified                             |
| `R-WF2` (`failingWorkflows`)          | A build is failing only if the newest run for that workflow concluded `failure`, `timed_out` or `startup_failure` within the window (14 days). | Verified                             |
| `R-PR1-merged-pr-is-completed-work`   | A pull request merged inside the window is recently completed work.                                                                            | Verified                             |
| `R-PR2-active-open-pr`                | An open, non-draft pull request updated inside the window evidences work in progress.                                                          | Verified                             |
| `R-RC5-stalled-pull-requests`         | An open pull request untouched beyond the window is **not** evidence of active work; it becomes a recommendation to review or close.           | Verified                             |
| `R-CW1-recent-commits`                | Commits inside the activity window evidence work in progress.                                                                                  | Verified                             |
| `R-RL1-release-is-completed-work`     | A published (non-draft) release is completed work.                                                                                             | Verified                             |
| `R-MS1-manual-milestone-stays-manual` | A milestone the owner ticked stays **Manual** unless another source verifies it.                                                               | Manual → Verified only with evidence |
| `R-MU1-manual-update-is-manual`       | An owner-written update is Manual, never Verified.                                                                                             | Manual                               |
| `R-CW0-paused-not-progressing`        | A paused project's "current work" says it is paused.                                                                                           | Manual                               |

## Freshness (`assessFreshness`, `computeFreshness`)

| Rule     | Behaviour                                                                                                                                                                                                                                                                                                    |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `R-FR1`  | A failed synchronisation marks the data **failing** and preserves the last good observation. It is never treated as evidence that no activity occurred.                                                                                                                                                      |
| `R-FR1a` | "Failing" is decided **per source**, against that same source's last success. A healthy second source — or the owner typing a manual update — never masks a broken one, and never turns last-known-good data into "up to date".                                                                              |
| `R-FR1b` | The observation date shown for a failing project is the last successful _synchronisation_, not a later manual edit, because that is the moment the data on screen actually dates from. Evidence belonging to a failing source is excluded from that calculation; evidence from healthy sources still counts. |
| —        | `live` / `recent` / `stale` thresholds vary by project type: a software repository is expected to produce evidence far more often than a career project.                                                                                                                                                     |
| —        | `never` means nothing has ever been observed — distinct from "nothing happened".                                                                                                                                                                                                                             |
| —        | A stale or failing source can never support a claim that the status is up to date; the headline says so explicitly (`R-HL5`, `R-HL7`).                                                                                                                                                                       |

## Attention (`attentionReasons`)

| Rule                                    | Trigger                                                                                                  | Severity         |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------- | ---------------- |
| `R-AT1-blocker-requires-owner-decision` | An active blocker flagged as needing the owner's decision.                                               | critical         |
| `R-AT2-active-blocker`                  | Any other active blocker.                                                                                | its own severity |
| `R-AT3-recent-failed-workflow`          | A recently failed workflow (higher when on the default branch).                                          | high / medium    |
| `R-AT4-source-sync-failed`              | A source whose last synchronisation failed — an operational warning about Jarvis, not about the project. | medium           |
| `R-AT5-stale-project`                   | Stale or never-observed evidence on a project the owner still treats as live.                            | low              |
| `R-AT6-overdue-next-action`             | A next action past its due date.                                                                         | high / medium    |
| `R-AT7-target-date-passed`              | A target date in the past on an unfinished project.                                                      | medium           |
| `R-AT8-archived-repository`             | The repository is archived but the project is not marked complete.                                       | low              |

## Recommendations (`recommendActions`)

Ordered by what is actually blocking, then by what the owner already planned.

| Rule                                   | Behaviour                                                                                  |
| -------------------------------------- | ------------------------------------------------------------------------------------------ |
| `R-RC1-decision-blocker-first`         | Decisions the owner owes come first — nothing else can move.                               |
| `R-RC2-fix-failing-build`              | Fix a failing workflow, citing the run.                                                    |
| `R-RC3-clear-active-blocker`           | Clear remaining active blockers.                                                           |
| `R-RC4-owner-next-action`              | The owner's own next actions outrank anything Jarvis would invent.                         |
| `R-RC5-stalled-pull-requests`          | Review or close stalled pull requests.                                                     |
| `R-RC6-completed-project-wrap-up-only` | A completed project receives wrap-up advice only — never ordinary development suggestions. |
| `R-RC7-archived-no-development-advice` | An archived project receives only "confirm or restore".                                    |
| `R-RC8-recover-sync`                   | A failed synchronisation prompts a re-run and a credential check.                          |
| `R-RC9-stale-needs-update`             | A stale project prompts a synchronisation or a written update.                             |
| `R-RC10-missing-goal`                  | With no goal recorded, the first recommendation is to write one.                           |

## Headline (`buildHeadline`)

`R-HL1` archived · `R-HL2` completed · `R-HL3` paused · `R-HL4` blocked · `R-HL5` sync failing ·
`R-HL6` no evidence · `R-HL7` stale · `R-HL8` progressing · `R-HL9` shipped recently but nothing in
flight · `R-HL10` waiting · `R-HL11` active but no evidence of work.

`R-HL6`, `R-HL7` and `R-HL11` are labelled **Unknown**, not Verified — Jarvis says it does not know
rather than implying quiet means fine.

## Unknowns (`collectUnknowns`)

Jarvis states what it cannot see: a missing goal, a missing phase, an unset status, everything
since a failed synchronisation, whether work continued past stale evidence, data categories a
credential could not read, absent Actions history, and a repository with no observed activity.

## What is deliberately absent

- **No completion percentage.** There is no field for one, and the narration validator rejects any
  text containing one.
- **No health score.** Focus order is a documented bucket ordering with a stated reason per entry,
  not a number.
- **No cross-source erasure.** One failing source never removes trustworthy evidence contributed by
  another (`R-AT4` records the failure; the other source's claims stand).

## Mission rules

Since Phase 2, missions contribute their own rules — `R-MS*` for what a mission state implies
about a project, plus the risk, queueing, claiming and clarification rules. They live in
[MISSION_RULES.md](MISSION_RULES.md), and they follow the same discipline as everything above:
every conclusion carries a rule id, and nothing is inferred that the evidence does not support.

Two of them are worth reading here, because they are the ones most likely to be got wrong:

- **`R-MS11`** — a mission whose worker has stopped reporting is never described as progressing.
  It is flagged, and it is listed under **unknowns**, because Jarvis genuinely does not know. It is
  not marked complete, and it is not marked failed, on the strength of silence.
- **`R-MS5`** — a draft pull request is "ready for your review, not merged". It is never counted
  as finished work, and never appears under recently completed.
